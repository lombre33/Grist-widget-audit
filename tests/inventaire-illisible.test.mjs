/**
 * L'inventaire des fichiers (`construireContexte`) lit tout le code de la surface pour savoir ce que la page charge. Ce qu'il n'a pas pu
 * lire ou parcourir ne se passe pas sous silence parce qu'il lit par expressions régulières à la place : C-SURFACE-03 le dit comme il dit
 * ce que les règles n'ont pas lu, une seule fois par unité (un fichier, ou un script de la page), même si aucune règle ne refait la
 * lecture ou le parcours qui a échoué ; une erreur de l'outil dans ce parcours ne fait pas sortir l'audit en code 3 ; et la lecture
 * qui a échoué n'est faite qu'une fois, pour l'inventaire, les graphes de document et les règles. Avant cela, l'inventaire rattrapait
 * le dépassement de pile en silence, relançait toute erreur autre (l'audit finissait en code 3) et lisait trois fois le fichier
 * qu'il n'avait pas pu lire (la fermeture de la surface, le graphe de document, les règles : six lectures d'acorn, deux à présent).
 * Chaque essai a son mutant dans `scripts/mutants-inventaire-illisible.mjs`.
 *
 * Le parcours qui déborde se provoque par une chaîne de membres `a.a.a…` : acorn la lit à plat (sans limite), le parcours récursif de
 * son arbre déborde vers 1 150 niveaux quelle que soit la machine (`scripts/mesurer-profondeur.mjs`), donc toujours à 5 000.
 */
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as walk from 'acorn-walk';
import { avecWidget, auditer, page, EXFIL } from './aide-surface.mjs';
import { construireContexte, calculerSurface, referencesDeCode } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { analyserIllisibles } from '../src/regles/c-illisibles.js';
import { noter } from '../src/moteur/notation.js';
import { lire, lireUnite, noterParcoursEchoue, pourChaqueUniteJs, depassementDePile } from '../src/moteur/analyse-js.js';

const SANS_RIEN = 'var a = 1;\n';
const TYPESCRIPT = 'let x: number = 1;\n';
const TOUS = ['A', 'B', 'C', 'E', 'F'];
const PROFONDEUR = 5000;
/** Une chaîne de membres que la lecture lit et que le parcours de l'arbre ne porte pas, suivie d'un import qu'elle ne doit pas faire perdre à la surface. */
const CHAINE = `a${'.a'.repeat(PROFONDEUR)};\nimport './suite.js';\n`;
const charge = (...noms) => page(noms.map((n) => `<script src="${n}"></script>`).join(''));
const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''}`;
const DEPASSEMENT = () => new RangeError('Maximum call stack size exceeded');
const DEFAUT = () => new TypeError('Cannot read properties of undefined (reading \'type\')');

/** Ce que l'inventaire dit tout seul : le contexte d'un widget, et C-SURFACE-03 sans qu'aucune règle n'ait tourné. */
async function inventaireSeul(fichiers) {
  return avecWidget(fichiers, {}, async (racine) => {
    const ctx = construireContexte(racine);
    return { ctx, constats: analyserIllisibles(ctx), surface: ctx.fichiers.filter((f) => f.executee).map((f) => f.chemin).sort() };
  });
}

test('prémisse : la chaîne de membres se lit et son parcours déborde la pile', () => {
  const { ast, erreur } = lire(CHAINE);
  assert.equal(erreur, null, 'acorn lit la chaîne à plat');
  assert.throws(() => walk.full(ast, () => {}), depassementDePile, 'le parcours récursif de l\'arbre la déborde');
});

// Ce que l'inventaire dit tout seul --------------------------------------------------------------------------------------------

test('une lecture que l\'inventaire n\'a pas pu faire est dite sans qu\'aucune règle ne tourne : fichier, script de la page, et fichier que seule une carte d\'import désigne', async () => {
  const fichier = await inventaireSeul({ 'index.html': charge('app.js'), 'app.js': `${SANS_RIEN}${TYPESCRIPT}` });
  assert.equal(fichier.constats.length, 1);
  const [c] = fichier.constats;
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.regle, 'C-SURFACE-03');
  assert.equal(c.fichier, 'app.js');
  assert.equal(c.ligne, 2);
  assert.deepEqual(c.preuve, { cause: 'syntaxe', message: 'Unexpected token', etape: 'lecture', ligne: 2, colonne: 6, inline: false });
  assert.deepEqual(c.axesEmpeches, TOUS);

  const enLigne = await inventaireSeul({ 'index.html': page('<p>x</p>\n<script>\nvar a = 1;\nlet y: string = "";\n</script>\n<script>var b = 2;</script>') });
  assert.equal(enLigne.constats.length, 1, 'le script lisible n\'est pas dit');
  assert.equal(enLigne.constats[0].titre, 'Script de la page que l\'outil ne sait pas lire');
  assert.equal(enLigne.constats[0].ligne, 4, 'à la ligne de l\'erreur dans la page');
  assert.equal(enLigne.constats[0].preuve.inline, true);

  const carte = await inventaireSeul({ 'index.html': page('', '<script type="importmap">{"imports":{"regles":"./regles.txt"}}</script>'), 'regles.txt': TYPESCRIPT });
  assert.equal(carte.constats.length, 1);
  assert.equal(etat(carte.constats[0]), 'info', 'un fichier que seule une carte désigne peut être de la donnée : une information');
  assert.deepEqual(carte.constats[0].preuve.emplacements.map((e) => [e.fichier, e.cause]), [['regles.txt', 'donnee-possible']]);

  const orphelin = await inventaireSeul({ 'index.html': charge('app.js'), 'app.js': SANS_RIEN, 'orphelin.js': TYPESCRIPT });
  assert.deepEqual(orphelin.constats, [], 'du code que la page ne charge pas n\'est pas lu par l\'inventaire : il n\'y a rien à dire');
});

test('un parcours que l\'inventaire n\'a pas pu faire (la pile déborde) est dit sans qu\'aucune règle ne tourne, et la surface garde ce que le code importe', async () => {
  const a = await inventaireSeul({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': CHAINE, 'suite.js': EXFIL });
  assert.ok(a.surface.includes('suite.js'), 'lu par expressions régulières, le code donne encore ses imports à la surface');
  assert.equal(a.constats.length, 1);
  const [c] = a.constats;
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.fichier, 'app.js');
  assert.equal(c.preuve.cause, 'profondeur');
  assert.equal(c.preuve.etape, 'inventaire');
  assert.equal(c.preuve.message, 'la pile déborde');
  assert.match(c.constat, /la pile déborde quand l'inventaire y cherche les fichiers que la page charge, qu'il lit alors par expressions régulières\. S'il s'exécute dans le navigateur, un fichier qu'il charge peut manquer à l'audit\./);
  assert.doesNotMatch(c.constat, /aucune règle ne l'a lu/, 'aucune règle n\'a encore tourné : le texte ne dit que ce qui a eu lieu');
  assert.deepEqual(c.axesEmpeches, TOUS);

  const deux = await inventaireSeul({ 'index.html': page(`<p>x</p>\n<script>${CHAINE.replace("import './suite.js';", "import('./suite.js');")}</script>\n<script>\n${CHAINE.replace("import './suite.js';", "import('./suite.js');")}</script>`), 'suite.js': EXFIL });
  assert.deepEqual(deux.constats.map((x) => [x.fichier, x.ligne, x.preuve.inline, x.preuve.etape]), [['index.html', 2, true, 'inventaire'], ['index.html', 5, true, 'inventaire']], 'deux scripts de la page qui ne se parcourent pas : un constat chacun, à la ligne où le script commence');
  assert.ok(deux.surface.includes('suite.js'));
});

test('une erreur de l\'outil dans le parcours de l\'inventaire ne fait pas sortir l\'audit : elle est dite (cause analyse), et la surface se lit par expressions régulières', () => {
  const contenu = "import './suite.js';\nnew Worker('w.js');\n";
  const f = { chemin: 'app.js', ext: '.js', contenu, binaire: false, executee: true };
  const unite = { source: contenu, inline: false, debut: null };
  // Un arbre dont le parcours lève une erreur qui n'est pas un dépassement de pile : c'est l'outil qui échoue, non le code.
  const arbre = { type: 'Program', sourceType: 'module', body: [{ type: 'ExpressionStatement', get expression() { throw new TypeError('boom'); } }] };
  let refs;
  assert.doesNotThrow(() => { refs = referencesDeCode(f, unite, { ast: arbre, erreur: null }); });
  assert.deepEqual([...refs].map((r) => (typeof r === 'string' ? r : r.documentRelatif ?? r.relatif)), ['./suite.js', 'w.js'], 'lu par expressions régulières : les imports et le worker restent dans la surface');
  assert.deepEqual(refs.specificateurs, [], 'une lecture par expressions régulières n\'ajoute aucun nom');
  const [c] = analyserIllisibles({ fichiers: [f] });
  assert.equal(etat(c), 'critique bloquant');
  assert.equal(c.fichier, 'app.js');
  assert.equal(c.preuve.cause, 'analyse');
  assert.equal(c.preuve.message, 'TypeError : boom');
  assert.equal(c.preuve.etape, 'inventaire');
  assert.match(c.constat, /L'inventaire des fichiers que ce code charge s'est interrompu sur une erreur \(TypeError : boom\) : il l'a lu par expressions régulières, et un fichier qu'il charge peut manquer à l'audit\./);
  assert.match(c.remediation, /Signaler l'erreur/, 'une erreur de l\'outil se signale, le code n\'est pas à réécrire');
  assert.deepEqual(c.axesEmpeches, TOUS);
});

// Une fois par unité ---------------------------------------------------------------------------------------------------------

test('un échec que l\'inventaire et les règles rencontrent tous deux est dit une fois : un constat par unité, la raison de la règle gardée', async () => {
  const chaine = await auditer({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': CHAINE, 'suite.js': EXFIL });
  assert.equal(chaine.de('C-SURFACE-03').length, 1, 'l\'inventaire et les règles ont tous deux échoué sur ce parcours : un constat');
  assert.equal(chaine.de('C-SURFACE-03')[0].preuve.etape, 'parcours', 'la raison qu\'une règle a relevée est gardée, celle de l\'inventaire ne la remplace pas');
  assert.equal(chaine.de('C-SURFACE-03')[0].preuve.cause, 'profondeur');

  const ts = await auditer({ 'index.html': charge('app.js'), 'app.js': TYPESCRIPT });
  assert.equal(ts.de('C-SURFACE-03').length, 1, 'l\'inventaire et les règles ont tous deux refusé ce fichier : un constat');

  const scripts = await auditer({ 'index.html': page(`<script>${TYPESCRIPT}</script>\n<script>var b = 2;</script>\n<script>\n${TYPESCRIPT}</script>`) });
  assert.deepEqual(scripts.de('C-SURFACE-03').map((c) => c.ligne), [1, 5], 'deux scripts illisibles de la même page : un constat chacun, dans l\'ordre de la page');

  const plusieurs = await auditer({ 'index.html': charge('a.js', 'b.js', 'c.js'), 'a.js': TYPESCRIPT, 'b.js': CHAINE, 'c.js': SANS_RIEN, 'suite.js': EXFIL });
  assert.deepEqual(plusieurs.de('C-SURFACE-03').map((c) => c.fichier), ['a.js', 'b.js']);
});

test('ce que l\'inventaire n\'a pas pu parcourir, les règles ne l\'ont pas lu : le widget ne note jamais mieux que s\'il s\'était laissé lire', async () => {
  const cache = await auditer({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': `${EXFIL}${CHAINE}`, 'suite.js': SANS_RIEN });
  const lisible = await auditer({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': `${EXFIL}import './suite.js';\n`, 'suite.js': SANS_RIEN });
  const nCache = noter(cache.constats, new Set(['D']));
  const nLisible = noter(lisible.constats, new Set(['D']));
  assert.ok(lisible.de('C-EXFIL-01', 'app.js').length > 0, 'lisible, l\'exfiltration est vue');
  assert.equal(nCache.verdict, 'NON CONFORME');
  assert.deepEqual(nCache.axesEmpeches, TOUS);
  assert.ok(nCache.global < nLisible.global);
});

// La lecture qui échoue n'est faite qu'une fois -------------------------------------------------------------------------------

/** Un texte qui compte combien de fois acorn le lit : sa conversion en chaîne, la première chose que fait `parse`, se fait dans son code. */
class Compte extends String {
  constructor(texte) {
    super(texte);
    this.lectures = 0;
  }

  [Symbol.toPrimitive]() {
    if (/[\\/]acorn[\\/]/.test(new Error().stack)) this.lectures++;
    return String.prototype.valueOf.call(this);
  }
}

/** Un widget en mémoire que `calculerSurface` lit : `trouver` rend les fichiers, dont le contenu peut être un `Compte`. */
function monde(definitions) {
  const parChemin = new Map(Object.entries(definitions).map(([chemin, contenu]) => [chemin, { chemin, ext: path.extname(chemin), contenu, binaire: false }]));
  return { trouver: (chemin) => parChemin.get(chemin) ?? null };
}

test('la lecture qu\'acorn refuse n\'est faite qu\'une fois pour les arêtes de la fermeture et celles des graphes de document : deux lectures d\'acorn (module, script), non quatre', () => {
  const app = new Compte(TYPESCRIPT);
  const m = monde({ 'index.html': charge('app.js'), 'app.js': app });
  const calcul = calculerSurface(['index.html'], m.trouver, () => []);
  assert.equal(app.lectures, 2, 'la fermeture lit le fichier une fois, en module puis en script');
  assert.ok(calcul.surfaceDuDocument('index.html').has('app.js'));
  assert.equal(app.lectures, 2, 'le graphe de document relit les arêtes du fichier : la lecture qui a échoué n\'est pas refaite');
});

test('la porte des fichiers que seule une carte d\'import désigne et la lecture de leurs références ne lisent le fichier qu\'une fois', () => {
  const regles = new Compte(SANS_RIEN);
  const m = monde({ 'index.html': page('', '<script type="importmap">{"imports":{"regles":"./regles.txt"}}</script>'), 'regles.txt': regles });
  const { surface } = calculerSurface(['index.html'], m.trouver, () => []);
  assert.ok(surface.has('regles.txt'));
  assert.equal(regles.lectures, 1, 'lu une fois : la porte ne refait pas la lecture que les références utilisent');
});

test('ce que l\'inventaire n\'a pas pu lire, les règles ne le relisent pas : elles ne refont aucune lecture, et disent la même raison', async () => {
  await avecWidget({ 'index.html': charge('app.js'), 'app.js': TYPESCRIPT }, {}, async (racine) => {
    const ctx = construireContexte(racine);
    const f = ctx.fichiers.find((x) => x.chemin === 'app.js');
    const contenu = new Compte(f.contenu);
    f.contenu = contenu;
    const constats = await analyseStatique(ctx, { reseau: false });
    assert.equal(contenu.lectures, 0, 'l\'inventaire a déjà refusé ce fichier : aucune règle, aucun graphe ne le relit');
    const illisibles = constats.filter((c) => c.regle === 'C-SURFACE-03');
    assert.equal(illisibles.length, 1);
    assert.equal(illisibles[0].preuve.cause, 'syntaxe');
  });
});

test('les échecs de lecture de plusieurs unités d\'un même fichier sont tous gardés : aucune n\'est relue', () => {
  const f = { chemin: 'p.html', ext: '.html', contenu: '', binaire: false };
  const scripts = [1, 2, 3].map((debut) => ({ source: new Compte(TYPESCRIPT), inline: true, debut }));
  for (const u of scripts) lireUnite(f, u);
  assert.deepEqual(scripts.map((u) => u.source.lectures), [2, 2, 2], 'chacune est lue une fois, en module puis en script');
  for (const u of scripts) lireUnite(f, u);
  assert.deepEqual(scripts.map((u) => u.source.lectures), [2, 2, 2], 'aucune n\'est relue : le deuxième échec d\'un fichier est gardé comme le premier');
  const entier = { source: new Compte(TYPESCRIPT), inline: false, debut: null };
  lireUnite(f, entier);
  lireUnite(f, entier);
  assert.equal(entier.source.lectures, 2, 'le fichier entier a sa propre clé : il n\'est pas pris pour un script de la page');
});

// Ce que l'inventaire lit comme du code ---------------------------------------------------------------------------------------

const EXTENSIONS_DE_CODE = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];

test('un fichier dont l\'extension dit qu\'il est du code est lu pour ses références, lisible ou non ; ce qui n\'en a pas l\'extension et qu\'aucune adresse ne désigne comme du code ne l\'est pas', async () => {
  const fichiers = {
    'index.html': page('', [...EXTENSIONS_DE_CODE.flatMap((ext) => [`r${ext}`, `t${ext}`]), 'style.css', 'notes.txt'].map((nom) => `<link rel="preload" href="${nom}">`).join('')),
    'style.css': 'a::after { content: "import \'./cache-css.js\'" }\n',
    'notes.txt': "import './cache-txt.js';\n",
    'cache-css.js': EXFIL, 'cache-txt.js': EXFIL,
  };
  for (const ext of EXTENSIONS_DE_CODE) {
    fichiers[`r${ext}`] = `import './lisible${ext.replace('.', '-')}.js';\n`;
    fichiers[`t${ext}`] = `let x: number = 1;\nimport './illisible${ext.replace('.', '-')}.js';\n`;
    fichiers[`lisible${ext.replace('.', '-')}.js`] = SANS_RIEN;
    fichiers[`illisible${ext.replace('.', '-')}.js`] = SANS_RIEN;
  }
  const a = await inventaireSeul(fichiers);
  for (const ext of EXTENSIONS_DE_CODE) {
    assert.ok(a.surface.includes(`lisible${ext.replace('.', '-')}.js`), `${ext} : ce que le code importe est atteint`);
    assert.ok(a.surface.includes(`illisible${ext.replace('.', '-')}.js`), `${ext} : même quand l'analyse ne lit pas le fichier, les expressions régulières le font`);
  }
  assert.ok(!a.surface.includes('cache-css.js'), 'une feuille de style ne se lit pas comme du code : ce que son texte ressemble à un import n\'en est pas un');
  assert.ok(!a.surface.includes('cache-txt.js'), 'un texte qu\'aucune adresse ne désigne comme du code n\'est pas du code, même s\'il se lit comme du JavaScript');
});

// Le cas d'une lecture qui lève une erreur de l'outil, et la priorité des raisons ---------------------------------------------

/** Un texte dont la n-ième lecture d'acorn (module, puis script) lève l'erreur demandée ; sans erreur, acorn le lit comme son texte. */
class LectureEnDeuxTemps extends String {
  constructor(texte, erreurs) {
    super(texte);
    this.erreurs = erreurs;
    this.lectures = 0;
  }

  [Symbol.toPrimitive]() {
    if (/[\\/]acorn[\\/]/.test(new Error().stack)) {
      const erreur = this.erreurs[this.lectures++];
      if (erreur) throw erreur();
    }
    return String.prototype.valueOf.call(this);
  }
}

test('une lecture qui lève une erreur qui n\'est ni une erreur de syntaxe d\'acorn ni un dépassement de pile dit « analyse », avec son type et son message', () => {
  const cas = [
    ['une erreur de l\'outil', DEFAUT, 'TypeError : Cannot read properties of undefined (reading \'type\')'],
    ['une erreur de syntaxe sans position, que n\'est pas celle d\'acorn', () => new SyntaxError('autre chose'), 'SyntaxError : autre chose'],
    ['une erreur qui porte une position sans être une erreur de syntaxe', () => Object.assign(new TypeError('x'), { pos: 5 }), 'TypeError : x'],
    ['une valeur qui n\'est pas une erreur', () => 'levée en chaîne', 'Error : levée en chaîne'],
    ['un message très long, coupé', () => new Error('y'.repeat(500)), `Error : ${'y'.repeat(200)}`],
  ];
  for (const [nom, erreur, message] of cas) {
    const { ast, erreur: dite } = lire(new LectureEnDeuxTemps(SANS_RIEN, [erreur, erreur]));
    assert.equal(ast, null, nom);
    assert.equal(dite.cause, 'analyse', nom);
    assert.equal(dite.message, message, nom);
  }
  const vraie = lire(new LectureEnDeuxTemps(TYPESCRIPT, [null, null]));
  assert.equal(vraie.erreur.cause, 'syntaxe', 'une vraie erreur de syntaxe d\'acorn en reste une');
  const posee = lire(new LectureEnDeuxTemps(TYPESCRIPT, [() => Object.assign(new SyntaxError('Unexpected token (1:6)'), { pos: 5, loc: { line: 1, column: 5 } }), null]));
  assert.deepEqual({ ...posee.erreur }, { cause: 'syntaxe', message: 'Unexpected token', ligne: 1, colonne: 6, position: 5 });
});

test('des deux lectures, module et script, la raison dite est un dépassement de pile, puis une erreur de l\'outil, puis la syntaxe qui va le plus loin', () => {
  const cause = (...erreurs) => lire(new LectureEnDeuxTemps(TYPESCRIPT, erreurs)).erreur.cause;
  assert.equal(cause(null, DEFAUT), 'analyse', 'une syntaxe refusée en module, une erreur de l\'outil en script : on ne sait pas ce que le script aurait dit');
  assert.equal(cause(DEFAUT, null), 'analyse', 'de même dans l\'autre sens');
  assert.equal(cause(DEFAUT, DEPASSEMENT), 'profondeur');
  assert.equal(cause(DEPASSEMENT, DEFAUT), 'profondeur');
  assert.equal(cause(null, DEPASSEMENT), 'profondeur');
  assert.equal(cause(DEPASSEMENT, null), 'profondeur');
  assert.equal(cause(DEFAUT, DEFAUT), 'analyse');
  assert.equal(cause(null, null), 'syntaxe');
});

// Ce que dit chaque étape -----------------------------------------------------------------------------------------------------

const unite = (extra) => ({ chemin: 'app.js', message: 'x', inline: false, facultative: false, ligne: null, colonne: null, surface: true, dossierExclu: false, ...extra });
const dire = (extra) => analyserIllisibles({ illisibles: new Map([['app.js\0fichier', unite(extra)]]) })[0];

test('chaque étape dit ce qui a eu lieu, et ne prétend jamais qu\'aucune règle n\'a lu un code que seule l\'inventaire ou une règle n\'a pas pu parcourir', () => {
  const lecture = dire({ cause: 'profondeur', etape: 'lecture', ligne: 3 });
  assert.match(lecture.constat, /imbriqué plus profondément que ce que l'outil sait parcourir : sa pile déborde \(ligne 3\)\. S'il s'exécute dans le navigateur, aucune règle ne l'a lu\./);
  const parcours = dire({ cause: 'profondeur', etape: 'parcours' });
  assert.match(parcours.constat, /imbriqué plus profondément que ce que l'outil sait parcourir : la pile déborde quand une règle le parcourt\. S'il s'exécute dans le navigateur, ce que les règles en disent est incomplet\./);
  assert.doesNotMatch(parcours.constat, /aucune règle ne l'a lu/);
  const inventaire = dire({ cause: 'profondeur', etape: 'inventaire' });
  assert.match(inventaire.constat, /imbriqué plus profondément que ce que l'outil sait parcourir : la pile déborde quand l'inventaire y cherche les fichiers que la page charge, qu'il lit alors par expressions régulières\. S'il s'exécute dans le navigateur, un fichier qu'il charge peut manquer à l'audit\./);
  assert.doesNotMatch(inventaire.constat, /aucune règle ne l'a lu/);
  assert.match(dire({ cause: 'profondeur' }).constat, /sa pile déborde\. S'il s'exécute dans le navigateur, aucune règle ne l'a lu\./, 'sans étape, c\'est celle de la lecture');

  for (const etape of ['lecture', 'parcours', undefined]) {
    assert.match(dire({ cause: 'analyse', etape }).constat, /^L'analyse de ce code s'est interrompue sur une erreur \(x\) : ce que les règles en disent est incomplet\.$/, String(etape));
  }
  assert.match(dire({ cause: 'analyse', etape: 'inventaire' }).constat, /^L'inventaire des fichiers que ce code charge s'est interrompu sur une erreur \(x\) : il l'a lu par expressions régulières, et un fichier qu'il charge peut manquer à l'audit\.$/);

  for (const etape of ['lecture', 'parcours', 'inventaire']) assert.equal(dire({ cause: 'syntaxe', etape, message: 'Unexpected token' }).preuve.etape, etape, 'la preuve du rapport JSON dit l\'étape');
  const groupe = analyserIllisibles({ illisibles: new Map(Array.from({ length: 51 }, (_, i) => [`f${i}.js\0fichier`, unite({ chemin: `f${String(i).padStart(2, '0')}.js`, cause: 'profondeur', etape: 'inventaire' })])) });
  assert.equal(groupe[50].preuve.emplacements[0].etape, 'inventaire', 'le groupe des autres le dit aussi');
});

// Ce que l'inventaire relève ------------------------------------------------------------------------------------------------

test('ce que l\'inventaire relève : le code exécuté seulement, la première raison gardée, une fois par unité, rien pour ce qui n\'est pas du code', () => {
  const fichier = (extra) => ({ chemin: 'app.js', ext: '.js', contenu: TYPESCRIPT, binaire: false, executee: true, ...extra });
  const lu = (f) => lireUnite(f, { source: f.contenu, inline: false, debut: null });

  const rien = fichier({ executee: false });
  assert.equal(lu(rien).ast, null);
  assert.deepEqual(analyserIllisibles({ fichiers: [rien] }), [], 'un code que rien n\'exécute et qu\'acorn refuse n\'est pas dit');

  const execute = fichier();
  lu(execute);
  assert.equal(analyserIllisibles({ fichiers: [execute] }).length, 1);

  const typescript = fichier({ chemin: 'app.ts', ext: '.ts' });
  lu(typescript);
  assert.deepEqual(analyserIllisibles({ fichiers: [typescript] }), [], 'du TypeScript qu\'aucune adresse ne désigne comme du code n\'est pas du code exécuté');
  const designe = fichier({ chemin: 'app.ts', ext: '.ts', commeCode: true });
  lu(designe);
  assert.equal(analyserIllisibles({ fichiers: [designe] }).length, 1, 'désigné comme du code par une adresse, il en est un');

  const facultatif = fichier({ chemin: 'regles.txt', ext: '.txt', commeCode: 'probable' });
  lu(facultatif);
  const [info] = analyserIllisibles({ fichiers: [facultatif] });
  assert.equal(etat(info), 'info');
  assert.deepEqual(info.preuve.emplacements.map((e) => e.cause), ['donnee-possible']);

  const deux = fichier({ contenu: SANS_RIEN });
  noterParcoursEchoue(deux, { source: SANS_RIEN, inline: false, debut: null }, DEPASSEMENT());
  noterParcoursEchoue(deux, { source: SANS_RIEN, inline: false, debut: null }, DEFAUT());
  const [premiere] = analyserIllisibles({ fichiers: [deux] });
  assert.equal(premiere.preuve.cause, 'profondeur', 'la première raison est gardée');

  const regle = fichier({ contenu: SANS_RIEN });
  const ctx = { fichiers: [regle] };
  pourChaqueUniteJs(ctx, {}, () => { throw DEFAUT(); });
  noterParcoursEchoue(regle, { source: SANS_RIEN, inline: false, debut: null }, DEPASSEMENT());
  const constats = analyserIllisibles(ctx);
  assert.equal(constats.length, 1, 'l\'unité qu\'une règle et l\'inventaire ont toutes deux échoué n\'est dite qu\'une fois');
  assert.deepEqual([constats[0].preuve.cause, constats[0].preuve.etape], ['analyse', 'parcours'], 'la raison relevée par la règle avant l\'inventaire est gardée');
  assert.equal(analyserIllisibles(ctx).length, 1, 'relevé de nouveau, il n\'est pas dit deux fois');
});
