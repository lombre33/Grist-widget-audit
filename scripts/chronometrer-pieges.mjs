#!/usr/bin/env node
/**
 * Chronomètre l'outil sur des entrées piégées : temps et pic de mémoire d'une
 * analyse complète (inventaire, page, règles statiques) ou de la seule lecture
 * de la page. `gwaudit` tourne sur du code qu'on ne connaît pas : en V2, un
 * algorithme quadratique ou un rapport géant est un déni de service.
 *
 * Chaque cas tourne dans son propre processus (un pic de mémoire par cas, un
 * plantage ou un dépassement de délai ne masque pas les autres). Le temps ne
 * compte que l'analyse ; le pic est celui du processus entier, entrée
 * fabriquée comprise (quelques Mio). Le dossier temporaire d'un cas est celui
 * du processus parent, qui le supprime même quand l'enfant a été tué.
 *
 * Usage : node scripts/chronometrer-pieges.mjs [--racine <dossier>] [--delai <secondes>] [--liste] [sous-chaîne du nom…]
 *   --racine  racine d'une autre version de l'outil (worktree) : la même entrée, deux versions, un tableau avant/après
 *   --delai   délai par cas (120 s par défaut) : au-delà, le cas est dit « dépassé », pas « lent »
 *   --liste   nomme les cas sans rien lancer
 * Les tailles sont celles où le défaut se voyait ; un cas qui ne dit rien de plus qu'un autre se retire, un défaut
 * trouvé s'y ajoute avec l'entrée qui l'a révélé.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ICI = fileURLToPath(import.meta.url);
const RACINE_PAR_DEFAUT = path.resolve(path.dirname(ICI), '..');
const MIO = 1 << 20;
const TETE = '<!doctype html><html lang="fr"><title>t</title>';
const N = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');
const imbrique = (c, niveaux) => { for (let i = 0; i < niveaux; i++) c = `@import url("data:text/css,${encodeURIComponent(c)}");`; return c; };

/** `pages` pages d'entrée qui chargent le même `app.js` : un import distant que la carte de chaque page couvre, et `modules` modules locaux (la surface de document de chaque page a `modules` arêtes). */
function graphePartage(pages, modules) {
  const integrity = { 'https://e.example/m.js': `sha384-${'A'.repeat(64)}` };
  const fichiers = { 'app.js': `import "https://e.example/m.js";\n${N(modules, (j) => `import "./m${j}.js";\n`)}` };
  for (let j = 0; j < modules; j++) fichiers[`m${j}.js`] = 'export const x = 1;\n';
  for (let i = 0; i < pages; i++) fichiers[`p${i}/index.html`] = `${TETE}<script type="importmap">${JSON.stringify({ integrity })}</script><script type="module" src="/app.js"></script>`;
  return fichiers;
}

/** `pages` pages d'entrée, l'empreinte de `https://e.example/m.js` dans chacune, un `entree.js` commun qui importe `racines` modules, chacun important cette adresse : chaque module est chargé par chaque page. */
function pagesEtRacines(pages, racines) {
  const integrity = { 'https://e.example/m.js': `sha384-${'A'.repeat(64)}` };
  const fichiers = { 'entree.js': N(racines, (j) => `import "./r${j}.js";\n`) };
  for (let j = 0; j < racines; j++) fichiers[`r${j}.js`] = 'import "https://e.example/m.js";\n';
  for (let i = 0; i < pages; i++) fichiers[`p${i}/index.html`] = `${TETE}<script type="importmap">${JSON.stringify({ integrity })}</script><script type="module" src="/entree.js"></script>`;
  return fichiers;
}

/** `page` : lirePage(html) seule ; `analyse` : construireContexte puis analyseStatique sur les fichiers donnés. */
const CAS = [
  // --- lecture de la page (l'analyseur HTML du standard, sur des entrées qui le mettent en difficulté)
  ['page : boutons non fermés', 'page', () => '<button>'.repeat(MIO / 8)],
  ['page : boutons et icônes non fermés', 'page', () => '<button><i>'.repeat(MIO / 11)],
  ['page : div imbriqués puis </p> sans p ouvert', 'page', () => '<div>'.repeat(MIO / 10) + '</p>'.repeat(MIO / 8)],
  ['page : formatage non fermé puis </p>', 'page', () => '<b><i><u><s>'.repeat(MIO / 24) + '</p>'.repeat(MIO / 8)],
  ['page : div imbriqués puis <p>', 'page', () => '<div>'.repeat(MIO / 10) + '<p>'.repeat(MIO / 6)],
  ['page : 100 000 attributs sur un script', 'page', () => `<script ${N(100000, (i) => `a${i}=1 `)}></script>`],
  ['page : 400 000 attributs sur un script', 'page', () => `<script ${N(400000, (i) => `a${i}=1 `)}></script>`],
  ['page : 1,6 million d\'attributs sur un bouton', 'page', () => `<button ${N(MIO * 1.6, (i) => `a${i.toString(36)} `)}>`],
  ['page : img, input, label, html sans >', 'page', () => '<img <input <label <html '.repeat(MIO / 26)],
  ['page : svg et sorties vers le HTML', 'page', () => '<svg><g><div>'.repeat(MIO / 13)],
  ['page : script SVG de 200 000 entités', 'page', () => `<svg><script>${'&amp;'.repeat(200000)}a()</script></svg>`],
  ['page : 3 Mio de <script> sur une ligne', 'page', () => '<script>a</script>'.repeat(3 * MIO / 18)],
  ['page : <style> ouverts en série', 'page', () => '<style>@import url(a.css);'.repeat(MIO / 26)],
  ['page : <link> à srcset en série', 'page', () => '<link rel=preload as=image imagesrcset="a 1x, b 2x, c 3x">'.repeat(MIO / 58)],
  ['page : attributs style en série', 'page', () => '<p style="background:url(a.png)">'.repeat(MIO / 34)],
  ['page : <template><style> en série', 'page', () => '<template><style>@import url(a.css);</style>'.repeat(MIO / 45)],

  // --- analyse complète : code exécuté en chaîne, scripts, imports
  ['analyse : 20 000 scripts avec un eval chacun', 'analyse', () => ({ 'index.html': TETE + '<script>eval(x)</script>\n'.repeat(20000) })],
  ['analyse : 20 000 scripts dans un <template>', 'analyse', () => ({ 'index.html': `${TETE}<template>${'<script>eval(x)</script>\n'.repeat(20000)}</template>` })],
  ['analyse : 5 000 imports sans liaison et 5 000 workers', 'analyse', () => ({ 'index.html': `${TETE}<script type="module">${'import "./a.js";\n'.repeat(5000)}${'new Worker("w.js");\n'.repeat(5000)}</script>` })],
  ['analyse : 3 Mio de <script> sur une ligne', 'analyse', () => ({ 'index.html': TETE + '<script>a</script>'.repeat(3 * MIO / 18) })],

  // --- analyse complète : le repli par expressions régulières d'un code qu'acorn ne lit pas (la suite se termine par un point ou
  //     une parenthèse qui ne ferme jamais). Deux tailles : un temps qui quadruple quand la taille double est quadratique.
  ['analyse : 100 000 fois « a. » dans un fichier que l\'analyse ne lit pas (200 Kio)', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': 'a.'.repeat(100000) })],
  ['analyse : 200 000 fois « a. » dans un fichier que l\'analyse ne lit pas (400 Kio)', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': 'a.'.repeat(200000) })],
  ['analyse : 14 000 fois « importScripts( » sans parenthèse fermante (200 Kio)', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': 'importScripts('.repeat(14000) })],
  ['analyse : 28 000 fois « importScripts( » sans parenthèse fermante (400 Kio)', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': 'importScripts('.repeat(28000) })],

  // --- analyse complète : CSS (lecteur, conversion en constats, extraits, numéros de ligne)
  ['analyse : .css, 40 000 url() externes sur une ligne', 'analyse', () => ({ 'index.html': `${TETE}<link rel=stylesheet href=a.css>`, 'a.css': N(40000, (i) => `.a${i}{background:url(https://e.example/${i}.png)}`) })],
  ['analyse : .css, 40 000 url() externes, une par ligne', 'analyse', () => ({ 'index.html': `${TETE}<link rel=stylesheet href=a.css>`, 'a.css': N(40000, (i) => `.a${i}{background:url(https://e.example/${i}.png)}\n`) })],
  ['analyse : .css, 8 000 url() externes sur une ligne', 'analyse', () => ({ 'index.html': `${TETE}<link rel=stylesheet href=a.css>`, 'a.css': N(8000, (i) => `.a${i}{background:url(https://e.example/${i}.png)}`) })],
  ['analyse : <style>, 8 000 @import externes sur une ligne', 'analyse', () => ({ 'index.html': `${TETE}<style>${N(8000, (i) => `@import url(https://e.example/${i}.css);`)}</style>` })],
  ['analyse : <style>, 8 000 @import externes, un par ligne', 'analyse', () => ({ 'index.html': `${TETE}<style>\n${N(8000, (i) => `@import url(https://e.example/${i}.css);\n`)}</style>` })],
  ['analyse : <style>, 40 000 @import externes', 'analyse', () => ({ 'index.html': `${TETE}<style>${N(40000, (i) => `@import url(https://e.example/${i}.css);`)}</style>` })],
  ['analyse : <style>, 40 000 url() externes', 'analyse', () => ({ 'index.html': `${TETE}<style>${N(40000, (i) => `.a${i}{background:url(https://e.example/${i}.png)}`)}</style>` })],
  ['analyse : 25 000 <link rel=stylesheet> externes', 'analyse', () => ({ 'index.html': TETE + N(25000, (i) => `<link rel=stylesheet href="https://e.example/${i}.css">\n`) })],
  ['analyse : 30 000 attributs style à url() externe', 'analyse', () => ({ 'index.html': TETE + N(30000, (i) => `<div style="background:url(https://e.example/${i}.png)">x</div>`) })],
  ['analyse : 25 000 candidats externes dans imagesrcset', 'analyse', () => ({ 'index.html': `${TETE}<link rel=preload as=image imagesrcset="${N(25000, (i) => `https://e.example/${i}.png ${i + 1}w,`)}">` })],
  ['analyse : 1 Mio de url() locales (aucun constat)', 'analyse', () => ({ 'index.html': `${TETE}<style>${N(MIO / 24, (i) => `a{background:url(l${i}.png)}\n`)}</style>` })],
  ['analyse : 1 Mio de commentaires CSS ouverts', 'analyse', () => ({ 'index.html': `${TETE}<style>${'/*'.repeat(MIO / 2)}</style>` })],
  ['analyse : 1 Mio de @import url( non fermés', 'analyse', () => ({ 'index.html': `${TETE}<style>${'@import url('.repeat(MIO / 12)}</style>` })],
  ['analyse : 1 Mio de chaînes CSS non fermées', 'analyse', () => ({ 'index.html': `${TETE}<style>${'a{b:"x\n'.repeat(MIO / 7)}</style>` })],
  ['analyse : 1 Mio de virgules dans imagesrcset', 'analyse', () => ({ 'index.html': `${TETE}<link rel=preload as=image imagesrcset="${','.repeat(MIO)}x">` })],
  ['analyse : 16 niveaux de data: imbriqués', 'analyse', () => ({ 'index.html': `${TETE}<style>${imbrique('@import url(https://e.example/fond.css);', 16)}</style>` })],

  // --- analyse complète : une <base> de plus de 4 096 caractères, résolue exactement (elle ne se tronque plus) ;
  //     50 000 références relatives, une résolution chacune : le coût suivait la taille de la base
  ['analyse : 50 000 scripts sous une base de 1 Mio (requête)', 'analyse', () => ({ 'index.html': `${TETE}<base href="https://e.example/x?${'a'.repeat(MIO)}">${N(50000, (i) => `<script src="./s${i}.js"></script>\n`)}` })],
  ['analyse : 50 000 scripts sous une base de 1 Mio (chemin d\'un seul segment)', 'analyse', () => ({ 'index.html': `${TETE}<base href="https://e.example/${'a'.repeat(MIO)}/">${N(50000, (i) => `<script src="./s${i}.js"></script>\n`)}` })],
  ['analyse : 50 000 scripts sous une base de 1 Mio (500 000 segments)', 'analyse', () => ({ 'index.html': `${TETE}<base href="https://e.example/${'a/'.repeat(MIO / 2)}">${N(50000, (i) => `<script src="./s${i}.js"></script>\n`)}` })],
  ['analyse : 50 000 scripts sous une base de 1 Mio (500 000 segments), remontées ../', 'analyse', () => ({ 'index.html': `${TETE}<base href="https://e.example/${'a/'.repeat(MIO / 2)}">${N(50000, (i) => `<script src="../../s${i}.js"></script>\n`)}` })],
  ['analyse : 50 000 scripts sous une base de 1 Mio (nom d\'hôte géant)', 'analyse', () => ({ 'index.html': `${TETE}<base href="https://${'a'.repeat(MIO)}.example/">${N(50000, (i) => `<script src="./s${i}.js"></script>\n`)}` })],
  ['analyse : 50 000 liens ?q sous une base de 1 Mio (requête)', 'analyse', () => ({ 'index.html': `${TETE}<base href="https://e.example/x?${'a'.repeat(MIO)}">${N(50000, (i) => `<link rel=stylesheet href="?q${i}">\n`)}` })],
  ['analyse : 50 000 références #ancre sous une base de 1 Mio (fragment)', 'analyse', () => ({ 'index.html': `${TETE}<base href="https://e.example/x#${'a'.repeat(MIO)}">${N(50000, (i) => `<script src="#a${i}"></script>\n`)}` })],

  // --- analyse complète : ce que la page charge, quel que soit le dossier (surface de code)
  ['analyse : 20 000 imports de fichiers de node_modules', 'analyse', () => {
    const fichiers = { 'index.html': `${TETE}<script type="module">${N(20000, (i) => `import "./node_modules/p${i}/index.js";\n`)}</script>` };
    for (let i = 0; i < 20000; i++) fichiers[`node_modules/p${i}/index.js`] = 'export const x = 1;\n';
    return fichiers;
  }],
  ['analyse : 20 000 imports statiques https:// distincts', 'analyse', () => ({ 'index.html': `${TETE}<script type="module">${N(20000, (i) => `import "https://e.example/m${i}.js";\n`)}</script>` })],
  ['analyse : import map de 20 000 cibles locales', 'analyse', () => {
    const imports = {};
    for (let i = 0; i < 20000; i++) imports[`m${i}`] = `./lib/m${i}.js`;
    const fichiers = { 'index.html': `${TETE}<script type="importmap">${JSON.stringify({ imports })}</script>` };
    for (let i = 0; i < 20000; i++) fichiers[`lib/m${i}.js`] = 'export const x = 1;\n';
    return fichiers;
  }],
  ['analyse : import map de 20 000 cibles distantes sans integrity', 'analyse', () => {
    const imports = {};
    for (let i = 0; i < 20000; i++) imports[`m${i}`] = `https://e.example/m${i}.js`;
    return { 'index.html': `${TETE}<script type="importmap">${JSON.stringify({ imports })}</script>` };
  }],

  // --- analyse complète : une adresse qui vise un dossier (préfixe d'import map, import() à début fixe) et les
  //     adresses de document (Worker, serviceWorker) résolues sous chaque page d'entrée
  ['analyse : un préfixe d\'import map sur un dossier de 19 000 modules', 'analyse', () => {
    const fichiers = { 'index.html': `${TETE}<script type="importmap">${JSON.stringify({ imports: { 'lib/': './lib/' } })}</script>` };
    for (let i = 0; i < 19000; i++) fichiers[`lib/m${i}.js`] = 'export const x = 1;\n';
    return fichiers;
  }],
  ['analyse : un préfixe d\'import map sur 19 000 modules de node_modules', 'analyse', () => {
    const fichiers = { 'index.html': `${TETE}<script type="importmap">${JSON.stringify({ imports: { 'p/': './node_modules/p/' } })}</script>` };
    for (let i = 0; i < 19000; i++) fichiers[`node_modules/p/m${i}.js`] = 'export const x = 1;\n';
    return fichiers;
  }],
  ['analyse : un préfixe d\'import map sur toute la racine, 19 000 modules', 'analyse', () => {
    const fichiers = { 'index.html': `${TETE}<script type="importmap">${JSON.stringify({ imports: { 'x/': './' } })}</script>` };
    for (let i = 0; i < 19000; i++) fichiers[`lib/m${i}.js`] = 'export const x = 1;\n';
    return fichiers;
  }],
  ['analyse : 2 000 préfixes d\'import map, chacun sur son dossier', 'analyse', () => {
    const imports = {};
    const fichiers = {};
    for (let i = 0; i < 2000; i++) {
      imports[`d${i}/`] = `./lib/d${i}/`;
      for (let j = 0; j < 5; j++) fichiers[`lib/d${i}/m${j}.js`] = 'export const x = 1;\n';
    }
    fichiers['index.html'] = `${TETE}<script type="importmap">${JSON.stringify({ imports })}</script>`;
    return fichiers;
  }],
  ['analyse : 800 préfixes imbriqués sur 14 400 modules', 'analyse', () => {
    // Noms de dossier courts : le chemin le plus profond doit rester sous PATH_MAX (4 096) pour que le dépôt s'écrive.
    const imports = {};
    const fichiers = {};
    let dossier = '';
    for (let i = 0; i < 800; i++) {
      dossier += `${i.toString(36)}/`;
      imports[`n${i}/`] = `./${dossier}`;
      for (let j = 0; j < 18; j++) fichiers[`${dossier}m${j}.js`] = 'export const x = 1;\n';
    }
    fichiers['index.html'] = `${TETE}<script type="importmap">${JSON.stringify({ imports })}</script>`;
    return fichiers;
  }],
  ['analyse : 20 000 import() à début fixe, tous distincts, sans dossier', 'analyse', () => ({
    'index.html': `${TETE}<script type="module" src="app.js"></script>`,
    'app.js': N(20000, (i) => `import(\`./nulle-part${i}/\${x}\`);\n`),
  })],
  ['analyse : 20 000 import() au même début fixe, sur 19 000 modules', 'analyse', () => {
    const fichiers = { 'index.html': `${TETE}<script type="module" src="app.js"></script>`, 'app.js': N(20000, () => 'import(`./lib/${x}`);\n') };
    for (let i = 0; i < 19000; i++) fichiers[`lib/m${i}.js`] = 'export const x = 1;\n';
    return fichiers;
  }],
  ['analyse : 20 000 modules qui importent le même fichier', 'analyse', () => {
    const fichiers = { 'index.html': `${TETE}<script type="module">${N(20000, (i) => `import "./m${i}.js";\n`)}</script>`, 'commun.js': 'export const x = 1;\n' };
    for (let i = 0; i < 20000; i++) fichiers[`m${i}.js`] = 'import "./commun.js";\n';
    return fichiers;
  }],
  ['analyse : une chaîne de 20 000 modules', 'analyse', () => {
    const fichiers = { 'index.html': `${TETE}<script type="module" src="m0.js"></script>` };
    for (let i = 0; i < 20000; i++) fichiers[`m${i}.js`] = `import "./m${i + 1}.js";\n`;
    return fichiers;
  }],
  ['analyse : 300 modules qui importent chacun les 300 autres', 'analyse', () => {
    const fichiers = { 'index.html': `${TETE}<script type="module" src="m0.js"></script>` };
    for (let i = 0; i < 300; i++) fichiers[`m${i}.js`] = N(300, (j) => `import "./m${j}.js";\n`);
    return fichiers;
  }],
  ['analyse : 1 000 pages d\'entrée × 1 000 adresses de worker (1 Mio de résolutions)', 'analyse', () => {
    const fichiers = { 'app.js': N(1000, (j) => `new Worker("w${j}.js");\n`) };
    for (let i = 0; i < 1000; i++) fichiers[`p${i}/index.html`] = `${TETE}<script src="/app.js"></script>`;
    return fichiers;
  }],
  ['analyse : 2 000 pages d\'entrée × 2 000 adresses de worker (au-delà du budget)', 'analyse', () => {
    const fichiers = { 'app.js': N(2000, (j) => `new Worker("w${j}.js");\n`) };
    for (let i = 0; i < 2000; i++) fichiers[`p${i}/index.html`] = `${TETE}<script src="/app.js"></script>`;
    return fichiers;
  }],
  ['analyse : 20 000 pages d\'entrée × un worker', 'analyse', () => {
    const fichiers = { 'app.js': 'new Worker("w.js");\n' };
    for (let i = 0; i < 20000; i++) fichiers[`p${i}/index.html`] = `${TETE}<script src="/app.js"></script>`;
    return fichiers;
  }],
  ['analyse : 20 000 adresses de worker sous une seule page', 'analyse', () => ({
    'index.html': `${TETE}<script src="app.js"></script>`,
    'app.js': N(20000, (j) => `new Worker("w${j}.js");\n`),
  })],

  // --- analyse complète : imports distants et ordre carte / chargeur (liens de préchargement, script qui couvre
  //     une ligne, graphes de document partagés entre pages d'entrée, budget d'arêtes)
  ['analyse : 50 000 <link rel=modulepreload> vers la même adresse distante', 'analyse', () => ({
    'index.html': `${TETE}${N(50000, () => '<link rel=modulepreload href="https://e.example/m.js">\n')}<script type="importmap">${JSON.stringify({ imports: { m: 'https://e.example/m.js' }, integrity: { 'https://e.example/m.js': `sha384-${'A'.repeat(64)}` } })}</script><script type="module">import "m";</script>`,
  })],
  ['analyse : 15 000 <link rel=modulepreload> vers des adresses distinctes, 15 000 entrées d\'import map', 'analyse', () => {
    // La page reste sous le plafond par fichier de l'outil : au-delà elle ne serait pas lue et le cas ne mesurerait rien.
    const imports = {};
    const integrity = {};
    for (let i = 0; i < 15000; i++) { imports[`m${i}`] = `https://e.example/m${i}.js`; integrity[`https://e.example/m${i}.js`] = `sha384-${'A'.repeat(64)}`; }
    return { 'index.html': `${TETE}${N(15000, (i) => `<link rel=modulepreload href="https://e.example/m${i}.js">\n`)}<script type="importmap">${JSON.stringify({ imports, integrity })}</script>` };
  }],
  ['analyse : 15 000 entrées d\'import map distantes, une par ligne (le numéro de ligne de chaque entrée se lit dans un index, pas en recopiant le début de la page)', 'analyse', () => {
    const lignes = N(15000, (i) => `"m${i}": "https://e.example/m${i}.js",\n`);
    return { 'index.html': `${TETE}<script type="importmap">{"imports": {\n${lignes}"z": "https://e.example/z.js"}}</script>` };
  }],
  ['analyse : 20 000 scripts, chacun son import https:// (une ligne chacun), import map en tête', 'analyse', () => ({
    'index.html': `${TETE}<script type="importmap">${JSON.stringify({ imports: { m: 'https://e.example/m.js' } })}</script>\n${N(20000, (i) => `<script type="module">import "https://e.example/m${i}.js";</script>\n`)}`,
  })],
  ['analyse : 20 000 scripts, chacun son import https:// (tous sur la même ligne)', 'analyse', () => ({
    'index.html': `${TETE}<script type="importmap">${JSON.stringify({ imports: { m: 'https://e.example/m.js' } })}</script>${N(20000, (i) => `<script type="module">import "https://e.example/m${i}.js";</script>`)}`,
  })],
  ['analyse : 20 000 scripts, chacun un eval d\'un littéral qui importe une adresse distante', 'analyse', () => ({
    'index.html': `${TETE}<script type="importmap">${JSON.stringify({ imports: { m: 'https://e.example/m.js' } })}</script>\n${N(20000, (i) => `<script type="module">eval("import('https://e.example/m${i}.js')")</script>\n`)}`,
  })],
  // Les cas qui suivent portent un import distant que l'import map de chaque page couvre : seul un import dont
  // l'empreinte est trouvée fait lire le graphe de document de la page (sans elle, la règle s'arrête à « pas d'empreinte »).
  ['analyse : 1 000 pages d\'entrée × un graphe partagé de 1 000 modules (1 Mio d\'arêtes)', 'analyse', () => graphePartage(1000, 1000)],
  ['analyse : 2 000 pages d\'entrée × un graphe partagé de 2 000 modules (au-delà du budget d\'arêtes)', 'analyse', () => graphePartage(2000, 2000)],
  ['analyse : 1 000 pages d\'entrée (import map sans empreinte) × 5 000 imports distants', 'analyse', () => {
    const fichiers = { 'app.js': N(5000, (j) => `import "https://e.example/m${j}.js";\n`) };
    for (let i = 0; i < 1000; i++) fichiers[`p${i}/index.html`] = `${TETE}<script type="importmap">{"imports":{}}</script><script type="module" src="/app.js"></script>`;
    return fichiers;
  }],
  ['analyse : 3 000 pages d\'entrée × 3 000 modules qui importent chacun la même adresse distante, l\'empreinte dans chaque page', 'analyse', () => pagesEtRacines(3000, 3000)],
  ['analyse : 300 pages d\'entrée, chacune l\'empreinte de 300 imports distants (90 000 couples)', 'analyse', () => {
    const integrity = {};
    for (let j = 0; j < 300; j++) integrity[`https://e.example/m${j}.js`] = `sha384-${'A'.repeat(64)}`;
    const fichiers = { 'app.js': N(300, (j) => `import "https://e.example/m${j}.js";\n`) };
    for (let i = 0; i < 300; i++) fichiers[`p${i}/index.html`] = `${TETE}<script type="importmap">${JSON.stringify({ integrity })}</script><script type="module" src="/app.js"></script>`;
    return fichiers;
  }],
  // --- analyse complète : une ligne à établir pour chaque occurrence d'un motif dans un même fichier (le numéro de ligne se lit dans un index des sauts de ligne, pas en recopiant le début du fichier à chaque occurrence)
  ['analyse : 300 000 marqueurs TODO dans un .js, un par ligne', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': N(300000, () => '// TODO: x\n') })],
  ['analyse : 300 000 marqueurs TODO dans un .js, sur une ligne', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': `/* ${N(300000, () => 'TODO: ')} */` })],
  ['analyse : 100 000 références à un hôte tiers non souverain, une par ligne', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': N(100000, () => '// https://fonts.googleapis.com/a\n') })],
  ['analyse : 100 000 références à un hôte tiers non souverain, sur une ligne', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': `/* ${N(100000, () => 'https://fonts.googleapis.com/a ')} */` })],
  // Une référence cachée par un encodage : le littéral décodé est un fichier de plus, dont la référence ne compte que si son fichier d'origine ne la porte pas déjà en clair (ici : jamais). Le fichier d'origine se cherche dans une table, et son contenu ne se parcourt qu'une fois par hôte ; un `find` sur tout l'inventaire et un `includes` sur tout le fichier à chaque référence, eux, sont quadratiques.
  ['analyse : 40 000 eval(atob(…)) qui cachent chacun une référence à un hôte tiers non souverain', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': N(40000, (i) => `eval(atob("${Buffer.from(`fetch('https://fonts.googleapis.com/a${i}')`).toString('base64')}"));\n`) })],
  // --- des blancs qui franchissaient les fins de ligne : `^\s*` (B-IA-01) courait d'une ligne vide à la suivante, `\s*` du README aussi ; un JSDoc générique cherché depuis chaque `/**` relisait la même fenêtre
  ['analyse : 200 000 lignes vides dans un .js', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': N(200000, () => '\n') })],
  ['analyse : 200 000 lignes vides dans un .js, fins de ligne CRLF', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': N(200000, () => '\r\n') })],
  ['analyse : 40 000 `/** @param {` dans un .js', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': N(40000, () => '/** @param {') })],
  ['analyse : un README de 200 000 lignes vides', 'analyse', () => ({ 'index.html': `${TETE}<script src="app.js"></script>`, 'app.js': '1;', 'README.md': N(200000, () => '\n') })],
];

const { values, positionals } = parseArgs({
  options: {
    racine: { type: 'string', default: RACINE_PAR_DEFAUT }, delai: { type: 'string', default: '120' }, liste: { type: 'boolean', default: false },
    // internes : le processus enfant d'un cas, et le dossier temporaire que le parent lui prête (et nettoie, même si l'enfant meurt)
    cas: { type: 'string' }, dossier: { type: 'string' },
  },
  allowPositionals: true,
});

/** Enfant : un seul cas, une ligne de résultat sur la sortie standard. */
async function lancerCas(nom, racine, dossier) {
  const cas = CAS.find(([n]) => n === nom);
  if (!cas) { console.error(`cas inconnu : ${nom}`); process.exit(2); }
  const [, portee, fabriquer] = cas;
  const importer = (chemin) => import(pathToFileURL(path.join(racine, chemin)).href);
  const entree = fabriquer();
  let ms;
  let detail;
  if (portee === 'page') {
    const { lirePage } = await importer('src/moteur/page-html.js');
    const t = process.hrtime.bigint();
    const p = lirePage(entree);
    ms = Number(process.hrtime.bigint() - t) / 1e6;
    detail = `${p.scripts.length} scripts, ${p.feuilles?.length ?? 0} feuilles`;
  } else {
    const { construireContexte } = await importer('src/contexte/inventaire.js');
    const { analyseStatique } = await importer('src/moteur/statique.js');
    for (const [fichier, contenu] of Object.entries(entree)) {
      const cible = path.join(dossier, fichier);
      fs.mkdirSync(path.dirname(cible), { recursive: true });
      fs.writeFileSync(cible, contenu);
    }
    const t = process.hrtime.bigint();
    const constats = await analyseStatique(construireContexte(dossier), { reseau: false });
    ms = Number(process.hrtime.bigint() - t) / 1e6;
    detail = `${constats.length} constats`;
  }
  console.log(`${ms.toFixed(0).padStart(8)} ms  ${detail.padEnd(22)} ${(process.resourceUsage().maxRSS / 1024).toFixed(0).padStart(6)} Mo (pic)`);
}

if (values.cas) {
  await lancerCas(values.cas, path.resolve(values.racine), values.dossier);
} else {
  const filtres = positionals;
  const retenus = CAS.map(([nom]) => nom).filter((nom) => !filtres.length || filtres.some((f) => nom.includes(f)));
  if (values.liste) { for (const nom of retenus) console.log(nom); process.exit(0); }
  if (!retenus.length) { console.error('Aucun cas ne correspond.'); process.exit(2); }
  const racine = path.resolve(values.racine);
  const delai = Number(values.delai);
  if (!fs.existsSync(path.join(racine, 'src', 'moteur', 'page-html.js'))) { console.error(`${racine} n'est pas la racine de l'outil.`); process.exit(2); }
  let echecs = 0;
  for (const nom of retenus) {
    // Un enfant tué (mémoire épuisée, délai) ne nettoie rien : le dossier temporaire est celui du parent.
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-pieges-'));
    let r;
    try { r = spawnSync(process.execPath, [ICI, '--cas', nom, '--racine', racine, '--dossier', dossier], { encoding: 'utf8', timeout: delai * 1000, maxBuffer: 1 << 24 }); }
    finally { fs.rmSync(dossier, { recursive: true, force: true }); }
    let resultat;
    if (r.error?.code === 'ETIMEDOUT') resultat = `dépassé (> ${delai} s)`;
    else if (r.status !== 0) resultat = `ÉCHEC (${r.signal ?? `code ${r.status}`}${/heap out of memory|allocation failed/i.test(r.stderr ?? '') ? ', mémoire épuisée' : ''})`;
    else resultat = r.stdout.trim();
    if (r.status !== 0) echecs++;
    console.log(`${nom.padEnd(58)} ${resultat}`);
  }
  process.exit(echecs ? 1 : 0);
}
