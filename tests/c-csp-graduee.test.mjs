/**
 * C-CSP-01, C-CSP-02, C-CSP-03 : une politique de sécurité de contenu (CSP) qui manque ou qui ne protège pas pèse selon ce que le widget a à protéger.
 *
 *  - Le widget demande `read table` ou `full` (il lit les données du document) : majeur, non bloquant. Sinon (`none`, aucun niveau lisible) : mineur.
 *  - C-CSP-03 : une CSP présente qui ne limite pas les destinations des requêtes sortantes (`connect-src`, à défaut `default-src`, absente ou ouverte
 *    à toute l'Internet) laisse un script injecté emporter ce qu'il lit. Une CSP stricte, une liste d'hôtes, ou la politique effective de plusieurs
 *    balises (leur intersection) ne la déclenchent pas ; un `default-src *` est dit une fois, par C-CSP-02.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditer, page } from './aide-surface.mjs';

const csp = (contenu) => `<meta http-equiv="Content-Security-Policy" content="${contenu}">`;
const widget = (acces, tete = '') => auditer({
  'index.html': page('<script src="app.js"></script>', tete),
  'app.js': acces === null ? 'const a = 1;\n' : `grist.ready({ requiredAccess: '${acces}' });\n`,
});
const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''}`;

test('sans CSP : majeur quand le widget lit le document (read table, full), mineur sinon (none, aucun niveau lisible), jamais bloquant', async () => {
  for (const [acces, attendu] of [['full', 'majeur'], ['read table', 'majeur'], ['none', 'mineur'], [null, 'mineur']]) {
    const [c, ...autres] = (await widget(acces)).de('C-CSP-01');
    assert.equal(autres.length, 0);
    assert.equal(etat(c), attendu, `accès ${acces}`);
    assert.equal(/Le widget demande l'accès « /.test(c.impact), attendu === 'majeur', `accès ${acces} : la phrase d'accès`);
  }
});

test('C-CSP-03 : une CSP qui ne limite pas les destinations sortantes est signalée, graduée de la même façon ; une CSP stricte ou une liste d\'hôtes ne l\'est pas', async () => {
  const ouvertes = ["script-src 'self'", "default-src 'self'; connect-src https:", "default-src 'self'; connect-src *", "default-src 'self' https:", "img-src 'self'; connect-src wss:"];
  for (const contenu of ouvertes) {
    const [c, ...autres] = (await widget('full', csp(contenu))).de('C-CSP-03');
    assert.equal(autres.length, 0, contenu);
    assert.equal(`${etat(c)} ${c.fichier}`, 'majeur index.html', contenu);
  }
  assert.equal(etat((await widget('none', csp("script-src 'self'"))).de('C-CSP-03')[0]), 'mineur', 'accès none');
  const fermees = ["default-src 'self'", "default-src 'none'", "default-src 'self'; connect-src 'self' https://api.exemple.org", "script-src 'self'; connect-src 'self' wss://docs.getgrist.com", "default-src *; connect-src 'self'"];
  for (const contenu of fermees) assert.deepEqual((await widget('full', csp(contenu))).de('C-CSP-03'), [], contenu);
});

test('C-CSP-03 : la politique effective de plusieurs balises est leur intersection, et une balise que Chromium n\'applique pas ne compte pas', async () => {
  const deux = (await widget('full', `${csp("script-src 'self'")}${csp("default-src 'self'")}`)).de('C-CSP-03');
  assert.deepEqual(deux, [], 'la deuxième balise limite les destinations');
  const ouvertes = (await widget('full', `${csp("script-src 'self'")}${csp("img-src 'self'")}`)).de('C-CSP-03');
  assert.equal(ouvertes.length, 1, 'aucune des deux ne les limite');
  const dansLeCorps = await auditer({ 'index.html': page(`<script src="app.js"></script>${csp("script-src 'self'")}`), 'app.js': "grist.ready({ requiredAccess: 'full' });\n" });
  assert.deepEqual(dansLeCorps.de('C-CSP-03'), [], 'une balise dans le corps n\'est pas appliquée : C-CSP-01 le dit');
  assert.equal(dansLeCorps.de('C-CSP-01').length, 1);
});

test('C-CSP-02 suit la même gravité, et un default-src * est dit une fois (C-CSP-02), non deux (pas de C-CSP-03 en plus)', async () => {
  const a = await widget('read table', csp("default-src * 'unsafe-inline'"));
  assert.deepEqual(a.de('C-CSP-02').map(etat), ['majeur', 'majeur'], 'le joker et unsafe-inline');
  assert.deepEqual(a.de('C-CSP-03'), []);
  const b = await widget('none', csp("default-src * 'unsafe-inline'"));
  assert.deepEqual(b.de('C-CSP-02').map(etat), ['mineur', 'mineur']);
  // Un joker en script-src, avec des connexions limitées : C-CSP-02 seul.
  const c = await widget('full', csp("script-src *; connect-src 'self'"));
  assert.equal(c.de('C-CSP-02').length, 1);
  assert.deepEqual(c.de('C-CSP-03'), []);
});
