#!/usr/bin/env node
/**
 * Rejoue les mutants de ce que l'inventaire des fichiers fait d'un code qu'il n'a pas pu lire ou parcourir (`tests/inventaire-illisible.test.mjs`) :
 * la lecture qui échoue est gardée et partagée avec les règles et les graphes de document (une seule lecture), le parcours qui échoue est relevé
 * au lieu d'être avalé ou de faire sortir l'audit, C-SURFACE-03 dit l'un et l'autre une fois par unité avec l'étape où l'échec a eu lieu, et
 * l'erreur d'une lecture qui n'est ni une syntaxe refusée ni un dépassement de pile est une erreur de l'outil (`analyse`). Chaque mutant pose, sur
 * la ligne qui porte le choix, le défaut plausible : un des essais doit alors échouer (méthode : `scripts/lib/rejouer-mutants.mjs`). Aucun navigateur
 * n'est requis.
 *
 * Usage : node scripts/mutants-inventaire-illisible.mjs [expression régulière sur le libellé] [--part=i/n] [--valider]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const AJ = 'src/moteur/analyse-js.js';
const I = 'src/contexte/inventaire.js';
const IL = 'src/regles/c-illisibles.js';
const TESTS = ['tests/inventaire-illisible.test.mjs'];

/** Une chaîne qui s'étend sur plusieurs lignes : `[fichier, chaîne d'origine, chaîne mutée, libellé]`. */
const brut = (fichier, ancien, nouveau, libelle) => [fichier, ancien, nouveau, libelle];

const SYNTAXE = "const syntaxe = e instanceof SyntaxError && typeof e.pos === 'number';";
const CAUSE = "cause: profond ? 'profondeur' : syntaxe ? 'syntaxe' : 'analyse',";
const RANGS = 'const RANG_DE_CAUSE = { profondeur: 2, analyse: 1, syntaxe: 0 };';
const PORTE = 'if (parSonExtension || commeCode === true || lecture.ast) {';
const CATCH_INVENTAIRE = '      noterParcoursEchoue(f, unite, e);\n      parExpressionsRegulieres();\n';
const DANS_RELEVER = '    for (const u of unitesJs(f)) {\n      const cle = cleDUnite(u);\n      if (lectures?.has(cle))';
const CONSTAT_INVENTAIRE = "if (n.etape === 'inventaire') return `${debut}";
const PARCOURS_PROFONDEUR = "if (n.etape === 'parcours') return `${debut} : la pile";
const INVENTAIRE_ANALYSE = "if (n.etape === 'inventaire') return `L'inventaire";
const PARCOURS_ANALYSE = "if (n.etape === 'parcours') return `${debut} : ce que";
const LECTURE_ANALYSE = "return `${debut}. S'il s'exécute dans le navigateur, aucune règle ne l'a lu.`;";

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // Ce qu'une lecture qui lève dit : syntaxe d'acorn, dépassement de pile, ou erreur de l'outil -------------------------------------
  dansLigne(AJ, SYNTAXE, "e instanceof SyntaxError && typeof e.pos === 'number'", 'e instanceof SyntaxError', 'erreur de lecture : une erreur de syntaxe sans position est celle d\'acorn'),
  dansLigne(AJ, SYNTAXE, "e instanceof SyntaxError && ", '', 'erreur de lecture : toute erreur qui porte une position est une erreur de syntaxe d\'acorn'),
  dansLigne(AJ, SYNTAXE, "typeof e.pos === 'number'", 'true', 'erreur de lecture : toute erreur de syntaxe est celle d\'acorn'),
  dansLigne(AJ, CAUSE, "syntaxe ? 'syntaxe' : 'analyse'", "'syntaxe'", 'erreur de lecture : une erreur de l\'outil est dite une syntaxe refusée'),
  dansLigne(AJ, CAUSE, "syntaxe ? 'syntaxe' : 'analyse'", "'analyse'", 'erreur de lecture : une syntaxe refusée est dite une erreur de l\'outil'),
  dansLigne(AJ, 'message: profond ? \'la pile déborde\' : syntaxe ?', ': messageDErreur(e),', ': String(e?.message ?? e),', 'erreur de lecture : l\'erreur de l\'outil ne dit pas son type'),
  dansLigne(AJ, 'const messageDErreur = (e) =>', "e?.name ?? 'Error'", "'Error'", 'erreur de l\'outil : elle ne dit pas son type'),
  dansLigne(AJ, 'const messageDErreur = (e) =>', '.slice(0, 200)', '.slice(0, 2000)', 'erreur de l\'outil : son message est dit en entier'),
  dansLigne(AJ, 'const messageDErreur = (e) =>', '.slice(0, 200)', '.slice(0, 20)', 'erreur de l\'outil : son message est coupé à vingt caractères'),
  dansLigne(AJ, RANGS, '{ profondeur: 2, analyse: 1, syntaxe: 0 }', '{ profondeur: 2, analyse: 0, syntaxe: 1 }', 'deux lectures : la syntaxe refusée l\'emporte sur l\'erreur de l\'outil'),
  dansLigne(AJ, RANGS, '{ profondeur: 2, analyse: 1, syntaxe: 0 }', '{ profondeur: 1, analyse: 2, syntaxe: 0 }', 'deux lectures : l\'erreur de l\'outil l\'emporte sur le dépassement de pile'),
  dansLigne(AJ, RANGS, '{ profondeur: 2, analyse: 1, syntaxe: 0 }', '{ profondeur: 0, analyse: 1, syntaxe: 2 }', 'deux lectures : la syntaxe refusée l\'emporte sur le dépassement de pile'),
  dansLigne(AJ, 'if (RANG_DE_CAUSE[b.cause] !== RANG_DE_CAUSE[a.cause])', 'RANG_DE_CAUSE[b.cause] !== RANG_DE_CAUSE[a.cause]', 'false', 'deux lectures : la raison qui va le plus loin l\'emporte toujours sur celle qui dit le plus'),
  dansLigne(AJ, 'if (RANG_DE_CAUSE[b.cause] !== RANG_DE_CAUSE[a.cause]) return', '> RANG_DE_CAUSE[a.cause] ? b : a;', '< RANG_DE_CAUSE[a.cause] ? b : a;', 'deux lectures : la raison qui dit le moins l\'emporte'),

  // La clé d'une unité, le relevé de ce que l'inventaire n'a pas pu parcourir ----------------------------------------------------
  dansLigne(AJ, 'const cleDUnite = (u) =>', "u.inline ? u.debut : 'fichier'", "'fichier'", 'unité : deux scripts d\'une même page ont la même clé'),
  brut(AJ, 'export function noterParcoursEchoue(f, u, e) {\n  const cle = cleDUnite(u);', "export function noterParcoursEchoue(f, u, e) {\n  const cle = 'fichier';", 'parcours de l\'inventaire : deux scripts d\'une même page qui échouent n\'en font qu\'un'),
  dansLigne(AJ, 'if (!echecs.has(cle)) echecs.set(cle, { ...erreurDeParcours(e), etape:', 'if (!echecs.has(cle)) ', '', 'parcours de l\'inventaire : la dernière raison remplace la première'),
  dansLigne(AJ, 'if (!echecs.has(cle)) echecs.set(cle, { ...erreurDeParcours(e), etape:', "etape: 'inventaire'", "etape: 'parcours'", 'parcours de l\'inventaire : son échec est dit celui d\'une règle'),
  dansLigne(AJ, 'if (!echecs.has(cle)) echecs.set(cle, { ...erreurDeParcours(e), etape:', ", etape: 'inventaire'", '', 'parcours de l\'inventaire : son échec est dit une lecture refusée'),
  dansLigne(AJ, 'if (!echecs) parcoursEchoues.set(f, echecs = new Map());', 'echecs = new Map()', 'new Map()', 'parcours de l\'inventaire : les échecs d\'un même fichier ne sont pas gardés ensemble'),
  dansLigne(AJ, 'for (const f of contexte.fichiers ?? []) {', 'contexte.fichiers ?? []', '[]', 'inventaire relevé : aucun fichier n\'est regardé'),
  dansLigne(AJ, 'if (!lectures && !parcours) continue;', 'if (!lectures && !parcours) continue;', 'continue;', 'inventaire relevé : aucun fichier n\'a d\'échec'),
  dansLigne(AJ, 'if (!lectures && !parcours) continue;', '!lectures && !parcours', '!lectures || !parcours', 'inventaire relevé : un fichier n\'a d\'échec que s\'il a les deux'),
  brut(AJ, DANS_RELEVER, DANS_RELEVER.replace('const cle = cleDUnite(u);', "const cle = 'fichier';"), 'inventaire relevé : un script de la page est pris pour le fichier entier'),
  dansLigne(AJ, 'if (lectures?.has(cle)) noterLectureRefusee(contexte, f, u, lectures.get(cle));', 'if (lectures?.has(cle))', 'if (false)', 'inventaire relevé : une lecture refusée n\'est pas dite'),
  dansLigne(AJ, 'if (lectures?.has(cle)) noterLectureRefusee(contexte, f, u, lectures.get(cle));', 'noterLectureRefusee(contexte, f, u, lectures.get(cle))', 'noterIllisible(contexte, f, u, lectures.get(cle))', 'inventaire relevé : une lecture refusée est dite même pour un code que rien n\'exécute'),
  dansLigne(AJ, 'else if (parcours?.has(cle)) noterIllisible(contexte, f, u, parcours.get(cle));', 'else if (parcours?.has(cle))', 'else if (false)', 'inventaire relevé : un parcours qui a échoué n\'est pas dit'),
  dansLigne(AJ, "etape: erreur.etape ?? 'lecture',", "erreur.etape ?? 'lecture'", "'lecture'", 'illisibles : l\'étape d\'un échec n\'est pas gardée'),
  dansLigne(AJ, "etape: erreur.etape ?? 'lecture',", "?? 'lecture'", "?? 'parcours'", 'illisibles : une lecture refusée est dite un parcours qui a échoué'),
  dansLigne(AJ, 'noterIllisible(releverDans, f, u, { ...erreurDeParcours(e), etape:', "etape: 'parcours'", "etape: 'inventaire'", 'parcours des règles : l\'échec d\'une règle est dit celui de l\'inventaire'),
  dansLigne(AJ, 'noterIllisible(releverDans, f, u, { ...erreurDeParcours(e), etape:', ", etape: 'parcours'", '', 'parcours des règles : l\'échec d\'une règle est dit une lecture refusée'),

  // La lecture partagée : l'inventaire lit par `lireUnite`, une fois, avec la clé de l'unité ----------------------------------------
  dansLigne(AJ, 'if (!lecture.ast) {', 'if (!lecture.ast) {', 'if (false) {', 'lecture gardée : aucun échec n\'est gardé'),
  brut(AJ, 'export function lireUnite(f, u) {\n  const cle = cleDUnite(u);\n  const echecs = lecturesEchouees.get(f);', 'export function lireUnite(f, u) {\n  const cle = cleDUnite(u);\n  const echecs = undefined;', 'lecture gardée : un échec déjà gardé n\'est jamais retrouvé'),
  dansLigne(AJ, 'else echecs.set(cle, lecture.erreur);', 'else echecs.set(cle, lecture.erreur);', '', 'lecture gardée : le deuxième échec d\'un même fichier n\'est pas gardé'),

  // Ce que l'inventaire fait d'un arbre qu'il ne parcourt pas -------------------------------------------------------------------------
  brut(I, CATCH_INVENTAIRE, '      parExpressionsRegulieres();\n', 'parcours de l\'inventaire : l\'échec est avalé sans être relevé'),
  brut(I, CATCH_INVENTAIRE, '      noterParcoursEchoue(f, unite, e);\n', 'parcours de l\'inventaire : un arbre que le parcours ne porte pas ne donne aucune référence'),
  brut(I, CATCH_INVENTAIRE, '      if (!(e instanceof RangeError)) throw e;\n      noterParcoursEchoue(f, unite, e);\n      parExpressionsRegulieres();\n', 'parcours de l\'inventaire : une erreur de l\'outil, qui n\'est pas un dépassement de pile, fait sortir l\'audit'),
  brut(I, CATCH_INVENTAIRE, '      noterParcoursEchoue(f, unite, e);\n      throw e;\n      parExpressionsRegulieres();\n', 'parcours de l\'inventaire : un arbre que le parcours ne porte pas fait sortir l\'audit après avoir été relevé'),
  dansLigne(I, 'noterParcoursEchoue(f, unite, e);', 'noterParcoursEchoue(f, unite, e);', 'noterParcoursEchoue(f, { ...unite, inline: !unite.inline }, e);', 'parcours de l\'inventaire : l\'échec est relevé sous la clé d\'une autre unité'),
  dansLigne(I, 'export function referencesDeCode(f, unite, lecture = lireUnite(f, unite)) {', 'lecture = lireUnite(f, unite)', 'lecture = null', 'références : sans lecture donnée, l\'arbre n\'est pas lu'),
  dansLigne(I, 'const { ast } = lecture;', 'const { ast } = lecture;', 'const { ast } = lireUnite(f, unite);', 'références : la lecture faite par la porte est refaite'),
  dansLigne(I, 'const lues = referencesDeCode(f, { source: s.texte, inline: true, debut: s.debut });', 'inline: true', 'inline: false', 'références : un script de la page est lu comme un fichier entier'),
  dansLigne(I, 'const lues = referencesDeCode(f, { source: s.texte, inline: true, debut: s.debut });', 'debut: s.debut', 'debut: null', 'références : un script de la page est lu sans son début'),
  dansLigne(I, 'const lues = referencesDeCode(f, { source: s.texte, inline: true, debut: s.debut });', 'debut: s.debut', 'debut: 0', 'références : tous les scripts de la page sont lus comme le premier'),
  dansLigne(I, 'const unite = { source: c, inline: false, debut: null };', 'inline: false, debut: null', 'inline: true, debut: 0', 'références : un fichier entier est lu comme un script au début de la page'),
  dansLigne(I, 'const lecture = lireUnite(f, unite);', 'lireUnite(f, unite)', '{ ast: null, erreur: null }', 'références : aucun fichier ne se lit'),
  dansLigne(I, 'const parSonExtension = EXTENSIONS_DE_CODE.includes(f.ext);', 'EXTENSIONS_DE_CODE.includes(f.ext)', 'false', 'références : un fichier n\'est pas du code par son extension'),
  dansLigne(I, 'const parSonExtension = EXTENSIONS_DE_CODE.includes(f.ext);', 'EXTENSIONS_DE_CODE.includes(f.ext)', 'true', 'références : tout fichier est du code par son extension'),
  dansLigne(I, 'if (parSonExtension || commeCode) {', '|| commeCode', "|| commeCode === true", 'références : un fichier que seule une carte d\'import désigne n\'est pas lu'),
  dansLigne(I, 'if (parSonExtension || commeCode) {', 'parSonExtension || commeCode', 'true', 'références : tout fichier est lu'),
  ...[['.js', 'JavaScript'], ['.mjs', 'module .mjs'], ['.cjs', 'script .cjs'], ['.jsx', 'JSX'], ['.ts', 'TypeScript'], ['.tsx', 'TSX']].map(([ext, nom]) => dansLigne(I, 'const EXTENSIONS_DE_CODE = [', `'${ext}'`, "'.aucune'", `références : un fichier ${nom} n'est pas du code par son extension`)),
  dansLigne(I, PORTE, 'parSonExtension || ', '', 'références : un fichier JavaScript n\'est lu que si une adresse le désigne'),

  // Ce que C-SURFACE-03 dit de chaque étape ----------------------------------------------------------------------------------------
  dansLigne(IL, 'releverEchecsDeLInventaire(ctx);', 'releverEchecsDeLInventaire(ctx);', '', 'C-SURFACE-03 : ce que l\'inventaire n\'a pas pu lire ni parcourir n\'est pas dit'),
  dansLigne(IL, CONSTAT_INVENTAIRE, "n.etape === 'inventaire'", 'false', 'C-SURFACE-03 : l\'échec de l\'inventaire est dit un échec de lecture (profondeur)'),
  dansLigne(IL, CONSTAT_INVENTAIRE, "n.etape === 'inventaire'", "n.etape !== 'inventaire'", 'C-SURFACE-03 : toute étape est dite celle de l\'inventaire (profondeur)'),
  dansLigne(IL, PARCOURS_PROFONDEUR, "n.etape === 'parcours'", 'false', 'C-SURFACE-03 : l\'échec d\'une règle est dit un échec de lecture (profondeur)'),
  dansLigne(IL, PARCOURS_PROFONDEUR, "n.etape === 'parcours'", "n.etape !== 'parcours'", 'C-SURFACE-03 : toute étape est dite celle d\'une règle (profondeur)'),
  dansLigne(IL, INVENTAIRE_ANALYSE, "n.etape === 'inventaire'", 'false', 'C-SURFACE-03 : l\'erreur de l\'inventaire est dite celle de l\'analyse'),
  dansLigne(IL, INVENTAIRE_ANALYSE, "n.etape === 'inventaire'", 'true', 'C-SURFACE-03 : toute erreur de l\'outil est dite celle de l\'inventaire'),
  // L'erreur de l'outil dite selon l'étape : à la lecture aucune règle n'a d'arbre (« incomplet » y voudrait dire « rien »), au parcours les autres règles ont lu
  dansLigne(IL, PARCOURS_ANALYSE, "n.etape === 'parcours'", 'false', 'C-SURFACE-03 : l\'erreur d\'une règle est dite une lecture que personne n\'a faite (analyse)'),
  dansLigne(IL, PARCOURS_ANALYSE, "n.etape === 'parcours'", "n.etape !== 'parcours'", 'C-SURFACE-03 : toute erreur de l\'outil est dite celle d\'une règle (analyse)'),
  dansLigne(IL, PARCOURS_ANALYSE, "n.etape === 'parcours'", "n.etape !== 'lecture'", 'C-SURFACE-03 : une étape absente est dite celle d\'une règle (analyse)'),
  dansLigne(IL, LECTURE_ANALYSE, "aucune règle ne l'a lu", 'ce que les règles en disent est incomplet', 'C-SURFACE-03 : la lecture qui échoue est dite « incomplet » (analyse)'),
  dansLigne(IL, LECTURE_ANALYSE, "S'il s'exécute dans le navigateur, ", '', 'C-SURFACE-03 : la lecture qui échoue ne réserve pas « s\'il s\'exécute dans le navigateur » (analyse)'),
  dansLigne(IL, 'preuve: { cause: n.cause, message: n.message, etape: n.etape,', 'etape: n.etape, ', '', 'C-SURFACE-03 : la preuve ne dit pas l\'étape'),
  dansLigne(IL, 'preuve: { emplacements: reste.map((n) => ({ fichier: n.chemin, ligne: n.ligne, cause: n.cause, message: n.message', ', etape: n.etape', '', 'C-SURFACE-03 : la preuve du groupe ne dit pas l\'étape'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de l\'inventaire qui n\'a pas pu lire', fichiers: TESTS }],
  exigerChromium: false,
  partie,
});
