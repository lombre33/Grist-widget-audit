import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lirePage } from '../src/moteur/page-html.js';
import { unitesJs, extraireImportMaps } from '../src/moteur/analyse-js.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyserRessourcesExternes, analyserHtmlDangereux, analyserCspPermissive, preparerCodeExecuteEnChaine } from '../src/regles/c-securite.js';
import { analyserDependancesDistantes } from '../src/regles/e-dependances.js';
import { analyserAccessibiliteStatique } from '../src/regles/f-conformite.js';

/**
 * Correctif de l'étape 1 de la passe HTML : chaque test porte le numéro du
 * point du correctif et a son mutant dans `scripts/mutants-passe-html.mjs`
 * (le mutant réintroduit le défaut : le test doit alors échouer). Les cas ont
 * été exécutés dans Chromium 141 ; `passe-html-chromium.test.mjs` les rejoue.
 */

const fichier = (chemin, contenu) => ({ chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false });
const ctxPage = (html) => ({ fichiers: [fichier('index.html', html)], entrees: ['index.html'] });
const exfil = (html) => analyserRessourcesExternes(ctxPage(html)).filter((c) => c.regle === 'C-EXFIL-03');
const edep = (html) => analyserDependancesDistantes(ctxPage(html)).filter((c) => c.regle === 'E-DEP-01');
const unites = (html) => unitesJs(fichier('index.html', html));

/** Écrit un widget dans un dossier temporaire, en construit le contexte, nettoie même en cas d'échec. */
function widget(fichiers, verifier) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-'));
  try {
    for (const [nom, contenu] of Object.entries(fichiers)) {
      fs.mkdirSync(path.dirname(path.join(racine, nom)), { recursive: true });
      fs.writeFileSync(path.join(racine, nom), contenu);
    }
    return verifier(construireContexte(racine));
  } finally {
    fs.rmSync(racine, { recursive: true, force: true });
  }
}
const surface = (ctx) => ctx.fichiers.filter((f) => f.executee).map((f) => f.chemin).sort();

// Point 1 : une import map SVG s'applique (Chromium 141) ---------------------

test('point 1 : une import map SVG est lue, et ses URL tierces sont vues par C-EXFIL-03 et E-DEP-01', () => {
  const html = '<svg><script type="importmap">{"imports":{"lib":"https://cdn.tiers/lib.js"}}</script></svg>';
  assert.equal(extraireImportMaps(html).length, 1);
  assert.equal(exfil(html).length, 1, 'C-EXFIL-03');
  assert.equal(edep(html).length, 1, 'E-DEP-01');
});

// Point 2 : la <base> ---------------------------------------------------------

test('point 2 : E-DEP-01 suit une <base> externe pour un src relatif', () => {
  assert.equal(edep('<base href="https://cdn.tiers/"><script src="app.js"></script>').length, 1);
  assert.equal(edep('<script src="app.js"></script>').length, 0, 'sans base, un fichier local n\'est pas une dépendance distante');
});

test('point 2 : une URL relative d\'import map suit la <base> externe (./, ../ et /), un nom nu ne se résout jamais', () => {
  const carte = (url) => `<base href="https://cdn.tiers/x/"><script type="importmap">{"imports":{"a":"${url}"}}</script>`;
  for (const url of ['./a.js', '../a.js', '/a.js']) {
    assert.equal(exfil(carte(url)).length, 1, `C-EXFIL-03 ${url}`);
    assert.equal(edep(carte(url)).length, 1, `E-DEP-01 ${url}`);
  }
  assert.equal(exfil(carte('a.js')).length + edep(carte('a.js')).length, 0, 'un nom nu n\'est pas résolu : Chromium n\'en fait aucune URL');
});

test('point 2 : une <base> dans un <template> ou un <noscript> est inerte, une base en commentaire aussi', () => {
  for (const base of ['<template><base href="https://cdn.tiers/"></template>', '<noscript><base href="https://cdn.tiers/"></noscript>', '<!-- <base href="https://cdn.tiers/"> -->']) {
    assert.equal(exfil(`${base}<script src="app.js"></script>`).length, 0, base);
    assert.equal(edep(`${base}<script src="app.js"></script>`).length, 0, base);
  }
});

test('point 2 : sous une <base> externe le fichier local du même nom n\'est jamais lu (script et CSS de lien), l\'externe n\'entre pas dans la surface', () => {
  widget({
    'index.html': '<!doctype html><base href="https://cdn.tiers/"><script src="app.js"></script><link rel="stylesheet" href="style.css">',
    'app.js': 'fetch("https://exfil.tiers/")', 'style.css': 'body{}',
  }, (ctx) => assert.deepEqual(surface(ctx), ['index.html']));
});

test('point 2 : sous une <base> relative les références se résolvent comme Chromium, contre l\'URL de la page', () => {
  widget({
    'index.html': '<!doctype html><base href="sous/"><script src="app.js"></script>',
    'app.js': 'x()', 'sous/app.js': 'y()',
  }, (ctx) => assert.deepEqual(surface(ctx), ['index.html', 'sous/app.js']));
});

// Point 3 : un script jamais fermé n'est pas du code --------------------------

test('point 3 : un script que seule la fin du document referme, ou qu\'un <!--<script> englobe, n\'est pas une unité de code', () => {
  assert.equal(unites('<script>eval(location.hash)').length, 0, 'jamais fermé');
  assert.equal(unites('<script>a=1;/*<!--<script>*/b()</script><script>eval(x)</script>').length, 0, 'double échappement : le </script> est avalé');
  assert.equal(unites('<script>ok()</script>').length, 1, 'contrôle : un script fermé est une unité');
});

// Point 4 : types -------------------------------------------------------------

test('point 4 : type=" module " reste lu, avec la mention que Chromium ne l\'exécute pas', () => {
  const [u, ...reste] = unites('<script type=" module ">import "x"</script>');
  assert.ok(u && !reste.length);
  assert.equal(u.module, true);
  assert.match(u.mention, /Chromium ne l'exécute pas, un navigateur qui suit le standard HTML si/);
  assert.equal(unites('<script type="module">a()</script>')[0].mention, null, 'contrôle : un vrai module n\'a pas de mention');
});

test('point 4 : nomodule ou text/template avec src n\'est ni chargé ni exécuté : ni C-EXFIL-03 ni E-DEP-01', () => {
  for (const balise of ['<script nomodule src="https://cdn.tiers/x.js"></script>', '<script type="text/template" src="https://cdn.tiers/x.js"></script>']) {
    assert.equal(exfil(balise).length + edep(balise).length, 0, balise);
  }
});

test('point 4 : un nomodule local quitte la surface, et un nomodule en ligne n\'est plus une unité', () => {
  widget({ 'index.html': '<!doctype html><script nomodule src="app.js"></script>', 'app.js': 'x()' }, (ctx) => assert.deepEqual(surface(ctx), ['index.html']));
  assert.equal(unites('<script nomodule>eval(x)</script>').length, 0);
});

test('point 4 : un <svg><script src> est signalé comme chargement, jamais comme code exécuté', () => {
  const html = '<svg><script src="https://cdn.tiers/x.js"></script></svg>';
  const [c, ...reste] = exfil(html);
  assert.ok(c && !reste.length);
  assert.equal(c.bloquant, false, 'Chromium le demande sans l\'exécuter');
  assert.equal(edep(html).length, 0);
  widget({ 'index.html': '<!doctype html><svg><script src="app.js"></script></svg>', 'app.js': 'x()' }, (ctx) => assert.deepEqual(surface(ctx), ['index.html']));
});

// Point 5 : les lecteurs par expression régulière passent par la passe --------

test('point 5 : une CSP en <meta http-equiv> sans guillemets est reconnue (C-CSP-01 : aucune CSP déclarée)', () => {
  const cspAbsente = (html) => analyserHtmlDangereux(ctxPage(html)).filter((c) => c.regle === 'C-CSP-01').length;
  assert.equal(cspAbsente('<!doctype html><title>t</title><meta http-equiv=Content-Security-Policy content="default-src \'self\'"><p>x</p>'), 0);
  assert.equal(cspAbsente('<!doctype html><title>t</title><p>x</p>'), 1, 'contrôle : sans CSP, le constat existe');
  assert.equal(cspAbsente('<!doctype html><title>t</title><p>x</p><meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'), 1, 'une meta après le corps ne s\'applique pas');
});

test('point 5 : C-DOM-01 lit rel comme le navigateur : noopener sans guillemets ou noreferrer suffisent, un lien en commentaire ou en gabarit n\'est pas un constat sûr', () => {
  const dom01 = (html) => analyserHtmlDangereux(ctxPage(html)).filter((c) => c.regle === 'C-DOM-01');
  assert.equal(dom01('<a target=_blank href="x">t</a>').length, 1, 'contrôle : sans rel, le constat existe');
  assert.equal(dom01('<a target=_blank rel=noopener href="x">t</a>').length, 0);
  assert.equal(dom01('<a target="_BLANK" rel="nofollow NoReferrer" href="x">t</a>').length, 0);
  assert.equal(dom01('<!-- <a target="_blank" href="x">t</a> -->').length, 0);
  assert.match(dom01('<template><a target="_blank" href="x">t</a></template>')[0].constat, /template/, 'un lien de gabarit est signalé avec sa mention');
});

test('point 5 : C-CSP-02 ne lit que la CSP que le navigateur applique (dans <head>), pas une meta du corps', () => {
  const csp02 = (html) => analyserCspPermissive(ctxPage(html)).filter((c) => c.regle === 'C-CSP-02').length;
  const permissive = '<meta http-equiv=Content-Security-Policy content="default-src *">';
  assert.equal(csp02(`<!doctype html><title>t</title>${permissive}<p>x</p>`), 1);
  assert.equal(csp02(`<!doctype html><title>t</title><p>x</p>${permissive}`), 0, 'une meta après le corps n\'est pas appliquée');
  assert.equal(csp02('<!doctype html><title>t</title><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><p>x</p>'), 0);
});

test('point 5 : un iframe en commentaire ne produit pas de C-DOM-02, un vrai iframe sans sandbox si', () => {
  const dom02 = (html) => analyserHtmlDangereux(ctxPage(html)).filter((c) => c.regle === 'C-DOM-02').length;
  assert.equal(dom02('<!-- <iframe src="a.html"></iframe> -->'), 0);
  assert.equal(dom02('<iframe src="a.html"></iframe>'), 1);
});

test('point 5 : un worker écrit dans un gabarit text/template ou en commentaire n\'entre pas dans la surface, celui d\'un script exécuté si', () => {
  widget({ 'index.html': '<!doctype html><script type="text/template">new Worker("w.js")</script>', 'w.js': 'x()' }, (ctx) => assert.deepEqual(surface(ctx), ['index.html']));
  widget({ 'index.html': '<!doctype html><script>new Worker("w.js")</script>', 'w.js': 'x()' }, (ctx) => assert.deepEqual(surface(ctx), ['index.html', 'w.js']));
});

test('point 5 : F-RGAA-02 lit le titre comme document.title (un titre en commentaire ou en gabarit ne compte pas)', () => {
  const sansTitre = (html) => analyserAccessibiliteStatique(ctxPage(`<!doctype html><html lang="fr">${html}`)).filter((c) => c.regle === 'F-RGAA-02').length;
  assert.equal(sansTitre('<title>Widget</title>'), 0);
  assert.equal(sansTitre('<!-- <title>Widget</title> -->'), 1);
  assert.equal(sansTitre('<template><title>Widget</title></template>'), 1);
  assert.equal(sansTitre('<title> </title>'), 1);
});

// Point 6 : positions dans un script SVG décodé --------------------------------

test('point 6 : la position d\'un nœud d\'un script SVG est celle du fichier, malgré entités et CDATA', () => {
  const html = '<svg><script>x=1;\n&amp;&amp;y();\r\n<![CDATA[a]]>z()</script></svg>';
  const [s] = lirePage(html).scripts;
  const lignes = html.split(/\r\n|\n/);
  for (const [lettre, indexLigne] of [['y', 1], ['z', 2]]) {
    const { ligne, colonne } = s.positionDe(s.texte.indexOf(`${lettre}(`));
    assert.equal(ligne, indexLigne + 1, `ligne de ${lettre}`);
    assert.equal(colonne, lignes[indexLigne].indexOf(`${lettre}(`), `colonne de ${lettre}`);
  }
  // un caractère décodé se place à l'endroit de sa référence, un `]` de CDATA à son propre endroit
  const entite = '<svg><script>a=&quot;q&quot;</script></svg>';
  const [e] = lirePage(entite).scripts;
  assert.equal(e.positionDe(e.texte.indexOf('"')).colonne, entite.indexOf('&quot;'));
  const crochets = '<svg><script><![CDATA[a]]]>z()</script></svg>';
  const [c] = lirePage(crochets).scripts;
  assert.equal(c.texte, 'a]z()');
  assert.equal(c.positionDe(c.texte.indexOf(']')).colonne, crochets.indexOf(']'));
});

// Point 7 : références sans liaison lues dans l'AST -----------------------------

test('point 7 : import sans liaison, export … from et import() littéral sont suivis ; commentaire, chaîne et import() calculé ne le sont pas', () => {
  widget({
    'index.html': '<!doctype html><script type="module" src="main.js"></script>',
    'main.js': [
      "import './a.js';", "export * from './b.js';", "export { x } from './c.js';", 'import("./d.js");', 'import(`./e.js`);',
      "// import './f.js';", "const t = \"import './g.js'\";", 'import(`./${nom}.js`);',
    ].join('\n'),
    ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => [`${n}.js`, 'x()'])),
  }, (ctx) => assert.deepEqual(surface(ctx), ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'index.html', 'main.js']));
});

// Point 8 : textes de C-XSS-04 -----------------------------------------------------

const texteMinuteur = (code) => {
  const [c] = preparerCodeExecuteEnChaine({ fichiers: [fichier('app.js', code)] }).filter((x) => x.regle === 'C-XSS-04');
  assert.ok(c, code);
  return `${c.titre} | ${c.constat}`;
};

test('point 8 : setTimeout(location.hash) dit que la valeur vient de l\'adresse et est toujours une chaîne', () => {
  const t = texteMinuteur('setTimeout(location.hash, 0);');
  assert.match(t, /adresse de la page/);
  assert.match(t, /toujours une chaîne/);
  assert.doesNotMatch(t, /type n'est pas connu/);
});

test('point 8 : a + "1" est toujours une chaîne, a + b ne l\'est que si un opérande en est une', () => {
  assert.match(texteMinuteur('setTimeout(a + "1", 0);'), /le résultat est toujours une chaîne/);
  assert.match(texteMinuteur('setTimeout(a + b, 0);'), /si l'un de ses opérandes est une chaîne/);
});

// Mentions : un constat sur du code de gabarit ou de standard seul le dit -------------

test('mentions : un constat de code dans un <template> ou un module lu par le seul standard le précise', async () => {
  const constats = await widget({
    'index.html': '<!doctype html><html lang="fr"><title>t</title>\n<template><script>eval(x)</script></template>\n<script type=" module ">eval(y)</script>',
  }, (ctx) => analyseStatique(ctx, { reseau: false }));
  const evals = constats.filter((c) => c.regle === 'C-XSS-03');
  assert.equal(evals.length, 2);
  assert.match(evals.find((c) => c.extrait.includes('eval(x)')).constat, /template/);
  assert.match(evals.find((c) => c.extrait.includes('eval(y)')).constat, /standard HTML/);
});
