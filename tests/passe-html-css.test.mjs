import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chargementsDeFichier, analyserRessourcesExternes, extraitAutour } from '../src/regles/c-securite.js';
import { lirePage, usageLien, candidatsSrcset } from '../src/moteur/page-html.js';
import { decoderUrlData, lireCss, lireFeuille, lirePrechargement, LIMITES_CSS } from '../src/moteur/css.js';

/**
 * Étape 2a de la passe unique du découpeur : le CSS écrit dans une page (et les
 * fichiers `.css`) est de nouveau lu, cette fois par un lecteur qui suit
 * Chromium, et chaque `<link>` est classé par ce que le navigateur en fait.
 *
 * `tests/fixtures/chromium-141-chargements.json` est un enregistrement : pour
 * chaque page essayée dans Chromium 141.0.7390.37 (29 septembre 2026, un
 * serveur de sonde qui note chaque requête reçue), la liste des chemins que le
 * navigateur a réellement demandés. Le test rejoue ces pages dans
 * `chargementsDeFichier` — la fonction même qui alimente C-EXFIL-03 — et
 * compare les deux listes. Il ne prouve que ce qu'il compare : l'enregistrement
 * ne dit rien des pages qu'on n'a pas essayées, et il est aveugle sur les
 * chemins de la page elle-même (`/p/…` : le serveur répond à la page avant de
 * noter, une prédiction qui pointe là ne se vérifie pas ; ce sont des chemins
 * locaux, jamais un constat).
 *
 * Deux sortes d'écart, jamais confondues : un `manque` (le navigateur demande
 * quelque chose que l'analyse ne liste pas : un trou) et un `faux` (l'analyse
 * liste avec certitude ce que le navigateur ne demande pas : un faux constat).
 * Hors de `LIMITES`, aucun n'est toléré. `LIMITES` nomme chaque écart connu
 * avec sa forme exacte : si l'un change (un trou se comble, un faux
 * apparaît), le test échoue et oblige à mettre la table à jour. Une entrée
 * qui n'est plus un écart doit disparaître.
 */

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/chromium-141-chargements.json', import.meta.url), 'utf8'));

const fichier = (chemin, contenu, extra = {}) => ({ chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra });
const exfil = (html, extra) => analyserRessourcesExternes({ fichiers: [fichier('index.html', html, extra)] }).filter((c) => c.regle === 'C-EXFIL-03');
const exfilFichiers = (fichiers) => analyserRessourcesExternes({ fichiers }).filter((c) => c.regle === 'C-EXFIL-03');
const b64 = (s) => Buffer.from(s).toString('base64');

// ---------------------------------------------------------------------------
// Rejeu de l'enregistrement Chromium
// ---------------------------------------------------------------------------

const HOTE = 'hote';

/**
 * Les chemins que l'analyse déclare charger (`sur` : certains ; `peut` :
 * conditionnels, notés `probable`), résolus comme le navigateur contre l'URL de
 * la page de la sonde. Les URL non http(s) (`data:`) et les connexions
 * anticipées (`preconnect`, jamais observées) n'y figurent pas.
 */
function chemins(entrees, page, decoder) {
  const sur = new Set();
  const peut = new Set();
  for (const e of entrees) {
    if (e.borne || e.connexion) continue;
    let u;
    try { u = new URL(e.url, e.baseBrute == null ? page : new URL(e.baseBrute.trim(), page)); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    (e.confiance === 'probable' ? peut : sur).add(decoder ? decodeURIComponent(u.pathname) : u.pathname + u.search);
  }
  return { sur, peut };
}

function ecarts(sonde) {
  const { decoder, aveugle, cas } = fx.sondes[sonde];
  const trouves = {};
  for (const c of cas) {
    const page = new URL(`http://${HOTE}${c.page}`);
    const html = c.html.replaceAll('HOTE', HOTE);
    const { sur, peut } = chemins(chargementsDeFichier(fichier('index.html', html)), page, decoder);
    const attendu = new Set(c.charge.map((x) => x.replace('HOTE', HOTE)));
    const manques = [...attendu].filter((x) => !sur.has(x) && !peut.has(x));
    const faux = [...sur].filter((x) => !attendu.has(x) && !(aveugle && x.startsWith('/p/')));
    if (manques.length || faux.length) trouves[c.nom] = `${manques.length ? 'manque' : ''}${manques.length && faux.length ? '+' : ''}${faux.length ? 'faux' : ''}`;
  }
  return trouves;
}

/** Vecteurs de chargement que l'analyse ne lit pas encore (étape 2b) : le navigateur demande, l'analyse ne liste pas. */
const NON_LUS_2B = {
  'sonde-lien12': [
    'img-srcset-seul', 'img-srcset-virgule-url', 'video-source', 'video-src', 'video-poster', 'video-poster-src', 'audio-src', 'audio-source', 'track',
    'input-image', 'input-image-maj', 'body-bg', 'table-bg', 'td-bg', 'tr-bg', 'th-bg', 'tbody-bg',
    'image-tag', 'svg-image', 'svg-image-xlink', 'svg-feimage', 'svg-feimage-inutilise', 'svg-use',
    'svg-fill-attr', 'svg-filter-attr', 'svg-mask-attr', 'svg-clip-attr', 'svg-marker-attr', 'svg-cursor-attr',
    'meta-refresh', 'frame', 'spec-prefetch', 'input-dynsrc',
  ],
  'sonde-css': ['url-attribut-presentation-svg', 'url-attribut-presentation-cursor', 'url-mask-attribut-svg', 'url-bgcolor-image-attr', 'url-attr-body-background'],
};

/** Étape 2b encore : `srcset` lu partiellement (l'image `src` est déclarée alors que `srcset` la remplace). */
const SRCSET_2B = { 'sonde-lien12': { 'img-src-srcset': 'manque+faux', 'img-srcset-w': 'manque+faux', pic: 'manque+faux' } };

/** Documents imbriqués dont le contenu s'exécute (étape 2c) : `srcdoc` et `data:text/html` embarquent une page entière. */
const DOCUMENTS_2C = { 'sonde-css-4': ['nu-srcdoc', 'nu-data-html'] };

/**
 * Surdéclarations voulues : l'analyse liste toutes les images candidates d'un
 * `srcset` de `<link rel=preload>` (l'écran en choisit une, le widget n'en
 * maîtrise aucune) et une image `loading=lazy` que la sonde n'a pas fait
 * défiler (le navigateur la demande au défilement).
 */
const SURDECLARATIONS = { 'sonde-lien12': ['pl-srcset-1x2x', 'pl-srcset-w', 'img-loading-lazy-hors'] };

/**
 * Trou connu, hors de la page : la sonde sert une feuille `/t/quirks-http`
 * sans extension, en `text/plain`. En quirks, Chromium la lit comme du CSS
 * malgré le type ; l'analyse ne lit comme feuille que les fichiers `.css`.
 */
const FICHIER_SANS_EXTENSION = { 'sonde-lien4': ['dq-quirks-http-plain'] };

function attendus(sonde) {
  const sortie = {};
  for (const nom of NON_LUS_2B[sonde] ?? []) sortie[nom] = 'manque';
  Object.assign(sortie, SRCSET_2B[sonde]);
  for (const nom of DOCUMENTS_2C[sonde] ?? []) sortie[nom] = 'manque';
  for (const nom of SURDECLARATIONS[sonde] ?? []) sortie[nom] = 'faux';
  for (const nom of FICHIER_SANS_EXTENSION[sonde] ?? []) sortie[nom] = 'manque';
  return sortie;
}

test("l'enregistrement Chromium est là : version, sondes et nombre de cas", () => {
  assert.equal(fx.chromium, '141.0.7390.37');
  const noms = Object.keys(fx.sondes);
  assert.ok(noms.length >= 20, `${noms.length} sondes`);
  const total = noms.reduce((n, s) => n + fx.sondes[s].cas.length, 0);
  assert.ok(total >= 890, `${total} cas : l'enregistrement a été tronqué`);
  for (const s of noms) assert.ok(fx.sondes[s].cas.length > 0, s);
});

for (const sonde of Object.keys(fx.sondes)) {
  test(`${sonde} : l'analyse liste ce que Chromium demande (aucun faux constat, aucun trou hors limites connues)`, () => {
    assert.deepEqual(ecarts(sonde), attendus(sonde));
  });
}

test('chaque limite connue nomme un cas qui existe dans l\'enregistrement', () => {
  for (const table of [NON_LUS_2B, SRCSET_2B, DOCUMENTS_2C, SURDECLARATIONS, FICHIER_SANS_EXTENSION]) {
    for (const [sonde, noms] of Object.entries(table)) {
      const existants = new Set(fx.sondes[sonde].cas.map((c) => c.nom));
      for (const nom of Array.isArray(noms) ? noms : Object.keys(noms)) assert.ok(existants.has(nom), `${sonde}/${nom}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Classement des <link> (usageLien)
// ---------------------------------------------------------------------------

const attrs = (o) => new Map(Object.entries(o));
const genres = (o) => usageLien(attrs(o)).map((u) => u.genre);

test('usageLien : les jetons de rel se lisent séparés par des blancs ASCII, sans tenir compte de la casse', () => {
  assert.deepEqual(genres({ rel: 'stylesheet', href: 'a.css' }), ['feuille']);
  assert.deepEqual(genres({ rel: 'STYLESHEET', href: 'a.css' }), ['feuille']);
  assert.deepEqual(genres({ rel: '\tstylesheet\n', href: 'a.css' }), ['feuille']);
  assert.deepEqual(genres({ rel: 'alternate stylesheet', href: 'a.css' }), ['feuille'], 'une feuille alternative est chargée quand même');
  assert.deepEqual(genres({ rel: 'shortcut icon', href: 'a.ico' }), ['icone']);
  assert.deepEqual(genres({ rel: 'stylesheet icon', href: 'a.css' }), ['feuille', 'icone']);
  assert.deepEqual(genres({ rel: 'stylesheet-x', href: 'a.css' }), []);
});

test('usageLien : ce qui ne charge rien', () => {
  for (const rel of ['canonical', 'alternate', 'manifest', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'author', 'help', 'license', 'next', 'prev', 'search', 'import', 'bookmark', 'me', 'pingback']) {
    assert.deepEqual(genres({ rel, href: 'https://tiers.example/x' }), [], rel);
  }
});

test('usageLien : type d\'une feuille (vide, absent ou text/css, coupé au premier point-virgule)', () => {
  const t = (type) => genres({ rel: 'stylesheet', href: 'a.css', ...(type === undefined ? {} : { type }) });
  assert.deepEqual(t(undefined), ['feuille']);
  assert.deepEqual(t(''), ['feuille']);
  assert.deepEqual(t('text/css'), ['feuille']);
  assert.deepEqual(t('TEXT/CSS'), ['feuille']);
  assert.deepEqual(t('text/css; charset=utf-8'), ['feuille']);
  assert.deepEqual(t(' text/css '), ['feuille']);
  assert.deepEqual(t('text/plain'), []);
  assert.deepEqual(t('text/css2'), []);
  assert.deepEqual(t('x/text/css'), []);
});

test('usageLien : href absent, vide ou fait de blancs ne charge rien', () => {
  assert.deepEqual(genres({ rel: 'stylesheet' }), []);
  assert.deepEqual(genres({ rel: 'stylesheet', href: '' }), []);
  assert.deepEqual(genres({ rel: 'stylesheet', href: ' \t\n' }), []);
  assert.deepEqual(genres({ rel: 'icon', href: '' }), []);
});

test('usageLien : preload ne charge que pour un as qui désigne une ressource', () => {
  for (const as of ['script', 'style', 'font', 'image', 'fetch', 'track', 'SCRIPT']) assert.deepEqual(genres({ rel: 'preload', href: 'x', as }), ['precharge'], as);
  for (const as of [undefined, '', 'document', 'audio', 'video', 'worker', 'embed', 'object', 'inconnu']) {
    assert.deepEqual(genres({ rel: 'preload', href: 'x', ...(as === undefined ? {} : { as }) }), [], String(as));
  }
});

test('usageLien : preload as=image avec imagesrcset prend les candidats du srcset, pas href', () => {
  const [u] = usageLien(attrs({ rel: 'preload', as: 'image', href: 'https://h.example/a.png', imagesrcset: 'https://h.example/b.png 1x, https://h.example/c.png 2x' }));
  assert.deepEqual(u.urls, ['https://h.example/b.png', 'https://h.example/c.png']);
  const [v] = usageLien(attrs({ rel: 'preload', as: 'image', href: 'https://h.example/a.png', imagesrcset: '   ' }));
  assert.deepEqual(v.urls, ['https://h.example/a.png'], 'un imagesrcset blanc ne remplace pas href');
  const [w] = usageLien(attrs({ rel: 'preload', as: 'script', href: 'https://h.example/a.js', imagesrcset: 'https://h.example/b.png 1x' }));
  assert.deepEqual(w.urls, ['https://h.example/a.js'], 'imagesrcset ne compte que pour as=image');
});

test('usageLien : modulepreload, prefetch, prerender chargent ; preconnect et dns-prefetch sont des connexions', () => {
  assert.deepEqual(genres({ rel: 'modulepreload', href: 'x' }), ['modulepreload']);
  assert.deepEqual(genres({ rel: 'prefetch', href: 'x' }), ['prefetch']);
  assert.deepEqual(genres({ rel: 'prerender', href: 'x' }), ['prerender']);
  assert.deepEqual(genres({ rel: 'preconnect', href: 'https://h.example' }), ['connexion']);
  assert.deepEqual(genres({ rel: 'dns-prefetch', href: '//h.example' }), ['connexion']);
});

// ---------------------------------------------------------------------------
// srcset
// ---------------------------------------------------------------------------

test('candidatsSrcset : lit les candidats comme le standard', () => {
  assert.deepEqual(candidatsSrcset(''), []);
  assert.deepEqual(candidatsSrcset('a.png 1x, b.png 2x'), ['a.png', 'b.png']);
  assert.deepEqual(candidatsSrcset('a.png 100w,b.png 200w'), ['a.png', 'b.png']);
  assert.deepEqual(candidatsSrcset('a.png, b.png'), ['a.png', 'b.png'], 'sans descripteur, la virgule de fin sépare');
  assert.deepEqual(candidatsSrcset('a.png,1x 1x, b.png 2x'), ['a.png,1x', 'b.png'], 'une virgule interne à l\'URL reste dans l\'URL');
  assert.deepEqual(candidatsSrcset('1x'), ['1x'], 'un seul jeton est une URL sans descripteur');
  assert.deepEqual(candidatsSrcset('a.png 1x 2w'), [], 'w et x ensemble : candidat écarté');
  assert.deepEqual(candidatsSrcset('a.png 1x 2x'), [], 'deux densités : candidat écarté');
  assert.deepEqual(candidatsSrcset('a.png 0w'), [], 'largeur nulle : candidat écarté');
  assert.deepEqual(candidatsSrcset('a.png (1x, 2x), b.png 1x'), ['b.png'], 'une virgule entre parenthèses ne sépare rien');
});

// ---------------------------------------------------------------------------
// Mode du document (quirks)
// ---------------------------------------------------------------------------

test('lirePage : le mode quirks suit le doctype, comme Chromium (sonde-lien5)', () => {
  const quirks = (html) => lirePage(html).quirks;
  assert.equal(quirks('<!doctype html><p>x'), false);
  assert.equal(quirks('<p>x'), true, 'sans doctype');
  assert.equal(quirks(''), true, 'page vide');
  assert.equal(quirks('<!-- c -->\n <!doctype html><p>'), false, 'commentaires et blancs avant le doctype ne comptent pas');
  assert.equal(quirks('<p><!doctype html>'), true, 'une balise avant le doctype');
  assert.equal(quirks('x<!doctype html>'), true, 'du texte avant le doctype');
  assert.equal(quirks('<!doctype html><!doctype html public "-//W3C//DTD HTML 4.01//EN">'), false, 'le second doctype est ignoré');
  assert.equal(quirks('<!doctype foo>'), true);
  assert.equal(quirks('<!doctype html public "-//W3C//DTD HTML 4.01 Transitional//EN">'), true, 'transitional sans identifiant système : quirks');
  assert.equal(quirks('<!doctype html public "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">'), false, 'avec identifiant système : quirks limité, pas quirks');
  assert.equal(quirks('<!doctype html system "about:legacy-compat">'), false);
  assert.equal(quirks('<!doctype'), true, 'doctype jamais fermé');
});

// ---------------------------------------------------------------------------
// data: décodé comme Chromium
// ---------------------------------------------------------------------------

test('decoderUrlData : décodage, base64 indulgent, fragment coupé, base64 refusé', () => {
  assert.equal(decoderUrlData('https://h.example/x'), null);
  assert.deepEqual(decoderUrlData('data:text/css,a%20b'), { mime: 'text/css', corps: 'a b' });
  assert.deepEqual(decoderUrlData('data:,x'), { mime: 'text/plain', corps: 'x' });
  assert.deepEqual(decoderUrlData('DATA:Text/CSS;charset=x,a'), { mime: 'text/css', corps: 'a' });
  assert.deepEqual(decoderUrlData(`data:text/css;base64,${b64('a{}')}`), { mime: 'text/css', corps: 'a{}' });
  assert.deepEqual(decoderUrlData(`data:text/css;base64,${b64('a{}').replace(/(.{2})/g, '$1 ')}`), { mime: 'text/css', corps: 'a{}' }, 'blancs ASCII retirés du base64');
  assert.equal(decoderUrlData('data:text/css;base64,a-b_').invalide, true, 'alphabet URL-safe refusé : rien n\'est chargé');
  assert.equal(decoderUrlData('data:text/css;base64,abcde').invalide, true, 'reste de 1 modulo 4 refusé');
  assert.deepEqual(decoderUrlData('data:text/css,a#b'), { mime: 'text/css', corps: 'a' }, 'fragment coupé');
  assert.deepEqual(decoderUrlData('data:text/css,a%23b'), { mime: 'text/css', corps: 'a#b' }, '%23 est décodé, il ne coupe pas');
  assert.deepEqual(decoderUrlData('  \tdata:text/css,a\n\tb \n'), { mime: 'text/css', corps: 'ab' }, 'contrôles de bord et tabulations retirés');
  assert.equal(decoderUrlData('data:text/css,' + 'a'.repeat(100), 10).trop, true, 'au-delà du volume admis');
});

// ---------------------------------------------------------------------------
// Feuilles data: : le type MIME ne compte qu'en quirks, la base est opaque
// ---------------------------------------------------------------------------

const importDataDe = (mime, css, base = '') => `@import url("data:${mime}${base},${encodeURIComponent(css)}");`;
const URL_EVIL = 'https://evil.example/x.css';
const urlsDe = (html) => chargementsDeFichier(fichier('index.html', html)).filter((e) => !e.borne).map((e) => e.url);

test('@import data: de type text/css : relu, ce que la feuille importe est déclaré', () => {
  const urls = urlsDe(`<!doctype html><style>${importDataDe('text/css', `@import url(${URL_EVIL});`)}</style>`);
  assert.ok(urls.includes(URL_EVIL), urls.join(' '));
});

test('@import data: d\'un autre type : relu seulement quand la page est en quirks', () => {
  const css = importDataDe('text/plain', `@import url(${URL_EVIL});`);
  assert.ok(!urlsDe(`<!doctype html><style>${css}</style>`).includes(URL_EVIL), 'standards : le navigateur refuse le type');
  assert.ok(urlsDe(`<style>${css}</style>`).includes(URL_EVIL), 'quirks : le navigateur lit n\'importe quel type');
});

test('feuille <link> data: : type MIME lu en quirks seulement, comme un @import data:', () => {
  const lien = `<link rel=stylesheet href='data:text/plain,${encodeURIComponent(`@import url(${URL_EVIL});`)}'>`;
  assert.ok(!urlsDe(`<!doctype html>${lien}`).includes(URL_EVIL));
  assert.ok(urlsDe(lien).includes(URL_EVIL));
});

test('dans une feuille data: la base est opaque : un @import relatif ne charge rien, un absolu charge', () => {
  const relatif = `<style>${importDataDe('text/css', '@import url(suite.css);')}</style>`;
  assert.deepEqual(urlsDe(relatif).filter((u) => !u.startsWith('data:')), [], 'relatif : rien');
  const absolu = `<style>${importDataDe('text/css', `@import url(${URL_EVIL});`)}</style>`;
  assert.ok(urlsDe(absolu).includes(URL_EVIL));
  const cheminAbsolu = `<style>${importDataDe('text/css', '@import url(/suite.css);')}</style>`;
  assert.deepEqual(urlsDe(cheminAbsolu).filter((u) => !u.startsWith('data:')), [], 'chemin absolu : rien');
});

// ---------------------------------------------------------------------------
// Imbrication de feuilles data: : la borne est dite, jamais un silence
// ---------------------------------------------------------------------------

function chaineData(niveaux, fin = `@import url("${URL_EVIL}");`) {
  let css = fin;
  for (let i = 0; i < niveaux; i++) css = `@import url("data:text/css;base64,${b64(css)}");`;
  return css;
}
const bornes = (html) => chargementsDeFichier(fichier('index.html', html)).filter((e) => e.borne);

// Les nombres sont écrits en clair : la borne mesurée (Chromium suit 40 niveaux, l'analyse s'arrête à 16) ne doit pas suivre une constante qu'on changerait.
test("feuilles data: imbriquées : jusqu'à 16 niveaux sont lus jusqu'au bout", () => {
  assert.equal(LIMITES_CSS.profondeur, 16);
  for (const n of [1, 5, 16]) {
    const html = `<style>${chaineData(n)}</style>`;
    assert.ok(urlsDe(html).includes(URL_EVIL), `${n} niveaux`);
    assert.deepEqual(bornes(html), [], `${n} niveaux : pas de borne`);
  }
});

test("feuilles data: imbriquées : dès le 17e niveau la borne de profondeur est dite (Chromium suit encore, l'analyse s'arrête)", () => {
  for (const n of [17, 20]) {
    const html = `<style>${chaineData(n)}</style>`;
    assert.ok(!urlsDe(html).includes(URL_EVIL), `${n} niveaux : au-delà de la borne`);
    const [b] = bornes(html);
    assert.equal(b?.raison, 'profondeur', `${n} niveaux`);
  }
  const lien = (n) => chargementsDeFichier(fichier('index.html', `<link rel=stylesheet href='data:text/css;base64,${b64(chaineData(n))}'>`));
  assert.equal(lien(17).filter((e) => e.borne)[0]?.raison, 'profondeur', 'même borne pour une feuille <link>');
  assert.deepEqual(lien(16).filter((e) => e.borne), [], 'une feuille <link> suit 16 niveaux comme un <style>');
  assert.ok(lien(16).some((e) => e.url === URL_EVIL));
});

test("un @import data: en base64 refusé ne charge rien : il n'atteint jamais la borne de profondeur", () => {
  const invalide = '@import url("data:text/css;base64,!!!!");';
  assert.deepEqual(bornes(`<style>${chaineData(16, invalide)}</style>`), [], 'la feuille du 16e niveau importe un base64 refusé : rien à suivre, donc rien à borner');
  assert.equal(bornes(`<style>${chaineData(16, '@import url("data:text/css;base64,YQ==");')}</style>`)[0]?.raison, 'profondeur', 'témoin : le même import valide, lui, dépasse');
  assert.deepEqual(bornes(`<link rel=stylesheet href="data:text/css;base64,!!!!">`), [], 'un <link> au base64 refusé : ni borne ni chargement');
  assert.deepEqual(urlsDe(`<link rel=stylesheet href="data:text/css;base64,!!!!">`).filter((u) => !u.startsWith('data:')), []);
});

test('feuilles data: imbriquées : la borne de volume est dite aussi', () => {
  const [b] = bornes(`<style>${chaineData(33)}</style>`);
  assert.equal(b?.raison, 'volume');
});

test('la borne atteinte devient un constat C-EXFIL-03 critique et bloquant qui empêche B, C et F : la feuille non lue peut contacter n\'importe quel hôte, et un widget qui empêche la lecture ne note pas mieux', () => {
  for (const raison of [chaineData(20), chaineData(33)]) {
    const cs = exfil(`<style>${raison}</style>`).filter((c) => /imbriquées/.test(c.titre));
    assert.equal(cs.length, 1);
    assert.equal(cs[0].severite, 'critique');
    assert.equal(cs[0].bloquant, true);
    assert.equal(cs[0].confiance, 'certain');
    assert.deepEqual(cs[0].axesEmpeches, ['B', 'C', 'F']);
    assert.equal(cs[0].mesurePartielle, false, 'ce n\'est plus une réserve sur la mesure : la mesure est empêchée');
  }
  const [profondeur] = exfil(`<style>${chaineData(20)}</style>`).filter((c) => /imbriquées/.test(c.titre));
  const [volume] = exfil(`<style>${chaineData(33)}</style>`).filter((c) => /imbriquées/.test(c.titre));
  assert.match(profondeur.constat, /borne de profondeur \(16 niveaux\)/);
  assert.match(volume.constat, /borne de volume \(1048576 octets\)/);
});

// ---------------------------------------------------------------------------
// Pièges chronométrés : en V2, un quadratique est un déni de service
// ---------------------------------------------------------------------------

const MIO = 1 << 20;
const PIEGES = {
  'accolades ouvrantes': '{'.repeat(MIO),
  'parenthèses ouvrantes': '('.repeat(MIO),
  '@media imbriqués': '@media x{'.repeat(MIO / 9),
  'url( sans fin': 'a{b:url('.repeat(MIO / 8),
  '@import répétés': '@import url(a.css);'.repeat(MIO / 19),
  '@import à chaînes': '@import "a.css" screen;'.repeat(MIO / 23),
  'commentaires ouverts': '/*'.repeat(MIO / 2),
  'échappements': '\\'.repeat(MIO),
  'chaînes ouvertes': '"'.repeat(MIO),
  'data: dans des url(': 'a{b:url(data:text/css,'.repeat(MIO / 22),
  '@import data: de base64 invalide': '@import url("data:text/css;base64,!!!!");'.repeat(MIO / 40),
};

for (const [nom, css] of Object.entries(PIEGES)) {
  test(`CSS piégé : ${nom} (environ 1 Mio) se lit en moins de 2 s, dans une page, un attribut style et un fichier .css`, () => {
    for (const [contexte, f] of [
      ['<style>', fichier('index.html', `<style>${css}</style>`)],
      ['style=', fichier('index.html', `<p style='${css.replaceAll("'", '&#39;')}'>`)],
      ['.css', fichier('style.css', css)],
    ]) {
      const debut = performance.now();
      chargementsDeFichier(f);
      const duree = performance.now() - debut;
      assert.ok(duree < 2000, `${contexte} : ${Math.round(duree)} ms`);
    }
  });
}

test('pages piégées : des dizaines de milliers de <link>, <style> et d\'URL data: se lisent en moins de 2 s', () => {
  const pieges = {
    'link à srcset': '<link rel=preload as=image imagesrcset="a 1x, b 2x, c 3x">'.repeat(MIO / 60),
    'candidats de srcset': `<link rel=preload as=image imagesrcset="${'a,'.repeat(MIO / 2)}">`,
    'candidats à parenthèses': `<link rel=preload as=image imagesrcset="${'a ('.repeat(MIO / 3)}">`,
    'style ouverts': '<style>@import url(a.css);'.repeat(MIO / 26),
    'link data:': "<link rel=stylesheet href='data:text/css,@import url(a.css);'>".repeat(MIO / 60),
    'attributs style': '<p style="background:url(a.png)">'.repeat(MIO / 34),
    'gabarits de style': '<template><style>@import url(a.css);</style>'.repeat(MIO / 45),
  };
  for (const [nom, html] of Object.entries(pieges)) {
    const debut = performance.now();
    chargementsDeFichier(fichier('index.html', html));
    const duree = performance.now() - debut;
    assert.ok(duree < 2000, `${nom} : ${Math.round(duree)} ms`);
  }
});

test('le volume relu dans des feuilles data: reste borné : au-delà d\'un Mio décodé, la borne de volume est dite', () => {
  const grosse = `@import url("data:text/css,${encodeURIComponent('/*' + 'x'.repeat(600 * 1024) + '*/')}");`;
  const html = `<style>${grosse}${grosse}${grosse}</style>`;
  const debut = performance.now();
  const b = bornes(html);
  assert.ok(performance.now() - debut < 2000);
  assert.equal(b[0]?.raison, 'volume', 'le budget de 1 Mio est épuisé au deuxième import : dit, pas silencieux');
});

// ---------------------------------------------------------------------------
// Constats C-EXFIL-03 (ce que l'utilisateur lit)
// ---------------------------------------------------------------------------

const SANS_CHARGEMENT = [
  'canonical', 'alternate', 'manifest', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'author', 'help', 'license', 'next', 'prev', 'search', 'import',
].map((rel) => `<link rel="${rel}" href="https://tiers.example/${rel}">`);

test('C-EXFIL-03 : un <link> qui ne charge rien (canonical, alternate, manifest…) n\'est plus un constat (faux positif corrigé)', () => {
  assert.deepEqual(exfil(`<!doctype html>${SANS_CHARGEMENT.join('\n')}`), []);
});

test('C-EXFIL-03 : chaque <link> qui charge quelque chose est un constat, avec sa sévérité', () => {
  const cas = {
    'stylesheet': ['<link rel=stylesheet href="https://tiers.example/a.css">', 'feuille de style', 'majeur'],
    'alternate stylesheet': ['<link rel="alternate stylesheet" href="https://tiers.example/a.css">', 'feuille de style', 'majeur'],
    'stylesheet media=print': ['<link rel=stylesheet media=print href="https://tiers.example/a.css">', 'feuille de style', 'majeur'],
    'icon': ['<link rel="shortcut icon" href="https://tiers.example/a.ico">', 'icône', 'mineur'],
    'preload script': ['<link rel=preload as=script href="https://tiers.example/a.js">', 'préchargement de script', 'majeur'],
    'preload font': ['<link rel=preload as=font href="https://tiers.example/a.woff2">', 'préchargement de font', 'mineur'],
    'preload image': ['<link rel=preload as=image href="https://tiers.example/a.png">', 'préchargement de image', 'mineur'],
    'preload image srcset': ['<link rel=preload as=image imagesrcset="https://tiers.example/a.png 1x, https://tiers.example/b.png 2x">', 'préchargement de image', 'mineur'],
    'modulepreload': ['<link rel=modulepreload href="https://tiers.example/a.mjs">', 'préchargement de module', 'majeur'],
    'prefetch': ['<link rel=prefetch href="https://tiers.example/a.html">', 'préchargement (prefetch)', 'majeur'],
    'prerender': ['<link rel=prerender href="https://tiers.example/a.html">', 'préchargement (prerender)', 'majeur'],
  };
  for (const [nom, [html, type, severite]] of Object.entries(cas)) {
    const cs = exfil(`<!doctype html>${html}`);
    assert.ok(cs.length >= 1, nom);
    assert.ok(cs.every((c) => c.severite === severite && !c.bloquant), `${nom} : ${cs.map((c) => c.severite).join()}`);
    assert.ok(cs.every((c) => c.titre.includes('tiers.example') && c.titre.includes(type)), `${nom} : ${cs[0].titre}`);
  }
});

test('C-EXFIL-03 : un <link> dont le type ou le préchargement n\'en fait pas une ressource ne charge rien', () => {
  for (const html of [
    '<link rel=stylesheet type=text/plain href="https://tiers.example/a.css">',
    '<link rel=preload href="https://tiers.example/a.js">',
    '<link rel=preload as=document href="https://tiers.example/a.html">',
    '<link rel=preload as=worker href="https://tiers.example/a.js">',
    '<link rel=stylesheet>',
    '<link rel=stylesheet href="">',
    '<link rel=icon href="  ">',
  ]) assert.deepEqual(exfil(`<!doctype html>${html}`), [], html);
});

test('C-EXFIL-03 : preconnect est dit comme tel (connexion anticipée, mineur), sans prétendre à une ressource ni à une observation', () => {
  const [c, ...reste] = exfil('<!doctype html><link rel=preconnect href="https://tiers.example">');
  assert.equal(reste.length, 0);
  assert.equal(c.severite, 'mineur');
  assert.ok(!c.bloquant);
  assert.match(c.titre, /connexion anticipée/);
  assert.match(c.constat, /Aucune ressource n'est demandée/);
  assert.doesNotMatch(c.constat, /observ/i);
});

test('C-EXFIL-03 : le CSS écrit dans une page est lu (régression de l\'étape 1 : il ne l\'était plus)', () => {
  const importe = exfil('<!doctype html><style>@import url(https://tiers.example/a.css);</style>');
  assert.equal(importe.length, 1);
  assert.match(importe[0].titre, /@import CSS/);
  assert.equal(importe[0].severite, 'majeur');
  assert.equal(importe[0].confiance, 'certain', 'un @import en tête de feuille est chargé sans condition');
  assert.ok(!importe[0].note && !/Le navigateur ne la demande/.test(importe[0].constat));

  const attribut = exfil('<!doctype html><p style="background:url(https://tiers.example/a.png)">x</p>');
  assert.equal(attribut.length, 1);
  assert.match(attribut[0].titre, /ressource CSS/);
  assert.equal(attribut[0].severite, 'mineur');
});

test('C-EXFIL-03 : un url() de déclaration est « probable », avec la raison dite (règle valide, sélecteur, police utilisée)', () => {
  const [c] = exfil('<!doctype html><style>p{background:url(https://tiers.example/a.png)}</style>');
  assert.equal(c.confiance, 'probable');
  assert.match(c.constat, /Le navigateur ne la demande que si la déclaration est valide/);
});

test('C-EXFIL-03 : un @import après une règle et une feuille de <template> sont « probables », avec leur note', () => {
  const [apres] = exfil('<!doctype html><style>p{}@import url(https://tiers.example/a.css);</style>');
  assert.equal(apres.confiance, 'probable');
  assert.match(apres.constat, /suit une règle/);
  const [modele] = exfil('<!doctype html><template><style>@import url(https://tiers.example/a.css);</style></template>');
  assert.equal(modele.confiance, 'probable');
  assert.match(modele.constat, /dans un `<template>`/);
});

test('C-EXFIL-03 : un fichier .css exécuté est lu comme le CSS d\'une page ; non exécuté, il ne l\'est pas', () => {
  const css = '@import url(https://tiers.example/a.css);\np{background:url(https://tiers.example/b.png)}';
  const lu = exfilFichiers([fichier('style.css', css)]);
  assert.deepEqual(lu.map((c) => c.severite).sort(), ['majeur', 'mineur']);
  assert.deepEqual(lu.map((c) => c.ligne).sort(), [1, 2]);
  assert.deepEqual(exfilFichiers([fichier('style.css', css, { executee: false })]), []);
});

test('C-EXFIL-03 : un fichier .css importé depuis data: de type quelconque est lu si une page du dépôt est en quirks', () => {
  const css = importDataDe('text/plain', `@import url(${URL_EVIL});`);
  const standards = exfilFichiers([fichier('index.html', '<!doctype html><link rel=stylesheet href=style.css>'), fichier('style.css', css)]);
  assert.deepEqual(standards, [], 'toutes les pages en standards : le type text/plain est refusé');
  const quirks = exfilFichiers([fichier('index.html', '<link rel=stylesheet href=style.css>'), fichier('style.css', css)]);
  assert.equal(quirks.length, 1, 'une page en quirks : le navigateur le lit');
});

test('C-EXFIL-03 : une URL vide (script, img, iframe, object, embed) ne charge rien, même avec un <base> externe (faux constat corrigé)', () => {
  const vides = [
    '<script src=""></script>', '<script src="  "></script>', '<img src="">', '<img src=" \t">', '<iframe src=""></iframe>',
    '<object data=""></object>', '<embed src="">', '<link rel=stylesheet href="">',
  ];
  assert.deepEqual(exfil(`<!doctype html><base href="https://tiers.example/">${vides.join('')}`), []);
  const reel = exfil('<!doctype html><base href="https://tiers.example/"><img src="a.png">');
  assert.equal(reel.length, 1, 'une URL relative, elle, se résout contre le <base> externe et charge chez le tiers');
});

test('C-EXFIL-03 : la sévérité critique bloquante reste réservée au script sans intégrité', () => {
  const script = exfil('<!doctype html><script src="https://tiers.example/a.js"></script>');
  assert.equal(script[0].severite, 'critique');
  assert.equal(script[0].bloquant, true);
  for (const html of ['<style>@import url(https://tiers.example/a.css);</style>', '<link rel=preload as=script href="https://tiers.example/a.js">', '<link rel=modulepreload href="https://tiers.example/a.mjs">']) {
    const cs = exfil(`<!doctype html>${html}`);
    assert.ok(cs.length && cs.every((c) => !c.bloquant && c.severite !== 'critique'), html);
  }
});

// ---------------------------------------------------------------------------
// lireCss : bornes du lecteur (le détail des formes est dans les sondes)
// ---------------------------------------------------------------------------

test('lireCss : @import valide seulement en tête de feuille ; url() seulement dans un bloc de déclarations', () => {
  const sortes = (css) => lireCss(css, { mode: 'feuille' }).map((e) => `${e.sorte}:${e.url}`);
  assert.deepEqual(sortes('@import url(a.css);'), ['import:a.css']);
  assert.deepEqual(sortes('@charset "utf-8"; @import "a.css";'), ['import:a.css']);
  assert.deepEqual(sortes('@layer a; @import "a.css";'), ['import:a.css']);
  assert.deepEqual(sortes('p{}@import "a.css";').map((s) => s.split(':')[0]), ['import'], 'après une règle : gardé, signalé « apresRegle »');
  assert.equal(lireCss('p{}@import "a.css";', { mode: 'feuille' })[0].apresRegle, true);
  assert.deepEqual(sortes('p{background:url(a.png)}'), ['url:a.png']);
  assert.deepEqual(sortes('@namespace url(a.css); p{}'), [], 'un prélude ne charge rien');
  assert.deepEqual(sortes('p[x=url(a.png)]{}'), [], 'un sélecteur ne charge rien');
  assert.deepEqual(sortes('@foo (}; @import url(a.css);'), [], 'un fermant qui ne correspond pas au sommet de pile n\'ouvre rien (Chromium)');
});

// ---------------------------------------------------------------------------
// Feuille <link> data: trop grosse : la borne de volume est dite, seulement quand le navigateur l'applique
// ---------------------------------------------------------------------------

test('une feuille <link> data: de plus de 4 Mio de URL est bornée en volume, dite, et lue en moins de 2 s', () => {
  const geante = 'a'.repeat(4 * MIO + 1);
  const debut = performance.now();
  const b = bornes(`<!doctype html><link rel=stylesheet href='data:text/css,${geante}'>`);
  assert.ok(performance.now() - debut < 2000);
  assert.equal(b.length, 1);
  assert.equal(b[0].raison, 'volume');
  const juste = bornes(`<!doctype html><link rel=stylesheet href='data:text/css,${'a'.repeat(4 * MIO)}'>`);
  assert.deepEqual(juste, [], 'à 4 Mio pile la feuille est lue (le corps décodé tient dans le budget) : pas de borne');
});

test('une feuille <link> data: trop grosse que le navigateur n\'applique pas ne dit aucune borne', () => {
  const geante = 'a'.repeat(4 * MIO + 1);
  assert.deepEqual(bornes(`<!doctype html><link rel=stylesheet href='data:text/plain,${geante}'>`), [], 'standards : text/plain n\'est pas une feuille');
  assert.equal(bornes(`<link rel=stylesheet href='data:text/plain,${geante}'>`)[0]?.raison, 'volume', 'quirks : le navigateur l\'applique, la borne est dite');
});

// ---------------------------------------------------------------------------
// decoderUrlData : base64 indulgent, comme atob du standard (sondes b64-* de l'enregistrement)
// ---------------------------------------------------------------------------

test('decoderUrlData : les = de fin ne sont retirés que si la longueur est multiple de 4 (Chromium refuse le reste)', () => {
  const corps = (u) => decoderUrlData(`data:text/css;base64,${u}`);
  assert.equal(corps('YQ==').corps, 'a');
  assert.equal(corps('YWI=').corps, 'ab');
  assert.equal(corps('YQ').corps, 'a', 'sans remplissage : accepté');
  assert.equal(corps('YQ=').invalide, true, 'un seul = pour une longueur de 3 : refusé');
  assert.equal(corps('YWJjZA=').invalide, true, 'longueur 7 : refusé');
  assert.equal(corps('YWJjZ===').invalide, true, 'trois = : refusé');
  assert.equal(corps('YQ=\n=').corps, 'a', 'blancs retirés avant de compter');
  for (const cas of ['b64-un-egal-reste3', 'b64-egal-de-trop-reste1']) {
    assert.ok(JSON.stringify(fx).includes(`"${cas}"`), `${cas} est dans l'enregistrement Chromium`);
  }
});

// ---------------------------------------------------------------------------
// lireCss : URL vides et blancs (sondes decl-vide-*, imp-vide-* de l'enregistrement Chromium)
// ---------------------------------------------------------------------------

const urlsCss = (css) => lireCss(css, { mode: 'feuille' }).map((e) => `${e.sorte}:${e.url}`);

test('lireCss : une URL vide ne charge rien, sous toutes ses écritures', () => {
  for (const css of ['@import "";', '@import url();', '@import url("");', '@import "  ";', '@import url(   );', 'a{b:url()}', 'a{b:url("")}', 'a{b:url(   )}', 'a{b:image-set("" 1x)}']) {
    assert.deepEqual(urlsCss(css), [], css);
  }
});

test('lireCss : une chaîne de blancs ASCII entre guillemets dans une déclaration se résout contre la base et charge (Chromium 141)', () => {
  for (const css of ['a{b:url("  ")}', 'a{b:url("\t")}', 'a{b:image-set("  " 1x)}', 'a{b:url("\u0001 ")}']) {
    assert.deepEqual(urlsCss(css), ['url:'], JSON.stringify(css));
  }
  assert.deepEqual(urlsCss('@import "  ";'), [], 'un @import à chaîne de blancs, lui, ne charge rien');
});

test('lireCss : le NBSP n\'est pas un blanc d\'URL ; seuls les blancs et contrôles ASCII sont rognés', () => {
  assert.deepEqual(urlsCss('a{b:url(" ")}'), ['url: ']);
  assert.deepEqual(urlsCss('@import " ";'), ['import: ']);
  assert.deepEqual(urlsCss('a{b:url( a.png)}'), ['url: a.png']);
  assert.deepEqual(urlsCss('a{b:url(  a.png  )}'), ['url:a.png']);
  assert.deepEqual(urlsCss('a{b:url("　")}'), ['url:　'], 'l\'espace idéographique non plus');
});

test('lireCss : @import "\\u0001" est écarté par l\'analyseur, mais le scanner de préchargement le demande (Chromium 141)', () => {
  assert.deepEqual(urlsCss('@import "\u0001";'), []);
  const feuilles = (html) => lirePage(html).feuilles.map((f) => lireFeuille(f).map((e) => `${e.sorte}:${e.url}`));
  assert.deepEqual(feuilles('<style>@import "\u0001";</style>'), [['precharge:\u0001']]);
  assert.deepEqual(feuilles('<style>@import "";</style>'), [[]]);
  assert.deepEqual(feuilles('<style>@import url();</style>'), [[]]);
  assert.deepEqual(lirePrechargement('@import "";').map((e) => e.url), [''], 'le scanner brut voit l\'import vide : c\'est lireFeuille qui l\'écarte');
  assert.deepEqual(feuilles('<style type="text/foo">@import "\u00a0a.css";</style>'), [['precharge:\u00a0a.css']], 'le scanner non plus ne rogne pas le NBSP');
  assert.deepEqual(feuilles('<style type="text/foo">@import "  a.css";</style>'), [[]], 'le scanner lit la valeur jusqu\'au premier blanc : rien n\'est demandé (Chromium 141)');
  assert.deepEqual(feuilles('<style>@import "  a.css";</style>'), [['import:a.css']], 'l\'analyseur, lui, rogne les blancs de la chaîne');
});

// ---------------------------------------------------------------------------
// Attributs en double : le premier gagne, comme dans le tokenizer du standard
// ---------------------------------------------------------------------------

test('un attribut en double : la première valeur gagne (href, style)', () => {
  const urls = urlsDe('<!doctype html><link rel=stylesheet href="https://tiers.example/a.css" href="https://tiers.example/b.css">');
  assert.deepEqual(urls, ['https://tiers.example/a.css']);
  const style = urlsDe('<!doctype html><p style="background:url(https://tiers.example/s1.png)" style="background:url(https://tiers.example/s2.png)">x</p>');
  assert.deepEqual(style, ['https://tiers.example/s1.png']);
  const casse = urlsDe('<!doctype html><img src="https://tiers.example/1.png" SRC="https://tiers.example/2.png">');
  assert.deepEqual(casse, ['https://tiers.example/1.png'], 'la casse ne distingue pas deux attributs');
  const page = lirePage('<p style="a" style="b" id=x id=y>');
  assert.deepEqual(page.feuilles.map((f) => f.texte), ['a']);
});

// ---------------------------------------------------------------------------
// Blancs de bord : rognés en temps linéaire
// ---------------------------------------------------------------------------

test('blancs de bord : des Mio de blancs dans une URL, un type, un rel, un href se lisent en moins de 2 s', () => {
  const blancs = ' '.repeat(MIO);
  const pieges = {
    'url() entre guillemets': `<style>a{b:url("${blancs}x")}</style>`,
    'url() sans guillemets': `<style>a{b:url(${blancs}x${blancs})}</style>`,
    '@import': `<style>@import "${blancs}x";</style>`,
    'data: à blancs': `<link rel=stylesheet href='data:text/css,${blancs}x'>`,
    'href': `<link rel=stylesheet href="${blancs}x${blancs}">`,
    'type': `<link rel=stylesheet type="${blancs}x" href=a.css>`,
    'rel': `<link rel="${blancs}x${blancs}" href=a.css>`,
    'imagesrcset': `<link rel=preload as=image imagesrcset="${','.repeat(MIO / 2)}x">`,
    'style=': `<p style="${blancs}background:url(a.png)${blancs}">`,
    '@import de blancs': `<style>${'@import "  ";'.repeat(MIO / 13)}</style>`,
  };
  for (const [nom, html] of Object.entries(pieges)) {
    const debut = performance.now();
    chargementsDeFichier(fichier('index.html', html));
    const duree = performance.now() - debut;
    assert.ok(duree < 2000, `${nom} : ${Math.round(duree)} ms`);
  }
});

// ---------------------------------------------------------------------------
// Des milliers de constats sur une seule ligne : extrait borné autour de la référence, ligne juste, temps linéaire
// ---------------------------------------------------------------------------

const rempli = (n) => 'a{color:red}'.repeat(n);
const constatsExfil = (fichiers) => analyserRessourcesExternes({ fichiers }).filter((c) => c.regle === 'C-EXFIL-03');
const jusqua = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test("l'extrait d'un constat CSS montre la référence, où qu'elle soit sur une ligne minifiée, avec un … là où la ligne continue", () => {
  const cas = [
    // nom, fichier, référence, … au début, … à la fin
    ['.css, début de ligne', fichier('a.css', `@import url(https://e.example/debut.css);${rempli(5000)}`), 'e.example/debut.css', false, true],
    ['.css, milieu de ligne', fichier('a.css', `${rempli(5000)}@import "https://e.example/milieu.css";${rempli(5000)}`), 'e.example/milieu.css', true, true],
    ['.css, fin de ligne', fichier('a.css', `${rempli(5000)}.x{background:url(https://e.example/fin.png)}`), 'e.example/fin.png', true, false],
    ['<style>, milieu de ligne', fichier('index.html', `<!doctype html><style>${rempli(5000)}@import url("https://e.example/style.css");${rempli(5000)}</style>`), 'e.example/style.css', true, true],
    ['attribut style, milieu de ligne', fichier('index.html', `<!doctype html><div style="${rempli(1000)}background:url(https://e.example/attr.png);${rempli(1000)}">x</div>`), 'e.example/attr.png', true, true],
    ['<style> data: imbriqué, milieu de ligne', fichier('index.html', `<!doctype html><style>${rempli(5000)}@import url("data:text/css,@import 'https://e.example/data.css';");${rempli(5000)}</style>`), 'data:text/css', true, true],
  ];
  for (const [nom, f, reference, debut, fin] of cas) {
    const [c] = constatsExfil([f]);
    assert.ok(c, nom);
    assert.ok(c.extrait.includes(reference), `${nom} : « ${c.extrait.slice(0, 80)}… » ne montre pas la référence`);
    assert.ok(c.extrait.length <= 300, `${nom} : ${c.extrait.length} caractères`);
    assert.equal(c.extrait.startsWith('…'), debut, `${nom} : … au début`);
    assert.equal(c.extrait.endsWith('…'), fin, `${nom} : … à la fin`);
  }
});

test("l'extrait d'une ligne courte est la ligne elle-même, sans …, et le numéro de ligne est celui de la référence (LF, CRLF)", () => {
  const lf = constatsExfil([fichier('a.css', 'a{}\n\n@import url(https://e.example/courte.css);\nb{}')]);
  assert.deepEqual(lf.map((c) => [c.ligne, c.extrait]), [[3, '@import url(https://e.example/courte.css);']]);
  const crlf = constatsExfil([fichier('a.css', 'a{}\r\n@import url(https://e.example/crlf.css);\r\nb{}')]);
  assert.deepEqual(crlf.map((c) => [c.ligne, c.extrait]), [[2, '@import url(https://e.example/crlf.css);']]);
  const page = constatsExfil([fichier('index.html', '<!doctype html>\n<style>\na{}\n@import url(https://e.example/page.css);\n</style>')]);
  assert.deepEqual(page.map((c) => [c.ligne, c.extrait]), [[4, '@import url(https://e.example/page.css);']]);
});

test('extraitAutour : borné à 60 caractères avant et 236 après, sans sortir de la ligne', () => {
  const texte = `${'a'.repeat(100)}\n${'b'.repeat(100)}X${'c'.repeat(300)}\n${'d'.repeat(100)}`;
  const decalage = texte.indexOf('X');
  assert.equal(extraitAutour(texte, decalage), `…${'b'.repeat(60)}X${'c'.repeat(235)}…`);
  assert.equal(extraitAutour('ab\ncXd\nef', 4), 'cXd', 'une ligne courte : la ligne, sans …');
  assert.equal(extraitAutour(`X${'z'.repeat(300)}`, 0), `X${'z'.repeat(235)}…`, 'au début du fichier : pas de … devant');
  assert.equal(extraitAutour(`${'z'.repeat(100)}\nabX`, 103), 'abX', 'la ligne commence à moins de 60 caractères de la référence, loin du début du fichier : pas de … devant');
  assert.equal(extraitAutour(`${'z'.repeat(300)}X`, 300), `…${'z'.repeat(60)}X`, 'à la fin du fichier : pas de … derrière');
});

test('40 000 références externes sur une ligne (.css, <style>, attributs style) : des constats en moins de 4 s, sans quadratique ni mémoire qui enfle', () => {
  const N = 40000;
  const pieges = {
    '.css, une ligne': [fichier('a.css', jusqua(N, (i) => `.a${i}{background:url(https://e.example/${i}.png)}`).join(''))],
    '.css, une par ligne': [fichier('a.css', jusqua(N, (i) => `.a${i}{background:url(https://e.example/${i}.png)}\n`).join(''))],
    '<style>, @import sur une ligne': [fichier('index.html', `<!doctype html><style>${jusqua(N, (i) => `@import url(https://e.example/${i}.css);`).join('')}</style>`)],
    '<style>, url() sur une ligne': [fichier('index.html', `<!doctype html><style>${jusqua(N, (i) => `.a${i}{background:url(https://e.example/${i}.png)}`).join('')}</style>`)],
    'attributs style': [fichier('index.html', `<!doctype html>${jusqua(N, (i) => `<div style="background:url(https://e.example/${i}.png)">x</div>`).join('')}`)],
    '<link rel=stylesheet>': [fichier('index.html', `<!doctype html>${jusqua(N, (i) => `<link rel=stylesheet href="https://e.example/${i}.css">`).join('')}`)],
    'imagesrcset de candidats externes': [fichier('index.html', `<!doctype html><link rel=preload as=image imagesrcset="${jusqua(N, (i) => `https://e.example/${i}.png ${i + 1}w`).join(',')}">`)],
  };
  for (const [nom, fichiers] of Object.entries(pieges)) {
    const debut = performance.now();
    const constats = constatsExfil(fichiers);
    const duree = performance.now() - debut;
    assert.equal(constats.length, N, `${nom} : un constat par référence`);
    assert.ok(constats.every((c) => c.extrait.length <= 300), `${nom} : extraits bornés`);
    assert.ok(duree < 4000, `${nom} : ${Math.round(duree)} ms`);
  }
});
