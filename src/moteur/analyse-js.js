/**
 * Couche d'analyse syntaxique JavaScript.
 *
 * On préfère un AST à des expressions régulières partout où c'est possible :
 * une regexp qui cherche « eval( » se déclenche sur un commentaire, sur une
 * chaîne de caractères ou sur `medieval(`. Dans un rapport d'audit, un faux
 * positif coûte la confiance du lecteur — c'est le défaut le plus grave que
 * puisse avoir un outil comme celui-ci.
 */
import { Parser } from 'acorn';
import * as walk from 'acorn-walk';
import { lirePage, integriteProtege, urlDe, urlDeCarte, baseDe } from './page-html.js';

const EXTENSIONS_JS = ['.js', '.mjs', '.cjs', '.jsx'];
const EXTENSIONS_PAGE = ['.html', '.htm'];

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
 *
 * Un fichier qu'une balise script, un import ou un worker désigne par son adresse
 * (`commeCode`, posé par l'inventaire) est du code pour le navigateur quelle que
 * soit son extension : `<script src="logique.txt">` exécute le texte du fichier,
 * sous le type que l'hébergement lui donne. Il se lit comme du code. Une page
 * ainsi désignée donne ses scripts inline puis, en dernier, le fichier entier
 * (un fichier peut être à la fois du HTML et du JavaScript valide) : dernier,
 * pour que la recherche de l'unité qui couvre une ligne (`uniteCouvrant`) garde
 * des unités rangées par fin de ligne.
 * @returns {Array<{chemin:string, source:string, positionDe:?Function, mention:?string, debutLigne:number, finLigne:number, inline:boolean, module:boolean, baseBrute:?string, debut:?number, facultative?:boolean}>}
 */
export function unitesJs(fichier) {
  if (fichier.binaire || !fichier.contenu) return [];
  const estPage = EXTENSIONS_PAGE.includes(fichier.ext);
  const unites = [];
  if (estPage) {
    const page = lirePage(fichier.contenu);
    for (const s of page.scripts) {
      if (!s.unite) continue; // pas du code que le navigateur exécute : externe, import map, jamais fermé, type non exécuté
      unites.push({
        chemin: fichier.chemin, source: s.texte, positionDe: s.positionDe, mention: s.mention,
        debutLigne: page.positionDe(s.debutContenu).ligne, finLigne: page.positionDe(s.finContenu).ligne,
        inline: true, module: s.genre === 'module', baseBrute: s.baseBrute, debut: s.debut,
      });
    }
  }
  const parSonExtension = EXTENSIONS_JS.includes(fichier.ext);
  if (parSonExtension || fichier.commeCode) {
    // `finLigne` est fini pour une page, dont les lignes se parcourent (`mentionsParLigne`). `facultative` : seule une carte d'import désigne ce fichier, qui peut aussi être de la donnée (`with { type: 'css' }`) : il se lit s'il se lit, et ne se dit illisible que par une information.
    unites.push({ chemin: fichier.chemin, source: fichier.contenu, positionDe: null, mention: null, debutLigne: 1, finLigne: estPage ? (fichier.lignes?.length ?? fichier.contenu.split('\n').length) : Infinity, inline: false, module: false, baseBrute: null, debut: null, facultative: !parSonExtension && fichier.commeCode === 'probable' });
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
 * Vrai pour le dépassement de pile devant un code imbriqué plus profondément que la pile ne le porte : le `RangeError` de V8 (le parcours
 * d'acorn-walk, une règle récursive) ou l'erreur de syntaxe que la lecture d'acorn en fait elle-même (« Not enough stack space to parse input »).
 */
export const depassementDePile = (e) => (e instanceof RangeError && /call stack/i.test(String(e.message))) || (e instanceof SyntaxError && /not enough stack space/i.test(String(e.message)));

/**
 * Vrai pour le `RangeError` de V8 que lève une pile qui déborde : le même jugement que le premier membre de `depassementDePile`, sans expression
 * régulière. La différence compte là où la pile est pleine (voir `LecteurAcorn`) : une expression régulière qui s'y compile pour la première fois
 * n'a plus la place de le faire, et V8 abandonne le processus. Un `RangeError` seul : un message d'erreur de syntaxe peut citer le texte du widget
 * (le motif d'une expression régulière invalide, `/(call stack/`) et ne doit pas passer pour une pile qui déborde.
 */
export const estPileDeV8 = (e) => e instanceof RangeError && String(e.message).includes('call stack');

/**
 * Le lecteur d'acorn. `catchStackOverflow` d'acorn (8.18) enveloppe chaque `parseExpression` : quand la pile déborde, le cadre le plus profond
 * qui le rattrape teste le message de l'erreur par une expression régulière, que V8 compile à cet instant, au bord de la pile. Il n'y a plus de
 * place pour la compiler : V8 abandonne le processus (« FATAL ERROR: RegExpCompiler Allocation failed », code 134, aucun rapport) et aucun `try`
 * ne l'attrape. Quelques Kio de `a[` répétés suffisent, à certains lancements (selon l'état du compilateur JIT et des
 * expressions régulières déjà compilées) : un widget hostile tue l'auditeur sans rapport. Ici le même rattrapage sans expression
 * régulière, et sans `raise` (qui en compile une autre pour dire la ligne) : le `RangeError` de la pile devient l'erreur de syntaxe « Not enough
 * stack space to parse input (ligne:colonne) » que lève acorn quand il réussit à la dire, avec les mêmes `pos`, `loc` et `raisedAt`, et que
 * `depassementDePile` classe en `profondeur`. Toute autre erreur passe telle quelle.
 */
export const LecteurAcorn = Parser.extend((Base) => class extends Base {
  catchStackOverflow(f) {
    try {
      return f();
    } catch (e) {
      if (!estPileDeV8(e)) throw e;
      const loc = this.startLoc;
      const erreur = new SyntaxError(`Not enough stack space to parse input${loc ? ` (${loc.line}:${loc.column})` : ''}`);
      erreur.pos = this.start;
      erreur.loc = loc;
      erreur.raisedAt = this.pos;
      throw erreur;
    }
  }
});

/** Ce que dit une erreur qui n'est ni un dépassement de pile ni une erreur de syntaxe : son type et son message, tronqué. */
const messageDErreur = (e) => `${e?.name ?? 'Error'} : ${String(e?.message ?? e).slice(0, 200)}`;

/**
 * Des deux erreurs des deux modes, celle qui dit le plus : un dépassement de pile, puis une erreur de l'outil (`analyse` : la lecture
 * n'est pas allée au bout, on ne sait pas ce que l'autre mode aurait donné), sinon celle qui va le plus loin dans le texte.
 */
const RANG_DE_CAUSE = { profondeur: 2, analyse: 1, syntaxe: 0 };
const erreurLaPlusLoin = (a, b) => {
  if (!a) return b;
  if (RANG_DE_CAUSE[b.cause] !== RANG_DE_CAUSE[a.cause]) return RANG_DE_CAUSE[b.cause] > RANG_DE_CAUSE[a.cause] ? b : a;
  return (b.position ?? -1) > (a.position ?? -1) ? b : a;
};

/**
 * Ce qu'une lecture qui lève dit. Un dépassement de pile : `profondeur`. Une erreur de syntaxe d'acorn, qui porte la position où il s'arrête :
 * `syntaxe`. Toute autre erreur (un défaut de l'outil ou de sa dépendance, la mémoire) : `analyse`, dite comme celle d'un parcours qui échoue :
 * le code n'est pas en cause, on ne lui conseille pas d'être réécrit, et l'erreur est à signaler.
 */
function erreurDeLecture(e) {
  const profond = depassementDePile(e);
  const syntaxe = e instanceof SyntaxError && typeof e.pos === 'number';
  return {
    cause: profond ? 'profondeur' : syntaxe ? 'syntaxe' : 'analyse',
    message: profond ? 'la pile déborde' : syntaxe ? String(e.message).replace(/\s*\(\d+:\d+\)$/, '') : messageDErreur(e),
    ligne: e?.loc?.line ?? null, colonne: e?.loc ? e.loc.column + 1 : null,
    position: typeof e?.pos === 'number' ? e.pos : null,
  };
}

/** Ce qu'un parcours de l'arbre qui lève dit : la pile qui déborde, ou l'erreur que l'outil a levée sur ce code. Ni ligne ni position : le code se lit, c'est le parcours qui échoue. */
export function erreurDeParcours(e) {
  const profond = depassementDePile(e);
  return {
    cause: profond ? 'profondeur' : 'analyse',
    message: profond ? 'la pile déborde' : messageDErreur(e),
    ligne: null, colonne: null, position: null,
  };
}

/**
 * Une lecture d'acorn, dans un mode (`module` ou `script`). Dans son propre appel : l'erreur d'une lecture qui échoue, et ce que le
 * cadre qui l'a attrapée tient, ne restent pas dans le cadre de `lire` pendant la lecture du mode suivant. Mesuré sur un gros
 * fichier qui ne se lit dans aucun mode (`scripts/mesurer-memoire-lecture.mjs`) : quand la vérification de l'erreur se faisait dans le
 * cadre de la boucle, la mémoire de la première lecture n'était pas rendue à temps et le tas plafonné d'un conteneur n'y suffisait plus,
 * alors que, lues une à une dans leur propre appel, les deux lectures y tiennent. La cause exacte dans V8 n'est pas établie.
 */
function tenter(source, sourceType) {
  try {
    const commentaires = [];
    const ast = LecteurAcorn.parse(source, {
      ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true,
      onComment: (_bloc, _texte, debut, fin) => commentaires.push({ debut, fin }),
    });
    ast.commentaires = commentaires;
    return { ast, erreur: null };
  } catch (e) {
    return { ast: null, erreur: erreurDeLecture(e) };
  }
}

/**
 * Lit une unité : son arbre, ou la raison pour laquelle acorn n'en donne pas (TS, JSX, syntaxe invalide, code plus profond
 * que la pile, erreur de l'outil). Module puis script : quand aucun des deux ne lit, l'erreur dite est celle qui dit le plus (`erreurLaPlusLoin`).
 * Les commentaires sont collectés à part (`ast.commentaires`, `{debut, fin}` en décalage de caractères) : acorn ne les
 * rattache à aucun nœud par défaut, or au moins une règle (A-ERR-01) a besoin de savoir si une portée de code est commentée
 * sans se soucier de la syntaxe qu'elle contient.
 * @returns {{ast: ?object, erreur: ?{cause: 'syntaxe'|'profondeur'|'analyse', message: string, ligne: ?number, colonne: ?number, position: ?number}}}
 */
export function lire(source) {
  let erreur = null;
  for (const sourceType of ['module', 'script']) {
    const lecture = tenter(source, sourceType);
    if (lecture.ast) return lecture;
    erreur = erreurLaPlusLoin(erreur, lecture.erreur);
  }
  return { ast: null, erreur };
}

/** L'arbre d'une unité, ou null quand acorn ne la lit pas (la raison est dans `lire`). */
export function parser(source) {
  return lire(source).ast;
}

/** Vrai si au moins un commentaire est entièrement contenu dans la portée du nœud donné. */
export function aCommentaireDansPortee(ast, noeud) {
  return (ast?.commentaires ?? []).some((c) => c.debut >= noeud.start && c.fin <= noeud.end);
}

/** La clé d'une unité parmi celles de son fichier : le décalage de sa balise `<script>` dans la page, ou « fichier » pour le fichier entier. */
const cleDUnite = (u) => (u.inline ? u.debut : 'fichier');

/**
 * Note qu'une unité n'a pas été lue (`contexte.illisibles`, une entrée par unité : les vingt parcours de règles
 * la rencontrent chacun, et l'inventaire des fichiers avant elles, la première raison est gardée). C-SURFACE-03 le dit.
 * `erreur.etape` dit où l'échec a eu lieu : `lecture` (acorn ne donne pas d'arbre, par défaut), `parcours` (une règle a échoué sur l'arbre)
 * ou `inventaire` (l'inventaire des fichiers n'a pas pu parcourir l'arbre pour savoir ce que la page charge).
 * @param {{cause: 'syntaxe'|'profondeur'|'analyse', message: string, ligne: ?number, colonne: ?number, position: ?number, etape?: 'lecture'|'parcours'|'inventaire'}} erreur
 */
function noterIllisible(releves, f, u, erreur) {
  const liste = (releves.illisibles ??= new Map());
  const cle = `${f.chemin}\0${cleDUnite(u)}`;
  if (liste.has(cle)) return;
  // La position d'une erreur se dit dans le fichier réel : pour un script inline, par le décalage dans la page.
  const place = u.positionDe && typeof erreur.position === 'number' ? u.positionDe(erreur.position) : null;
  liste.set(cle, {
    chemin: f.chemin, cause: erreur.cause, message: erreur.message, etape: erreur.etape ?? 'lecture', inline: u.inline, facultative: Boolean(u.facultative),
    ligne: place ? place.ligne : (u.inline ? u.debutLigne : erreur.ligne), colonne: place ? place.colonne + 1 : erreur.colonne,
    surface: Boolean(f.executee), dossierExclu: Boolean(f.dossierExclu),
  });
}

/** Une unité dont la lecture n'a pas donné d'arbre : dite si le code est exécuté (du JSX ou du TypeScript qu'aucune page ne charge n'est pas du code exécuté) ; un fichier que seule une carte d'import désigne n'est peut-être que de la donnée. */
function noterLectureRefusee(releves, f, u, erreur) {
  if (f.executee) noterIllisible(releves, f, u, u.facultative ? { ...erreur, cause: 'donnee-possible' } : erreur);
}

/** Les unités qu'acorn n'a pas lues, par fichier : la raison, gardée pour que la vingtaine de règles qui les rencontrent ne refassent pas une lecture qui a échoué (jusqu'à la fin d'un gros fichier). */
const lecturesEchouees = new WeakMap();

/** Les unités dont l'arbre a été lu et que l'inventaire des fichiers n'a pas pu parcourir, par fichier : la raison, que `releverEchecsDeLInventaire` dit. */
const parcoursEchoues = new WeakMap();

/**
 * `lire` l'unité, une seule fois quand la lecture échoue : l'arbre d'une lecture réussie n'est pas gardé (la mémoire), le refus l'est (quelques octets).
 * L'inventaire des fichiers (`construireContexte`) et les règles lisent par là : ce que l'un n'a pas pu lire, l'autre ne le relit pas, et l'échec n'est dit qu'une fois.
 * `u` est une unité de `unitesJs`, ou l'une de ses trois propriétés : `{ source, inline, debut }`.
 */
export function lireUnite(f, u) {
  const cle = cleDUnite(u);
  const echecs = lecturesEchouees.get(f);
  if (echecs?.has(cle)) return { ast: null, erreur: echecs.get(cle) };
  const lecture = lire(u.source);
  if (!lecture.ast) {
    if (!echecs) lecturesEchouees.set(f, new Map([[cle, lecture.erreur]]));
    else echecs.set(cle, lecture.erreur);
  }
  return lecture;
}

/** L'inventaire des fichiers n'a pas pu parcourir l'arbre de cette unité (la pile déborde, une erreur de l'outil) : il le dit ici, il en lit les références par expressions régulières, et C-SURFACE-03 le dit. Une fois par unité. */
export function noterParcoursEchoue(f, u, e) {
  const cle = cleDUnite(u);
  let echecs = parcoursEchoues.get(f);
  if (!echecs) parcoursEchoues.set(f, echecs = new Map());
  if (!echecs.has(cle)) echecs.set(cle, { ...erreurDeParcours(e), etape: 'inventaire' });
}

/**
 * Relève dans `contexte.illisibles` ce que l'inventaire des fichiers a lui-même échoué à lire ou à parcourir : il lit tout le code de la surface pour savoir ce que
 * la page charge, et un échec de sa part ne se passe pas sous silence parce qu'il lit par expressions régulières à la place. Dit comme celui des règles, une fois par
 * unité : la raison qu'une règle a déjà relevée est gardée, `noterIllisible` ne la remplace pas. Appelée une fois que les règles ont tourné (C-SURFACE-03).
 */
export function releverEchecsDeLInventaire(contexte) {
  for (const f of contexte.fichiers ?? []) {
    const lectures = lecturesEchouees.get(f);
    const parcours = parcoursEchoues.get(f);
    if (!lectures && !parcours) continue;
    for (const u of unitesJs(f)) {
      const cle = cleDUnite(u);
      if (lectures?.has(cle)) noterLectureRefusee(contexte, f, u, lectures.get(cle));
      else if (parcours?.has(cle)) noterIllisible(contexte, f, u, parcours.get(cle));
    }
  }
}

/**
 * Parcourt toutes les unités JS du contexte en appelant `visiteur` avec
 * l'AST et un utilitaire `signaler(noeud, …)` qui gère le décalage de ligne
 * des scripts inline.
 *
 * Une unité qu'acorn ne lit pas n'est pas visitée, et une unité dont le parcours échoue (la pile déborde, une règle
 * lève une erreur sur un code piégé) ne fait pas tomber l'audit : dans les deux cas elle est relevée dans
 * `releverDans.illisibles` (le contexte par défaut), où C-SURFACE-03 la dit. Un code que le navigateur exécute et
 * qu'aucune règle n'a lu ne se passe pas sous silence. Seul le code de la surface est relevé quand c'est la lecture
 * qui échoue (du JSX ou du TypeScript qu'aucune page ne charge n'est pas du code exécuté) ; un parcours qui échoue
 * est toujours relevé.
 */
export function pourChaqueUniteJs(contexte, { surfaceSeulement = false, ignorerVendorise = false, releverDans = contexte } = {}, visiteur) {
  for (const f of contexte.fichiers) {
    if (surfaceSeulement && !f.executee) continue;
    if (ignorerVendorise && (f.vendorise || f.dossierExclu)) continue;
    for (const u of unitesJs(f)) {
      const { ast, erreur } = lireUnite(f, u);
      if (!ast) {
        noterLectureRefusee(releverDans, f, u, erreur);
        continue;
      }
      try {
        visiteur({ unite: u, ast, fichier: f, ligneDe: (noeud) => ligneDans(u, noeud), walk });
      } catch (e) {
        noterIllisible(releverDans, f, u, { ...erreurDeParcours(e), etape: 'parcours' });
      }
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

const PROTOCOLES_SPECIAUX = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:']);

/** Ajoute à une table de carte (`imports`, ou un bloc de `scopes`) les clés d'un objet de la carte `s`, normalisées comme Chromium le fait : la première carte qui nomme une clé l'emporte. */
function ajouterALaTable(table, source, s, cheminPage) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  const propres = new Map();
  for (const [cle, valeur] of Object.entries(source)) {
    if (cle === '') continue;
    const normalisee = urlDeCarte(cle, s.baseBrute, cheminPage)?.href ?? cle;           // une clé qui est une adresse se compare résolue
    let adresse = typeof valeur === 'string' ? urlDeCarte(valeur, s.baseBrute, cheminPage) : null;
    if (adresse && cle.endsWith('/') && !adresse.href.endsWith('/')) adresse = null;    // une clé de préfixe dont l'adresse n'en est pas un : la résolution échoue
    propres.set(normalisee, adresse);
  }
  for (const [cle, adresse] of propres) if (!table.entrees.has(cle)) table.entrees.set(cle, adresse);
}

/**
 * Ce qu'une table de carte rend d'un spécificateur normalisé : l'adresse de sa clé exacte, sinon celle de la plus longue clé de préfixe
 * (qui finit par `/`) qu'il commence ; `null` quand l'adresse est bloquée, `undefined` quand aucune clé ne correspond.
 * Un spécificateur qui est une adresse d'un schéma non spécial (`data:`) ne s'apparie à aucun préfixe.
 */
function correspondance(table, normalise, special) {
  if (table.entrees.has(normalise)) return table.entrees.get(normalise);
  if (!special) return undefined;
  for (const cle of table.prefixes) {
    if (!normalise.startsWith(cle)) continue;
    const adresse = table.entrees.get(cle);
    if (adresse === null) return null;
    let url;
    try { url = new URL(normalise.slice(cle.length), adresse.href); } catch { return null; }
    return url.href.startsWith(adresse.href) ? url : null;                             // un `..` qui sortirait de l'adresse du préfixe fait échouer la résolution
  }
  return undefined;
}

/**
 * Ce que les cartes d'import d'une page font d'un spécificateur de module, comme Chromium 141 le fait (`import.meta.resolve` est l'oracle
 * de `tests/carte-import-chromium.test.mjs`) : les cartes se fusionnent, la première qui nomme une clé l'emporte ; pour un référent, les
 * blocs `scopes` dont le préfixe est celui de son adresse, puis, si aucun ne nomme le spécificateur, les `imports` du dessus ; dans une
 * table, la clé exacte, sinon le plus long préfixe (`"lib/": "./libs/"` : `import 'lib/x.js'` charge `libs/x.js`). Un nom nu qu'aucune
 * clé ne nomme est une erreur du navigateur, une adresse qu'aucune clé ne remappe est elle-même. Quand plusieurs portées correspondent au
 * référent (`./sub/` et `./sub/deep/`), la norme veut la plus longue ; Chromium 141 en retient une dans un ordre qui n'est pas celui-là
 * (mesuré sur des paires de portées imbriquées : pour certaines c'est la plus courte, et d'un lancement à l'autre la même) : l'outil rend alors les adresses de toutes
 * celles qui nomment le spécificateur, le doute inclut. L'ordre des cartes et des chargements (une carte lue après le premier module est
 * ignorée) n'est pas modélisé : une carte de la page compte toujours.
 * @param {string} contenu la page
 * @param {string} cheminPage son chemin dans le widget
 * @param {?('gabarit'|'standard')} [sans] ignore les cartes qui ne s'appliquent pas tout de suite (`<template>`) ou que Chromium n'applique pas (`standard`) :
 *   les fermetures de la surface sans ces chargements (voir `mentionDe`)
 * @returns {?{ resoudre: (specificateur: string, referent: {chemin: string, baseBrute: ?string}) => URL[], taille: number }} null : la page n'a pas de carte
 *   que Chromium applique, ou ses cartes ne portent aucune clé. `resoudre` rend les adresses que le spécificateur peut prendre (une seule, sauf entre portées
 *   imbriquées ; aucune quand la résolution échoue) ; `referent` : le fichier (`baseBrute` null) ou la page
 *   (son script inline, sous la `<base>` qui le précède) dont le code importe ; `taille` : ce qu'une résolution parcourt au plus (clés de préfixe, blocs).
 */
export function resolveurDeCartes(contenu, cheminPage, sans = null) {
  const cartes = cartesDeLaPage(contenu).filter(({ s }) => !(sans === 'gabarit' && s.dansTemplate) && !(sans === 'standard' && s.seulementStandard));
  if (cartes.length === 0) return null;
  const nouvelle = () => ({ entrees: new Map(), prefixes: [] });
  const imports = nouvelle();
  const blocs = new Map();                                        // préfixe de portée (href) → table
  for (const { carte, s } of cartes) {
    ajouterALaTable(imports, carte?.imports, s, cheminPage);
    const portees = carte?.scopes;
    if (!portees || typeof portees !== 'object' || Array.isArray(portees)) continue;
    for (const [prefixe, source] of Object.entries(portees)) {
      const cle = urlDe(prefixe, s.baseBrute, cheminPage)?.href;
      if (cle === undefined) continue;
      let table = blocs.get(cle);
      if (!table) blocs.set(cle, table = nouvelle());
      ajouterALaTable(table, source, s, cheminPage);
    }
  }
  if (imports.entrees.size === 0 && blocs.size === 0) return null;   // une carte qui ne porte que des empreintes (`integrity`) ne résout aucun nom
  const tables = [imports, ...blocs.values()];
  for (const table of tables) table.prefixes = [...table.entrees.keys()].filter((cle) => cle.endsWith('/')).sort((a, b) => b.length - a.length);
  const portees = [...blocs].sort(([a], [b]) => b.length - a.length);
  const duReferent = new Map();                                   // href du référent → ses blocs, le préfixe le plus long d'abord
  const blocsDe = (href) => {
    let liste = duReferent.get(href);
    if (!liste) duReferent.set(href, liste = portees.filter(([prefixe]) => prefixe === href || (prefixe.endsWith('/') && href.startsWith(prefixe))).map(([, table]) => table));
    return liste;
  };
  const resoudre = (specificateur, { chemin, baseBrute }) => {
    const enAdresse = urlDeCarte(specificateur, baseBrute, chemin);
    const normalise = enAdresse ? enAdresse.href : specificateur;
    const special = enAdresse === null || PROTOCOLES_SPECIAUX.has(enAdresse.protocol);
    const parPortee = blocsDe(baseDe(baseBrute, chemin).url.href).map((table) => correspondance(table, normalise, special)).filter((trouve) => trouve !== undefined);
    if (parPortee.length > 0) return [...new Map(parPortee.filter(Boolean).map((url) => [url.href, url])).values()];   // une portée qui nomme le spécificateur ferme la résolution, `null` (adresse bloquée) comprise
    const trouve = correspondance(imports, normalise, special);
    if (trouve !== undefined) return trouve ? [trouve] : [];
    return enAdresse ? [enAdresse] : [];
  };
  return { resoudre, taille: 1 + tables.reduce((n, table) => n + table.prefixes.length, 0) + blocs.size };
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
