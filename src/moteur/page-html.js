/**
 * Lecture d'une page HTML telle que le navigateur la découpe : le découpeur
 * du standard HTML (voir `Decoupeur`) et une pile d'éléments simplifiée,
 * que partagent les règles de sécurité, l'analyse JavaScript et l'inventaire.
 * Une expression régulière ne sait pas qu'un `>` entre guillemets ne ferme
 * pas une balise, qu'un commentaire ne contient aucun élément, qu'un
 * `<!--<script>` dans un script fait ignorer le `</script>` suivant, ni
 * qu'une valeur d'attribut peut s'écrire sans guillemets ou avec des
 * références de caractères : chacune de ces différences cachait du code
 * exécuté à l'analyse statique, ou lui faisait lire du code qui ne s'exécute
 * jamais (vérifié dans Chromium 141, le 2026-09-28 et 29).
 *
 * Pas encore une passe unique : `f-conformite.js` (F-RGAA) garde sa propre
 * marche du découpeur jusqu'à l'étape 3, où elle passera par `parcourirPage`.
 */
import path from 'node:path';
import { TokenizerMode, foreignContent, parse, defaultTreeAdapter } from 'parse5';
import { Decoupeur } from './decoupeur-html.js';
import { decoderUrlData } from './css.js';
import { ORIGINE_LOCALE, preparerBase, resoudre } from './base-url.js';

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
  if (nom === 'annotation-xml') return /^(text\/html|application\/xhtml\+xml)$/i.test(attribut(balise, 'encoding') ?? '');
  return ['mi', 'mo', 'mn', 'ms', 'mtext'].includes(nom);
}

/**
 * Éléments qui laissent la page en phase de tête (modes « in head » et
 * « after head » du standard) : tout autre élément ouvre le corps, et une
 * balise `<meta>` qui suit n'est plus dans `<head>`.
 */
const ELEMENTS_DE_TETE = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'noframes', 'noscript', 'script', 'style', 'template', 'title', 'html', 'head']);

const nouvellePortee = () => ({ ouverts: new Map(), boutons: 0 });

/**
 * Une passe du découpeur sur une page, avec une pile d'éléments simplifiée
 * à la place du constructeur d'arbre de parse5, quadratique sur des pages
 * piégées : chaque élément entre et sort une fois, et un compte des éléments
 * ouverts par nom fait ignorer en temps constant une balise fermante sans
 * ouvrante. Ce que le constructeur faisait et qui change le découpage est
 * repris ici : le contenu de `script`, `style`, `textarea`… n'est pas du
 * balisage ; dans `svg` et `math`, `title` n'en est pas un et la barre
 * oblique ferme l'élément (`</p>` et `</br>` sortent aussi de l'étranger) ;
 * une balise HTML y ramène au HTML ; les éléments vides ne s'empilent pas ;
 * un `<button>` ferme celui qui est ouvert ; une balise fermante ne franchit
 * pas un `<template>` (hors `</template>` lui-même).
 *
 * Ce que la pile ne reproduit pas : la barrière des éléments spéciaux d'une
 * balise fermante HTML ordinaire (`<span><div></span>` ferme ici le div) et
 * l'algorithme d'adoption des éléments de mise en forme. Rien de ce que
 * l'audit décide n'en dépend (contenu de gabarit, phase de tête, script
 * SVG fermé ou non), sauf un `</svg>` perdu sous un `<foreignObject>` qui
 * ferme ici plus qu'un navigateur.
 *
 * Le visiteur reçoit `ouverture(balise, element, parent)` avant que
 * l'élément soit empilé (il peut l'annoter ; `element.dansTemplate` et
 * `element.dansTete` y sont déjà posés), `fermeture(element, finContenu,
 * finBalise)` quand il est dépilé (balise fermante, fermeture implicite ou
 * fin du document, où les deux positions se confondent ; `element.ferme`
 * vaut vrai seulement si SA balise fermante l'a fermé), `texte(jeton, haut,
 * sorte)` pour chaque caractère (`sorte` : 'caractere', 'blanc' ou 'nul'),
 * et `fin()`. Les éléments vides ou fermés d'eux-mêmes (SVG `<x/>`) n'ont
 * pas de `fermeture` : `ferme` y est posé dès `ouverture`. Si `ouverture`
 * pose `element.positions`, les jetons de texte de cet élément portent
 * `origines` (voir `Decoupeur`) : la position dans le source de chaque unité
 * de leur texte, décodé.
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
  const portees = [nouvellePortee()];
  let portee = portees[0];
  let templatesOuverts = 0;
  let phase = 'tete';
  let doctypePossible = true;
  let quirks = false;
  const contenuAvantDoctype = () => {
    if (doctypePossible) {
      doctypePossible = false;
      quirks = true;
    }
  };

  const depiler = (finContenu, finBalise, propre = false) => {
    const element = pile.pop();
    if (element.gabaritHtml) {
      templatesOuverts--;
      portees.pop();
      portee = portees.at(-1);
    }
    const compte = element.portee;
    compte.ouverts.set(element.nom, compte.ouverts.get(element.nom) - 1);
    if (element.boutonHtml) compte.boutons--;
    element.ferme = propre;
    visiteur.fermeture?.(element, finContenu, finBalise);
  };
  const ajusterModeEtranger = () => {
    const haut = pile.at(-1);
    decoupeur.inForeignNode = Boolean(haut && haut.ns !== 'html' && !haut.integration);
    decoupeur.enregistrer = Boolean(haut?.positions);
  };
  const sortirDeLEtranger = (position) => {
    while (pile.length && pile.at(-1).ns !== 'html' && !pile.at(-1).integration) depiler(position, position);
    ajusterModeEtranger();
  };
  const ouvrirLeCorps = () => {
    if (templatesOuverts === 0) phase = 'corps';
  };

  const decoupeur = new Decoupeur({ sourceCodeLocationInfo: true }, {
    onStartTag(balise) {
      contenuAvantDoctype();
      const nom = balise.tagName;
      const { startOffset } = balise.location;
      if (decoupeur.inForeignNode && foreignContent.causesExit(balise)) sortirDeLEtranger(startOffset);
      const ns = decoupeur.inForeignNode ? pile.at(-1).ns : nom === 'svg' || nom === 'math' ? nom : 'html';
      if (phase !== 'corps' && (ns !== 'html' || nom === 'body' || !ELEMENTS_DE_TETE.has(nom))) ouvrirLeCorps();
      if (ns === 'html' && nom === 'button' && portee.boutons) {
        while (!pile.at(-1).boutonHtml) depiler(startOffset, startOffset);
        depiler(startOffset, startOffset);
        ajusterModeEtranger();
      }
      const parent = pile.at(-1);
      const vide = ns === 'html' ? ELEMENTS_VIDES.has(nom) : balise.selfClosing;
      const element = {
        nom, ns, portee, brut: false, ferme: vide,
        integration: ns !== 'html' && estPointIntegration(ns, nom, balise),
        boutonHtml: ns === 'html' && nom === 'button',
        gabaritHtml: ns === 'html' && nom === 'template',
        gabaritEtranger: ns === 'html' ? null : nom === 'template' ? true : parent?.ns !== 'html' && parent?.gabaritEtranger ? parent.gabaritEtranger : null,
        dansTemplate: templatesOuverts > 0,
        dansTete: phase !== 'corps' && templatesOuverts === 0,
      };
      visiteur.ouverture?.(balise, element, parent);

      if (vide) return;
      if (ns === 'html' && MODES_TEXTE_BRUT.has(nom)) {
        decoupeur.state = MODES_TEXTE_BRUT.get(nom);
        element.brut = true;
      }
      pile.push(element);
      portee.ouverts.set(nom, (portee.ouverts.get(nom) ?? 0) + 1);
      if (element.boutonHtml) portee.boutons++;
      if (element.gabaritHtml) {
        templatesOuverts++;
        portee = nouvellePortee();
        portees.push(portee);
      }
      ajusterModeEtranger();
    },
    onEndTag(balise) {
      contenuAvantDoctype();
      const nom = balise.tagName;
      const { startOffset, endOffset } = balise.location;
      if (templatesOuverts === 0) {
        if (nom === 'head') {
          if (phase === 'tete') phase = 'apres-tete';
        } else if (nom === 'body' || nom === 'html' || nom === 'br') phase = 'corps';
      }
      if (decoupeur.inForeignNode && (nom === 'br' || nom === 'p')) sortirDeLEtranger(startOffset);
      if (nom === 'template') {
        const haut = pile.at(-1);
        if (decoupeur.inForeignNode && haut.gabaritEtranger) {
          const propre = haut.nom === 'template';
          while (pile.at(-1).nom !== 'template' || pile.at(-1).ns === 'html') depiler(startOffset, endOffset);
          depiler(startOffset, endOffset, propre);
        } else if (templatesOuverts > 0) {
          const propre = haut.gabaritHtml;
          while (!pile.at(-1).gabaritHtml) depiler(startOffset, endOffset);
          depiler(startOffset, endOffset, propre);
        }
        ajusterModeEtranger();
        return;
      }
      if (!portee.ouverts.get(nom)) return;
      const propre = pile.at(-1).nom === nom;
      while (pile.at(-1).nom !== nom) depiler(startOffset, endOffset);
      depiler(startOffset, endOffset, propre);
      ajusterModeEtranger();
    },
    onCharacter(jeton) {
      contenuAvantDoctype();
      const haut = pile.at(-1);
      if (phase !== 'corps' && !haut?.brut) ouvrirLeCorps();
      visiteur.texte?.(jeton, haut, 'caractere');
    },
    onWhitespaceCharacter(jeton) { visiteur.texte?.(jeton, pile.at(-1), 'blanc'); },
    onNullCharacter(jeton) {
      const haut = pile.at(-1);
      if (phase !== 'corps' && !haut?.brut) ouvrirLeCorps();
      visiteur.texte?.(jeton, haut, 'nul');
    },
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

/** Blancs de bord du standard HTML (espace, tabulation, saut de ligne, saut de page, retour chariot), retirés en temps linéaire. */
function sansBlancsDeBord(texte) {
  const espace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
  let a = 0;
  let b = texte.length;
  while (a < b && espace(texte.charCodeAt(a))) a++;
  while (b > a && espace(texte.charCodeAt(b - 1))) b--;
  return texte.slice(a, b);
}

/**
 * Blancs que Chromium retire autour d'un `type` avant de le comparer aux
 * types JavaScript (`String::StripWhiteSpace` : les blancs ASCII, tabulation
 * verticale comprise, et les caractères de direction « blanc neutre »).
 * Ensemble relevé sur les 1 114 112 points de code de Chromium 141, avant,
 * après et des deux côtés : U+0009 à U+000D, U+0020, U+1680, U+2000 à
 * U+200A, U+2028, U+205F, U+3000. Ni U+00A0, ni U+0085, ni U+180E, ni
 * U+2029, ni U+202F, ni U+2060, ni U+FEFF n'en font partie.
 */
const BLANCS_DE_TYPE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x1680, 0x2028, 0x205f, 0x3000]);
for (let point = 0x2000; point <= 0x200a; point++) BLANCS_DE_TYPE.add(point);

function sansBlancsDeType(texte) {
  let debut = 0;
  let fin = texte.length;
  while (debut < fin && BLANCS_DE_TYPE.has(texte.charCodeAt(debut))) debut++;
  while (fin > debut && BLANCS_DE_TYPE.has(texte.charCodeAt(fin - 1))) fin--;
  return texte.slice(debut, fin);
}

const enMinusculesAscii = (texte) => texte.replace(/[A-Z]/g, (c) => c.toLowerCase());
const CLASSES_DE_MODULE = new Set(['module', 'importmap']);

/**
 * Ce que Chromium fait d'un `<script>` (vérifié dans Chromium 141 : sondes
 * `type`, `language` et `nomodule`, en HTML et en SVG, et balayage des
 * 1 114 112 points de code autour du `type`) : `genre` vaut 'classique',
 * 'module', 'importmap', ou null s'il ne l'exécute pas.
 *
 * Un `type` vide, ou ni `type` ni `language`, donne un script classique ;
 * sans `type`, `language` doit former un type JavaScript une fois précédé de
 * `text/` (HTML seulement : SVG l'ignore, comme `nomodule`) ; sinon le
 * `type`, débarrassé des blancs de `BLANCS_DE_TYPE`, doit être un type
 * JavaScript, sans tenir compte de la casse ASCII. Un type suivi de
 * paramètres (`text/javascript; charset=utf-8`) et les noms historiques
 * (`javascript`, `ecmascript`) ne s'exécutent pas. `module` et `importmap`
 * se comparent tels quels : `" module "` ne s'exécute pas dans Chromium, mais
 * un navigateur qui suit le standard HTML retire les blancs ASCII et
 * l'exécute ; l'analyse le lit alors (`seulementStandard`) pour ne pas
 * laisser passer du code qu'un autre navigateur exécuterait. Un script
 * classique HTML qui porte `nomodule` n'est pas exécuté.
 * @param {Map<string, string>} attributs
 * @param {string} [ns] 'html' (défaut) ou 'svg'
 * @returns {{genre: 'classique'|'module'|'importmap'|null, seulementStandard: boolean}}
 */
export function typeDeScript(attributs, ns = 'html') {
  const type = attributs.get('type');
  const langage = ns === 'html' ? attributs.get('language') : undefined;
  let genre = null;
  let seulementStandard = false;
  if (type === '' || (type === undefined && !langage)) genre = 'classique';
  else if (type === undefined) genre = TYPES_JAVASCRIPT.has(enMinusculesAscii(`text/${langage}`)) ? 'classique' : null;
  else if (TYPES_JAVASCRIPT.has(enMinusculesAscii(sansBlancsDeType(type)))) genre = 'classique';
  else if (CLASSES_DE_MODULE.has(enMinusculesAscii(type))) genre = enMinusculesAscii(type);
  else {
    const standard = enMinusculesAscii(sansBlancsDeBord(type));
    if (CLASSES_DE_MODULE.has(standard)) {
      genre = standard;
      seulementStandard = true;
    }
  }
  if (genre === 'classique' && ns === 'html' && attributs.has('nomodule')) genre = null;
  return { genre, seulementStandard };
}

/** `typeDeScript(...).genre` : ce que Chromium exécute, sans le détail des lectures qui ne valent que pour le standard. */
export function genreDeScript(attributs, ns = 'html') {
  return typeDeScript(attributs, ns).genre;
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

/** URL de la page dans le widget : l'origine fictive suivie de son chemin, chaque segment encodé. */
export function urlDePage(chemin = '') {
  return new URL(String(chemin).split('/').map(encodeURIComponent).join('/'), `${ORIGINE_LOCALE}/`);
}

/**
 * Base des références relatives d'une entrée, comme Chromium la calcule depuis
 * la valeur brute du `href` de la première `<base>` qui la précède
 * (`baseBrute`, null s'il n'y en a pas). Une base vide, invalide, ou en `data:`
 * ou `javascript:` laisse la base de la page ; une base relative se résout
 * contre l'URL de la page. Vérifié dans Chromium 141 (sonde de bases :
 * `data:`, `javascript:`, `about:blank`, `blob:`, `file:`, `ftp:`, protocole
 * relatif, chemin sans barre finale, espaces, fragment).
 * Une base qui se lit une fois et se résout autant de fois que la page a de
 * références : voir `preparerBase`, qui garde le coût d'une référence
 * indépendant de la longueur de la base sans rien en retrancher.
 * @returns {{ url: URL, longue: object|null }}
 */
export function baseDe(baseBrute, cheminPage = '') {
  // Mémorisée : une base de plusieurs Mo relue à chaque référence rendrait la résolution quadratique.
  const cle = baseBrute ?? null;
  let parChemin = BASES.get(cle);
  if (!parChemin) {
    if (BASES.size >= 64) BASES.clear();
    parChemin = new Map();
    BASES.set(cle, parChemin);
  }
  let base = parChemin.get(cheminPage);
  if (base === undefined) {
    base = preparerBase(urlDeBase(baseBrute, cheminPage));
    parChemin.set(cheminPage, base);
  }
  return base;
}

const BASES = new Map();

function urlDeBase(baseBrute, cheminPage) {
  const page = urlDePage(cheminPage);
  if (baseBrute === null || baseBrute === undefined) return page;
  const valeur = sansBlancsDeBord(baseBrute);
  if (valeur === '') return page;
  let base;
  try { base = new URL(valeur, page); } catch { return page; }
  if (base.protocol === 'data:' || base.protocol === 'javascript:') return page;
  return base;
}

/**
 * URL absolue d'une référence d'une entrée de la page ; null si elle ne se
 * résout pas (une base `about:blank` ou `blob:` n'en résout aucune). Seules
 * les URL `http:` et `https:` chargent quelque chose : à l'appelant de
 * l'écarter pour `file:`, `ftp:`, `data:`… Sous une base longue, l'objet rendu
 * offre les propriétés de lecture d'un `URL` (voir `UrlSousBaseLongue`).
 * @returns {URL|import('./base-url.js').UrlSousBaseLongue|null}
 */
export function urlDe(valeur, baseBrute, cheminPage = '') {
  try { return resoudre(valeur, baseDe(baseBrute, cheminPage)); } catch { return null; }
}

/**
 * Comme `urlDe`, pour une URL d'import map : seules les formes `./`, `../` et
 * `/` (et une URL absolue) se résolvent, une adresse relative nue n'est
 * jamais une adresse (Chromium 141 : `"x": "rel.js"` ne charge rien).
 * @returns {URL|null}
 */
export function urlDeCarte(valeur, baseBrute, cheminPage = '') {
  if (/^(\.\/|\.\.\/|\/)/.test(valeur)) return urlDe(valeur, baseBrute, cheminPage);
  try { return new URL(valeur); } catch { return null; }
}

/**
 * Chemin, dans le widget, du fichier qu'une URL désigne ; null si elle sort
 * du widget (autre origine : le fichier du même nom, s'il existe, n'est
 * jamais lu à sa place) ou ne se décode pas.
 * Le chemin est celui que sert un serveur de fichiers : décodé (`%61pp.js`,
 * `js%2Fapp.js`), puis normalisé (`js//app.js`, `js/./app.js` et
 * `js/..%2Fapp.js` désignent `js/app.js` et `app.js`). Un chemin écrit pour que
 * l'audit ne trouve pas le fichier que le navigateur demande est un code
 * exécuté que personne n'a lu : dans le doute, on inclut.
 * @returns {string|null}
 */
export function cheminLocal(url) {
  if (!url || url.origin !== ORIGINE_LOCALE) return null;
  try { return path.posix.normalize(decodeURIComponent(url.pathname)).slice(1); } catch { return null; }
}

const MENTION_GABARIT = 'dans un `<template>` : ne s\'exécute qu\'une fois le gabarit cloné puis inséré';
const MENTION_STANDARD = 'Chromium ne l\'exécute pas, un navigateur qui suit le standard HTML si';

/** Ce qu'un constat doit dire d'une entrée que Chromium n'exécute pas tout de suite, ou pas du tout ; null s'il n'y a rien à dire. */
export function mentionDe(entree) {
  const mentions = [];
  if (entree.dansTemplate) mentions.push(MENTION_GABARIT);
  if (entree.seulementStandard) mentions.push(MENTION_STANDARD);
  return mentions.length ? mentions.join(' ; ') : null;
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

const LUS_HTML = new Set(['script', 'base', 'link', 'iframe', 'img', 'object', 'embed', 'a', 'meta']);
const LUS_SVG = new Set(['script', 'a']);
const LUS_MATHML = new Set(['script']);
const estLu = (nom, ns) => (ns === 'html' ? LUS_HTML : ns === 'svg' ? LUS_SVG : LUS_MATHML).has(nom);

const estBlanc = (valeur) => sansBlancsDeBord(valeur) === '';
const seCharge = (genre) => genre === 'classique' || genre === 'module';

/**
 * Ce qu'un `<script>` demande au réseau, avant de savoir s'il a été fermé.
 * Chromium 141 : un script HTML avec `src` est demandé même s'il n'est jamais
 * fermé (le préchargeur), mais ne s'exécute que fermé ; un script SVG
 * s'exécute par `href` (ou `xlink:href`, `href` d'abord) selon les règles de
 * type de SVG, seulement s'il est fermé par son `</script>` (ou auto-fermant),
 * et son `src` est demandé par le préchargeur selon les règles de type HTML,
 * sans jamais s'exécuter ; un script MathML ne fait que demander son `src`.
 * Une valeur blanche ne demande rien ; un import map, un `type` refusé ou
 * `nomodule` non plus.
 */
function demandesDe({ ns, attributs }) {
  const demandes = [];
  const ajouter = (valeur, mode, seulementStandard) => {
    if (valeur !== undefined && !estBlanc(valeur)) demandes.push({ valeur, mode, seulementStandard });
  };
  if (ns === 'svg') {
    const execution = typeDeScript(attributs, 'svg');
    if (seCharge(execution.genre)) ajouter(attributs.has('href') ? attributs.get('href') : attributs.get('xlink:href'), 'reference-svg', execution.seulementStandard);
  }
  const chargement = typeDeScript(attributs, 'html');
  if (seCharge(chargement.genre)) ajouter(attributs.get('src'), ns === 'html' ? 'src-html' : 'src-sans-execution', chargement.seulementStandard);
  return demandes;
}

/** Ce que Chromium lit du texte d'un `<script>` selon son espace de noms, ce qui le remplace, et ce qu'il demande. */
function classerScript(entree) {
  const { ns, attributs } = entree;
  const lecture = ns === 'html' ? typeDeScript(attributs, 'html') : ns === 'svg' ? typeDeScript(attributs, 'svg') : { genre: null, seulementStandard: false };
  entree.genre = lecture.genre;
  entree.seulementStandard = lecture.seulementStandard;
  entree.src = attributs.get('src') ?? null;
  entree.texteLu = ns === 'html' ? !attributs.has('src') : ns === 'svg' ? !(attributs.has('href') || attributs.has('xlink:href')) : false;
  entree.demandes = demandesDe(entree);
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

/** Ce que Chromium met à la place d'un caractère nul dans le texte d'un élément SVG. */
const CARACTERE_DE_REMPLACEMENT = String.fromCharCode(0xfffd);

/**
 * Ce que la page charge et exécute, dans l'ordre du document.
 *
 * `scripts` : les `<script>` HTML, SVG et MathML. Chaque entrée porte ses
 * attributs (premier de chaque nom, références de caractères décodées), sa
 * balise ouvrante, sa ligne, `baseBrute` (le `href` brut de la première
 * `<base>` qui la précède, hors gabarit : à résoudre avec `urlDe`), `ferme`
 * (vrai seulement si SA balise fermante l'a fermée : Chromium n'exécute pas
 * un script que la fin du document ou une balise voisine referme), `genre`,
 * `seulementStandard`, `mention` (ce qu'un constat doit dire de l'entrée) et
 * `chargements` : chaque URL qu'elle demande, avec `execute` vrai si le
 * navigateur l'exécute (un `src` HTML fermé, un `href` SVG fermé) et faux
 * s'il ne fait que la demander (préchargeur, `src` d'un script SVG ou MathML,
 * script jamais fermé). `unite` est vrai quand le texte du script est du code
 * que Chromium exécute ; `carteImport` quand c'est une import map qu'il
 * applique. `texte` est le texte que le navigateur lit (null si `src` ou
 * `href` le remplace), `positionDe(décalage dans le texte)` en donne la
 * ligne et la colonne dans le fichier, y compris quand le texte SVG a été
 * décodé (références de caractères, CDATA).
 *
 * `ressources` : les `link`, `iframe`, `img`, `object` et `embed` HTML.
 * `balises` : les `a` (HTML et SVG) et les `meta` HTML. `titre` : le texte
 * décodé du premier `<title>` HTML hors gabarit (null s'il n'y en a pas), ce
 * que `document.title` lit. `positionDe(décalage dans le fichier)`.
 *
 * Chaque entrée dit aussi `dansTemplate` (le navigateur ne l'exécute qu'une
 * fois le gabarit cloné puis inséré) et `dansTete` (encore dans `<head>` au
 * sens du standard, et hors de tout `<template>` : une `<meta http-equiv>` de
 * CSP n'agit que là).
 * Résultat mis en cache par contenu : chaque règle qui lit la page la relit
 * sans la redécouper.
 *
 * `feuilles` : le CSS que la page écrit, à lire avec `lireFeuille` (`css.js`) :
 * `{sorte: 'style'|'attribut'|'lien', element, ns, texte, precharge,
 * texteScanner, debutScanner, applique, modele, baseBrute, ligne, debut}`.
 * `sorte` dit si c'est le contenu d'un `<style>`, la valeur d'un attribut
 * `style` ou le corps d'un `<link rel="stylesheet" href="data:…">` ;
 * `precharge` que le scanner de préchargement de Chromium lit ce `<style>`
 * (voir `lireScanner` : quel que soit son espace de noms, hors `<template>`) ;
 * son texte brut, tel qu'écrit dans la page, est `texteScanner` (`debutScanner`
 * en est le décalage), différent de `texte`, celui que le constructeur
 * d'arbre lit (références décodées, sans les éléments enfants d'un style SVG) ;
 * `applique` que le navigateur en fait une feuille (un `<style
 * type="text/foo">` n'en est pas une, seul le préchargement le lit) ;
 * `modele` qu'il est dans un `<template>`, où il ne s'applique qu'une fois
 * inséré ; `baseBrute` le `href` brut de la `<base>` dont ses URL relatives
 * dépendent (à résoudre avec `urlDe`, comme pour les scripts). `debut` est le
 * décalage, dans la page, du premier caractère de `texte` quand chaque
 * caractère de `texte` est écrit tel quel dans la page, sinon `null`
 * (références de caractères, CDATA, éléments enfants d'un style SVG) et
 * `ligne` celle de l'élément. `position(feuille, decalage)` donne `{ligne,
 * colonne, exacte, decalage}` d'un décalage de `texte` (`position(feuille,
 * decalage, true)` : de `texteScanner`) ; `decalage` est alors celui de la
 * page, `null` si la position n'est pas exacte. `mimeLibre` dit que la page est en mode quirks
 * (`quirks`, voir `parcourirPage`), où une feuille `data:` de n'importe quel
 * type MIME est lue. Chaque `<link>` de `ressources` porte `usages` (voir
 * `usageLien`) : ce que le navigateur en charge, pas seulement son `href`.
 * `baseFinale` est le `href` brut de la `<base>` que la page déclare (null sans
 * base) : celle que voit le code qui tourne une fois la page lue, quand la
 * `baseBrute` d'un script est celle qui le précède.
 * @returns {{scripts: Array<object>, ressources: Array<object>, balises: Array<object>, feuilles: Array<object>, titre: ?string, quirks: boolean, positionDe: Function, baseFinale: ?string}}
 */
export function lirePage(contenu) {
  const connu = CACHE.get(contenu);
  if (connu) return connu;

  const debuts = debutsDeLignes(contenu);
  const positionDe = (decalage) => positionDans(debuts, decalage);
  const scripts = [];
  const ressources = [];
  const balises = [];
  const feuilles = [];
  const aFinaliser = [];
  const scanner = lireScanner(contenu);
  let baseBrute = null;
  let baseDepuis = 0;
  let titre = null;
  let titreVu = false;

  const feuille = (sorte, element, balise, champs) => {
    const { startOffset } = balise.location;
    const entree = { sorte, element: element.nom, ns: element.ns, precharge: false, applique: true, modele: element.modele, baseBrute, ligne: positionDans(debuts, startOffset).ligne, debut: null, texte: '', ...champs };
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
      const estTitre = ns === 'html' && nom === 'title' && !titreVu && !element.dansTemplate;
      if (estTitre) {
        titreVu = true;
        element.titre = [];
        return;
      }
      if (!estLu(nom, ns)) return;
      const attributs = new Map(balise.attrs.map(({ name, value }) => [name, value]));
      if (nom === 'base') {
        if (baseBrute === null && !element.dansTemplate && attributs.has('href')) {
          baseBrute = attributs.get('href');
          baseDepuis = balise.location.startOffset;
        }
        return;
      }
      const { startOffset: debut, endOffset: fin } = balise.location;
      const entree = {
        nom, ns, attributs, debut, fin, ligne: positionDe(debut).ligne, balise: contenu.slice(debut, fin),
        baseBrute, dansTemplate: element.dansTemplate, dansTete: element.dansTete,
      };
      if (nom === 'script') {
        classerScript(entree);
        if (ns === 'svg' && entree.texteLu) {
          element.script = entree;
          element.positions = true;
          entree.morceaux = [];
          entree.correspondance = [];
        }
        aFinaliser.push({ entree, element });
        scripts.push(entree);
      } else if (nom === 'a' || nom === 'meta') balises.push(entree);
      else {
        if (nom === 'link') {
          entree.usages = usageLien(attributs);
          for (const usage of entree.usages) if (usage.genre === 'feuille') for (const url of usage.urls) {
            const data = decoderUrlData(url);
            if (data) feuille('lien', element, balise, { applique: false, data, texte: data.corps ?? '', trop: data.corps === null });
          }
        }
        ressources.push(entree);
      }
    },
    texte(jeton, haut, sorte) {
      if (!haut) return;
      haut.feuille?.morceaux?.push(jeton.chars);
      if (haut.titre) {
        haut.titre.push(jeton.chars);
        return;
      }
      const script = haut.script;
      if (!script) return;
      const origines = jeton.origines?.length === jeton.chars.length
        ? jeton.origines
        : Array.from({ length: jeton.chars.length }, () => jeton.location.startOffset);
      script.morceaux.push(sorte === 'nul' ? CARACTERE_DE_REMPLACEMENT.repeat(jeton.chars.length) : jeton.chars);
      for (const origine of origines) script.correspondance.push(origine);
    },
    fermeture(element, finContenu) {
      element.finContenu = finContenu;
      if (element.titre) titre = element.titre.join('');
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
    },
    fin() {
      for (const { entree, element } of aFinaliser) finaliserScript(entree, element, contenu, positionDe);
    },
  });

  // Un style SVG vide et auto-fermant (`<style/>`) n'est jamais dépilé non plus.
  for (const style of feuilles) {
    delete style.morceaux;
    delete style.debutContenu;
  }

  // Un `<style>` que le scanner voit et pas le constructeur d'arbre (texte brut de l'un, balisage de l'autre) : il n'est pas une feuille, seul le préchargement le lit.
  for (const [decalage, lu] of scanner) {
    feuilles.push({ sorte: 'style', element: 'style', ns: 'html', precharge: true, applique: false, modele: false, baseBrute: baseBrute !== null && baseDepuis < decalage ? baseBrute : null, ligne: positionDe(decalage).ligne, debut: null, texte: '', texteScanner: contenu.slice(lu.debut, lu.fin), debutScanner: lu.debut });
  }

  // Une feuille `data:` d'un `<link>` n'est lue que si son type MIME est `text/css` ou si la page est en mode quirks, où tout type passe (les `@import` imbriqués suivent la même règle).
  for (const f of feuilles) {
    f.mimeLibre = quirks;
    if (f.sorte === 'lien') f.applique = f.data.mime === 'text/css' || quirks;
  }

  const position = (entree, decalage, scanner = false) => {
    const origine = scanner ? entree.debutScanner : entree.debut;
    const exacte = origine !== null && origine !== undefined;
    const { ligne, colonne } = exacte ? positionDe(origine + decalage) : { ligne: entree.ligne, colonne: 0 };
    return { ligne, colonne, exacte, decalage: exacte ? origine + decalage : null };
  };
  const resultat = { scripts, ressources, balises, feuilles, titre, quirks, positionDe, position, baseFinale: baseBrute };
  if (CACHE.size >= TAILLE_CACHE) CACHE.clear();
  CACHE.set(contenu, resultat);
  return resultat;
}

/** Ce qui ne se sait qu'une fois le script dépilé : fermé ou non, son texte, ce qu'il charge et exécute. */
function finaliserScript(entree, element, contenu, positionDe) {
  const { ns, genre, demandes, texteLu } = entree;
  const ferme = element.ferme;
  const finContenu = element.finContenu ?? entree.fin;
  entree.ferme = ferme;
  entree.debutContenu = entree.fin;
  entree.finContenu = finContenu;
  entree.chargements = demandes.flatMap(({ valeur, mode, seulementStandard }) => {
    if (mode === 'reference-svg') return ferme ? [{ valeur, execute: true, seulementStandard }] : [];
    return [{ valeur, execute: mode === 'src-html' && ferme, seulementStandard }];
  });
  entree.texte = null;
  if (texteLu) {
    if (entree.correspondance) {
      entree.texte = entree.morceaux.join('');
      const { correspondance } = entree;
      entree.positionDe = (decalage) => positionDe(decalage < correspondance.length ? correspondance[decalage] : finContenu);
    } else {
      entree.texte = contenu.slice(entree.fin, finContenu);
      entree.positionDe = (decalage) => positionDe(entree.fin + decalage);
    }
  }
  entree.unite = texteLu && ferme && seCharge(genre) && ns !== 'math';
  entree.carteImport = texteLu && ferme && genre === 'importmap';
  entree.mention = mentionDe(entree);
  delete entree.demandes;
  delete entree.morceaux;
}
