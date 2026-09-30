import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lirePage } from '../src/moteur/page-html.js';
import { ouvrirHorsInventaire } from '../src/contexte/inventaire.js';
import { page, auditer, avecWidget, EXFIL, trie, PRECISION_GABARIT } from './aide-surface.mjs';

/**
 * Correctif après 2a, points B et C. Chaque test a son mutant dans
 * `scripts/mutants-surface-code.mjs` : le mutant réintroduit le défaut, le
 * test doit alors échouer.
 *
 * B : la surface suit ce que la page charge, quel que soit le dossier ; un
 *     module chargé depuis une adresse externe est du code exécuté que
 *     personne ne relit, donc un constat, jamais un silence.
 * C : ce qu'un constat affirme suit ce que le code fait (une donnée qui n'est
 *     pas une chaîne n'est pas « toujours une chaîne »), et une réserve de la
 *     page (gabarit inerte) se dit aussi sur le fichier qu'elle mène à charger.
 */

const DOSSIERS_EXCLUS = ['dist', 'build', 'vendor', 'node_modules', '.next', 'coverage', '.venv', '__pycache__'];

// B-1 : le dossier ne change pas ce qui est audité ----------------------------------------------------------

for (const dossier of DOSSIERS_EXCLUS) {
  test(`B : un script rangé dans ${dossier}/ que la page charge est dans la surface et audité par l'axe C`, async () => {
    const a = await auditer({ 'index.html': page(`<script src="${dossier}/payload.js"></script>`), [`${dossier}/payload.js`]: EXFIL });
    assert.deepEqual(a.surface, trie(['index.html', `${dossier}/payload.js`]));
    assert.equal(a.fichier(`${dossier}/payload.js`).dossierExclu, true);
    const exfil = a.de('C-EXFIL-01', `${dossier}/payload.js`);
    assert.equal(exfil.length, 1, `constats C-EXFIL-01 : ${a.constats.map((c) => c.regle)}`);
    assert.equal(exfil[0].bloquant, true);
    assert.equal(exfil[0].ligne, 1);
  });
}

test('B : ce que la page ne charge pas reste hors de l\'inventaire, même dans un dossier que la page pourrait viser', async () => {
  const a = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': 'console.log(1);\n', 'dist/payload.js': EXFIL });
  assert.deepEqual(a.surface, trie(['index.html', 'app.js']));
  assert.equal(a.fichier('dist/payload.js'), undefined, 'un fichier que rien ne charge n\'entre pas');
  assert.equal(a.de('C-EXFIL-01').length, 0);
});

test('B : une chaîne d\'imports traverse les dossiers exclus, chaque maillon est audité', async () => {
  const a = await auditer({
    'index.html': page('<script type="module" src="app.js"></script>'),
    'app.js': 'import "./dist/a.js";\n',
    'dist/a.js': 'import "../vendor/b.js";\n',
    'vendor/b.js': EXFIL,
  });
  assert.deepEqual(a.surface, trie(['index.html', 'app.js', 'dist/a.js', 'vendor/b.js']));
  assert.equal(a.de('C-EXFIL-01', 'vendor/b.js').length, 1);
});

test('B : un manifest qui désigne une page rangée dans dist/ en fait un point d\'entrée', async () => {
  const a = await auditer({
    'manifest.json': JSON.stringify([{ name: 'w', url: 'dist/index.html' }]),
    'dist/index.html': page('<script src="app.js"></script>'),
    'dist/app.js': EXFIL,
  });
  assert.ok(a.surface.includes('dist/index.html') && a.surface.includes('dist/app.js'), a.surface.join());
  assert.equal(a.de('C-EXFIL-01', 'dist/app.js').length, 1);
});

test('B : .git n\'est jamais suivi, même nommé par la page', async () => {
  const a = await auditer({ 'index.html': page('<script src=".git/x.js"></script><script type="module">import "./.git/y.js";</script>'), '.git/x.js': EXFIL, '.git/y.js': EXFIL });
  assert.deepEqual(a.surface, trie(['index.html']));
  assert.equal(a.de('C-EXFIL-01').length, 0);
});

test('B : un chemin qui sort du widget ou qui passe par `..` ne fait entrer aucun fichier', async () => {
  const a = await auditer({ 'index.html': page('<script src="dist/../../dehors/x.js"></script><script src="dist//x.js"></script>'), 'dist/x.js': 'console.log(1);\n' }, { dehors: { 'x.js': EXFIL } });
  assert.equal(a.de('C-EXFIL-01').length, 0);
  assert.ok(!a.surface.some((c) => c.includes('..')), a.surface.join());
});

test('B : un dossier exclu qui est un lien vers l\'extérieur n\'est pas suivi', async () => {
  const a = await auditer({ 'index.html': page('<script src="dist/payload.js"></script>') }, { liens: [['dist', 'cible']], dehors: { 'cible/payload.js': EXFIL } });
  assert.deepEqual(a.surface, trie(['index.html']));
  assert.equal(a.fichier('dist/payload.js'), undefined);
  assert.equal(a.de('C-EXFIL-01').length, 0);
});

test('B : un fichier de dist/ qui est un lien vers l\'extérieur n\'est pas suivi', async (t) => {
  let a;
  try {
    a = await auditer({ 'index.html': page('<script src="dist/payload.js"></script>'), 'dist/.garde': '' }, { liens: [['dist/payload.js', 'cible.js']], dehors: { 'cible.js': EXFIL } });
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip(`lien symbolique impossible ici : ${e.code}`);
    throw e;
  }
  assert.equal(a.fichier('dist/payload.js'), undefined);
  assert.equal(a.de('C-EXFIL-01').length, 0);
});

// B-2 : l'exemption du code vendorisé ne vaut que pour A et B ------------------------------------------------

/** Un contenu qui déclenche `regle` quand il se trouve dans un fichier de la surface, hors dossier exclu. */
const DECLENCHEURS = {
  'A-TAILLE-01': () => Array.from({ length: 700 }, (_, i) => `var v${i} = ${i};`).join('\n') + '\n',
  'A-DEV-03': () => Array.from({ length: 8 }, (_, i) => `// TODO: reprendre ${i}`).join('\n') + '\nvar a = 1;\n',
  'B-COM-01': () => Array.from({ length: 300 }, (_, i) => `var v${i} = ${i};`).join('\n') + '\n',
  'B-NOM-01': () => 'var a = 1; var b = 2; var c = 3; var d = 4; var e = 5; var f = 6; var g = 7; var h = 8; var i = 9; var j = 10;\n',
  'B-VERB-01': () => Array.from({ length: 4100 }, (_, i) => `var v${i} = ${i};`).join('\n') + '\n',
  'B-LANG-01': () => [
    ...Array.from({ length: 20 }, (_, i) => `// Cette fonction est pour le calcul numéro ${i} dans le tableau`),
    ...Array.from({ length: 12 }, (_, i) => `// This function will compute the value number ${i} for the table`),
    'var a = 1;',
  ].join('\n') + '\n',
  'B-IA-01': () => [
    ...Array.from({ length: 5 }, (_, i) => `// Step ${i + 1}: faire quelque chose`),
    ...Array.from({ length: 5 }, (_, i) => `// Ajout de la ligne ${i}`),
    'var a = 1;',
  ].join('\n') + '\n',
};
// A-DUP-01 compare deux fichiers : le même bloc de 10 lignes dans deux fichiers.
const BLOC_DUPLIQUE = Array.from({ length: 12 }, (_, i) => `const valeur${i} = calculer(donnees, ${i}, 'clef ${i}', options.parametre${i});`).join('\n') + '\n';

for (const [regle, contenu] of Object.entries(DECLENCHEURS)) {
  test(`B : ${regle} juge un fichier du widget et laisse en paix le même fichier rangé dans dist/`, async () => {
    const racine = await auditer({ 'index.html': page('<script src="code.js"></script>'), 'code.js': contenu() });
    assert.ok(racine.de(regle).length > 0, `${regle} doit se déclencher sur le fichier de la racine (témoin) : ${racine.constats.map((c) => c.regle).join()}`);
    const range = await auditer({ 'index.html': page('<script src="dist/code.js"></script>'), 'dist/code.js': contenu() });
    assert.equal(range.fichier('dist/code.js').executee, true);
    assert.equal(range.de(regle).length, 0, `${regle} ne juge pas ce que le widget n'a pas écrit`);
  });
}

test('B : A-DUP-01 juge la duplication entre deux fichiers du widget, pas entre deux fichiers de dist/', async () => {
  const racine = await auditer({ 'index.html': page('<script src="a.js"></script><script src="b.js"></script>'), 'a.js': BLOC_DUPLIQUE, 'b.js': BLOC_DUPLIQUE });
  assert.ok(racine.de('A-DUP-01').length > 0, 'témoin');
  const range = await auditer({ 'index.html': page('<script src="dist/a.js"></script><script src="dist/b.js"></script>'), 'dist/a.js': BLOC_DUPLIQUE, 'dist/b.js': BLOC_DUPLIQUE });
  assert.equal(range.de('A-DUP-01').length, 0);
});

test('B : les fonctions longues, complexes, imbriquées et les erreurs silencieuses d\'un fichier de dist/ ne sont pas jugées non plus', async () => {
  const fonctionComplexe = `function f(a) {\n${Array.from({ length: 40 }, (_, i) => `  if (a === ${i}) { return ${i}; }`).join('\n')}\n  try { a(); } catch (e) {}\n  return 0;\n}\n`;
  const racine = await auditer({ 'index.html': page('<script src="code.js"></script>'), 'code.js': fonctionComplexe });
  assert.ok(racine.constats.some((c) => c.axe === 'A' && /^A-(FONC|CPLX|ERR)/.test(c.regle)), `témoin : ${racine.constats.filter((c) => c.axe === 'A').map((c) => c.regle).join()}`);
  const range = await auditer({ 'index.html': page('<script src="dist/code.js"></script>'), 'dist/code.js': fonctionComplexe });
  assert.deepEqual(range.constats.filter((c) => c.fichier === 'dist/code.js' && (c.axe === 'A' || c.axe === 'B')), []);
});

test('B : le code de dist/ reste jugé par les axes C et E, comme celui de la racine', async () => {
  const a = await auditer({
    'index.html': page('<script src="dist/payload.js"></script><script src="https://cdn.tiers.example/lib.js"></script>'),
    'dist/payload.js': 'eval(location.hash.slice(1));\n' + EXFIL,
  });
  assert.equal(a.de('C-EXFIL-01', 'dist/payload.js').length, 1);
  assert.ok(a.constats.some((c) => c.axe === 'C' && c.fichier === 'dist/payload.js' && /eval/i.test(`${c.regle} ${c.titre}`)), 'eval de la fenêtre : constat C');
  assert.ok(a.de('E-DEP-01').length > 0, 'la dépendance distante');
});

// B-3 : une import map désigne du code local ----------------------------------------------------------------

test('B : une import map fait entrer dans la surface les modules locaux qu\'elle désigne (imports et scopes)', async () => {
  const a = await auditer({
    'index.html': page('<script type="importmap">{"imports":{"a":"./lib/a.js","b":"/lib/b.js"},"scopes":{"./x/":{"c":"../lib/c.js"}}}</script><script type="module">import "a";</script>'),
    'lib/a.js': EXFIL, 'lib/b.js': 'console.log(1);\n', 'lib/c.js': 'console.log(2);\n',
  });
  assert.deepEqual(a.surface, trie(['index.html', 'lib/a.js', 'lib/b.js', 'lib/c.js']));
  assert.equal(a.de('C-EXFIL-01', 'lib/a.js').length, 1);
});

test('B : un nom nu d\'une import map n\'est pas une adresse locale, et une carte d\'un gabarit se dit', async () => {
  const nu = await auditer({ 'index.html': page('<script type="importmap">{"imports":{"a":"lib.js"}}</script>'), 'lib.js': EXFIL });
  assert.deepEqual(nu.surface, trie(['index.html']), 'Chromium n\'en fait aucune URL : le fichier local du même nom n\'est jamais chargé');
  const gabarit = await auditer({ 'index.html': page('<template><script type="importmap">{"imports":{"a":"./lib.js"}}</script></template>'), 'lib.js': EXFIL });
  assert.deepEqual(gabarit.surface, trie(['index.html', 'lib.js']));
  assert.match(gabarit.de('C-EXFIL-01', 'lib.js')[0]?.constat ?? '', /Précision : dans un `<template>`/);
});

test('B : la cible locale d\'une import map sous une <base> externe n\'est pas le fichier local du même nom', async () => {
  const a = await auditer({
    'index.html': page('<script type="importmap">{"imports":{"a":"./lib.js"}}</script>', '<base href="https://cdn.tiers.example/x/">'),
    'lib.js': EXFIL,
  });
  assert.deepEqual(a.surface, trie(['index.html']));
});

// B-4 : un import de code depuis l'extérieur est un chargement -----------------------------------------------

const importsExternes = [
  ['import statique sans liaison', 'import "https://cdn.tiers.example/m.js";\n', 'import statique'],
  ['import statique nommé', 'import { x } from "https://cdn.tiers.example/m.js";\nx();\n', 'import statique'],
  ['export … from', 'export * from "https://cdn.tiers.example/m.js";\n', 'export … from'],
  ['export nommé … from', 'export { x } from "https://cdn.tiers.example/m.js";\n', 'export … from'],
  ['import() littéral', 'import("https://cdn.tiers.example/m.js");\n', 'import() distant'],
  ['adresse relative au protocole', 'import "//cdn.tiers.example/m.js";\n', 'import statique'],
  ['gabarit sans interpolation', 'import(`https://cdn.tiers.example/m.js`);\n', 'import() distant'],
];

for (const [nom, code, canal] of importsExternes) {
  test(`B : ${nom} depuis un fichier .js → C-EXFIL-01 critique bloquant, dit comme un chargement de code`, async () => {
    const a = await auditer({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': code });
    const c = a.de('C-EXFIL-01', 'app.js');
    assert.equal(c.length, 1, `constats : ${a.constats.map((x) => x.regle).join()}`);
    assert.equal(c[0].severite, 'critique');
    assert.equal(c[0].bloquant, true);
    assert.match(c[0].constat, /charge et exécute du code depuis `cdn\.tiers\.example`/);
    assert.ok(c[0].constat.includes(canal), c[0].constat);
    assert.match(c[0].remediation, /Héberger le module dans le dépôt/);
  });
}

test('B : un import de code du même hôte externe est signalé une fois par emplacement, pas une fois par nom', async () => {
  const a = await auditer({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': 'import "https://cdn.tiers.example/m.js";\nimport("https://cdn.tiers.example/m.js");\n' });
  assert.equal(a.de('C-EXFIL-01', 'app.js').length, 2, 'deux emplacements, deux constats');
});

test('B : un import statique dans un module de la page, sous une <base> externe, charge chez le tiers', async () => {
  const a = await auditer({ 'index.html': page('<script type="module">import "./bii.js";</script>', '<base href="http://cdn.tiers.example/b/">'), 'bii.js': EXFIL });
  const c = a.de('C-EXFIL-01', 'index.html');
  assert.equal(c.length, 1, `constats : ${a.constats.map((x) => `${x.regle}@${x.fichier}`).join()}`);
  assert.match(c[0].constat, /cdn\.tiers\.example/);
  assert.deepEqual(a.surface, ['index.html'], 'le fichier local du même nom n\'est pas ce que le navigateur charge');
});

test('B : un import relatif d\'un fichier .js se résout contre le fichier, jamais contre la <base> de la page', async () => {
  const a = await auditer({
    'index.html': page('<script type="module" src="app.js"></script>', '<base href="http://cdn.tiers.example/b/">'),
  });
  // `app.js` se charge chez le tiers (base externe) : rien de local n'est lu, rien n'est inventé.
  assert.deepEqual(a.surface, trie(['index.html']));
  const b = await auditer({
    'index.html': page('<script type="module" src="sous/app.js"></script>'),
    'sous/app.js': 'import "./b.js";\n',
    'sous/b.js': 'console.log(1);\n',
  });
  assert.equal(b.de('C-EXFIL-01').length, 0, 'un import local ne dit rien');
  assert.deepEqual(b.surface, trie(['index.html', 'sous/app.js', 'sous/b.js']));
});

test('B : ne disent rien — import local, nom nu, hôte Grist, script classique de la page', async () => {
  const cas = {
    'un import local': ['app.js', 'import "./b.js";\n', { 'b.js': 'console.log(1);\n' }],
    'un nom nu': ['app.js', 'import "lodash";\n', {}],
    "l'hôte de Grist": ['app.js', 'import "https://docs.getgrist.com/grist-plugin-api.js";\n', {}],
  };
  for (const [nom, [fichier, code, autres]] of Object.entries(cas)) {
    const a = await auditer({ 'index.html': page(`<script type="module" src="${fichier}"></script>`), [fichier]: code, ...autres });
    assert.equal(a.de('C-EXFIL-01').length, 0, nom);
  }
  // Un `import` statique dans un script classique est une erreur de syntaxe : rien n'est chargé.
  const classique = await auditer({ 'index.html': page('<script>import "https://cdn.tiers.example/m.js";</script>') });
  assert.equal(classique.de('C-EXFIL-01').length, 0, 'script classique');
  // Un `import()` dynamique reste permis dans un script classique.
  const dynamique = await auditer({ 'index.html': page('<script>import("https://cdn.tiers.example/m.js");</script>') });
  assert.equal(dynamique.de('C-EXFIL-01').length, 1, 'import() dans un script classique');
});

// C-1 : un worker se lit dans l'AST -------------------------------------------------------------------------

test('C : un worker écrit dans un commentaire ou dans une chaîne n\'en est pas un — le fichier qu\'il nomme n\'est ni exécuté ni audité', async () => {
  const a = await auditer({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': [
      '// new Worker("w.js") : ancienne version, retirée',
      '/* const w = new Worker(\'w.js\'); */',
      'const aide = "pour l\'ouvrir : new Worker(\'w.js\')";',
      'const autre = `importScripts("w.js")`;',
      'console.log(aide, autre);',
      '',
    ].join('\n'),
    'w.js': EXFIL,
  });
  assert.equal(a.fichier('w.js').executee, false, 'le fichier n\'est pas atteint');
  assert.deepEqual(a.surface, trie(['index.html', 'app.js']));
  assert.equal(a.de('C-EXFIL-01', 'w.js').length, 0, 'aucun faux constat sur un fichier que rien ne charge');
});

const formesDeWorker = [
  ['guillemets simples', "new Worker('w.js');"],
  ['guillemets doubles', 'new Worker("w.js");'],
  ['gabarit sans interpolation', 'new Worker(`w.js`);'],
  ['SharedWorker', "new SharedWorker('w.js');"],
  ['window.Worker', "new window.Worker('w.js');"],
  ['self.Worker', "new self.Worker('w.js');"],
  ['globalThis.SharedWorker', "new globalThis.SharedWorker('w.js');"],
  ['new URL(…, import.meta.url)', "new Worker(new URL('w.js', import.meta.url));"],
  ['new window.URL(…)', "new Worker(new window.URL('w.js', location.href));"],
  ['avec des options', "new Worker('w.js', { type: 'module' });"],
];

for (const [nom, code] of formesDeWorker) {
  test(`C : un worker écrit en toutes lettres (${nom}) fait entrer son fichier dans la surface`, async () => {
    const a = await auditer({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': `${code}\n`, 'w.js': EXFIL });
    assert.deepEqual(a.surface, trie(['index.html', 'app.js', 'w.js']));
    assert.equal(a.de('C-EXFIL-01', 'w.js').length, 1);
  });
}

test('C : importScripts() suit tous ses arguments, et un worker calculé ou d\'une autre bibliothèque ne suit rien', async () => {
  const a = await auditer({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': "new Worker('w.js');\n",
    'w.js': "importScripts('a.js', './b.js', 'https://cdn.tiers.example/c.js');\n",
    'a.js': 'var a = 1;\n', 'b.js': 'var b = 2;\n',
  });
  assert.deepEqual(a.surface, trie(['index.html', 'app.js', 'w.js', 'a.js', 'b.js']));
  const b = await auditer({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': "const nom = 'w.js';\nnew Worker(nom);\nnew Worker('w' + '.js');\nnew lib.Worker('w.js');\nlib.Worker('w.js');\n",
    'w.js': EXFIL,
  });
  assert.equal(b.fichier('w.js').executee, false, 'ni calculé, ni d\'un autre objet, ni sans new');
});

test('C : un code que l\'analyseur ne lit pas (JSX) se lit par expressions régulières : le doute inclut', async () => {
  const a = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': "const x = <div />;\nnew Worker('w.js');\n", 'w.js': EXFIL });
  assert.ok(a.fichier('w.js').executee, 'un worker dans un code illisible reste suivi');
  const b = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': "const x = <div />;\nimport './m.js';\nimport('./n.js');\n", 'm.js': 'var m = 1;\n', 'n.js': 'var n = 1;\n' });
  assert.deepEqual(b.surface, trie(['index.html', 'app.js', 'm.js', 'n.js']));
});

// C-2 : la réserve de la page se dit aussi sur le fichier qu'elle mène à charger ------------------------------


test('C : un fichier que seul un <template> charge porte la précision du gabarit, ceux qu\'il importe aussi', async () => {
  const a = await auditer({
    'index.html': page('<template><script type="module" src="app.js"></script></template>'),
    'app.js': `import "./b.js";\n${EXFIL}`,
    'b.js': EXFIL,
  });
  assert.match(a.de('C-EXFIL-01', 'app.js')[0]?.constat ?? '', PRECISION_GABARIT, 'app.js, chargé par le gabarit');
  assert.match(a.de('C-EXFIL-01', 'b.js')[0]?.constat ?? '', PRECISION_GABARIT, 'b.js, importé par app.js');
});

test('C : un fichier aussi chargé hors gabarit ne porte aucune précision : il s\'exécute tout de suite', async () => {
  const a = await auditer({
    'index.html': page('<template><script src="app.js"></script></template><script src="app.js"></script>'),
    'app.js': EXFIL,
  });
  const c = a.de('C-EXFIL-01', 'app.js');
  assert.equal(c.length, 1);
  assert.doesNotMatch(c[0].constat, /Précision/);
});

test('C : un module que seul le standard HTML exécute porte la précision, même dans un fichier .js', async () => {
  const a = await auditer({ 'index.html': page('<script type=" module " src="app.js"></script>'), 'app.js': EXFIL });
  const c = a.de('C-EXFIL-01', 'app.js');
  assert.equal(c.length, 1, `constats : ${a.constats.map((x) => `${x.regle}@${x.fichier}`).join()}`);
  assert.match(c[0].constat, /Précision : Chromium ne l'exécute pas, un navigateur qui suit le standard HTML si/);
});

// C-3 : C-XSS-04 suit le type de ce qu'on lui passe -------------------------------------------------------------

const xss04 = async (code) => (await auditer({ 'index.html': page(`<script>${code}</script>`) })).de('C-XSS-04');

for (const code of [
  'setTimeout(location.reload, 0);',
  'setTimeout(location.assign, 0);',
  'setTimeout(window.location.replace, 0);',
  'setInterval(self.location.toString, 500);',
  'setTimeout(location.hash.length);',
  'setTimeout(window.location.href.length, 0);',
]) {
  test(`C : ${code} passe une fonction ou un nombre, jamais une chaîne : aucun constat`, async () => {
    assert.deepEqual(await xss04(code), []);
  });
}

for (const code of ['setTimeout(location.hash, 0);', 'setTimeout(window.location.href, 0);', 'setInterval(location.search, 9);']) {
  test(`C : ${code} passe une chaîne que n'importe quel lien fixe : critique bloquant, dit « toujours une chaîne »`, async () => {
    const c = await xss04(code);
    assert.equal(c.length, 1);
    assert.equal(c[0].severite, 'critique');
    assert.equal(c[0].bloquant, true);
    assert.match(c[0].constat, /c'est toujours une chaîne/);
  });
}

// C-4 : une CSP en balise que Chromium n'applique pas n'est pas une CSP -------------------------------------------

const csp = async (meta, entete = '') => auditer({ 'index.html': `<!doctype html><html lang="fr"><head><title>t</title>${entete}${meta}</head><body><script>var a = 1;</script></body></html>` });

for (const [nom, meta, raison] of [
  ['sans attribut content', '<meta http-equiv="Content-Security-Policy">', /elle n'a pas d'attribut `content`/],
  ['avec un content vide', '<meta http-equiv="Content-Security-Policy" content="">', /son attribut `content` ne déclare aucune directive/],
  ['avec un content d\'espaces', '<meta http-equiv="Content-Security-Policy" content="   ">', /ne déclare aucune directive/],
  ['avec un content réduit à des points-virgules', '<meta http-equiv="Content-Security-Policy" content=" ; ;">', /ne déclare aucune directive/],
]) {
  test(`C : une balise CSP ${nom} ne compte pas : C-CSP-01, avec la raison`, async () => {
    const a = await csp(meta);
    const c = a.de('C-CSP-01');
    assert.equal(c.length, 1);
    assert.match(c[0].constat, raison);
    assert.deepEqual(a.de('C-CSP-02'), [], 'aucune politique permissive à juger là où il n\'y en a pas');
  });
}

test('C : une CSP déclarée ne donne pas C-CSP-01, une balise inerte devant elle non plus', async () => {
  assert.deepEqual((await csp('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">')).de('C-CSP-01'), []);
  assert.deepEqual((await csp('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">', '<meta http-equiv="Content-Security-Policy" content="">')).de('C-CSP-01'), []);
});

test('C : une CSP dans un <template> ou après </head> ne compte pas, et dit pourquoi', async () => {
  const gabarit = await csp('<template><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></template>');
  assert.match(gabarit.de('C-CSP-01')[0]?.constat ?? '', /elle est dans un `<template>`/);
  const corps = await auditer({ 'index.html': '<!doctype html><html lang="fr"><head><title>t</title></head><body><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><script>var a = 1;</script></body></html>' });
  assert.match(corps.de('C-CSP-01')[0]?.constat ?? '', /n'est plus dans `<head>`/);
});

test('C : une CSP permissive reste jugée par C-CSP-02', async () => {
  assert.equal((await csp('<meta http-equiv="Content-Security-Policy" content="default-src *">')).de('C-CSP-02').length, 1);
});

// Compléments : ce que les gardes d'ouverture et la lecture des références doivent tenir ---------------------------------

test('B : un chemin qui remonte hors du widget par un dossier exclu ne fait entrer aucun fichier du poste', async () => {
  const a = await auditer(
    { 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': 'import "../dehors/dist/x.js";\nimport "./dist/../../dehors/dist/x.js";\n' },
    { dehors: { 'dist/x.js': EXFIL } },
  );
  assert.deepEqual(a.surface, trie(['index.html', 'app.js']));
  assert.equal(a.de('C-EXFIL-01').length, 0);
  assert.ok(a.ctx.fichiers.every((f) => !f.chemin.startsWith('..')), a.ctx.fichiers.map((f) => f.chemin).join());
});

test('B : un chemin non normalisé (segment vide) désigne le fichier que sert le serveur, enregistré sous son seul nom', async () => {
  const a = await auditer({ 'index.html': page('<script src="dist//x.js"></script><script src="dist/./x.js"></script>'), 'dist/x.js': EXFIL });
  assert.equal(a.fichier('dist/x.js')?.executee, true);
  assert.deepEqual(a.ctx.fichiers.map((f) => f.chemin).sort(), ['dist/x.js', 'index.html'], 'aucun fichier sous un chemin à segment vide');
  assert.equal(a.de('C-EXFIL-01', 'dist/x.js').length, 1);
});

test('B : ouvrirHorsInventaire n\'ouvre qu\'un chemin sous sa forme normale, dans un dossier exclu, sans lien', async () => {
  await avecWidget({ 'index.html': page(''), 'dist/x.js': EXFIL, 'dist/sub/y.js': EXFIL, 'src/z.js': EXFIL }, {}, (racine) => {
    const ouvre = (chemin) => {
      const fichiers = [];
      const etat = { octetsLus: 0, tronqueFichiers: false, tronqueOctets: false, tronqueListage: false, exclus: [] };
      const f = ouvrirHorsInventaire(racine, chemin, fichiers, new Map(), etat);
      return f ? [f.chemin, f.dossierExclu, fichiers.length] : null;
    };
    assert.deepEqual(ouvre('dist/x.js'), ['dist/x.js', true, 1]);
    assert.deepEqual(ouvre('dist/sub/y.js'), ['dist/sub/y.js', true, 1]);
    assert.equal(ouvre('dist//x.js'), null, 'un segment vide');
    assert.equal(ouvre('dist/./x.js'), null, 'un segment « . »');
    assert.equal(ouvre('dist/sub/../x.js'), null, 'un segment « .. »');
    assert.equal(ouvre('../widget/dist/x.js'), null, 'un chemin qui sort du dépôt');
    assert.equal(ouvre('src/z.js'), null, 'hors d\'un dossier exclu : l\'inventaire l\'a déjà');
    assert.equal(ouvre('dist/'), null, 'un dossier n\'est pas un fichier');
    assert.equal(ouvre('dist/absent.js'), null);
  });
});

test('B : un dossier nommé comme un script n\'est pas un fichier', async () => {
  const a = await auditer({ 'index.html': page('<script src="dist/dir.js"></script>'), 'dist/dir.js/dedans.js': EXFIL });
  assert.equal(a.fichier('dist/dir.js'), undefined);
  assert.equal(a.de('C-EXFIL-01').length, 0);
});

test('B : un fichier de dist/ atteint par plusieurs chemins n\'entre qu\'une fois dans l\'inventaire', async () => {
  const a = await auditer({
    'index.html': page('<script type="module" src="a.js"></script><script type="module" src="b.js"></script><script src="dist/x.js"></script>'),
    'a.js': 'import "./dist/x.js";\n', 'b.js': 'import "./dist/x.js";\n', 'dist/x.js': EXFIL,
  });
  assert.equal(a.ctx.fichiers.filter((f) => f.chemin === 'dist/x.js').length, 1);
  assert.equal(a.de('C-EXFIL-01', 'dist/x.js').length, 1, 'un seul constat, pas un par entrée');
});

test('B : node_modules/ est du code tiers recopié (E-DEP-02), dist/ n\'en est pas', async () => {
  const nm = await auditer({ 'index.html': page('<script src="node_modules/paquet/index.js"></script>'), 'node_modules/paquet/index.js': 'var a = 1;\n' });
  assert.equal(nm.fichier('node_modules/paquet/index.js').vendorise, true);
  assert.equal(nm.de('E-DEP-02', 'node_modules/paquet/index.js').length, 1);
  const dist = await auditer({ 'index.html': page('<script src="dist/app.js"></script>'), 'dist/app.js': 'var a = 1;\n' });
  assert.equal(dist.fichier('dist/app.js').vendorise, false);
  assert.equal(dist.de('E-DEP-02').length, 0);
});

test('C : une feuille que seul un <template> charge porte la précision du gabarit sur ce qu\'elle fait charger', async () => {
  const css = '@import url(https://evil.example/x.css);\nbody { background: url(https://evil.example/p.png); }\n';
  const a = await auditer({ 'index.html': page('<template><link rel="stylesheet" href="a.css"></template>'), 'a.css': css });
  const c = a.de('C-EXFIL-03', 'a.css');
  assert.equal(c.length, 2, `constats : ${a.constats.map((x) => `${x.regle}@${x.fichier}`).join()}`);
  for (const x of c) assert.match(x.constat, /Précision : dans un `<template>` : ne se charge et ne s'active qu'une fois le gabarit cloné puis inséré/);
  const dehors = await auditer({ 'index.html': page('<template><link rel="stylesheet" href="a.css"></template><link rel="stylesheet" href="a.css">'), 'a.css': css });
  for (const x of dehors.de('C-EXFIL-03', 'a.css')) assert.doesNotMatch(x.constat, /Précision/);
});

test('C : un module que la page charge par une import map de <template> ne se dit pas en exécution immédiate', async () => {
  const a = await auditer({
    'index.html': page('<template><script type="importmap">{"imports":{"m":"./m.js"}}</script></template><script type="module">import "m";</script>'),
    'm.js': EXFIL,
  });
  assert.match(a.de('C-EXFIL-01', 'm.js')[0]?.constat ?? '', PRECISION_GABARIT);
});

test('C : une liaison qui reçoit une fonction de location n\'est pas une donnée de la page, une liaison qui reçoit une chaîne de location en est une', async () => {
  const fonction = await auditer({ 'index.html': page('<script>let f = location.reload; setTimeout(f, 0);</script>') });
  assert.deepEqual(fonction.de('C-XSS-04').filter((c) => c.severite === 'critique' || c.bloquant), [], 'une fonction ne se compile pas');
  const chaine = await auditer({ 'index.html': page('<script>let g = location.hash; setTimeout(g, 0);</script>') });
  const c = chaine.de('C-XSS-04').filter((x) => x.severite === 'critique');
  assert.equal(c.length, 1);
  assert.equal(c[0].bloquant, true);
});

test('B : un nom nu n\'est pas une adresse : le fichier local du même nom n\'est jamais chargé à sa place (page et fichier)', async () => {
  const enPage = await auditer({ 'index.html': page('<script type="module">import "m"; import("n");</script>'), 'm.js': EXFIL, 'n.js': EXFIL });
  assert.deepEqual(enPage.surface, ['index.html']);
  const enFichier = await auditer({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': 'import "m";\nimport { x } from "n";\nexport * from "o";\nimport("p");\n', 'm.js': EXFIL, 'n.js': EXFIL, 'o.js': EXFIL, 'p.js': EXFIL });
  assert.deepEqual(enFichier.surface, trie(['index.html', 'app.js']));
});

test('B : une adresse qui commence par « / » part de la racine du widget, y compris depuis un fichier d\'un sous-dossier', async () => {
  const a = await auditer({
    'index.html': page('<script type="module" src="sous/app.js"></script>'),
    'sous/app.js': 'import "/lib/x.js";\nimport "./y.js";\n', 'lib/x.js': EXFIL, 'sous/y.js': 'var y = 1;\n', 'sous/lib/x.js': 'var faux = 1;\n',
  });
  assert.deepEqual(a.surface, trie(['index.html', 'sous/app.js', 'lib/x.js', 'sous/y.js']));
  assert.equal(a.de('C-EXFIL-01', 'lib/x.js').length, 1);
});

test('C : une balise CSP inerte devant une CSP permissive ne masque pas C-CSP-02', async () => {
  const a = await csp('<meta http-equiv="Content-Security-Policy" content="default-src *">', '<meta http-equiv="Content-Security-Policy" content="">');
  assert.equal(a.de('C-CSP-01').length, 0);
  assert.equal(a.de('C-CSP-02').length, 1);
});

test('C : dans un code que l\'analyseur ne lit pas, tous les chargements de code restent suivis (le doute inclut)', async () => {
  const a = await auditer({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': [
      'const x = <div />;',
      "import { a } from './o.js';",
      "new Worker(new URL('w2.js', import.meta.url));",
      "new SharedWorker(`w3.js`);",
      "importScripts('i1.js', \"i2.js\");",
      '',
    ].join('\n'),
    'o.js': 'var o = 1;\n', 'w2.js': 'var w = 1;\n', 'w3.js': 'var w = 1;\n', 'i1.js': 'var i = 1;\n', 'i2.js': 'var i = 1;\n',
  });
  assert.deepEqual(a.surface, trie(['index.html', 'app.js', 'o.js', 'w2.js', 'w3.js', 'i1.js', 'i2.js']));
});

test('C : self.importScripts() est suivi comme importScripts() nu', async () => {
  const a = await auditer({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': "new Worker('w.js');\n",
    'w.js': "self.importScripts('a.js');\n",
    'a.js': EXFIL,
  });
  assert.deepEqual(a.surface, trie(['index.html', 'app.js', 'w.js', 'a.js']));
});

for (const propriete of ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
  test(`C : location.${propriete} est une chaîne que n'importe quel lien fixe, sa longueur un nombre`, async () => {
    const chaine = await xss04(`setTimeout(location.${propriete}, 0);`);
    assert.equal(chaine.filter((c) => c.severite === 'critique' && c.bloquant).length, 1, 'la chaîne : critique bloquant');
    assert.deepEqual(await xss04(`setTimeout(location.${propriete}.length, 0);`), [], 'la longueur : rien');
  });
}

test('B : le CSS d\'un <style> de <template> qui importe une feuille locale la rend au gabarit', async () => {
  const a = await auditer({
    'index.html': page('<template><style>@import "a.css";</style></template>'),
    'a.css': 'body { background: url(https://evil.example/p.png); }\n',
  });
  assert.deepEqual(a.surface, trie(['index.html', 'a.css']));
  assert.match(a.de('C-EXFIL-03', 'a.css')[0]?.constat ?? '', /Précision : dans un `<template>`/);
});

test('B : sous une <base> externe, un nom nu d\'un module de la page n\'est pas résolu contre la base', async () => {
  const a = await auditer({ 'index.html': page('<script type="module">import "lodash"; import("chart");</script>', '<base href="https://cdn.tiers.example/b/">') });
  assert.deepEqual(a.de('C-EXFIL-01'), [], 'un nom nu n\'est pas une adresse : aucun chargement chez le tiers');
});

test('B : une import map que seul le standard applique fait charger ses modules locaux, et le dit', async () => {
  const a = await auditer({ 'index.html': page('<script type=" importmap ">{"imports":{"m":"./m.js"}}</script>'), 'm.js': EXFIL });
  assert.deepEqual(a.surface, trie(['index.html', 'm.js']));
  assert.match(a.de('C-EXFIL-01', 'm.js')[0]?.constat ?? '', /Précision : Chromium ne l'exécute pas, un navigateur qui suit le standard HTML si/);
});

test('C : une CSP permissive que Chromium n\'applique pas (dans un <template>, après </head>) n\'est pas jugée par C-CSP-02', async () => {
  const permissive = '<meta http-equiv="Content-Security-Policy" content="default-src *">';
  assert.deepEqual((await csp(`<template>${permissive}</template>`)).de('C-CSP-02'), []);
  const corps = await auditer({ 'index.html': `<!doctype html><html lang="fr"><head><title>t</title></head><body>${permissive}<script>var a = 1;</script></body></html>` });
  assert.deepEqual(corps.de('C-CSP-02'), []);
});

test('C : un module écrit dans la page porte ses réserves (gabarit, standard seul) aux fichiers qu\'il importe', async () => {
  const gabarit = await auditer({ 'index.html': page('<template><script type="module">import "./m.js";</script></template>'), 'm.js': EXFIL });
  assert.match(gabarit.de('C-EXFIL-01', 'm.js')[0]?.constat ?? '', PRECISION_GABARIT);
  const standard = await auditer({ 'index.html': page('<script type=" module ">import "./m.js";</script>'), 'm.js': EXFIL });
  assert.match(standard.de('C-EXFIL-01', 'm.js')[0]?.constat ?? '', /Précision : Chromium ne l'exécute pas, un navigateur qui suit le standard HTML si/);
  const direct = await auditer({ 'index.html': page('<script type="module">import "./m.js";</script>'), 'm.js': EXFIL });
  assert.doesNotMatch(direct.de('C-EXFIL-01', 'm.js')[0]?.constat ?? '', /Précision/);
});

test('C : un fichier qu\'un nom désigne par une clé de préfixe de la carte d\'import (extension qui n\'est pas du JavaScript) porte les réserves de la carte et du script qui l\'importent', async () => {
  const STANDARD = /Précision : Chromium ne l'exécute pas, un navigateur qui suit le standard HTML si/;
  const carte = '<script type="importmap">{"imports":{"lib/":"./libs/"}}</script>';
  const importe = '<script type="module">import "lib/x.txt";</script>';
  const constatSur = async (corps) => (await auditer({ 'index.html': page(corps), 'libs/x.txt': EXFIL })).de('C-EXFIL-01', 'libs/x.txt')[0]?.constat ?? '';
  assert.match(await constatSur(`${carte}<template>${importe}</template>`), PRECISION_GABARIT, 'le script qui importe est dans un gabarit');
  assert.match(await constatSur(`${carte}${importe.replace('type="module"', 'type=" module "')}`), STANDARD, 'le script qui importe ne s\'exécute que sous le standard');
  assert.match(await constatSur(`<template>${carte}</template>${importe}`), PRECISION_GABARIT, 'la carte est dans un gabarit');
  assert.match(await constatSur(`${carte.replace('type="importmap"', 'type=" importmap "')}${importe}`), STANDARD, 'la carte ne s\'applique que sous le standard');
  const direct = await constatSur(`${carte}${importe}`);
  assert.notEqual(direct, '', 'le fichier est lu comme du code : il a son constat');
  assert.doesNotMatch(direct, /Précision/, 'la carte et le script s\'appliquent tout de suite : aucune réserve');
});

test('C : dansTete est faux dans un <template>, même placé dans <head> : une CSP de gabarit n\'agit jamais', () => {
  const { balises } = lirePage('<!doctype html><html><head><title>t</title><template><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></template></head><body></body></html>');
  assert.equal(balises.length, 1);
  assert.equal(balises[0].dansTemplate, true);
  assert.equal(balises[0].dansTete, false);
});
