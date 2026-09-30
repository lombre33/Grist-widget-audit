/**
 * Un code que le navigateur exécute et qu'aucune règle n'a pu lire ne se passe pas sous silence, et ne note jamais mieux
 * que le même code lisible : la syntaxe qu'acorn refuse (TypeScript, JSX), l'imbrication que sa pile ne porte pas, le
 * parcours qui déborde ou la règle qui échoue sur un code piégé sont un constat critique et BLOQUANT par fichier (ou par
 * script de page) qui dit lequel et pourquoi, et qui empêche les axes que ce code aurait nourris (C-SURFACE-03). Un
 * fichier qu'une balise script, un import ou un worker désigne par son adresse est du code quelle que soit son extension.
 * Chaque essai a son mutant dans `scripts/mutants-illisibles.mjs`.
 */
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as walk from 'acorn-walk';
import { chromium } from 'playwright';
import { auditer, avecWidget, page, EXFIL } from './aide-surface.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { chromiumIndisponible } from './aide-chromium.mjs';
import { noter } from '../src/moteur/notation.js';
import { lire, unitesJs, pourChaqueUniteJs, depassementDePile } from '../src/moteur/analyse-js.js';
import { preparerCodeExecuteEnChaine } from '../src/regles/c-securite.js';
import { analyserIllisibles } from '../src/regles/c-illisibles.js';

const SANS_RIEN = 'var a = 1;\n';
/** Ce que le navigateur n'exécute pas et qu'acorn refuse : une annotation de type. */
const TYPESCRIPT = 'let x: number = 1;\n';
/** Des objets imbriqués plus profondément que la pile d'acorn ne les lit ; Chromium, lui, les exécute (le dernier essai du fichier le vérifie dans Chromium). */
const imbriques = (n) => `var s = ${'({a:'.repeat(n)}1${'})'.repeat(n)};\n`;
/** Une somme que la lecture lit et que le parcours de l'arbre ne porte pas (il est récursif, l'arbre est aussi profond que la somme est longue) ; Chromium l'exécute : la somme se compile à plat (mesuré par `scripts/mesurer-profondeur.mjs`, et par le dernier essai du fichier). Une chaîne de membres `a.b.b.b` ne convient pas : Chromium ne l'exécute pas au-delà de 1 344 environ. */
const somme = (n) => `var s = 1${'+1'.repeat(n)};\n`;
/** Les tailles des pièges : assez au-delà de ce que la pile d'acorn et le parcours portent (la limite varie avec l'état du compilateur JIT) pour que l'essai ne dépende pas de lui, assez en deçà de ce que Chromium exécute. `node scripts/mesurer-profondeur.mjs` donne les limites de la machine. */
const PROFOND = 700;
const LONGUE = 4000;
const charge = (...noms) => page(noms.map((n) => `<script src="${n}"></script>`).join(''));
const carte = (imports) => `<script type="importmap">${JSON.stringify({ imports })}</script>`;

const ILLISIBLE = (a) => a.de('C-SURFACE-03');
const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''}`;
const TOUS = ['A', 'B', 'C', 'E', 'F'];
const SANS_A = ['B', 'C', 'E', 'F'];
const noterStatique = (constats) => noter(constats, new Set(['D']));

test('un code que la page exécute et que l\'analyse ne lit pas (TypeScript) est un critique bloquant qui dit le fichier, la ligne et la raison, et empêche tous les axes', async () => {
  const a = await auditer({ 'index.html': charge('app.js'), 'app.js': `${SANS_RIEN}${TYPESCRIPT}` });
  assert.equal(ILLISIBLE(a).length, 1, 'un constat par fichier, non un par règle qui a voulu le lire');
  const [c] = ILLISIBLE(a);
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.axe, 'C');
  assert.equal(c.confiance, 'certain');
  assert.equal(c.fichier, 'app.js');
  assert.equal(c.ligne, 2);
  assert.equal(c.titre, 'Fichier de code que l\'outil ne sait pas lire');
  assert.match(c.constat, /ne lit pas ce code : Unexpected token \(ligne 2, colonne 6\)/);
  assert.match(c.constat, /ni injection, ni sortie réseau, ni secret, ni dépendance, ni conformité/);
  assert.match(c.constat, /L'axe D ne le voit que s'il s'exécute/);
  assert.match(c.remediation, /JavaScript valide/);
  assert.ok(c.impact);
  assert.deepEqual(c.axesEmpeches, TOUS);
  assert.deepEqual(c.preuve, { cause: 'syntaxe', message: 'Unexpected token', etape: 'lecture', ligne: 2, colonne: 6, inline: false });
  const n = noterStatique(a.constats);
  assert.deepEqual(n.axesEmpeches, TOUS);
  assert.equal(n.verdict, 'NON CONFORME');
  const lisible = await auditer({ 'index.html': charge('app.js'), 'app.js': SANS_RIEN });
  assert.deepEqual(ILLISIBLE(lisible), [], 'le même fichier sans annotation de type se lit : rien à dire');
  assert.deepEqual(noterStatique(lisible.constats).axesEmpeches, []);
});

test('un code illisible que la page ne charge pas n\'est pas du code exécuté : aucun constat, et le même fichier, dès qu\'une page le charge, en est un', async () => {
  const a = await auditer({ 'index.html': charge('app.js'), 'app.js': SANS_RIEN, 'orphelin.js': TYPESCRIPT, 'source.jsx': 'const a = <div />;\n' });
  assert.deepEqual(ILLISIBLE(a), []);
  assert.deepEqual(noterStatique(a.constats).axesEmpeches, []);
  const chargé = await auditer({ 'index.html': charge('orphelin.js'), 'orphelin.js': TYPESCRIPT });
  assert.equal(etat(ILLISIBLE(chargé)[0]), 'critique bloquant');
  const jsx = await auditer({ 'index.html': charge('source.jsx'), 'source.jsx': 'const a = <div />;\n' });
  assert.equal(ILLISIBLE(jsx)[0]?.fichier, 'source.jsx', 'du JSX que la page charge est du code que personne n\'a lu');
});

test('un script de la page que l\'analyse ne lit pas est dit sur la page, à la ligne de l\'erreur dans la page', async () => {
  const accueil = page('<p>x</p>\n<script>\nvar a = 1;\nlet y: string = "";\n</script>\n<script>var b = 2;</script>');
  const a = await auditer({ 'index.html': accueil });
  assert.equal(ILLISIBLE(a).length, 1, 'le script lisible n\'est pas dit');
  const [c] = ILLISIBLE(a);
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.fichier, 'index.html');
  assert.equal(c.ligne, 4);
  assert.equal(c.titre, 'Script de la page que l\'outil ne sait pas lire');
  assert.match(c.constat, /\(ligne 4, colonne 6\)/);
  assert.deepEqual(c.preuve, { cause: 'syntaxe', message: 'Unexpected token', etape: 'lecture', ligne: 4, colonne: 6, inline: true });
  assert.deepEqual(c.axesEmpeches, TOUS);
  const enLigne = page('<script>let y: string;</script>');
  const c1 = ILLISIBLE(await auditer({ 'index.html': enLigne }))[0];
  assert.equal(c1.preuve.colonne, enLigne.indexOf('let y') + 6, 'la colonne se compte dans la page, non dans le script');
  assert.equal(c1.preuve.ligne, 1);
  const deux = await auditer({ 'index.html': page('<script>let y: string;</script>\n<p>x</p>\n<script>\n\nlet z: number;</script>') });
  assert.deepEqual(ILLISIBLE(deux).map((c) => c.ligne), [1, 5], 'deux scripts illisibles de la même page : un constat chacun, dans l\'ordre de la page');
});

test('un code imbriqué plus profondément que la pile de l\'analyse ne le lit, et que le navigateur exécute, est illisible par profondeur, non par syntaxe', async () => {
  const code = imbriques(PROFOND);
  assert.equal(lire(code).ast, null, 'prémisse : acorn ne lit pas cette imbrication (Chromium l\'exécute : le dernier essai du fichier le vérifie dans Chromium)');
  const a = await auditer({ 'index.html': charge('app.js'), 'app.js': code });
  const [c] = ILLISIBLE(a);
  assert.equal(ILLISIBLE(a).length, 1);
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.preuve.cause, 'profondeur');
  assert.equal(c.preuve.message, 'la pile déborde');
  assert.match(c.constat, /imbriqué plus profondément que ce que l'outil sait parcourir : sa pile déborde \(ligne 1\)\. S'il s'exécute dans le navigateur, aucune règle ne l'a lu\./);
  assert.doesNotMatch(c.constat, /le navigateur exécute du code plus profond/i, 'le texte ne dit pas que le navigateur lit plus profond : cela dépend de la construction');
  assert.match(c.remediation, /Découper/);
  assert.deepEqual(c.axesEmpeches, TOUS);
});

test('un code que la lecture lit et dont le parcours des règles déborde la pile ne fait pas tomber l\'audit : il est dit, et les autres fichiers sont audités', async () => {
  const code = somme(LONGUE);
  const { ast } = lire(code);
  assert.ok(ast, 'prémisse : acorn lit cette somme (sa lecture va plus loin que le parcours de son arbre)');
  assert.throws(() => walk.ancestor(ast, {}), depassementDePile, 'prémisse : le parcours de l\'arbre la déborde');
  const a = await auditer({ 'index.html': charge('piege.js', 'mal.js'), 'piege.js': code, 'mal.js': EXFIL });
  const [c] = ILLISIBLE(a);
  assert.equal(ILLISIBLE(a).length, 1, 'un constat pour le fichier, non un par règle dont le parcours a débordé');
  assert.equal(c.fichier, 'piege.js');
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.preuve.cause, 'profondeur');
  assert.equal(c.preuve.etape, 'parcours');
  assert.match(c.constat, /la pile déborde quand une règle le parcourt\. S'il s'exécute dans le navigateur, ce que les règles en disent est incomplet\./, 'un parcours qui déborde ne dit pas de ligne : le code se lit, c\'est le parcours qui échoue');
  assert.doesNotMatch(c.constat, /aucune règle ne l'a lu/, 'le code se lit : une règle qui ne le parcourt pas n\'y perd rien, le texte ne dit pas qu\'aucune ne l\'a lu');
  assert.deepEqual(c.axesEmpeches, TOUS);
  assert.ok(a.de('C-EXFIL-01', 'mal.js').length > 0, 'le fichier d\'à côté est audité comme s\'il était seul');
  const n = noterStatique(a.constats);
  assert.equal(n.verdict, 'NON CONFORME');
});

test('un code piégé dont le parcours déborde donne encore ses références à la surface : ce qu\'il importe, même après le piège, est audité', async () => {
  const fichiers = { 'index.html': page('<script type="module" src="app.js"></script>'), 'suite.js': EXFIL };
  for (const [nom, corps] of [['parcours', somme(LONGUE)], ['lecture', imbriques(PROFOND)]]) {
    const a = await auditer({ ...fichiers, 'app.js': `${corps}import './suite.js';\n` });
    assert.ok(a.surface.includes('suite.js'), `${nom} : le module importé par un code que les règles n'ont pu lire est tout de même atteint`);
    assert.ok(a.de('C-EXFIL-01', 'suite.js').length > 0, `${nom} : et lu`);
    assert.equal(ILLISIBLE(a).length, 1, nom);
  }
});

test('un script de la page dont le parcours des règles déborde est dit à la ligne où il commence, et la règle qui prépare le code exécuté en chaîne relève ce qu\'elle ne parcourt pas', async () => {
  const accueil = page(`<p>x</p>\n<script>${somme(LONGUE)}</script>`);
  const a = await auditer({ 'index.html': accueil });
  const [c] = ILLISIBLE(a);
  assert.equal(ILLISIBLE(a).length, 1);
  assert.equal(c.titre, 'Script de la page que l\'outil ne sait pas lire');
  assert.equal(c.fichier, 'index.html');
  assert.equal(c.ligne, 2, 'le parcours n\'a pas de ligne d\'erreur : le script est dit à la ligne où il commence');
  assert.equal(c.preuve.cause, 'profondeur');
  const ctx = { fichiers: [{ chemin: 'piege.js', ext: '.js', contenu: somme(LONGUE), binaire: false, executee: true }] };
  assert.deepEqual(preparerCodeExecuteEnChaine(ctx), []);
  assert.deepEqual([...ctx.illisibles.values()].map((n) => [n.chemin, n.cause]), [['piege.js', 'profondeur']], 'relevé dans le contexte de l\'audit, non dans celui d\'un seul fichier');
});

test('un fichier que rien n\'exécute et dont un parcours a débordé est une information groupée, sans bloquer ni empêcher aucun axe', async () => {
  const a = await auditer({ 'index.html': charge('app.js'), 'app.js': SANS_RIEN, 'orphelin.js': somme(LONGUE) });
  const [c] = ILLISIBLE(a);
  assert.equal(ILLISIBLE(a).length, 1);
  assert.equal(etat(c), 'info');
  assert.match(c.titre, /1 fichier\(s\) que l'analyse n'a pas pu parcourir et que le widget n'exécute pas/);
  assert.match(c.constat, /orphelin\.js/);
  assert.deepEqual(c.preuve.emplacements.map((e) => e.fichier), ['orphelin.js']);
  assert.deepEqual(c.axesEmpeches, [], 'une information n\'empêche aucun axe');
  assert.deepEqual(noterStatique(a.constats).axesEmpeches, []);
});

test('plus de cinquante codes illisibles : les cinquante premiers un à un (par chemin), les autres dans un seul constat qui les nomme tous', async () => {
  const noms = Array.from({ length: 52 }, (_, i) => `f${String(i).padStart(2, '0')}.js`);
  const a = await auditer({ 'index.html': charge(...noms), ...Object.fromEntries(noms.map((n) => [n, TYPESCRIPT])) });
  const constats = ILLISIBLE(a);
  assert.equal(constats.length, 51);
  assert.deepEqual(constats.slice(0, 50).map((c) => c.fichier), noms.slice(0, 50));
  const groupe = constats[50];
  assert.equal(etat(groupe), 'critique bloquant');
  assert.equal(groupe.titre, '2 autres codes que l\'outil ne sait pas lire');
  assert.equal(groupe.axe, 'C');
  assert.equal(groupe.confiance, 'certain');
  assert.ok(groupe.impact && groupe.remediation);
  assert.equal(groupe.remediation, constats[0].remediation, 'deux fichiers de la même cause : la remédiation de cette cause, une fois');
  assert.match(groupe.constat, /52 codes exécutés par le navigateur n'ont pu être lus ; les 50 premiers sont dits un à un/);
  assert.deepEqual(groupe.preuve.emplacements.map((e) => e.fichier), noms.slice(50));
  assert.deepEqual(groupe.axesEmpeches, TOUS);
  const cinquante = await auditer({ 'index.html': charge(...noms.slice(0, 50)), ...Object.fromEntries(noms.slice(0, 50).map((n) => [n, TYPESCRIPT])) });
  assert.equal(ILLISIBLE(cinquante).length, 50, 'cinquante tiennent un à un : aucun groupe');
  const cinquanteEtUn = await auditer({ 'index.html': charge(...noms.slice(0, 51)), ...Object.fromEntries(noms.slice(0, 51).map((n) => [n, TYPESCRIPT])) });
  assert.equal(ILLISIBLE(cinquanteEtUn).length, 51);
  assert.equal(ILLISIBLE(cinquanteEtUn)[50].titre, '1 autre code que l\'outil ne sait pas lire');
});

test('le groupe des autres illisibles donne la remédiation de chaque cause qu\'il regroupe, une fois chacune', async () => {
  const noms = Array.from({ length: 52 }, (_, i) => `f${String(i).padStart(2, '0')}.js`);
  const fichiers = Object.fromEntries(noms.map((n, i) => [n, i === 51 ? imbriques(PROFOND) : TYPESCRIPT]));
  const a = await auditer({ 'index.html': charge(...noms), ...fichiers });
  const constats = ILLISIBLE(a);
  assert.equal(constats.length, 51);
  const groupe = constats[50];
  assert.deepEqual(groupe.preuve.emplacements.map((e) => [e.fichier, e.cause]), [['f50.js', 'syntaxe'], ['f51.js', 'profondeur']]);
  const profond = await auditer({ 'index.html': charge('p.js'), 'p.js': imbriques(PROFOND) });
  assert.notEqual(ILLISIBLE(profond)[0].remediation, constats[0].remediation, 'les deux causes ne se remédient pas de la même façon');
  assert.equal(groupe.remediation, `${constats[0].remediation} ${ILLISIBLE(profond)[0].remediation}`);
});

test('les axes du groupe des autres illisibles sont ceux de ce qu\'il regroupe : A reste à sa note si tout le reste est de la bibliothèque tierce', async () => {
  const contributeur = Array.from({ length: 50 }, (_, i) => `a${String(i).padStart(2, '0')}.js`);
  const fabriquer = async (reste) => {
    const noms = [...contributeur, ...reste];
    return auditer({ 'index.html': charge(...noms), ...Object.fromEntries(noms.map((n) => [n, TYPESCRIPT])) });
  };
  const tiers = await fabriquer(['libs/a.js', 'libs/b.js']);
  assert.deepEqual(ILLISIBLE(tiers)[50].axesEmpeches, SANS_A, 'le reste est de la bibliothèque tierce : A n\'en juge pas le code');
  const mixte = await fabriquer(['libs/a.js', 'zz.js']);
  assert.deepEqual(ILLISIBLE(mixte)[50].axesEmpeches, TOUS, 'un seul fichier du contributeur dans le reste suffit');
});

test('l\'axe A ne juge pas le code d\'une bibliothèque tierce : un code illisible sous un chemin de bibliothèque laisse A à sa note, le code du contributeur l\'empêche', async () => {
  const axes = async (chemin) => {
    const a = await auditer({ 'index.html': charge(chemin), [chemin]: TYPESCRIPT });
    return ILLISIBLE(a)[0].axesEmpeches;
  };
  assert.deepEqual(await axes('libs/gros.js'), SANS_A);
  assert.deepEqual(await axes('app.min.js'), SANS_A);
  assert.deepEqual(await axes('dist/app.js'), SANS_A, 'un dossier exclu de l\'inventaire : code généré, que A ne juge pas');
  assert.deepEqual(await axes('mien.js'), TOUS);
  const mixte = await auditer({ 'index.html': charge('libs/gros.js', 'mien.js'), 'libs/gros.js': TYPESCRIPT, 'mien.js': TYPESCRIPT });
  assert.deepEqual(noterStatique(mixte.constats).axesEmpeches, TOUS, 'le fichier du contributeur suffit à empêcher A');
  const seulTiers = await auditer({ 'index.html': charge('libs/gros.js'), 'libs/gros.js': TYPESCRIPT });
  assert.deepEqual(noterStatique(seulTiers.constats).axesEmpeches, SANS_A);
});

test('cacher une exfiltration derrière une syntaxe que l\'analyse ne lit pas ne note jamais mieux que la laisser lire : axe par axe, le code illisible vaut au plus le lisible', async () => {
  const lisible = await auditer({ 'index.html': charge('app.js'), 'app.js': EXFIL });
  const cache = await auditer({ 'index.html': charge('app.js'), 'app.js': `${EXFIL}${TYPESCRIPT}` });
  assert.ok(lisible.de('C-EXFIL-01').length > 0, 'lisible, l\'exfiltration est vue');
  assert.deepEqual(cache.de('C-EXFIL-01'), [], 'illisible, elle ne l\'est pas : c\'est tout l\'intérêt de la cacher');
  assert.equal(ILLISIBLE(cache).length, 1, 'mais l\'outil dit qu\'il n\'a pas lu');
  const nLisible = noterStatique(lisible.constats);
  const nCache = noterStatique(cache.constats);
  assert.equal(nCache.verdict, 'NON CONFORME');
  for (const axe of TOUS) {
    assert.ok(nCache.parAxe[axe].score <= nLisible.parAxe[axe].score, `${axe} : ${nCache.parAxe[axe].score} contre ${nLisible.parAxe[axe].score}`);
    assert.equal(nCache.parAxe[axe].score, 0, axe);
    assert.equal(nCache.parAxe[axe].empeche, true, axe);
    assert.equal(nCache.parAxe[axe].causes[0].regle, 'C-SURFACE-03', axe);
  }
});

// Ce qu'une adresse désigne comme du code --------------------------------------------------------------------------------

test('un fichier qu\'une balise script désigne par son adresse est du code quelle que soit son extension : il se lit comme du code, et n\'est lu que si la page le charge', async () => {
  const charge_ = await auditer({ 'index.html': charge('logique.txt'), 'logique.txt': EXFIL });
  assert.ok(charge_.surface.includes('logique.txt'));
  assert.ok(charge_.de('C-EXFIL-01', 'logique.txt').length > 0, 'l\'exfiltration d\'un fichier .txt chargé comme script est vue');
  const libre = await auditer({ 'index.html': charge('app.js'), 'app.js': SANS_RIEN, 'logique.txt': EXFIL });
  assert.deepEqual(libre.de('C-EXFIL-01'), [], 'le même texte, qu\'aucune page ne charge, n\'est pas du code exécuté');
  const illisible = await auditer({ 'index.html': charge('logique.txt'), 'logique.txt': TYPESCRIPT });
  const [c] = ILLISIBLE(illisible);
  assert.equal(c.fichier, 'logique.txt');
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.preuve.cause, 'syntaxe');
});

test('un import, un import() ou un worker qui désigne un fichier par son adresse en fait du code lu ; un import de données (`with { type }`) n\'en fait pas', async () => {
  const fichiers = (corps, plus) => ({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': corps, ...plus });
  const importe = await auditer(fichiers("import './regles.txt';\n", { 'regles.txt': EXFIL }));
  assert.ok(importe.de('C-EXFIL-01', 'regles.txt').length > 0, 'import');
  const dynamique = await auditer(fichiers("import('./regles.txt');\n", { 'regles.txt': EXFIL }));
  assert.ok(dynamique.de('C-EXFIL-01', 'regles.txt').length > 0, 'import()');
  const worker = await auditer(fichiers("new Worker('./regles.txt');\n", { 'regles.txt': EXFIL }));
  assert.ok(worker.de('C-EXFIL-01', 'regles.txt').length > 0, 'worker');
  for (const type of ['css', 'json', 'text', 'bytes']) {
    for (const [forme, corps] of [['import', `import d from './d.txt' with { type: '${type}' };\n`], ['export from', `export { default } from './d.txt' with { type: '${type}' };\n`], ['import()', `import('./d.txt', { with: { type: '${type}' } });\n`]]) {
      const donnees = await auditer(fichiers(corps, { 'd.txt': 'body { color: red; }\n' }));
      assert.ok(donnees.surface.includes('d.txt'), `${type} ${forme} : le fichier est atteint`);
      assert.deepEqual(ILLISIBLE(donnees), [], `${type} ${forme} : une donnée importée n'est pas du code que l'outil ne sait pas lire`);
      assert.equal(donnees.fichier('d.txt').commeCode, false, `${type} ${forme}`);
    }
  }
  const sansType = await auditer(fichiers("import d from './d.txt' with { foo: 'css' };\n", { 'd.txt': 'body { color: red; }\n' }));
  assert.equal(sansType.fichier('d.txt').commeCode, true, 'un attribut qui n\'est pas `type` ne change pas ce que le navigateur exécute');
  const autreType = await auditer(fichiers("import d from './d.txt' with { type: 'webassembly' };\n", { 'd.txt': 'body { color: red; }\n' }));
  assert.equal(autreType.fichier('d.txt').commeCode, true, 'un type qui n\'est pas de la donnée : le navigateur ne le reconnaît pas, on ne le tient pas pour de la donnée');
});

test('un fichier que seule une carte d\'import désigne : lu comme du code s\'il se lit comme du JavaScript, donnée s\'il est du JSON, information groupée sinon', async () => {
  const accueil = page('<script type="module" src="app.js"></script>', carte({ regles: './regles.txt', donnees: './donnees.json', style: './style.css' }));
  const a = await auditer({ 'index.html': accueil, 'app.js': SANS_RIEN, 'regles.txt': `${EXFIL}import './suite.js';\n`, 'suite.js': SANS_RIEN, 'donnees.json': '{"a": [1, 2]}\n', 'style.css': 'body { color: red; }\n' });
  assert.ok(a.surface.includes('suite.js'), 'un fichier que la carte désigne et qui se lit comme du JavaScript est suivi comme du code : ce qu\'il importe est atteint');
  assert.ok(a.surface.includes('regles.txt') && a.surface.includes('donnees.json') && a.surface.includes('style.css'), 'la carte les désigne : la surface les atteint');
  assert.equal(a.fichier('regles.txt').commeCode, 'probable');
  assert.equal(a.fichier('donnees.json').commeCode, false, 'du JSON valide est de la donnée, jamais du code');
  assert.equal(a.fichier('style.css').commeCode, 'probable');
  assert.ok(a.de('C-EXFIL-01', 'regles.txt').length > 0, 'ce que la carte désigne et qui se lit comme du JavaScript est lu comme tel');
  const [c] = ILLISIBLE(a);
  assert.equal(ILLISIBLE(a).length, 1, 'le JSON n\'est pas dit, le JavaScript lisible non plus');
  assert.equal(etat(c), 'info', 'le CSS qu\'une carte désigne peut être de la donnée : une information, non un blocage');
  assert.match(c.titre, /1 fichier désigné par une carte d'import que l'outil ne lit pas comme du code/);
  assert.match(c.constat, /style\.css/);
  assert.deepEqual(c.preuve.emplacements.map((e) => [e.fichier, e.cause]), [['style.css', 'donnee-possible']]);
  assert.deepEqual(c.axesEmpeches, [], 'une information n\'empêche aucun axe');
  assert.deepEqual(noterStatique(a.constats).axesEmpeches, []);
  const deux = await auditer({ 'index.html': page('', carte({ a: './a.css', b: './b.css' })), 'a.css': 'a { b: c; }\n', 'b.css': 'b { c: d; }\n' });
  assert.match(ILLISIBLE(deux)[0].titre, /^2 fichiers désignés par une carte d'import/);
});

test('du JSON valide n\'exécute rien : désigné par une balise script, il n\'est ni du code lu ni du code que l\'outil ne sait pas lire', async () => {
  const objet = await auditer({ 'index.html': charge('config.txt'), 'config.txt': '{"a": [1, 2], "b": "import(\'./x.js\')"}\n' });
  assert.equal(objet.fichier('config.txt').commeCode, false);
  assert.deepEqual(ILLISIBLE(objet), []);
  assert.deepEqual(noterStatique(objet.constats).axesEmpeches, []);
  const valeur = await auditer({ 'index.html': charge('n.txt'), 'n.txt': '42\n' });
  assert.equal(valeur.fichier('n.txt').commeCode, false);
  const pasDuJson = await auditer({ 'index.html': charge('n.txt'), 'n.txt': "{'a': 1}\n" });
  assert.equal(pasDuJson.fichier('n.txt').commeCode, true, 'des guillemets simples ne sont pas du JSON : le navigateur le lit comme un script');
  assert.equal(ILLISIBLE(pasDuJson)[0]?.fichier, 'n.txt');
});

test('un fichier parcouru comme probable puis désigné comme du code par un import est relu comme du code : ses références comptent, même si l\'analyse ne le lit pas', async () => {
  const accueil = page('<script type="module" src="a.js"></script>', carte({ logique: './logique.txt' }));
  const a = await auditer({ 'index.html': accueil, 'a.js': "import './b.js';\n", 'b.js': "import './logique.txt';\n", 'logique.txt': "let x: number;\nimport './profond.js';\n", 'profond.js': EXFIL });
  assert.equal(a.fichier('logique.txt').commeCode, true);
  assert.ok(a.surface.includes('profond.js'), 'ce que le code désigné importe est atteint, par les expressions régulières quand acorn ne lit pas');
  assert.ok(a.de('C-EXFIL-01', 'profond.js').length > 0);
  const probable = await auditer({ 'index.html': accueil, 'a.js': SANS_RIEN, 'logique.txt': "let x: number;\nimport './profond.js';\n", 'profond.js': EXFIL });
  assert.equal(probable.fichier('logique.txt').commeCode, 'probable');
  assert.ok(!probable.surface.includes('profond.js'), 'désigné par la seule carte et ne se lisant pas comme du JavaScript : ses références ne sont pas suivies');
});

test('un fichier que la carte d\'import désigne ET qu\'une balise ou un import écrit désigne comme du code est du code : illisible, il bloque', async () => {
  const accueil = page('<script src="style.css"></script>', carte({ style: './style.css' }));
  const a = await auditer({ 'index.html': accueil, 'style.css': 'body { color: red; }\n' });
  assert.equal(a.fichier('style.css').commeCode, true, 'la désignation sûre l\'emporte sur la probable');
  const [c] = ILLISIBLE(a);
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.fichier, 'style.css');
});

test('une erreur de l\'outil sur un code lisible (cause « analyse ») est un critique bloquant qui le dit et renvoie au rapport d\'erreur, sans conseiller de réécrire le code', () => {
  const unite = { chemin: 'app.js', cause: 'analyse', message: 'TypeError : boom', inline: false, facultative: false, ligne: null, colonne: null, surface: true, dossierExclu: false };
  const [c] = analyserIllisibles({ illisibles: new Map([['app.js\0fichier', unite]]) });
  assert.equal(etat(c), 'critique bloquant');
  assert.match(c.constat, /L'analyse de ce code s'est interrompue sur une erreur \(TypeError : boom\)/);
  assert.equal(c.remediation, 'Signaler l\'erreur avec ce rapport ; tant qu\'elle n\'est pas corrigée, ce code n\'est pas audité.');
  assert.deepEqual(c.axesEmpeches, TOUS);
  assert.equal(c.preuve.cause, 'analyse');
});

// Les noms que du code lu importe, résolus par la carte d'import de la page -------------------------------------------------------

const module = (src) => `<script type="module" src="${src}"></script>`;
const cartes = (objet) => `<script type="importmap">${JSON.stringify(objet)}</script>`;

test('un nom que du code lu importe et que la carte d\'import de la page résout désigne son fichier comme du code : illisible, il bloque ; sans import, il reste une information', async () => {
  const accueil = page(module('app.js'), cartes({ imports: { lib: './modules/lib.txt' } }));
  const a = await auditer({ 'index.html': accueil, 'app.js': "import lib from 'lib';\nexport default lib;\n", 'modules/lib.txt': `${SANS_RIEN}${TYPESCRIPT}` });
  assert.equal(a.fichier('modules/lib.txt').commeCode, true, 'le navigateur charge ce que « lib » désigne comme du code, quelle que soit l\'extension');
  const [c] = ILLISIBLE(a);
  assert.equal(ILLISIBLE(a).length, 1);
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.fichier, 'modules/lib.txt');
  assert.equal(c.preuve.cause, 'syntaxe');
  assert.deepEqual(noterStatique(a.constats).axesEmpeches, TOUS);
  const sansImport = await auditer({ 'index.html': accueil, 'app.js': SANS_RIEN, 'modules/lib.txt': `${SANS_RIEN}${TYPESCRIPT}` });
  assert.equal(sansImport.fichier('modules/lib.txt').commeCode, 'probable', 'rien n\'importe « lib » : la carte seule désigne le fichier');
  assert.equal(etat(ILLISIBLE(sansImport)[0]), 'info');
  assert.deepEqual(noterStatique(sansImport.constats).axesEmpeches, []);
});

test('un nom s\'importe de toutes les façons que le navigateur reconnaît : import statique, export … from, import() littéral, script inline de la page', async () => {
  const fichiers = (corps) => ({ 'index.html': page(module('app.js'), cartes({ imports: { lib: './lib.txt' } })), 'app.js': corps, 'lib.txt': TYPESCRIPT });
  for (const [forme, corps] of [
    ['import statique sans liaison', "import 'lib';\n"],
    ['import statique', "import x from 'lib';\nexport { x };\n"],
    ['export … from', "export * from 'lib';\n"],
    ['export nommé … from', "export { x } from 'lib';\n"],
    ['import() littéral', "import('lib');\n"],
    ['import() littéral en gabarit', 'import(`lib`);\n'],
  ]) {
    const a = await auditer(fichiers(corps));
    assert.equal(a.fichier('lib.txt').commeCode, true, forme);
    assert.equal(etat(ILLISIBLE(a)[0]), 'critique bloquant', forme);
  }
  const enPage = await auditer({ 'index.html': page('<script type="module">import "lib";</script>', cartes({ imports: { lib: './lib.txt' } })), 'lib.txt': TYPESCRIPT });
  assert.equal(enPage.fichier('lib.txt').commeCode, true, 'le script inline d\'un module de la page');
  const calcule = await auditer(fichiers("const n = 'li' + 'b';\nimport(n);\n"));
  assert.equal(calcule.fichier('lib.txt').commeCode, 'probable', 'un nom calculé ne désigne aucun fichier en particulier : la limite est dite au message (étape des chargeurs)');
});

test('un import de données par un nom n\'en fait pas du code ; le même fichier importé aussi sans attribut en est', async () => {
  const f = (corps) => ({ 'index.html': page(module('app.js'), cartes({ imports: { feuille: './style.css' } })), 'app.js': corps, 'style.css': 'body { color: red; }\n' });
  for (const [forme, corps] of [
    ['import statique with type css', "import s from 'feuille' with { type: 'css' };\n"],
    ['export … from with type css', "export { default } from 'feuille' with { type: 'css' };\n"],
    ['import() avec with type css', "import('feuille', { with: { type: 'css' } });\n"],
    ['import() avec assert type css', "import('feuille', { assert: { type: 'css' } });\n"],
  ]) {
    const a = await auditer(f(corps));
    assert.equal(a.fichier('style.css').commeCode, 'probable', `${forme} : le navigateur n'exécute pas une feuille importée comme telle`);
    assert.equal(etat(ILLISIBLE(a)[0]), 'info', forme);
  }
  const deuxFois = await auditer(f("import s from 'feuille' with { type: 'css' };\nimport 'feuille';\n"));
  assert.equal(deuxFois.fichier('style.css').commeCode, true, 'un import sans attribut exécute le fichier comme un script de module');
  assert.equal(etat(ILLISIBLE(deuxFois)[0]), 'critique bloquant');
});

test('une clé de préfixe désigne comme du code chaque fichier que le code importe sous elle, quelle que soit son extension, et rien d\'autre du dossier', async () => {
  const a = await auditer({
    'index.html': page(module('app.js'), cartes({ imports: { 'lib/': './vendor/dir/' } })),
    'app.js': "import 'lib/x.txt';\nimport('lib/sous/y.data');\n",
    'vendor/dir/x.txt': `${EXFIL}${TYPESCRIPT}`, 'vendor/dir/sous/y.data': 'var b = 2;\n', 'vendor/dir/z.txt': TYPESCRIPT,
  });
  assert.ok(a.surface.includes('vendor/dir/x.txt') && a.surface.includes('vendor/dir/sous/y.data'), 'ce que le navigateur charge sous le préfixe est dans la surface, quelle que soit son extension');
  assert.ok(!a.surface.includes('vendor/dir/z.txt'), 'un fichier du dossier que rien n\'importe n\'est pas chargé');
  assert.equal(a.fichier('vendor/dir/x.txt').commeCode, true);
  assert.equal(a.fichier('vendor/dir/sous/y.data').commeCode, true);
  assert.deepEqual(ILLISIBLE(a).map((c) => c.fichier), ['vendor/dir/x.txt'], 'celui qui ne se lit pas est dit, celui qui se lit est audité');
  assert.ok(a.de('C-EXFIL-01', 'vendor/dir/x.txt').length === 0, 'illisible : aucune règle n\'a lu ce fichier');
  const lisible = await auditer({
    'index.html': page(module('app.js'), cartes({ imports: { 'lib/': './vendor/dir/' } })),
    'app.js': "import 'lib/x.txt';\n", 'vendor/dir/x.txt': EXFIL,
  });
  assert.ok(lisible.de('C-EXFIL-01', 'vendor/dir/x.txt').length > 0, 'un fichier à extension quelconque que la page charge sous un préfixe est lu comme du code : il n\'échappait à toute règle avant');
});

test('les portées de la carte s\'appliquent au module qui importe : la table de son dossier, sinon celle du dessus, et aucune des deux sans le nom', async () => {
  const carteDePortee = cartes({ imports: { lib: './haut/lib.txt' }, scopes: { './app/': { lib: './app/lib.txt' } } });
  const a = await auditer({ 'index.html': page(`${module('app/main.js')}${module('main.js')}`, carteDePortee), 'app/main.js': "import 'lib';\n", 'main.js': SANS_RIEN, 'app/lib.txt': TYPESCRIPT, 'haut/lib.txt': TYPESCRIPT });
  assert.equal(a.fichier('app/lib.txt').commeCode, true, 'le module de app/ voit la table de sa portée');
  assert.equal(a.fichier('haut/lib.txt').commeCode, 'probable', 'la table du dessus n\'est pas celle de ce module');
  const dessus = await auditer({ 'index.html': page(module('main.js'), carteDePortee), 'main.js': "import 'lib';\n", 'app/lib.txt': TYPESCRIPT, 'haut/lib.txt': TYPESCRIPT });
  assert.equal(dessus.fichier('haut/lib.txt').commeCode, true, 'un module hors de la portée voit la table du dessus');
  assert.equal(dessus.fichier('app/lib.txt').commeCode, 'probable');
  const sansLeNom = await auditer({ 'index.html': page(module('app/main.js'), cartes({ imports: { lib: './haut/lib.txt' }, scopes: { './app/': { autre: './app/autre.txt' } } })), 'app/main.js': "import 'lib';\n", 'app/autre.txt': TYPESCRIPT, 'haut/lib.txt': TYPESCRIPT });
  assert.equal(sansLeNom.fichier('haut/lib.txt').commeCode, true, 'la portée ne nomme pas « lib » : celle du dessus répond');
  assert.equal(sansLeNom.fichier('app/autre.txt').commeCode, 'probable');
  const imbriquees = await auditer({
    'index.html': page(module('sub/deep/m.js'), cartes({ scopes: { './sub/': { x: './court.txt' }, './sub/deep/': { x: './long.txt' } } })),
    'sub/deep/m.js': "import 'x';\n", 'court.txt': TYPESCRIPT, 'long.txt': TYPESCRIPT,
  });
  assert.equal(imbriquees.fichier('court.txt').commeCode, true, 'Chromium 141 retient l\'une ou l\'autre de deux portées imbriquées : les deux sont du code');
  assert.equal(imbriquees.fichier('long.txt').commeCode, true);
});

test('ce qu\'aucune carte ne résout ne désigne rien : nom sans clé, adresse bloquée, adresse hors du widget, carte d\'une autre page', async () => {
  const f = (carteDeLaPage, corps) => ({ 'index.html': page(module('app.js'), carteDeLaPage), 'app.js': corps, 'lib.txt': TYPESCRIPT });
  const sansCle = await auditer(f(cartes({ imports: { autre: './autre.js' } }), "import 'lib';\n"));
  assert.ok(!sansCle.surface.includes('lib.txt'), 'un nom nu qu\'aucune clé ne nomme est une erreur du navigateur : le fichier local du même nom n\'est jamais chargé');
  const bloque = await auditer(f(cartes({ imports: { lib: null } }), "import 'lib';\n"));
  assert.ok(!bloque.surface.includes('lib.txt'));
  const dehors = await auditer(f(cartes({ imports: { lib: 'https://cdn.example/lib.js' } }), "import 'lib';\n"));
  assert.ok(!dehors.surface.includes('lib.txt'));
  const sansCarte = await auditer(f('', "import 'lib';\n"));
  assert.ok(!sansCarte.surface.includes('lib.txt'));
  for (const a of [sansCle, bloque, dehors, sansCarte]) assert.deepEqual(ILLISIBLE(a), []);
  const autrePage = await auditer({
    'index.html': page('<script type="module">import "lib";</script>'), 'b.html': page('', cartes({ imports: { lib: './lib.txt' } })), 'lib.txt': TYPESCRIPT,
    'manifest.json': JSON.stringify({ widgets: [{ name: 'b', url: 'b.html' }] }),
  });
  assert.ok(autrePage.surface.includes('b.html'), 'prémisse : la seconde page est un point d\'entrée');
  assert.equal(autrePage.fichier('lib.txt').commeCode, 'probable', 'le script inline d\'index.html n\'a pas la carte de b.html : son import échoue, la carte seule désigne le fichier');
});

test('deux fichiers qui importent le même nom sous deux portées de la carte désignent chacun le fichier de sa portée', async () => {
  const a = await auditer({
    'index.html': page(`${module('a/m.js')}${module('b/m.js')}`, cartes({ scopes: { './a/': { x: './un.txt' }, './b/': { x: './deux.txt' } } })),
    'a/m.js': "import 'x';\n", 'b/m.js': "import 'x';\n", 'un.txt': TYPESCRIPT, 'deux.txt': TYPESCRIPT,
  });
  assert.equal(a.fichier('un.txt').commeCode, true);
  assert.equal(a.fichier('deux.txt').commeCode, true, 'le second importeur a sa propre portée : son nom ne se confond pas avec celui du premier');
  assert.deepEqual(ILLISIBLE(a).map((c) => c.fichier).sort(), ['deux.txt', 'un.txt']);
});

test('un script de la page résout ses noms sous la `<base>` qui le précède ; celui qui la précède les résout sous la page', async () => {
  const accueil = page(`<script type="module">import './x.txt';</script><base href="sub/"><script type="module">import './x.txt';</script>`, cartes({ imports: { '/sub/x.txt': './y.txt' } }));
  const a = await auditer({ 'index.html': accueil, 'y.txt': TYPESCRIPT });
  assert.equal(a.fichier('y.txt').commeCode, true, 'sous `<base href="sub/">`, « ./x.txt » est « /sub/x.txt » : la clé de la carte, qui mène à y.txt');
  assert.equal(etat(ILLISIBLE(a)[0]), 'critique bloquant');
  const avant = await auditer({ 'index.html': page(`<script type="module">import './x.txt';</script><base href="sub/">`, cartes({ imports: { '/sub/x.txt': './y.txt' } })), 'y.txt': TYPESCRIPT });
  assert.equal(avant.fichier('y.txt').commeCode, 'probable', 'le script qui précède la `<base>` résout « ./x.txt » en « /x.txt » : aucune clé ne le nomme');
});

test('un code dont le parcours déborde garde les noms qu\'il a donnés avant de déborder : ce qu\'il importe avant le piège désigne son fichier', async () => {
  const a = await auditer({ 'index.html': page(module('app.js'), cartes({ imports: { lib: './lib.txt' } })), 'app.js': `import 'lib';\n${somme(LONGUE)}`, 'lib.txt': TYPESCRIPT });
  assert.equal(a.fichier('lib.txt').commeCode, true, 'l\'import a été lu dans l\'arbre avant que le parcours ne déborde : c\'est un vrai import');
  assert.deepEqual(ILLISIBLE(a).map((c) => [c.fichier, c.preuve.cause]).sort(), [['app.js', 'profondeur'], ['lib.txt', 'syntaxe']]);
});

test('la résolution d\'un nom coûte la taille de la carte qui le résout, et une page relue comme du code ne compte pas sa carte deux fois', async () => {
  const cles = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}/`, `./p${i}/`]));
  const pas = (n) => avecWidget({ 'index.html': page(module('app.js'), carte({ ...cles(n), lib: './lib.txt' })), 'app.js': "import 'lib';\n", 'lib.txt': TYPESCRIPT }, {}, async (racine) => construireContexte(racine).pasDocuments());
  const petite = await pas(5);
  const grande = await pas(55);
  assert.ok(grande - petite >= 50, `cinquante clés de préfixe de plus coûtent au moins cinquante pas (${petite}, puis ${grande})`);
  const relue = (extra) => avecWidget({ 'index.html': page(`${carte({ lib: './lib.txt' })}<script type="module">import "lib";</script>${extra}`), 'lib.txt': TYPESCRIPT }, {}, async (racine) => construireContexte(racine).pasDocuments());
  assert.equal(await relue('<script type="module" src="index.html"></script>'), await relue(''), 'la page qui se charge elle-même est relue comme du code : sa carte ne se compte pas deux fois');
});

test('un fichier que la carte désigne est lu une fois que le code qui l\'importe est lu, quel que soit l\'ordre où la fermeture rencontre la page, le code et les fichiers', async () => {
  const chaine = {
    'app.js': "import 'un';\n", 'un.txt': "import 'deux';\n", 'deux.txt': "import('trois');\n", 'trois.txt': TYPESCRIPT,
  };
  const carte3 = cartes({ imports: { un: './un.txt', deux: './deux.txt', trois: './trois.txt' } });
  const lien = (href) => `<link rel="help" href="${href}">`;      // la fermeture atteint cette page après les scripts de celle qui la désigne
  const pageAvant = await auditer({ 'index.html': page(module('app.js'), carte3), ...chaine });
  const pageApres = await auditer({ 'index.html': page(`${module('app.js')}${lien('b.html')}`), 'b.html': page('', carte3), ...chaine });
  const pageAvantLeCode = await auditer({ 'index.html': page(lien('c.html'), carte3), 'c.html': page(module('app.js')), ...chaine });
  assert.ok(pageApres.surface.includes('b.html') && pageAvantLeCode.surface.includes('c.html'), 'prémisse : les pages liées sont atteintes');
  for (const [ordre, a] of [['la page avant le code', pageAvant], ['le code avant la page qui a la carte', pageApres], ['la carte d\'abord, le code depuis une autre page', pageAvantLeCode]]) {
    for (const f of ['un.txt', 'deux.txt', 'trois.txt']) assert.equal(a.fichier(f).commeCode, true, `${ordre} : ${f}`);
    assert.deepEqual(ILLISIBLE(a).map((c) => c.fichier), ['trois.txt'], `${ordre} : le dernier maillon ne se lit pas, les autres sont audités`);
  }
});

test('un code que l\'outil ne lit pas ne désigne rien par ses noms : ce que son texte semble importer peut être un commentaire ou une chaîne', async () => {
  const a = await auditer({
    'index.html': page(module('app.js'), cartes({ imports: { lib: './lib.txt' } })),
    'app.js': `${TYPESCRIPT}import 'lib';\n`, 'lib.txt': TYPESCRIPT,
  });
  const bloquants = ILLISIBLE(a).filter((c) => c.bloquant);
  assert.deepEqual(bloquants.map((c) => c.fichier), ['app.js'], 'app.js est dit illisible');
  assert.deepEqual(ILLISIBLE(a).filter((c) => !c.bloquant).flatMap((c) => c.preuve.emplacements.map((e) => e.fichier)), ['lib.txt'], 'lib.txt n\'est désigné que par la carte : une information');
  assert.equal(a.fichier('lib.txt').commeCode, 'probable');
  const commente = await auditer({ 'index.html': page(module('app.js'), cartes({ imports: { lib: './lib.txt' } })), 'app.js': "// import 'lib';\nconst t = \"import 'lib'\";\n", 'lib.txt': TYPESCRIPT });
  assert.equal(commente.fichier('lib.txt').commeCode, 'probable', 'un import écrit dans un commentaire ou une chaîne n\'importe rien');
});

test('la résolution des noms par les cartes coûte des pas d\'analyse de document, bornés : le plafond atteint est dit, il ne désigne rien en silence', async () => {
  const cles = Object.fromEntries(['p0/', 'p1/', 'p2/', 'p3/', 'p4/'].map((k) => [k, `./${k}`]));
  const fichiers = {
    'index.html': page(module('app.js'), cartes({ imports: { ...cles, lib: './lib.txt' } })),
    'app.js': "import 'lib';\nimport 'p0/a.js';\nimport 'autre';\n",
    'lib.txt': TYPESCRIPT, 'p0/a.js': SANS_RIEN,
  };
  const assez = await auditer(fichiers);
  const pas = assez.ctx.pasDocuments();
  assert.ok(pas > 0, 'la résolution dépense des pas');
  assert.equal(assez.ctx.tronque, null);
  assert.equal(assez.fichier('lib.txt').commeCode, true);
  const juste = await auditer(fichiers, { plafonds: { maxPasDocuments: pas } });
  assert.equal(juste.ctx.tronque, null, 'un plafond égal à ce que la résolution dépense suffit');
  const trop = await auditer(fichiers, { plafonds: { maxPasDocuments: pas - 1 } });
  assert.equal(trop.ctx.tronque.documents, true);
  const [c] = trop.de('C-SURFACE-01');
  assert.equal(c.preuve.plafond, 'documents');
  assert.equal(etat(c), 'critique bloquant');
  assert.match(c.titre, /pas d'analyse de document/);
});

// Les outils de lecture ---------------------------------------------------------------------------------------------------

test('lire : l\'arbre d\'un code lisible, sinon la raison et l\'endroit où acorn s\'arrête (syntaxe, ou profondeur)', () => {
  const ok = lire(`${SANS_RIEN}// fin\n`);
  assert.equal(ok.erreur, null);
  assert.equal(ok.ast.type, 'Program');
  assert.ok(ok.ast.commentaires.length === 1);
  const ts = lire(`${SANS_RIEN}${TYPESCRIPT}`);
  assert.equal(ts.ast, null);
  assert.deepEqual({ ...ts.erreur, position: undefined }, { cause: 'syntaxe', message: 'Unexpected token', ligne: 2, colonne: 6, position: undefined });
  assert.equal(typeof ts.erreur.position, 'number');
  const profond = lire(imbriques(PROFOND));
  assert.equal(profond.ast, null);
  assert.equal(profond.erreur.cause, 'profondeur');
  assert.equal(profond.erreur.message, 'la pile déborde');
  const importe = lire('import x from "./a.js";\nexport default x;\n');
  assert.ok(importe.ast, 'une syntaxe de module se lit');
  const moduleLoin = lire('with (a) {}\nlet x: number;\n');
  assert.equal(moduleLoin.erreur.ligne, 2, 'en mode script le with se lit : la lecture va plus loin que le mode module, qui s\'arrête au with');
  const scriptLoin = lire('await foo();\nlet x: number;\n');
  assert.equal(scriptLoin.erreur.ligne, 2, 'en mode module l\'await de premier niveau se lit : la lecture va plus loin que le mode script');
  const classique = lire('return 1;\n');
  assert.equal(classique.ast, null, 'un return hors d\'une fonction ne se lit ni en module ni en script');
  assert.equal(classique.erreur.cause, 'syntaxe');
});

test('depassementDePile : le RangeError de V8 et l\'erreur que la lecture d\'acorn en fait, rien d\'autre', () => {
  assert.equal(depassementDePile(new RangeError('Maximum call stack size exceeded')), true);
  assert.equal(depassementDePile(new SyntaxError('Not enough stack space to parse input (1:815)')), true);
  assert.equal(depassementDePile(new RangeError('Invalid array length')), false);
  assert.equal(depassementDePile(new SyntaxError('Unexpected token (1:5)')), false);
  assert.equal(depassementDePile(new Error('Maximum call stack size exceeded')), false, 'seule l\'erreur du bon type en est un');
  assert.equal(depassementDePile(new Error('Not enough stack space to parse input')), false, 'de même pour celle de la lecture : une erreur de syntaxe');
  assert.equal(depassementDePile(new TypeError('x is not a function')), false);
  assert.equal(depassementDePile('Maximum call stack size exceeded'), false);
  assert.equal(depassementDePile(null), false);
});

test('unitesJs : un fichier JavaScript, un fichier qu\'une adresse désigne comme du code, les scripts d\'une page puis (si la page est désignée) la page entière en dernier', () => {
  const fichier = (extra) => ({ chemin: 'f.txt', ext: '.txt', contenu: SANS_RIEN, binaire: false, ...extra });
  assert.equal(unitesJs(fichier({})).length, 0, 'du texte que rien ne désigne n\'est pas du code');
  assert.equal(unitesJs(fichier({ commeCode: false })).length, 0);
  assert.equal(unitesJs(fichier({ commeCode: true })).length, 1);
  assert.equal(unitesJs(fichier({ commeCode: true }))[0].facultative, false);
  assert.equal(unitesJs(fichier({ commeCode: 'probable' })).length, 1);
  assert.equal(unitesJs(fichier({ commeCode: 'probable' }))[0].facultative, true, 'une carte d\'import seule : l\'unité est facultative');
  assert.equal(unitesJs(fichier({ ext: '.js', commeCode: 'probable' }))[0].facultative, false, 'un .js est du code par son extension, désigné ou non');
  assert.equal(unitesJs(fichier({ ext: '.js' })).length, 1);
  assert.equal(unitesJs(fichier({ ext: '.js' }))[0].finLigne, Infinity);
  assert.equal(unitesJs(fichier({ commeCode: true, binaire: true })).length, 0, 'un binaire n\'a pas de texte');
  assert.equal(unitesJs(fichier({ commeCode: true, contenu: '' })).length, 0);
  const accueil = page('<script>var a = 1;</script>\n<script>var b = 2;</script>');
  const html = (extra) => ({ chemin: 'p.html', ext: '.html', contenu: accueil, binaire: false, lignes: accueil.split('\n'), ...extra });
  assert.equal(unitesJs(html({})).length, 2, 'les scripts de la page');
  const designee = unitesJs(html({ commeCode: true }));
  assert.equal(designee.length, 3, 'et la page entière, si une adresse la désigne comme du code');
  assert.equal(designee[2].inline, false, 'en dernier');
  assert.equal(designee[2].finLigne, 2, 'finie pour une page : ses lignes se parcourent');
  assert.deepEqual(designee.map((u) => u.finLigne), [1, 2, 2]);
});

test('pourChaqueUniteJs : l\'illisible de la surface se relève dans le contexte voulu, une règle qui échoue ne fait pas tomber les autres, une unité se relève une fois', () => {
  const fichier = (chemin, contenu, extra = {}) => ({ chemin, ext: '.js', contenu, binaire: false, executee: true, ...extra });
  const contexte = { fichiers: [fichier('a.js', SANS_RIEN), fichier('b.js', TYPESCRIPT), fichier('c.js', SANS_RIEN, { executee: false }), fichier('d.js', TYPESCRIPT, { executee: false })] };
  const vus = [];
  pourChaqueUniteJs(contexte, {}, ({ fichier: f }) => { vus.push(f.chemin); });
  assert.deepEqual(vus, ['a.js', 'c.js'], 'un fichier illisible n\'est pas visité');
  assert.deepEqual([...contexte.illisibles.values()].map((n) => `${n.chemin}:${n.cause}`), ['b.js:syntaxe'], 'd.js n\'est pas exécuté : un code que rien n\'exécute et qu\'acorn refuse n\'est pas relevé');
  pourChaqueUniteJs(contexte, {}, () => {});
  assert.equal(contexte.illisibles.size, 1, 'la même unité, relevée par un autre parcours, l\'est une fois');
  const ailleurs = { illisibles: new Map() };
  const autre = { fichiers: [fichier('e.js', TYPESCRIPT)] };
  pourChaqueUniteJs(autre, { releverDans: ailleurs }, () => {});
  assert.equal(autre.illisibles, undefined, 'relevé là où l\'appelant le demande');
  assert.equal(ailleurs.illisibles.size, 1);
  const pose = { fichiers: [fichier('f.js', SANS_RIEN), fichier('g.js', SANS_RIEN, { executee: false })] };
  const suivis = [];
  pourChaqueUniteJs(pose, {}, ({ fichier: f }) => { suivis.push(f.chemin); if (f.chemin === 'f.js') throw new TypeError('boom'); });
  assert.deepEqual(suivis, ['f.js', 'g.js'], 'la règle qui échoue sur un fichier continue sur le suivant');
  assert.deepEqual([...pose.illisibles.values()].map((n) => [n.chemin, n.cause, n.message, n.surface]), [['f.js', 'analyse', 'TypeError : boom', true]]);
  const deuxRaisons = { fichiers: [fichier('m.js', SANS_RIEN)] };
  pourChaqueUniteJs(deuxRaisons, {}, () => { throw new RangeError('Maximum call stack size exceeded'); });
  pourChaqueUniteJs(deuxRaisons, {}, () => { throw new TypeError('boom'); });
  assert.deepEqual([...deuxRaisons.illisibles.values()].map((n) => n.cause), ['profondeur'], 'la première raison est gardée : les règles suivantes qui échouent sur la même unité ne la remplacent pas');
  const longue = { fichiers: [fichier('l.js', SANS_RIEN)] };
  pourChaqueUniteJs(longue, {}, () => { throw new Error('y'.repeat(500)); });
  assert.equal([...longue.illisibles.values()][0].message, `Error : ${'y'.repeat(200)}`, 'le message d\'une erreur se dit tronqué à 200 caractères');
  const hors = { fichiers: [fichier('h.js', SANS_RIEN, { executee: false })] };
  pourChaqueUniteJs(hors, {}, () => { throw new RangeError('Maximum call stack size exceeded'); });
  assert.deepEqual([...hors.illisibles.values()].map((n) => [n.cause, n.message, n.surface]), [['profondeur', 'la pile déborde', false]], 'une règle qui échoue sur un fichier non exécuté est relevée, hors surface');
  const fige = { fichiers: [fichier('j.js', TYPESCRIPT)] };
  pourChaqueUniteJs(fige, {}, () => {});
  fige.fichiers[0].contenu = SANS_RIEN;
  const relus = [];
  pourChaqueUniteJs(fige, {}, ({ fichier: f }) => { relus.push(f.chemin); });
  assert.deepEqual(relus, [], 'une lecture qui a échoué n\'est pas refaite : la vingtaine de règles qui rencontrent le fichier ne la refont pas');
  const deux = { fichiers: [fichier('k.html', page('<script>let x: number;</script><script>var b = 2;</script>'), { ext: '.html' })] };
  const lus = [];
  pourChaqueUniteJs(deux, {}, ({ unite }) => { lus.push(unite.source); });
  pourChaqueUniteJs(deux, {}, ({ unite }) => { lus.push(unite.source); });
  assert.deepEqual(lus, ['var b = 2;', 'var b = 2;'], 'un script illisible ne rend pas illisible celui qui le suit dans la page');
  const seulSurface = { fichiers: [fichier('i.js', TYPESCRIPT, { executee: false })] };
  pourChaqueUniteJs(seulSurface, { surfaceSeulement: true }, () => {});
  assert.equal(seulSurface.illisibles, undefined);
});

// ---------------------------------------------------------------------------
// La prémisse de tout ce fichier, dans le navigateur : ce que l'outil dit illisible, Chromium l'exécute.
// ---------------------------------------------------------------------------

const cheminChromium = () => {
  const impose = process.env.GWAUDIT_CHROMIUM_PATH;
  if (impose) return fs.existsSync(impose) ? impose : null;
  const defaut = chromium.executablePath();
  return fs.existsSync(defaut) ? defaut : null;
};

test('Chromium exécute les deux pièges que l\'outil ne lit pas : l\'imbrication qu\'acorn refuse et la somme dont le parcours déborde', async (t) => {
  const executable = cheminChromium();
  if (!executable) { chromiumIndisponible(t, 'aucun Chromium lançable (voir GWAUDIT_CHROMIUM_PATH)'); return; }
  const pieges = [
    ['imbrication', imbriques(PROFOND), () => assert.equal(lire(imbriques(PROFOND)).ast, null, 'acorn ne lit pas ce que Chromium exécute')],
    ['somme de 4 000 termes', somme(LONGUE), () => assert.throws(() => walk.ancestor(lire(somme(LONGUE)).ast, {}), depassementDePile, 'le parcours ne porte pas ce que Chromium exécute')],
  ];
  const navigateur = await chromium.launch({ executablePath: executable, args: process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  try {
    const onglet = await (await navigateur.newContext()).newPage();
    const erreurs = [];
    onglet.on('pageerror', (e) => erreurs.push(String(e.message).slice(0, 200)));
    for (const [nom, code, cote] of pieges) {
      await onglet.goto('about:blank');
      await onglet.addScriptTag({ content: `${code}window.__execute = 'oui';` });
      assert.equal(await onglet.evaluate(() => window.__execute), 'oui', `${nom} : Chromium exécute le script jusqu'au bout (erreurs de page : ${erreurs.join(' | ') || 'aucune'})`);
      cote();
    }
  } finally {
    await navigateur.close();
  }
});
