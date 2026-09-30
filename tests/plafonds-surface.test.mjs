/**
 * Ce que l'outil n'a pas lu ne se passe jamais sous silence, et ne note jamais mieux que ce qu'il a lu : chaque plafond
 * de l'inventaire (fichiers, octets, dossiers exclus listés, résolutions d'adresse, arêtes de document, imbrication de
 * code littéral) et chaque fichier de code qu'il n'a pas lu (trop gros, plafond cumulé atteint, lecture refusée,
 * extension de binaire que la page charge comme du code) sont un constat critique et BLOQUANT qui dit lequel et
 * pourquoi, et qui empêche les axes que ce qui n'a pas été lu aurait nourris (`axesEmpeches`). Chaque essai a son mutant
 * dans `scripts/mutants-plafonds.mjs`.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { auditer, page } from './aide-surface.mjs';
import { noter } from '../src/moteur/notation.js';
import { analyserSurface, axesDUnFichierNonLu } from '../src/regles/c-surface.js';
import { PLAFONDS, raisonsDeTroncature } from '../src/contexte/inventaire.js';

const SANS_RIEN = 'var a = 1;\n';
/** Le plafond par fichier des essais : au-dessus de la taille d'une page minimale (elle se lit), au-dessous de ce qui s'y écrit de gros. */
const PLAFOND_FICHIER = 400;
/** Le plafond des essais qui alignent des dizaines de fichiers : au-dessus de la taille de la page qui les charge tous. */
const PLAFOND_GROS = 5000;
/** Une page qui charge chacun de ces scripts : un fichier non lu n'est dit bloquant que si une page l'atteint. */
const chargeTout = (noms) => page(noms.map((n) => `<script src="${n}"></script>`).join(''));
/** Un fichier JavaScript valide de la taille demandée (un commentaire de remplissage). */
const js = (octets) => `/*${'x'.repeat(octets - 5)}*/\n`;
const JSON_DE = (octets) => `{"a":"${'x'.repeat(octets - 9)}"}\n`;
const carte = (imports, plus = {}) => `<script type="importmap">${JSON.stringify({ imports, ...plus })}</script>`;
const modules = (noms) => Object.fromEntries(noms.map((n) => [n, SANS_RIEN]));

const PLAFOND = (a) => a.de('C-SURFACE-01');
const NON_LU = (a) => a.de('C-SURFACE-02');
const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''}`;
const TOUS = ['A', 'B', 'C', 'E', 'F'];
const SANS_A = ['B', 'C', 'E', 'F'];
const noterStatique = (constats) => noter(constats, new Set(['D']));

test('un dépôt lu en entier ne dit ni plafond atteint ni fichier non lu', async () => {
  const a = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': SANS_RIEN, 'donnees.json': JSON_DE(300) });
  assert.deepEqual(PLAFOND(a), []);
  assert.deepEqual(NON_LU(a), []);
  assert.deepEqual(a.ctx.nonLus, []);
  assert.equal(a.ctx.tronque, null);
  assert.deepEqual(a.ctx.plafonds, { octets: PLAFONDS.octets, octetsFichier: PLAFONDS.octetsFichier });
  const autres = await auditer({ 'a.js': SANS_RIEN }, { plafonds: { maxOctetsCumules: 1000, maxOctetsFichier: 500 } });
  assert.deepEqual(autres.ctx.plafonds, { octets: 1000, octetsFichier: 500 }, 'ceux qui s\'appliquent, non les valeurs par défaut');
});

// Plafond du nombre de fichiers ----------------------------------------------------------------------------------------

test('plus de fichiers que le plafond : critique bloquant, tous les axes empêchés, et pas un fichier de moins que le plafond exact', async () => {
  const fichiers = { 'a.js': SANS_RIEN, 'b.js': SANS_RIEN, 'c.js': SANS_RIEN };
  const trop = await auditer(fichiers, { plafonds: { maxFichiers: 2 } });
  assert.equal(trop.ctx.fichiers.length, 2);
  const [c] = PLAFOND(trop);
  assert.equal(PLAFOND(trop).length, 1);
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.axe, 'C');
  assert.equal(c.confiance, 'certain');
  assert.deepEqual(c.axesEmpeches, TOUS);
  assert.deepEqual(c.preuve, { plafond: 'fichiers' });
  assert.equal(c.titre, 'Plus de 2 fichiers dans le dépôt : l\'inventaire s\'est arrêté');
  assert.match(c.constat, /plus de 2 fichiers, le plafond de l'outil/);
  assert.match(c.constat, /ni inventoriés, ni lus, ni audités, par aucun axe/);
  assert.ok(c.impact && c.remediation);
  const juste = await auditer(fichiers, { plafonds: { maxFichiers: 3 } });
  assert.deepEqual(PLAFOND(juste), [], 'trois fichiers pour un plafond de trois : rien ne manque');
  assert.equal(juste.ctx.tronque, null);
});

// Plafond d'octets cumulés --------------------------------------------------------------------------------------------

test('plafond d\'octets cumulés : le fichier qui n\'a pas été lu est nommé (cause cumul), le plafond l\'est aussi, et un plafond exact ne coupe rien', async () => {
  const accueil = chargeTout(['x1.js', 'x2.js']);
  const base = accueil.length;
  const fichiers = { 'index.html': accueil, 'x1.js': js(60), 'x2.js': js(60) };
  const trop = await auditer(fichiers, { plafonds: { maxOctetsCumules: base + 100 } });
  const [plafond] = PLAFOND(trop);
  assert.equal(PLAFOND(trop).length, 1);
  assert.equal(plafond.preuve.plafond, 'octets');
  assert.equal(etat(plafond), 'critique bloquant');
  assert.deepEqual(plafond.axesEmpeches, TOUS);
  assert.match(plafond.titre, /^Plus de 0 Mio de contenu lu/, 'un plafond abaissé pour un essai se lit tel qu\'il est');
  const [nonLu] = NON_LU(trop);
  assert.equal(NON_LU(trop).length, 1, 'un seul des deux scripts n\'a pas pu être lu : la page, lue la première, et x1.js ont déjà pris leur place');
  assert.equal(nonLu.fichier, 'x2.js');
  assert.equal(nonLu.preuve.cause, 'cumul');
  assert.equal(nonLu.preuve.taille, 60);
  assert.equal(etat(nonLu), 'critique bloquant');
  assert.deepEqual(nonLu.axesEmpeches, TOUS);
  assert.match(nonLu.constat, new RegExp(`déjà lu ${base + 100} octets de fichiers texte, son plafond`));
  assert.match(nonLu.constat, /ce fichier \(60 octets\)/);
  assert.equal(trop.fichier(nonLu.fichier).contenuTronque, true);
  const juste = await auditer(fichiers, { plafonds: { maxOctetsCumules: base + 120 } });
  assert.deepEqual(PLAFOND(juste), [], 'la page et deux fois 60 octets pour un plafond qui les couvre exactement : tout est lu');
  assert.deepEqual(NON_LU(juste), []);
  const presque = await auditer(fichiers, { plafonds: { maxOctetsCumules: base + 119 } });
  assert.equal(NON_LU(presque).length, 1, 'un octet de moins : le second script n\'est pas lu');
});

// Plafond par fichier -------------------------------------------------------------------------------------------------

test('un fichier de code plus gros que le plafond par fichier n\'est pas lu : critique bloquant, nommé, avec sa taille et la raison ; au plafond exact il est lu', async () => {
  const fichiers = { 'index.html': chargeTout(['gros.js', 'exact.js', 'juste-plus.js']), 'gros.js': js(800), 'exact.js': js(PLAFOND_FICHIER), 'juste-plus.js': js(PLAFOND_FICHIER + 1) };
  const a = await auditer(fichiers, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  assert.deepEqual(NON_LU(a).map((c) => c.fichier).sort(), ['gros.js', 'juste-plus.js'], 'exact.js fait autant que le plafond : il est lu');
  assert.equal(a.fichier('exact.js').executee, true, 'le script lu, chargé par la page, est sur la surface');
  const c = NON_LU(a).find((x) => x.fichier === 'gros.js');
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.axe, 'C');
  assert.equal(c.confiance, 'certain');
  assert.equal(c.titre, 'Fichier de code non lu (800 octets)');
  assert.match(c.constat, /Ce fichier fait 800 octets ; l'outil ne lit pas un fichier de plus de 400 octets\./);
  assert.match(c.constat, /Aucune règle ne l'a examiné/);
  assert.deepEqual(c.preuve, { cause: 'taille', taille: 800, commeCode: true });
  assert.deepEqual(c.axesEmpeches, TOUS);
  assert.equal(a.fichier('exact.js').nonLu, undefined);
  assert.equal(a.fichier('exact.js').binaire, false);
  assert.equal(a.fichier('gros.js').binaire, true, 'l\'outil ne le lit pas : aucune règle ne le voit');
  assert.deepEqual(NON_LU(a).find((x) => x.fichier === 'juste-plus.js').preuve, { cause: 'taille', taille: PLAFOND_FICHIER + 1, commeCode: true });
  assert.deepEqual(PLAFOND(a), [], 'le plafond par fichier n\'est pas un plafond d\'inventaire : chaque fichier est nommé');
  assert.equal(a.ctx.tronque, null);
});

test('une page HTML trop grosse est un fichier de code non lu, comme un script : ce qu\'elle charge n\'est pas suivi', async () => {
  const a = await auditer({ 'index.html': `${page('<script src="app.js"></script>')}<!--${'x'.repeat(800)}-->`, 'app.js': SANS_RIEN }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1);
  assert.equal(c.fichier, 'index.html');
  assert.equal(c.preuve.cause, 'taille');
  assert.equal(c.preuve.commeCode, true, 'une page d\'entrée est chargée comme une page');
  assert.equal(etat(c), 'critique bloquant');
  assert.deepEqual(c.axesEmpeches, TOUS);
});

test('un fichier de données (ni code ni chargé comme du code) trop gros n\'est qu\'une information, qui ne bloque pas et n\'empêche aucun axe', async () => {
  const a = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': SANS_RIEN, 'donnees.json': JSON_DE(600), 'notes.md': 'x'.repeat(600), 'grande.png': 'x'.repeat(600) }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1, 'un seul constat pour les deux fichiers : une image n\'est pas un fichier de texte que l\'outil aurait dû lire');
  assert.equal(etat(c), 'info');
  assert.equal(c.titre, '2 fichier(s) non lus que le widget n\'exécute pas');
  assert.deepEqual(c.axesEmpeches, []);
  assert.match(c.constat, /donnees\.json \(600 octets\)/);
  assert.match(c.constat, /notes\.md \(600 octets\)/);
  assert.match(c.constat, /taille au-delà de 400 octets/);
  assert.deepEqual(c.preuve.emplacements.map((e) => e.fichier).sort(), ['donnees.json', 'notes.md']);
  assert.ok(c.preuve.emplacements.every((e) => e.cause === 'taille'));
  assert.deepEqual(noterStatique(a.constats).axesEmpeches, [], 'une donnée non lue n\'empêche aucune mesure');
});

test('un fichier de données que la page atteint sans le charger comme du code (préchargement en fetch, url() d\'une feuille de style) et que l\'outil n\'a pas lu est dit et nommé, sans bloquer', async () => {
  for (const [accueil, plus] of [
    [page('', '<link rel="preload" as="fetch" href="donnees.json" crossorigin>'), {}],
    [page('', '<link rel="stylesheet" href="s.css">'), { 's.css': 'body { background: url(donnees.json); }\n' }],
  ]) {
    const a = await auditer({ 'index.html': accueil, 'donnees.json': JSON_DE(600), ...plus }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
    const [releve] = a.ctx.nonLus;
    assert.equal(a.ctx.nonLus.length, 1);
    assert.deepEqual({ atteint: releve.atteint, commeCode: releve.commeCode, code: releve.code }, { atteint: true, commeCode: false, code: false }, 'la page l\'atteint, sans le charger comme du code');
    const [c] = NON_LU(a);
    assert.equal(NON_LU(a).length, 1, 'une donnée atteinte est dite : elle ne disparaît pas entre le groupe du code et celui des données');
    assert.equal(etat(c), 'info');
    assert.deepEqual(c.preuve.emplacements.map((e) => e.fichier), ['donnees.json']);
    assert.deepEqual(noterStatique(a.constats).axesEmpeches, []);
  }
});

test('un fichier de code trop gros que aucune page n\'atteint est une information, pas un point bloquant : le navigateur ne l\'exécute pas', async () => {
  const a = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': SANS_RIEN, 'orphelin.js': js(800), 'doc.html': `${page('')}<!--${'x'.repeat(800)}-->` }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1, 'un seul constat, qui les nomme tous les deux');
  assert.equal(etat(c), 'info');
  assert.deepEqual(c.axesEmpeches, []);
  assert.deepEqual(c.preuve.emplacements.map((e) => e.fichier).sort(), ['doc.html', 'orphelin.js']);
  assert.match(c.constat, /qu'aucune page ne charge comme du code/);
  assert.match(c.impact, /ne l'exécutent pas/);
  assert.deepEqual(noterStatique(a.constats).axesEmpeches, [], 'un fichier que rien n\'exécute n\'empêche aucune mesure');
  const chargé = await auditer({ 'index.html': page('<script src="orphelin.js"></script>'), 'orphelin.js': js(800) }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  assert.equal(etat(NON_LU(chargé)[0]), 'critique bloquant', 'le même fichier, dès qu\'une page le charge, est du code que personne n\'a lu');
});

test('un module que import() vise par un début d\'adresse fixe (`./locales/` + langue) et que l\'outil n\'a pas lu est du code non lu, sans qu\'aucune page le nomme : tout le dossier est atteignable', async () => {
  const a = await auditer({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': "import('./locales/' + navigator.language);\n",
    'locales/fr.js': js(800),
    'locales/notes.txt': 'x'.repeat(800),
    'ailleurs/autre.js': js(800),
  }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const dits = NON_LU(a).filter((c) => c.fichier);
  assert.deepEqual(dits.map((c) => c.fichier), ['locales/fr.js'], 'le module du dossier visé est dit, pas celui d\'un autre dossier');
  assert.equal(etat(dits[0]), 'critique bloquant');
  assert.deepEqual(dits[0].preuve, { cause: 'taille', taille: 800, commeCode: true });
  assert.deepEqual(dits[0].axesEmpeches, TOUS);
  const [hors] = NON_LU(a).filter((c) => !c.fichier);
  assert.equal(etat(hors), 'info');
  assert.deepEqual(hors.preuve.emplacements.map((e) => e.fichier).sort(), ['ailleurs/autre.js', 'locales/notes.txt'], 'une donnée du dossier, et un module qu\'aucune adresse ne vise, restent des informations');
});

test('limite connue : un import() à adresse entièrement calculée ne désigne aucun dossier que l\'inventaire sache nommer, donc un fichier de code non lu que rien ne nomme reste une information (à compléter à l\'étape des chargeurs)', async () => {
  const a = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': 'import(window.location.hash.slice(1));\n', 'orphelin.js': js(800) }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1);
  assert.equal(etat(c), 'info', 'faute de savoir où cet import() mène, l\'outil ne peut pas dire que ce fichier est atteignable : l\'étape des chargeurs le complète');
  assert.deepEqual(c.preuve.emplacements.map((e) => e.fichier), ['orphelin.js']);
  assert.ok(a.constats.some((x) => x.axe === 'C' && /import\(\)/.test(`${x.titre} ${x.constat}`)), 'l\'import() calculé est, lui, dit par une règle de l\'axe C');
});

test('un fichier de code que la page atteint sans l\'exécuter comme un script (une feuille de style) et que l\'outil n\'a pas lu est un fichier de code non lu', async () => {
  const css = `/*${'x'.repeat(800)}*/\n`;
  const a = await auditer({ 'index.html': page('', '<link rel="stylesheet" href="gros.css">'), 'gros.css': css }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1);
  assert.equal(c.fichier, 'gros.css');
  assert.equal(etat(c), 'critique bloquant');
  assert.deepEqual(c.preuve, { cause: 'taille', taille: css.length, commeCode: false }, 'une page l\'atteint par un lien, non comme du code chargé');
  assert.deepEqual(c.axesEmpeches, TOUS);
});

test('un fichier de données que la page charge comme du code (balise script) et que l\'outil n\'a pas lu est un fichier de code non lu', async () => {
  const a = await auditer({ 'index.html': page('<script src="donnees.json"></script>'), 'donnees.json': JSON_DE(600) }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1, 'une seule fois, même atteint par un chargement de code et trop gros');
  assert.equal(etat(c), 'critique bloquant');
  assert.deepEqual(c.preuve, { cause: 'taille', taille: 600, commeCode: true });
});

test('au-delà de cinquante fichiers de code non lus, les plus gros sont dits un à un et les autres regroupés avec leur liste', async () => {
  const noms = Array.from({ length: 52 }, (_, i) => `m${String(i).padStart(2, '0')}.js`);
  const fichiers = { 'index.html': chargeTout(noms), ...Object.fromEntries(noms.map((n, i) => [n, js(PLAFOND_GROS + 100 + i)])) };
  const a = await auditer(fichiers, { plafonds: { maxOctetsFichier: PLAFOND_GROS } });
  const dits = NON_LU(a).filter((c) => c.fichier);
  const reste = NON_LU(a).filter((c) => !c.fichier);
  assert.equal(dits.length, 50);
  assert.equal(reste.length, 1);
  assert.ok(!dits.some((c) => ['m00.js', 'm01.js'].includes(c.fichier)), 'les deux plus petits ne sont pas dits un à un');
  assert.equal(reste[0].titre, '2 autres fichiers de code non lus');
  assert.match(reste[0].constat, /^52 fichiers de code n'ont pas été lus ; les 50 plus gros sont dits un à un/);
  assert.deepEqual(reste[0].preuve.emplacements, [{ fichier: 'm01.js', cause: 'taille', taille: PLAFOND_GROS + 101 }, { fichier: 'm00.js', cause: 'taille', taille: PLAFOND_GROS + 100 }]);
  assert.equal(etat(reste[0]), 'critique bloquant');
  assert.deepEqual(reste[0].axesEmpeches, TOUS);
});

// Les axes qu'un fichier non lu empêche ---------------------------------------------------------------------------------

test('un fichier de bibliothèque tierce non lu empêche B, C, E et F, pas A (qui ne juge pas ce code) ; un fichier du contributeur les empêche tous', async () => {
  const a = await auditer({
    'index.html': page('<script src="libs/gros.js"></script><script src="app.min.js"></script><script src="mien.js"></script>'),
    'libs/gros.js': js(800), 'app.min.js': js(800), 'mien.js': js(800),
  }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const axes = (chemin) => NON_LU(a).find((c) => c.fichier === chemin).axesEmpeches;
  assert.deepEqual(axes('libs/gros.js'), SANS_A);
  assert.deepEqual(axes('app.min.js'), SANS_A);
  assert.deepEqual(axes('mien.js'), TOUS);
  const n = noterStatique(a.constats);
  assert.deepEqual(n.axesEmpeches, TOUS, 'le fichier du contributeur suffit à empêcher A');
  const seulTiers = await auditer({ 'index.html': page('<script src="libs/gros.js"></script>'), 'libs/gros.js': js(800) }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  assert.deepEqual(noterStatique(seulTiers.constats).axesEmpeches, SANS_A, 'A garde sa note : il ne juge pas une bibliothèque tierce ; B, C, E et F lisent tout le code exécuté');
});

test('noter : un fichier de code non lu met les axes empêchés à 0, le verdict devient NON CONFORME et dit pourquoi', async () => {
  const lu = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': SANS_RIEN }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const cache = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': js(800) }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const nLu = noterStatique(lu.constats);
  const nCache = noterStatique(cache.constats);
  assert.deepEqual(nLu.axesEmpeches, []);
  assert.deepEqual(nCache.axesEmpeches, TOUS);
  assert.equal(nCache.verdict, 'NON CONFORME');
  for (const axe of TOUS) {
    assert.ok(nLu.parAxe[axe].score > 0, axe);
    assert.equal(nCache.parAxe[axe].score, 0, axe);
    assert.equal(nCache.parAxe[axe].empeche, true, axe);
    assert.equal(nCache.parAxe[axe].causes[0].regle, 'C-SURFACE-02', axe);
    assert.equal(nCache.parAxe[axe].causes[0].fichier, 'app.js', axe);
  }
  assert.ok(nCache.global < nLu.global, 'un widget qui empêche la lecture de son code ne note pas mieux que s\'il la laissait faire');
  assert.equal(nCache.global, 0, 'D n\'est pas lancé et les cinq autres axes sont empêchés');
  assert.ok(nCache.bloquants.some((c) => c.regle === 'C-SURFACE-02'));
  assert.match(nCache.motif, /Mesure empêchée par le widget/);
});

// L'extension d'un fichier chargé comme du code -----------------------------------------------------------------------------

test('un fichier d\'extension de binaire que la page charge comme du code (script, import, worker, carte d\'import) est un fichier de code non lu', async () => {
  const a = await auditer({
    'index.html': page(`${carte({ m: './carte.webp' })}<script src="balise.png"></script><script type="module">import './module.gif';\nnew Worker('worker.wasm');</script>`),
    'balise.png': 'x', 'module.gif': 'x', 'worker.wasm': 'x', 'carte.webp': 'x', 'libre.png': 'x',
  });
  assert.deepEqual(NON_LU(a).map((c) => c.fichier).sort(), ['balise.png', 'carte.webp', 'module.gif', 'worker.wasm']);
  for (const c of NON_LU(a)) {
    assert.equal(etat(c), 'critique bloquant', c.fichier);
    assert.equal(c.preuve.cause, 'extension', c.fichier);
    assert.equal(c.preuve.commeCode, true, c.fichier);
    assert.deepEqual(c.axesEmpeches, TOUS, c.fichier);
    assert.match(c.constat, /extension de fichier non textuel/, c.fichier);
    assert.match(c.constat, new RegExp(`\`\\.${c.fichier.split('.').pop()}\``), c.fichier);
  }
});

test('un binaire d\'un dossier exclu que la page charge comme du code est dit tel : A n\'en juge pas le code, B, C, E et F le lisent', async () => {
  const a = await auditer({ 'index.html': page('<script src="dist/app.png"></script>'), 'dist/app.png': 'x' });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1);
  assert.equal(c.fichier, 'dist/app.png');
  assert.deepEqual(c.preuve, { cause: 'extension', taille: 1, commeCode: true });
  assert.deepEqual(c.axesEmpeches, SANS_A);
  assert.deepEqual(a.ctx.nonLus.map((n) => [n.chemin, n.dossierExclu]), [['dist/app.png', true]]);
});

test('un binaire qu\'un lien, une image, une police ou une feuille de style désigne n\'est pas du code chargé : aucun constat', async () => {
  const a = await auditer({
    'index.html': page(`<link rel="icon" href="icone.png"><link rel="preload" as="font" href="police.woff2" crossorigin><img src="logo.png"><style>@font-face{font-family:f;src:url(police.ttf)}body{background:url(fond.jpg)}</style><link rel="stylesheet" href="style.css">`),
    'icone.png': 'x', 'police.woff2': 'x', 'logo.png': 'x', 'police.ttf': 'x', 'fond.jpg': 'x', 'style.css': 'a{background:url(autre.webp)}',
    'autre.webp': 'x',
  });
  assert.deepEqual(NON_LU(a), []);
  assert.deepEqual(a.ctx.nonLus, []);
});

test('un fichier d\'extension de binaire atteint par un import, un worker, ou un worker de worker, depuis un fichier de code est dit non lu', async () => {
  const a = await auditer({
    'index.html': page('<script type="module" src="app.js"></script>'),
    'app.js': "import './dessin.png';\nnew Worker('w.js');\nnew Worker('w2.png');\n",
    'dessin.png': 'x', 'w2.png': 'x',
    'w.js': "importScripts('suite.ico');\n", 'suite.ico': 'x',
  });
  assert.deepEqual(NON_LU(a).map((c) => c.fichier).sort(), ['dessin.png', 'suite.ico', 'w2.png']);
});

test('un fichier d\'un dossier exclu ouvert parce qu\'une page le charge compte pour le plafond de fichiers, et le dit', async () => {
  const fichiers = { 'index.html': page('<script src="dist/x.js"></script><script src="dist/y.js"></script>'), 'dist/x.js': SANS_RIEN, 'dist/y.js': SANS_RIEN };
  const court = await auditer(fichiers, { plafonds: { maxFichiers: 2 } });
  assert.deepEqual(PLAFOND(court).map((c) => c.preuve.plafond), ['fichiers']);
  assert.deepEqual(court.ctx.fichiers.map((f) => f.chemin), ['index.html', 'dist/x.js'], 'dist/y.js serait le troisième');
  const juste = await auditer(fichiers, { plafonds: { maxFichiers: 3 } });
  assert.deepEqual(PLAFOND(juste), []);
  assert.equal(juste.ctx.fichiers.length, 3);
});

test('une adresse qui ne mène à aucun fichier, ou à un dossier, ne lève pas le plafond de fichiers : il ne se dit atteint que pour un fichier qui existe et qu\'il empêche d\'ouvrir', async () => {
  // `dist/x.js` est lu ; ses candidats (`dist/x.js.js`, `dist/x.js.mjs`, `dist/x.js/index.js`) n'existent pas et `dist/d` est un dossier :
  // aucun n'est un fichier que le plafond empêche d'ouvrir, quand l'inventaire est exactement au plafond.
  const fichiers = { 'index.html': page('<script src="dist/x.js"></script><script src="dist/d"></script>'), 'dist/x.js': SANS_RIEN, 'dist/d/x.txt': 'x' };
  const juste = await auditer(fichiers, { plafonds: { maxFichiers: 2 } });
  assert.deepEqual(PLAFOND(juste), []);
  assert.equal(juste.ctx.tronque, null);
  assert.deepEqual(juste.ctx.fichiers.map((f) => f.chemin), ['index.html', 'dist/x.js']);
});

test('un module d\'un dossier que l\'import map désigne par préfixe, trop gros pour être lu, est appelé comme du code', async () => {
  const html = page(`${carte({ 'm/': './node_modules/m/' })}<script type="module">import 'm/a.js';</script>`);
  const a = await auditer({ 'index.html': html, 'node_modules/m/a.js': SANS_RIEN, 'node_modules/m/gros.js': js(800) }, { plafonds: { maxOctetsFichier: 500 } });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1);
  assert.equal(c.fichier, 'node_modules/m/gros.js');
  assert.deepEqual(c.preuve, { cause: 'taille', taille: 800, commeCode: true });
  assert.deepEqual(c.axesEmpeches, SANS_A, 'un dossier exclu : A ne juge pas ce code');
});

test('exactement cinquante fichiers de code non lus se disent un à un ; le cinquante et unième est annoncé seul, au singulier', async () => {
  const noms = Array.from({ length: 50 }, (_, i) => `m${String(i).padStart(2, '0')}.js`);
  const cinquante = Object.fromEntries(noms.map((n, i) => [n, js(PLAFOND_GROS + 100 + i)]));
  const a = await auditer({ 'index.html': chargeTout(noms), ...cinquante }, { plafonds: { maxOctetsFichier: PLAFOND_GROS } });
  assert.equal(NON_LU(a).length, 50);
  assert.ok(NON_LU(a).every((c) => c.fichier), 'aucun constat groupé : il n\'y a rien à grouper');
  const b = await auditer({ 'index.html': chargeTout([...noms, 'petit.js']), ...cinquante, 'petit.js': js(PLAFOND_GROS + 1) }, { plafonds: { maxOctetsFichier: PLAFOND_GROS } });
  assert.equal(NON_LU(b).length, 51);
  const reste = NON_LU(b).filter((c) => !c.fichier);
  assert.equal(reste.length, 1);
  assert.equal(reste[0].titre, '1 autre fichier de code non lu');
  assert.deepEqual(reste[0].preuve.emplacements.map((e) => e.fichier), ['petit.js']);
});

// Lecture refusée -----------------------------------------------------------------------------------------------------

test('un fichier que le système de fichiers refuse de lire est dit non lu (cause lecture), sans arrêter l\'audit', async (t) => {
  const lire = fs.readFileSync;
  t.after(() => mock.restoreAll());
  mock.method(fs, 'readFileSync', function readFileSync(chemin, ...reste) {
    if (String(chemin).endsWith('interdit.js')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return lire.call(this, chemin, ...reste);
  });
  const a = await auditer({ 'index.html': page('<script src="interdit.js"></script><script src="app.js"></script>'), 'interdit.js': SANS_RIEN, 'app.js': SANS_RIEN });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1);
  assert.equal(c.fichier, 'interdit.js');
  assert.equal(c.preuve.cause, 'lecture');
  assert.equal(etat(c), 'critique bloquant');
  assert.deepEqual(c.axesEmpeches, TOUS);
  assert.match(c.constat, /refusé la lecture de ce fichier/);
  assert.equal(a.fichier('app.js').contenu, SANS_RIEN, 'les autres fichiers sont lus');
});

test('un fichier dont la taille ne se lit même pas est dit non lu (cause lecture), sans titre de taille ; un binaire qu\'aucune règle ne lit n\'a rien à dire', async (t) => {
  const stat = fs.statSync;
  t.after(() => mock.restoreAll());
  mock.method(fs, 'statSync', function statSync(chemin, ...reste) {
    if (/(invisible\.js|invisible\.png)$/.test(String(chemin))) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    return stat.call(this, chemin, ...reste);
  });
  const a = await auditer({ 'index.html': page('<script src="invisible.js"></script>'), 'invisible.js': SANS_RIEN, 'invisible.png': 'x' });
  const [c] = NON_LU(a);
  assert.equal(NON_LU(a).length, 1);
  assert.equal(c.fichier, 'invisible.js');
  assert.equal(c.titre, 'Fichier de code non lu');
  assert.deepEqual(c.preuve, { cause: 'lecture', taille: 0, commeCode: true });
  assert.equal(a.fichier('invisible.png'), undefined);
});

// Les autres plafonds d'inventaire ----------------------------------------------------------------------------------------

test('trop d\'entrées lues dans les dossiers exclus : critique bloquant, tous les axes empêchés ; un plafond exact ne le dit pas', async () => {
  const dossier = modules(Array.from({ length: 12 }, (_, i) => `node_modules/m${i}.js`));
  const html = page(`${carte({ 'm/': './node_modules/' })}<script type="module">import 'm/m0.js';</script>`);
  const court = await auditer({ 'index.html': html, ...dossier }, { plafonds: { maxEntreesListees: 11 } });
  const [c] = PLAFOND(court);
  assert.equal(PLAFOND(court).length, 1);
  assert.equal(c.preuve.plafond, 'listage');
  assert.equal(etat(c), 'critique bloquant');
  assert.deepEqual(c.axesEmpeches, TOUS);
  assert.equal(c.titre, 'Plus de 11 entrées lues dans les dossiers exclus : des modules n\'ont pas été cherchés');
  assert.match(c.constat, /s'est arrêté à 11 entrées/);
  const juste = await auditer({ 'index.html': html, ...dossier }, { plafonds: { maxEntreesListees: 12 } });
  assert.deepEqual(PLAFOND(juste), []);
});

test('trop de résolutions d\'adresses de worker : critique bloquant, tous les axes empêchés ; un plafond exact ne le dit pas', async () => {
  const dossiers = ['a', 'b', 'c'];
  const fichiers = {
    ...Object.fromEntries(dossiers.map((d) => [`${d}/index.html`, page('<script src="../js/app.js"></script>')])),
    'js/app.js': "new Worker('w1.js');\nnew Worker('w2.js');\nnew Worker('w3.js');\n",
    ...modules(dossiers.flatMap((d) => ['w1', 'w2', 'w3'].map((w) => `${d}/${w}.js`))),
  };
  const court = await auditer(fichiers, { plafonds: { maxResolutions: 8 } });
  const [c] = PLAFOND(court);
  assert.equal(PLAFOND(court).length, 1);
  assert.equal(c.preuve.plafond, 'surface');
  assert.equal(etat(c), 'critique bloquant');
  assert.deepEqual(c.axesEmpeches, TOUS);
  assert.equal(c.titre, 'Plus de 8 résolutions d\'adresses de worker : la surface exécutée n\'est pas complète');
  assert.match(c.constat, /8 résolutions d'adresses de worker/);
  const juste = await auditer(fichiers, { plafonds: { maxResolutions: 9 } });
  assert.deepEqual(PLAFOND(juste), []);
});

test('trop d\'arêtes de document : critique bloquant, dit après que l\'axe E a demandé les graphes ; un plafond suffisant ne le dit pas', async () => {
  const U = 'https://esm.sh/foo@1.2.3';
  const fichiers = {
    'index.html': page(`${carte({}, { integrity: { [U]: `sha384-${'A'.repeat(64)}` } })}<script type="module" src="app.js"></script>`),
    'app.js': 'import "./c.js";\n',
    'c.js': `import "${U}";\n`,
  };
  const epuise = await auditer(fichiers, { plafonds: { maxPasDocuments: 4 } });
  const [c] = PLAFOND(epuise);
  assert.equal(PLAFOND(epuise).length, 1);
  assert.equal(c.preuve.plafond, 'documents');
  assert.equal(etat(c), 'critique bloquant');
  assert.deepEqual(c.axesEmpeches, TOUS);
  assert.equal(c.titre, 'Plus de 4 pas d\'analyse de document : l\'ordre de chargement n\'est pas établi pour toutes les pages');
  assert.equal(epuise.ctx.tronque.documents, true);
  const juste = await auditer(fichiers, { plafonds: { maxPasDocuments: 6 } });
  assert.deepEqual(PLAFOND(juste), []);
  assert.equal(juste.ctx.tronque, null);
});

const TRONQUE = { fichiers: false, octets: false, listage: false, surface: false, documents: false, maxFichiers: 20_000, maxOctets: 200 * 1024 * 1024, maxEntreesListees: 100_000, maxResolutions: 2_000_000, maxPasDocuments: 2_000_000 };
const PLAFONDS_DE_L_OUTIL = { octets: PLAFONDS.octets, octetsFichier: PLAFONDS.octetsFichier };
const sansFichier = (tronque) => analyserSurface({ tronque, nonLus: [], plafonds: PLAFONDS_DE_L_OUTIL });

test('chaque plafond atteint donne son constat, et lui seul ; tous ensemble, dans l\'ordre où l\'outil les dit', () => {
  for (const drapeau of ['fichiers', 'octets', 'listage', 'surface', 'documents']) {
    const cs = sansFichier({ ...TRONQUE, [drapeau]: true });
    assert.deepEqual(cs.map((c) => c.preuve.plafond), [drapeau], drapeau);
    assert.equal(etat(cs[0]), 'critique bloquant', drapeau);
    assert.deepEqual(cs[0].axesEmpeches, TOUS, drapeau);
    assert.equal(cs[0].regle, 'C-SURFACE-01', drapeau);
  }
  assert.deepEqual(sansFichier(TRONQUE), []);
  assert.deepEqual(analyserSurface({ tronque: null, nonLus: [], plafonds: PLAFONDS_DE_L_OUTIL }), []);
  assert.deepEqual(analyserSurface({ nonLus: [] }), [], 'un contexte sans plafond ni fichier non lu ne dit rien');
  const tous = sansFichier({ ...TRONQUE, fichiers: true, octets: true, listage: true, surface: true, documents: true });
  assert.deepEqual(tous.map((c) => c.preuve.plafond), ['fichiers', 'octets', 'listage', 'surface', 'documents']);
  assert.equal(new Set(tous.map((c) => c.uid)).size, 5, 'cinq constats distincts');
});

test('chaque plafond dit sa propre valeur, en clair : fichiers, Mio lus, entrées listées, résolutions, arêtes de document', () => {
  const titre = (drapeau, valeurs = {}) => sansFichier({ ...TRONQUE, [drapeau]: true, ...valeurs })[0].titre;
  const DISTINCTES = { maxFichiers: 11, maxOctets: 22 * 1024 * 1024, maxEntreesListees: 33, maxResolutions: 44, maxPasDocuments: 55 };
  assert.match(titre('fichiers', DISTINCTES), /^Plus de 11 fichiers/);
  assert.match(titre('octets', DISTINCTES), /^Plus de 22 Mio de contenu lu/);
  assert.match(titre('listage', DISTINCTES), /^Plus de 33 entrées lues/);
  assert.match(titre('surface', DISTINCTES), /^Plus de 44 résolutions/);
  assert.match(titre('documents', DISTINCTES), /^Plus de 55 pas d'analyse/);
  assert.equal(titre('fichiers'), 'Plus de 20 000 fichiers dans le dépôt : l\'inventaire s\'est arrêté');
  assert.equal(titre('octets'), 'Plus de 200 Mio de contenu lu : l\'inventaire s\'est arrêté');
  assert.equal(titre('listage'), 'Plus de 100 000 entrées lues dans les dossiers exclus : des modules n\'ont pas été cherchés');
  assert.equal(titre('surface'), 'Plus de 2 000 000 résolutions d\'adresses de worker : la surface exécutée n\'est pas complète');
  assert.equal(titre('documents'), 'Plus de 2 000 000 pas d\'analyse de document : l\'ordre de chargement n\'est pas établi pour toutes les pages');
  const constat = (drapeau, valeurs = {}) => sansFichier({ ...TRONQUE, [drapeau]: true, ...valeurs })[0].constat;
  assert.match(constat('fichiers', { maxFichiers: 1234 }), /plus de 1 234 fichiers, le plafond/);
  assert.match(constat('octets', { maxOctets: 7 * 1024 * 1024 }), /a lu 7 Mio de fichiers texte, son plafond/);
  assert.match(constat('listage', { maxEntreesListees: 4321 }), /s'est arrêté à 4 321 entrées/);
  assert.match(constat('surface', { maxResolutions: 5678 }), /a fait 5 678 résolutions d'adresses de worker/);
  assert.match(constat('documents', { maxPasDocuments: 9876 }), /a parcouru 9 876 arêtes de documents/);
});

test('troncature : la raison du budget d\'arêtes de document est dite avec son plafond, pour le rapport Markdown et la ligne de commande', () => {
  assert.deepEqual(raisonsDeTroncature({ ...TRONQUE, documents: true, maxPasDocuments: 7, maxResolutions: 8 }), ['plus de 7 pas d\'analyse de document : l\'ordre de chargement n\'est pas établi pour toutes les pages']);
  assert.deepEqual(raisonsDeTroncature(TRONQUE), []);
  assert.deepEqual(raisonsDeTroncature({ ...TRONQUE, surface: true, documents: true }).length, 2);
});

test('une taille se dit à l\'unité qui la rend lisible : octets, Kio, Mio', () => {
  const titre = (taille) => analyserSurface({ tronque: null, nonLus: [{ chemin: 'a.js', taille, cause: 'taille', code: true, commeCode: false, atteint: true, dossierExclu: false }], plafonds: PLAFONDS_DE_L_OUTIL })[0].titre;
  assert.equal(titre(500), 'Fichier de code non lu (500 octets)');
  assert.equal(titre(1023), 'Fichier de code non lu (1023 octets)');
  assert.equal(titre(1024), 'Fichier de code non lu (1,0 Kio)');
  assert.equal(titre(2560), 'Fichier de code non lu (2,5 Kio)');
  assert.equal(titre(1024 * 1024 - 1), 'Fichier de code non lu (1024,0 Kio)');
  assert.equal(titre(1024 * 1024), 'Fichier de code non lu (1,0 Mio)');
  assert.equal(titre(6_710_886), 'Fichier de code non lu (6,4 Mio)', 'le main.js de chart : 6,4 Mio');
});

test('les fichiers non lus se disent du plus gros au plus petit, à taille égale par nom', () => {
  const nonLu = (chemin, taille) => ({ chemin, taille, cause: 'taille', code: true, commeCode: false, atteint: true, dossierExclu: false });
  const cs = analyserSurface({ tronque: null, nonLus: [nonLu('b.js', 500), nonLu('c.js', 900), nonLu('a.js', 500), nonLu('d.js', 100)], plafonds: PLAFONDS_DE_L_OUTIL });
  assert.deepEqual(cs.map((c) => c.fichier), ['c.js', 'a.js', 'b.js', 'd.js']);
});

test('les fichiers de données non lus : les cinq premiers nommés, le reste annoncé par des points de suspension, tous dans la preuve', async () => {
  const fichiers = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`d${i}.json`, JSON_DE(600 + i)]));
  const a = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': SANS_RIEN, ...fichiers }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const [c] = NON_LU(a);
  assert.equal(c.titre, '7 fichier(s) non lus que le widget n\'exécute pas');
  assert.match(c.constat, /d6\.json \(606 octets\), d5\.json \(605 octets\), d4\.json \(604 octets\), d3\.json \(603 octets\), d2\.json \(602 octets\)…/);
  assert.ok(!/d1\.json|d0\.json/.test(c.constat));
  assert.equal(c.preuve.emplacements.length, 7);
  const cinq = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': SANS_RIEN, ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`d${i}.json`, JSON_DE(600 + i)])) }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  assert.ok(!/…/.test(NON_LU(cinq)[0].constat), 'cinq fichiers : rien à abréger');
});

test('un fichier de code d\'un dossier exclu (dist/) ou une bibliothèque non lue n\'empêche pas A ; axesDUnFichierNonLu le dit à partir du chemin seul', async () => {
  const a = await auditer({ 'index.html': page('<script src="dist/app.js"></script>'), 'dist/app.js': js(800) }, { plafonds: { maxOctetsFichier: PLAFOND_FICHIER } });
  const [c] = NON_LU(a);
  assert.equal(c.fichier, 'dist/app.js');
  assert.deepEqual(c.axesEmpeches, SANS_A, 'un dossier de sortie de construction : A ne juge pas ce code');
  const seul = (chemin, dossierExclu = false) => axesDUnFichierNonLu({ chemin, dossierExclu });
  assert.deepEqual(seul('dist/app.js', true), SANS_A);
  assert.deepEqual(seul('src/app.js'), TOUS);
  assert.deepEqual(seul('node_modules/x/index.js'), SANS_A);
  assert.deepEqual(seul('lib/x.js'), SANS_A);
  assert.deepEqual(seul('x.min.js'), SANS_A);
  assert.deepEqual(seul('mon.js'), TOUS);
});

test('au-delà de cinquante fichiers, le constat groupé n\'empêche A que si l\'un des fichiers regroupés est du contributeur', async () => {
  const nomsTiers = Array.from({ length: 52 }, (_, i) => `libs/m${String(i).padStart(2, '0')}.js`);
  const tiers = Object.fromEntries(nomsTiers.map((n, i) => [n, js(PLAFOND_GROS + 100 + i)]));
  const seulsTiers = await auditer({ 'index.html': chargeTout(nomsTiers), ...tiers }, { plafonds: { maxOctetsFichier: PLAFOND_GROS } });
  const reste = NON_LU(seulsTiers).filter((c) => !c.fichier);
  assert.equal(reste.length, 1);
  assert.deepEqual(reste[0].axesEmpeches, SANS_A, 'les cinquante-deux fichiers sont de bibliothèques tierces');
  const mixte = await auditer({ 'index.html': chargeTout([...nomsTiers, 'mien.js']), ...tiers, 'mien.js': js(PLAFOND_GROS + 1) }, { plafonds: { maxOctetsFichier: PLAFOND_GROS } });
  const resteMixte = NON_LU(mixte).filter((c) => !c.fichier);
  assert.deepEqual(resteMixte[0].axesEmpeches, TOUS, 'le fichier du contributeur, le plus petit, est dans le groupe : A est empêché');
  assert.equal(resteMixte[0].titre, '3 autres fichiers de code non lus');
});

// Imbrication de code littéral ---------------------------------------------------------------------------------------------

/** `niveaux` eval() emboîtés : chaque chaîne contient l'eval() du niveau suivant, le dernier ne contient qu'une affectation. */
const imbriques = (niveaux) => {
  let code = 'var z = 1;';
  for (let i = 0; i < niveaux; i++) code = `eval(${JSON.stringify(code)});`;
  return `${code}\n`;
};

test('code littéral emboîté au-delà de la profondeur lue : critique bloquant, B, C, E et F empêchés ; juste sous la profondeur, rien', async () => {
  const profond = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': imbriques(6) });
  const trop = profond.de('C-XSS-03').filter((c) => /trop profonde/.test(c.titre));
  assert.equal(trop.length, 1, profond.de('C-XSS-03').map((c) => c.titre).join(' | '));
  assert.equal(etat(trop[0]), 'critique bloquant');
  assert.equal(trop[0].confiance, 'certain');
  assert.deepEqual(trop[0].axesEmpeches, ['B', 'C', 'E', 'F']);
  assert.match(trop[0].constat, /au-delà de 5 niveaux : l'outil n'a pas lu ce qui se trouve au-delà/);
  const n = noterStatique(profond.constats);
  assert.deepEqual(n.axesEmpeches, ['B', 'C', 'E', 'F']);
  const limite = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': imbriques(5) });
  assert.deepEqual(limite.de('C-XSS-03').filter((c) => /trop profonde/.test(c.titre)), [], 'cinq niveaux se lisent jusqu\'au bout');
  assert.deepEqual(noterStatique(limite.constats).axesEmpeches, []);
});
