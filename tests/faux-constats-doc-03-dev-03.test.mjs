/**
 * Deux règles qui accusaient à tort ou manquaient ce qu'elles disaient lire.
 *
 * B-DOC-03 disait « certain » un niveau d'accès non documenté quand il était `none`, quand le README le décrivait avec d'autres mots (« accès en lecture à la
 * table liée »), ou quand le niveau venait d'un fichier que la page n'exécute pas ; elle manquait un README qui ne dit que « fully featured ».
 * A-DEV-03 comptait tout le texte du dépôt (un `HACK` dans un JSON, un `BUG :` dans une chaîne affichée) et manquait `//TODO` en fin de ligne et `TODO(nom)`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyserReadme } from '../src/regles/b-lisibilite.js';
import { analyserTracesDev } from '../src/regles/a-qualite.js';

const BASE = '# W\n\n## Description\nAffiche des cartes.\n\n## Configuration\nColonnes : titre.\n\n## Dépendances\nAucune dépendance.\n';
const fichier = (chemin, contenu, extra = {}) => ({ chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra });

const docAcces = (readme, acces, fichiers = []) => analyserReadme({
  fichiers: [fichier('README.md', readme, { executee: false }), ...fichiers],
  usagesGrist: { acces },
}).find((c) => c.regle === 'B-DOC-03');
const demande = (niveau, f = 'app.js', ligne = 3) => ({ niveau, fichier: f, ligne });

test('B-DOC-03 : un niveau `none` ne demande rien à expliquer ; `full` ou `read table` non documentés donnent un constat qui cite où le code le demande', () => {
  assert.equal(docAcces(BASE, [demande('none')]), undefined);
  const c = docAcces(BASE, [demande('read table', 'js/app.js', 12)]);
  assert.ok(c, 'read table non documenté');
  assert.equal(c.confiance, 'probable');
  assert.match(c.constat, /`js\/app\.js` ligne 12/);
  assert.match(docAcces(BASE, [demande('read table'), demande('full')]).titre, /`full`/, 'le plus étendu des niveaux demandés');
});

test('B-DOC-03 : un README qui explique l\'accès avec d\'autres mots est documenté', () => {
  for (const phrase of ['Accès en lecture à la table liée.', 'Lecture de la table sélectionnée uniquement.', 'The widget reads the linked table.', 'Il écrit dans le document.', 'requiredAccess: read table']) {
    assert.equal(docAcces(`${BASE}\n${phrase}\n`, [demande('read table')]), undefined, phrase);
  }
});

test('B-DOC-03 : « fully featured » et « full-width » ne parlent pas d\'accès', () => {
  assert.ok(docAcces(`${BASE}\nA powerful, fully featured widget.\n`, [demande('full')]));
  assert.ok(docAcces(`${BASE}\nUne mise en page full-width.\n`, [demande('full')]));
  assert.equal(docAcces(`${BASE}\nAccès full au document.\n`, [demande('full')]), undefined);
});

test('B-DOC-03 : un niveau relevé dans un fichier que la page n\'exécute pas n\'est pas demandé', () => {
  const horsPage = fichier('essai.js', 'x', { executee: false });
  assert.equal(docAcces(BASE, [demande('full', 'essai.js')], [horsPage]), undefined);
  assert.ok(docAcces(BASE, [demande('full', 'app.js')], [fichier('app.js', 'x')]));
});

const marqueurs = (fichiers) => analyserTracesDev({ fichiers }).find((c) => c.regle === 'A-DEV-03');
const SIX = (prefixe, suffixe = '') => Array.from({ length: 6 }, (_, i) => `${prefixe}TODO ${i}${suffixe}`).join('\n');

test('A-DEV-03 : un marqueur dans un JSON, un README ou une chaîne affichée n\'est pas un travail inachevé', () => {
  assert.equal(marqueurs([fichier('data.json', '{"a":' + JSON.stringify(Array(6).fill('HACK')) + '}')]), undefined);
  assert.equal(marqueurs([fichier('README.md', SIX('- '))]), undefined);
  const chaines = Array.from({ length: 6 }, (_, i) => `const m${i} = "BUG : ${i}";`).join('\n');
  assert.equal(marqueurs([fichier('app.js', chaines)]), undefined);
});

test('A-DEV-03 : `//TODO` en fin de ligne, `TODO(nom)` et `TODO-` sont des marqueurs, à leur ligne', () => {
  const contenu = ['a(); //TODO', 'b(); // TODO(marie): x', 'c(); // TODO- y', '// FIXME', '/* XXX */', 'd(); // HACK'].join('\n');
  const c = marqueurs([fichier('app.js', contenu)]);
  assert.ok(c, 'six marqueurs');
  assert.deepEqual(c.preuve.emplacements.map((e) => [e.ligne, e.type]), [[1, 'TODO'], [2, 'TODO'], [3, 'TODO'], [4, 'FIXME'], [5, 'XXX'], [6, 'HACK']]);
});

test('A-DEV-03 : les commentaires d\'un script de page sont lus, à la ligne de la page ; un identifiant `TODOS` n\'est pas un marqueur', () => {
  const page = ['<!doctype html>', '<script>', '// TODO un', 'const TODOS = [];', '// TODO deux', '// TODO trois', '// TODO quatre', '// TODO cinq', '// TODO six', '</script>'].join('\n');
  const c = marqueurs([fichier('index.html', page)]);
  assert.ok(c, 'six marqueurs dans le script');
  assert.deepEqual(c.preuve.emplacements.map((e) => e.ligne), [3, 5, 6, 7, 8, 9]);
});
