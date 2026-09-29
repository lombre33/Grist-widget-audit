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
import { lirePage } from './page-html.js';

/**
 * Extrait les unités de code JavaScript d'un fichier : le fichier entier pour
 * un .js, chaque <script> inline que le navigateur exécute pour un .html (lus
 * par la passe unique du découpeur, voir `lirePage`). `module` n'est vrai que
 * pour un `<script type="module">` inline : un fichier .js peut être exécuté
 * comme script classique par n'importe quel chargement, même si un autre le
 * charge comme module (voir `syntaxeDeModule`).
 *
 * Une unité inline porte `positionDe(décalage dans source)` (ligne et colonne
 * dans le fichier, y compris pour un texte SVG décodé), `mention` (ce qu'un
 * constat sur cette unité doit dire : gabarit inerte, exécution par le seul
 * standard) et `debutLigne`/`finLigne` (les lignes qu'elle couvre).
 * @returns {Array<{chemin:string, source:string, positionDe:?Function, mention:?string, debutLigne:number, finLigne:number, inline:boolean, module:boolean}>}
 */
export function unitesJs(fichier) {
  if (fichier.binaire || !fichier.contenu) return [];
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(fichier.ext)) {
    return [{ chemin: fichier.chemin, source: fichier.contenu, positionDe: null, mention: null, debutLigne: 1, finLigne: Infinity, inline: false, module: false }];
  }
  if (!['.html', '.htm'].includes(fichier.ext)) return [];

  const page = lirePage(fichier.contenu);
  const unites = [];
  for (const s of page.scripts) {
    if (!s.unite) continue; // pas du code que le navigateur exécute : externe, import map, jamais fermé, type non exécuté
    unites.push({
      chemin: fichier.chemin, source: s.texte, positionDe: s.positionDe, mention: s.mention,
      debutLigne: page.positionDe(s.debutContenu).ligne, finLigne: page.positionDe(s.finContenu).ligne,
      inline: true, module: s.genre === 'module',
    });
  }
  return unites;
}

/** Ligne (1-based) d'un nœud dans le fichier réel : par le décalage du nœud dans l'unité pour un script inline, par acorn pour un fichier .js. */
export function ligneDans(unite, noeud) {
  if (unite.positionDe) return unite.positionDe(typeof noeud?.start === 'number' ? noeud.start : 0).ligne;
  return noeud?.loc?.start?.line ?? 0;
}

/** Colonne (1-based) d'un nœud dans le fichier réel, par les mêmes positions que `ligneDans`. */
export function colonneDans(unite, noeud) {
  if (unite.positionDe) return unite.positionDe(typeof noeud?.start === 'number' ? noeud.start : 0).colonne + 1;
  return (noeud?.loc?.start?.column ?? 0) + 1;
}

/**
 * Ce que les constats d'un fichier HTML doivent dire de l'unité qui les
 * porte : `mention` de l'unité (gabarit, standard seul). Renvoie la fonction
 * `ligne -> mention` : un constat n'en reçoit une que si TOUTES les unités qui
 * couvrent sa ligne en portent la même (deux scripts sur la même ligne, dont
 * un seul en gabarit : on ne sait pas lequel a produit le constat, on
 * n'affirme rien de faux). Calculée en un passage sur le fichier, pour que
 * chaque constat coûte O(1) même avec des dizaines de milliers de scripts et
 * de constats.
 * @returns {(ligne: number) => ?string}
 */
export function mentionsParLigne(fichier) {
  if (!['.html', '.htm'].includes(fichier.ext) || !fichier.contenu) return () => null;
  const parLigne = new Map();
  for (const u of unitesJs(fichier)) {
    for (let ligne = u.debutLigne; ligne <= u.finLigne; ligne++) {
      const vu = parLigne.get(ligne);
      if (!vu) parLigne.set(ligne, { mention: u.mention, unanime: u.mention !== null });
      else if (u.mention === null || u.mention !== vu.mention) vu.unanime = false;
    }
  }
  return (ligne) => {
    const vu = parLigne.get(ligne);
    return vu?.unanime ? vu.mention : null;
  };
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
      visiteur({ unite: u, ast, fichier: f, ligneDe: (noeud) => ligneDans(u, noeud), walk });
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
 * @returns {Array<{spec:string, url:string, sri:boolean, index:number, baseBrute:?string, mention:?string}>}
 *   `index` est le décalage du `<script>` dans `contenu`, pour que l'appelant
 *   calcule fichier/ligne comme pour les autres motifs HTML ; `baseBrute` est
 *   le `href` brut de la `<base>` qui précède cette carte (les URL relatives
 *   `./`, `../` et `/` se résolvent contre elle, avec `urlDe`) ; `mention`
 *   dit ce que le constat doit préciser (gabarit inerte, standard seul).
 */
export function extraireImportMaps(contenu) {
  const entrees = [];
  for (const s of lirePage(contenu).scripts) {
    if (!s.carteImport) continue;                                 // une carte que Chromium applique : contenu en clair, fermée, ni `src`, ni `href`
    let carte;
    try { carte = JSON.parse(s.texte); } catch { continue; }      // JSON invalide : rien à affirmer
    const integrites = carte && typeof carte.integrity === 'object' && carte.integrity ? carte.integrity : {};
    const parUrl = new Map();                                    // dédoublonne : plusieurs spécificateurs peuvent viser la même URL
    const ajouter = (table) => {
      if (!table || typeof table !== 'object') return;
      for (const [spec, url] of Object.entries(table)) if (typeof url === 'string') parUrl.set(url, spec);
    };
    ajouter(carte?.imports);
    for (const portee of Object.values(carte?.scopes ?? {})) ajouter(portee);
    for (const [url, spec] of parUrl) {
      entrees.push({ spec, url, sri: Object.prototype.hasOwnProperty.call(integrites, url), index: s.debut, baseBrute: s.baseBrute, mention: s.mention });
    }
  }
  return entrees;
}
