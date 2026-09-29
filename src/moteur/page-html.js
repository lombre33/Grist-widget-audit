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
import { TokenizerMode, foreignContent } from 'parse5';
import { Decoupeur } from './decoupeur-html.js';

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
  if (nom === 'annotation-xml') return /^(text\/html|application\/xhtml\+xml)$/i.test((attribut(balise, 'encoding') ?? '').trim());
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
 */
export function parcourirPage(source, visiteur) {
  const pile = [];
  const ouverts = new Map();
  let boutonsOuverts = 0;

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
      const nom = balise.tagName;
      if (!ouverts.get(nom)) return;
      const { startOffset, endOffset } = balise.location;
      while (pile.at(-1).nom !== nom) depiler(startOffset, endOffset);
      depiler(startOffset, endOffset);
      ajusterModeEtranger();
    },
    onCharacter(jeton) { visiteur.texte?.(jeton, pile.at(-1), 'caractere'); },
    onWhitespaceCharacter(jeton) { visiteur.texte?.(jeton, pile.at(-1), 'blanc'); },
    onNullCharacter(jeton) { visiteur.texte?.(jeton, pile.at(-1), 'nul'); },
    onComment() {},
    onDoctype() {},
    onEof() {
      while (pile.length) depiler(source.length, source.length);
      visiteur.fin?.();
    },
  });
  decoupeur.write(source, true);
}

/** Les types MIME JavaScript du standard MIME Sniffing, que le navigateur exécute comme script classique. */
const TYPES_JAVASCRIPT = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);

const sansBlancsDeBord = (texte) => texte.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
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

const ELEMENTS_LUS = new Set(['script', 'base', 'link', 'iframe', 'img', 'object', 'embed']);

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

const CACHE = new Map();
const TAILLE_CACHE = 32;

/**
 * Ce que la page charge et exécute, dans l'ordre du document : ses scripts
 * (HTML, et SVG dont le code est aussi exécuté) et les éléments qui
 * chargent une ressource (`link`, `iframe`, `img`, `object`, `embed`).
 * Chaque entrée porte ses attributs (premier de chaque nom, références de
 * caractères décodées), sa balise ouvrante et sa ligne, et la base de ses
 * URL relatives : la première `<base href>` qui la précède, comme dans
 * Chromium, où une base externe envoie un `src="app.js"` vers un autre
 * hôte. Un script porte en plus `src` (ou `href` pour un script SVG),
 * `genre` (voir `genreDeScript`) et, s'il est écrit dans la page, `texte`
 * et la position exacte de son premier caractère (`decalageLigne`,
 * `decalageColonne`). Résultat mis en cache par contenu : chaque règle qui
 * lit la page la relit sans la redécouper.
 * @returns {{scripts: Array<object>, ressources: Array<object>}}
 */
export function lirePage(contenu) {
  const connu = CACHE.get(contenu);
  if (connu) return connu;

  const debuts = debutsDeLignes(contenu);
  const scripts = [];
  const ressources = [];
  let base = null;

  parcourirPage(contenu, {
    ouverture(balise, element) {
      const { nom, ns } = element;
      if (!ELEMENTS_LUS.has(nom) || (ns !== 'html' && !(ns === 'svg' && nom === 'script'))) return;
      const attributs = new Map(balise.attrs.map(({ name, value }) => [name, value]));
      const { startOffset: debut, endOffset: fin } = balise.location;
      if (nom === 'base') {
        if (base === null && attributs.has('href')) base = resoudreUrl(attributs.get('href'))?.href ?? BASE_PAR_DEFAUT;
        return;
      }
      const entree = { nom, ns, attributs, debut, fin, ligne: positionDans(debuts, debut).ligne, balise: contenu.slice(debut, fin), base: base ?? BASE_PAR_DEFAUT };
      if (nom !== 'script') {
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
    },
    fermeture(element, finContenu) {
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

  const resultat = { scripts, ressources };
  if (CACHE.size >= TAILLE_CACHE) CACHE.clear();
  CACHE.set(contenu, resultat);
  return resultat;
}
