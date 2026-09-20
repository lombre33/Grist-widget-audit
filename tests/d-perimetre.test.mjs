import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserAccesAppat } from '../src/regles/d-perimetre.js';
import { TABLE_APPAT_ID } from '../src/runtime/dynamique.js';

function ctxAvecReadme(texte, acces = 'full') {
  return {
    fichiers: [{ chemin: 'README.md', contenu: texte }],
    usagesGrist: acces ? { acces: [{ niveau: acces }] } : { acces: [] },
  };
}

test("D-PERIMETRE-01 détecte un fetchTable sur la table appât (README muet : bloquant)", () => {
  const journal = {
    appelsRpc: [
      { interface: 'GristDocAPI@grist', methode: 'listTables', args: [], t: 1 },
      { interface: 'GristDocAPI@grist', methode: 'fetchTable', args: [TABLE_APPAT_ID], t: 2 },
    ],
  };
  const ctx = ctxAvecReadme('# Mon widget\n\nUn widget qui fait des choses.');
  const constats = analyserAccesAppat(journal, ctx);
  const c = constats.find((x) => x.regle === 'D-PERIMETRE-01');
  assert.ok(c);
  assert.equal(c.bloquant, true);
  assert.equal(c.severite, 'critique');
  assert.equal(c.confiance, 'prouve');
  assert.ok(c.constat && c.remediation, 'trois choses : emplacement dans preuve, explication, correctif');
});

test("D-PERIMETRE-01 détecte un applyUserActions sur la table appât", () => {
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'applyUserActions', args: [TABLE_APPAT_ID, []], t: 5 }] };
  const ctx = ctxAvecReadme('# Mon widget');
  const constats = analyserAccesAppat(journal, ctx);
  assert.equal(constats.filter((x) => x.regle === 'D-PERIMETRE-01' && x.bloquant).length, 1);
});

test("D-PERIMETRE-01 ne se déclenche pas sur listTables() seul (énumération légitime)", () => {
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'listTables', args: [], t: 1 }] };
  const constats = analyserAccesAppat(journal, ctxAvecReadme('# Mon widget'));
  assert.equal(constats.length, 0);
});

test("D-PERIMETRE-01 ne se déclenche pas sur un accès à la vraie table du scénario", () => {
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'fetchTable', args: ['Table1'], t: 1 }] };
  const constats = analyserAccesAppat(journal, ctxAvecReadme('# Mon widget'));
  assert.equal(constats.length, 0);
});

test('D-PERIMETRE-01 ne se déclenche pas sans journal ni appels', () => {
  assert.equal(analyserAccesAppat(null, ctxAvecReadme('# x')).length, 0);
  assert.equal(analyserAccesAppat({}, ctxAvecReadme('# x')).length, 0);
  assert.equal(analyserAccesAppat({ appelsRpc: [] }, ctxAvecReadme('# x')).length, 0);
});

test("D-PERIMETRE-01 rétrograde en 'info' non bloquant quand le README annonce une lecture de l'ensemble du document et l'accès full", () => {
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'fetchTable', args: [TABLE_APPAT_ID], t: 2 }] };
  const texte = "# Mon widget\n\n## Sécurité et permissions\n\nNiveau d'accès demandé : `requiredAccess: 'full'` — le widget lit et écrit sur l'ensemble du document Grist, pas seulement sur la table à laquelle il est lié.";
  const constats = analyserAccesAppat(journal, ctxAvecReadme(texte, 'full'));
  const c = constats.find((x) => x.regle === 'D-PERIMETRE-01');
  assert.ok(c);
  assert.equal(c.bloquant, false);
  assert.equal(c.severite, 'info');
  assert.equal(c.confiance, 'prouve');
});

test("D-PERIMETRE-01 reste bloquant si le README annonce une lecture étendue mais l'accès déclaré n'est pas full", () => {
  // Techniquement incohérent (un accès `read table` ne permet même pas
  // d'atteindre d'autres tables dans un vrai Grist) : ne jamais neutraliser
  // le constat sur ce seul texte.
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'fetchTable', args: [TABLE_APPAT_ID], t: 2 }] };
  const texte = "# Mon widget\n\nCe widget lit l'ensemble du document.";
  const constats = analyserAccesAppat(journal, ctxAvecReadme(texte, 'read table'));
  const c = constats.find((x) => x.regle === 'D-PERIMETRE-01');
  assert.ok(c);
  assert.equal(c.bloquant, true);
});

test("D-PERIMETRE-01 reste bloquant en accès full si le README ne mentionne aucune lecture étendue", () => {
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'fetchTable', args: [TABLE_APPAT_ID], t: 2 }] };
  const texte = "# Mon widget\n\nNiveau d'accès demandé : `requiredAccess: 'full'`, nécessaire pour écrire dans la table liée.";
  const constats = analyserAccesAppat(journal, ctxAvecReadme(texte, 'full'));
  const c = constats.find((x) => x.regle === 'D-PERIMETRE-01');
  assert.ok(c);
  assert.equal(c.bloquant, true);
});

test('D-PERIMETRE-01 ne casse pas sans ctx (rétrocompatibilité de signature)', () => {
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'fetchTable', args: [TABLE_APPAT_ID], t: 2 }] };
  const constats = analyserAccesAppat(journal);
  const c = constats.find((x) => x.regle === 'D-PERIMETRE-01');
  assert.ok(c);
  assert.equal(c.bloquant, true, 'sans ctx, aucune déclaration ne peut être trouvée : reste bloquant par défaut');
});
