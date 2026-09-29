import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';

/**
 * Différentiel : la surface de code que l'inventaire retient (`executee`, le
 * fichier qu'un navigateur charge depuis la page) comparée aux fichiers du
 * widget que Chromium demande vraiment. Le widget est servi tel quel par un
 * serveur local, ses modules s'importent, ses workers démarrent ; un serveur
 * « tiers » répond à tout ce qui sort de l'origine du widget.
 *
 * Deux exigences, et pas davantage :
 *  - sûreté : tout fichier du widget que Chromium charge est dans la surface.
 *    Un fichier chargé que l'audit n'a pas dans sa surface est du code exécuté
 *    que personne n'a lu : le défaut que ce test existe pour attraper ;
 *  - exactitude, là où l'audit la prétend : un fichier que Chromium ne charge
 *    pas n'est pas dans la surface (`exact`). Là où l'audit inclut dans le
 *    doute, la forme dit ce qu'il inclut en trop (`enTrop`) : le test échoue
 *    si l'excès change, dans un sens ou dans l'autre.
 * Une forme que l'audit ne tient pas encore est écrite `connu` : ce que
 * Chromium charge et que la surface manque. Le test échoue quand elle est
 * réparée, pour qu'on retire la mention.
 *
 * Le test ne se saute que si aucun Chromium ne se lance (GWAUDIT_CHROMIUM_PATH).
 * Chromium 141, sondé le 2026-09-29.
 */

const page = (corps, tete = '') => `<!doctype html><meta charset=utf-8>${tete}${corps}`;
const MODULE = (chemin) => `<script type=module src="${chemin}"></script>`;

/**
 * [nom, fichiers(E), options]
 *   exact    : la surface est exactement ce que Chromium charge
 *   enTrop   : fichiers que la surface a en plus, faute de savoir (inclure dans le doute)
 *   connu    : fichiers que Chromium charge et que la surface manque (à réparer)
 *   externe  : le navigateur demande au moins une ressource au tiers, et l'audit le dit (C-EXFIL-01, code chargé)
 *   gabarit  : fichiers dont la précision « dans un `<template>` » doit figurer
 */
const FORMES = [
  ['graphe de modules : import, export … from, ../', (E) => ({
    'index.html': page(MODULE('app.js')),
    'app.js': "import './sub/b.js'; import { c } from './c.js'; export * from './d.js'; export { e } from './e.js';\n",
    'sub/b.js': "import '../f.js';\n",
    'c.js': 'export const c = 1;\n', 'd.js': 'export const d = 1;\n', 'e.js': 'export const e = 1;\n', 'f.js': '\n',
    'sub/c.js': '// leurre : jamais importé\n', 'g.js': '// leurre\n',
  }), { exact: true }],

  ['import nu sans import map : rien n\'est chargé', () => ({
    'index.html': page("<script type=module>import 'lodash';</script>"),
    'lodash.js': '// leurre\n', 'lodash/index.js': '// leurre\n', 'node_modules/lodash/index.js': '// leurre\n',
  }), { exact: true }],

  ['import map locale et import nu', () => ({
    'index.html': page(`<script type=importmap>{"imports":{"lodash":"./lib/lodash.js"}}</script><script type=module>import 'lodash';</script>`),
    'lib/lodash.js': "import './helper.js';\n", 'lib/helper.js': '\n', 'helper.js': '// leurre\n',
  }), { exact: true }],

  ['import map : une entrée que la page n\'importe pas', () => ({
    'index.html': page(`<script type=importmap>{"imports":{"used":"./lib/used.js","unused":"./lib/unused.js"}}</script><script type=module>import 'used';</script>`),
    'lib/used.js': '\n', 'lib/unused.js': '\n',
  }), { enTrop: ['lib/unused.js'] }],

  ['import map : scopes', () => ({
    'index.html': page(`<script type=importmap>{"imports":{"a":"./lib/a.js"},"scopes":{"./sub/":{"a":"./lib/a-sub.js"}}}</script><script type=module src="sub/m.js"></script>`),
    'sub/m.js': "import 'a';\n", 'lib/a.js': '\n', 'lib/a-sub.js': '\n',
  }), { enTrop: ['lib/a.js'] }],

  ['import map à préfixe : "lib/" vers "./libs/"', () => ({
    'index.html': page(`<script type=importmap>{"imports":{"lib/":"./libs/"}}</script><script type=module>import 'lib/x.js';</script>`),
    'libs/x.js': '\n', 'libs/y.js': '// jamais importé\n',
  }), { enTrop: ['libs/y.js'] }],

  ['code rangé dans dist/, build/, vendor/, node_modules/', () => ({
    'index.html': page(`<script src="dist/app.js"></script><script src="vendor/lib.js"></script>${MODULE('build/x.js')}<script src="node_modules/p/index.js"></script>`),
    'dist/app.js': "import('./chunk.js');\n", 'dist/chunk.js': '\n', 'dist/leurre.js': '// jamais chargé\n',
    'vendor/lib.js': '\n', 'build/x.js': "import '/shared.js';\n", 'shared.js': '\n', 'node_modules/p/index.js': '\n', 'node_modules/p/autre.js': '// jamais chargé\n',
  }), { exact: true }],

  ['adresses absolues (/) depuis un sous-dossier', () => ({
    'index.html': page(MODULE('sub/m.js')),
    'sub/m.js': "import '/root.js'; import '/sub/n.js';\n", 'root.js': '\n', 'sub/n.js': '\n', 'n.js': '// leurre\n',
  }), { exact: true }],

  ['base externe : un import relatif part chez le tiers', (E) => ({
    'index.html': page("<script type=module>import './bii.js';</script>", `<base href="${E}/b/">`),
    'bii.js': '// leurre : jamais chargé\n', 'b/bii.js': '// leurre\n',
  }), { exact: true, externe: true }],

  ['base relative : un script relatif se résout contre elle', () => ({
    'index.html': page('<script src="app.js"></script>', '<base href="sub/">'),
    'sub/app.js': '\n', 'app.js': '// leurre : jamais chargé\n',
  }), { exact: true }],

  ['import() à littéral', () => ({
    'index.html': page("<script type=module>import('./dyn.js');</script>"),
    'dyn.js': '\n', 'jamais.js': '// leurre\n',
  }), { exact: true }],

  ['script classique d\'un sous-dossier : import() relatif au script', () => ({
    'index.html': page('<script src="sub/a.js"></script>'),
    'sub/a.js': "import('./x.js');\n", 'sub/x.js': '\n', 'x.js': '// leurre : jamais chargé\n',
  }), { exact: true }],

  ['requête et fragment d\'un import', () => ({
    'index.html': page(MODULE('a.js?v=2#f')),
    'a.js': "import './b.js?x=1#y';\n", 'b.js': '\n',
  }), { exact: true }],

  ['import sans extension', () => ({
    'index.html': page(MODULE('a.js')),
    'a.js': "import './noext';\n", 'noext': '\n', 'noext.js': '// leurre : Chromium ne complète jamais l\'extension\n',
  }), { enTrop: ['noext.js'] }],

  ['modulepreload et feuille avec @import', () => ({
    'index.html': page('', '<link rel=modulepreload href="pre.js"><link rel=stylesheet href="s.css">'),
    'pre.js': '\n', 's.css': "@import 'i.css';\n", 'i.css': 'a{}\n',
  }), { exact: true }],

  ['worker à la racine et importScripts relatif au worker', () => ({
    'index.html': page("<script>new Worker('w.js')</script>"),
    'w.js': "importScripts('lib/x.js');\n", 'lib/x.js': '\n', 'x.js': '// leurre\n',
  }), { exact: true }],

  ['worker construit par un script de sous-dossier (chaîne : relative au document)', () => ({
    'index.html': page('<script src="sub/app.js"></script>'),
    'sub/app.js': "new Worker('w.js');\n", 'w.js': '\n', 'sub/w.js': '// Chromium demande /w.js : le dossier du fichier reste essayé dans le doute\n',
  }), { enTrop: ['sub/w.js'] }],

  ['worker construit sous une <base> par un script hors du dossier de base', () => ({
    'index.html': page('<script src="/app.js"></script>', '<base href="cache/">'),
    'app.js': "new Worker('w.js');\n", 'cache/w.js': '\n', 'w.js': '// dossier du fichier : essayé dans le doute\n',
  }), { enTrop: ['w.js'] }],

  ['worker construit sous une <base> par un script d\'un autre dossier : la page sans base n\'est pas un contexte', () => ({
    'index.html': page('<script src="/js/app.js"></script>', '<base href="cache/">'),
    'js/app.js': "new Worker('w.js');\n", 'cache/w.js': '\n', 'js/w.js': '// dossier du fichier : essayé dans le doute\n', 'w.js': '// la racine : la page a une base avant son script, personne ne la voit sans\n',
  }), { enTrop: ['js/w.js'] }],

  ['worker construit par un script placé avant la <base> : la page sans base et la page avec', () => ({
    'index.html': page('', '<script src="js/app.js"></script><base href="cache/">'),
    'js/app.js': "new Worker('w.js');\n", 'w.js': '\n', 'cache/w.js': '// le code qui tourne après la page voit la base : essayé dans le doute\n', 'js/w.js': '// dossier du fichier : essayé dans le doute\n',
  }), { enTrop: ['cache/w.js', 'js/w.js'] }],

  ['worker par new URL(…, document.baseURI) : relatif au document, non au module', () => ({
    'index.html': page('<script src="sub/app.js"></script>'),
    'sub/app.js': "new Worker(new URL('w.js', document.baseURI));\n", 'w.js': '\n', 'sub/w.js': '// dossier du module : essayé dans le doute\n',
  }), { enTrop: ['sub/w.js'] }],

  ['service worker et modules de worklet', () => ({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': "navigator.serviceWorker.register('sw.js');\nnew AudioContext().audioWorklet.addModule('am.js');\nCSS.paintWorklet.addModule('pm.js');\n",
    'sw.js': '\n', 'am.js': 'registerProcessor("x", class extends AudioWorkletProcessor { process() { return true; } });\n', 'pm.js': 'registerPaint("y", class { paint() {} });\n',
  }), {}],

  ['worker par new URL(…, import.meta.url)', () => ({
    'index.html': page(MODULE('sub/app.js')),
    'sub/app.js': "new Worker(new URL('./w.js', import.meta.url), { type: 'module' });\n", 'sub/w.js': '\n', 'w.js': '// leurre\n',
  }), { exact: true }],

  ['script dans un <template> : rien avant l\'insertion', () => ({
    'index.html': page('<template><script src="t.js"></script></template>'),
    't.js': '\n',
  }), { enTrop: ['t.js'], gabarit: ['t.js'] }],

  ['script SVG (href), script dans <noscript>, nomodule, type inconnu', () => ({
    'index.html': page('<svg><script href="s.js"></script></svg><noscript><script src="n.js"></script></noscript><script nomodule src="nm.js"></script><script type="text/template" src="tt.js"></script>'),
    's.js': '\n', 'n.js': '// leurre\n', 'nm.js': '// leurre\n', 'tt.js': '// leurre\n',
  }), { exact: true }],

  ['chemins de page écrits autrement : %-encodés, //, /./, /../ et %2F', () => ({
    'index.html': page('<script src="%61.js"></script><script src="js//b.js"></script><script src="js/./c.js"></script><script src="js/x/../d.js"></script><script src="js/..%2Fe.js"></script><script src="f%20g.js"></script>'),
    'a.js': '\n', 'js/b.js': '\n', 'js/c.js': '\n', 'js/d.js': '\n', 'e.js': '\n', 'f g.js': '\n',
    'js/a.js': '// leurre\n', 'x/d.js': '// leurre\n',
  }), { exact: true }],

  ['chemins de module écrits autrement : %-encodés, //, /../ et worker à %2E', () => ({
    'index.html': page(MODULE('app.js')),
    'app.js': "import './%62.js'; import './sub//c.js'; import './sub/../d.js'; import './e%20f.js'; new Worker('./w%2Ejs');\n",
    'b.js': '\n', 'sub/c.js': '\n', 'd.js': '\n', 'e f.js': '\n', 'w.js': '\n', 'sub/d.js': '// leurre\n',
  }), { exact: true }],

  ['iframe vers une page locale : ses scripts s\'exécutent (étape 2b, pas encore suivi)', () => ({
    'index.html': page('<iframe src="p2.html"></iframe>'),
    'p2.html': page('<script src="p2.js"></script>'), 'p2.js': '\n',
  }), { connu: ['p2.html', 'p2.js'] }],

  ['import() à gabarit ou à concaténation : le dossier fixe est dans la surface', () => ({
    'index.html': page("<script type=module>const l = 'fr'; import(`./locales/${l}.js`); import('./autres/' + l + '.js');</script>"),
    'locales/fr.js': '\n', 'locales/en.js': '// jamais chargé : tout module du dossier est essayé\n',
    'autres/fr.js': '\n', 'autres/en.js': '// jamais chargé\n', 'ailleurs/x.js': '// hors des dossiers fixes\n',
  }), { enTrop: ['locales/en.js', 'autres/en.js'] }],

  ['import() à gabarit dans un module de sous-dossier : relatif au module', () => ({
    'index.html': page(MODULE('sub/app.js')),
    'sub/app.js': "const n = 'a'; import(`./chunks/${n}.js`);\n",
    'sub/chunks/a.js': '\n', 'sub/chunks/b.js': '// jamais chargé\n', 'chunks/a.js': '// hors du dossier du module\n',
  }), { enTrop: ['sub/chunks/b.js'] }],

  ['import d\'un module tiers depuis un module local', (E) => ({
    'index.html': page(MODULE('a.js')),
    'a.js': `import './b.js';\n`, 'b.js': `import '${E}/tiers/x.js';\n`,
  }), { exact: true, externe: true }],
];

const cheminChromium = () => {
  const impose = process.env.GWAUDIT_CHROMIUM_PATH;
  if (impose) return fs.existsSync(impose) ? impose : null;
  const defaut = chromium.executablePath();
  return fs.existsSync(defaut) ? defaut : null;
};

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };

test('différentiel Chromium : la surface de code de l\'inventaire contient tout ce que le navigateur charge du widget', async (t) => {
  const executable = cheminChromium();
  if (!executable) { t.skip('aucun Chromium lançable (voir GWAUDIT_CHROMIUM_PATH)'); return; }
  const courant = { dossier: '', locales: [], externes: [] };
  const local = http.createServer((req, res) => {
    // Comme nginx ou `send` : le chemin se décode (`%61`, `%2F`) puis se normalise (`//`, `/./`, `/../`) avant de désigner un fichier.
    const fichier = path.join(courant.dossier, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const chemin = path.relative(courant.dossier, fichier).split(path.sep).join('/');
    if (!chemin || chemin === 'favicon.ico' || chemin.startsWith('..') || !fs.existsSync(fichier) || !fs.statSync(fichier).isFile()) { res.statusCode = 404; res.end(); return; }
    if (chemin !== 'index.html') courant.locales.push(chemin);
    res.setHeader('content-type', TYPES[path.extname(chemin)] ?? 'text/javascript');
    res.end(fs.readFileSync(fichier));
  });
  const ext = http.createServer((req, res) => {
    courant.externes.push(new URL(req.url, 'http://x').pathname);
    res.setHeader('content-type', 'text/javascript');
    res.setHeader('access-control-allow-origin', '*');
    res.end('export {};\n');
  });
  await Promise.all([local, ext].map((s) => new Promise((ok) => s.listen(0, '127.0.0.1', ok))));
  const E = `http://ext.localhost:${ext.address().port}`;
  const navigateur = await chromium.launch({ executablePath: executable });
  t.after(async () => { await navigateur.close(); local.close(); ext.close(); });

  const problemes = [];
  for (const [nom, fabriquer, options = {}] of FORMES) {
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-surface-'));
    try {
      for (const [chemin, contenu] of Object.entries(fabriquer(E))) {
        fs.mkdirSync(path.dirname(path.join(racine, chemin)), { recursive: true });
        fs.writeFileSync(path.join(racine, chemin), contenu.replaceAll('{{E}}', E));
      }
      // Chromium
      courant.dossier = racine; courant.locales = []; courant.externes = [];
      const onglet = await navigateur.newPage();
      await onglet.goto(`http://127.0.0.1:${local.address().port}/index.html`, { waitUntil: 'load' });
      await onglet.waitForTimeout(300);
      await onglet.close();
      const charges = new Set(courant.locales);

      // L'audit
      const ctx = construireContexte(racine);
      const surface = new Set(ctx.fichiers.filter((f) => f.executee).map((f) => f.chemin));
      surface.delete('index.html');

      const manques = [...charges].filter((c) => !surface.has(c)).sort();
      const enTrop = [...surface].filter((c) => !charges.has(c)).sort();
      const attenduManques = [...(options.connu ?? [])].sort();
      const attenduEnTrop = [...(options.enTrop ?? [])].sort();
      if (JSON.stringify(manques) !== JSON.stringify(attenduManques)) problemes.push(`${nom} : Chromium charge, la surface ne contient pas : ${JSON.stringify(manques)} (attendu ${JSON.stringify(attenduManques)}${options.connu ? " ; si la surface le tient maintenant, retirer « connu »" : ''})`);
      if (JSON.stringify(enTrop) !== JSON.stringify(attenduEnTrop)) problemes.push(`${nom} : la surface contient, Chromium ne charge pas : ${JSON.stringify(enTrop)} (attendu ${JSON.stringify(attenduEnTrop)})`);

      for (const chemin of options.gabarit ?? []) {
        const f = ctx.fichiers.find((x) => x.chemin === chemin);
        if (!(f?.mention && /template/.test(f.mention))) problemes.push(`${nom} : ${chemin} doit dire qu'il vient d'un <template>`);
      }
      if ('externe' in options) {
        const constats = await analyseStatique(ctx, { reseau: false });
        const dit = constats.some((c) => c.regle === 'C-EXFIL-01' && /charge et exécute du code depuis `ext\.localhost`/.test(c.constat));
        if (courant.externes.length === 0) problemes.push(`${nom} : le navigateur ne demande rien au tiers`);
        if (!dit) problemes.push(`${nom} : l'audit ne dit pas qu'il charge du code chez le tiers`);
      } else if (courant.externes.length) {
        problemes.push(`${nom} : demande inattendue au tiers ${JSON.stringify(courant.externes)}`);
      }
    } finally {
      fs.rmSync(racine, { recursive: true, force: true });
    }
  }
  assert.deepEqual(problemes, [], `${problemes.length} écart(s) entre la surface de l'audit et ce que Chromium charge`);
});
