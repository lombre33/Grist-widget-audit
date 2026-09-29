import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lirePage } from '../src/moteur/page-html.js';
import { unitesJs, extraireImportMaps, ligneDans, colonneDans } from '../src/moteur/analyse-js.js';
import { analyserRessourcesExternes, analyserHtmlDangereux, analyserSortiesReseau, preparerCodeExecuteEnChaine } from '../src/regles/c-securite.js';
import { analyserDependancesDistantes } from '../src/regles/e-dependances.js';

/**
 * Ce que les mutants indépendants de la coordination (rejeu sur 9b1ba86) ont
 * montré non gardé après l'étape 2a : chaque test protège un point qui n'avait
 * aucun garde, et a son mutant dans `scripts/mutants-survivants-2a.mjs`.
 *
 *   C03b  ce qui est local n'est jamais une ressource tierce
 *   C05g  l'`integrity` d'une iframe, image, objet, embed ou lien se dit
 *   C09   la ligne et la colonne d'un code écrit dans une page
 *   C11g  un élément HTML dans du SVG ou du MathML en sort, une balise de fin aussi
 *   C11i  ce que la passe lit dans SVG et MathML n'est pas ce qu'elle lit dans HTML
 *   C12a  l'`integrity` d'une import map ne protège que par une empreinte bien formée
 *   X14   une iframe ou un lien de gabarit le disent
 */

const fichier = (chemin, contenu) => ({ chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, taille: Buffer.byteLength(contenu, 'utf8') });
const ctxPage = (html) => ({ fichiers: [fichier('index.html', html)], entrees: ['index.html'] });
const exfil = (html) => {
  const ctx = ctxPage(html);
  return { constats: analyserRessourcesExternes(ctx).filter((c) => c.regle === 'C-EXFIL-03'), ctx };
};
const EMPREINTE = 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC';

// C03b ------------------------------------------------------------------------------------------------------------

const LOCAUX = [
  ['script relatif', '<script src="app.js"></script>'],
  ['script à la racine', '<script src="/app.js"></script>'],
  ['feuille relative', '<link rel="stylesheet" href="style.css">'],
  ['icône relative', '<link rel="icon" href="favicon.ico">'],
  ['préchargement relatif', '<link rel="preload" as="script" href="app.js">'],
  ['image relative', '<img src="a.png">'],
  ['iframe relative', '<iframe src="f.html"></iframe>'],
  ['objet relatif', '<object data="o.swf"></object>'],
  ['embed relatif', '<embed src="e.swf">'],
  ['@import relatif', '<style>@import url(a.css);</style>'],
  ['url() relatif', '<style>body { background: url(b.png); }</style>'],
  ['attribut style relatif', '<p style="background: url(b.png)">x</p>'],
  ['script de localhost', '<script src="http://localhost:8000/app.js"></script>'],
  ['image de 127.0.0.1', '<img src="http://127.0.0.1:8080/a.png">'],
  ['script de widget.local', '<script src="https://widget.local/app.js"></script>'],
  ['iframe de localhost', '<iframe src="http://localhost/f.html"></iframe>'],
];

for (const [nom, html] of LOCAUX) {
  test(`C03b : ${nom} n'est pas une ressource tierce`, () => {
    const { constats, ctx } = exfil(html);
    assert.deepEqual(constats.map((c) => c.titre), []);
    assert.equal(ctx.destinationsExternes?.size ?? 0, 0, 'aucune destination externe mémorisée');
  });
}

test('C03b : une ressource tierce, elle, est signalée (le témoin des cas précédents)', () => {
  for (const html of ['<script src="https://cdn.tiers.example/a.js"></script>', '<img src="https://cdn.tiers.example/a.png">', '<style>@import url(https://cdn.tiers.example/a.css);</style>']) {
    assert.equal(exfil(html).constats.length, 1, html);
  }
});

test('C03b : une destination qui ne se lit pas (URL invalide) n\'est pas un service externe', () => {
  const ctx = { fichiers: [fichier('app.js', 'fetch("http://[bad");\nfetch("https://[");\n')], entrees: [] };
  assert.deepEqual(analyserSortiesReseau(ctx).map((c) => c.titre), []);
});

test('C03b : les hôtes locaux ne sont pas des destinations, une IPv4 quelconque en est une', () => {
  const ctx = { fichiers: [fichier('app.js', 'fetch("http://localhost:3000/a");\nfetch("http://127.0.0.1/b");\nfetch("https://widget.local/c");\nfetch("http://192.0.2.1/d");\n')], entrees: [] };
  const c = analyserSortiesReseau(ctx);
  assert.equal(c.length, 1);
  assert.match(c[0].titre, /192\.0\.2\.1/);
});

// C05g ------------------------------------------------------------------------------------------------------------

const AVEC = /\(avec attribut `integrity`\)/;
const SANS = /sans contrôle d'intégrité \(`integrity`\)/;

const RESSOURCES_A_INTEGRITE = [
  ['iframe', (integrity) => `<iframe src="https://cdn.tiers.example/f.html"${integrity}></iframe>`],
  ['image', (integrity) => `<img src="https://cdn.tiers.example/a.png"${integrity}>`],
  ['objet', (integrity) => `<object data="https://cdn.tiers.example/o"${integrity}></object>`],
  ['embed', (integrity) => `<embed src="https://cdn.tiers.example/e"${integrity}>`],
  ['feuille de style', (integrity) => `<link rel="stylesheet" href="https://cdn.tiers.example/a.css"${integrity}>`],
  ['icône', (integrity) => `<link rel="icon" href="https://cdn.tiers.example/i.ico"${integrity}>`],
];

for (const [nom, fabriquer] of RESSOURCES_A_INTEGRITE) {
  test(`C05g : ${nom} — l'integrity se dit quand elle est bien formée, pas sinon`, () => {
    const [avec] = exfil(fabriquer(` integrity="${EMPREINTE}"`)).constats;
    assert.match(avec.constat, AVEC, 'empreinte bien formée');
    for (const mauvaise of ['', ' integrity=""', ' integrity="x"', ' integrity="md5-abc"', ' integrity="sha384-"']) {
      const [sans] = exfil(fabriquer(mauvaise)).constats;
      assert.match(sans.constat, SANS, `« ${mauvaise.trim()} » ne protège pas`);
    }
  });
}

test('C05g : un script tiers n\'est bloquant que sans empreinte bien formée', () => {
  const avec = exfil(`<script src="https://cdn.tiers.example/a.js" integrity="${EMPREINTE}"></script>`).constats[0];
  assert.equal(avec.bloquant, false);
  assert.match(avec.constat, AVEC);
  const sans = exfil('<script src="https://cdn.tiers.example/a.js" integrity="x"></script>').constats[0];
  assert.equal(sans.bloquant, true);
  assert.equal(sans.severite, 'critique');
});

// C09 -------------------------------------------------------------------------------------------------------------

/** Le nom des fichiers synthétiques que crée la lecture d'un `eval` à argument littéral dans la page. */
function litterauxDe(html) {
  const ctx = { fichiers: [fichier('index.html', html)], entrees: ['index.html'] };
  preparerCodeExecuteEnChaine(ctx);
  return ctx.fichiers.filter((f) => f.litteralImbrique).map((f) => f.chemin);
}

/** Ce que doit dire le nom : la ligne et la colonne (1-based) de `morceau` (l'appel, ou le littéral d'une liaison) dans la page réelle. */
function positionAttendue(html, morceau) {
  const debut = html.indexOf(morceau);
  const avant = html.slice(0, debut).split('\n');
  return `index.html (code littéral, ligne ${avant.length}, colonne ${avant.at(-1).length + 1})`;
}

test('C09 : un script qui commence à la ligne suivante rend la ligne et la colonne de la page', () => {
  const html = '<!doctype html>\n<html lang="fr"><head><title>t</title></head><body>\n<script>\n  var a = 1;\n    eval("1+1");\n</script>\n</body></html>';
  assert.deepEqual(litterauxDe(html), [positionAttendue(html, 'eval("1+1")')]);
  assert.equal(litterauxDe(html)[0], 'index.html (code littéral, ligne 5, colonne 5)');
});

test('C09 : un script sur la ligne de sa balise compte les caractères de la balise dans la colonne', () => {
  const html = '<!doctype html>\n<html lang="fr"><head><title>t</title></head><body><script>eval("1+1");</script></body></html>';
  assert.deepEqual(litterauxDe(html), [positionAttendue(html, 'eval("1+1")')]);
});

test('C09 : deux scripts, la position de chacun suit le sien (pas le décalage du premier)', () => {
  const html = '<!doctype html>\n<body><script>var a = 1;</script>\n<p>x</p><script>\n\n  eval("2+2");</script>\n<script>eval("3+3");</script></body>';
  assert.deepEqual(litterauxDe(html), [positionAttendue(html, 'eval("2+2")'), positionAttendue(html, 'eval("3+3")')]);
});

test('C09 : un littéral écrit dans une liaison rend la position du littéral, dans la page', () => {
  const html = '<!doctype html>\n<body><script>\n  var a = 1;\n  let code = "1+1";\n  eval(code);\n</script></body>';
  assert.deepEqual(litterauxDe(html), [positionAttendue(html, '"1+1"')]);
  assert.equal(litterauxDe(html)[0], 'index.html (code littéral, ligne 4, colonne 14)');
});

test('C09 : un appel sur plusieurs lignes est placé à sa première ligne et à sa première colonne', () => {
  const html = '<!doctype html>\n<body><script>\n  eval(\n    "1+1"\n  );\n</script></body>';
  assert.deepEqual(litterauxDe(html), [positionAttendue(html, 'eval(')]);
  assert.equal(litterauxDe(html)[0], 'index.html (code littéral, ligne 3, colonne 3)');
});

test('C09 : ligneDans et colonneDans d\'un nœud sans position rendent le début de l\'unité, ceux d\'un nœud la position de son début', () => {
  const page = { positionDe: (decalage) => ({ ligne: 7 + decalage, colonne: 3 + decalage }) };
  assert.equal(ligneDans(page, null), 7);
  assert.equal(colonneDans(page, null), 4);
  assert.equal(ligneDans(page, { start: 2, end: 9 }), 9);
  assert.equal(colonneDans(page, { start: 2, end: 9 }), 6);
  const fichierJs = { positionDe: null };
  const noeud = { loc: { start: { line: 4, column: 2 }, end: { line: 6, column: 8 } } };
  assert.equal(ligneDans(fichierJs, noeud), 4);
  assert.equal(colonneDans(fichierJs, noeud), 3);
  assert.equal(ligneDans(fichierJs, null), 0);
  assert.equal(colonneDans(fichierJs, null), 1);
});

test('C09 : la position d\'un nœud d\'un script de page (ligne et colonne 1-based) est celle du fichier', () => {
  const html = '<!doctype html>\n<body>\n<script>\n  var a = 1;\n    b();\n</script></body>';
  const [unite] = unitesJs(fichier('index.html', html));
  const decalage = unite.source.indexOf('b()');
  const { ligne, colonne } = unite.positionDe(decalage);
  assert.equal(ligne, 5);
  assert.equal(colonne, 4, 'colonne 0-based de la page : quatre espaces avant b()');
});

// C11g ------------------------------------------------------------------------------------------------------------

const scriptApres = (avant) => {
  const [s] = lirePage(`<!doctype html><body>${avant}<script src="x.js"></script></body>`).scripts;
  return `${s.ns}:${s.chargements[0].execute}`;
};

for (const [nom, avant] of [
  ['b', '<svg><b></b>'], ['div', '<svg><div></div>'], ['p', '<svg><p></p>'], ['br', '<svg><br>'], ['br auto-fermant en majuscules', '<svg><BR/>'],
  ['font avec color', '<svg><font color=red></font>'], ['font avec face', '<svg><font face=a></font>'], ['font avec size', '<svg><font size=3></font>'],
  ['un élément HTML dans MathML', '<math><p></p>'], ['une balise de fin </p>', '<svg></p>'], ['une balise de fin </br>', '<svg></br>'], ['</p> dans MathML', '<math></p>'],
]) {
  test(`C11g : ${nom} fait sortir du contenu étranger : le script qui suit est HTML et s'exécute`, () => {
    assert.equal(scriptApres(avant), 'html:true');
  });
}

for (const [nom, avant] of [
  ['font sans attribut', '<svg><font></font>'], ['font avec un autre attribut', '<svg><font id=a></font>'], ['une balise de fin </b>', '<svg></b>'], ['</div>', '<svg></div>'],
  ['un élément SVG', '<svg><g></g>'],
]) {
  test(`C11g : ${nom} ne fait pas sortir du contenu étranger : le script qui suit reste SVG et n'exécute rien`, () => {
    assert.equal(scriptApres(avant), 'svg:false');
  });
}

// C11i ------------------------------------------------------------------------------------------------------------

const lu = (html) => {
  const { scripts, ressources, balises } = lirePage(`<!doctype html><body>${html}</body>`);
  return { scripts: scripts.map((s) => s.ns), ressources: ressources.map((r) => `${r.ns}:${r.nom}`), balises: balises.map((b) => `${b.ns}:${b.nom}`) };
};

test('C11i : dans SVG, le script et le lien sont lus, ni l\'iframe, ni le lien de ressource, ni l\'objet', () => {
  assert.deepEqual(lu('<svg><script></script></svg>').scripts, ['svg']);
  assert.deepEqual(lu('<svg><a href="x" target="_blank"><text>t</text></a></svg>').balises, ['svg:a']);
  assert.deepEqual(lu('<svg><iframe src="https://x/"></iframe><link rel="stylesheet" href="https://x/a.css"><object data="https://x/o"></object></svg>'), { scripts: [], ressources: [], balises: [] });
});

test('C11i : dans MathML, seul le script est lu, pas le lien ni l\'iframe ni la feuille', () => {
  assert.deepEqual(lu('<math><script src="x.js"></script></math>').scripts, ['math']);
  assert.deepEqual(lu('<math><a href="x" target="_blank">t</a></math>').balises, []);
  assert.deepEqual(lu('<math><iframe src="https://x/"></iframe><link rel="stylesheet" href="https://x/a.css"></math>'), { scripts: [], ressources: [], balises: [] });
});

test('C11i : un embed ou une image dans SVG sortent du SVG : ce sont ceux de HTML, lus comme tels', () => {
  assert.deepEqual(lu('<svg><embed src="https://x/e"><img src="https://x/i.png"></svg>').ressources, ['html:embed', 'html:img']);
});

test('C11i : une <base> dans SVG ne change pas la base de la page', () => {
  const [s] = lirePage('<svg><base href="https://cdn.tiers/"></svg><script src="a.js"></script>').scripts;
  assert.equal(s.baseBrute, null);
});

test('C11i : une iframe, un lien et une image de HTML sont lus (le témoin)', () => {
  assert.deepEqual(lu('<iframe src="x"></iframe><link rel="stylesheet" href="a.css"><img src="i.png"><object data="o"></object><a href="x">t</a><meta charset="utf-8">').ressources, ['html:iframe', 'html:link', 'html:img', 'html:object']);
});

// C12a ------------------------------------------------------------------------------------------------------------

const carte = (json) => extraireImportMaps(`<script type="importmap">${json}</script>`);
const URL_TIERCE = 'https://cdn.tiers.example/a.js';

test('C12a : l\'entrée d\'une import map est protégée par une empreinte bien formée pour son URL, pas autrement', () => {
  const avec = (integrity) => carte(`{"imports":{"a":"${URL_TIERCE}"},"integrity":${integrity}}`)[0].sri;
  assert.equal(avec(`{"${URL_TIERCE}":"${EMPREINTE}"}`), true);
  assert.equal(avec(`{"${URL_TIERCE}":"md5-abc ${EMPREINTE}"}`), true, 'un jeton bien formé suffit, même à côté d\'un jeton invalide');
  assert.equal(avec(`{"${URL_TIERCE}":""}`), false, 'valeur vide');
  assert.equal(avec(`{"${URL_TIERCE}":"x"}`), false);
  assert.equal(avec(`{"${URL_TIERCE}":"sha384-"}`), false);
  assert.equal(avec(`{"${URL_TIERCE}":"SHA384-abc"}`), false);
  assert.equal(avec(`{"${URL_TIERCE}":null}`), false);
  assert.equal(avec(`{"${URL_TIERCE}":42}`), false);
  assert.equal(avec(`{"https://cdn.tiers.example/autre.js":"${EMPREINTE}"}`), false, 'l\'empreinte d\'une autre URL ne protège pas celle-ci');
  assert.equal(avec('{}'), false);
});

test('C12a : un integrity absent, nul, de mauvais type ou hérité ne protège ni ne plante', () => {
  assert.equal(carte(`{"imports":{"a":"${URL_TIERCE}"}}`)[0].sri, false);
  for (const integrity of ['null', '"texte"', '[]', '42', 'true']) assert.equal(carte(`{"imports":{"a":"${URL_TIERCE}"},"integrity":${integrity}}`)[0].sri, false, integrity);
  assert.equal(carte('{"imports":{"a":"constructor","b":"toString","c":"__proto__"}}').every((e) => e.sri === false), true, 'une clé de Object.prototype n\'est pas une empreinte');
});

test('C12a : une entrée d\'un scope est protégée par la même clé integrity, deux noms pour une URL ne donnent qu\'une entrée', () => {
  const entrees = carte(`{"imports":{"a":"${URL_TIERCE}","b":"${URL_TIERCE}"},"scopes":{"https://x/":{"c":"https://y.example/c.js"}},"integrity":{"https://y.example/c.js":"${EMPREINTE}"}}`);
  assert.deepEqual(entrees.map((e) => [e.url, e.sri]), [[URL_TIERCE, false], ['https://y.example/c.js', true]]);
});

test('C12a : C-EXFIL-03 et E-DEP-01 suivent l\'empreinte de l\'import map : majeur sans blocage avec, critique bloquant sans', () => {
  const page = (integrity) => `<script type="importmap">{"imports":{"a":"${URL_TIERCE}"}${integrity}}</script>`;
  const ctx = (html) => ctxPage(html);
  const bonne = page(`,"integrity":{"${URL_TIERCE}":"${EMPREINTE}"}`);
  const mauvaise = page(`,"integrity":{"${URL_TIERCE}":"x"}`);
  const c3 = (html) => analyserRessourcesExternes(ctx(html)).filter((c) => c.regle === 'C-EXFIL-03');
  const e1 = (html) => analyserDependancesDistantes(ctx(html)).filter((c) => c.regle === 'E-DEP-01');
  assert.deepEqual(c3(bonne).map((c) => [c.severite, c.bloquant]), [['majeur', false]]);
  assert.match(c3(bonne)[0].constat, /couverte par la clé `integrity` de l'import map/);
  assert.deepEqual(c3(mauvaise).map((c) => [c.severite, c.bloquant]), [['critique', true]]);
  assert.match(c3(mauvaise)[0].constat, /sans empreinte `integrity` valide dans l'import map/);
  assert.deepEqual(e1(bonne).map((c) => [c.severite, c.bloquant]), [['majeur', false]]);
  assert.deepEqual(e1(mauvaise).map((c) => [c.severite, c.bloquant]), [['critique', true]]);
});

// X14 -------------------------------------------------------------------------------------------------------------

test('X14 : une iframe et un lien d\'un <template> le disent, ceux de la page non', () => {
  const html = (dedans) => `<!doctype html><html lang="fr"><head><title>t</title></head><body>${dedans}</body></html>`;
  const corps = '<iframe src="f.html"></iframe><a href="x" target="_blank">t</a>';
  const gabarit = analyserHtmlDangereux(ctxPage(html(`<template>${corps}</template>`)));
  for (const regle of ['C-DOM-01', 'C-DOM-02']) {
    const [c] = gabarit.filter((x) => x.regle === regle);
    assert.match(c.constat, /Précision : dans un `<template>` : ne se charge et ne s'active qu'une fois le gabarit cloné puis inséré/, regle);
  }
  const page = analyserHtmlDangereux(ctxPage(html(corps)));
  for (const regle of ['C-DOM-01', 'C-DOM-02']) {
    const [c] = page.filter((x) => x.regle === regle);
    assert.doesNotMatch(c.constat, /Précision/, regle);
  }
});
