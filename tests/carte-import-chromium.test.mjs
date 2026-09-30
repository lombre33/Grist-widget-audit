/**
 * Différentiel : `resolveurDeCartes` (ce que l'outil fait d'un nom ou d'une adresse que du code importe, sous les cartes d'import
 * d'une page) comparé à `import.meta.resolve` de Chromium, qui applique les cartes de la page au module qui l'appelle. Un fichier
 * qu'un nom désigne par une carte est du code pour le navigateur quelle que soit son extension (C-SURFACE-03) : si l'outil résolvait
 * un nom ailleurs que Chromium, il déclarerait illisible un fichier que le navigateur n'exécute pas, ou lirait comme de la donnée
 * celui qu'il exécute. Chaque cas a sa réponse dans Chromium, pas dans la spécification lue de mémoire.
 *
 * Le test ne se saute que si aucun Chromium ne se lance (GWAUDIT_CHROMIUM_PATH). Chromium 141.
 */
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromiumIndisponible } from './aide-chromium.mjs';
import { resolveurDeCartes } from '../src/moteur/analyse-js.js';
import { ORIGINE_LOCALE } from '../src/moteur/base-url.js';

const cheminChromium = () => {
  const impose = process.env.GWAUDIT_CHROMIUM_PATH;
  if (impose) return fs.existsSync(impose) ? impose : null;
  const defaut = chromium.executablePath();
  return fs.existsSync(defaut) ? defaut : null;
};

const ERREUR = 'ERREUR';

/**
 * [nom, cartes (une par balise `importmap`, dans l'ordre de la page), référent, spécificateur, options]
 * référent : le chemin du module qui importe (`'sub/m.js'`), ou `null` pour un script de la page elle-même
 * options.base : le `href` de la `<base>` qui précède les cartes
 * options.libre : plusieurs portées correspondent au module et nomment le nom : la norme veut la plus longue, Chromium 141 n'en retient pas toujours
 *   la plus longue (voir `resolveurDeCartes`) ; l'outil rend les adresses de toutes, et la réponse de Chromium est l'une d'elles
 * options.retenue : ce que Chromium 141 retient dans ce cas libre (la mention de `resolveurDeCartes` tombe le jour où cet essai échoue)
 */
const CAS = [
  ['un nom que la carte nomme', [{ imports: { lib: './vendor/lib.js' } }], 'app.js', 'lib'],
  ['un nom nu qu\'aucune clé ne nomme : erreur', [{ imports: { lib: './vendor/lib.js' } }], 'app.js', 'autre'],
  ['un nom nu sans carte qui le nomme, carte vide de noms', [{ imports: {} }], 'app.js', 'lib'],
  ['une clé de préfixe', [{ imports: { 'lib/': './libs/' } }], 'app.js', 'lib/x/y.js'],
  ['le nom du préfixe seul ne correspond pas au préfixe', [{ imports: { 'lib/': './libs/' } }], 'app.js', 'lib'],
  ['le plus long préfixe l\'emporte', [{ imports: { 'a/': './un/', 'a/b/': './deux/' } }], 'app.js', 'a/b/c.js'],
  ['le préfixe le plus court, quand le plus long ne commence pas le nom', [{ imports: { 'a/': './un/', 'a/b/': './deux/' } }], 'app.js', 'a/c.js'],
  ['la clé exacte l\'emporte sur un préfixe', [{ imports: { 'a/': './un/', 'a/b.js': './exact.js' } }], 'app.js', 'a/b.js'],
  ['un préfixe dont l\'adresse ne finit pas par une barre est une erreur', [{ imports: { 'lib/': './libs' } }], 'app.js', 'lib/x.js'],
  ['un nom qui sort du dossier du préfixe par `..` est une erreur', [{ imports: { 'lib/': './libs/' } }], 'app.js', 'lib/../secret.js'],
  ['une adresse `null` bloque le nom', [{ imports: { lib: null } }], 'app.js', 'lib'],
  ['une adresse qui n\'est pas une chaîne bloque le nom', [{ imports: { lib: 42 } }], 'app.js', 'lib'],
  ['une adresse relative nue n\'est pas une adresse : le nom est bloqué', [{ imports: { lib: 'vendor/lib.js' } }], 'app.js', 'lib'],
  ['une adresse absolue hors du widget', [{ imports: { lib: 'https://cdn.example/lib.js' } }], 'app.js', 'lib'],
  ['une portée : le module de ce dossier voit sa table', [{ imports: { x: './haut.js' }, scopes: { './sub/': { x: './portee.js' } } }], 'sub/m.js', 'x'],
  ['une portée : un module d\'ailleurs voit la table du dessus', [{ imports: { x: './haut.js' }, scopes: { './sub/': { x: './portee.js' } } }], 'm.js', 'x'],
  ['une portée dont la table ne nomme pas le nom : celle du dessus', [{ imports: { x: './haut.js' }, scopes: { './sub/': { y: './y.js' } } }], 'sub/m.js', 'x'],
  ['deux portées imbriquées qui nomment le nom : Chromium en retient une, l\'outil les garde toutes', [{ scopes: { './sub/': { x: './court.js' }, './sub/deep/': { x: './long.js' } } }], 'sub/deep/m.js', 'x', { libre: true, retenue: 'court.js' }],
  ['deux portées imbriquées, l\'autre paire : la plus longue', [{ scopes: { './sub/': { x: './court.js' }, './sub/d/': { x: './long.js' } } }], 'sub/d/m.js', 'x', { libre: true, retenue: 'long.js' }],
  ['deux portées imbriquées dont la longue ne nomme pas le nom : la courte', [{ scopes: { './sub/': { x: './court.js' }, './sub/deep/': { y: './y.js' } } }], 'sub/deep/m.js', 'x'],
  ['une portée sans barre finale ne vaut que pour l\'adresse exacte', [{ scopes: { './sub/m.js': { x: './exacte.js' } } }], 'sub/m.js', 'x'],
  ['une portée sans barre finale ne vaut pas pour un autre module du dossier', [{ scopes: { './sub/m.js': { x: './exacte.js' } } }], 'sub/n.js', 'x'],
  ['une portée sans barre finale ne vaut pas pour l\'adresse qu\'elle ne fait que commencer', [{ imports: { x: './haut.js' }, scopes: { './sub/m': { x: './portee.js' } } }], 'sub/m.js', 'x'],
  ['une clé qui est une adresse remappe celle que le module écrit', [{ imports: { './a.js': './b.js' } }], 'app.js', './a.js'],
  ['une adresse relative se compare résolue depuis le module', [{ imports: { './a.js': './b.js' } }], 'sub/app.js', './a.js'],
  ['une clé en adresse absolue', [{ imports: { 'https://cdn.example/x.js': './local.js' } }], 'app.js', 'https://cdn.example/x.js'],
  ['une adresse absolue qu\'aucune clé ne remappe est elle-même', [{ imports: { lib: './lib.js' } }], 'app.js', 'https://cdn.example/y.js'],
  ['deux cartes : la première qui nomme une clé l\'emporte', [{ imports: { lib: './un.js' } }, { imports: { lib: './deux.js', autre: './autre.js' } }], 'app.js', 'lib'],
  ['deux cartes : une clé que la seconde seule nomme s\'ajoute', [{ imports: { lib: './un.js' } }, { imports: { lib: './deux.js', autre: './autre.js' } }], 'app.js', 'autre'],
  ['un script de la page : la base du document', [{ imports: { './x.js': './y.js' } }], null, './x.js', { base: '/base/' }],
  ['un script de la page : un nom', [{ imports: { lib: './vendor/lib.js' } }], null, 'lib'],
  ['une portée au nom de la page, pour son script inline', [{ scopes: { './': { lib: './portee.js' } } }], null, 'lib'],
  ['une clé de préfixe en adresse absolue s\'applique aux adresses qui la commencent', [{ imports: { 'https://cdn.example/lib/': './local/' } }], 'app.js', 'https://cdn.example/lib/x.js'],
  ['une adresse d\'un schéma qui n\'est pas spécial ne s\'apparie à aucun préfixe', [{ imports: { 'data:text/': './x/' } }], 'app.js', 'data:text/javascript,0'],
  ['une clé vide est ignorée', [{ imports: { '': './x.js' } }], 'app.js', ''],
  ['deux clés qui se normalisent en la même adresse : la dernière de l\'objet l\'emporte', [{ imports: { './a.js': './un.js', '/a.js': './deux.js' } }], 'app.js', './a.js'],
  ['une portée dont la table bloque le nom ferme la résolution', [{ imports: { x: './haut.js' }, scopes: { './sub/': { x: null } } }], 'sub/m.js', 'x'],
  ['une portée dont le préfixe bloque le nom ferme la résolution', [{ imports: { 'lib/x.js': './haut.js' }, scopes: { './sub/': { 'lib/': null } } }], 'sub/m.js', 'lib/x.js'],
  ['une clé qui est une adresse se compare résolue contre la base de la carte', [{ imports: { './a.js': './b.js' } }], null, './a.js', { base: '/base/' }],
  ['une adresse de valeur se résout contre la base de la carte', [{ imports: { lib: './vendor/lib.js' } }], 'app.js', 'lib', { base: '/base/' }],
  ['le préfixe exact d\'un nom nu : la clé seule ne s\'apparie pas, le nom avec son dossier oui', [{ imports: { 'lib/': './libs/' } }], 'app.js', 'lib/'],
  ['une adresse en tableau bloque le nom', [{ imports: { lib: ['./a.js'] } }], 'app.js', 'lib'],
  ['un préfixe ne s\'apparie qu\'au début du nom', [{ imports: { 'b/': './x/' } }], 'app.js', 'a/b/c.js'],
  ['une clé sans barre finale ne sert pas de préfixe', [{ imports: { li: './vendor/' } }], 'app.js', 'lib/x.js'],
  ['un préfixe bloqué par `null` ne laisse pas la main à un préfixe plus court', [{ imports: { 'a/': './un/', 'a/b/': null } }], 'app.js', 'a/b/c.js'],
  ['une clé de préfixe en `http:`', [{ imports: { 'http://h.example/lib/': './local/' } }], 'app.js', 'http://h.example/lib/x.js'],
  ['une clé de préfixe en `ws:`', [{ imports: { 'ws://h.example/lib/': './local/' } }], 'app.js', 'ws://h.example/lib/x.js'],
  ['une clé de préfixe en `wss:`', [{ imports: { 'wss://h.example/lib/': './local/' } }], 'app.js', 'wss://h.example/lib/x.js'],
  ['une clé de préfixe en `ftp:`', [{ imports: { 'ftp://h.example/lib/': './local/' } }], 'app.js', 'ftp://h.example/lib/x.js'],
  ['une clé de préfixe en `file:`', [{ imports: { 'file:///lib/': './local/' } }], 'app.js', 'file:///lib/x.js'],
];

test('le résolveur de cartes d\'import rend ce que Chromium rend pour le même nom, la même carte et le même module', async (t) => {
  const executable = cheminChromium();
  if (!executable) { chromiumIndisponible(t, 'aucun Chromium lançable (voir GWAUDIT_CHROMIUM_PATH)'); return; }
  const navigateur = await chromium.launch({ executablePath: executable, args: process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  try {
    for (const [nom, cartes, referent, specificateur, { base, libre = false, retenue } = {}] of CAS) {
      const sonde = `window.__resolu = (() => { try { return import.meta.resolve(${JSON.stringify(specificateur)}); } catch { return '${ERREUR}'; } })();`;
      const accueil = `<!doctype html><meta charset=utf-8>${base ? `<base href="${base}">` : ''}${cartes.map((c) => `<script type="importmap">${JSON.stringify(c)}</script>`).join('')}${referent === null ? `<script type="module">${sonde}</script>` : `<script type="module" src="/${referent}"></script>`}`;
      const contexte = await navigateur.newContext();
      try {
        await contexte.route(`${ORIGINE_LOCALE}/**`, (route) => {
          const { pathname } = new URL(route.request().url());
          if (pathname === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: accueil });
          if (referent !== null && pathname === `/${referent}`) return route.fulfill({ status: 200, contentType: 'text/javascript', body: sonde });
          return route.fulfill({ status: 404, body: '' });
        });
        const onglet = await contexte.newPage();
        await onglet.goto(`${ORIGINE_LOCALE}/index.html`);
        const chromiumDit = await onglet.evaluate(() => window.__resolu);
        assert.ok(chromiumDit, `${nom} : le module a bien tourné dans Chromium`);
        const resolveur = resolveurDeCartes(accueil, 'index.html');
        const possibles = (resolveur ? resolveur.resoudre(specificateur, referent === null ? { chemin: 'index.html', baseBrute: base ?? null } : { chemin: referent, baseBrute: null }) : []).map((u) => u.href);
        if (libre) {
          assert.ok(possibles.length > 1, `${nom} : l'outil garde les adresses de toutes les portées qui nomment le nom (${possibles.join(' ')})`);
          assert.ok(possibles.includes(chromiumDit), `${nom} : Chromium retient l'une d'elles (${chromiumDit} parmi ${possibles.join(' ')})`);
          if (retenue) assert.equal(chromiumDit, `${ORIGINE_LOCALE}/${retenue}`, `${nom} : ce que Chromium 141 retient ; s'il change, la mention de \`resolveurDeCartes\` sur l'ordre des portées est à revoir`);
        } else {
          assert.deepEqual(possibles, chromiumDit === ERREUR ? [] : [chromiumDit], `${nom} : l'outil résout « ${specificateur} » comme Chromium`);
        }
      } finally {
        await contexte.close();
      }
    }
  } finally {
    await navigateur.close();
  }
});

test('une page sans carte, ou dont les cartes ne portent aucune clé, n\'a pas de résolveur', () => {
  assert.equal(resolveurDeCartes('<!doctype html><p>x</p>', 'index.html'), null);
  assert.equal(resolveurDeCartes('<script type="importmap">{"integrity":{"https://x.test/a.js":"sha384-AAAA"}}</script>', 'index.html'), null);
  assert.equal(resolveurDeCartes('<script type="importmap">{ pas du json</script>', 'index.html'), null);
  assert.notEqual(resolveurDeCartes('<script type="importmap">{"imports":{"a":"./a.js"}}</script>', 'index.html'), null);
});
