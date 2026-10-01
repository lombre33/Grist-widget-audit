#!/usr/bin/env node
/**
 * Rejoue les mutants de la mesure exacte du code (méthode : `scripts/lib/rejouer-mutants.mjs`) :
 *   - `src/moteur/fonctions.js` : la complexité d'une fonction sur son propre corps (chaque construction qui ajoute un chemin, chaque opérateur
 *     logique, le `case` à test), la profondeur des blocs (chaque construction qui ouvre un niveau, la chaîne de `else if` à plat), les lignes
 *     propres d'une enveloppe, la mesure du code qui n'est dans aucune fonction (le niveau supérieur d'un script) et l'instruction où il faut
 *     regarder, ce qu'est une fonction appelée là où elle est écrite, le nom d'une fonction (déclaration, affectation, propriété, méthode,
 *     champ, constructeur, rappel, enveloppe), le nom du widget borné et cité ;
 *   - `src/moteur/lignes-de-code.js` : le compte des lignes sur les commentaires qu'acorn lit (les blancs, les fins de ligne, le bord d'un
 *     commentaire, la dernière ligne), son repli quand le fichier n'est pas lu, sa mémoire ;
 *   - ce que les règles en font : A-FONC-01/02/03 (les seuils, ceux du niveau supérieur, la mesure d'une enveloppe, la ligne et le texte du constat), A-TAILLE-01, B-COM-01, B-VERB-01.
 * Chaque mutant est tué par une assertion de `tests/a-fonctions.test.mjs` ou de `tests/lignes-de-code.test.mjs`.
 *
 * Mutants équivalents, laissés de côté :
 *   - `if (cle === 'loc') continue;` retiré (`fonctions.js`) : l'objet `loc` n'a ni `type` ni tableau de nœuds, le parcours n'y trouve rien ;
 *   - `noeud.type === 'IfStatement' &&` retiré de la règle du `else if` : seul un `if` a un `alternate` qui soit un `if` ;
 *   - `if (parent.callee === fonction) break;` retiré (nom d'un rappel) : un appelé qui est la fonction n'a pas de nom pointé, le repli retombe sur la même réponse ;
 *   - `.find((u) => !u.inline)` → `.find(() => true)` (`lignes-de-code.js`) : un fichier .js n'a qu'une unité, la sienne.
 *
 * Usage : node scripts/mutants-mesure-exacte.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const F = 'src/moteur/fonctions.js';
const L = 'src/moteur/lignes-de-code.js';
const A = 'src/regles/a-qualite.js';
const B = 'src/regles/b-lisibilite.js';
const TESTS = ['tests/a-fonctions.test.mjs', 'tests/lignes-de-code.test.mjs'];

const CHEMINS = ['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'CatchClause', 'ConditionalExpression', 'LogicalExpression'];
const NIVEAUX = ['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement'];
const sans = (liste, element) => (liste.at(-1) === element ? `, '${element}'` : `'${element}', `);

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- complexité d'une fonction
  ...CHEMINS.map((c) => dansLigne(F, 'const AJOUTE_UN_CHEMIN = new Set(', sans(CHEMINS, c), '', `complexité : ${c} n'ajoute plus de chemin`)),
  dansLigne(F, "noeud.type === 'SwitchCase'", ' && noeud.test', '', 'complexité : le `default` compte comme un `case`'),
  dansLigne(F, "noeud.type === 'SwitchCase'", 'complexite++', '', 'complexité : un `case` ne compte plus'),
  dansLigne(F, 'let complexite = 1;', '= 1', '= 0', 'complexité : une fonction sans branche vaut 0'),
  dansLigne(F, 'const { complexite, imbrication, interieur } = parcourir(', ', ...fonction.params', '', 'complexité : les valeurs par défaut des paramètres ne sont pas lues'),
  dansLigne(F, '// elle a sa propre mesure', 'continue;', '', 'complexité : les fonctions déclarées dedans comptent dans la fonction (et font déborder l\'enveloppe d\'un module)'),

  // --- imbrication
  ...NIVEAUX.map((c) => dansLigne(F, 'const OUVRE_UN_NIVEAU = new Set(', sans(NIVEAUX, c), '', `imbrication : ${c} n'ouvre plus de niveau`)),
  dansLigne(F, 'dedans = niveau + 1;', 'niveau + 1', 'niveau', 'imbrication : aucun bloc n\'ouvre un niveau'),
  dansLigne(F, 'dedans = niveau + 1;', 'niveau + 1', 'niveau + 2', 'imbrication : chaque bloc ouvre deux niveaux'),
  dansLigne(F, 'if (dedans > imbrication) imbrication = dedans;', 'dedans > imbrication', 'dedans < imbrication', 'imbrication : la plus petite profondeur est retenue'),
  dansLigne(F, 'const fils = noeud.type', '? niveau : dedans', '? dedans : dedans', 'imbrication : un `else if` ouvre un niveau de plus que le `if` qu\'il suit (une chaîne de huit en fait huit)'),
  dansLigne(F, 'const fils = noeud.type', "cle === 'alternate'", "cle === 'consequent'", 'imbrication : un `if` sans accolades dans un `if` est tenu pour une chaîne'),
  dansLigne(F, 'const fils = noeud.type', "v?.type === 'IfStatement'", 'true', 'imbrication : un `if` dans le bloc du `else` est tenu pour une chaîne'),
  dansLigne(F, 'const fils = noeud.type', '? niveau : dedans', '? 0 : dedans', 'imbrication : un `else if` remet la profondeur à zéro'),

  // --- lignes
  dansLigne(F, 'const etendue = fonction.loc.end.line', ' + 1;', ';', 'lignes : l\'étendue oublie la première ligne'),
  dansLigne(F, 'interieur += noeud.loc.end.line', ' + 1;', ';', 'lignes : une fonction interne retire une ligne de moins que celles qu\'elle occupe'),
  dansLigne(F, 'interieur += noeud.loc.end.line', 'noeud.loc.end.line > noeud.loc.start.line', 'noeud.loc.end.line >= noeud.loc.start.line', 'lignes : une fonction interne d\'une seule ligne retire sa ligne'),
  dansLigne(F, 'interieur += noeud.loc.end.line', 'interieur +=', 'interieur =', 'lignes : seule la dernière fonction interne est retirée'),
  dansLigne(F, 'return { complexite, imbrication, etendue, lignesPropres', 'etendue - interieur', 'etendue + interieur', 'lignes : les lignes des fonctions internes s\'ajoutent aux lignes propres'),
  dansLigne(F, 'return { complexite, imbrication, etendue, lignesPropres', 'etendue - interieur', 'etendue', 'lignes : les lignes propres sont l\'étendue'),

  // --- une fonction appelée là où elle est écrite
  dansLigne(F, "if ((parent?.type === 'CallExpression'", 'parent.callee === fonction', 'true', 'auto-appelée : toute fonction passée à un appel l\'est'),
  dansLigne(F, "if ((parent?.type === 'CallExpression'", " || parent?.type === 'NewExpression'", '', 'auto-appelée : `new function () {}` ne l\'est plus'),
  dansLigne(F, "if ((parent?.type === 'CallExpression'", "parent?.type === 'CallExpression'", "parent?.type === 'NewExpression'", 'auto-appelée : `(function () {})()` ne l\'est plus'),
  dansLigne(F, "parent?.type === 'MemberExpression' && !parent.computed", '!parent.computed && ', '', 'auto-appelée : `(function () {})[call](x)` l\'est'),
  dansLigne(F, "parent?.type === 'MemberExpression' && !parent.computed", "(parent.property.name === 'call' || parent.property.name === 'apply')", "(parent.property.name === 'apply')", 'auto-appelée : `.call(this)` ne l\'est plus'),
  dansLigne(F, "parent?.type === 'MemberExpression' && !parent.computed", "(parent.property.name === 'call' || parent.property.name === 'apply')", "(parent.property.name === 'call')", 'auto-appelée : `.apply(this, [])` ne l\'est plus'),
  dansLigne(F, "(parent.property.name === 'call'", "(parent.property.name === 'call' || parent.property.name === 'apply')", '(true)', 'auto-appelée : tout membre de la fonction suivi d\'un appel l\'est (`.bind(this)`)'),
  dansLigne(F, "&& appel?.type === 'CallExpression'", "appel?.type === 'CallExpression' && ", '', 'auto-appelée : le membre peut être la cible d\'un `new` (`new (function () {}).call(x)`)'),
  dansLigne(F, "&& appel?.type === 'CallExpression'", ' && appel.callee === parent', '', 'auto-appelée : `g((function () {}).call)` l\'est'),

  // --- les noms
  dansLigne(F, 'const LONGUEUR_NOM = 60;', '60', '59', 'nom : borné à 59'),
  dansLigne(F, 'const LONGUEUR_NOM = 60;', '60', '61', 'nom : borné à 61'),
  dansLigne(F, 'const borner = (texte)', 'texte.length > LONGUEUR_NOM', 'texte.length >= LONGUEUR_NOM', 'nom : un nom de 60 caractères est déjà borné'),
  dansLigne(F, 'const borner = (texte)', '.toWellFormed()', '', 'nom : la coupe peut laisser une moitié de paire de substitution'),
  dansLigne(F, 'const borner = (texte)', 'texte.slice(0, LONGUEUR_NOM)', 'texte', 'nom : aucune borne'),
  dansLigne(F, 'const MAX_PROPRIETES = 8;', '8', '9', 'nom : un nom pointé de neuf propriétés est encore un nom'),
  dansLigne(F, 'const MAX_PROPRIETES = 8;', '8', '7', 'nom : un nom pointé de huit propriétés n\'est plus un nom'),
  dansLigne(F, 'const MAX_PROPRIETES = 8;', '= 8', '= Infinity', 'nom : un nom pointé n\'a pas de borne'),
  dansLigne(F, "if (cle.type === 'Identifier' && !calculee)", ' && !calculee', '', 'nom : une clé calculée `[nom]` porte le nom de sa variable'),
  dansLigne(F, "if (cle.type === 'PrivateIdentifier')", '`#${cle.name}`', 'cle.name', 'nom : une méthode privée perd son #'),
  dansLigne(F, "if (cle.type === 'Literal' &&", "typeof cle.value === 'string' || typeof cle.value === 'number'", "typeof cle.value === 'string'", 'nom : une clé numérique n\'est pas un nom'),
  dansLigne(F, "if (cle.type === 'Literal' &&", "typeof cle.value === 'string' || typeof cle.value === 'number'", "typeof cle.value === 'number'", 'nom : une clé de chaîne n\'est pas un nom'),
  dansLigne(F, "else if (n.type === 'ThisExpression')", "morceaux.unshift('this')", "morceaux.unshift('')", 'nom : `this.render` perd son `this`'),
  dansLigne(F, "if (n.type === 'Identifier') morceaux.unshift(n.name);", "n.type === 'Identifier'", 'true', 'nom : le pied d\'un nom pointé est toujours un identifiant'),
  dansLigne(F, 'return { brut: cite, code:', 'cite === borne ?', 'true ?', 'nom : un nom cité est mis deux fois entre guillemets inversés'),
  dansLigne(F, 'return { brut: cite, code:', 'cite === borne ?', 'false ?', 'nom : un nom sans rien de fragile est cité'),
  dansLigne(F, 'const cite = citerSiBesoin(borne);', 'citerSiBesoin(borne)', 'borne', 'nom : un nom du widget est dit tel quel, sans être cité'),
  dansLigne(F, 'if (fonction.id) return nommee(fonction.id.name);', 'if (fonction.id)', 'if (false)', 'nom : une fonction nommée perd son nom'),
  dansLigne(F, "if (parent.init === fonction && parent.id.type === 'Identifier')", " && parent.id.type === 'Identifier'", '', 'nom : la fonction d\'un motif de déstructuration prend le nom de ce motif'),
  dansLigne(F, 'const cible = parent.right === fonction', 'nomPointeSimple(parent.left)', 'null', 'nom : une affectation ne donne plus son nom'),
  dansLigne(F, "parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ${nom}` : nom", " || parent.kind === 'set'", '', 'nom : le `set` d\'un objet se dit comme une propriété'),
  dansLigne(F, "parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ${nom}` : nom", "parent.kind === 'get' || ", '', 'nom : le `get` d\'un objet se dit comme une propriété'),
  dansLigne(F, "parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ${nom}` : nom", "parent.method ? 'methode' : 'fonction'", "parent.method ? 'fonction' : 'methode'", 'nom : une méthode d\'objet est une fonction, une propriété une méthode'),
  dansLigne(F, "if (parent.kind === 'constructor') {", "parent.kind === 'constructor'", 'false', 'nom : un constructeur est nommé comme une méthode'),
  dansLigne(F, 'const classe = nomDeClasse(ancetres, ancetres.length - 4);', 'ancetres.length - 4', 'ancetres.length - 3', 'nom : la classe est cherchée au mauvais ancêtre'),
  dansLigne(F, 'const accesseur = parent.kind', " || parent.kind === 'set'", '', 'nom : le `set` d\'une classe perd son accesseur'),
  dansLigne(F, "return nommee(`${classe === null ? '' : `${classe}.`}", "parent.type === 'MethodDefinition' ? 'methode' : 'fonction'", "parent.type === 'MethodDefinition' ? 'fonction' : 'methode'", 'nom : une méthode de classe est une fonction, un champ une méthode'),
  dansLigne(F, "return nommee(`${classe === null ? '' : `${classe}.`}", "${classe === null ? '' : `${classe}.`}", '', 'nom : une méthode ne porte pas le nom de sa classe'),
  dansLigne(F, "return declarant?.type === 'VariableDeclarator'", "declarant.id.type === 'Identifier' ? declarant.id.name : null", 'null', 'nom : la classe affectée à une variable n\'a pas de nom'),
  dansLigne(F, "if (classe.id) return classe.id.name;", 'classe.id', 'false', 'nom : une classe nommée est cherchée à sa variable'),
  dansLigne(F, 'const appele = nomPointeSimple(parent.callee)', 'nomPointeSimple(parent.callee)', 'null', 'nom : un rappel perd le nom de l\'appelé'),
  dansLigne(F, "?? (parent.callee.type === 'MemberExpression'", "parent.callee.type === 'MemberExpression'", 'false', 'nom : `$(document).ready(fn)` ne donne pas `ready`'),
  dansLigne(F, 'if (estAutoAppelee(fonction, ancetres))', 'estAutoAppelee(fonction, ancetres)', 'false', 'nom : une enveloppe n\'est pas dite auto-appelée'),

  // --- A-FONC-01, A-FONC-02, A-FONC-03
  dansLigne(A, 'const lignes = autoAppelee ?', 'autoAppelee ? lignesPropres : etendue', 'etendue', 'A-FONC-01 : l\'enveloppe d\'un module compte toutes les lignes de ses fonctions'),
  dansLigne(A, 'const lignes = autoAppelee ?', 'autoAppelee ? lignesPropres : etendue', 'lignesPropres', 'A-FONC-01 : toute fonction compte seulement ses lignes propres'),
  dansLigne(A, 'const lignes = autoAppelee ?', 'autoAppelee ? lignesPropres : etendue', 'autoAppelee ? etendue : lignesPropres', 'A-FONC-01 : l\'enveloppe compte ses lignes en entier, les autres ses lignes propres'),
  dansLigne(A, 'if (lignes > SEUILS.fonctionLongue) {', 'lignes >', 'lignes >=', 'A-FONC-01 : une fonction de 80 lignes est longue (seuil)'),
  dansLigne(A, 'const tres = lignes > SEUILS.fonctionTresLongue;', 'lignes >', 'lignes >=', 'A-FONC-01 : une fonction de 200 lignes est très longue'),
  dansLigne(A, 'if (complexite > SEUILS.complexite) {', 'complexite >', 'complexite >=', 'A-FONC-02 : une complexité de 15 est relevée'),
  dansLigne(A, 'const forte = complexite > SEUILS.complexiteForte;', 'complexite >', 'complexite >=', 'A-FONC-02 : une complexité de 30 est majeure'),
  dansLigne(A, 'if (imbrication > SEUILS.imbrication) {', 'imbrication >', 'imbrication >=', 'A-FONC-03 : une imbrication de 5 est relevée'),
  dansLigne(A, 'constat: etendue > lignes', 'etendue > lignes', 'etendue >= lignes', 'A-FONC-01 : une fonction sans fonction dedans dit ne rien compter'),
  dansLigne(A, 'constat: etendue > lignes', 'etendue > lignes', 'false', 'A-FONC-01 : une enveloppe ne dit pas ce qu\'elle ne compte pas'),
  dansLigne(A, 'const enPhrase = (groupe)', 'groupe.charAt(0).toUpperCase() + groupe.slice(1)', 'groupe', 'A-FONC : la phrase du constat commence par une minuscule'),
  dansLigne(A, 'constat: `${enPhrase(nom.groupe)} atteint', '${enPhrase(nom.groupe)}', '${nom.groupe}', 'A-FONC-03 : la phrase du constat commence par une minuscule'),
  dansLigne(A, 'constat: `${enPhrase(nom.groupe)} comporte', '${enPhrase(nom.groupe)}', '${nom.groupe}', 'A-FONC-02 : la phrase du constat commence par une minuscule'),
  dansLigne(A, 'impact: `Il faut au minimum ${complexite} cas de test', '${complexite}', '${complexite + 1}', 'A-FONC-02 : l\'impact dit un nombre de cas de test de trop'),
  dansLigne(A, 'remediation: dansUneFonction', 'dansUneFonction', '!dansUneFonction', 'A-FONC-03 : le conseil d\'une fonction et celui du niveau supérieur sont échangés'),

  // --- le niveau supérieur d'un script (A-FONC-02, A-FONC-03)
  dansLigne(A, 'const niveauSuperieur = mesurerProgramme(ast);', 'mesurerProgramme(ast)', '{ complexite: 1, imbrication: 0, premiere: null, plusProfonde: null }', 'niveau supérieur : il n\'est pas mesuré'),
  dansLigne(A, 'if (niveauSuperieur.complexite > SEUILS.complexite) {', 'complexite >', 'complexite >=', 'niveau supérieur : une complexité de 15 est relevée'),
  dansLigne(A, 'if (niveauSuperieur.imbrication > SEUILS.imbrication) {', 'imbrication >', 'imbrication >=', 'niveau supérieur : une imbrication de 5 est relevée'),
  dansLigne(A, 'constatComplexite(unite.chemin, ligneDe(niveauSuperieur.premiere)', 'niveauSuperieur.premiere', 'niveauSuperieur.plusProfonde', 'niveau supérieur : la complexité est dite à la ligne de l\'instruction la plus profonde'),
  dansLigne(A, 'constatImbrication(unite.chemin, ligneDe(niveauSuperieur.plusProfonde)', 'niveauSuperieur.plusProfonde', 'niveauSuperieur.premiere', 'niveau supérieur : l\'imbrication est dite à la ligne de la première instruction qui ajoute un chemin'),
  dansLigne(A, 'constatComplexite(unite.chemin, ligneDe(niveauSuperieur.premiere)', 'nomDuNiveauSuperieur(unite)', 'nomDuNiveauSuperieur({ inline: false })', 'niveau supérieur : la complexité d\'un script de page est dite celle d\'un fichier'),
  dansLigne(A, 'constatComplexite(unite.chemin, ligneDe(niveauSuperieur.premiere)', 'nomDuNiveauSuperieur(unite)', 'nomDuNiveauSuperieur({ inline: true })', 'niveau supérieur : la complexité d\'un fichier est dite celle d\'un script de page'),
  dansLigne(A, 'constatImbrication(unite.chemin, ligneDe(niveauSuperieur.plusProfonde)', 'nomDuNiveauSuperieur(unite)', 'nomDuNiveauSuperieur({ inline: false })', 'niveau supérieur : l\'imbrication d\'un script de page est dite celle d\'un fichier'),
  dansLigne(A, 'constatImbrication(unite.chemin, ligneDe(niveauSuperieur.plusProfonde)', 'nomDuNiveauSuperieur(unite)', 'nomDuNiveauSuperieur({ inline: true })', 'niveau supérieur : l\'imbrication d\'un fichier est dite celle d\'un script de page'),
  dansLigne(A, 'constatImbrication(unite.chemin, ligneDe(niveauSuperieur.plusProfonde)', ', false));', ', true));', 'niveau supérieur : l\'imbrication reçoit le conseil du `return` anticipé'),
  dansLigne(A, 'constatImbrication(unite.chemin, ligneDe(n), nomDeFonction(n, ancetres)', ', true));', ', false));', 'A-FONC-03 : une fonction ne reçoit plus le conseil du `return` anticipé'),

  // --- mesurerProgramme
  dansLigne(F, 'let complexite = 1, imbrication = 0;', 'complexite = 1', 'complexite = 0', 'niveau supérieur : un script sans branche vaut 0'),
  dansLigne(F, 'const mesure = parcourir([instruction]);', '[instruction]', '[]', 'niveau supérieur : aucune instruction n\'est mesurée'),
  dansLigne(F, 'if (mesure.complexite > 1) {', '> 1', '>= 1', 'niveau supérieur : toute instruction est tenue pour une qui ajoute un chemin (la première est rendue)'),
  dansLigne(F, 'if (mesure.complexite > 1) {', '> 1', '> 2', 'niveau supérieur : une instruction qui n\'ajoute qu\'un chemin n\'en ajoute aucun'),
  dansLigne(F, 'complexite += mesure.complexite - 1;', ' - 1', '', 'niveau supérieur : chaque instruction ajoute son chemin de base'),
  dansLigne(F, 'complexite += mesure.complexite - 1;', '+=', '=', 'niveau supérieur : seule la dernière instruction compte pour la complexité'),
  dansLigne(F, 'premiere ??= instruction;', '??=', '=', 'niveau supérieur : la dernière instruction qui ajoute un chemin est rendue'),
  dansLigne(F, 'if (mesure.imbrication > imbrication) {', '>', '>=', 'niveau supérieur : la dernière instruction à la plus grande profondeur est rendue'),
  dansLigne(F, 'if (mesure.imbrication > imbrication) {', '>', '<', 'niveau supérieur : la plus petite profondeur est retenue'),
  dansLigne(F, 'imbrication = mesure.imbrication;', '= mesure', '+= mesure', 'niveau supérieur : les profondeurs de deux instructions s\'ajoutent'),
  dansLigne(F, 'plusProfonde = instruction;', 'instruction', 'premiere', 'niveau supérieur : l\'instruction la plus profonde est la première qui ajoute un chemin'),
  dansLigne(F, "return unite.inline", 'unite.inline', 'true', 'nom du niveau supérieur : un fichier est dit un script de page'),
  dansLigne(F, "return unite.inline", 'unite.inline', 'false', 'nom du niveau supérieur : un script de page est dit un fichier'),
  dansLigne(F, "(niveau supérieur du fichier)", 'niveau supérieur du fichier', 'niveau supérieur', 'nom du niveau supérieur : le titre d\'un fichier ne dit plus qu\'il s\'agit du fichier'),
  dansLigne(F, "le code du niveau supérieur de ce script de la page", 'de ce script de la page', 'du fichier', 'nom du niveau supérieur : la phrase d\'un script de page parle du fichier'),

  // --- A-TAILLE-01
  dansLigne(A, '.map((f) => ({ f, ...mesurerLignes(f) }))', '...mesurerLignes(f)', 'code: f.locSignificatives ?? 0, exacte: true', 'A-TAILLE-01 : les lignes sont celles de l\'inventaire (premier caractère)'),
  dansLigne(A, '.filter((m) => m.code > SEUILS.fichierLong)', 'm.code >', 'm.code >=', 'A-TAILLE-01 : un fichier de 600 lignes est long'),
  dansLigne(A, '.sort((a, b) => b.code - a.code);', 'b.code - a.code', 'a.code - b.code', 'A-TAILLE-01 : les fichiers les plus courts d\'abord'),
  dansLigne(A, 'const tresLong = code > SEUILS.fichierTresLong;', 'code >', 'code >=', 'A-TAILLE-01 : un fichier de 1 200 lignes est très long'),
  dansLigne(A, 'Le fichier dépasse le seuil de', "exacte ? '' : NOTE_LIGNES_APPROCHEES", "exacte ? NOTE_LIGNES_APPROCHEES : ''", 'A-TAILLE-01 : le compte approché est dit exact et l\'exact dit approché'),
  dansLigne(A, 'Le fichier dépasse le seuil de', "${exacte ? '' : NOTE_LIGNES_APPROCHEES}", '', 'A-TAILLE-01 : un compte approché ne le dit pas'),

  // --- B-COM-01, B-VERB-01
  dansLigne(B, 'const { code, commentaire, exacte } = mesurerLignes(f);', 'mesurerLignes(f)', '{ code: f.locSignificatives ?? 0, commentaire: f.lignes.filter((l) => /^\\s*(\\/\\/|\\/\\*|\\*)/.test(l)).length, exacte: true }', 'B-COM-01 : les lignes et les commentaires sont ceux de l\'inventaire (premier caractère)'),
  dansLigne(B, 'if (code < 200) continue;', 'code < 200', 'code <= 200', 'B-COM-01 : un fichier de 200 lignes n\'est pas mesuré'),
  dansLigne(B, 'const densite = commentaire / Math.max(1, code);', 'Math.max(1, code)', 'Math.max(1, code + commentaire)', 'B-COM-01 : la densité est rapportée au fichier entier'),
  dansLigne(B, 'if (densite >= 0.04) continue;', '>=', '>', 'B-COM-01 : une densité de 4 % est relevée'),
  dansLigne(B, 'lignes de code (${Math.round(densite * 100)} %).', "exacte ? '' : NOTE_LIGNES_APPROCHEES", "exacte ? NOTE_LIGNES_APPROCHEES : ''", 'B-COM-01 : le compte approché est dit exact et l\'exact dit approché'),
  dansLigne(B, 'const loc = surface.reduce(', '(f.contenu ? mesurerLignes(f).code : 0)', '(f.locSignificatives ?? 0)', 'B-VERB-01 : les lignes sont celles de l\'inventaire (premier caractère)'),
  dansLigne(B, 'if (loc + html > seuil) {', 'loc + html >', 'loc + html >=', 'B-VERB-01 : 4 000 lignes dépassent le seuil'),
  dansLigne(B, "severite: loc + html > 12000 ? 'majeur' : 'mineur'", '>', '>=', 'B-VERB-01 : 12 000 lignes sont majeures'),
  dansLigne(B, "severite: loc + html > 12000 ? 'majeur' : 'mineur'", '12000', '4000', 'B-VERB-01 : 4 000 lignes sont majeures'),

  // --- compter les lignes
  dansLigne(L, 'return c === 32 ||', 'c === 32 || ', '', 'blancs : l\'espace est du code'),
  dansLigne(L, 'return c === 32 ||', '(c >= 9 && c <= 12)', '(c >= 9 && c <= 11)', 'blancs : le saut de page est du code'),
  dansLigne(L, 'return c === 32 ||', '(c >= 9 && c <= 12)', '(c >= 10 && c <= 12)', 'blancs : la tabulation est du code'),
  dansLigne(L, 'return c === 32 ||', 'c === 0xa0 || ', '', 'blancs : l\'espace insécable est du code'),
  dansLigne(L, 'return c === 32 ||', 'c === 0x1680 || ', '', 'blancs : l\'espace ogham est du code'),
  dansLigne(L, 'return c === 32 ||', '(c >= 0x2000 && c <= 0x200a)', '(c > 0x2000 && c <= 0x200a)', 'blancs : l\'espace demi-cadratin (U+2000) est du code'),
  dansLigne(L, 'return c === 32 ||', '(c >= 0x2000 && c <= 0x200a)', '(c >= 0x2000 && c < 0x200a)', 'blancs : l\'espace ultra-fine (U+200A) est du code'),
  dansLigne(L, 'return c === 32 ||', 'c === 0x202f || ', '', 'blancs : l\'espace fine insécable est du code'),
  dansLigne(L, 'return c === 32 ||', 'c === 0x205f || ', '', 'blancs : l\'espace moyenne mathématique est du code'),
  dansLigne(L, 'return c === 32 ||', 'c === 0x3000 || ', '', 'blancs : l\'espace idéographique est du code'),
  dansLigne(L, 'return c === 32 ||', ' || c === 0xfeff', '', 'blancs : la marque d\'ordre des octets est du code'),
  dansLigne(L, 'if (c === NL || c === CR || c === LS || c === PS) {', 'c === NL || ', '', 'fin de ligne : \\n ne ferme plus la ligne'),
  dansLigne(L, 'if (c === NL || c === CR || c === LS || c === PS) {', 'c === CR || ', '', 'fin de ligne : \\r seul ne ferme plus la ligne'),
  dansLigne(L, 'if (c === NL || c === CR || c === LS || c === PS) {', 'c === LS || ', '', 'fin de ligne : U+2028 ne ferme plus la ligne'),
  dansLigne(L, 'if (c === NL || c === CR || c === LS || c === PS) {', ' || c === PS', '', 'fin de ligne : U+2029 ne ferme plus la ligne'),
  dansLigne(L, 'if (c === CR && source.charCodeAt(i + 1) === NL) i++;', 'i++;', '', 'fin de ligne : \\r\\n compte pour deux fins de ligne'),
  dansLigne(L, 'if (c === CR && source.charCodeAt(i + 1) === NL) i++;', 'c === CR &&', 'true &&', 'fin de ligne : une fin de ligne \\n suivant n\'importe quel caractère est avalée'),
  dansLigne(L, 'if (porteDuCode) code++;', 'if (porteDuCode)', 'if (porteUnCommentaire)', 'lignes : une ligne qui porte un commentaire est du code'),
  dansLigne(L, 'else if (porteUnCommentaire) commentaire++;', 'else if (porteUnCommentaire)', 'else if (false)', 'lignes : un commentaire seul est une ligne vide'),
  dansLigne(L, 'else vide++;', 'vide++', 'commentaire++', 'lignes : une ligne vide est un commentaire'),
  dansLigne(L, 'porteDuCode = porteUnCommentaire = ligneOuverte = false;', ' = ligneOuverte', '', 'lignes : une ligne qui porte un commentaire le garde pour la suivante'),
  dansLigne(L, 'porteDuCode = porteUnCommentaire = ligneOuverte = false;', 'porteDuCode = ', '', 'lignes : une ligne qui porte du code le garde pour la suivante'),
  dansLigne(L, '    ligneOuverte = true;', 'true', 'false', 'lignes : une dernière ligne de blancs sans fin de ligne n\'est pas comptée'),
  dansLigne(L, 'if (ligneOuverte) fermer();', 'ligneOuverte', 'false', 'lignes : la dernière ligne sans fin de ligne n\'est pas comptée'),
  dansLigne(L, 'if (ligneOuverte) fermer();', 'ligneOuverte', 'true', 'lignes : ce qui suit la dernière fin de ligne est une ligne vide de plus'),
  dansLigne(L, '    if (estBlanc(c)) continue;', 'estBlanc(c)', 'false', 'lignes : un blanc dans un commentaire fait une ligne de commentaire'),
  dansLigne(L, 'while (i >= finCourant && suivant < commentaires.length) {', 'i >= finCourant', 'i > finCourant', 'commentaires : deux commentaires collés ne sont plus qu\'un'),
  dansLigne(L, 'while (i >= finCourant && suivant < commentaires.length) {', ' && suivant < commentaires.length', '', 'commentaires : la liste n\'a pas de fin'),
  dansLigne(L, 'debutCourant = commentaires[suivant].debut;', 'commentaires[suivant].debut', 'commentaires[suivant].fin', 'commentaires : un commentaire commence là où il finit'),
  dansLigne(L, '      suivant++;', 'suivant++', 'suivant += 2', 'commentaires : un commentaire sur deux est lu'),
  dansLigne(L, 'if (i >= debutCourant && i < finCourant) porteUnCommentaire = true;', 'i >= debutCourant', 'i > debutCourant', 'commentaires : le premier caractère d\'un commentaire est du code'),
  dansLigne(L, 'if (i >= debutCourant && i < finCourant) porteUnCommentaire = true;', 'i < finCourant', 'i <= finCourant', 'commentaires : le caractère qui suit un commentaire en fait partie'),
  dansLigne(L, 'if (i >= debutCourant && i < finCourant) porteUnCommentaire = true;', 'i >= debutCourant && ', '', 'commentaires : un code qui précède un commentaire en fait partie'),
  dansLigne(L, 'let suivant = 0, debutCourant = 0, finCourant = 0;', 'finCourant = 0', 'finCourant = 1', 'commentaires : le premier caractère est un commentaire'),

  // --- mesurerLignes
  dansLigne(L, 'let mesure = memoire.get(f);', 'memoire.get(f)', 'undefined', 'mesurerLignes : le compte d\'un fichier est refait pour chaque règle'),
  dansLigne(L, 'memoire.set(f, mesure);', 'memoire.set(f, mesure);', '', 'mesurerLignes : le compte d\'un fichier n\'est jamais gardé'),
  dansLigne(L, '? { ...compterLignes(f.contenu, ast.commentaires), exacte: true }', 'exacte: true', 'exacte: false', 'mesurerLignes : un compte exact se dit approché'),
  dansLigne(L, '? { ...compterLignes(f.contenu, ast.commentaires), exacte: true }', 'ast.commentaires', '[]', 'mesurerLignes : les commentaires d\'acorn ne sont pas relevés'),
  dansLigne(L, 'code: f.locSignificatives ?? 0,', 'f.locSignificatives ?? 0', 'f.locSignificatives ?? 1', 'mesurerLignes : un fichier sans compte d\'inventaire vaut une ligne'),
  dansLigne(L, 'code: f.locSignificatives ?? 0,', 'f.locSignificatives ?? 0', '0', 'mesurerLignes : le repli ignore le compte de l\'inventaire'),
  dansLigne(L, 'commentaire: (f.lignes ?? []).filter', '(f.lignes ?? [])', '[]', 'mesurerLignes : le repli ne compte aucun commentaire'),
  dansLigne(L, 'exacte: false,', 'false', 'true', 'mesurerLignes : un compte approché se dit exact'),
  dansLigne(L, 'const DEBUT_DE_COMMENTAIRE =', '|\\*)', ')', 'mesurerLignes : le repli ne reconnaît plus la suite d\'un commentaire de bloc'),
  dansLigne(L, 'const DEBUT_DE_COMMENTAIRE =', '\\/\\/|', '', 'mesurerLignes : le repli ne reconnaît plus un commentaire de ligne'),
  dansLigne(L, 'const DEBUT_DE_COMMENTAIRE =', '|\\/\\*', '', 'mesurerLignes : le repli ne reconnaît plus l\'ouverture d\'un commentaire de bloc'),
  dansLigne(L, 'export const NOTE_LIGNES_APPROCHEES =', "d'après leur premier caractère", 'exactement', 'NOTE_LIGNES_APPROCHEES : la note ne dit plus que le compte est approché'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de la mesure exacte du code', fichiers: TESTS }],
  exigerChromium: false,
  partie,
  delaiMs: 90_000,
});
