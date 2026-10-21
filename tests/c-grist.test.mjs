import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserAccesGrist } from '../src/regles/c-securite.js';

/**
 * C-GRIST-01 à 04 lisent l'AST en suivant l'objet `grist` (alias, déstructuration, `await`,
 * `window.grist`). Un constat ne s'appuie jamais sur l'absence d'un usage que le suivi n'a
 * pas pu établir : un objet de l'API transmis à une fonction rend le widget `opaque`.
 */

function fichier(contenu, chemin = 'app.js') {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: '.js', binaire: false, executee: true, vendorise: false };
}

const FULL = "grist.ready({ requiredAccess: 'full' });\n";

function audit(contenu) {
  const ctx = { fichiers: [fichier(contenu)] };
  const constats = analyserAccesGrist(ctx);
  return { ctx, par: (regle) => constats.find((c) => c.regle === regle) };
}

const verdict = (c) => (c ? `${c.severite}/${c.confiance}` : 'rien');

test('C-GRIST-03 : une écriture par getTable(), un alias de table ou de docApi est une écriture, pas un privilège inutile', () => {
  const ecritures = [
    "const t = grist.getTable();\nasync function maj() { await t.update({ id: 1, fields: {} }); }",
    "async function f() { const table = await grist.getTable('T'); await table.create({ fields: {} }); }",
    'grist.getTable().destroy([1]);',
    "grist.getTable?.()?.upsert([]);",
    "const api = grist.docApi;\napi.applyUserActions([['UpdateRecord', 'T', 1, {}]]);",
    "const { docApi } = window.grist;\ndocApi.applyUserActions([]);",
  ];
  for (const code of ecritures) assert.equal(verdict(audit(FULL + code).par('C-GRIST-03')), 'majeur/certain', code);
});

test("C-GRIST-03 : le critique reste pour un widget qui ne fait que lire sa table liée, jamais quand l'usage dépasse ou échappe à la lecture", () => {
  assert.equal(verdict(audit(FULL + 'grist.onRecords((r) => r.length);').par('C-GRIST-03')), 'critique/certain');
  const c = audit(FULL + "grist.docApi.fetchTable('Autre');").par('C-GRIST-03');
  assert.equal(verdict(c), 'majeur/probable');
  assert.ok(!/read table/.test(c.remediation), "ne conseille pas de rétrograder un widget qui lit une autre table");
  assert.equal(verdict(audit(FULL + 'grist.docApi.getAccessToken({ readOnly: true });').par('C-GRIST-03')), 'majeur/probable');
  assert.equal(verdict(audit(FULL + 'function sauver(t) { t.update({}); }\nsauver(grist.getTable());').par('C-GRIST-03')), 'majeur/probable');
});

test("C-GRIST-01/02 : grist.ready appelé par déstructuration ou window.grist existe ; le niveau d'une constante est lu", () => {
  for (const code of ["const { ready } = grist;\nready({ requiredAccess: 'read table' });", "window.grist.ready({ requiredAccess: 'none' });"]) {
    const { par, ctx } = audit(code);
    assert.equal(par('C-GRIST-01'), undefined, code);
    assert.equal(par('C-GRIST-02'), undefined, code);
    assert.equal(ctx.usagesGrist.acces.length, 1, code);
  }
  for (const code of ["const NIVEAU = 'full';\ngrist.ready({ requiredAccess: NIVEAU });", "const options = { requiredAccess: 'full' };\ngrist.ready(options);"]) {
    const { par, ctx } = audit(`${code}\ngrist.selectedTable.update({});`);
    assert.equal(par('C-GRIST-02'), undefined, code);
    assert.equal(ctx.usagesGrist.acces[0].niveau, 'full', code);
    assert.equal(verdict(par('C-GRIST-03')), 'majeur/certain', code);
  }
});

test("C-GRIST-01/02 : ce qui manque reste dit, et un niveau calculé n'est pas dit « non déclaré »", () => {
  assert.equal(verdict(audit('console.info(1);').par('C-GRIST-01')), 'majeur/certain');
  assert.equal(audit('init(grist);').par('C-GRIST-01'), undefined, 'grist transmis : on ne sait pas');
  assert.equal(verdict(audit("grist.ready({ columns: ['A'] });").par('C-GRIST-02')), 'majeur/certain');
  assert.equal(verdict(audit('grist.ready({ requiredAccess: niveauDuReglage() });').par('C-GRIST-02')), 'majeur/probable');
});

test("C-GRIST-04 : les actions de structure sont lues dans l'action, pas dans les valeurs ; une action rangée dans une variable est vue", () => {
  const schema = [
    "grist.docApi.applyUserActions([['AddVisibleColumn', 'T', 'c', {}]]);",
    "grist.docApi.applyUserActions([['RenameColumn', 'T', 'a', 'b']]);",
    "const act = ['AddColumn', 'T', 'c', {}];\ngrist.docApi.applyUserActions([act]);",
    "const lot = [];\nlot.push(['RemoveTable', 'T']);\ngrist.docApi.applyUserActions(lot);",
    "grist.docApi.applyUserActions([['BulkUpdateRecord', '_grist_Tables_column', [1], { type: ['Text'] }]]);",
  ];
  for (const code of schema) assert.ok(audit(FULL + code).par('C-GRIST-04'), code);
  const donnees = [
    "grist.docApi.applyUserActions([['UpdateRecord', 'Notes', 1, { Titre: 'AddTable' }]]);",
    "grist.docApi.applyUserActions([['BulkAddRecord', 'Notes', [1, 2], { Titre: ['AddTable', 'RemoveColumn'] }]]);",
  ];
  for (const code of donnees) assert.equal(audit(FULL + code).par('C-GRIST-04'), undefined, code);
});
