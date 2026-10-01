/**
 * Mesure d'une fonction, une par une : sa complexité cyclomatique, la profondeur de ses blocs imbriqués, les lignes qu'elle occupe, son nom ;
 * et celle du code qui n'est dans aucune fonction, le niveau supérieur d'un script ou d'un module.
 *
 * Une fonction se mesure sur son propre corps. Les fonctions qu'elle contient (rappels, fonctions internes, méthodes d'une classe qu'elle
 * déclare) ont chacune leur mesure et ne comptent pas dans la sienne : c'est la complexité de McCabe, définie par fonction. Une fermeture qui
 * enveloppe tout un widget (le motif de module `(function () { … })()`) n'est donc plus créditée des branches de chacune de ses fonctions ;
 * trente fonctions de deux chemins faisaient « une fonction de 31 chemins » qui n'était la complexité d'aucune d'elles, et un code groupé
 * (un fichier empaqueté) en produisait par milliers.
 */
import { citerSiBesoin } from './texte-du-widget.js';

const FONCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Vrai pour un nœud qui est une fonction (déclaration, expression, flèche ; la valeur d'une méthode est une expression de fonction). */
export const estFonction = (noeud) => FONCTIONS.has(noeud?.type);

/** Les constructions qui ouvrent un niveau de blocs imbriqués. */
const OUVRE_UN_NIVEAU = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement']);

/** Les constructions qui ajoutent un chemin d'exécution (le `case` à test, plus bas, en ajoute un aussi : `&&`, `||` et `??` sont les trois opérateurs d'une `LogicalExpression`). */
const AJOUTE_UN_CHEMIN = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'CatchClause', 'ConditionalExpression', 'LogicalExpression']);

/**
 * Parcourt des nœuds racines, sans entrer dans les fonctions qu'ils contiennent, et rend la complexité (1, plus un par construction qui ajoute un
 * chemin), la profondeur des blocs imbriqués et les lignes des fonctions rencontrées sur plusieurs lignes (de la première à la dernière).
 * Pile explicite : la profondeur d'un arbre n'est pas bornée par celle de la pile d'appels.
 */
function parcourir(racines) {
  let complexite = 1;
  let imbrication = 0;
  let interieur = 0;
  const pile = racines.map((n) => [n, 0]);
  while (pile.length) {
    const [noeud, niveau] = pile.pop();
    if (estFonction(noeud)) {
      if (noeud.loc.end.line > noeud.loc.start.line) interieur += noeud.loc.end.line - noeud.loc.start.line + 1;
      continue;                                       // elle a sa propre mesure
    }
    if (AJOUTE_UN_CHEMIN.has(noeud.type)) complexite++;
    else if (noeud.type === 'SwitchCase' && noeud.test) complexite++;
    let dedans = niveau;
    if (OUVRE_UN_NIVEAU.has(noeud.type)) {
      dedans = niveau + 1;
      if (dedans > imbrication) imbrication = dedans;
    }
    for (const cle of Object.keys(noeud)) {
      if (cle === 'loc') continue;
      const v = noeud[cle];
      const fils = noeud.type === 'IfStatement' && cle === 'alternate' && v?.type === 'IfStatement' ? niveau : dedans;
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') pile.push([x, fils]); }
      else if (v && typeof v.type === 'string') pile.push([v, fils]);
    }
  }
  return { complexite, imbrication, interieur };
}

/**
 * Ce que mesure une fonction sur son propre corps (les fonctions qu'elle contient sont mesurées à part) :
 *  - `complexite` : 1, plus un par `if`, boucle, `case` à test, `catch`, ternaire, `&&`, `||` et `??` ;
 *  - `imbrication` : le plus grand nombre de `if`, boucles, `switch` et `try` emboîtés. Un `else if` prolonge la chaîne au niveau du `if` qu'il
 *    suit : huit `else if` à la suite sont à plat, non à huit niveaux ;
 *  - `etendue` : les lignes de la fonction, de la première à la dernière ;
 *  - `lignesPropres` : l'étendue moins les lignes de chaque fonction qu'elle contient sur plusieurs lignes, de la première à la dernière. Une
 *    fonction interne qui tient sur une ligne ne retire rien : sa ligne est aussi celle du code qui l'écrit. Ce compte ne dépasse jamais
 *    les lignes que la fonction écrit réellement elle-même (la ligne qui ouvre une fonction interne, `ready(() => {`, est retirée alors qu'elle
 *    a un peu du code de l'extérieur) : un défaut qui laisse passer une enveloppe de quelques lignes de trop, jamais un qui lui en donne.
 * @returns {{complexite: number, imbrication: number, etendue: number, lignesPropres: number}}
 */
export function mesurerFonction(fonction) {
  const etendue = fonction.loc.end.line - fonction.loc.start.line + 1;
  const { complexite, imbrication, interieur } = parcourir([fonction.body, ...fonction.params]);
  return { complexite, imbrication, etendue, lignesPropres: etendue - interieur };
}

/**
 * Ce que mesure le code qui n'est dans aucune fonction (les instructions du niveau supérieur d'un script ou d'un module), de la même façon qu'une
 * fonction : un widget écrit à plat vaut ce que vaut le même code dans une fermeture `(function () { … })()`, dont le corps est mesuré sur ses
 * instructions propres. Les fonctions que ce code déclare ont chacune leur mesure.
 * @param {{body: object[]}} programme le nœud `Program`
 * @returns {{complexite: number, imbrication: number, premiere: ?object, plusProfonde: ?object}} `premiere` : la première instruction qui ajoute un
 *   chemin, `plusProfonde` : la première qui atteint la plus grande profondeur (l'endroit où le relecteur doit regarder), `null` quand il n'y en a pas
 */
export function mesurerProgramme(programme) {
  let complexite = 1, imbrication = 0;
  let premiere = null, plusProfonde = null;
  for (const instruction of programme.body) {
    const mesure = parcourir([instruction]);
    if (mesure.complexite > 1) {
      complexite += mesure.complexite - 1;
      premiere ??= instruction;
    }
    if (mesure.imbrication > imbrication) {
      imbrication = mesure.imbrication;
      plusProfonde = instruction;
    }
  }
  return { complexite, imbrication, premiere, plusProfonde };
}

/** Le nom du code du niveau supérieur d'une unité (un fichier, ou un script de page), dans les mêmes termes que celui d'une fonction : `{ titre, groupe }`. */
export function nomDuNiveauSuperieur(unite) {
  return unite.inline
    ? { titre: "(niveau supérieur d'un script de la page)", groupe: 'le code du niveau supérieur de ce script de la page' }
    : { titre: '(niveau supérieur du fichier)', groupe: 'le code du niveau supérieur du fichier' };
}

/** Vrai pour une fonction appelée là où elle est écrite : `(function () { … })()`, `(() => { … })()`, `!function () { … }()`, `(function () { … }).call(this)`, `new function () { … }`. */
export function estAutoAppelee(fonction, ancetres) {
  const parent = ancetres[ancetres.length - 2];
  if ((parent?.type === 'CallExpression' || parent?.type === 'NewExpression') && parent.callee === fonction) return true;
  const appel = ancetres[ancetres.length - 3];
  return parent?.type === 'MemberExpression' && !parent.computed && (parent.property.name === 'call' || parent.property.name === 'apply')
    && appel?.type === 'CallExpression' && appel.callee === parent;
}

/** La longueur à laquelle un nom du widget se cite : un identifiant ou une clé de chaîne peut faire des Mio. */
const LONGUEUR_NOM = 60;

/** Le nombre de propriétés qu'un nom pointé (`a.b.c`) garde : au-delà, ce n'est plus un nom qu'un lecteur reconnaît. */
const MAX_PROPRIETES = 8;

/** Le nom d'une clé de propriété ou de méthode : un identifiant, un nom privé, un littéral chaîne ou nombre ; rien si la clé est calculée. */
function nomDeCle(cle, calculee) {
  if (!cle) return null;
  if (cle.type === 'Identifier' && !calculee) return cle.name;
  if (cle.type === 'PrivateIdentifier') return `#${cle.name}`;
  if (cle.type === 'Literal' && (typeof cle.value === 'string' || typeof cle.value === 'number')) return String(cle.value);
  return null;
}

/** Le nom pointé d'une cible d'affectation ou d'un appelé (`this.render`, `grist.onRecords`) quand il ne passe que par des identifiants et des propriétés nommées, sinon null. Sans récursion. */
function nomPointeSimple(noeud) {
  const morceaux = [];
  let n = noeud;
  while (n.type === 'MemberExpression') {
    const propriete = nomDeCle(n.property, n.computed);
    if (propriete === null || morceaux.length >= MAX_PROPRIETES) return null;
    morceaux.unshift(propriete);
    n = n.object;
  }
  if (n.type === 'Identifier') morceaux.unshift(n.name);
  else if (n.type === 'ThisExpression') morceaux.unshift('this');
  else return null;
  return morceaux.join('.');
}

/** Le texte borné : une moitié de paire de substitution coupée devient U+FFFD plutôt que de rester seule. */
const borner = (texte) => (texte.length > LONGUEUR_NOM ? `${texte.slice(0, LONGUEUR_NOM).toWellFormed()}…` : texte);

/** Un nom du widget tel qu'un constat le dit : le texte tel quel (pour un titre) et en extrait de code (pour une phrase) ; cité quand un de ses caractères a un sens pour une sortie, voir `texte-du-widget.js`. */
function dire(nom) {
  const borne = borner(nom);
  const cite = citerSiBesoin(borne);
  return { brut: cite, code: cite === borne ? `\`${borne}\`` : cite };
}

/** Le nom de la classe qui contient la méthode ou le champ : le sien, ou celui de la variable à laquelle `const A = class { … }` l'affecte. */
function nomDeClasse(ancetres, indice) {
  const classe = ancetres[indice];
  if (classe?.type !== 'ClassDeclaration' && classe?.type !== 'ClassExpression') return null;
  if (classe.id) return classe.id.name;
  const declarant = ancetres[indice - 1];
  return declarant?.type === 'VariableDeclarator' && declarant.id.type === 'Identifier' ? declarant.id.name : null;
}

/**
 * Comment un constat nomme une fonction. `titre` est ce qui suit les deux-points d'un titre (le nom tel quel, ou une description entre
 * parenthèses : `(rappel de grist.onRecords)`) ; `groupe` est le groupe nominal d'une phrase, article compris et sans majuscule
 * (« la fonction `render` », « le rappel passé à `grist.onRecords` »).
 * Le nom vient de la déclaration (`function f`, `const f = () => …`, `obj.f = function …`, `{ f() {} }`, un champ de classe, une méthode : `C.f`) ;
 * à défaut, de l'appel qui reçoit la fonction en argument, ou qui l'exécute aussitôt. Tout texte du widget y passe par `dire` : borné, et cité
 * si un de ses caractères a un sens pour une sortie.
 * @param {object} fonction
 * @param {object[]} ancetres les ancêtres du nœud, lui compris en dernier (`walk.ancestor`)
 * @returns {{titre: string, groupe: string}}
 */
export function nomDeFonction(fonction, ancetres) {
  const nommee = (nom, nature = 'fonction') => {
    const { brut, code } = dire(nom);
    return { titre: brut, groupe: `${nature === 'methode' ? 'la méthode' : 'la fonction'} ${code}` };
  };
  if (fonction.id) return nommee(fonction.id.name);
  const parent = ancetres[ancetres.length - 2];
  switch (parent?.type) {
    case 'VariableDeclarator':
      if (parent.init === fonction && parent.id.type === 'Identifier') return nommee(parent.id.name);
      break;
    case 'AssignmentExpression': {
      const cible = parent.right === fonction ? nomPointeSimple(parent.left) : null;
      if (cible !== null) return nommee(cible);
      break;
    }
    case 'Property': {
      const nom = parent.value === fonction ? nomDeCle(parent.key, parent.computed) : null;
      if (nom !== null) return nommee(parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ${nom}` : nom, parent.method ? 'methode' : 'fonction');
      break;
    }
    case 'PropertyDefinition':
    case 'MethodDefinition': {
      const nom = parent.value === fonction ? nomDeCle(parent.key, parent.computed) : null;
      if (nom === null) break;
      const classe = nomDeClasse(ancetres, ancetres.length - 4);
      if (parent.kind === 'constructor') {
        const dit = classe === null ? null : dire(classe);
        return { titre: dit ? `${dit.brut}.constructor` : 'constructor', groupe: dit ? `le constructeur de ${dit.code}` : 'le constructeur' };
      }
      const accesseur = parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ` : '';
      return nommee(`${classe === null ? '' : `${classe}.`}${accesseur}${nom}`, parent.type === 'MethodDefinition' ? 'methode' : 'fonction');
    }
    case 'ExportDefaultDeclaration':
      return { titre: '(fonction exportée par défaut)', groupe: 'la fonction exportée par défaut' };
    case 'CallExpression':
    case 'NewExpression': {
      if (parent.callee === fonction) break;          // auto-appelée, dite plus bas
      const appele = nomPointeSimple(parent.callee)
        ?? (parent.callee.type === 'MemberExpression' ? nomDeCle(parent.callee.property, parent.callee.computed) : null);
      if (appele !== null) {
        const { brut, code } = dire(appele);
        return { titre: `(rappel de ${brut})`, groupe: `le rappel passé à ${code}` };
      }
      break;
    }
    default:
  }
  if (estAutoAppelee(fonction, ancetres)) return { titre: '(fonction auto-appelée)', groupe: 'la fonction auto-appelée' };
  return { titre: '(fonction anonyme)', groupe: 'la fonction anonyme' };
}
