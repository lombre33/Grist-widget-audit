/**
 * E-DEP-01 sur les imports : de quelle empreinte un module dépend. Chromium 141
 * n'applique la clé `integrity` d'une import map qu'aux contextes de document,
 * jamais à un worker (Worker, SharedWorker, service worker, worklet, ni ce qu'il
 * importe), et chaque document a ses propres cartes : un `<iframe>` ouvre un
 * autre document. Le différentiel `e-dep-imports-chromium.test.mjs` fait dire
 * ces faits au navigateur ; ici la règle et la fermeture qui la sert, cas par cas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extraireImportMaps, adressesProtegeesParEmpreinte } from '../src/moteur/analyse-js.js';
import { calculerSurface } from '../src/contexte/inventaire.js';
import { auditer, page } from './aide-surface.mjs';

const U = 'https://esm.sh/foo@1.2.3';
const SRI = `sha384-${'A'.repeat(64)}`;
const MOD = (code) => `<script type="module">\n${code}\n</script>`;
const CARTE = (integrity = { [U]: SRI }) => `<script type="importmap">${JSON.stringify({ integrity })}</script>`;
const E = (a) => a.de('E-DEP-01');
const verdict = (a) => E(a).map((c) => `${c.fichier}:${c.ligne} ${c.severite}${c.bloquant ? ' bloquant' : ''}`);
const RAISON_WORKER = /exécuté par un worker, où Chromium n'applique pas l'import map de la page/;

test('un fichier que la page exécute dans un worker n\'hérite pas de l\'empreinte de la page : critique et bloquant, avec la raison', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}${MOD("new Worker('w.js', { type: 'module' });")}`),
    'w.js': `import '${U}';\n`,
  });
  assert.deepEqual(verdict(a), ['w.js:1 critique bloquant']);
  assert.match(E(a)[0].constat, RAISON_WORKER);
  assert.doesNotMatch(E(a)[0].constat, /aucune empreinte/, 'la page porte l\'empreinte : ce n\'est pas ce qui manque');
});

test('SharedWorker, service worker et worklet sont des workers : leurs fichiers ne sont pas protégés non plus', async () => {
  for (const [creation, fichier] of [
    ["new SharedWorker('w.js', { type: 'module' });", 'w.js'],
    ["navigator.serviceWorker.register('sw.js', { type: 'module' });", 'sw.js'],
    ["new AudioContext().audioWorklet.addModule('m.js');", 'm.js'],
    ["new Worker('w.js');", 'w.js'],
    ["self.Worker && new self.Worker('./w.js');", 'w.js'],
  ]) {
    const a = await auditer({ 'index.html': page(`${CARTE()}${MOD(creation)}`), [fichier]: `import '${U}';\n` });
    assert.deepEqual(verdict(a), [`${fichier}:1 critique bloquant`], creation);
    assert.match(E(a)[0].constat, RAISON_WORKER, creation);
  }
});

test('ce qu\'un worker importe est dans le worker, à n\'importe quelle profondeur', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}${MOD("new Worker('w.js', { type: 'module' });")}`),
    'w.js': "import './b.js';\n",
    'b.js': "import './c.js';\n",
    'c.js': `import '${U}';\n`,
  });
  assert.deepEqual(verdict(a), ['c.js:1 critique bloquant']);
});

test('importScripts d\'un worker suit le worker : le script qu\'il charge est dans le worker', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}${MOD("new Worker('w.js');")}`),
    'w.js': "importScripts('classique.js');\n",
    'classique.js': `import('${U}');\n`,
  });
  assert.deepEqual(verdict(a), ['classique.js:1 critique bloquant']);
});

test('un fichier que la page charge et qu\'un worker exécute aussi n\'est pas protégé : l\'empreinte ne vaut que pour la page', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}<script type="module" src="lib.js"></script>${MOD("new Worker('lib.js', { type: 'module' });")}`),
    'lib.js': `import '${U}';\n`,
  });
  assert.deepEqual(verdict(a), ['lib.js:1 critique bloquant']);
  assert.match(E(a)[0].constat, RAISON_WORKER);
});

test('le même fichier que la page seule charge reste protégé : le worker d\'un autre fichier ne change rien', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}<script type="module" src="lib.js"></script>${MOD("new Worker('w.js');")}`),
    'lib.js': `import '${U}';\n`,
    'w.js': 'self.postMessage(1);\n',
  });
  assert.deepEqual(verdict(a), ['lib.js:1 majeur']);
});

test('la forme des empaqueteurs, new Worker(new URL(\'./w.js\', import.meta.url)), est une adresse écrite : suivie comme telle, elle ne retire rien aux autres imports', async () => {
  const sansImport = await auditer({
    'index.html': page(`${CARTE()}${MOD(`import '${U}';\nnew Worker(new URL('./w.js', import.meta.url), { type: 'module' });`)}`),
    'w.js': 'self.postMessage(1);\n',
  });
  assert.deepEqual(verdict(sansImport), ['index.html:2 majeur'], 'le worker est suivi : l\'import du module de la page reste protégé');
  const avecImport = await auditer({
    'index.html': page(`${CARTE()}${MOD("new Worker(new URL('./w.js', import.meta.url), { type: 'module' });")}`),
    'w.js': `import '${U}';\n`,
  });
  assert.deepEqual(verdict(avecImport), ['w.js:1 critique bloquant'], 'et son fichier est dans le worker');
});

test('un worker dont l\'adresse n\'est pas résolue peut exécuter n\'importe quel fichier : plus aucun import distant n\'est protégé, et le constat dit où est ce worker', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}${MOD(`import '${U}';\nconst nom = ['w', 'js'].join('.');\nnew Worker(nom, { type: 'module' });`)}`),
    'lib.js': 'export {};\n',
  });
  assert.deepEqual(verdict(a), ['index.html:2 critique bloquant']);
  assert.match(E(a)[0].constat, /le widget crée un worker dont l'adresse n'est pas résolue \(index\.html, ligne 4\) : il peut exécuter n'importe quel fichier du widget/);
  const b = await auditer({
    'index.html': page(`${CARTE()}<script type="module" src="app.js"></script>`),
    'app.js': `import '${U}';\nnavigator.serviceWorker.register(chemin);\n`,
  });
  assert.deepEqual(verdict(b), ['app.js:1 critique bloquant'], 'service worker à adresse calculée');
  const c = await auditer({
    'index.html': page(`${CARTE()}<script type="module" src="app.js"></script>`),
    'app.js': `import '${U}';\ncontext.audioWorklet.addModule(cible);\n`,
  });
  assert.deepEqual(verdict(c), ['app.js:1 critique bloquant'], 'worklet à adresse calculée');
});

test('sans empreinte pour l\'adresse, un worker non résolu ne change pas la raison : c\'est l\'empreinte qui manque', async () => {
  const a = await auditer({ 'index.html': page(MOD(`import '${U}';\nnew Worker(nom);`)) });
  assert.match(E(a)[0].constat, /aucune empreinte dans la clé `integrity` d'une import map de la page qui le charge/);
});

test('les formes de worker que l\'analyse résout ne comptent pas comme non résolues : chemin littéral, URL relative, code littéral, adresse absolue', async () => {
  for (const creation of [
    "new Worker('w.js');",
    "new Worker(`w.js`);",
    "new Worker(new URL('./w.js', import.meta.url));",
    "new Worker(new URL('./w.js', document.baseURI));",
    "new Worker(URL.createObjectURL(new Blob(['self.postMessage(1);'])));",
    "new Worker('data:text/javascript,self.postMessage(1)');",
    "new Worker('https://cdn.example/w.js');",
    "navigator.serviceWorker.register('/w.js');",
  ]) {
    const a = await auditer({
      'index.html': page(`${CARTE()}${MOD(`import '${U}';\n${creation}`)}`),
      'w.js': 'self.postMessage(1);\n',
    });
    assert.deepEqual(verdict(a), ['index.html:2 majeur'], creation);
  }
});

test('un worker dont le code littéral n\'est pas entièrement lu (Blob dont un morceau est calculé) est un worker non résolu', async () => {
  const a = await auditer({ 'index.html': page(`${CARTE()}${MOD(`import '${U}';\nnew Worker(URL.createObjectURL(new Blob([morceau, 'self.postMessage(1);'])));`)}`) });
  assert.deepEqual(verdict(a), ['index.html:2 critique bloquant']);
  assert.match(E(a)[0].constat, /adresse n'est pas résolue/);
});

test('le code d\'un Blob ou d\'un data: passé à Worker est dans le worker : ses imports ne sont pas protégés', async () => {
  const blob = await auditer({ 'index.html': page(`${CARTE()}${MOD(`new Worker(URL.createObjectURL(new Blob(['import "${U}";'], { type: 'text/javascript' })), { type: 'module' });`)}`) });
  const imports = E(blob).filter((c) => c.constat.includes(U));
  assert.equal(imports.length, 1);
  assert.deepEqual([imports[0].severite, imports[0].bloquant], ['critique', true]);
  assert.match(imports[0].constat, RAISON_WORKER);
  assert.match(imports[0].fichier, /code littéral/);
  const donnees = await auditer({ 'index.html': page(`${CARTE()}${MOD(`new Worker('data:text/javascript,${encodeURIComponent(`import "${U}";`)}', { type: 'module' });`)}`) });
  assert.deepEqual(E(donnees).filter((c) => c.constat.includes(U)).map((c) => c.severite), ['critique']);
});

test('le code littéral d\'un eval ou d\'un setTimeout s\'exécute là où l\'appel s\'exécute : dans la page, l\'empreinte s\'applique ; dans un worker, non', async () => {
  const dansLaPage = await auditer({ 'index.html': page(`${CARTE()}${MOD(`eval('import("${U}")');`)}`) });
  assert.deepEqual(E(dansLaPage).filter((c) => c.constat.includes(U)).map((c) => c.severite), ['majeur']);
  const dansUnWorker = await auditer({
    'index.html': page(`${CARTE()}${MOD("new Worker('w.js');")}`),
    'w.js': `setTimeout('import("${U}")', 0);\n`,
  });
  assert.deepEqual(E(dansUnWorker).filter((c) => c.constat.includes(U)).map((c) => c.severite), ['critique']);
});

// --- les documents : chaque page d'entrée est un document, avec ses propres cartes (un <iframe src> local en fera un aussi, quand la surface le suivra : stade 2c)

const DEUX_PAGES = JSON.stringify({ widgets: [{ url: 'index.html' }, { url: 'autre.html' }] });

test('deux pages d\'entrée sont deux documents : la carte de l\'une ne couvre pas l\'import en ligne de l\'autre', async () => {
  const a = await auditer({
    'manifest.json': DEUX_PAGES,
    'index.html': page(`${CARTE()}${MOD(`import '${U}';`)}`),
    'autre.html': page(MOD(`import '${U}';`)),
  });
  assert.deepEqual(verdict(a).sort(), ['autre.html:2 critique bloquant', 'index.html:2 majeur']);
});

test('le module .js d\'une page ne dépend que des cartes de la page qui le charge', async () => {
  const carteALautre = await auditer({
    'manifest.json': DEUX_PAGES,
    'index.html': page('<script type="module" src="lib.js"></script>'),
    'autre.html': page(`${CARTE()}<p>rien</p>`),
    'lib.js': `import '${U}';\n`,
  });
  assert.deepEqual(verdict(carteALautre), ['lib.js:1 critique bloquant'], 'lib.js est chargé par index.html, dont la carte est absente');
  const carteAlaPage = await auditer({
    'manifest.json': DEUX_PAGES,
    'index.html': page(`${CARTE()}<script type="module" src="lib.js"></script>`),
    'autre.html': page('<p>rien</p>'),
    'lib.js': `import '${U}';\n`,
  });
  assert.deepEqual(verdict(carteAlaPage), ['lib.js:1 majeur']);
});

test('un module chargé par deux documents, dont un seul porte l\'empreinte, n\'est pas protégé', async () => {
  const a = await auditer({
    'manifest.json': DEUX_PAGES,
    'index.html': page(`${CARTE()}<script type="module" src="lib.js"></script>`),
    'autre.html': page('<script type="module" src="lib.js"></script>'),
    'lib.js': `import '${U}';\n`,
  });
  assert.deepEqual(verdict(a), ['lib.js:1 critique bloquant']);
});

// --- la fermeture : graphe de document et graphe des workers

/** Une fermeture à la main : `fichiers` nom → références sortantes (voir `aretes`) résolues par `trouver`. */
function fermeture(fichiers, entrees, options) {
  const trouver = (chemin) => (chemin in fichiers ? { chemin, ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, contenu: fichiers[chemin], executee: false } : null);
  return calculerSurface(entrees, trouver, () => [], options);
}

test('surfaceDuDocument : le graphe d\'une page, sans les workers ni les autres pages ; surfaceDesWorkers : ce que les workers exécutent, avec ce qu\'ils importent', () => {
  const f = fermeture({
    'index.html': `<script type="module" src="app.js"></script><link rel="prefetch" href="fille.html">`,
    'fille.html': '<script type="module" src="autre.js"></script>',
    'app.js': "import './partage.js'; new Worker('w.js');",
    'partage.js': 'export {};',
    'w.js': "import './dans-le-worker.js'; import './partage.js';",
    'dans-le-worker.js': 'export {};',
    'autre.js': 'export {};',
  }, ['index.html']);
  assert.deepEqual([...f.surface].sort(), ['app.js', 'autre.js', 'dans-le-worker.js', 'fille.html', 'index.html', 'partage.js', 'w.js']);
  assert.deepEqual([...f.surfaceDuDocument('index.html')].sort(), ['app.js', 'fille.html', 'index.html', 'partage.js'], 'ni w.js ni ce qu\'il importe, ni autre.js (chargé par l\'autre page) ; l\'autre page elle-même y est, sans son graphe');
  assert.deepEqual([...f.surfaceDuDocument('fille.html')].sort(), ['autre.js', 'fille.html']);
  assert.deepEqual([...f.surfaceDesWorkers()].sort(), ['dans-le-worker.js', 'partage.js', 'w.js']);
});

test('surfaceDuDocument : sans worker, ni fichier ni graphe de worker ; un même appel rend le même ensemble', () => {
  const f = fermeture({ 'index.html': '<script src="app.js"></script>', 'app.js': '' }, ['index.html']);
  assert.deepEqual([...f.surfaceDesWorkers()], []);
  assert.equal(f.surfaceDuDocument('index.html'), f.surfaceDuDocument('index.html'));
});

test('surfaceDuDocument rend null quand le budget d\'arêtes partagé est épuisé, et les appels suivants aussi', () => {
  const modules = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`m${i}.js`, `import './m${i + 1}.js';`]));
  modules['m50.js'] = '';
  const f = fermeture({
    'a.html': '<script type="module" src="m0.js"></script>',
    'b.html': '<script type="module" src="m0.js"></script>',
    ...modules,
  }, ['a.html', 'b.html'], { maxPasDocuments: 150 });
  assert.notEqual(f.surfaceDuDocument('a.html'), null, 'le premier graphe tient dans le budget');
  assert.equal(f.surfaceDuDocument('b.html'), null, 'le second n\'y tient plus');
});

// --- les clés, comparées à l'adresse résolue

const cartes = (contenu, chemin = 'index.html') => extraireImportMaps(contenu, chemin).map((e) => [e.spec, e.sri]);

test('extraireImportMaps : une clé se compare à l\'adresse résolue (hôte en capitales, segment /./), pas telle qu\'elle est écrite', () => {
  const carte = (cle, valeur = U) => `<script type="importmap">${JSON.stringify({ imports: { lib: valeur }, integrity: { [cle]: SRI } })}</script>`;
  assert.deepEqual(cartes(carte(U)), [['lib', true]]);
  assert.deepEqual(cartes(carte('https://ESM.SH/foo@1.2.3')), [['lib', true]], 'hôte en capitales');
  assert.deepEqual(cartes(carte('https://esm.sh/./foo@1.2.3')), [['lib', true]], 'segment /./');
  assert.deepEqual(cartes(carte('https://esm.sh/x/../foo@1.2.3')), [['lib', true]], 'segment /../');
  assert.deepEqual(cartes(carte(U, 'https://ESM.SH/foo@1.2.3')), [['lib', true]], 'l\'adresse de l\'entrée, elle aussi résolue');
  assert.deepEqual(cartes(carte(`${U}?v=1`)), [['lib', false]], 'une requête distingue deux adresses');
  assert.deepEqual(cartes(carte('foo')), [['lib', false]], 'une clé qui n\'est pas une adresse ne protège rien');
});

test('extraireImportMaps : une clé relative se résout contre la base de la page, à l\'endroit où la carte est lue', () => {
  const carte = `<script type="importmap">${JSON.stringify({ imports: { lib: 'https://cdn.tiers.example/lib/a.js' }, integrity: { './a.js': SRI } })}</script>`;
  assert.deepEqual(cartes(carte), [['lib', false]], 'sans <base>, ./a.js est dans le widget');
  assert.deepEqual(cartes(`<base href="https://cdn.tiers.example/lib/">${carte}`), [['lib', true]], 'sous une <base> vers le tiers, elle mène chez lui');
  assert.deepEqual(cartes(`${carte}<base href="https://cdn.tiers.example/lib/">`), [['lib', false]], 'une <base> après la carte ne change pas ce que la clé désigne');
  assert.deepEqual(cartes(carte, 'sous/dossier/page.html'), [['lib', false]]);
});

test('extraireImportMaps : sha256, sha384 et sha512 protègent ; une valeur vide, mal formée ou qui n\'est pas une chaîne, non', () => {
  const avec = (valeur) => `<script type="importmap">${JSON.stringify({ imports: { lib: U }, integrity: { [U]: valeur } })}</script>`;
  for (const bonne of [`sha256-${'A'.repeat(43)}=`, `sha384-${'A'.repeat(64)}`, `sha512-${'A'.repeat(86)}==`, `md5-xx ${SRI}`]) assert.deepEqual(cartes(avec(bonne)), [['lib', true]], bonne);
  for (const mauvaise of ['', 'x', 'md5-AAAA', 'sha384-', `SHA384-${'A'.repeat(64)}`, null, 12, [SRI]]) assert.deepEqual(cartes(avec(mauvaise)), [['lib', false]], String(mauvaise));
});

test('adressesProtegeesParEmpreinte : les adresses résolues, sans les valeurs mal formées, de toutes les cartes de la page, avec le décalage de la carte qui les protège', () => {
  const premiere = CARTE({ [U]: SRI, 'https://cdn.example/b.js': 'x' });
  const contenu = `${premiere}${CARTE({ 'https://cdn.example/c.js': SRI })}`;
  assert.deepEqual([...adressesProtegeesParEmpreinte(contenu, 'index.html')].sort(), [['https://cdn.example/c.js', premiere.length], [U, 0]]);
  assert.deepEqual([...adressesProtegeesParEmpreinte('<p>rien</p>', 'index.html')], []);
  assert.deepEqual([...adressesProtegeesParEmpreinte('<script type="importmap">pas du JSON</script>', 'index.html')], []);
});
