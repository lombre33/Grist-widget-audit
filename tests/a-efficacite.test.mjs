import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserEfficacite } from '../src/regles/a-efficacite.js';
import { reglesA } from '../src/regles/a-qualite.js';

/**
 * A-PERF-01 (un appel à Grist ou au réseau attendu à chaque tour d'une boucle) et A-PERF-02 (`innerHTML +=` dans une boucle ou un
 * parcours) : des informations, qui disent où est le motif et ne notent rien. Ces essais posent le motif, puis ce qui lui ressemble sans
 * se répéter (en dehors d'une boucle, dans son en-tête, dans un rappel que la boucle ne fait pas tourner).
 */

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, dossierExclu: false, ...extra };
}
const constatsDe = (contenu, extra) => analyserEfficacite({ fichiers: [fichier('app.js', contenu, extra)] });
const reglesDe = (contenu, extra) => constatsDe(contenu, extra).map((c) => c.regle);

test('A-PERF-01 : un appel à Grist attendu à chaque tour d\'une boucle est signalé en information, à sa ligne', () => {
  const [c, ...autres] = constatsDe(`async function maj(lignes) {
  for (const l of lignes) {
    await grist.docApi.applyUserActions([['UpdateRecord', 'T', l.id, { A: 1 }]]);
  }
}`);
  assert.equal(autres.length, 0);
  assert.equal(c.regle, 'A-PERF-01');
  assert.equal(c.severite, 'info');
  assert.equal(c.fichier, 'app.js');
  assert.equal(c.ligne, 3);
});

test('A-PERF-01 : fetch dans un while et dans un for await, deux occurrences, un seul constat qui les compte', () => {
  const constats = constatsDe(`async function f(urls) {
  while (urls.length) { await fetch(urls.pop()); }
  for await (const x of flux()) { await window.fetch(x); }
}`);
  assert.equal(constats.length, 1);
  assert.match(constats[0].titre, /^2 appel/);
  assert.deepEqual(constats[0].preuve.emplacements.map((e) => e.ligne), [2, 3]);
});

test('A-PERF-01 : rien hors d\'une boucle, dans ce que la boucle évalue une fois, ni dans un rappel que la boucle ne fait pas tourner', () => {
  for (const source of [
    'async function f() { await grist.docApi.fetchTable("T"); }',
    'async function f() { for (const r of await grist.docApi.fetchTable("T")) { g(r); } }',
    'async function f(l) { await Promise.all(l.map(async (r) => { await fetch(r); })); }',
    'async function f(l) { for (const r of l) { const g = async () => { await fetch(r); }; } }',
  ]) assert.deepEqual(reglesDe(source), [], source);
});

test('A-PERF-01 : un appel qui ne sort pas du navigateur n\'est pas signalé', () => {
  assert.deepEqual(reglesDe('async function f(l) { for (const r of l) { await pause(10); await table.update(r); } }'), []);
});

test('A-PERF-02 : innerHTML += dans une boucle ou dans le rappel d\'un parcours est signalé, un constat pour les trois', () => {
  const constats = constatsDe(`function rendre(lignes, liste) {
  for (const l of lignes) { liste.innerHTML += '<li>' + l.nom + '</li>'; }
  lignes.forEach((l) => { liste.innerHTML += '<li>' + l.nom + '</li>'; });
  lignes.forEach((l) => liste.innerHTML += l.nom);
}`);
  assert.deepEqual(constats.map((c) => c.regle), ['A-PERF-02']);
  assert.equal(constats[0].severite, 'info');
  assert.deepEqual(constats[0].preuve.emplacements.map((e) => e.ligne), [2, 3, 4]);
});

test('A-PERF-02 : rien hors d\'une répétition, ni pour une autre affectation, une autre propriété ou un rappel que le parcours n\'appelle pas', () => {
  for (const source of [
    'liste.innerHTML += "<li>x</li>";',
    'for (const l of ls) { liste.innerHTML = l.html; }',
    'for (const l of ls) { liste.textContent += l.nom; }',
    'for (const l of ls) { const ajouter = () => { liste.innerHTML += l.nom; }; }',
  ]) assert.deepEqual(reglesDe(source), [], source);
});

test('les deux règles ne lisent que le code que la page exécute et que le widget a écrit', () => {
  const source = 'async function f(l) { for (const r of l) { await fetch(r); el.innerHTML += r; } }';
  assert.deepEqual(reglesDe(source), ['A-PERF-01', 'A-PERF-02']);
  assert.deepEqual(reglesDe(source, { executee: false }), []);
  assert.deepEqual(reglesDe(source, { vendorise: true }), []);
});

test('les deux règles font partie de l\'axe A', () => {
  assert.ok(reglesA.includes(analyserEfficacite));
});
