/**
 * Couche d'analyse syntaxique JavaScript.
 *
 * On préfère un AST à des expressions régulières partout où c'est possible :
 * une regexp qui cherche « eval( » se déclenche sur un commentaire, sur une
 * chaîne de caractères ou sur `medieval(`. Dans un rapport d'audit, un faux
 * positif coûte la confiance du lecteur — c'est le défaut le plus grave que
 * puisse avoir un outil comme celui-ci.
 */
import { parse } from 'acorn';
import * as walk from 'acorn-walk';
import { Decoupeur } from './decoupeur-html.js';

/**
 * Extrait les unités de code JavaScript d'un fichier : le fichier entier pour
 * un .js, chaque <script> inline que le navigateur exécute pour un .html.
 * `module` n'est vrai que pour un `<script type="module">` inline : un
 * fichier .js peut être exécuté comme script classique par n'importe quel
 * chargement, même si un autre le charge comme module (voir `syntaxeDeModule`).
 * @returns {Array<{chemin:string, source:string, decalageLigne:number, inline:boolean, module:boolean}>}
 */
export function unitesJs(fichier) {
  if (fichier.binaire || !fichier.contenu) return [];
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(fichier.ext)) {
    return [{ chemin: fichier.chemin, source: fichier.contenu, decalageLigne: 0, inline: false, module: false }];
  }
  if (!['.html', '.htm'].includes(fichier.ext)) return [];

  const unites = [];
  for (const m of fichier.contenu.matchAll(ELEMENT_SCRIPT)) {
    const attributs = attributsDeBalise(m[1] || '');
    if (!attributs || attributs.has('src')) continue;            // autre élément ; ou script externe, traité ailleurs, dont le contenu ne s'exécute pas
    const genre = genreDeScript(attributs);
    if (!genre) continue;                                        // template, json-ld, import map… : jamais exécuté
    unites.push({
      chemin: fichier.chemin,
      source: m[2],
      decalageLigne: fichier.contenu.slice(0, m.index).split('\n').length - 1,
      inline: true,
      module: genre === 'module',
    });
  }
  return unites;
}

/** Un élément `<script>` : ses attributs, puis son contenu jusqu'à la balise fermante. */
const ELEMENT_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * Attributs d'une balise `<script…>`, lus par le découpeur du standard HTML
 * (voir `Decoupeur`) : noms en minuscules, premier attribut d'un nom gardé,
 * références de caractères décodées dans les valeurs (`type="&#109;odule"`
 * est un module pour le navigateur). Une valeur entre guillemets que
 * l'extraction a coupée au premier `>` ne se referme jamais : la balise
 * n'est alors pas émise, et rien n'est affirmé de ses attributs. `null` si
 * la balise est celle d'un autre élément (`<script-x>`), qui n'exécute rien.
 * @returns {Map<string, string> | null}
 */
function attributsDeBalise(texte) {
  let attributs = new Map();
  const rien = () => {};
  new Decoupeur({}, {
    onStartTag(balise) { attributs = balise.tagName === 'script' ? new Map(balise.attrs.map(({ name, value }) => [name, value])) : null; },
    onEndTag: rien, onCharacter: rien, onNullCharacter: rien, onWhitespaceCharacter: rien, onComment: rien, onDoctype: rien, onEof: rien,
  }).write(`<script${texte}>`, true);
  return attributs;
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
 * Ce que le navigateur fait d'un `<script>` sans `src` (standard HTML,
 * « prepare the script element », vérifié dans Chromium) : 'classique',
 * 'module', ou null s'il ne l'exécute pas. Un `type` vide, ou ni `type` ni
 * `language` non vide, donne un script classique ; sinon le type, blancs de
 * bord retirés (ou `text/` suivi de `language`), doit être un type MIME
 * JavaScript ou « module », sans tenir compte de la casse ASCII. Deux écarts
 * du côté de l'analyse : un type JavaScript suivi de paramètres
 * (`text/javascript; charset=utf-8`), que Chromium n'exécute pas, est lu ;
 * `type=" module "` est un module, comme le veut le standard, là où Chromium
 * ne l'exécute pas du tout.
 */
function genreDeScript(attributs) {
  const type = attributs.get('type');
  const langage = attributs.get('language');
  if (type === '' || (type === undefined && !langage)) return 'classique';
  const chaine = enMinusculesAscii(type === undefined ? `text/${langage}` : sansBlancsDeBord(type));
  if (TYPES_JAVASCRIPT.has(sansBlancsDeBord(chaine.split(';')[0]))) return 'classique';
  return chaine === 'module' ? 'module' : null;
}

/**
 * Vrai si l'unité contient un `import` ou un `export` de premier niveau :
 * un script classique qui en contient ne se parse pas, donc ne s'exécute
 * jamais, quel que soit le chargement qui le désigne. Un `import()`
 * dynamique n'en est pas un : il est permis partout.
 */
export function syntaxeDeModule(ast) {
  return ast.sourceType === 'module' && ast.body.some((s) => /^(Import|ExportNamed|ExportDefault|ExportAll)Declaration$/.test(s.type));
}

/**
 * Parse une unité. Renvoie null si le code est syntaxiquement invalide (TS,
 * JSX exotique…). Les commentaires sont collectés à part (`ast.commentaires`,
 * `{debut, fin}` en décalage de caractères) : acorn ne les rattache à aucun
 * nœud par défaut, or au moins une règle (A-ERR-01) a besoin de savoir si une
 * portée de code est commentée sans se soucier de la syntaxe qu'elle contient.
 */
export function parser(source) {
  for (const sourceType of ['module', 'script']) {
    try {
      const commentaires = [];
      const ast = parse(source, {
        ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true,
        onComment: (_bloc, _texte, debut, fin) => commentaires.push({ debut, fin }),
      });
      ast.commentaires = commentaires;
      return ast;
    } catch { /* on tente l'autre mode */ }
  }
  return null;
}

/** Vrai si au moins un commentaire est entièrement contenu dans la portée du nœud donné. */
export function aCommentaireDansPortee(ast, noeud) {
  return (ast?.commentaires ?? []).some((c) => c.debut >= noeud.start && c.fin <= noeud.end);
}

/**
 * Parcourt toutes les unités JS du contexte en appelant `visiteur` avec
 * l'AST et un utilitaire `signaler(noeud, …)` qui gère le décalage de ligne
 * des scripts inline.
 */
export function pourChaqueUniteJs(contexte, { surfaceSeulement = false, ignorerVendorise = false } = {}, visiteur) {
  for (const f of contexte.fichiers) {
    if (surfaceSeulement && !f.executee) continue;
    if (ignorerVendorise && f.vendorise) continue;
    for (const u of unitesJs(f)) {
      const ast = parser(u.source);
      if (!ast) { visiteur({ unite: u, ast: null, fichier: f, ligneDe: () => null, walk }); continue; }
      const ligneDe = (noeud) => (noeud?.loc?.start?.line ?? 0) + u.decalageLigne;
      visiteur({ unite: u, ast, fichier: f, ligneDe, walk });
    }
  }
}

/** Reconstitue le nom pointé d'un MemberExpression : `grist.docApi.fetchTable`. */
export function nomPointe(noeud) {
  const parts = [];
  let n = noeud;
  while (n) {
    if (n.type === 'Identifier') { parts.unshift(n.name); break; }
    if (n.type === 'ThisExpression') { parts.unshift('this'); break; }
    if (n.type === 'MemberExpression') {
      if (n.computed) {
        if (n.property.type === 'Literal') parts.unshift(String(n.property.value));
        else parts.unshift('[]');
      } else parts.unshift(n.property.name);
      n = n.object;
      continue;
    }
    if (n.type === 'CallExpression') { parts.unshift('()'); n = n.callee; continue; }
    return parts.length ? parts.join('.') : null;
  }
  return parts.join('.');
}

/** Extrait la valeur d'un littéral chaîne, y compris un template sans expression. */
export function chaineLitterale(noeud) {
  if (!noeud) return null;
  if (noeud.type === 'Literal' && typeof noeud.value === 'string') return noeud.value;
  if (noeud.type === 'TemplateLiteral' && noeud.expressions.length === 0) return noeud.quasis.map((q) => q.value.cooked).join('');
  return null;
}

/** Vrai si l'expression n'est pas une chaîne entièrement littérale (donc potentiellement dynamique). */
export function estDynamique(noeud) {
  if (!noeud) return false;
  if (noeud.type === 'Literal') return false;
  if (noeud.type === 'TemplateLiteral') return noeud.expressions.length > 0;
  if (noeud.type === 'BinaryExpression' && noeud.operator === '+') return estDynamique(noeud.left) || estDynamique(noeud.right);
  return true;
}

/**
 * Extrait les entrées d'un `<script type="importmap">` : chaque spécificateur
 * mappé (`imports`, et chaque bloc de `scopes`) avec l'URL cible et si elle
 * est couverte par la clé `integrity` de premier niveau (WHATWG — Import
 * Maps). Ce contenu est du JSON, jamais exécuté comme du JS (`unitesJs`
 * l'exclut explicitement), donc invisible à toute règle qui lit du JS ou qui
 * ne regarde que l'attribut `src` d'un `<script>` : une bibliothèque résolue
 * par un import nu après une entrée d'import map est pourtant chargée à
 * l'exécution comme n'importe quel `<script src>`.
 * @returns {Array<{spec:string, url:string, sri:boolean, index:number}>}
 *   `index` est le décalage du `<script>` dans `contenu`, pour que l'appelant
 *   calcule fichier/ligne comme pour les autres motifs HTML.
 */
export function extraireImportMaps(contenu) {
  const entrees = [];
  for (const m of contenu.matchAll(/<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let carte;
    try { carte = JSON.parse(m[1]); } catch { continue; }        // JSON invalide : rien à affirmer
    const integrites = carte && typeof carte.integrity === 'object' && carte.integrity ? carte.integrity : {};
    const parUrl = new Map();                                    // dédoublonne : plusieurs spécificateurs peuvent viser la même URL
    const ajouter = (table) => {
      if (!table || typeof table !== 'object') return;
      for (const [spec, url] of Object.entries(table)) if (typeof url === 'string') parUrl.set(url, spec);
    };
    ajouter(carte?.imports);
    for (const portee of Object.values(carte?.scopes ?? {})) ajouter(portee);
    for (const [url, spec] of parUrl) {
      entrees.push({ spec, url, sri: Object.prototype.hasOwnProperty.call(integrites, url), index: m.index });
    }
  }
  return entrees;
}
