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
import { lirePage, integriteProtege, urlDe, urlDeCarte } from './page-html.js';

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
 * Une unité inline porte aussi `baseBrute` (le `href` brut de la `<base>` qui
 * la précède, null sinon) : ses références relatives se résolvent contre la
 * base du document, quand celles d'un fichier .js se résolvent contre son
 * propre emplacement.
 * `debut` est le décalage de la balise `<script>` dans la page (null pour un
 * fichier .js) : l'ordre des balises dit quelle import map précède quel script.
 * @returns {Array<{chemin:string, source:string, positionDe:?Function, mention:?string, debutLigne:number, finLigne:number, inline:boolean, module:boolean, baseBrute:?string, debut:?number}>}
 */
export function unitesJs(fichier) {
  if (fichier.binaire || !fichier.contenu) return [];
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(fichier.ext)) {
    return [{ chemin: fichier.chemin, source: fichier.contenu, positionDe: null, mention: null, debutLigne: 1, finLigne: Infinity, inline: false, module: false, baseBrute: null, debut: null }];
  }
  if (!['.html', '.htm'].includes(fichier.ext)) return [];

  const page = lirePage(fichier.contenu);
  const unites = [];
  for (const s of page.scripts) {
    if (!s.unite) continue; // pas du code que le navigateur exécute : externe, import map, jamais fermé, type non exécuté
    unites.push({
      chemin: fichier.chemin, source: s.texte, positionDe: s.positionDe, mention: s.mention,
      debutLigne: page.positionDe(s.debutContenu).ligne, finLigne: page.positionDe(s.finContenu).ligne,
      inline: true, module: s.genre === 'module', baseBrute: s.baseBrute, debut: s.debut,
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
  // Hors d'une page, la réserve est celle du fichier entier (`mention`, posée par l'inventaire : chargé seulement depuis un `<template>`, ou seulement par un module que le standard lit).
  if (!['.html', '.htm'].includes(fichier.ext) || !fichier.contenu) return () => fichier.mention ?? null;
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
    if (ignorerVendorise && (f.vendorise || f.dossierExclu)) continue;
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
 * Les cartes d'import de la page que Chromium applique, lues : `{ carte, s }`
 * (`s` : l'entrée de `lirePage`, avec sa `baseBrute`), dans l'ordre du document.
 * Une carte dont le JSON est invalide n'affirme rien.
 */
function cartesDeLaPage(contenu) {
  const cartes = [];
  for (const s of lirePage(contenu).scripts) {
    if (!s.carteImport) continue;                                 // une carte que Chromium applique : contenu en clair, fermée, ni `src`, ni `href`
    try { cartes.push({ carte: JSON.parse(s.texte), s }); } catch { /* JSON invalide : rien à affirmer */ }
  }
  return cartes;
}

/**
 * Les adresses que les clés `integrity` des cartes d'une page protègent, en
 * `href` d'URL absolue, avec le décalage (dans la page) de la carte qui les
 * protège. Chaque clé est une adresse d'import map (`urlDeCarte`, relative à
 * la base du document au moment où la carte est lue) et se compare résolue,
 * comme Chromium 141 le fait : une clé dont l'hôte est en capitales ou qui
 * porte un segment `/./` protège encore, une clé pour `U?v=1` ne protège pas
 * `U`, une clé qui n'est pas une adresse (`x`) ne protège rien. Seule une
 * valeur qui porte une empreinte bien formée (`integriteProtege`) protège :
 * Chromium écrit en console qu'une valeur vide, `x`, `md5-…` ou `sha384-` est
 * ignorée, et exécute. Deux clés d'une même carte qui se résolvent à la même
 * adresse : la dernière s'applique ; deux cartes qui nomment la même adresse :
 * la première s'applique, et une valeur vide ou mal formée d'une carte
 * antérieure n'est pas remplacée par une valeur correcte d'une carte
 * postérieure (mesuré dans Chromium 141, comme la spécification le veut).
 */
function adressesProtegees(cartes, cheminPage) {
  const valeurs = new Map();                                       // href → { valeur, position } de la première carte qui nomme l'adresse
  for (const { carte, s } of cartes) {
    const integrites = carte && typeof carte.integrity === 'object' && carte.integrity ? carte.integrity : {};
    const propres = new Map();
    for (const [cle, valeur] of Object.entries(integrites)) {
      const url = urlDeCarte(cle, s.baseBrute, cheminPage);
      if (url && typeof valeur === 'string') propres.set(url.href, valeur);
    }
    for (const [href, valeur] of propres) if (!valeurs.has(href)) valeurs.set(href, { valeur, position: s.debut });
  }
  return new Map([...valeurs].filter(([, { valeur }]) => integriteProtege(valeur)).map(([href, { position }]) => [href, position]));
}

/**
 * Les `<link rel="modulepreload">` d'une page, par adresse résolue (`href` d'URL
 * absolue, contre la `<base>` qui précède le lien). Un tel lien charge le module à
 * son adresse quand la balise est lue, et le module qu'un `import` ou un
 * `<script type="module" src>` trouve ensuite est celui-là : mesuré dans Chromium 141
 * (page seule et iframe), une carte lue après le lien n'y ajoute pas l'empreinte, et
 * un attribut `integrity` du lien, même vide ou mal formé, l'emporte sur la carte pour
 * ce chargement. Ni `preload`, ni `prefetch` ne font cela (mesuré : l'empreinte
 * s'applique encore), ni un lien vers un fichier local (ses imports se résolvent plus
 * tard, avec la carte). Un lien dans un `<template>` est inerte. Un lien dont
 * l'attribut est une empreinte bien formée vérifie lui-même son chargement (mesuré :
 * un module falsifié est refusé) : il n'est pas gardé.
 * Deux liens par adresse suffisent à répondre en temps constant, quel que soit leur
 * nombre : le premier sans empreinte valide (dans l'ordre du document), et le premier
 * dont l'attribut est présent mais vide ou mal formé.
 * @param {string} contenu la page
 * @param {string} cheminPage son chemin dans le widget
 * @returns {Map<string, { premier: object, attributMal: ?object }>} chaque lien : `{ debut, ligne, attribut }` (le décalage du lien dans la page, sa ligne, et s'il porte un attribut `integrity`)
 */
export function modulepreloadsDeLaPage(contenu, cheminPage) {
  const parAdresse = new Map();
  for (const r of lirePage(contenu).ressources) {
    if (r.nom !== 'link' || r.dansTemplate) continue;
    if (integriteProtege(r.attributs.get('integrity'))) continue;
    for (const usage of r.usages) {
      if (usage.genre !== 'modulepreload') continue;
      const url = urlDe(usage.urls[0], r.baseBrute, cheminPage);
      if (!url) continue;
      const lien = { debut: r.debut, ligne: r.ligne, attribut: r.attributs.has('integrity') };
      const vus = parAdresse.get(url.href) ?? { premier: lien, attributMal: null };
      if (lien.attribut) vus.attributMal ??= lien;
      parAdresse.set(url.href, vus);
    }
  }
  return parAdresse;
}

/**
 * Le premier `<link rel="modulepreload">` (dans l'ordre du document) qui charge le
 * module sans que l'empreinte de la carte lue au décalage `carte` s'y applique : un
 * lien lu avant la carte, ou un lien dont l'attribut `integrity` (présent, même
 * vide) l'emporte sur la carte. Un lien qui vérifie lui-même son chargement (attribut
 * bien formé) ne brise rien.
 * @param {?{ premier: object, attributMal: ?object }} liens ceux de `modulepreloadsDeLaPage` pour cette adresse
 * @param {number} carte le décalage de la carte qui porte l'empreinte
 * @returns {?object} le lien, ou undefined
 */
export function lienQuiBriseLEmpreinte(liens, carte) {
  if (!liens) return undefined;
  if (liens.premier.attribut || liens.premier.debut < carte) return liens.premier;
  return liens.attributMal ?? undefined;
}

/**
 * Extrait les entrées d'un `<script type="importmap">` : chaque spécificateur
 * mappé (`imports`, et chaque bloc de `scopes`) avec l'URL cible et si elle
 * est couverte par la clé `integrity` de premier niveau (WHATWG — Import
 * Maps). `sri` n'est vrai que si l'adresse, résolue contre `cheminPage`, est
 * protégée par la carte de l'entrée ou par une carte qui la précède (voir
 * `adressesProtegees`) : une empreinte lue après l'entrée laisse le temps à un
 * chargement de commencer sans elle ; et si aucun `<link rel="modulepreload">` de
 * l'adresse ne l'a chargée sans elle (voir `modulepreloadsDeLaPage`). Ce contenu est du JSON, jamais exécuté
 * comme du JS (`unitesJs` l'exclut explicitement), donc invisible à toute règle
 * qui lit du JS ou qui ne regarde que l'attribut `src` d'un `<script>` : une
 * bibliothèque résolue par un import nu après une entrée d'import map est
 * pourtant chargée à l'exécution comme n'importe quel `<script src>`.
 * @param {string} contenu la page
 * @param {string} [cheminPage] son chemin dans le widget, contre lequel les clés et les adresses relatives se résolvent
 * @returns {Array<{spec:string, url:string, sri:boolean, carte:?number, lien:?object, index:number, baseBrute:?string, mention:?string, dansTemplate:boolean, seulementStandard:boolean}>}
 *   `carte` : le décalage de la carte dont la clé `integrity` porte une empreinte bien formée de cette adresse (undefined : aucune) ;
 *   `lien` : le `<link rel="modulepreload">` qui a chargé le module sans elle (voir `lienQuiBriseLEmpreinte`) ;
 *   `index` est le décalage du `<script>` dans `contenu`, pour que l'appelant
 *   calcule fichier/ligne comme pour les autres motifs HTML ; `baseBrute` est
 *   le `href` brut de la `<base>` qui précède cette carte (les URL relatives
 *   `./`, `../` et `/` se résolvent contre elle, avec `urlDe`) ; `mention`
 *   dit ce que le constat doit préciser (gabarit inerte, standard seul).
 */
export function extraireImportMaps(contenu, cheminPage = '') {
  const cartes = cartesDeLaPage(contenu);
  const protegees = adressesProtegees(cartes, cheminPage);
  const liens = modulepreloadsDeLaPage(contenu, cheminPage);
  const entrees = [];
  for (const { carte, s } of cartes) {
    const parUrl = new Map();                                    // dédoublonne : plusieurs spécificateurs peuvent viser la même URL
    const ajouter = (table) => {
      if (!table || typeof table !== 'object') return;
      for (const [spec, url] of Object.entries(table)) if (typeof url === 'string') parUrl.set(url, spec);
    };
    ajouter(carte?.imports);
    for (const portee of Object.values(carte?.scopes ?? {})) ajouter(portee);
    for (const [url, spec] of parUrl) {
      const resolue = urlDeCarte(url, s.baseBrute, cheminPage);
      const carteDeLEmpreinte = resolue === null ? undefined : protegees.get(resolue.href);
      const lien = carteDeLEmpreinte === undefined ? undefined : lienQuiBriseLEmpreinte(liens.get(resolue.href), carteDeLEmpreinte);
      // Une entrée ne se charge qu'après la carte qui la déclare : son empreinte compte si la carte qui la porte est celle-ci ou une carte antérieure, et si aucun lien `modulepreload` n'a chargé le module sans elle.
      entrees.push({ spec, url, sri: carteDeLEmpreinte !== undefined && carteDeLEmpreinte <= s.debut && !lien, carte: carteDeLEmpreinte, lien, index: s.debut, baseBrute: s.baseBrute, mention: s.mention, dansTemplate: s.dansTemplate, seulementStandard: s.seulementStandard });
    }
  }
  return entrees;
}

/**
 * Ce que le code d'une unité charge à une adresse `http:` ou `https:` : `import`
 * et `export … from` statiques, `import()` à littéral. Rend les visiteurs à
 * ajouter au parcours de l'AST de l'unité (`walk.simple`) ; `trouve` reçoit
 * `{ noeud, canal, valeur, url }` pour chaque chargement : `valeur` est l'adresse
 * telle qu'elle est écrite, `url` l'adresse résolue (`canal` : `import()
 * distant`, `import statique` ou `export … from`). Une adresse relative se
 * résout contre la base du document pour un script écrit dans la page (sous une
 * `<base>` externe, elle mène chez un tiers), contre l'emplacement du fichier pour
 * un fichier ; un nom nu n'est pas une adresse (seule une import map en fait
 * une, lue ailleurs). Un `import` statique d'un script classique de la page est
 * une erreur de syntaxe : rien n'y est chargé, rien n'est dit.
 * Un seul lecteur pour C-EXFIL-01 (la destination) et E-DEP-01 (l'intégrité) :
 * ce que l'un voit, l'autre le voit.
 */
export function visiteursDImports({ unite, fichier }, trouve) {
  const importer = (noeud, source, canal) => {
    if (canal !== 'import() distant' && unite.inline && !unite.module) return;
    const valeur = chaineLitterale(source);
    if (valeur === null) return;
    const url = urlDeCarte(valeur, unite.inline ? unite.baseBrute : null, fichier.chemin);
    if (url && /^https?:$/.test(url.protocol)) trouve({ noeud, canal, valeur, url });
  };
  return {
    ImportExpression(n) { importer(n, n.source, 'import() distant'); },
    ImportDeclaration(n) { importer(n, n.source, 'import statique'); },
    ExportAllDeclaration(n) { importer(n, n.source, 'export … from'); },
    ExportNamedDeclaration(n) { if (n.source) importer(n, n.source, 'export … from'); },
  };
}

/**
 * Les adresses que l'empreinte des import maps d'une page protège (voir
 * `adressesProtegees`), avec le décalage de la carte qui les protège.
 * Chromium applique l'empreinte au module qui se charge à cette adresse dans
 * le document de la page, quel que soit le chemin (`<script type=module src>`,
 * `import`, `export … from`, `import()`), à condition que le chargement
 * commence après la lecture de la carte ; jamais dans un worker. L'appelant
 * compare ce décalage à celui de la balise qui charge le module.
 * @param {string} contenu la page
 * @param {string} cheminPage son chemin dans le widget
 * @returns {Map<string, number>} `href` d'URL absolue → décalage de la carte dans la page
 */
export function adressesProtegeesParEmpreinte(contenu, cheminPage) {
  return adressesProtegees(cartesDeLaPage(contenu), cheminPage);
}
