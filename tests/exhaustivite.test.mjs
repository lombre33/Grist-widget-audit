import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserTracesDev, analyserPratiques } from '../src/regles/a-qualite.js';
import { analyserReadme } from '../src/regles/b-lisibilite.js';
import { analyserAccesGrist, analyserStockage } from '../src/regles/c-securite.js';
import { analyserSouverainete } from '../src/regles/f-conformite.js';

/**
 * Demande d'Antoine : que l'audit précise exhaustivement dans quels fichiers,
 * pas seulement le premier. Plusieurs règles collectaient toutes les
 * occurrences réelles mais ne gardaient dans `preuve` qu'un extrait plafonné
 * (parfois 10, parfois 40 selon la règle) : ces tests vérifient que la liste
 * complète est désormais exposée, en dépassant volontairement chaque ancien
 * plafond. Aucune de ces règles ne doit changer de score par ce correctif :
 * `facteurOccurrences` continue de ne voir qu'un seul constat par règle,
 * volontairement inchangé ici (voir src/moteur/priorisation.js pour la
 * question, distincte, de savoir si ça doit changer).
 */

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
}

test('A-DEV-01 (console.log) : la preuve liste toutes les occurrences, pas les 30 premières', () => {
  const contenu = Array.from({ length: 35 }, (_, i) => `console.log(${i});`).join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserTracesDev(ctx);
  const c = constats.find((x) => x.regle === 'A-DEV-01');
  assert.ok(c, 'doit se déclencher (35 > 10)');
  assert.equal(c.preuve.emplacements.length, 35, 'l\'ancien plafond à 30 ne doit plus tronquer la liste');
});

test('A-LANG-01 (comparaisons non strictes) : la preuve liste toutes les occurrences, pas les 20 premières', () => {
  const contenu = Array.from({ length: 25 }, (_, i) => `if (v${i} == ${i}) { x = ${i}; }`).join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserPratiques(ctx);
  const c = constats.find((x) => x.regle === 'A-LANG-01');
  assert.ok(c, 'doit se déclencher (25 comparaisons non strictes)');
  assert.equal(c.preuve.emplacements.length, 25, 'l\'ancien plafond à 20 ne doit plus tronquer la liste');
});

test('C-STOCK-01 (stockage persistant) : la preuve liste toutes les occurrences, pas les 20 premières', () => {
  const contenu = Array.from({ length: 25 }, (_, i) => `localStorage.setItem('cle${i}', ${i});`).join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserStockage(ctx);
  const c = constats.find((x) => x.regle === 'C-STOCK-01');
  assert.ok(c, 'doit se déclencher (25 écritures localStorage)');
  assert.equal(c.preuve.emplacements.length, 25, 'l\'ancien plafond à 20 ne doit plus tronquer la liste');
});

test('F-SOUV-01 (service non souverain) : la preuve liste toutes les occurrences, pas les 10 premières', () => {
  const contenu = Array.from({ length: 15 }, (_, i) => `fetch('https://fonts.googleapis.com/css2?v=${i}');`).join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserSouverainete(ctx);
  const c = constats.find((x) => x.regle === 'F-SOUV-01');
  assert.ok(c, 'doit se déclencher (15 références à fonts.googleapis.com)');
  assert.equal(c.preuve.emplacements.length, 15, 'l\'ancien plafond à 10 ne doit plus tronquer la liste');
});

test('B-DOC-04 (service externe non documenté) : tous les hôtes sont exposés en donnée structurée, pas seulement joints en texte', () => {
  const ctx = {
    fichiers: [fichier('README.md', 'Un widget minimal.')],
    destinationsExternes: new Set(['fonts.googleapis.com', 'esm.sh', 'unpkg.com']),
  };
  const constats = analyserReadme(ctx);
  const c = constats.find((x) => x.regle === 'B-DOC-04');
  assert.ok(c);
  assert.deepEqual(c.preuve.hotes.sort(), ['esm.sh', 'fonts.googleapis.com', 'unpkg.com']);
});

test('C-GRIST-04 (écriture de schéma) : la preuve liste désormais les emplacements, avant absente', () => {
  const contenu = [
    "grist.ready({ requiredAccess: 'full' });",
    "grist.docApi.applyUserActions([['AddColumn', 'T', 'c1', {}]]);",
    "grist.docApi.applyUserActions([['RemoveColumn', 'T', 'c2']]);",
  ].join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserAccesGrist(ctx);
  const c = constats.find((x) => x.regle === 'C-GRIST-04');
  assert.ok(c, 'doit se déclencher (2 actions de schéma détectées)');
  assert.equal(c.preuve.emplacements.length, 2, 'l\'ancienne version ne gardait aucun emplacement en preuve');
});
