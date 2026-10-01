/**
 * Le rapport de repli (src/isolement/repli.js) : quand l'analyse du code s'est interrompue, le parent écrit
 * un constat critique bloquant qui dit pourquoi, les axes que l'analyse alimente sont notés 0, et le verdict
 * est NON CONFORME — un audit qui n'a pas lu tout le code ne déclare rien conforme. Le constat est aussi
 * honnête sur ce qu'il ignore : il n'affirme pas la mémoire comme cause sans que V8 l'ait dit, ni un fichier
 * comme responsable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { noter } from '../src/moteur/notation.js';
import { constat } from '../src/moteur/modele.js';
import { AXES_DE_L_ANALYSE, constatAxeDInterrompu, constatInterruption, preciserConstatsDeLAxeD } from '../src/isolement/repli.js';

const cause = (genre, o = {}) => ({ genre, raison: `raison de ${genre}`, code: null, signal: null, etape: 'regles', fin: '', ...o });
const resume = { plusGrosFichierDeCode: { chemin: 'dist/bundle.js', taille: 9 * 1048576 } };

test('le constat de repli : C-SURFACE-03, critique, bloquant, certain, sur l\'axe C', () => {
  const c = constatInterruption(cause('tas'), resume);
  assert.equal(c.regle, 'C-SURFACE-03');
  assert.equal(c.axe, 'C');
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
  assert.equal(c.confiance, 'certain');
});

test('il empêche les axes A, B, C, E et F : ceux que l\'analyse du code alimente, pas l\'axe D', () => {
  assert.deepEqual(AXES_DE_L_ANALYSE, ['A', 'B', 'C', 'E', 'F']);
  assert.deepEqual(constatInterruption(cause('tas'), resume).axesEmpeches, ['A', 'B', 'C', 'E', 'F']);
});

test('la preuve porte la cause « interruption », la raison, l\'étape, le code et le signal, sans ligne ni colonne', () => {
  const c = constatInterruption(cause('noyau', { signal: 'SIGKILL', etape: 'inventaire', fin: 'Killed' }), null);
  assert.equal(c.preuve.cause, 'interruption');
  assert.equal(c.preuve.message, 'raison de noyau');
  assert.equal(c.preuve.genre, 'noyau');
  assert.equal(c.preuve.etape, 'inventaire');
  assert.equal(c.preuve.signal, 'SIGKILL');
  assert.equal(c.preuve.code, null);
  assert.equal(c.preuve.ligne, null);
  assert.equal(c.preuve.colonne, null);
  assert.equal(c.preuve.inline, false);
  assert.equal(c.preuve.finDeLaSortieDErreur, 'Killed');
});

test('le texte dit la raison et l\'étape de l\'interruption', () => {
  const t = constatInterruption(cause('tas'), resume).constat;
  assert.match(t, /s'est interrompue avant la fin \(raison de tas\)/);
  assert.match(t, /aucune règle n'a pu lire tout le code/);
  assert.match(t, /pendant l'exécution des règles/);
  assert.match(constatInterruption(cause('tas', { etape: 'inventaire' }), null).constat, /pendant la construction de l'inventaire/);
  assert.doesNotMatch(constatInterruption(cause('tas', { etape: null }), null).constat, /pendant/, 'aucune étape annoncée : aucune n\'est inventée');
});

for (const genre of ['tas', 'abandon', 'noyau', 'delai']) {
  test(`fin par « ${genre} » : le plus gros fichier de code est nommé, sans être dit responsable`, () => {
    const c = constatInterruption(cause(genre), resume);
    assert.match(c.constat, /dist\/bundle\.js/);
    assert.match(c.constat, /9,0 Mio/);
    assert.match(c.constat, /pas établi comme la cause/);
    assert.deepEqual(c.preuve.plusGrosFichierDeCode, resume.plusGrosFichierDeCode);
  });
}

for (const genre of ['pile', 'exception', 'incomplet', 'sortie']) {
  test(`fin par « ${genre} » : aucun fichier n'est désigné, la taille n'a rien à voir`, () => {
    const c = constatInterruption(cause(genre), resume);
    assert.doesNotMatch(c.constat, /bundle\.js/);
    assert.equal(c.preuve.plusGrosFichierDeCode, undefined);
  });
}

// Le nom du plus gros fichier est choisi par le widget, et le Markdown n'échappe aucun texte de constat : il est cité comme du texte
// (src/moteur/texte-du-widget.js), jamais recopié tel quel. Un nom honnête s'écrit comme avant.
const NOMS = [
  ['un nom honnête', 'dist/bundle.js', '`dist/bundle.js`', 'entre deux guillemets inversés, comme avant'],
  ['un guillemet inversé au milieu', 'a`b.js', '``a`b.js``', 'la barre d\'ouverture est plus longue que toute suite de guillemets inversés du nom : rien du nom ne la ferme'],
  ['un guillemet inversé au début', '`debut.js', '`` `debut.js ``', 'calé d\'une espace de chaque côté'],
  ['un guillemet inversé à la fin', 'fin.js`', '`` fin.js` ``', 'calé d\'une espace de chaque côté'],
  ['un retour à la ligne et un titre', 'x\n# Faux titre\n.js', '`x\\u000a# Faux titre\\u000a.js`', 'le retour à la ligne n\'ouvre pas de titre : il s\'écrit en clair'],
  ['des caractères d\'échappement', '\u001b[2J\u001b]0;pwnd\u0007.js', '`\\u001b[2J\\u001b]0;pwnd\\u0007.js`', 'rien n\'atteint ni le terminal ni le Markdown'],
  ['un caractère de sens d\'écriture', '\u202egnp.js', '`\\u202egnp.js`', 'le nom n\'est pas retourné'],
  ['une balise', '<img src=x onerror=alert(1)>.js', '`<img src=x onerror=alert(1)>.js`', 'dans un extrait de code, elle ne vaut rien'],
];
for (const [libelle, chemin, attendu, pourquoi] of NOMS) {
  test(`le nom du plus gros fichier est cité comme du texte : ${libelle}`, () => {
    const t = constatInterruption(cause('tas'), { plusGrosFichierDeCode: { chemin, taille: 9 * 1048576 } }).constat;
    assert.ok(t.includes(` fichier de code du widget est ${attendu} (9,0 Mio) : ce n'est pas établi comme la cause`), `${pourquoi} : ${JSON.stringify(t)}`);
    assert.doesNotMatch(t, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u, 'le texte du constat ne porte aucun caractère qu\'on ne voit pas');
  });
}

test('la remédiation dit ce qui convient à la cause : découper le code trop imbriqué d\'une pile pleine, la taille des fichiers pour le reste', () => {
  const pile = constatInterruption(cause('pile'), resume);
  assert.match(pile.remediation, /Découper l'expression trop imbriquée/);
  assert.doesNotMatch(pile.remediation, /publier des fichiers plus petits/, 'la taille des fichiers n\'a rien à voir avec une pile pleine');
  for (const genre of ['tas', 'abandon', 'noyau', 'delai', 'exception']) {
    assert.match(constatInterruption(cause(genre), resume).remediation, /publier des fichiers plus petits/, genre);
    assert.doesNotMatch(constatInterruption(cause(genre), resume).remediation, /Découper l'expression trop imbriquée/, genre);
  }
});

test('sans résumé (l\'enfant est mort avant la fin de l\'inventaire) : pas de fichier désigné, le texte reste vrai', () => {
  const c = constatInterruption(cause('tas'), null);
  assert.doesNotMatch(c.constat, /plus gros fichier/);
  assert.match(c.constat, /s'est interrompue/);
});

test('un rapport de repli seul : NON CONFORME, A B C E F notés 0 avec leur mesure et leur cause, D hors du calcul', () => {
  const c = constatInterruption(cause('tas'), resume);
  const n = noter([c, constatAxeDInterrompu(cause('tas', { etape: 'inventaire' }))], new Set(['D']));
  assert.equal(n.verdict, 'NON CONFORME');
  assert.equal(n.bloquants.length, 1);
  for (const code of ['A', 'B', 'C', 'E', 'F']) {
    assert.equal(n.parAxe[code].score, 0, `axe ${code}`);
    assert.equal(n.parAxe[code].empeche, true, `axe ${code}`);
    // Ce que l'axe vaut sur ce qui a été lu (rien, hors le critique lui-même sur l'axe C) : dit à côté du 0, jamais pris pour lui.
    assert.equal(n.parAxe[code].scoreMesure, code === 'C' ? 65 : 100, `axe ${code}`);
    assert.equal(n.parAxe[code].causes.length, 1);
  }
  assert.equal(n.parAxe.D.nonExecute, true);
  assert.equal(n.parAxe.D.score, null);
  assert.equal(n.global, 0);
  assert.match(n.motif, /Mesure empêchée/);
});

test('le verdict ne vaut jamais mieux que si l\'analyse avait abouti : le repli avec un axe D parfait reste NON CONFORME', () => {
  const n = noter([constatInterruption(cause('delai'), resume)]);
  assert.equal(n.verdict, 'NON CONFORME');
  assert.equal(n.parAxe.D.score, 100);
  assert.ok(n.global < 60, `global ${n.global}`);
});

test('D-INDISPONIBLE dit que l\'analyse s\'est arrêtée avant que le contexte existe, et qu\'une absence de mesure n\'est pas une absence de risque', () => {
  const c = constatAxeDInterrompu(cause('noyau', { etape: 'inventaire' }));
  assert.equal(c.regle, 'D-INDISPONIBLE');
  assert.equal(c.axe, 'D');
  assert.equal(c.severite, 'info');
  assert.equal(c.bloquant, false);
  assert.match(c.constat, /avant la fin de l'inventaire/);
  assert.match(c.impact, /pas une absence de risque/);
});

test('D-PERIMETRE-01 d\'un axe D joué sans niveau d\'accès lu : le README n\'est pas dit « non annoncé »', () => {
  const dperim = constat({ regle: 'D-PERIMETRE-01', axe: 'D', severite: 'mineur', titre: 't', constat: 'Le widget lit une table sans l\'annoncer.' });
  const autre = constat({ regle: 'D-XSS-01', axe: 'D', severite: 'mineur', titre: 't', constat: 'autre' });
  preciserConstatsDeLAxeD([dperim, autre], { racine: '.', entrees: [] });
  assert.match(dperim.constat, /Précision : l'analyse statique s'est interrompue/);
  assert.equal(autre.constat, 'autre', 'seul D-PERIMETRE-01 est précisé');
  const deuxFois = dperim.constat;
  preciserConstatsDeLAxeD([dperim], { racine: '.', entrees: [] });
  assert.equal(dperim.constat, deuxFois, 'la précision n\'est pas ajoutée deux fois');
  const complet = constat({ regle: 'D-PERIMETRE-01', axe: 'D', severite: 'mineur', titre: 't', constat: 'x' });
  preciserConstatsDeLAxeD([complet], { usagesGrist: { acces: [{ niveau: 'read table' }] } });
  assert.equal(complet.constat, 'x', 'avec le niveau d\'accès lu, rien à préciser');
});
