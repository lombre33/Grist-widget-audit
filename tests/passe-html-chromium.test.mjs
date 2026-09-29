import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';
import { lirePage, urlDe } from '../src/moteur/page-html.js';

/**
 * Différentiel : ce que la passe HTML dit qu'un navigateur exécute ou demande,
 * comparé à ce que Chromium fait vraiment d'une page (deux serveurs locaux,
 * LOCAL pour la page, EXT pour un « tiers »). Une ligne par forme ; les cas
 * viennent des sondes du 2026-09-28 et 29 sur Chromium 141. Sont exclus de la
 * comparaison, parce que l'audit les rapporte exprès avec une mention : les
 * scripts d'un `<template>` (Chromium les exécute une fois le gabarit inséré)
 * et ceux que seul le standard HTML exécute (`type=" module "`).
 * Le test ne se saute que si aucun Chromium ne se lance (GWAUDIT_CHROMIUM_PATH).
 */

const exec = (id) => `(window.vus=window.vus||[]).push("${id}")`;
const G = 'x'; // clé de la page courante, jamais dans un chemin

// [nom, corps, options] ; options : nue (rien après le corps), carte (id du module qui ne tourne que si l'import map s'applique)
const CAS = [
  ['en ligne', `<script>${exec('i:1')}</script>`],
  ['src tiers', '<script src="{{E}}/x/a.js"></script>'],
  ['src local', '<script src="rel.js"></script>'],
  ['base externe', '<base href="{{E}}/b/"><script src="rel.js"></script>'],
  ['base relative', '<base href="sous/"><script src="rel.js"></script>'],
  ['base à la racine', '<base href="/racine/"><script src="rel.js"></script>'],
  ['base en gabarit', '<template><base href="{{E}}/t/"></template><script src="rel.js"></script>'],
  ['base en noscript', '<noscript><base href="{{E}}/n/"></noscript><script src="rel.js"></script>'],
  ['base en commentaire', '<!-- <base href="{{E}}/c/"> --><script src="rel.js"></script>'],
  ['base après le script', '<script src="avant.js"></script><base href="{{E}}/ap/"><script src="apres.js"></script>'],
  ['base sans barre finale', '<base href="{{E}}/dossier"><script src="rel.js"></script>'],
  ['base avec fragment', '<base href="{{E}}/f/#x"><script src="rel.js"></script>'],
  ['base data:', '<base href="data:text/html,x"><script src="rel.js"></script>'],
  ['première base avec href', '<base target="_blank"><base href="{{E}}/2/"><base href="{{E}}/3/"><script src="rel.js"></script>'],
  ['base au protocole relatif', '<base href="//{{EH}}/pr/"><script src="rel.js"></script>'],
  ['module avec src', '<script type=module src="{{E}}/m/a.js"></script>'],
  ['type à paramètres', `<script type="text/javascript; charset=utf-8" src="{{E}}/p/a.js"></script><script type="text/javascript; charset=utf-8">${exec('i:param')}</script>`],
  ['nomodule', `<script nomodule src="{{E}}/nm/a.js"></script><script nomodule>${exec('i:nomodule')}</script>`],
  ['text/template avec src', '<script type="text/template" src="{{E}}/tt/a.js"></script>'],
  ['type vide', '<script type="" src="{{E}}/tv/a.js"></script>'],
  ['type module aux blancs de bord (standard seul)', '<script type=" module " src="{{E}}/ms/a.js"></script>'],
  ['type précédé de U+3000 (dans l\'ensemble de blancs)', `<script type="&#x3000;text/javascript">${exec('i:x3000')}</script>`],
  ['type précédé d\'une espace insécable (hors ensemble)', `<script type="&#xA0;text/javascript">${exec('i:xa0')}</script>`],
  ['language=vbscript', `<script language="vbscript">${exec('i:vbs')}</script><script language="javascript">${exec('i:js')}</script>`],
  ['script jamais fermé', `<script>${exec('i:eof')}`, { nue: true }],
  ['script src jamais fermé', '<script src="{{E}}/eof/a.js">', { nue: true }],
  ['script englobé par <!--<script>', `<script>a=1;/*<!--<script>*/${exec('i:de')}</script><script src="{{E}}/de/a.js"></script>`],
  ['dans un template', `<template><script src="{{E}}/tpl/a.js"></script><script>${exec('i:tpl')}</script></template>`],
  ['dans un noscript', '<noscript><script src="{{E}}/nos/a.js"></script></noscript>'],
  ['dans un textarea', '<textarea><script src="{{E}}/ta/a.js"></script></textarea>'],
  ['svg href', '<svg><script href="{{E}}/s/a.js"></script></svg>'],
  ['svg xlink:href', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><script xlink:href="{{E}}/s/b.js"></script></svg>'],
  ['svg src', '<svg><script src="{{E}}/s/c.js"></script></svg>'],
  ['svg en ligne', `<svg><script>${exec('i:svg')}</script></svg>`],
  ['svg jamais fermé', '<svg><script href="{{E}}/s/d.js">', { nue: true }],
  ['svg cdata', `<svg><script><![CDATA[${exec('i:cdata')}]]></script></svg>`],
  ['svg entités', `<svg><script>(window.vus=window.vus||[]).push(&quot;i:ent&quot;)</script></svg>`],
  ['svg nomodule', `<svg><script nomodule>${exec('i:svgnm')}</script></svg>`],
  ['script HTML dans foreignObject', '<svg><foreignObject><script src="{{E}}/fo/a.js"></script></foreignObject></svg>'],
  ['script MathML avec src', '<math><script src="{{E}}/ma/a.js"></script></math>'],
  ['import map HTML', `<script type=importmap>{"imports":{"lib":"{{E}}/im/h.js"}}</script><script type=module>import "lib";${exec('i:mod')}</script>`, { carte: 'i:mod' }],
  ['import map SVG', `<svg><script type=importmap>{"imports":{"lib":"{{E}}/im/s.js"}}</script></svg><script type=module>import "lib";${exec('i:mod')}</script>`, { carte: 'i:mod' }],
  ['import map SVG avec href', `<svg><script type=importmap href="x">{"imports":{"lib":"{{E}}/im/sh.js"}}</script></svg><script type=module>import "lib";${exec('i:mod')}</script>`, { carte: 'i:mod' }],
  ['import map SVG avec src', `<svg><script type=importmap src="x">{"imports":{"lib":"{{E}}/im/ss.js"}}</script></svg><script type=module>import "lib";${exec('i:mod')}</script>`, { carte: 'i:mod' }],
  ['import map HTML avec src', `<script type=importmap src="{{E}}/im/x.js">{"imports":{"lib":"{{E}}/im/hs.js"}}</script><script type=module>import "lib";${exec('i:mod')}</script>`, { carte: 'i:mod' }],
];

const cheminChromium = () => {
  const impose = process.env.GWAUDIT_CHROMIUM_PATH;
  if (impose) return fs.existsSync(impose) ? impose : null;
  const defaut = chromium.executablePath();
  return fs.existsSync(defaut) ? defaut : null;
};

function serveur(etiquette, page) {
  const s = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (etiquette === 'LOCAL' && pathname === '/index.html') { res.setHeader('content-type', 'text/html'); res.end(page.courante); return; }
    if (pathname === '/favicon.ico') { res.statusCode = 404; res.end(); return; }
    page.requetes.push(`${etiquette}${pathname}`);
    res.setHeader('content-type', 'text/javascript');
    res.setHeader('access-control-allow-origin', '*');
    res.end(`(window.vus=window.vus||[]).push(${JSON.stringify(etiquette + pathname)});`);
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(s)));
}

test('différentiel Chromium : ce que la passe HTML exécute et demande est ce que le navigateur exécute et demande', async (t) => {
  const executable = cheminChromium();
  if (!executable) { t.skip('aucun Chromium lançable (voir GWAUDIT_CHROMIUM_PATH)'); return; }
  const page = { courante: '', requetes: [] };
  const [local, ext] = [await serveur('LOCAL', page), await serveur('EXT', page)];
  const E = `http://127.0.0.1:${ext.address().port}`;
  const navigateur = await chromium.launch({ executablePath: executable });
  t.after(async () => { await navigateur.close(); local.close(); ext.close(); });
  const etiquette = (url) => (url === null ? null : url.origin === 'https://widget.local' ? `LOCAL${url.pathname}` : url.host === E.slice('http://'.length) ? `EXT${url.pathname}` : null); // l'hôte seul : la page réelle est en http, l'analyse la suppose en https

  for (const [nom, modele, options = {}] of CAS) {
    const corps = modele.replaceAll('{{EH}}', E.slice('http://'.length)).replaceAll('{{E}}', E);
    const html = `<!doctype html><meta charset=utf-8>${corps}${options.nue ? '' : '<p>fin</p>'}`;

    // Ce que dit l'analyse : seulement ce que Chromium fait tel quel (ni gabarit, ni standard seul)
    const { scripts } = lirePage(html);
    const executePrevu = new Set(), demandePrevu = new Set();
    for (const s of scripts) {
      if (s.dansTemplate) continue;
      for (const ch of s.chargements) {
        if (ch.seulementStandard) continue;
        const cible = etiquette(urlDe(ch.valeur, s.baseBrute, 'index.html'));
        if (!cible) continue;
        demandePrevu.add(cible);
        if (ch.execute) executePrevu.add(cible);
      }
      if (s.unite && !s.seulementStandard) for (const m of s.texte.matchAll(/push\("(i:[^"]+)"\)/g)) executePrevu.add(m[1]);
    }

    // Ce que fait Chromium
    page.courante = html;
    page.requetes = [];
    const onglet = await navigateur.newPage();
    await onglet.goto(`http://127.0.0.1:${local.address().port}/index.html`, { waitUntil: 'load' });
    await onglet.waitForTimeout(250);
    const executeReel = new Set(await onglet.evaluate(() => window.vus ?? []));
    await onglet.close();
    const demandeReel = new Set(page.requetes.filter((r) => r !== 'LOCAL/index.html'));

    if (options.carte) {
      const [carte] = scripts.filter((s) => s.genre === 'importmap');
      assert.equal(carte?.carteImport ?? false, executeReel.has(options.carte), `${nom} : l'import map est appliquée par Chromium exactement quand l'analyse la lit`);
      continue;
    }
    assert.deepEqual([...executePrevu].sort(), [...executeReel].sort(), `${nom} : ce qui s'exécute`);
    const invente = [...demandePrevu].filter((d) => !demandeReel.has(d));
    assert.deepEqual(invente, [], `${nom} : une demande que l'analyse annonce et que Chromium ne fait pas`);
    const manque = [...demandeReel].filter((d) => !demandePrevu.has(d)).sort();
    assert.deepEqual(manque, [], `${nom} : une demande de Chromium que l'analyse ne connaît pas`);
  }
});
