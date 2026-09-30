import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserTests, analyserTracesDev } from '../src/regles/a-qualite.js';

/**
 * Une carte de sources (`.map`) est générée par l'empaqueteur et embarque le texte des sources, celles des bibliothèques
 * tierces comprises : ce n'est pas le travail du contributeur. Depuis que le plafond par fichier est de 16 Mio et non plus
 * de 4 Mio, les cartes de 4 à 16 Mio sont lues ; leur texte ne doit ni compter ses marqueurs de travail inachevé parmi ceux
 * du dépôt (A-DEV-03), ni fournir la preuve d'un test de bout en bout (A-TEST-02 : le motif `chromium.` se reconnaît dans les
 * adresses `bugs.chromium.org` que les commentaires d'une bibliothèque citent). Mesuré sur le corpus avant ce correctif, les
 * cartes de `timeline` et de `chart` (plus de 4 Mio) retiraient A-TEST-02 et, pour `timeline`, ajoutaient A-DEV-03.
 */

function fichier(chemin, contenu) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: false, vendorise: false };
}

const MARQUEURS = Array.from({ length: 8 }, (_, i) => `// TODO: reprendre ${i}`).join('\n');
const SOURCE_TIERCE = `${MARQUEURS}\n// https://bugs.chromium.org/p/v8/issues/detail?id=3334\n`;
const CARTE = JSON.stringify({ version: 3, sources: ['node_modules/core-js/modules/es.symbol.js'], sourcesContent: [SOURCE_TIERCE], mappings: '' });

const de = (constats, regle) => constats.find((c) => c.regle === regle);

test('A-DEV-03 : les marqueurs de travail inachevé que la carte de sources embarque ne sont pas ceux du dépôt, les mêmes dans un fichier du dépôt le sont', () => {
  const carte = analyserTracesDev({ fichiers: [fichier('out/index.js.map', CARTE), fichier('app.js', 'var a = 1;\n')] });
  assert.equal(de(carte, 'A-DEV-03'), undefined, 'huit TODO dans les sources tierces d\'une carte : aucun n\'est au contributeur');
  const code = analyserTracesDev({ fichiers: [fichier('app.js', MARQUEURS)] });
  assert.equal(de(code, 'A-DEV-03')?.titre, '8 marqueurs TODO / FIXME dans le dépôt', 'le même texte dans son code est compté');
  const avecLesDeux = analyserTracesDev({ fichiers: [fichier('out/index.js.map', CARTE), fichier('app.js', MARQUEURS)] });
  assert.equal(de(avecLesDeux, 'A-DEV-03')?.titre, '8 marqueurs TODO / FIXME dans le dépôt', 'la carte n\'y ajoute rien : huit, non seize');
  assert.equal(de(avecLesDeux, 'A-DEV-03')?.fichier, 'app.js');
});

test('A-TEST-02 : une adresse de bibliothèque citée dans une carte de sources n\'est pas la preuve d\'un test de bout en bout', () => {
  const constats = analyserTests({ fichiers: [fichier('out/index.js.map', CARTE), fichier('app.js', 'var a = 1;\n')] });
  assert.ok(de(constats, 'A-TEST-02'), 'aucun test de bout en bout : la carte n\'en est pas un');
  assert.ok(de(constats, 'A-TEST-01'));
});

test('A-TEST-02 : un vrai lanceur du dépôt reste reconnu même quand une carte de sources est lue aussi', () => {
  const lanceur = "const { chromium } = require('playwright');\nconst navigateur = await chromium.launch();\nawait navigateur.newPage();\n";
  const constats = analyserTests({ fichiers: [fichier('out/index.js.map', CARTE), fichier('dev-tests/lancer.mjs', lanceur)] });
  assert.equal(de(constats, 'A-TEST-02'), undefined);
});
