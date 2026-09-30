/**
 * E-DEP-01 voit ce que le code JavaScript charge par une adresse (`import
 * 'https://…'`, `export … from`, `import()` à littéral) comme une entrée
 * d'import map : du code tiers exécuté sans empreinte est critique et bloquant,
 * avec l'empreinte de la clé `integrity` de l'import map de la page qui le charge
 * il est majeur. Avant, C-EXFIL-01 le disait (destination) et E-DEP-01 ne voyait
 * rien : la dépendance restait un angle mort de l'axe E.
 *
 * Un seul lecteur pour les deux règles (`visiteursDImports`) : ce que l'une voit,
 * l'autre le voit. Chaque garde a son mutant : `scripts/mutants-e-dep-imports.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyserDependancesDistantes } from '../src/regles/e-dependances.js';
import { analyserSortiesReseau } from '../src/regles/c-securite.js';
import { auditer, page } from './aide-surface.mjs';

const SRI = `sha384-${'A'.repeat(64)}`;
const MODULE = (code) => `<script type="module">\n${code}\n</script>`;
const CARTE = (integrity, imports = {}) => `<script type="importmap">${JSON.stringify({ imports, integrity })}</script>`;
const E = (a, chemin) => a.de('E-DEP-01', chemin);

test('un import statique de https:// sans import map est une dépendance distante : critique et bloquant, dit avec son canal', async () => {
  const a = await auditer({ 'index.html': page(MODULE("import x from 'https://esm.sh/foo@1.2.3';\nx();")) });
  const [c] = E(a);
  assert.equal(E(a).length, 1);
  assert.deepEqual([c.severite, c.bloquant, c.axe, c.fichier, c.ligne], ['critique', true, 'E', 'index.html', 2]);
  assert.match(c.titre, /depuis esm\.sh$/);
  assert.equal(c.extrait, "import x from 'https://esm.sh/foo@1.2.3';");
  assert.match(c.constat, /^Le widget charge `https:\/\/esm\.sh\/foo@1\.2\.3` par un `import` statique — aucune empreinte dans la clé `integrity` d'une import map de la page qui le charge\.$/);
  assert.match(c.remediation, /clé `integrity` d'une import map de la page/);
  assert.equal(a.de('C-EXFIL-01').length, 1, 'C-EXFIL-01 le dit toujours, de son côté');
});

test('la ligne d\'un import est celle de la page, même quand la balise <script s\'étend sur plusieurs lignes (E-DEP-01 et C-EXFIL-01)', async () => {
  const corps = "<script\n  type=\"module\"\n  data-x=\"a\"\n>\nimport x from 'https://esm.sh/foo@1.2.3';\nx();\n</script>";
  const html = page(corps);
  const attendue = html.split('\n').findIndex((l) => l.startsWith('import x from')) + 1;
  assert.equal(attendue, 5, 'la page de l\'essai : la balise tient sur quatre lignes, l\'import est sur la cinquième');
  const a = await auditer({ 'index.html': html });
  assert.deepEqual([E(a).length, E(a)[0].ligne], [1, attendue]);
  assert.deepEqual([a.de('C-EXFIL-01').length, a.de('C-EXFIL-01')[0].ligne], [1, attendue]);
});

test('la version non figée dans l\'adresse est dite aussi', async () => {
  const a = await auditer({ 'index.html': page(MODULE("import x from 'https://esm.sh/foo';")) });
  assert.match(E(a)[0].constat, /aucune empreinte dans la clé `integrity` d'une import map de la page qui le charge, version non figée dans l'URL\.$/);
});

test('l\'empreinte de l\'import map de la page, à l\'adresse du module, ramène le constat à majeur sans blocage', async () => {
  const a = await auditer({ 'index.html': page(`${CARTE({ 'https://esm.sh/foo@1.2.3': SRI })}${MODULE("import x from 'https://esm.sh/foo@1.2.3';")}`) });
  const [c] = E(a);
  assert.deepEqual([E(a).length, c.severite, c.bloquant], [1, 'majeur', false]);
  assert.doesNotMatch(c.constat, /aucune empreinte/);
});

test('une empreinte mal formée, vide ou pour une autre adresse ne protège rien : critique et bloquant', async () => {
  for (const [nom, integrity] of [
    ['vide', { 'https://esm.sh/foo@1.2.3': '' }],
    ['md5', { 'https://esm.sh/foo@1.2.3': 'md5-AAAA' }],
    ['sans empreinte', { 'https://esm.sh/foo@1.2.3': 'sha384-' }],
    ['majuscules', { 'https://esm.sh/foo@1.2.3': `SHA384-${'A'.repeat(64)}` }],
    ['autre adresse', { 'https://esm.sh/autre@1.2.3': SRI }],
    ['clé qui n\'est pas une adresse', { 'foo': SRI }],
    ['valeur qui n\'est pas une chaîne', { 'https://esm.sh/foo@1.2.3': null }],
  ]) {
    const a = await auditer({ 'index.html': page(`${CARTE(integrity)}${MODULE("import x from 'https://esm.sh/foo@1.2.3';")}`) });
    const [c] = E(a);
    assert.deepEqual([E(a).length, c.severite, c.bloquant], [1, 'critique', true], nom);
  }
});

test('la clé d\'empreinte relative est résolue comme une adresse d\'import map, depuis la base de la page', async () => {
  const src = MODULE("import x from '/lib/a.js';");
  const sous = await auditer({ 'index.html': page(`<base href="https://cdn.tiers.example/">${CARTE({ '/lib/a.js': SRI })}${src}`) });
  assert.deepEqual([E(sous).length, E(sous)[0].severite], [1, 'majeur'], 'sous une base externe, /lib/a.js mène chez le tiers, et sa clé aussi');
  const autreBase = await auditer({ 'index.html': page(`<base href="https://cdn.tiers.example/">${CARTE({ 'https://autre.example/lib/a.js': SRI })}${src}`) });
  assert.equal(E(autreBase)[0].severite, 'critique');
});

test('export … from, export * from et import() à littéral sont vus comme l\'import statique, chacun avec son canal', async () => {
  const a = await auditer({ 'index.html': page(MODULE([
    "export { a } from 'https://cdn.tiers.example/a.js';",
    "export * from 'https://cdn.tiers.example/b.js';",
    "const c = await import('https://cdn.tiers.example/c.js');",
    'const d = await import(`https://cdn.tiers.example/d.js`);',
  ].join('\n'))) });
  assert.deepEqual(E(a).map((c) => [c.ligne, c.constat.match(/par (un `[^`]+`(?: statique)?)/)[1]]), [
    [2, 'un `export … from`'], [3, 'un `export … from`'], [4, 'un `import()`'], [5, 'un `import()`'],
  ]);
  assert.ok(E(a).every((c) => c.severite === 'critique' && c.bloquant));
});

test('un module .js chargé par la page : l\'import map de la page s\'applique, le constat est dans le fichier', async () => {
  const carte = CARTE({ 'https://esm.sh/foo@1.2.3': SRI });
  const sans = await auditer({ 'index.html': page('<script type="module" src="app.js"></script>'), 'app.js': "import x from 'https://esm.sh/foo@1.2.3';\n" });
  assert.deepEqual([E(sans).length, E(sans)[0].fichier, E(sans)[0].ligne, E(sans)[0].severite], [1, 'app.js', 1, 'critique']);
  const avec = await auditer({ 'index.html': page(`${carte}<script type="module" src="app.js"></script>`), 'app.js': "import x from 'https://esm.sh/foo@1.2.3';\n" });
  assert.deepEqual([E(avec).length, E(avec)[0].severite, E(avec)[0].bloquant], [1, 'majeur', false]);
});

test('deux pages : chacune ne compte que pour les modules qu\'elle atteint', async () => {
  const manifeste = JSON.stringify({ widgets: [{ url: 'index.html' }, { url: 'autre.html' }] });
  const carte = CARTE({ 'https://esm.sh/a@1.0.0': SRI });
  const a = await auditer({
    'manifest.json': manifeste,
    'index.html': page(`${carte}<script type="module" src="a.js"></script>`),
    'autre.html': page('<script type="module" src="b.js"></script><script type="module" src="commun.js"></script>'),
    'a.js': "import 'https://esm.sh/a@1.0.0';\n",
    'b.js': "import 'https://esm.sh/b@1.0.0';\n",
    'commun.js': "import 'https://esm.sh/a@1.0.0';\n",
  });
  const parFichier = Object.fromEntries(E(a).map((c) => [c.fichier, `${c.severite}${c.bloquant ? ' bloquant' : ''}`]));
  assert.deepEqual(parFichier, {
    'a.js': 'majeur',                    // seule index.html l'atteint, et sa carte le protège
    'b.js': 'critique bloquant',         // seule autre.html l'atteint, sans carte
    'commun.js': 'critique bloquant',    // autre.html l'atteint aussi, sans carte : la garantie ne tient pas partout
  });
});

test('deux pages qui chargent le même module, chacune avec l\'empreinte : majeur ; une seule : critique', async () => {
  const manifeste = JSON.stringify({ widgets: [{ url: 'index.html' }, { url: 'autre.html' }] });
  const carte = CARTE({ 'https://esm.sh/a@1.0.0': SRI });
  const fichiers = (autre) => ({
    'manifest.json': manifeste,
    'index.html': page(`${carte}<script type="module" src="a.js"></script>`),
    'autre.html': page(`${autre}<script type="module" src="a.js"></script>`),
    'a.js': "import 'https://esm.sh/a@1.0.0';\n",
  });
  assert.equal(E(await auditer(fichiers(carte)))[0].severite, 'majeur');
  assert.equal(E(await auditer(fichiers('')))[0].severite, 'critique');
});

test('ce qui n\'est pas une adresse tierce ne donne rien : nom nu, relatif, localhost, l\'API Grist, une chaîne, un commentaire', async () => {
  const a = await auditer({ 'index.html': page(MODULE([
    "import 'foo';",
    "import './local.js';",
    "import 'http://localhost:8080/x.js';",
    "import 'http://127.0.0.1/x.js';",
    "import 'https://docs.getgrist.com/grist-plugin-api.js';",
    "const s = \"import 'https://esm.sh/chaine'\";",
    "// import 'https://esm.sh/commentaire';",
    "await import(`https://esm.sh/${nom}`);",
    'await import(nom);',
  ].join('\n'))), 'local.js': 'export {};\n' });
  assert.deepEqual(E(a).map((c) => c.ligne), []);
});

test('un script classique de la page n\'est pas un module : son import statique est une erreur de syntaxe, il ne charge rien', async () => {
  const a = await auditer({ 'index.html': page("<script>\nimport x from 'https://esm.sh/foo@1.2.3';\n</script>") });
  assert.equal(E(a).length, 0);
  const dynamique = await auditer({ 'index.html': page("<script>\nimport('https://esm.sh/foo@1.2.3');\n</script>") });
  assert.equal(E(dynamique).length, 1, 'un import() est permis partout');
});

test('un import d\'un gabarit inerte garde sa précision', async () => {
  const a = await auditer({ 'index.html': page("<template><script type=\"module\">\nimport 'https://esm.sh/foo@1.2.3';\n</script></template>") });
  assert.match(E(a)[0].constat, /Précision : dans un `<template>`/);
});

test('un import relatif sous une <base> externe mène chez le tiers : E-DEP-01 le voit comme C-EXFIL-01', async () => {
  const a = await auditer({ 'index.html': page(`<base href="https://cdn.tiers.example/x/">${MODULE("import './lib.js';")}`) });
  assert.deepEqual(E(a).map((c) => c.constat.match(/`([^`]+)`/)[1]), ['https://cdn.tiers.example/x/lib.js']);
  assert.equal(a.de('C-EXFIL-01').length, 1);
});

test('un import d\'une adresse d\'import map aussi nommée dans la carte : un constat par endroit, jamais un de plus', async () => {
  const a = await auditer({ 'index.html': page(`${CARTE({}, { foo: 'https://esm.sh/foo@1.2.3' })}${MODULE("import 'foo';\nimport 'https://esm.sh/foo@1.2.3';")}`) });
  assert.deepEqual(E(a).map((c) => c.ligne).sort(), [1, 3], 'l\'entrée de la carte, puis l\'adresse écrite dans le module ; le nom nu ne fait rien');
});

test('E-DEP-01 et C-EXFIL-01 voient les mêmes chargements de code sur toutes les formes', async () => {
  const formes = [
    "import a from 'https://x.example/1.js';",
    "import { b } from '//x.example/2.js';",
    "import 'https://x.example/3.js';",
    "export * from 'https://x.example/4.js';",
    "export * as ns from 'https://x.example/5.js';",
    "export { c } from 'https://x.example/6.js';",
    "await import('https://x.example/7.js');",
    'await import(`https://x.example/8.js`);',
    "await import('HTTPS://X.EXAMPLE/9.js');",
    "import 'https:\\/\\/x.example/10.js';",
    "import 'ftp://x.example/11.js';",
    "import 'data:text/javascript,1';",
    "import 'blob:https://x.example/12';",
    "import './13.js';",
    "await import('./14.js');",
    "export const z = 1;",
  ];
  const a = await auditer({ 'index.html': page(MODULE(formes.join('\n'))) });
  const urls = (constats) => constats.map((c) => `${c.ligne}`).sort();
  const dependances = analyserDependancesDistantes(a.ctx).filter((c) => c.regle === 'E-DEP-01');
  const sorties = analyserSortiesReseau(a.ctx).filter((c) => c.regle === 'C-EXFIL-01');
  assert.deepEqual(urls(dependances), urls(sorties));
  assert.ok(dependances.length >= 10, `les formes valides sont vues (${dependances.length})`);
});

test('le constat d\'une entrée d\'import map porte la ligne de la balise de la carte, où qu\'elle soit dans la page (et quelles que soient les lignes de la carte)', async () => {
  const carte = `<script type="importmap">\n{ "imports": {\n"a": "https://esm.sh/a@1.0.0",\n"b": "https://esm.sh/b@1.0.0" } }\n</script>`;
  for (const [avant, ligne] of [['', 1], ['\n', 2], ['\n\n\n\n\n\n\n\n\n', 10]]) {
    const a = await auditer({ 'index.html': page(`${avant}${carte}`) });
    assert.deepEqual(E(a).map((c) => c.ligne), [ligne, ligne], `${ligne - 1} ligne(s) avant la carte`);
  }
});
