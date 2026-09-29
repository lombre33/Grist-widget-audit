#!/usr/bin/env node
/**
 * Enregistre ce que Chromium demande vraiment d'une page, dans
 * `tests/fixtures/chromium-141-chargements.json`, que `tests/passe-html-css.test.mjs`
 * rejoue contre `chargementsDeFichier`.
 *
 * Un serveur de sonde sert chaque page à `/p/<nom>` (sans jamais la noter : la
 * sonde est aveugle sur la page elle-même, d'où les `<base>` vers `/r/z/` des
 * cas où une URL vide se résout vers la page) et note tout autre chemin
 * demandé, dans l'ordre. `HOTE` dans une page est remplacé par l'hôte réel de
 * la sonde ; il l'est aussi dans ce qui a été demandé, pour que
 * l'enregistrement ne dépende pas du port.
 *
 * Seules les sondes définies ici sont rejouables par ce script (celles de
 * `SONDES`) ; les vingt-quatre premières de l'enregistrement viennent d'un
 * script qui n'a pas été gardé : elles ne se rejouent pas, elles se lisent.
 *
 * Usage :
 *   GWAUDIT_CHROMIUM_PATH=/chemin/vers/chromium node scripts/enregistrer-sonde-chromium.mjs            # enregistre
 *   GWAUDIT_CHROMIUM_PATH=/chemin/vers/chromium node scripts/enregistrer-sonde-chromium.mjs --verifier # compare, n'écrit rien (code 1 si un écart)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(RACINE, 'tests/fixtures/chromium-141-chargements.json');
const ATTENTE_MS = 300;

// Les caractères sont construits, jamais tapés : un outil qui les convertirait changerait la sonde sans le dire.
const NBSP = String.fromCharCode(0xa0);
const NEL = String.fromCharCode(0x85);
const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const IDEO = String.fromCharCode(0x3000);
const C0 = String.fromCharCode(1);
const BASE = '<base href="http://HOTE/r/z/">';
const DOC = '<!doctype html><meta charset=utf-8>';

/** Une feuille `data:` dont l'`@import` est la balise : elle n'est demandée que si l'URL est bien lue comme `data:`. */
const donnees = (nom) => `data:text/css,@import 'http://HOTE/r/${nom}.css';`;
const autres = [['nbsp', NBSP], ['nel', NEL], ['zwsp', ZWSP], ['bom', BOM], ['ideo', IDEO]];

/**
 * nom de sonde → { decoder, aveugle, cas: [[nom, html]] } ; `decoder` compare des
 * chemins décodés (`decodeURIComponent`), sinon le chemin et la requête tels
 * que demandés.
 */
const SONDES = {
  'sonde-data-blancs': {
    decoder: false,
    aveugle: true,
    cas: [
      // Ce que l'analyseur d'URL retire en tête (contrôles C0 et espace) : l'URL est bien `data:`, son @import est demandé.
      ['imp-data-nu', `${DOC}<style>@import url("${donnees('d1')}");</style>`],
      ['imp-data-espace-avant', `${DOC}<style>@import url(" ${donnees('d2')}");</style>`],
      ['imp-data-tab-avant', `${DOC}<style>@import url("\t${donnees('d3')}");</style>`],
      ['imp-data-c0-avant', `${DOC}<style>@import url("${C0}${donnees('d4')}");</style>`],
      ['imp-data-schema-majuscules', `${DOC}<style>@import url("DATA:${donnees('d5').slice('data:'.length)}");</style>`],
      ['imp-data-nbsp-apres', `${DOC}<style>@import url("${donnees('d6')}${NBSP}");</style>`],
      ['imp-data-chaine-nue', `${DOC}<style>@import "${donnees('d7')}";</style>`],
      // Ce qu'il ne retire pas (espace insécable, NEL, espace de largeur nulle, BOM, espace idéographique) : l'URL est relative, elle se résout contre la base, rien d'imbriqué n'est demandé.
      ...autres.map(([n, c], i) => [`imp-data-${n}-avant`, `${DOC}${BASE}<style>@import url("${c}${donnees(`e${i}`)}");</style>`]),
      // Les mêmes, pour un <link>.
      ['lien-data-nu', `${DOC}<link rel=stylesheet href="${donnees('f1')}">`],
      ['lien-data-espace-avant', `${DOC}<link rel=stylesheet href=" ${donnees('f2')}">`],
      ['lien-data-c0-avant', `${DOC}<link rel=stylesheet href="${C0}${donnees('f3')}">`],
      ...autres.map(([n, c], i) => [`lien-data-${n}-avant`, `${DOC}${BASE}<link rel=stylesheet href="${c}${donnees(`g${i}`)}">`]),
      // Dans une déclaration, `data:` est une image (rien à charger) et une URL qui n'en est pas une est relative.
      ['decl-data-espace-avant', `${DOC}<style>*{background:url(" ${donnees('h1')}")}</style><div>x</div>`],
      ['decl-data-nbsp-avant', `${DOC}${BASE}<style>*{background:url("${NBSP}${donnees('h2')}")}</style><div>x</div>`],
      // `srcset` d'un préchargement : virgules finales retirées, virgule interne gardée.
      ['srcset-virgule-finale', `${DOC}<link rel=preload as=image imagesrcset="http://HOTE/r/s1.png,">`],
      ['srcset-virgules-finales', `${DOC}<link rel=preload as=image imagesrcset="http://HOTE/r/s2.png,,,">`],
      ['srcset-virgule-interne', `${DOC}<link rel=preload as=image imagesrcset="http://HOTE/r/s3.png,1x">`],
      ['srcset-virgule-finale-descripteur', `${DOC}<link rel=preload as=image imagesrcset="http://HOTE/r/s4.png 1x,">`],
    ],
  },
};

const cheminChromium = () => {
  const impose = process.env.GWAUDIT_CHROMIUM_PATH;
  if (impose) return fs.existsSync(impose) ? impose : null;
  const defaut = chromium.executablePath();
  return fs.existsSync(defaut) ? defaut : null;
};

async function enregistrer(navigateur, sonde) {
  const demandes = [];
  const pages = new Map(sonde.cas);
  let hote = '';
  const serveur = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    res.setHeader('cache-control', 'no-store');
    if (pathname === '/favicon.ico') { res.statusCode = 404; res.end(); return; }
    if (pathname.startsWith('/p/') && pages.has(pathname.slice(3))) {
      res.setHeader('content-type', 'text/html');
      res.end(pages.get(pathname.slice(3)).replaceAll('HOTE', hote));
      return;
    }
    demandes.push(req.url);
    res.setHeader('content-type', 'text/css');
    res.end('');
  });
  await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
  hote = `127.0.0.1:${serveur.address().port}`;
  const normalise = (chemin) => {
    const sansHote = chemin.replaceAll(hote, 'HOTE');
    if (!sonde.decoder) return sansHote;
    try { return decodeURIComponent(new URL(sansHote, 'http://x').pathname); } catch { return sansHote; }
  };
  try {
    const cas = [];
    for (const [nom, html] of sonde.cas) {
      demandes.length = 0;
      const contexte = await navigateur.newContext();
      const onglet = await contexte.newPage();
      await onglet.goto(`http://${hote}/p/${nom}`, { waitUntil: 'load' });
      await onglet.waitForLoadState('networkidle');
      await onglet.waitForTimeout(ATTENTE_MS);
      await contexte.close();
      cas.push({ nom, page: `/p/${nom}`, html, charge: [...new Set(demandes.map(normalise))] });
    }
    return { decoder: sonde.decoder, aveugle: sonde.aveugle, cas };
  } finally {
    serveur.close();
  }
}

const verifier = process.argv.includes('--verifier');
const executable = cheminChromium();
if (!executable) {
  console.error('Aucun Chromium lançable (voir GWAUDIT_CHROMIUM_PATH) : rien à enregistrer.');
  process.exit(2);
}
const navigateur = await chromium.launch({ executablePath: executable });
let code = 0;
try {
  const version = navigateur.version();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  if (fixture.chromium !== version) {
    console.error(`Chromium ${version} n'est pas celui de l'enregistrement (${fixture.chromium}) : ${verifier ? 'les écarts ne prouvent rien de la version enregistrée' : 'les sondes définies ici seraient enregistrées avec une autre version que les vingt-quatre premières'}.`);
    if (!verifier) process.exit(2);
    code = 2;
  }
  for (const [nom, sonde] of Object.entries(SONDES)) {
    const lu = await enregistrer(navigateur, sonde);
    if (!verifier) { fixture.sondes[nom] = lu; console.log(`${nom} : ${lu.cas.length} cas enregistrés`); continue; }
    const attendu = fixture.sondes[nom];
    if (!attendu) { console.error(`${nom} : absente de l'enregistrement`); code = code || 1; continue; }
    const ecarts = [];
    if (attendu.cas.length !== lu.cas.length) ecarts.push(`${attendu.cas.length} cas enregistrés, ${lu.cas.length} définis`);
    for (const c of lu.cas) {
      const a = attendu.cas.find((x) => x.nom === c.nom);
      if (!a) { ecarts.push(`${c.nom} : absent de l'enregistrement`); continue; }
      if (a.html !== c.html) ecarts.push(`${c.nom} : la page enregistrée n'est plus celle qui est définie`);
      if (JSON.stringify([...a.charge].sort()) !== JSON.stringify([...c.charge].sort())) ecarts.push(`${c.nom} : enregistré ${JSON.stringify(a.charge)}, Chromium demande ${JSON.stringify(c.charge)}`);
    }
    console.log(`${nom} : ${ecarts.length ? `${ecarts.length} écart(s)` : `${lu.cas.length} cas identiques à l'enregistrement`}`);
    for (const e of ecarts) console.log(`  - ${e}`);
    if (ecarts.length) code = code || 1;
  }
  if (!verifier) fs.writeFileSync(FIXTURE, JSON.stringify(fixture)); // compact, sans saut de ligne final : le format de l'enregistrement existant
} finally {
  await navigateur.close();
}
process.exit(code);
