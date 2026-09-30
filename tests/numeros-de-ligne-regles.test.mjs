import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserTracesDev } from '../src/regles/a-qualite.js';
import { analyserSouverainete } from '../src/regles/f-conformite.js';

/**
 * A-DEV-03 (marqueurs de travail inachevé) et F-SOUV-01 (services tiers non souverains) donnent la ligne
 * de chaque occurrence. Elles la calculaient par `contenu.slice(0, index).split('\n').length` : le début du
 * fichier recopié à chaque occurrence, donc un temps quadratique dès qu'un fichier de quelques Mio répète le
 * motif (un dépôt hostile n'a qu'à le faire). Elles lisent maintenant un index des sauts de ligne (`numeroLigne`).
 * Ces essais vérifient les lignes rendues et comptent le travail fait, sans mesurer aucun temps :
 * un essai à budget en temps réel n'a pas sa place dans la suite par défaut.
 */

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
}

/** Le nombre total de caractères que `travail` passe à `split('\n')` : recopier le début d'un fichier à chaque occurrence les compte tous. */
function caracteresCoupesParLignes(travail) {
  const original = String.prototype.split;
  let total = 0;
  String.prototype.split = function espion(separateur, ...suite) {
    if (separateur === '\n') total += this.length;
    return original.call(this, separateur, ...suite);
  };
  try { travail(); } finally { String.prototype.split = original; }
  return total;
}

/** Le nombre d'appels à `String.prototype.includes` dont le texte est exactement `texte`. */
function appelsAIncludesSur(texte, travail) {
  const original = String.prototype.includes;
  let appels = 0;
  String.prototype.includes = function espion(...arguments_) {
    if (String(this) === texte) appels += 1;
    return original.apply(this, arguments_);
  };
  try { travail(); } finally { String.prototype.includes = original; }
  return appels;
}

const LIGNES_A_MARQUEURS = [2, 5, 9, 14, 20, 33];
const contenuAMarqueurs = () => Array.from({ length: 40 }, (_, i) => (LIGNES_A_MARQUEURS.includes(i + 1) ? `// TODO: reprendre ${i}` : `const v${i} = ${i};`)).join('\n');

test('A-DEV-03 : chaque marqueur est rendu à sa ligne, la première dans le constat', () => {
  const c = analyserTracesDev({ fichiers: [fichier('app.js', contenuAMarqueurs())] }).find((x) => x.regle === 'A-DEV-03');
  assert.ok(c, 'six marqueurs : le constat se déclenche');
  assert.deepEqual(c.preuve.emplacements.map((e) => e.ligne), LIGNES_A_MARQUEURS);
  assert.equal(c.ligne, LIGNES_A_MARQUEURS[0]);
  assert.equal(c.fichier, 'app.js');
});

test('A-DEV-03 : des marqueurs en fins de ligne CRLF et sur la même ligne que du code sont à la ligne juste', () => {
  const contenu = ['a();', 'b(); // TODO: un', 'c();', '/* FIXME: deux */ d();', '', 'e(); // XXX: trois', 'f();', '// HACK: quatre', '// BUG: cinq', 'g(); // TODO: six'].join('\r\n');
  const c = analyserTracesDev({ fichiers: [fichier('app.js', contenu)] }).find((x) => x.regle === 'A-DEV-03');
  assert.deepEqual(c.preuve.emplacements.map((e) => [e.ligne, e.type]), [[2, 'TODO'], [4, 'FIXME'], [6, 'XXX'], [8, 'HACK'], [9, 'BUG'], [10, 'TODO']]);
});

test('A-DEV-03 : la ligne d\'un marqueur ne recopie pas le début du fichier à chaque marqueur (le travail reste de l\'ordre de la taille du fichier)', () => {
  const N = 3000;
  const contenu = Array.from({ length: N }, () => '// TODO: x').join('\n');
  let constats;
  const coupes = caracteresCoupesParLignes(() => { constats = analyserTracesDev({ fichiers: [fichier('app.js', contenu)] }); });
  const c = constats.find((x) => x.regle === 'A-DEV-03');
  assert.equal(c.preuve.emplacements.length, N);
  assert.deepEqual([c.preuve.emplacements[0].ligne, c.preuve.emplacements[N - 1].ligne], [1, N]);
  assert.ok(coupes <= 2 * contenu.length, `${coupes} caractères passés à split('\\n') pour un fichier de ${contenu.length} : le début du fichier est recopié à chaque marqueur`);
});

const LIGNES_A_HOTES = [3, 8, 8, 15];
const contenuAHotes = () => Array.from({ length: 20 }, (_, i) => {
  const n = LIGNES_A_HOTES.filter((l) => l === i + 1).length;
  return n ? Array.from({ length: n }, (_, k) => `fetch('https://${k === 0 ? 'fonts.googleapis.com' : 'cdn.jsdelivr.net'}/x${i}');`).join(' ') : `const v${i} = ${i};`;
}).join('\n');

test('F-SOUV-01 : chaque référence à un service tiers est rendue à sa ligne, la première dans le constat', () => {
  const constats = analyserSouverainete({ fichiers: [fichier('app.js', contenuAHotes())] }).filter((x) => x.regle === 'F-SOUV-01');
  const parNom = Object.fromEntries(constats.map((c) => [c.titre.replace('Appel à un service tiers non souverain : ', ''), c]));
  assert.deepEqual(Object.keys(parNom).sort(), ['Google Fonts', 'jsDelivr']);
  assert.deepEqual(parNom['Google Fonts'].preuve.emplacements.map((e) => e.ligne), [3, 8, 15]);
  assert.deepEqual(parNom.jsDelivr.preuve.emplacements.map((e) => e.ligne), [8]);
  assert.equal(parNom['Google Fonts'].ligne, 3);
});

test('F-SOUV-01 : la ligne d\'une référence ne recopie pas le début du fichier à chaque référence (le travail reste de l\'ordre de la taille du fichier)', () => {
  const N = 3000;
  const contenu = Array.from({ length: N }, (_, i) => `// https://fonts.googleapis.com/a${i}`).join('\n');
  let constats;
  const coupes = caracteresCoupesParLignes(() => { constats = analyserSouverainete({ fichiers: [fichier('app.js', contenu)] }); });
  const c = constats.find((x) => x.regle === 'F-SOUV-01');
  assert.equal(c.preuve.emplacements.length, N);
  assert.deepEqual([c.preuve.emplacements[0].ligne, c.preuve.emplacements[N - 1].ligne], [1, N]);
  assert.ok(coupes <= 2 * contenu.length, `${coupes} caractères passés à split('\\n') pour un fichier de ${contenu.length} : le début du fichier est recopié à chaque référence`);
});

// --- le fichier synthétique d'un littéral passé à `eval` : sa référence n'est pas comptée deux fois

const LITTERAL = { litteralImbrique: true, origineReelle: { chemin: 'app.js', ligne: 1 } };

test('F-SOUV-01 : une référence d\'un littéral passé à eval, déjà en clair dans son fichier d\'origine, n\'est pas comptée deux fois ; celle qu\'un encodage cache, si', () => {
  const origine = fichier('app.js', "eval(\"fetch('https://fonts.googleapis.com/css')\"); eval(atob('ZmV0Y2goJ2h0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC94Jyk='));\n");
  const enClair = fichier('app.js#eval1', "fetch('https://fonts.googleapis.com/css')", LITTERAL);
  const encodee = fichier('app.js#eval2', "fetch('https://cdn.jsdelivr.net/x')", LITTERAL);
  const constats = analyserSouverainete({ fichiers: [origine, enClair, encodee] }).filter((x) => x.regle === 'F-SOUV-01');
  const emplacements = Object.fromEntries(constats.map((c) => [c.titre.replace('Appel à un service tiers non souverain : ', ''), c.preuve.emplacements.map((e) => [e.fichier, e.ligne])]));
  assert.deepEqual(emplacements, { 'Google Fonts': [['app.js', 1]], jsDelivr: [['app.js#eval2', 1]] }, 'Google Fonts : la seule référence est celle du fichier d\'origine ; jsDelivr : celle du littéral, seule à la porter en clair');
});

test('F-SOUV-01 : un littéral dont le fichier d\'origine n\'est pas dans l\'inventaire (ou sans contenu) garde sa référence : rien n\'est visible ailleurs', () => {
  const sansOrigine = fichier('x.js#eval1', "fetch('https://fonts.googleapis.com/css')", { litteralImbrique: true, origineReelle: { chemin: 'inconnu.js', ligne: 4 } });
  const origineVide = fichier('vide.js', '');
  const surOrigineVide = fichier('vide.js#eval1', "fetch('https://cdn.jsdelivr.net/x')", { litteralImbrique: true, origineReelle: { chemin: 'vide.js', ligne: 1 } });
  const constats = analyserSouverainete({ fichiers: [sansOrigine, origineVide, surOrigineVide] }).filter((x) => x.regle === 'F-SOUV-01');
  assert.deepEqual(constats.map((c) => c.preuve.emplacements.map((e) => e.fichier)).sort(), [['vide.js#eval1'], ['x.js#eval1']]);
});

test('F-SOUV-01 : le fichier d\'origine d\'un littéral se trouve dans une table faite une fois (aucun `find` sur l\'inventaire par référence), et son contenu n\'est parcouru qu\'une fois par hôte', () => {
  const REPETITIONS = 400;
  const origine = fichier('app.js', "eval(\"fetch('https://fonts.googleapis.com/css')\");\n");
  const litteral = fichier('app.js#eval1', `${Array.from({ length: REPETITIONS }, () => "fetch('https://fonts.googleapis.com/css');").join('\n')}\n${Array.from({ length: REPETITIONS }, () => "fetch('https://cdn.jsdelivr.net/x');").join('\n')}`, LITTERAL);
  const fichiers = [origine, litteral, ...Array.from({ length: 50 }, (_, i) => fichier(`autre${i}.js`, 'var a = 1;'))];
  let finds = 0;
  let tables = 0;
  const trouver = fichiers.find;
  const tabler = fichiers.map;
  fichiers.find = function espion(...arguments_) { finds += 1; return trouver.apply(this, arguments_); };
  fichiers.map = function espion(...arguments_) { tables += 1; return tabler.apply(this, arguments_); };
  let constats;
  const includesSurOrigine = appelsAIncludesSur(origine.contenu, () => { constats = analyserSouverainete({ fichiers }).filter((x) => x.regle === 'F-SOUV-01'); });
  assert.equal(finds, 0, 'le fichier d\'origine ne se cherche pas par un `find` sur tout l\'inventaire à chaque référence');
  assert.equal(tables, 1, 'la table des fichiers par chemin se fait une fois (une par référence rendrait la règle quadratique comme le `find`)');
  assert.equal(includesSurOrigine, 2, 'un parcours du fichier d\'origine par hôte distinct (2), non par référence (800)');
  assert.deepEqual(constats.map((c) => [c.titre.replace('Appel à un service tiers non souverain : ', ''), c.preuve.emplacements.length]).sort(), [['Google Fonts', 1], ['jsDelivr', REPETITIONS]], 'la référence en clair dans l\'origine n\'est comptée qu\'une fois (celle de l\'origine) ; celle qu\'elle ne porte pas l\'est chaque fois');
});
