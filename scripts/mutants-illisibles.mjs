#!/usr/bin/env node
/**
 * Rejoue les mutants du code que l'outil ne sait pas lire : la lecture qu'acorn refuse (syntaxe, imbrication au-delà de sa pile),
 * le parcours des règles qui déborde ou qui échoue, le constat critique et bloquant par fichier (C-SURFACE-03) et les axes qu'il
 * empêche, l'information groupée de ce qui n'est pas exécuté ou que seule une carte d'import désigne, et ce qu'une adresse désigne
 * comme du code quelle que soit l'extension (balise script, import, worker, carte d'import ; le JSON valide n'exécute rien ; un
 * import de données n'est pas du code). Chaque mutant pose, sur la ligne qui porte le choix, le défaut plausible : un des essais
 * doit alors échouer (méthode : `scripts/lib/rejouer-mutants.mjs`). Aucun navigateur n'est requis.
 *
 * Usage : node scripts/mutants-illisibles.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const AJ = 'src/moteur/analyse-js.js';
const I = 'src/contexte/inventaire.js';
const IL = 'src/regles/c-illisibles.js';
const T = 'src/moteur/statique.js';
const TESTS = ['tests/code-illisible.test.mjs'];

/** Une chaîne qui s'étend sur plusieurs lignes : `[fichier, chaîne d'origine, chaîne mutée, libellé]`. */
const brut = (fichier, ancien, nouveau, libelle) => [fichier, ancien, nouveau, libelle];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // Le dépassement de pile : ce que `lire` et le parcours des règles font d'une erreur de profondeur ------------------------
  dansLigne(AJ, 'export const depassementDePile', '(e instanceof RangeError && /call stack/i.test(String(e.message))) || ', '', 'dépassement de pile : le RangeError de V8 n\'en est plus un'),
  dansLigne(AJ, 'export const depassementDePile', ' || (e instanceof SyntaxError && /not enough stack space/i.test(String(e.message)))', '', 'dépassement de pile : l\'erreur que la lecture d\'acorn en fait n\'en est plus une'),
  dansLigne(AJ, 'export const depassementDePile', 'e instanceof RangeError', 'e instanceof Error', 'dépassement de pile : toute erreur qui cite la pile en est un'),
  dansLigne(AJ, 'export const depassementDePile', 'e instanceof SyntaxError', 'e instanceof Error', 'dépassement de pile : toute erreur qui cite la pile de lecture en est un'),
  dansLigne(AJ, 'export const depassementDePile', '/call stack/i', '/./', 'dépassement de pile : tout RangeError en est un'),
  dansLigne(AJ, 'export const depassementDePile', '/not enough stack space/i', '/./', 'dépassement de pile : toute erreur de syntaxe en est un'),

  // La lecture d'une unité : l'arbre, sinon la raison ----------------------------------------------------------------------
  dansLigne(AJ, "cause: profond ? 'profondeur' : syntaxe ?", "profond ? 'profondeur' :", "profond ? 'syntaxe' :", 'lecture : une imbrication trop profonde est dite de syntaxe'),
  dansLigne(AJ, "message: profond ? 'la pile déborde' : syntaxe ?", "profond ? 'la pile déborde' : ", '', 'lecture : la raison d\'une imbrication trop profonde est le message d\'acorn'),
  dansLigne(AJ, "message: profond ? 'la pile déborde' : syntaxe ?", ".replace(/\\s*\\(\\d+:\\d+\\)$/, '')", '', 'lecture : la raison garde la position entre parenthèses'),
  dansLigne(AJ, 'colonne: e?.loc ? e.loc.column + 1 : null', 'e.loc.column + 1', 'e.loc.column', 'lecture : la colonne se compte depuis zéro'),
  dansLigne(AJ, 'colonne: e?.loc ? e.loc.column + 1 : null', 'e?.loc ? e.loc.column + 1 : null', 'null', 'lecture : la colonne de l\'erreur n\'est pas dite'),
  dansLigne(AJ, 'ligne: e?.loc?.line ?? null', 'e?.loc?.line ?? null', 'null', 'lecture : la ligne de l\'erreur n\'est pas dite'),
  dansLigne(AJ, "position: typeof e?.pos === 'number' ? e.pos : null,", "typeof e?.pos === 'number' ? e.pos : null", 'null', 'lecture : la position de l\'erreur n\'est pas gardée'),
  dansLigne(AJ, 'return (b.position ?? -1) > (a.position ?? -1) ? b : a;', '>', '<', 'erreur la plus loin : on garde celle qui s\'arrête le plus tôt'),
  dansLigne(AJ, "for (const sourceType of ['module', 'script']) {", "['module', 'script']", "['script']", 'lecture : le mode module n\'est pas essayé'),
  dansLigne(AJ, "for (const sourceType of ['module', 'script']) {", "['module', 'script']", "['module']", 'lecture : le mode script n\'est pas essayé'),

  // Ce qu'une unité que la lecture a refusée devient ------------------------------------------------------------------------
  dansLigne(AJ, 'if (liste.has(cle)) return;', 'if (liste.has(cle)) return;', '', 'illisibles : une unité que plusieurs règles rencontrent est relevée autant de fois'),
  dansLigne(AJ, "const cle = `${f.chemin}\\0${cleDUnite(u)}`;", 'cleDUnite(u)', "'fichier'", 'illisibles : deux scripts illisibles d\'une même page n\'en font qu\'un'),
  dansLigne(AJ, "const cle = `${f.chemin}\\0${cleDUnite(u)}`;", '${f.chemin}\\0', '', 'illisibles : deux fichiers illisibles n\'en font qu\'un'),
  dansLigne(AJ, 'ligne: place ? place.ligne : (u.inline ? u.debutLigne : erreur.ligne)', 'place ? place.ligne :', 'false ? 0 :', 'illisibles : un script de la page est dit à la ligne de son début, non à celle de l\'erreur'),
  dansLigne(AJ, 'ligne: place ? place.ligne : (u.inline ? u.debutLigne : erreur.ligne)', 'u.inline ? u.debutLigne : erreur.ligne', 'erreur.ligne', 'illisibles : un script dont le parcours a échoué n\'est pas dit à la ligne de son début'),
  dansLigne(AJ, 'ligne: place ? place.ligne : (u.inline ? u.debutLigne : erreur.ligne)', 'u.inline ? u.debutLigne : erreur.ligne', 'u.debutLigne', 'illisibles : un fichier est dit à la ligne où commence une unité qui n\'existe pas'),
  dansLigne(AJ, 'colonne: place ? place.colonne + 1 : erreur.colonne', 'place.colonne + 1', 'place.colonne', 'illisibles : la colonne d\'un script de la page se compte depuis zéro'),
  dansLigne(AJ, 'colonne: place ? place.colonne + 1 : erreur.colonne', 'place ? place.colonne + 1 : erreur.colonne', 'erreur.colonne', 'illisibles : la colonne d\'un script de la page est celle de l\'erreur dans le script'),
  dansLigne(AJ, 'surface: Boolean(f.executee), dossierExclu: Boolean(f.dossierExclu),', 'surface: Boolean(f.executee)', 'surface: true', 'illisibles : un fichier que rien n\'exécute est tenu pour exécuté'),
  dansLigne(AJ, 'surface: Boolean(f.executee), dossierExclu: Boolean(f.dossierExclu),', 'surface: Boolean(f.executee)', 'surface: false', 'illisibles : un fichier exécuté est tenu pour non exécuté'),
  dansLigne(AJ, 'surface: Boolean(f.executee), dossierExclu: Boolean(f.dossierExclu),', 'dossierExclu: Boolean(f.dossierExclu)', 'dossierExclu: false', 'illisibles : un dossier exclu n\'est pas dit exclu'),
  dansLigne(AJ, 'chemin: f.chemin, cause: erreur.cause, message: erreur.message, etape:', 'facultative: Boolean(u.facultative)', 'facultative: false', 'illisibles : un fichier que seule une carte d\'import désigne est tenu pour du code'),

  // Le parcours des unités ---------------------------------------------------------------------------------------------------
  dansLigne(AJ, 'noterLectureRefusee(releverDans, f, u, erreur);', 'noterLectureRefusee(releverDans, f, u, erreur);', '', 'parcours : la lecture refusée n\'est pas relevée dans le contexte voulu'),
  dansLigne(AJ, 'if (f.executee) noterIllisible(releves, f, u,', 'if (f.executee) ', '', 'parcours : une unité que rien n\'exécute et qu\'acorn refuse est relevée'),
  dansLigne(AJ, 'if (f.executee) noterIllisible(releves, f, u,', 'if (f.executee)', 'if (false)', 'parcours : le code exécuté que la lecture refuse n\'est jamais relevé'),
  dansLigne(AJ, 'if (f.executee) noterIllisible(releves, f, u,', "u.facultative ? { ...erreur, cause: 'donnee-possible' } : erreur", 'erreur', 'parcours : un fichier facultatif illisible garde la cause d\'une syntaxe refusée'),
  dansLigne(AJ, 'if (f.executee) noterIllisible(releves, f, u,', "cause: 'donnee-possible'", "cause: 'syntaxe'", 'parcours : la cause d\'un fichier facultatif illisible est une syntaxe refusée'),
  dansLigne(AJ, 'noterIllisible(releverDans, f, u, {', 'noterIllisible(releverDans, f, u, {', 'throw e; noterIllisible(releverDans, f, u, {', 'parcours : une règle qui échoue sur un code fait tomber l\'audit'),
  dansLigne(AJ, "cause: profond ? 'profondeur' : 'analyse',", "profond ? 'profondeur' : 'analyse'", "'analyse'", 'parcours : un parcours qui déborde la pile est dit une erreur d\'analyse'),
  dansLigne(AJ, "cause: profond ? 'profondeur' : 'analyse',", "profond ? 'profondeur' : 'analyse'", "'profondeur'", 'parcours : une règle qui échoue est dite un débordement de pile'),
  dansLigne(AJ, 'const messageDErreur = (e) =>', "e?.name ?? 'Error'", "'Error'", 'parcours : l\'erreur d\'une règle ne dit pas son type'),
  dansLigne(AJ, 'const messageDErreur = (e) =>', '.slice(0, 200)', '.slice(0, 2000)', 'parcours : le message d\'une erreur est dit en entier'),
  dansLigne(AJ, 'const messageDErreur = (e) =>', '.slice(0, 200)', '.slice(0, 20)', 'parcours : le message d\'une erreur est coupé à vingt caractères'),
  dansLigne(AJ, 'export function pourChaqueUniteJs(', 'releverDans = contexte', 'releverDans = {}', 'parcours : l\'illisible ne se relève pas dans le contexte de l\'audit'),
  dansLigne(AJ, 'if (echecs?.has(cle)) return', 'if (echecs?.has(cle))', 'if (false)', 'lecture échouée : elle est refaite par chaque règle'),
  brut(AJ, "export function lireUnite(f, u) {\n  const cle = cleDUnite(u);", "export function lireUnite(f, u) {\n  const cle = 'fichier';", 'lecture échouée : un script illisible d\'une page rend illisibles ceux qui le suivent'),
  dansLigne(AJ, 'if (!lecture.ast) {', 'if (!lecture.ast) {', 'if (true) {', 'lecture échouée : une lecture réussie est gardée comme un échec'),

  // Ce qu'une unité est : un fichier JavaScript, un fichier qu'une adresse désigne, une page --------------------------------
  dansLigne(AJ, 'const parSonExtension = EXTENSIONS_JS.includes(fichier.ext);', 'EXTENSIONS_JS.includes(fichier.ext)', 'false', 'unités : un fichier .js n\'est pas du code par son extension'),
  dansLigne(AJ, 'if (parSonExtension || fichier.commeCode) {', ' || fichier.commeCode', '', 'unités : un fichier désigné comme du code par son adresse n\'est pas lu'),
  dansLigne(AJ, 'if (parSonExtension || fichier.commeCode) {', 'fichier.commeCode', "fichier.commeCode === true", 'unités : un fichier que seule une carte d\'import désigne n\'est pas lu'),
  dansLigne(AJ, 'if (parSonExtension || fichier.commeCode) {', 'parSonExtension || fichier.commeCode', 'true', 'unités : tout fichier est lu comme du code'),
  dansLigne(AJ, 'facultative: !parSonExtension && fichier.commeCode', '!parSonExtension && ', '', 'unités : un .js que la carte d\'import désigne est facultatif'),
  dansLigne(AJ, 'facultative: !parSonExtension && fichier.commeCode', "!parSonExtension && fichier.commeCode === 'probable'", 'false', 'unités : un fichier que la carte d\'import désigne n\'est jamais facultatif'),
  dansLigne(AJ, 'facultative: !parSonExtension && fichier.commeCode', "fichier.commeCode === 'probable'", 'true', 'unités : tout fichier désigné par son adresse est facultatif'),
  dansLigne(AJ, 'finLigne: estPage ? (fichier.lignes?.length', "estPage ? (fichier.lignes?.length ?? fichier.contenu.split('\\n').length) : Infinity", 'Infinity', 'unités : une page désignée comme du code n\'a pas de dernière ligne'),

  // Le JSON valide n'exécute rien ; une adresse désigne du code quelle que soit l'extension ------------------------------
  dansLigne(I, 'f.commeCode = designe && estJsonValide(f.contenu) ? false : designe;', 'designe && estJsonValide(f.contenu) ? false : designe', 'designe', 'désignation : du JSON valide désigné par une adresse est du code'),
  dansLigne(I, 'f.commeCode = designe && estJsonValide(f.contenu) ? false : designe;', 'designe && estJsonValide(f.contenu) ? false : designe', 'false', 'désignation : aucun fichier n\'est du code par son adresse'),
  dansLigne(I, 'try { JSON.parse(texte); return true; } catch { return false; }', 'return true; } catch', 'return false; } catch', 'JSON valide : aucun texte n\'est du JSON'),
  dansLigne(I, 'try { JSON.parse(texte); return true; } catch { return false; }', 'catch { return false; }', 'catch { return true; }', 'JSON valide : tout texte en est'),
  dansLigne(I, 'const rang = (designe) =>', "designe === true ? 2 : designe === 'probable' ? 1 : 0", "designe === true ? 1 : designe === 'probable' ? 2 : 0", 'désignation : la carte d\'import l\'emporte sur la balise ou l\'import écrit'),
  dansLigne(I, 'if (commeCode && designe && rang(designe)', 'rang(designe) > rang(designes.get(chemin))', 'true', 'désignation : la dernière adresse qui désigne un fichier l\'emporte'),
  dansLigne(I, 'else if (vus.has(chemin) && rang(designes.get(chemin))', 'else if (vus.has(chemin) && rang(designes.get(chemin)) > rang(parcourusComme.get(chemin))) file.push(chemin);', '', 'désignation : un fichier déjà parcouru n\'est pas relu quand une adresse le désigne comme du code'),
  dansLigne(I, 'const comme = designes.get(rel) ?? false;', 'designes.get(rel) ?? false', 'false', 'désignation : les références d\'un fichier désigné ne se lisent pas comme celles d\'un code'),
  dansLigne(I, 'const cle = commeCode ?', '${rel}\\0${commeCode}', '${rel}', 'arêtes : un fichier lu comme code et lu comme autre chose partagent leurs arêtes'),
  dansLigne(I, 'const ambigu = objet && Boolean(ref.ambigu);', 'objet && Boolean(ref.ambigu)', 'false', 'carte d\'import : ce qu\'elle désigne l\'est avec certitude'),
  dansLigne(I, 'mettre(arete.cible, arete.commeCode, arete.commeCode ?', "arete.commeCode ? (arete.ambigu ? 'probable' : true) : false", 'arete.commeCode ? true : false', 'carte d\'import : ce qu\'elle désigne n\'est jamais que probable'),
  dansLigne(I, "e.dansTemplate, seulementStandard: e.seulementStandard, position: e.index, commeCode: true, ambigu: true }", 'ambigu: true', 'ambigu: false', 'carte d\'import : les arêtes qu\'elle donne ne sont pas ambiguës'),
  dansLigne(I, 'if (parSonExtension || commeCode === true || lecture.ast) {', ' || lecture.ast', '', 'références : un fichier que la carte désigne et qui se lit comme du JavaScript n\'est pas suivi'),
  dansLigne(I, 'if (parSonExtension || commeCode === true || lecture.ast) {', ' || lecture.ast', ' || commeCode', 'références : un fichier que la carte désigne est suivi même s\'il ne se lit pas comme du JavaScript'),
  dansLigne(I, 'if (parSonExtension || commeCode === true || lecture.ast) {', 'commeCode === true || ', '', 'références : un fichier qu\'une balise désigne n\'est pas suivi comme du code'),
  dansLigne(I, 'const deDonnees = importDeDonnees(n.attributes);', 'importDeDonnees(n.attributes)', 'false', 'import de données : un import avec `with { type }` est du code'),
  dansLigne(I, 'const deDonnees = importDeDonnees(n.options);', 'importDeDonnees(n.options)', 'false', 'import de données : un import() avec `with { type }` est du code'),
  dansLigne(I, "const TYPES_D_IMPORT_DE_DONNEES = new Set(['json', 'css', 'bytes', 'text']);", "'css', ", '', 'import de données : une feuille de style importée est du code'),
  dansLigne(I, "const TYPES_D_IMPORT_DE_DONNEES = new Set(['json', 'css', 'bytes', 'text']);", "'json', ", '', 'import de données : un JSON importé est du code'),
  dansLigne(I, "const TYPES_D_IMPORT_DE_DONNEES = new Set(['json', 'css', 'bytes', 'text']);", ", 'bytes'", '', 'import de données : des octets importés sont du code'),
  dansLigne(I, "const TYPES_D_IMPORT_DE_DONNEES = new Set(['json', 'css', 'bytes', 'text']);", ", 'text'", '', 'import de données : un texte importé est du code'),
  dansLigne(I, 'noterParcoursEchoue(f, unite, e);', 'noterParcoursEchoue(f, unite, e);', 'throw e;', 'références : un arbre que le parcours ne porte pas fait tomber l\'audit'),
  brut(I, "      noterParcoursEchoue(f, unite, e);\n      parExpressionsRegulieres();\n", "      noterParcoursEchoue(f, unite, e);\n", 'références : un arbre que le parcours ne porte pas ne donne aucune référence'),

  // Le constat critique et bloquant par fichier illisible ---------------------------------------------------------------------
  dansLigne(T, 'constats.push(...analyserIllisibles(ctx));', 'constats.push(...analyserIllisibles(ctx));', '', 'C-SURFACE-03 : le code illisible n\'est pas dit'),
  dansLigne(IL, "const tous = [...(ctx.illisibles?.values() ?? [])]", "(ctx.illisibles?.values() ?? [])", '[]', 'C-SURFACE-03 : aucun illisible n\'est relevé'),
  dansLigne(IL, 'const tous = [...(ctx.illisibles?.values() ?? [])].sort(', 'a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 :', 'a.chemin < b.chemin ? 1 : a.chemin > b.chemin ? -1 :', 'C-SURFACE-03 : les codes illisibles se disent par chemin décroissant'),
  dansLigne(IL, 'const tous = [...(ctx.illisibles?.values() ?? [])].sort(', '(a.ligne ?? 0) - (b.ligne ?? 0)', '(b.ligne ?? 0) - (a.ligne ?? 0)', 'C-SURFACE-03 : les scripts illisibles d\'une page se disent du dernier au premier'),
  dansLigne(IL, 'const code = tous.filter((n) => n.surface && !n.facultative);', ' && !n.facultative', '', 'C-SURFACE-03 : un fichier que seule une carte d\'import désigne bloque'),
  dansLigne(IL, 'const code = tous.filter((n) => n.surface && !n.facultative);', 'n.surface && !n.facultative', 'true', 'C-SURFACE-03 : un fichier que rien n\'exécute bloque'),
  dansLigne(IL, 'const probables = tous.filter((n) => n.facultative);', 'n.facultative', 'false', 'C-SURFACE-03 : un fichier que la carte d\'import désigne n\'est pas dit'),
  brut(IL, "  for (const n of code.slice(0, MAX_FICHIERS_DITS)) {\n    const cause = CAUSES_ILLISIBLE[n.cause];", "  for (const n of code.slice(0, MAX_FICHIERS_DITS + 1)) {\n    const cause = CAUSES_ILLISIBLE[n.cause];", 'C-SURFACE-03 : cinquante et un codes illisibles sont dits un à un'),
  brut(IL, "  for (const n of code.slice(0, MAX_FICHIERS_DITS)) {\n    const cause = CAUSES_ILLISIBLE[n.cause];", "  for (const n of code.slice(1, MAX_FICHIERS_DITS)) {\n    const cause = CAUSES_ILLISIBLE[n.cause];", 'C-SURFACE-03 : le premier code illisible n\'est pas dit un à un'),
  brut(IL, "  if (code.length > MAX_FICHIERS_DITS) {\n    const reste = code.slice(MAX_FICHIERS_DITS);\n    const axes = TOUS_LES_AXES_STATIQUES", "  if (code.length >= MAX_FICHIERS_DITS) {\n    const reste = code.slice(MAX_FICHIERS_DITS);\n    const axes = TOUS_LES_AXES_STATIQUES", 'C-SURFACE-03 : cinquante codes illisibles font un groupe'),
  brut(IL, "  if (code.length > MAX_FICHIERS_DITS) {\n    const reste = code.slice(MAX_FICHIERS_DITS);\n    const axes = TOUS_LES_AXES_STATIQUES", "  if (code.length > MAX_FICHIERS_DITS) {\n    const reste = code.slice(MAX_FICHIERS_DITS + 1);\n    const axes = TOUS_LES_AXES_STATIQUES", 'C-SURFACE-03 : le groupe ne nomme pas le premier des autres'),
  dansLigne(IL, 'const axes = TOUS_LES_AXES_STATIQUES.filter((a) => reste.some(', 'reste.some', 'reste.every', 'C-SURFACE-03 : le groupe ne dit les axes que si tout ce qu\'il regroupe les empêche'),
  dansLigne(IL, 'const axes = TOUS_LES_AXES_STATIQUES.filter((a) => reste.some(', '(a) => reste.some((n) => axesDUnFichierNonLu(n).includes(a))', '() => true', 'C-SURFACE-03 : le groupe empêche tous les axes'),
  brut(IL, "      regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',\n      titre: n.inline ?", "      regle: 'C-SURFACE-03', axe: 'C', severite: 'majeur', bloquant: true, confiance: 'certain',\n      titre: n.inline ?", 'C-SURFACE-03 : un code illisible n\'est que majeur'),
  brut(IL, "      regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',\n      titre: n.inline ?", "      regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'probable',\n      titre: n.inline ?", 'C-SURFACE-03 : un code illisible est dit probable'),
  brut(IL, "      regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',\n      titre: reste.length === 1 ?", "      regle: 'C-SURFACE-03', axe: 'C', severite: 'majeur', bloquant: true, confiance: 'certain',\n      titre: reste.length === 1 ?", 'C-SURFACE-03 : le groupe des autres codes illisibles n\'est que majeur'),
  brut(IL, "      regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',\n      titre: reste.length === 1 ?", "      regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'probable',\n      titre: reste.length === 1 ?", 'C-SURFACE-03 : le groupe des autres codes illisibles est dit probable'),
  dansLigne(IL, "titre: n.inline ? 'Script de la page que l\\'outil ne sait pas lire'", 'n.inline ?', 'false ?', 'C-SURFACE-03 : un script de page est dit fichier'),
  dansLigne(IL, "titre: n.inline ? 'Script de la page que l\\'outil ne sait pas lire'", 'n.inline ?', 'true ?', 'C-SURFACE-03 : un fichier est dit script de page'),
  dansLigne(IL, 'fichier: n.chemin, ...(n.ligne ? { ligne: n.ligne } : {}),', '...(n.ligne ? { ligne: n.ligne } : {})', '...{}', 'C-SURFACE-03 : la ligne n\'est pas dite'),
  brut(IL, "      axesEmpeches: axesDUnFichierNonLu(n),\n      preuve: { cause: n.cause, message:", "      axesEmpeches: TOUS_LES_AXES_STATIQUES,\n      preuve: { cause: n.cause, message:", 'C-SURFACE-03 : un code illisible de bibliothèque tierce empêche A'),
  brut(IL, "      axesEmpeches: axesDUnFichierNonLu(n),\n      preuve: { cause: n.cause, message:", "      axesEmpeches: ['B', 'C', 'E', 'F'],\n      preuve: { cause: n.cause, message:", 'C-SURFACE-03 : un code illisible du contributeur n\'empêche pas A'),
  brut(IL, "      axesEmpeches: axesDUnFichierNonLu(n),\n      preuve: { cause: n.cause, message:", "      axesEmpeches: [],\n      preuve: { cause: n.cause, message:", 'C-SURFACE-03 : un code illisible n\'empêche aucun axe'),
  dansLigne(IL, 'preuve: { cause: n.cause, message: n.message, etape: n.etape,', 'cause: n.cause, ', '', 'C-SURFACE-03 : la preuve ne dit pas la cause'),
  dansLigne(IL, "titre: reste.length === 1 ? '1 autre code que l\\'outil ne sait pas lire'", 'reste.length === 1', 'false', 'C-SURFACE-03 : un seul autre code illisible est dit au pluriel'),
  dansLigne(IL, "titre: reste.length === 1 ? '1 autre code que l\\'outil ne sait pas lire'", 'reste.length === 1', 'true', 'C-SURFACE-03 : plusieurs autres codes illisibles sont dits au singulier'),
  dansLigne(IL, 'preuve: { emplacements: reste.map((n) => ({ fichier: n.chemin, ligne: n.ligne, cause: n.cause, message: n.message', 'reste.map', 'code.map', 'C-SURFACE-03 : la preuve du groupe nomme aussi ceux qui sont dits un à un'),
  // Les deux informations groupées : ce que rien n'exécute, ce que seule une carte d'import désigne (une ligne `severite: 'info'` chacune, distinguée par celle qui suit).
  brut(IL, "      regle: 'C-SURFACE-03', axe: 'C', severite: 'info', confiance: 'certain',\n      titre: probables.length === 1 ?", "      regle: 'C-SURFACE-03', axe: 'C', severite: 'mineur', confiance: 'certain',\n      titre: probables.length === 1 ?", 'C-SURFACE-03 : un fichier que seule la carte d\'import désigne est un constat mineur'),
  brut(IL, "      regle: 'C-SURFACE-03', axe: 'C', severite: 'info', confiance: 'certain',\n      titre: `${nombre(hors.length)} fichier(s) que l'analyse", "      regle: 'C-SURFACE-03', axe: 'C', severite: 'mineur', confiance: 'certain',\n      titre: `${nombre(hors.length)} fichier(s) que l'analyse", 'C-SURFACE-03 : un fichier que rien n\'exécute est un constat mineur'),
  dansLigne(IL, "titre: probables.length === 1 ?", 'probables.length === 1', 'false', 'C-SURFACE-03 : un seul fichier désigné par la carte est dit au pluriel'),
  dansLigne(IL, "titre: probables.length === 1 ?", 'probables.length === 1', 'true', 'C-SURFACE-03 : plusieurs fichiers désignés par la carte sont dits au singulier'),
  dansLigne(IL, 'if (probables.length) {', 'probables.length', 'false', 'C-SURFACE-03 : les fichiers que la carte désigne ne sont pas dits'),
  brut(IL, "  if (hors.length) {\n    constats.push(constat({\n      regle: 'C-SURFACE-03'", "  if (false) {\n    constats.push(constat({\n      regle: 'C-SURFACE-03'", 'C-SURFACE-03 : les fichiers que rien n\'exécute ne sont pas dits'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests du code illisible', fichiers: TESTS }],
  exigerChromium: false,
  partie,
});
