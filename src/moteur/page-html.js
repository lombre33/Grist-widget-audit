/**
 * Lecture d'une page HTML telle que le navigateur la découpe : une passe du
 * découpeur du standard HTML (voir `Decoupeur`), partagée par tout ce qui
 * lit une page. Une expression régulière ne sait pas qu'un `>` entre
 * guillemets ne ferme pas une balise, qu'un commentaire ne contient aucun
 * élément, qu'un `<!--<script>` dans un script fait ignorer le `</script>`
 * suivant, ni qu'une valeur d'attribut peut s'écrire sans guillemets ou avec
 * des références de caractères : chacune de ces différences cachait du code
 * exécuté à l'analyse statique, ou lui faisait lire du code qui ne s'exécute
 * jamais (vérifié dans Chromium 141, le 2026-09-28).
 */
import { TokenizerMode, foreignContent, parse, defaultTreeAdapter } from 'parse5';
import { Decoupeur } from './decoupeur-html.js';
import { decoderUrlData } from './css.js';

export const ELEMENTS_VIDES = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Éléments dont le contenu n'est pas du balisage : dans parse5, c'est le constructeur d'arbre qui bascule le découpeur, ici c'est à nous. `noscript` suit un navigateur où les scripts s'exécutent.
export const MODES_TEXTE_BRUT = new Map([
  ['script', TokenizerMode.SCRIPT_DATA], ['style', TokenizerMode.RAWTEXT], ['xmp', TokenizerMode.RAWTEXT],
  ['iframe', TokenizerMode.RAWTEXT], ['noembed', TokenizerMode.RAWTEXT], ['noframes', TokenizerMode.RAWTEXT],
  ['noscript', TokenizerMode.RAWTEXT], ['textarea', TokenizerMode.RCDATA], ['title', TokenizerMode.RCDATA],
  ['plaintext', TokenizerMode.PLAINTEXT],
]);

export const attribut = (balise, nom) => balise.attrs.find((a) => a.name === nom)?.value;

/** Élément étranger (SVG, MathML) dont les enfants sont de nouveau lus comme du HTML. */
export function estPointIntegration(ns, nom, balise) {
  if (ns === 'svg') return nom === 'foreignobject' || nom === 'desc' || nom === 'title';
  if (nom === 'annotation-xml') return /^(text\/html|application\/xhtml\+xml)$/i.test((attribut(balise, 'encoding') ?? ''));
  return ['mi', 'mo', 'mn', 'ms', 'mtext'].includes(nom);
}

/**
 * Une passe du découpeur sur une page, avec une pile d'éléments simplifiée
 * à la place du constructeur d'arbre de parse5, quadratique sur des pages
 * piégées : chaque élément entre et sort une fois, et un compte des éléments
 * ouverts par nom fait ignorer en temps constant une balise fermante sans
 * ouvrante. Ce que le constructeur faisait et qui change le découpage est
 * repris ici : le contenu de `script`, `style`, `textarea`… n'est pas du
 * balisage ; dans `svg` et `math`, `title` n'en est pas un et la barre
 * oblique ferme l'élément ; une balise HTML y ramène au HTML ; les éléments
 * vides ne s'empilent pas ; un `<button>` ferme celui qui est ouvert.
 *
 * Le visiteur reçoit `ouverture(balise, element, parent)` avant que
 * l'élément soit empilé (il peut l'annoter), `fermeture(element,
 * finContenu, finBalise)` quand il est dépilé (balise fermante, fermeture
 * implicite ou fin du document, où les deux positions se confondent),
 * `texte(jeton, haut, sorte)` pour chaque caractère (`sorte` : 'caractere',
 * 'blanc' ou 'nul'), et `fin()`.
 *
 * Renvoie `{ quirks }` : le document est-il en mode quirks (`compatMode`
 * `BackCompat`) ? Tout le monde peut s'en servir : en quirks, une feuille
 * `data:` de n'importe quel type MIME est lue (`link` comme `@import`). Il
 * l'est sans doctype valide, avec une balise ou du texte avant le doctype
 * (un commentaire, des blancs ou un NUL n'y comptent pas, vérifié dans
 * Chromium 141 : `tests/passe-html-css.test.mjs`), ou avec un des doctypes
 * du standard qui le veulent. Le mode « limited-quirks » n'est pas du quirks.
 */
export function parcourirPage(source, visiteur) {
  const pile = [];
  const ouverts = new Map();
  let boutonsOuverts = 0;
  let doctypePossible = true;
  let quirks = false;
  const contenuAvantDoctype = () => {
    if (doctypePossible) {
      doctypePossible = false;
      quirks = true;
    }
  };

  const depiler = (finContenu, finBalise) => {
    const element = pile.pop();
    ouverts.set(element.nom, ouverts.get(element.nom) - 1);
    if (element.boutonHtml) boutonsOuverts--;
    visiteur.fermeture?.(element, finContenu, finBalise);
  };
  const ajusterModeEtranger = () => {
    const haut = pile.at(-1);
    decoupeur.inForeignNode = Boolean(haut && haut.ns !== 'html' && !haut.integration);
  };

  const decoupeur = new Decoupeur({ sourceCodeLocationInfo: true }, {
    onStartTag(balise) {
      contenuAvantDoctype();
      const nom = balise.tagName;
      const { startOffset } = balise.location;
      if (decoupeur.inForeignNode && foreignContent.causesExit(balise)) {
        while (pile.length && pile.at(-1).ns !== 'html' && !pile.at(-1).integration) depiler(startOffset, startOffset);
        ajusterModeEtranger();
      }
      const ns = decoupeur.inForeignNode ? pile.at(-1).ns : nom === 'svg' || nom === 'math' ? nom : 'html';
      if (ns === 'html' && nom === 'button' && boutonsOuverts) {
        while (!pile.at(-1).boutonHtml) depiler(startOffset, startOffset);
        depiler(startOffset, startOffset);
        ajusterModeEtranger();
      }
      const parent = pile.at(-1);
      const element = { nom, ns, integration: ns !== 'html' && estPointIntegration(ns, nom, balise), brut: false, boutonHtml: ns === 'html' && nom === 'button' };
      visiteur.ouverture?.(balise, element, parent);

      if (ns === 'html' ? ELEMENTS_VIDES.has(nom) : balise.selfClosing) return;
      if (ns === 'html' && MODES_TEXTE_BRUT.has(nom)) {
        decoupeur.state = MODES_TEXTE_BRUT.get(nom);
        element.brut = true;
      }
      pile.push(element);
      ouverts.set(nom, (ouverts.get(nom) ?? 0) + 1);
      if (element.boutonHtml) boutonsOuverts++;
      ajusterModeEtranger();
    },
    onEndTag(balise) {
      contenuAvantDoctype();
      const nom = balise.tagName;
      if (!ouverts.get(nom)) return;
      const { startOffset, endOffset } = balise.location;
      while (pile.at(-1).nom !== nom) depiler(startOffset, endOffset);
      depiler(startOffset, endOffset);
      ajusterModeEtranger();
    },
    onCharacter(jeton) {
      contenuAvantDoctype();
      visiteur.texte?.(jeton, pile.at(-1), 'caractere');
    },
    onWhitespaceCharacter(jeton) { visiteur.texte?.(jeton, pile.at(-1), 'blanc'); },
    onNullCharacter(jeton) { visiteur.texte?.(jeton, pile.at(-1), 'nul'); },
    onComment() {},
    onDoctype(jeton) {
      if (!doctypePossible) return;
      doctypePossible = false;
      quirks = defaultTreeAdapter.getDocumentMode(parse(source.slice(jeton.location.startOffset, jeton.location.endOffset))) === 'quirks';
    },
    onEof() {
      if (doctypePossible) quirks = true;
      while (pile.length) depiler(source.length, source.length);
      visiteur.fin?.();
    },
  });
  decoupeur.write(source, true);
  return { quirks };
}

/** Les types MIME JavaScript du standard MIME Sniffing, que le navigateur exécute comme script classique. */
const TYPES_JAVASCRIPT = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);

function sansBlancsDeBord(texte) {
  const espace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
  let a = 0;
  let b = texte.length;
  while (a < b && espace(texte.charCodeAt(a))) a++;
  while (b > a && espace(texte.charCodeAt(b - 1))) b--;
  return texte.slice(a, b);
}
const enMinusculesAscii = (texte) => texte.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Ce que le navigateur fait d'un `<script>` (standard HTML, « prepare the
 * script element », vérifié dans Chromium) : 'classique', 'module',
 * 'importmap', ou null s'il ne l'exécute pas. Un `type` vide, ou ni `type`
 * ni `language` non vide, donne un script classique ; sinon le type, blancs
 * de bord retirés (ou `text/` suivi de `language`), doit être un type MIME
 * JavaScript, « module » ou « importmap », sans tenir compte de la casse
 * ASCII. Un script classique qui porte `nomodule` ne s'exécute pas. Deux
 * écarts du côté de l'analyse : un type JavaScript suivi de paramètres
 * (`text/javascript; charset=utf-8`), que Chromium n'exécute pas, est lu ;
 * `type=" module "` est un module, comme le veut le standard, là où Chromium
 * ne l'exécute pas du tout (de même pour « importmap »).
 * @param {Map<string, string>} attributs
 */
export function genreDeScript(attributs) {
  const type = attributs.get('type');
  const langage = attributs.get('language');
  if (!(type === '' || (type === undefined && !langage))) {
    const chaine = enMinusculesAscii(type === undefined ? `text/${langage}` : sansBlancsDeBord(type));
    if (!TYPES_JAVASCRIPT.has(sansBlancsDeBord(chaine.split(';')[0]))) return chaine === 'module' || chaine === 'importmap' ? chaine : null;
  }
  return attributs.has('nomodule') ? null : 'classique';
}

/**
 * Vrai si une valeur d'`integrity` protège vraiment : au moins un jeton
 * `sha256-`, `sha384-` ou `sha512-` (en minuscules) suivi d'une empreinte en
 * base64, options `?…` permises. Vérifié dans Chromium : une valeur vide,
 * `x`, `md5-…`, `sha1-…`, `SHA384-…`, `sha384-` ou `sha384-!!!` laisse
 * charger et exécuter n'importe quel contenu ; un seul jeton bien formé
 * suffit, même à côté d'un jeton invalide.
 */
export function integriteProtege(valeur) {
  if (typeof valeur !== 'string') return false;
  return valeur.split(/[\t\n\f\r ]+/).some((jeton) => /^sha(256|384|512)-[A-Za-z0-9+/_-]+={0,2}(\?.*)?$/.test(jeton));
}

/** Base des URL relatives d'une page sans `<base>` : un hôte fictif, que l'analyse tient pour local. */
export const BASE_PAR_DEFAUT = 'https://widget.local/';

/** URL absolue d'une référence, comme le navigateur la résout depuis `base` ; null si elle ne se résout pas. */
export function resoudreUrl(valeur, base = BASE_PAR_DEFAUT) {
  try { return new URL(valeur, base); } catch { return null; }
}

const estBlancHtml = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';

/**
 * Les URL d'un attribut `srcset` (ou `imagesrcset`), lues comme le fait le
 * standard HTML (« parse a srcset attribute ») : des candidats séparés par des
 * virgules, chacun une URL suivie de descripteurs `Nw` ou `Nx` ; une URL sans
 * blanc ni virgule de fin garde sa virgule interne (`a.png,1x`), une virgule
 * entre parenthèses ne sépare rien, et un candidat aux descripteurs invalides
 * est écarté. Toutes les URL valides comptent : l'écran choisit laquelle sera
 * chargée (`x` de 1 ou de 2), et le widget n'en maîtrise aucune.
 */
export function candidatsSrcset(valeur) {
  const urls = [];
  const n = valeur.length;
  let i = 0;
  for (;;) {
    while (i < n && (estBlancHtml(valeur[i]) || valeur[i] === ',')) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !estBlancHtml(valeur[j])) j++;
    let url = valeur.slice(i, j);
    i = j;
    let descripteurs = '';
    if (url.endsWith(',')) {
      let fin = url.length;
      while (fin > 0 && url.charCodeAt(fin - 1) === 44) fin--;
      url = url.slice(0, fin);
    }
    else {
      while (i < n && estBlancHtml(valeur[i])) i++;
      let parentheses = false;
      let k = i;
      for (; k < n; k++) {
        const c = valeur[k];
        if (c === '(') parentheses = true;
        else if (c === ')') parentheses = false;
        else if (c === ',' && !parentheses) break;
      }
      descripteurs = valeur.slice(i, k);
      i = k + 1;
    }
    if (url && descripteursValides(descripteurs)) urls.push(url);
  }
  return urls;
}

function descripteursValides(texte) {
  let largeur = false;
  let densite = false;
  for (const jeton of texte.split(/[\t\n\f\r ]+/).filter(Boolean)) {
    const nombre = jeton.slice(0, -1);
    if (jeton.endsWith('w') && /^[0-9]+$/.test(nombre) && Number(nombre) > 0 && !largeur) largeur = true;
    else if (jeton.endsWith('x') && /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(nombre) && Number(nombre) >= 0 && !densite) densite = true;
    else return false;
  }
  return !(largeur && densite);
}

const AS_PRECHARGES = new Set(['script', 'style', 'font', 'image', 'fetch', 'track']);

/**
 * Ce que Chromium fait d'un `<link>` (vérifié dans Chromium 141, le 2026-09-29,
 * par sonde : `tests/passe-html-css.test.mjs`). `rel` se lit en jetons séparés
 * par des blancs ASCII, sans tenir compte de la casse ; un jeton `stylesheet`
 * charge une feuille (`type` vide, absent ou `text/css` seulement, même
 * `alternate`, `disabled` ou `media="print"`), `icon` une icône, `preload` une
 * ressource si `as` en désigne une (jamais `document`, `audio`, `video`,
 * `worker` ni `as` absent), `modulepreload`, `prefetch` et `prerender`
 * la leur. Tout le reste (`canonical`, `alternate`, `manifest`,
 * `apple-touch-icon`, `author`, `next`, `import`…) ne charge rien.
 * `preconnect` et `dns-prefetch` n'appellent pas de ressource : ils ouvrent
 * ou préparent une connexion vers l'hôte, ce qu'un navigateur sans écran
 * n'exécute pas (non observé, dit comme tel dans le constat).
 * Sans `href`, ou avec un `href` vide, rien n'est chargé, hors `preload`
 * d'une image dont `imagesrcset` fournit les candidats.
 * @param {Map<string, string>} attributs
 * @returns {Array<{genre: 'feuille'|'icone'|'precharge'|'modulepreload'|'prefetch'|'prerender'|'connexion', urls: string[]}>}
 */
export function usageLien(attributs) {
  const jetons = new Set(enMinusculesAscii(attributs.get('rel') ?? '').split(/[\t\n\f\r ]+/).filter(Boolean));
  const href = sansBlancsDeBord(attributs.get('href') ?? '') === '' ? [] : [attributs.get('href')];
  const usages = [];
  if (jetons.has('stylesheet')) {
    const type = attributs.get('type');
    if (type === undefined || type === '' || sansBlancsDeBord(enMinusculesAscii(type.split(';')[0])) === 'text/css') usages.push({ genre: 'feuille', urls: href });
  }
  if (jetons.has('icon')) usages.push({ genre: 'icone', urls: href });
  if (jetons.has('preload')) {
    const as = enMinusculesAscii(attributs.get('as') ?? '');
    if (AS_PRECHARGES.has(as)) {
      const srcset = as === 'image' ? attributs.get('imagesrcset') : undefined;
      usages.push({ genre: 'precharge', as, urls: srcset !== undefined && sansBlancsDeBord(srcset) !== '' ? candidatsSrcset(srcset) : href });
    }
  }
  for (const genre of ['modulepreload', 'prefetch', 'prerender']) if (jetons.has(genre)) usages.push({ genre, urls: href });
  if (jetons.has('preconnect') || jetons.has('dns-prefetch')) usages.push({ genre: 'connexion', urls: href });
  return usages.filter((u) => u.urls.length);
}

const ELEMENTS_LUS = new Set(['script', 'base', 'link', 'iframe', 'img', 'object', 'embed']);

const DEBUT_VALEUR_STYLE = /^style[\t\n\f\r ]*=[\t\n\f\r ]*(["']?)/i;
const sansRetourChariot = (texte) => texte.replace(/\r\n?/g, '\n');

/** Vrai si le navigateur lit un `<style>` de ce `type` comme une feuille CSS (vide ou `text/css`, sans tenir compte de la casse ASCII ni des blancs : Chromium ne les retire pas). */
const typeDeStyleCss = (type) => type === undefined || type === '' || enMinusculesAscii(type) === 'text/css';

/** Début de chaque ligne (au sens de `split('\n')`, comme le reste de l'outil). */
function debutsDeLignes(texte) {
  const debuts = [0];
  for (let i = texte.indexOf('\n'); i >= 0; i = texte.indexOf('\n', i + 1)) debuts.push(i + 1);
  return debuts;
}

function positionDans(debuts, decalage) {
  let bas = 0;
  let haut = debuts.length - 1;
  while (bas < haut) {
    const milieu = (bas + haut + 1) >> 1;
    if (debuts[milieu] <= decalage) bas = milieu;
    else haut = milieu - 1;
  }
  return { ligne: bas + 1, colonne: decalage - debuts[bas] };
}

/**
 * Le scanner de préchargement de Chromium, qui lit la page avant le
 * constructeur d'arbre et demande les `@import` d'un `<style>` sans passer
 * par l'analyseur CSS. Il ne suit ni les espaces de noms ni l'arbre : chaque
 * `<style>` (HTML, SVG ou MathML, même auto-fermant) y ouvre un texte brut
 * jusqu'au premier `</style` suivi d'un blanc, d'une barre oblique ou de
 * `>` ; `script`, `title`, `textarea`… ouvrent le leur, où un `<style>`
 * n'est pas vu ; et un `<style>` n'est lu que hors de tout `<template>`,
 * compté sur les balises sans regarder l'arbre (une fermante seule ne compte
 * pas). Chaque point vérifié dans Chromium 141 (`tests/passe-html-css.test.mjs`).
 * Renvoie, par décalage de balise ouvrante, le texte brut lu (`debut`, `fin`).
 */
function lireScanner(source) {
  const styles = new Map();
  let modeles = 0;
  let ouvert = null;
  const scanner = new Decoupeur({ sourceCodeLocationInfo: true }, {
    onStartTag(balise) {
      const nom = balise.tagName;
      const { startOffset, endOffset } = balise.location;
      if (nom === 'template') modeles++;
      const mode = MODES_TEXTE_BRUT.get(nom);
      if (mode !== undefined) scanner.state = mode;
      if (nom === 'style' && modeles === 0) {
        ouvert = { debut: endOffset, fin: source.length };
        styles.set(startOffset, ouvert);
      }
    },
    onEndTag(balise) {
      const nom = balise.tagName;
      if (nom === 'template' && modeles) modeles--;
      if (nom === 'style' && ouvert) {
        ouvert.fin = balise.location.startOffset;
        ouvert = null;
      }
    },
    onCharacter() {},
    onWhitespaceCharacter() {},
    onNullCharacter() {},
    onComment() {},
    onDoctype() {},
    onEof() {},
  });
  scanner.write(source, true);
  return styles;
}

const CACHE = new Map();
const TAILLE_CACHE = 32;

/**
 * Ce que la page charge et exécute, dans l'ordre du document : ses scripts
 * (HTML, et SVG dont le code est aussi exécuté), les éléments qui
 * chargent une ressource (`link`, `iframe`, `img`, `object`, `embed`) et ses
 * feuilles de style.
 * Chaque entrée porte ses attributs (premier de chaque nom, références de
 * caractères décodées), sa balise ouvrante et sa ligne, et la base de ses
 * URL relatives : la première `<base href>` qui la précède, comme dans
 * Chromium, où une base externe envoie un `src="app.js"` vers un autre
 * hôte. Un script porte en plus `src` (ou `href` pour un script SVG),
 * `genre` (voir `genreDeScript`) et, s'il est écrit dans la page, `texte`
 * et la position exacte de son premier caractère (`decalageLigne`,
 * `decalageColonne`). Résultat mis en cache par contenu : chaque règle qui
 * lit la page la relit sans la redécouper.
 *
 * Une feuille (`feuilles`) est un CSS à lire avec `lireCss` (`css.js`) :
 * `{sorte: 'style'|'attribut', element, ns, texte, precharge, texteScanner,
 * debutScanner, applique, modele, base, ligne, debut}`. `sorte` dit si c'est
 * le contenu d'un `<style>` ou la valeur d'un attribut `style` ; `precharge`
 * que le scanner de préchargement de Chromium lit ce `<style>` (voir
 * `lireScanner` : quel que soit son espace de noms, hors `<template>`) ;
 * son texte brut, tel qu'écrit dans la page, est `texteScanner` (`debutScanner`
 * en est le décalage), différent de `texte`, celui que le constructeur
 * d'arbre lit (références décodées, sans les éléments enfants d'un style SVG) ;
 * `applique` que le navigateur en fait une feuille (un `<style
 * type="text/foo">` n'en est pas une, seul le préchargement le lit) ;
 * `modele` qu'il est dans un `<template>`, où il ne s'applique qu'une fois
 * inséré. `debut` est le décalage, dans la page, du premier caractère de
 * `texte` quand chaque caractère de `texte` est écrit tel quel dans la page,
 * sinon `null` (références de caractères, CDATA, éléments enfants d'un style
 * SVG) et `ligne` celle de l'élément. `position(feuille, decalage)` donne
 * `{ligne, colonne, exacte}` d'un décalage de `texte` (`position(feuille,
 * decalage, true)` : de `texteScanner`). Lire une feuille : `lireFeuille`.
 *
 * Un `<link rel="stylesheet" href="data:…">` est lui aussi une feuille
 * (`sorte: 'lien'`, `texte` : son corps décodé, `data`) ; `mimeLibre` dit que
 * la page est en mode quirks (`quirks`, voir `parcourirPage`), où une feuille
 * `data:` de n'importe quel type MIME est lue. Chaque `<link>` de
 * `ressources` porte `usages` (voir `usageLien`) : ce que le navigateur en
 * charge, pas seulement son `href`.
 * @returns {{scripts: Array<object>, ressources: Array<object>, feuilles: Array<object>, quirks: boolean, position: Function}}
 */
export function lirePage(contenu) {
  const connu = CACHE.get(contenu);
  if (connu) return connu;

  const debuts = debutsDeLignes(contenu);
  const scripts = [];
  const ressources = [];
  const feuilles = [];
  const scanner = lireScanner(contenu);
  let base = null;
  let baseDepuis = 0;

  const feuille = (sorte, element, balise, champs) => {
    const { startOffset } = balise.location;
    const entree = { sorte, element: element.nom, ns: element.ns, precharge: false, applique: true, modele: element.modele, base: base ?? BASE_PAR_DEFAUT, ligne: positionDans(debuts, startOffset).ligne, debut: null, texte: '', ...champs };
    feuilles.push(entree);
    return entree;
  };

  const { quirks } = parcourirPage(contenu, {
    ouverture(balise, element, parent) {
      const { nom, ns } = element;
      element.modele = Boolean(parent?.modele) || (ns === 'html' && nom === 'template');
      const localisation = balise.location.attrs?.style;
      if (localisation) {
        const valeur = attribut(balise, 'style');
        const brut = contenu.slice(localisation.startOffset, localisation.endOffset);
        const guillemet = DEBUT_VALEUR_STYLE.exec(brut);
        if (valeur && guillemet) {
          const debut = localisation.startOffset + guillemet[0].length;
          const ecrit = contenu.slice(debut, localisation.endOffset - guillemet[1].length);
          const exacte = sansRetourChariot(ecrit) === valeur;
          feuille('attribut', element, balise, { texte: exacte ? ecrit : valeur, debut: exacte ? debut : null, ligne: positionDans(debuts, localisation.startOffset).ligne });
        }
      }
      if (nom === 'style') {
        const entree = feuille('style', element, balise, { applique: typeDeStyleCss(attribut(balise, 'type')) });
        const lu = scanner.get(balise.location.startOffset);
        if (lu) {
          scanner.delete(balise.location.startOffset);
          Object.assign(entree, { precharge: true, texteScanner: contenu.slice(lu.debut, lu.fin), debutScanner: lu.debut });
        }
        element.feuille = entree;
        entree.debutContenu = balise.location.endOffset;
        if (ns !== 'html') entree.morceaux = [];
      }
      if (!ELEMENTS_LUS.has(nom) || (ns !== 'html' && !(ns === 'svg' && nom === 'script'))) return;
      const attributs = new Map(balise.attrs.map(({ name, value }) => [name, value]));
      const { startOffset: debut, endOffset: fin } = balise.location;
      if (nom === 'base') {
        if (base === null && attributs.has('href')) {
          base = resoudreUrl(attributs.get('href'))?.href ?? BASE_PAR_DEFAUT;
          baseDepuis = debut;
        }
        return;
      }
      const entree = { nom, ns, attributs, debut, fin, ligne: positionDans(debuts, debut).ligne, balise: contenu.slice(debut, fin), base: base ?? BASE_PAR_DEFAUT };
      if (nom !== 'script') {
        if (nom === 'link') {
          entree.usages = usageLien(attributs);
          for (const usage of entree.usages) if (usage.genre === 'feuille') for (const url of usage.urls) {
            const data = decoderUrlData(url);
            if (data) feuille('lien', element, balise, { applique: false, data, texte: data.corps ?? '', trop: data.corps === null });
          }
        }
        ressources.push(entree);
        return;
      }
      entree.src = (ns === 'html' ? attributs.get('src') : attributs.get('href') ?? attributs.get('xlink:href')) ?? null;
      // SVG accepte un script classique ou module (vérifié dans Chromium : `this` vaut `undefined` en module, `window` en classique), mais pas d'import map.
      const genre = genreDeScript(attributs);
      entree.genre = ns === 'html' ? genre : genre === 'importmap' ? null : genre;
      entree.texte = null;
      if (entree.src === null) {
        element.script = entree;
        entree.debutContenu = fin;
        if (ns !== 'html') entree.morceaux = [];
      }
      scripts.push(entree);
    },
    texte(jeton, haut) {
      haut?.script?.morceaux?.push(jeton.chars);
      haut?.feuille?.morceaux?.push(jeton.chars);
    },
    fermeture(element, finContenu) {
      const style = element.feuille;
      if (style) {
        const ecrit = contenu.slice(style.debutContenu, finContenu);
        const lu = style.morceaux ? style.morceaux.join('') : ecrit;
        const exacte = sansRetourChariot(ecrit) === sansRetourChariot(lu);
        style.texte = exacte ? ecrit : lu;
        if (exacte) style.debut = style.debutContenu;
        delete style.morceaux;
        delete style.debutContenu;
      }
      const script = element.script;
      if (!script) return;
      script.texte = script.morceaux ? script.morceaux.join('') : contenu.slice(script.debutContenu, finContenu);
      delete script.morceaux;
      const { ligne, colonne } = positionDans(debuts, script.debutContenu);
      script.decalageLigne = ligne - 1;
      script.decalageColonne = colonne;
    },
  });

  // Un script SVG vide et auto-fermant (`<script/>`) n'est jamais dépilé.
  for (const script of scripts) if (script.src === null && script.texte === null) {
    script.texte = '';
    const { ligne, colonne } = positionDans(debuts, script.debutContenu);
    script.decalageLigne = ligne - 1;
    script.decalageColonne = colonne;
  }

  // Un style SVG vide et auto-fermant (`<style/>`) n'est jamais dépilé non plus.
  for (const style of feuilles) {
    delete style.morceaux;
    delete style.debutContenu;
  }

  // Un `<style>` que le scanner voit et pas le constructeur d'arbre (texte brut de l'un, balisage de l'autre) : il n'est pas une feuille, seul le préchargement le lit.
  for (const [decalage, lu] of scanner) {
    feuilles.push({ sorte: 'style', element: 'style', ns: 'html', precharge: true, applique: false, modele: false, base: base !== null && baseDepuis < decalage ? base : BASE_PAR_DEFAUT, ligne: positionDans(debuts, decalage).ligne, debut: null, texte: '', texteScanner: contenu.slice(lu.debut, lu.fin), debutScanner: lu.debut });
  }

  // Une feuille `data:` d'un `<link>` n'est lue que si son type MIME est `text/css` ou si la page est en mode quirks, où tout type passe (les `@import` imbriqués suivent la même règle).
  for (const f of feuilles) {
    f.mimeLibre = quirks;
    if (f.sorte === 'lien') f.applique = f.data.mime === 'text/css' || quirks;
  }

  const position = (entree, decalage, scanner = false) => {
    const origine = scanner ? entree.debutScanner : entree.debut;
    const exacte = origine !== null && origine !== undefined;
    const { ligne, colonne } = exacte ? positionDans(debuts, origine + decalage) : { ligne: entree.ligne, colonne: 0 };
    return { ligne, colonne, exacte };
  };
  const resultat = { scripts, ressources, feuilles, quirks, position };
  if (CACHE.size >= TAILLE_CACHE) CACHE.clear();
  CACHE.set(contenu, resultat);
  return resultat;
}
