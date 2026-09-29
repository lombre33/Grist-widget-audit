import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { construireContexte, calculerSurface, contextesDeDocument, resolveurDeDocument, nouveauListeur, raisonsDeTroncature } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { cheminLocal, urlDe } from '../src/moteur/page-html.js';
import { noter } from '../src/moteur/notation.js';
import { genererMarkdown } from '../src/rapport/markdown.js';
import { genererHtml } from '../src/rapport/html.js';
import { page, auditer, avecWidget, EXFIL, trie, PRECISION_GABARIT } from './aide-surface.mjs';

/**
 * Correctif après 2a, point B (suite) : ce que la surface suit quand la
 * référence n'est pas un chemin écrit en clair. Chaque test a son mutant dans
 * `scripts/mutants-surface-code.mjs`.
 *
 *  - une adresse d'import map qui finit par `/` est un préfixe : tout module
 *    du dossier est du code que la page peut charger, dossiers exclus compris ;
 *  - `new Worker('w.js')`, `serviceWorker.register('sw.js')` et
 *    `audioWorklet.addModule('m.js')` s'adressent au document, pas au fichier ;
 *  - `import('./locales/' + l)` charge un module du dossier `locales/` ;
 *  - la fermeture reste linéaire : un fichier, un dossier ne sont lus qu'une fois.
 *
 * Le différentiel qui compare ces choix à Chromium est dans
 * `surface-chromium.test.mjs`.
 */

const carte = (imports, plus = {}) => `<script type="importmap">${JSON.stringify({ imports, ...plus })}</script>`;
const PRECISION_STANDARD = /Précision : Chromium ne l'exécute pas, un navigateur qui suit le standard HTML si/;
const SANS_RIEN = 'var a = 1;\n';

// D-1 : une adresse d'import map qui finit par « / » est un préfixe -------------------------------------------------

test('D : `"lib/": "./libs/"` rend chargeable tout module de libs/, et seulement lui', async () => {
  const a = await auditer({
    'index.html': page(`${carte({ 'lib/': './libs/' })}<script type="module">import 'lib/x.js';</script>`),
    'libs/x.js': SANS_RIEN, 'libs/y.mjs': EXFIL, 'libs/sub/deep.cjs': SANS_RIEN, 'libs/MAJ.JS': SANS_RIEN,
    'libs/data.json': '{}', 'libs/notes.md': 'x', 'libs/a.js.map': '{}', 'libs/script.ts': 'let t: number = 1;\n',
    'libs2/z.js': EXFIL, 'autre/w.js': EXFIL, 'racine.js': EXFIL,
  });
  assert.deepEqual(a.surface, trie(['index.html', 'libs/x.js', 'libs/y.mjs', 'libs/sub/deep.cjs', 'libs/MAJ.JS']));
  assert.equal(a.de('C-EXFIL-01', 'libs/y.mjs').length, 1, 'un module du préfixe que personne ne nomme est audité');
  assert.equal(a.de('C-EXFIL-01').length, 1, 'ni libs2/, ni un autre dossier');
});

test('D : un préfixe qui désigne node_modules/ fait entrer ses modules (dossier exclu), pas ceux d\'à côté', async () => {
  const a = await auditer({
    'index.html': page(`${carte({ 'lib/': './node_modules/lib/' })}<script type="module">import 'lib/a.js';</script>`),
    'node_modules/lib/a.js': EXFIL, 'node_modules/lib/sub/b.js': EXFIL, 'node_modules/lib/README.md': 'x', 'node_modules/autre/c.js': EXFIL,
  });
  assert.deepEqual(a.surface, trie(['index.html', 'node_modules/lib/a.js', 'node_modules/lib/sub/b.js']));
  for (const chemin of ['node_modules/lib/a.js', 'node_modules/lib/sub/b.js']) {
    assert.equal(a.fichier(chemin).dossierExclu, true);
    assert.equal(a.de('C-EXFIL-01', chemin).length, 1, chemin);
  }
  assert.equal(a.fichier('node_modules/autre/c.js'), undefined, 'un fichier que rien ne désigne n\'entre pas dans l\'inventaire');
});

test('D : un préfixe qui désigne un dossier exclu d\'un sous-dossier ne lit que celui-là', async () => {
  const a = await auditer({
    'index.html': page(`${carte({ 'app/': './sous/dist/' })}<script type="module">import 'app/a.js';</script>`),
    'sous/dist/a.js': EXFIL, 'sous/dist/n/b.js': EXFIL, 'dist/x.js': EXFIL, 'sous/autre.js': EXFIL,
  });
  assert.deepEqual(a.surface, trie(['index.html', 'sous/dist/a.js', 'sous/dist/n/b.js']));
});

for (const cible of ['./', '/']) {
  test(`D : un préfixe qui désigne la racine du widget (« ${cible} ») rend tout module chargeable, dossiers exclus compris, .git jamais`, async () => {
    const a = await auditer({
      'index.html': page(`${carte({ 'a/': cible })}<script type="module">import 'a/x.js';</script>`),
      'x.js': SANS_RIEN, 'sous/y.js': SANS_RIEN, 'dist/z.js': EXFIL, 'node_modules/p/i.js': SANS_RIEN,
      'data.json': '{}', '.git/hooks/h.js': EXFIL,
    });
    assert.deepEqual(a.surface, trie(['index.html', 'x.js', 'sous/y.js', 'dist/z.js', 'node_modules/p/i.js']));
    assert.equal(a.de('C-EXFIL-01', 'dist/z.js').length, 1);
    assert.equal(a.fichier('.git/hooks/h.js'), undefined);
  });
}

test('D : une adresse d\'import map qui ne finit pas par « / » désigne un fichier, non un préfixe', async () => {
  const a = await auditer({
    'index.html': page(carte({ lib: './libs/x' })),
    'libs/x.js': SANS_RIEN, 'libs/xy.js': EXFIL, 'libs/x/z.js': EXFIL, 'libs/autre.js': EXFIL,
  });
  assert.deepEqual(a.surface, trie(['index.html', 'libs/x.js']), 'le module que l\'adresse nomme (sans extension : comme le fait la fermeture pour un chemin), aucun de ses voisins');
});

test('D : le préfixe d\'un bloc `scopes` compte comme celui de `imports`', async () => {
  const a = await auditer({
    'index.html': page(`${carte({}, { scopes: { './sous/': { 'lib/': './libs/' } } })}<script type="module">import 'lib/x.js';</script>`),
    'libs/x.js': EXFIL, 'autre/w.js': EXFIL,
  });
  assert.deepEqual(a.surface, trie(['index.html', 'libs/x.js']));
});

test('D : un préfixe lu depuis un <template> ou par le seul standard porte cette précision aux modules du dossier', async () => {
  const gabarit = await auditer({ 'index.html': page(`<template>${carte({ 'lib/': './libs/' })}</template>`), 'libs/x.js': EXFIL });
  assert.match(gabarit.de('C-EXFIL-01', 'libs/x.js')[0]?.constat ?? '', PRECISION_GABARIT);
  const standard = await auditer({ 'index.html': page(`<script type=" importmap ">${JSON.stringify({ imports: { 'lib/': './libs/' } })}</script>`), 'libs/x.js': EXFIL });
  assert.match(standard.de('C-EXFIL-01', 'libs/x.js')[0]?.constat ?? '', PRECISION_STANDARD);
  const direct = await auditer({ 'index.html': page(carte({ 'lib/': './libs/' })), 'libs/x.js': EXFIL });
  assert.doesNotMatch(direct.de('C-EXFIL-01', 'libs/x.js')[0]?.constat ?? '', /Précision/);
  const mixte = await auditer({ 'index.html': page(`<template>${carte({ 'lib/': './libs/' })}</template>${carte({ 'autre/': './libs/' })}`), 'libs/x.js': EXFIL });
  assert.doesNotMatch(mixte.de('C-EXFIL-01', 'libs/x.js')[0]?.constat ?? '', /Précision/, 'une page qui le charge sans réserve : rien à préciser');
});

// D-2 : ce qui s'adresse au document ---------------------------------------------------------------------------------

const surfaceDe = async (fichiers) => (await auditer(fichiers)).surface;

test('D : `new Worker(\'w.js\')` d\'un sous-dossier se résout contre la page (w.js) et, dans le doute, contre le fichier (sous/w.js)', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script src="sous/app.js"></script>'), 'sous/app.js': "new Worker('w.js');\n",
    'w.js': SANS_RIEN, 'sous/w.js': SANS_RIEN, 'autre/w.js': EXFIL,
  }), trie(['index.html', 'sous/app.js', 'w.js', 'sous/w.js']));
});

test('D : sous une <base>, un worker se résout contre la base de la page, non contre la racine', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script src="/js/app.js"></script>', '<base href="base/">'), 'js/app.js': "new Worker('w.js');\n",
    'base/w.js': SANS_RIEN, 'js/w.js': SANS_RIEN, 'w.js': EXFIL,
  }), trie(['index.html', 'js/app.js', 'base/w.js', 'js/w.js']));
});

test('D : un script placé avant la <base> voit la page sans base, le code qui tourne ensuite voit la base', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('', '<script src="js/app.js"></script><base href="base/">'), 'js/app.js': "new Worker('w.js');\n",
    'base/w.js': SANS_RIEN, 'w.js': SANS_RIEN, 'js/w.js': SANS_RIEN, 'autre/w.js': EXFIL,
  }), trie(['index.html', 'js/app.js', 'base/w.js', 'w.js', 'js/w.js']));
});

test('D : `new Worker(new URL(\'./w.js\', import.meta.url))` se résout contre le module, exactement', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script src="sous/app.js"></script>'), 'sous/app.js': "new Worker(new URL('./w.js', import.meta.url));\n",
    'sous/w.js': SANS_RIEN, 'w.js': EXFIL,
  }), trie(['index.html', 'sous/app.js', 'sous/w.js']));
});

test('D : `new Worker(new URL(\'w.js\', document.baseURI))` se résout contre la page', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script src="sous/app.js"></script>'), 'sous/app.js': "new Worker(new URL('w.js', document.baseURI));\nnew SharedWorker(new URL('s.js', window.location.href));\nnew Worker(new URL('./u.js', config.url));\n",
    'w.js': SANS_RIEN, 's.js': SANS_RIEN, 'u.js': SANS_RIEN, 'autre/w.js': EXFIL,
  }), trie(['index.html', 'sous/app.js', 'w.js', 's.js', 'u.js']));
});

test('D : un service worker et un module de worklet se résolvent contre la page, les autres `register` et `addModule` ne sont rien', async () => {
  const surface = await surfaceDe({
    'index.html': page('<script src="sous/app.js"></script>'),
    'sous/app.js': [
      "navigator.serviceWorker.register('sw.js');",
      "audioCtx.audioWorklet.addModule('audio.js');",
      "CSS.paintWorklet.addModule('paint.js');",
      "layoutWorklet.addModule('layout.js');",
      "worklet.addModule('minuscule.js');",
      "registre.addModule('non1.js');",
      "aide.register('non2.js');",
      "monserviceWorker.register('non3.js');",
      "moi$Worklet.addModule('non4.js');",
      'navigator.serviceWorker.register(nom);',
    ].join('\n'),
    ...Object.fromEntries(['sw', 'audio', 'paint', 'layout', 'minuscule', 'non1', 'non2', 'non3', 'non4'].map((n) => [`${n}.js`, EXFIL])),
  });
  assert.deepEqual(surface, trie(['index.html', 'sous/app.js', 'sw.js', 'audio.js', 'paint.js', 'layout.js', 'minuscule.js']));
});

test('D : `importScripts()` se résout contre le worker qui l\'appelle, tous ses arguments', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script src="app.js"></script>'), 'app.js': "new Worker('sous/w.js');\n",
    'sous/w.js': "importScripts('a.js', './b.js');\n", 'sous/a.js': SANS_RIEN, 'sous/b.js': SANS_RIEN, 'a.js': EXFIL, 'b.js': EXFIL,
  }), trie(['index.html', 'app.js', 'sous/w.js', 'sous/a.js', 'sous/b.js']));
});

test('D : chaque page d\'entrée est un contexte : le worker d\'un script partagé se résout sous chacune', async () => {
  assert.deepEqual(await surfaceDe({
    'a/index.html': page('<script src="../js/app.js"></script>'), 'b/index.html': page('<script src="../js/app.js"></script>'),
    'js/app.js': "new Worker('w.js');\n",
    'a/w.js': SANS_RIEN, 'b/w.js': SANS_RIEN, 'js/w.js': SANS_RIEN, 'c/w.js': EXFIL,
  }), trie(['a/index.html', 'b/index.html', 'js/app.js', 'a/w.js', 'b/w.js', 'js/w.js']));
});

test('D : un worker écrit dans la page se résout contre la base de la page, exactement, et porte la réserve du gabarit', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script>new Worker("w.js"); navigator.serviceWorker.register("sw.js");</script>', '<base href="b/">'),
    'b/w.js': SANS_RIEN, 'b/sw.js': SANS_RIEN, 'w.js': EXFIL, 'sw.js': EXFIL,
  }), trie(['index.html', 'b/w.js', 'b/sw.js']));
  const gabarit = await auditer({ 'index.html': page('<template><script>new Worker("w.js");</script></template>'), 'w.js': EXFIL });
  assert.match(gabarit.de('C-EXFIL-01', 'w.js')[0]?.constat ?? '', PRECISION_GABARIT);
  const direct = await auditer({ 'index.html': page('<script>new Worker("w.js");</script>'), 'w.js': EXFIL });
  assert.doesNotMatch(direct.de('C-EXFIL-01', 'w.js')[0]?.constat ?? '', /Précision/);
});

test('D : dans un code que l\'analyseur ne lit pas, les adresses de document restent résolues contre la page', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script src="sous/app.js"></script>'),
    'sous/app.js': [
      'const x = <div />;',
      "new Worker('w1.js');",
      "new Worker(new URL('w2.js', document.baseURI));",
      "navigator.serviceWorker.register('sw.js');",
      'CSS.paintWorklet.addModule("pw.js");',
      "audioCtx.audioWorklet.addModule('aw.js');",
      "worklet.addModule('minuscule.js');",
      "monserviceWorker.register('non.js');",
      "importScripts('i1.js');",
      '',
    ].join('\n'),
    ...Object.fromEntries(['w1', 'w2', 'sw', 'pw', 'aw', 'minuscule', 'non'].map((n) => [`${n}.js`, EXFIL])), 'sous/i1.js': SANS_RIEN,
  }), trie(['index.html', 'sous/app.js', 'w1.js', 'w2.js', 'sw.js', 'pw.js', 'aw.js', 'minuscule.js', 'sous/i1.js']).filter((c) => c !== 'non.js'));
});

// D-3 : `import()` dont le début de l'adresse est fixe --------------------------------------------------------------

const modules = (noms) => Object.fromEntries(noms.map((n) => [n, SANS_RIEN]));

test('D : `import(`./locales/${l}.js`)` rend chargeable tout module de locales/, sous-dossiers compris', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': "const l = 'fr';\nimport(`./locales/${l}.js`);\n",
    ...modules(['locales/en.js', 'locales/fr.js', 'locales/sous/x.js', 'locales2/en.js', 'autres/en.js']), 'locales/data.json': '{}',
  }), trie(['index.html', 'app.js', 'locales/en.js', 'locales/fr.js', 'locales/sous/x.js']));
});

test('D : `import(\'./chunks/\' + nom + \'.js\')` : la concaténation vaut le gabarit', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': "import('./chunks/' + nom + '.js');\n",
    ...modules(['chunks/a.js', 'autre/a.js']),
  }), trie(['index.html', 'app.js', 'chunks/a.js']));
});

test('D : le dossier d\'un `import()` se lit depuis le fichier qui l\'écrit, `../` comprise, jamais hors du widget', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="sous/app.js"></script>'),
    'sous/app.js': "import(`./chunks/${n}.js`);\nimport(`../partage/${n}.js`);\nimport(`../../dehors/${n}.js`);\n",
    ...modules(['sous/chunks/a.js', 'chunks/b.js', 'partage/c.js', 'dehors/d.js']),
  }), trie(['index.html', 'sous/app.js', 'sous/chunks/a.js', 'partage/c.js']));
});

test('D : `import(\'/locales/\' + l)` part de la racine du widget, `import(\'./\' + l)` du dossier du fichier', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="sous/app.js"></script>'), 'sous/app.js': "import('/locales/' + l);\n",
    ...modules(['locales/en.js', 'sous/locales/en.js']),
  }), trie(['index.html', 'sous/app.js', 'locales/en.js']));
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="sous/app.js"></script>'), 'sous/app.js': "import('./' + l);\n",
    ...modules(['sous/a.js', 'sous/b/c.js', 'racine.js']),
  }), trie(['index.html', 'sous/app.js', 'sous/a.js', 'sous/b/c.js']));
});

test('D : `import(\'./\' + l)` et `import(\'/\' + l)` d\'un fichier de la racine rendent chargeable tout module du widget', async () => {
  for (const debut of ["'./'", "'/'"]) {
    assert.deepEqual(await surfaceDe({
      'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': `import(${debut} + l);\n`,
      ...modules(['a.js', 'sous/b.js', 'dist/c.js']), 'data.json': '{}',
    }), trie(['index.html', 'app.js', 'a.js', 'sous/b.js', 'dist/c.js']), debut);
  }
});

test('D : sans dossier fixe, un `import()` calculé ne fait entrer aucun module', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="app.js"></script>'),
    'app.js': [
      'import(x);',
      'import(`${x}/a.js`);',
      "import('lib-' + x);",
      'import(`locales/${x}.js`);',
      "import('lodash/' + x);",
      "import('locales' + x);",
      'import(x + "./locales/");',
      "import('./locales/' - x);",
      '',
    ].join('\n'),
    ...modules(['locales/en.js', 'lib-en.js', 'lodash/a.js', 'a.js', 'locales.js']),
  }), trie(['index.html', 'app.js']));
});

test('D : `import()` de la page se lit contre la base de la page et porte la réserve du gabarit', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module">import(`./locales/${l}.js`);</script>', '<base href="b/">'),
    ...modules(['b/locales/en.js', 'locales/en.js']),
  }), trie(['index.html', 'b/locales/en.js']));
  const gabarit = await auditer({ 'index.html': page('<template><script type="module">import(`./locales/${l}.js`);</script></template>'), 'locales/en.js': EXFIL });
  assert.match(gabarit.de('C-EXFIL-01', 'locales/en.js')[0]?.constat ?? '', PRECISION_GABARIT);
});

test('D : `import()` d\'une page rangée dans un sous-dossier se lit contre le dossier de cette page', async () => {
  assert.deepEqual(await surfaceDe({
    'app/index.html': page('<script type="module">import(`./locales/${l}.js`);</script><script type="module">import("./chunk.js");</script>'),
    ...modules(['app/locales/en.js', 'locales/en.js', 'app/chunk.js', 'chunk.js']),
  }), trie(['app/index.html', 'app/locales/en.js', 'app/chunk.js']));
});

test('D : dans un code que l\'analyseur ne lit pas, le début fixe d\'un `import()` reste suivi', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="sous/app.js"></script>'),
    'sous/app.js': ['const x = <div />;', 'import(`./a/${l}.js`);', "import('./b/' + l);", "import('c/' + l);", 'import(`d/${l}`);', ''].join('\n'),
    ...modules(['sous/a/x.js', 'sous/b/x.js', 'sous/c/x.js', 'sous/d/x.js', 'a/x.js']),
  }), trie(['index.html', 'sous/app.js', 'sous/a/x.js', 'sous/b/x.js']));
});

test('D : un cycle d\'imports, un module qui s\'importe lui-même : la fermeture s\'arrête', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="a.js"></script>'),
    'a.js': "import './b.js';\nimport './a.js';\n", 'b.js': "import './a.js';\nimport './b.js';\n",
  }), trie(['index.html', 'a.js', 'b.js']));
});

test('D : la requête et le fragment d\'une adresse ne sont pas son chemin', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="app.js"></script>'),
    'app.js': "import './a.js?v=1';\nimport './b.js#frag';\nnew Worker('w.js?x=1#y');\nnew Worker('/w2.js?x=1');\n",
    ...modules(['a.js', 'b.js', 'w.js', 'w2.js']),
  }), trie(['index.html', 'app.js', 'a.js', 'b.js', 'w.js', 'w2.js']));
});

// D-4 : ce que la fermeture ne relit pas, ce que le listeur ne lit qu'une fois ---------------------------------------

const fiche = (chemin, contenu) => ({ chemin, ext: path.extname(chemin), contenu, binaire: false });
/** Un widget en mémoire : `trouver` compte ses appels. */
function monde(definitions) {
  const parChemin = new Map(Object.entries(definitions).map(([c, t]) => [c, fiche(c, t)]));
  const appels = [];
  return { appels, trouver: (chemin) => { appels.push(chemin); return parChemin.get(chemin) ?? null; }, de: (chemin) => appels.filter((c) => c === chemin).length };
}

test('D : un dossier nommé par plusieurs références n\'est lu qu\'une fois par parcours', () => {
  const m = monde({
    'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': "import(`./locales/${a}.js`);\nimport(`./locales/${b}.js`);\n", 'locales/en.js': SANS_RIEN,
  });
  const lus = [];
  const { surface } = calculerSurface(['index.html'], m.trouver, (dossier) => { lus.push(dossier); return ['locales/en.js']; });
  assert.deepEqual([...surface].sort(), ['app.js', 'index.html', 'locales/en.js']);
  assert.deepEqual(lus, ['locales/', 'locales/', 'locales/'], 'un parcours pour tout, un sans gabarit, un sans standard : trois lectures, non six');
});

test('D : un fichier nommé par plusieurs importeurs n\'entre qu\'une fois dans la file de chaque parcours', () => {
  const m = monde({
    'index.html': page('<script type="module" src="a.js"></script><script type="module" src="b.js"></script>'),
    'a.js': "import './c.js';\n", 'b.js': "import './c.js';\n", 'c.js': SANS_RIEN,
  });
  const { surface } = calculerSurface(['index.html'], m.trouver, () => []);
  assert.deepEqual([...surface].sort(), ['a.js', 'b.js', 'c.js', 'index.html']);
  // Deux recherches de candidat (une par importeur), une lecture de ses propres références (les deux mémoïsées entre les parcours) et une sortie de file par parcours : 2 + 1 + 3.
  assert.equal(m.de('c.js'), 6);
});

test('D : les contextes de page se calculent une fois par fermeture, quel que soit le nombre d\'adresses de document', () => {
  const m = monde({
    'index.html': page('<script src="app.js"></script>'), 'app.js': "new Worker('w1.js');\nnew Worker('w2.js');\nnew Worker('w3.js');\n", 'w1.js': SANS_RIEN,
  });
  const { surface } = calculerSurface(['index.html'], m.trouver, () => []);
  assert.deepEqual([...surface].sort(), ['app.js', 'index.html', 'w1.js']);
  // Une lecture pour ses arêtes (mémoïsée), une sortie de file par parcours (3), une pour les contextes : 5.
  assert.equal(m.de('index.html'), 5);
});

test('D : par défaut, la fermeture a de quoi résoudre les adresses de worker sous chaque page', () => {
  const m = monde({ 'a/index.html': page('<script src="../js/app.js"></script>'), 'js/app.js': "new Worker('w.js');\n", 'a/w.js': SANS_RIEN });
  const { surface, partiel } = calculerSurface(['a/index.html'], m.trouver, () => []);
  assert.deepEqual([...surface].sort(), ['a/index.html', 'a/w.js', 'js/app.js']);
  assert.equal(partiel, false);
});

test('D : une page qui se cite elle-même n\'entre pas deux fois dans la file', () => {
  const m = monde({ 'index.html': page('', '<link rel="canonical" href="index.html">') });
  const { surface } = calculerSurface(['index.html'], m.trouver, () => []);
  assert.deepEqual([...surface], ['index.html']);
  // Sa recherche comme candidat de son propre lien, la lecture de ses références, une sortie de file par parcours : 1 + 1 + 3.
  assert.equal(m.de('index.html'), 5);
});

test('contextes : deux pages d\'un même dossier ne font qu\'un contexte, deux dossiers en font deux', () => {
  const m = monde({ 'a/index.html': page(''), 'a/autre.html': page(''), 'b/index.html': page('') });
  assert.deepEqual(contextesDeDocument(['a/index.html', 'a/autre.html'], m.trouver), [{ entree: 'a/index.html', baseBrute: null }]);
  assert.deepEqual(contextesDeDocument(['a/index.html', 'b/index.html'], m.trouver).map((c) => c.entree), ['a/index.html', 'b/index.html']);
});

test('contextes : la base finale, celle d\'un script qui la précède, et la page sans script ni base', () => {
  const m = monde({
    'base.html': page('<script src="x.js"></script>', '<base href="b/">'),
    'avant.html': page('', '<script src="x.js"></script><base href="b/">'),
    'sans-base.html': page('<script src="x.js"></script>'),
    'vide.html': page(''),
    'deux-dossiers/base.html': page('<script src="x.js"></script>', '<base href="c/">'),
  });
  const de = (entree) => contextesDeDocument([entree], m.trouver).map((c) => c.baseBrute);
  assert.deepEqual(de('base.html'), ['b/'], 'tous les scripts sont après la base : la page sans base n\'existe pas');
  assert.deepEqual(de('avant.html'), ['b/', null], 'le code qui tourne ensuite voit la base, le script placé avant ne la voit pas');
  assert.deepEqual(de('sans-base.html'), [null]);
  assert.deepEqual(de('vide.html'), [null]);
  assert.deepEqual(contextesDeDocument(['base.html', 'deux-dossiers/base.html'], m.trouver).map((c) => c.baseBrute), ['b/', 'c/'], 'même base, dossiers différents : deux contextes ; ici deux bases');
  assert.deepEqual(contextesDeDocument(['inconnu.html'], m.trouver), [{ entree: 'inconnu.html', baseBrute: null }], 'une page sans contenu lisible : la page elle-même');
  assert.deepEqual(contextesDeDocument(['binaire.html'], () => ({ chemin: 'binaire.html', binaire: true })), [{ entree: 'binaire.html', baseBrute: null }], 'un fichier trouvé mais sans texte : de même');
});

test('contextes : une base d\'un autre dossier et la même base sous deux dossiers', () => {
  const m = monde({ 'a/index.html': page('<script src="x.js"></script>', '<base href="/r/">'), 'b/index.html': page('<script src="x.js"></script>', '<base href="/r/">') });
  assert.equal(contextesDeDocument(['a/index.html', 'b/index.html'], m.trouver).length, 2, 'une base relative se résoudrait sous chaque dossier : deux contextes, même écrite pareil');
});

test('résolution : une adresse relative se résout sous chaque contexte, une base externe ne désigne rien du widget', () => {
  const resoudre = resolveurDeDocument([
    { entree: 'a/index.html', baseBrute: null }, { entree: 'b/index.html', baseBrute: 'c/' },
    { entree: 'index.html', baseBrute: '/abs/' }, { entree: 'index.html', baseBrute: 'https://cdn.example/x/' },
  ]);
  assert.deepEqual([...resoudre('w.js')].sort(), ['a/w.js', 'abs/w.js', 'b/c/w.js']);
  assert.deepEqual([...resoudre('w.js?v=1#x')].sort(), ['a/w.js', 'abs/w.js', 'b/c/w.js'], 'la requête et le fragment ne sont pas le chemin');
  assert.deepEqual([...resoudre('/racine/w.js')].sort(), ['racine/w.js'], 'une adresse absolue part de la racine du widget, quel que soit le contexte');
  assert.equal(resoudre('w.js'), resoudre('w.js'), 'le résultat d\'une adresse se calcule une fois');
});

// Le listeur --------------------------------------------------------------------------------------------------------

const sansEtat = () => ({ exclus: [], tronqueListage: false });

test('listeur : les modules dont le chemin commence par le préfixe, triés, le premier et le dernier compris', () => {
  const fichiers = ['z/b.js', 'a/x.js', 'm/k.js', 'a/w.js', 'a/b/c.js', 'ab/d.js', 'a.js', 'a/y.json'].map((chemin) => ({ chemin }));
  const lister = nouveauListeur('/inexistant', fichiers, sansEtat(), 10);
  assert.deepEqual(lister(''), ['a.js', 'a/b/c.js', 'a/w.js', 'a/x.js', 'ab/d.js', 'm/k.js', 'z/b.js']);
  assert.deepEqual(lister('a/'), ['a/b/c.js', 'a/w.js', 'a/x.js']);
  assert.deepEqual(lister('a/b/'), ['a/b/c.js']);
  assert.deepEqual(lister('z/'), ['z/b.js'], 'le dernier');
  assert.deepEqual(lister('a.'), ['a.js'], 'le premier');
  assert.deepEqual(lister('a/x'), ['a/x.js'], 'un préfixe n\'est pas forcément un dossier');
  assert.deepEqual(lister('a/x.js'), ['a/x.js'], 'et un chemin entier se désigne lui-même');
  assert.deepEqual(lister('0'), [], 'avant le premier');
  assert.deepEqual(lister('zz'), [], 'après le dernier');
  assert.deepEqual(lister('m/'), ['m/k.js'], 'au milieu');
  assert.deepEqual(lister('n/'), [], 'entre deux');
});

test('listeur : la plage d\'un préfixe se borne par recherche dichotomique, sans comparer chaque module au préfixe', () => {
  const fichiers = Array.from({ length: 5000 }, (_, i) => ({ chemin: `d${String(i).padStart(4, '0')}/m.js` }));
  const lister = nouveauListeur('/inexistant', fichiers, sansEtat(), 10);
  assert.equal(lister('').length, 5000);
  const original = String.prototype.startsWith;
  let appels = 0;
  let rendus;
  String.prototype.startsWith = function startsWithCompte(...arguments_) { appels++; return original.apply(this, arguments_); };
  try { rendus = lister('d0'); } finally { String.prototype.startsWith = original; }
  assert.equal(rendus.length, 1000);
  assert.ok(appels <= 20, `${appels} comparaisons de préfixe pour 1 000 modules : la plage doit se borner en log(n), pas module par module`);
});

test('listeur : ne rend que des modules JavaScript, sur le nom seul', () => {
  const bons = ['a.js', 'b.mjs', 'c.cjs', 'D.JS', 'e.MJS', 'f.Cjs'];
  const mauvais = ['g.jsx', 'h.ts', 'i.json', 'j.js.map', 'k.mjs.bak', 'js', 'l.css', 'm.html', 'n.md'];
  const lister = nouveauListeur('/inexistant', [...mauvais, ...bons].map((chemin) => ({ chemin })), sansEtat(), 10);
  assert.deepEqual(lister(''), trie(bons));
});

test('listeur : ce que l\'inventaire a déjà ouvert d\'un dossier exclu n\'est rendu qu\'une fois', async () => {
  await avecWidget({ 'node_modules/p/a.js': SANS_RIEN, 'node_modules/p/b.js': SANS_RIEN }, {}, (racine) => {
    const fichiers = [{ chemin: 'app.js' }, { chemin: 'node_modules/p/a.js', dossierExclu: true }];
    const etat = { exclus: ['node_modules'], tronqueListage: false };
    assert.deepEqual(nouveauListeur(racine, fichiers, etat, 100)(''), ['app.js', 'node_modules/p/a.js', 'node_modules/p/b.js']);
  });
});

test('listeur : lit les dossiers exclus à fond, sans .git, sans les dossiers pris pour des fichiers, et rend l\'inventaire avec', async () => {
  await avecWidget({
    'node_modules/p/a.js': SANS_RIEN, 'node_modules/p/b.js': SANS_RIEN, 'node_modules/q/c.js': SANS_RIEN,
    'node_modules/q/.git/hooks/h.js': EXFIL, 'node_modules/dir.js/dedans.js': SANS_RIEN, 'node_modules/notes.md': 'x',
    'dist/d.js': SANS_RIEN, 'sous/dist/e.js': SANS_RIEN,
  }, {}, (racine) => {
    const fichiers = [{ chemin: 'z.js' }, { chemin: 'app.js' }];
    const etat = { exclus: ['node_modules', 'dist', 'sous/dist'], tronqueListage: false };
    assert.deepEqual(nouveauListeur(racine, fichiers, etat, 100)(''), [
      'app.js', 'dist/d.js', 'node_modules/dir.js/dedans.js', 'node_modules/p/a.js', 'node_modules/p/b.js', 'node_modules/q/c.js', 'sous/dist/e.js', 'z.js',
    ]);
    assert.equal(etat.tronqueListage, false);
  });
});

test('listeur : un dossier exclu absent ou illisible ne fait rien échouer', async () => {
  await avecWidget({ 'app.js': SANS_RIEN }, {}, (racine) => {
    const etat = { exclus: ['absent', 'app.js'], tronqueListage: false };
    assert.deepEqual(nouveauListeur(racine, [{ chemin: 'app.js' }], etat, 100)(''), ['app.js'], 'ni un dossier absent, ni un fichier pris pour un dossier');
  });
});

test('listeur : un lien n\'est pas suivi, ni comme fichier ni comme dossier', async (t) => {
  try {
    await avecWidget({ 'node_modules/p/a.js': SANS_RIEN }, { liens: [['node_modules/lien.js', 'cible.js'], ['node_modules/lien-dossier', 'dossier-cible']], dehors: { 'cible.js': EXFIL, 'dossier-cible/z.js': EXFIL } }, (racine) => {
      const etat = { exclus: ['node_modules'], tronqueListage: false };
      assert.deepEqual(nouveauListeur(racine, [], etat, 100)(''), ['node_modules/p/a.js']);
    });
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip(`lien symbolique impossible ici : ${e.code}`);
    throw e;
  }
});

test('listeur : le budget d\'entrées lues est exact, au-delà l\'inventaire se dit tronqué et la liste reste triée', async () => {
  const fichiers = { '.gitkeep': '', ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`node_modules/m${String(i).padStart(2, '0')}.js`, SANS_RIEN])), 'node_modules/.git/x.js': EXFIL, 'node_modules/.git/y.js': EXFIL };
  await avecWidget(fichiers, {}, (racine) => {
    const inventaire = [{ chemin: 'z.js' }, { chemin: 'b.js' }];
    const complet = { exclus: ['node_modules'], tronqueListage: false };
    const tous = nouveauListeur(racine, inventaire, complet, 12)('');
    assert.equal(tous.length, 14, 'douze modules et deux de l\'inventaire : rien n\'est coupé à 12 entrées (les entrées de .git ne comptent pas)');
    assert.equal(complet.tronqueListage, false);
    const court = { exclus: ['node_modules'], tronqueListage: false };
    const coupe = nouveauListeur(racine, inventaire, court, 11)('');
    assert.equal(court.tronqueListage, true, 'douze entrées pour un budget de onze');
    assert.ok(coupe.length < 14 && coupe.includes('b.js') && coupe.includes('z.js'), coupe.join());
    assert.deepEqual(coupe, [...coupe].sort(), 'une liste coupée reste triée, sinon la recherche du préfixe se trompe');
  });
});

test('listeur : les dossiers exclus ne se lisent qu\'au premier appel, et une seule fois', async () => {
  await avecWidget({ 'node_modules/p/a.js': SANS_RIEN, 'node_modules/q/b.js': SANS_RIEN }, {}, (racine) => {
    const lecture = fs.readdirSync;
    let lectures = 0;
    fs.readdirSync = (...arguments_) => { lectures += 1; return lecture(...arguments_); };
    try {
      const etat = { exclus: ['node_modules'], tronqueListage: false };
      const lister = nouveauListeur(racine, [], etat, 100);
      assert.equal(lectures, 0, 'rien ne se lit avant le premier préfixe');
      lister('node_modules/p/');
      const apres = lectures;
      assert.ok(apres >= 3, `node_modules, p, q : ${apres}`);
      lister('node_modules/q/');
      lister('');
      assert.equal(lectures, apres, 'les appels suivants ne relisent rien');
    } finally {
      fs.readdirSync = lecture;
    }
  });
});

test('D : un .git, celui de la racine comme celui d\'un dossier exclu, ne se lit pas et ne consomme pas le budget', async () => {
  const html = page(`${carte({ 'm/': './' })}<script type="module">import 'm/a.js';</script>`);
  const objets = (dossier) => Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${dossier}/objets/o${i}.js`, EXFIL]));
  const a = await auditer({
    'index.html': html, ...modules(['node_modules/a.js', 'node_modules/b.js']), ...objets('.git'), ...objets('node_modules/.git'),
  }, { plafonds: { maxEntreesListees: 2 } });
  assert.equal(a.ctx.tronque, null, 'deux entrées lues, node_modules/a.js et node_modules/b.js : ni .git ni node_modules/.git ne comptent');
  assert.deepEqual(a.surface, trie(['index.html', 'node_modules/a.js', 'node_modules/b.js']));
});

test('D : un widget sans préfixe ne lit aucun dossier exclu, même sous un budget d\'une entrée', async () => {
  const a = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': SANS_RIEN, ...modules(['node_modules/a.js', 'node_modules/b.js', 'node_modules/c.js']) }, { plafonds: { maxEntreesListees: 1 } });
  assert.equal(a.ctx.tronque, null);
});

test('D : un préfixe qui dépasse le budget de lecture le dit (inventaire tronqué) et garde ce qu\'il a lu', async () => {
  const dossier = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`node_modules/m${i}.js`, SANS_RIEN]));
  const html = page(`${carte({ 'm/': './node_modules/' })}<script type="module">import 'm/m0.js';</script>`);
  const complet = await auditer({ 'index.html': html, ...dossier }, { plafonds: { maxEntreesListees: 12 } });
  assert.equal(complet.ctx.tronque, null);
  assert.equal(complet.surface.length, 13);
  const court = await auditer({ 'index.html': html, ...dossier }, { plafonds: { maxEntreesListees: 11 } });
  assert.equal(court.ctx.tronque?.listage, true);
  assert.deepEqual([court.ctx.tronque?.fichiers, court.ctx.tronque?.octets, court.ctx.tronque?.surface], [false, false, false], 'seul le plafond de lecture des dossiers exclus est atteint');
  assert.equal(court.ctx.tronque?.maxEntreesListees, 11);
  assert.ok(court.surface.length < 13, court.surface.join());
});

// D-5 : ce qui dépasse un plafond se dit ---------------------------------------------------------------------------

test('résolution : le budget borne le nombre total de résolutions, puis plus rien ne se résout', () => {
  const contextes = [{ entree: 'a/index.html', baseBrute: null }, { entree: 'b/index.html', baseBrute: null }];
  const budget = { restant: 3, epuise: false };
  const resoudre = resolveurDeDocument(contextes, budget);
  assert.deepEqual([...resoudre('x.js')].sort(), ['a/x.js', 'b/x.js']);
  assert.equal(budget.epuise, false, 'deux résolutions sur trois');
  assert.deepEqual([...resoudre('y.js')], ['a/y.js'], 'la troisième a lieu, la quatrième non');
  assert.equal(budget.epuise, true);
  assert.deepEqual([...resoudre('z.js')], [], 'plus rien ensuite');
  const juste = { restant: 4, epuise: false };
  const autre = resolveurDeDocument(contextes, juste);
  autre('x.js');
  autre('y.js');
  assert.equal(juste.epuise, false, 'un budget égal au nombre de résolutions ne s\'épuise pas');
});

test('D : trop d\'adresses de worker sous trop de pages d\'entrée : la surface se dit tronquée, à la résolution près', async () => {
  const dossiers = ['a', 'b', 'c'];
  const fichiers = {
    ...Object.fromEntries(dossiers.map((d) => [`${d}/index.html`, page('<script src="../js/app.js"></script>')])),
    'js/app.js': "new Worker('w1.js');\nnew Worker('w2.js');\nnew Worker('w3.js');\n",
    ...modules(dossiers.flatMap((d) => ['w1', 'w2', 'w3'].map((w) => `${d}/${w}.js`))),
  };
  // Trois adresses sous trois contextes : neuf résolutions.
  const juste = await auditer(fichiers, { plafonds: { maxResolutions: 9 } });
  assert.equal(juste.ctx.tronque, null, 'un budget égal au nombre de résolutions ne tronque rien');
  assert.equal(juste.surface.length, 3 + 1 + 9);
  const court = await auditer(fichiers, { plafonds: { maxResolutions: 8 } });
  assert.equal(court.ctx.tronque?.surface, true);
  assert.deepEqual([court.ctx.tronque?.fichiers, court.ctx.tronque?.octets, court.ctx.tronque?.listage], [false, false, false], 'seul le budget de résolutions est atteint');
  assert.equal(court.ctx.tronque?.maxResolutions, 8);
  assert.equal(court.surface.length, juste.surface.length - 1, 'la neuvième résolution n\'a pas eu lieu, aucune autre ne manque');
});

test('D : un widget sans adresse de document ne dépense aucune résolution', async () => {
  const a = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': SANS_RIEN }, { plafonds: { maxResolutions: 0 } });
  assert.equal(a.ctx.tronque, null);
});

const PLAFONDS = { maxFichiers: 20000, maxOctets: 200 * 1024 * 1024, maxEntreesListees: 100000, maxResolutions: 2000000 };
const AUCUN = { fichiers: false, octets: false, listage: false, surface: false, ...PLAFONDS };

test('troncature : une phrase par plafond atteint, dans l\'ordre', () => {
  assert.deepEqual(raisonsDeTroncature(AUCUN), []);
  assert.deepEqual(raisonsDeTroncature({ ...AUCUN, fichiers: true }), ['plus de 20000 fichiers']);
  assert.deepEqual(raisonsDeTroncature({ ...AUCUN, octets: true }), ['plus de 200 Mio de contenu lu']);
  assert.deepEqual(raisonsDeTroncature({ ...AUCUN, listage: true }), ['plus de 100000 entrées lues dans les dossiers exclus pour suivre une adresse d\'import map ou un import() à début fixe']);
  assert.deepEqual(raisonsDeTroncature({ ...AUCUN, surface: true }), ['plus de 2000000 résolutions d\'adresses de worker sous les pages d\'entrée : la surface n\'est pas complète']);
  assert.equal(raisonsDeTroncature({ fichiers: true, octets: true, listage: true, surface: true, ...PLAFONDS }).length, 4);
  assert.deepEqual(raisonsDeTroncature({ ...AUCUN, octets: true, fichiers: true }).map((r) => r.slice(0, 12)), ['plus de 2000', 'plus de 200 ']);
});

async function rapports(tronque) {
  return avecWidget({ 'index.html': page('<script>var a = 1;</script>') }, {}, async (racine) => {
    const ctx = construireContexte(racine);
    const notation = noter(await analyseStatique(ctx, { reseau: false }), new Set(['D']));
    const meta = { version: 'test', nomDepot: 'widget', commit: null, cible: null, tronque };
    return { md: genererMarkdown({ ctx, notation, meta }), html: genererHtml({ ctx, notation, meta }) };
  });
}

test('troncature : le Markdown et la page HTML disent chaque plafond atteint, et rien quand aucun ne l\'est', async () => {
  const { md, html } = await rapports({ ...AUCUN, listage: true, surface: true });
  assert.ok(md.includes('- ⚠️ Inventaire tronqué : dépôt anormalement volumineux (plus de 100000 entrées lues dans les dossiers exclus pour suivre une adresse d\'import map ou un import() à début fixe, plus de 2000000 résolutions d\'adresses de worker sous les pages d\'entrée : la surface n\'est pas complète). Ce rapport ne couvre qu\'une partie du dépôt.'), md);
  assert.match(html, /<p class="motif-verdict motif-partiel">⚠ Inventaire tronqué : dépôt anormalement volumineux \(plus de 100000 entrées lues dans les dossiers exclus pour suivre une adresse d&#39;import map ou un import\(\) à début fixe, plus de 2000000 résolutions d&#39;adresses de worker sous les pages d&#39;entrée : la surface n&#39;est pas complète\)\. Ce rapport ne couvre qu'une partie du dépôt\.<\/p>/);
  const sans = await rapports(null);
  assert.ok(!sans.md.includes('Inventaire tronqué'));
  assert.ok(!sans.html.includes('Inventaire tronqué'));
  assert.ok(!/<p[^>]*>\s*<\/p>/.test(sans.html), 'sans troncature, la page ne porte aucun paragraphe vide');
});

// D-5 : le chemin écrit autrement que le fichier ---------------------------------------------------------------------

test('chemin : cheminLocal rend le chemin que sert un serveur de fichiers (décodé, puis normalisé), et rien hors du widget', () => {
  const de = (adresse, base = null, page = '') => cheminLocal(urlDe(adresse, base, page));
  assert.equal(de('%61pp.js'), 'app.js', 'un octet encodé');
  assert.equal(de('js%2Fapp.js'), 'js/app.js', 'une barre encodée');
  assert.equal(de('a%20b.js'), 'a b.js');
  assert.equal(de('js//app.js'), 'js/app.js', 'une barre doublée');
  assert.equal(de('js///x////app.js'), 'js/x/app.js');
  assert.equal(de('js/x/..%2Fapp.js'), 'js/app.js', 'une remontée encodée');
  assert.equal(de('js/%2e%2e/app.js'), 'app.js');
  assert.equal(de('..%2F..%2Fapp.js'), 'app.js', 'une remontée qui dépasse la racine y reste');
  assert.equal(de('%2E%2E%2Fapp.js', null, 'a/b/index.html'), 'a/app.js', 'depuis un sous-dossier : le chemin de la page compte');
  assert.equal(de('libs//'), 'libs/', 'un dossier garde sa barre finale');
  assert.equal(de('./'), '', 'la racine');
  assert.equal(de('x%zz.js'), null, 'un chemin qui ne se décode pas ne désigne aucun fichier');
  assert.equal(de('https://cdn.example/app.js'), null, 'hors du widget');
  assert.equal(cheminLocal(null), null);
});

test('D : les chemins d\'une page écrits autrement mènent au fichier que le navigateur charge', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script src="%61.js"></script><script src="js//b.js"></script><script src="js/./c.js"></script><script src="js/x/../d.js"></script><script src="js/..%2Fe.js"></script><script src="f%20g.js"></script>'),
    ...modules(['a.js', 'js/b.js', 'js/c.js', 'js/d.js', 'e.js', 'f g.js', 'js/a.js', 'x/d.js']),
  }), trie(['index.html', 'a.js', 'js/b.js', 'js/c.js', 'js/d.js', 'e.js', 'f g.js']));
});

test('D : un code caché derrière un chemin écrit autrement est audité, aussi dans un dossier exclu', async () => {
  const a = await auditer({
    'index.html': page('<script src="dist//app.js"></script><script src="%64ist/autre.js"></script>'),
    'dist/app.js': EXFIL, 'dist/autre.js': EXFIL,
  });
  assert.deepEqual(a.surface, trie(['index.html', 'dist/app.js', 'dist/autre.js']));
  for (const chemin of ['dist/app.js', 'dist/autre.js']) assert.equal(a.de('C-EXFIL-01', chemin).length, 1, chemin);
});

test('D : les chemins d\'un module, d\'un worker et d\'un import() écrits autrement mènent au fichier que le navigateur charge', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="app.js"></script>'),
    'app.js': "import './%62.js';\nimport './sub//c.js';\nimport './sub/../d.js';\nimport './e%20f.js';\nnew Worker('./w%2Ejs');\nimport(`./%6cocales/${l}.js`);\nimport('./%63hunks/' + l);\n",
    ...modules(['b.js', 'sub/c.js', 'd.js', 'e f.js', 'w.js', 'locales/fr.js', 'chunks/a.js', 'sub/d.js', 'sub/%6cocales.js']),
  }), trie(['index.html', 'app.js', 'b.js', 'sub/c.js', 'd.js', 'e f.js', 'w.js', 'locales/fr.js', 'chunks/a.js']));
});

test('D : une adresse d\'import map et un préfixe écrits autrement mènent au dossier que le navigateur charge', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page(`${carte({ 'lib/': './%6cibs//', m: './%6dod//x.js' })}<script type="module">import 'lib/a.js'; import 'm';</script>`),
    ...modules(['libs/a.js', 'libs/sub/b.js', 'mod/x.js', 'autre/c.js']),
  }), trie(['index.html', 'libs/a.js', 'libs/sub/b.js', 'mod/x.js']));
});

test('D : dans le doute, le chemin écrit reste essayé : un fichier dont le nom contient vraiment « % » est atteint', async () => {
  assert.deepEqual(await surfaceDe({
    'index.html': page('<script type="module" src="app.js"></script>'),
    'app.js': "import './%62.js';\nimport './100%.js';\nimport './x%zz.js';\nimport('./%63hunks/' + l);\n",
    ...modules(['%62.js', 'b.js', '100%.js', 'x%zz.js', '%63hunks/a.js', 'chunks/b.js']),
  }), trie(['index.html', 'app.js', '%62.js', 'b.js', '100%.js', 'x%zz.js', '%63hunks/a.js', 'chunks/b.js']));
});
