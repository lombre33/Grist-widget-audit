#!/usr/bin/env node
/**
 * Rejoue les mutants de ce que l'audit fait d'une lecture qui lève (`tests/lecture-qui-leve.test.mjs`), du lecteur d'acorn quand la pile
 * déborde (`tests/abandon-de-pile.test.mjs`) et du script qui rejoue, lancement après lancement, l'audit d'un fichier trop profond
 * (`tests/rejouer-fichier-profond.test.mjs`). Le premier essai force la lecture d'acorn à lever un dépassement de pile : chaque mutant
 * des sources pose le défaut qui faisait conclure « conforme sous réserve » d'un fichier que l'outil n'avait pas lu (la lecture qui
 * échoue n'est pas relevée, n'est pas dite, interrompt le parcours des autres fichiers, ne bloque pas, n'empêche aucun axe, n'est pas
 * notée 0). Le deuxième éprouve `LecteurAcorn`, qui rattrape la pile sans expression régulière : ce qu'il fait de chaque erreur (dans le
 * processus) et que le code réellement trop profond n'arrête plus le processus (dans un processus neuf par lecture : le mutant qui rend
 * à `lire` le lecteur d'origine est tué par l'abandon de V8, que l'essai voit comme un signal, non par un délai). Le troisième éprouve
 * ce que le script juge (silence, abandon, plantage, délai, sortie inconnue), comment il lance l'audit (fil principal ou Worker, pile,
 * options), ce qu'il compte et ce que sa ligne de commande refuse. Chaque mutant pose, sur la ligne qui porte le choix, le défaut
 * plausible : un des essais doit alors échouer (méthode : `scripts/lib/rejouer-mutants.mjs`). Aucun navigateur n'est requis ; `bin/`
 * est copié avec le reste parce que deux essais lancent l'audit pour de vrai.
 *
 * Mutants équivalents, non posés : `fs.rmSync(erreurs, { force: true })` de `lancer` retiré (le dossier temporaire du rejeu est supprimé en entier à la fin) ;
 * `includes('call stack')` réduit à `includes('stack')` dans `estPileDeV8` (la phrase est celle de V8, que
 * l'essai prend dans le processus même ; seul un message inventé pour l'occasion distinguerait les deux) ; `String(e.message)` réduit à
 * `e.message` (le message d'une erreur de V8 est toujours une chaîne).
 *
 * Usage : node scripts/mutants-lecture-qui-leve.mjs [expression régulière sur le libellé] [--part=i/n] [--valider]
 */
import { lireArguments, rejouerMutants, dansLigne, DOSSIERS_COPIES } from './lib/rejouer-mutants.mjs';

const AJ = 'src/moteur/analyse-js.js';
const IL = 'src/regles/c-illisibles.js';
const CS = 'src/regles/c-surface.js';
const N = 'src/moteur/notation.js';
const T = 'src/moteur/statique.js';
const SC = 'scripts/rejouer-fichier-profond.mjs';

/** Une chaîne qui s'étend sur plusieurs lignes : `[fichier, chaîne d'origine, chaîne mutée, libellé]`. */
const brut = (fichier, ancien, nouveau, libelle) => [fichier, ancien, nouveau, libelle];

const CONSTAT_CRITIQUE = "      regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',\n      titre: n.inline ?";

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // La lecture qui lève : ce qu'elle dit, et qu'acorn l'a bien tentée -----------------------------------------------------------
  dansLigne(AJ, 'export const depassementDePile', '(e instanceof RangeError && /call stack/i.test(String(e.message))) || ', '', 'lecture qui lève : le RangeError de V8 n\'est plus un dépassement de pile'),
  dansLigne(AJ, 'export const depassementDePile', ' || (e instanceof SyntaxError && /not enough stack space/i.test(String(e.message)))', '', 'lecture qui lève : l\'erreur que la lecture d\'acorn en fait n\'est plus un dépassement de pile'),
  dansLigne(AJ, "cause: profond ? 'profondeur' : syntaxe ?", "profond ? 'profondeur' :", "profond ? 'syntaxe' :", 'lecture qui lève : un dépassement de pile est dit de syntaxe'),
  dansLigne(AJ, "message: profond ? 'la pile déborde' : syntaxe ?", "profond ? 'la pile déborde' : ", '', 'lecture qui lève : la raison d\'un dépassement de pile est le message de l\'erreur levée'),
  dansLigne(AJ, 'const lecture = tenter(source, sourceType);', 'tenter(source, sourceType)', "{ ast: null, erreur: { cause: 'profondeur', message: 'la pile déborde', ligne: null, colonne: null, position: null } }", 'lecture qui lève : la pile est dite déborder sans qu\'acorn ait lu'),
  brut(AJ, '  } catch (e) {\n    return { ast: null, erreur: erreurDeLecture(e) };', '  } catch (e) {\n    if (!depassementDePile(e) && !(e instanceof SyntaxError)) throw e;\n    return { ast: null, erreur: erreurDeLecture(e) };', 'lecture qui lève : une erreur qui n\'est ni de syntaxe ni un dépassement de pile fait tomber l\'audit'),

  // Le lecteur d'acorn : la pile qui déborde est rattrapée sans expression régulière, et ne fait jamais abandonner le processus ----
  dansLigne(AJ, 'const ast = LecteurAcorn.parse(source', 'LecteurAcorn.parse', 'Parser.parse', 'lecteur : `lire` lit par le lecteur d\'origine d\'acorn, dont le rattrapage compile une expression régulière au bord de la pile'),
  dansLigne(AJ, 'export const estPileDeV8', 'e instanceof RangeError && ', '', 'lecteur : toute erreur dont le message dit « call stack » est une pile qui déborde'),
  dansLigne(AJ, 'export const estPileDeV8', " && String(e.message).includes('call stack')", '', 'lecteur : tout RangeError est une pile qui déborde'),
  dansLigne(AJ, 'if (!estPileDeV8(e)) throw e;', '!estPileDeV8(e)', 'false', 'lecteur : toute erreur devient une pile qui déborde'),
  dansLigne(AJ, 'if (!estPileDeV8(e)) throw e;', '!estPileDeV8(e)', 'true', 'lecteur : le lecteur ne rattrape plus la pile, le RangeError traverse les cadres d\'acorn'),
  dansLigne(AJ, 'if (!estPileDeV8(e)) throw e;', '!estPileDeV8(e)', '!depassementDePile(e)', 'lecteur : la pile est jugée par l\'expression régulière de `depassementDePile`, compilée au bord de la pile'),
  dansLigne(AJ, 'const erreur = new SyntaxError(', 'Not enough stack space to parse input', 'Unexpected end of input', 'lecteur : la pile qui déborde est dite autrement qu\'acorn ne la dit'),
  dansLigne(AJ, 'const erreur = new SyntaxError(', "${loc ? ` (${loc.line}:${loc.column})` : ''}", '', 'lecteur : l\'erreur de pile ne dit pas la ligne et la colonne dans son message'),
  dansLigne(AJ, 'const erreur = new SyntaxError(', "loc ? ` (${loc.line}:${loc.column})` : ''", '` (${loc.line}:${loc.column})`', 'lecteur : sans positions demandées, le rattrapage de la pile lève une TypeError'),
  dansLigne(AJ, 'const erreur = new SyntaxError(', 'loc.line}:${loc.column', 'loc.column}:${loc.line', 'lecteur : la colonne et la ligne sont échangées dans le message de l\'erreur de pile'),
  dansLigne(AJ, 'erreur.pos = this.start;', 'this.start', 'this.pos', 'lecteur : l\'erreur de pile dit où la lecture en était, non le jeton courant'),
  dansLigne(AJ, 'erreur.pos = this.start;', 'this.start', '0', 'lecteur : l\'erreur de pile dit la position 0'),
  dansLigne(AJ, 'erreur.loc = loc;', '= loc;', '= null;', 'lecteur : l\'erreur de pile ne dit ni ligne ni colonne'),
  dansLigne(AJ, 'erreur.raisedAt = this.pos;', 'this.pos', 'this.start', 'lecteur : l\'erreur de pile ne dit pas où la lecture en était'),
  dansLigne(AJ, 'const loc = this.startLoc;', 'this.startLoc', 'this.endLoc', 'lecteur : la ligne et la colonne de l\'erreur de pile sont celles de la fin du jeton'),
  dansLigne(AJ, 'return f();', 'return f();', 'f();', 'lecteur : un rattrapage qui réussit ne rend pas la valeur de la lecture'),
  dansLigne(AJ, 'catchStackOverflow(f) {', 'catchStackOverflow(f)', 'catchStackOverflowPlus(f)', 'lecteur : le lecteur ne redéfinit pas le rattrapage d\'acorn, qui compile son expression régulière au bord de la pile'),

  // Ce que la lecture qui a échoué devient : relevée, sans arrêter le parcours des autres fichiers -------------------------------
  dansLigne(AJ, 'if (f.executee) noterIllisible(releves, f, u,', 'if (f.executee)', 'if (false)', 'lecture qui lève : le code exécuté que la lecture refuse n\'est jamais relevé'),
  brut(AJ, "      noterLectureRefusee(releverDans, f, u, erreur);\n      continue;", "      noterLectureRefusee(releverDans, f, u, erreur);\n      return;", 'lecture qui lève : le premier code illisible interrompt le parcours des autres fichiers'),
  dansLigne(AJ, "const cle = `${f.chemin}\\0${cleDUnite(u)}`;", "cleDUnite(u)}`", "cleDUnite(u)}${liste.size}`", 'lecture qui lève : chaque règle qui rencontre le fichier le relève de nouveau'),

  // Le constat, et ce qu'il empêche --------------------------------------------------------------------------------------------
  dansLigne(T, 'constats.push(...analyserIllisibles(ctx));', 'constats.push(...analyserIllisibles(ctx));', '', 'lecture qui lève : les codes illisibles ne sont pas dits par l\'analyse statique'),
  brut(IL, CONSTAT_CRITIQUE, CONSTAT_CRITIQUE.replace("severite: 'critique'", "severite: 'majeur'"), 'lecture qui lève : un code illisible n\'est que majeur'),
  brut(IL, CONSTAT_CRITIQUE, CONSTAT_CRITIQUE.replace('bloquant: true', 'bloquant: false'), 'lecture qui lève : un code illisible ne bloque pas'),
  dansLigne(IL, 'axesEmpeches: axesDUnFichierNonLu(n),', 'axesDUnFichierNonLu(n)', '[]', 'lecture qui lève : un code illisible n\'empêche aucun axe'),
  dansLigne(CS, '!n.dossierExclu && !cheminVendorise(n.chemin) ? TOUS_LES_AXES_STATIQUES : AXES_DU_CODE_EXECUTE', 'TOUS_LES_AXES_STATIQUES :', 'AXES_DU_CODE_EXECUTE :', 'lecture qui lève : un code illisible du contributeur n\'empêche pas A'),
  dansLigne(IL, 'preuve: { cause: n.cause, message: n.message, etape: n.etape,', 'cause: n.cause, ', '', 'lecture qui lève : la preuve ne dit pas la cause'),
  dansLigne(IL, "return `${debut}. S'il s'exécute dans le navigateur, aucune règle ne l'a lu.`;", "aucune règle ne l'a lu", 'ce que les règles en disent est incomplet', 'lecture qui lève : l\'erreur de l\'outil est dite « incomplet », alors qu\'aucune règle n\'a eu d\'arbre'),
  dansLigne(N, 'for (const code of c.axesEmpeches ?? []) {', 'c.axesEmpeches ?? []', '[]', 'lecture qui lève : la notation ne lit pas les axes qu\'un constat empêche'),
  brut(N, '        scoreMesure: parAxe[code].score,\n        score: 0,', '        scoreMesure: parAxe[code].score,\n        score: parAxe[code].score,', 'lecture qui lève : un axe empêché garde sa note'),

  // Le script de rejeu : le fichier, ce que le rapport dit, ce que chaque fin de lancement est ----------------------------------
  dansLigne(SC, 'export const fichierProfond', "'}'.repeat(niveaux)", "'}'.repeat(niveaux - 1)", 'rejeu : le fichier a une accolade fermante de moins que de niveaux'),
  dansLigne(SC, 'export const fichierProfond', "'x=>{'.repeat(niveaux)", "'x=>{'.repeat(niveaux + 1)", 'rejeu : le fichier a un niveau de plus que demandé'),
  dansLigne(SC, "c.regle === 'C-SURFACE-03'", "c.regle === 'C-SURFACE-03' && ", '', 'rejeu : tout constat critique et bloquant dit un code illisible'),
  dansLigne(SC, "c.regle === 'C-SURFACE-03'", " && c.severite === 'critique'", '', 'rejeu : l\'information d\'un fichier non exécuté dit un code illisible'),
  dansLigne(SC, "c.regle === 'C-SURFACE-03'", ' && c.bloquant === true', '', 'rejeu : un C-SURFACE-03 qui ne bloque pas dit un code illisible'),
  dansLigne(SC, "c.regle === 'C-SURFACE-03'", 'Object.values(rapport?.axes ?? {})', '[rapport?.axes?.C ?? {}]', 'rejeu : seul l\'axe C dit un code illisible'),
  dansLigne(SC, "c.regle === 'C-SURFACE-03'", '(axe.constats ?? [])', 'axe.constats', 'rejeu : un axe sans constats fait tomber le jugement'),
  dansLigne(SC, "c.regle === 'C-SURFACE-03'", 'rapport?.axes ?? {}', 'rapport.axes ?? {}', 'rejeu : l\'absence de rapport fait tomber le jugement'),

  // Le témoin : planté au cœur du fichier, et cherché dans le rapport
  dansLigne(SC, 'export const fichierProfond', " + APPEL_TEMOIN + ", " + '' + ", 'rejeu : le fichier ne porte pas le témoin'),
  dansLigne(SC, 'const APPEL_TEMOIN', 'fetch(', 'fetsh(', 'rejeu : le témoin n\'est pas un appel réseau'),
  dansLigne(SC, 'const APPEL_TEMOIN', 'https://', 'http://', 'rejeu : le témoin appelle une adresse sans protocole sûr'),
  dansLigne(SC, 'export const TEMOIN', "'temoin-rejeu.invalid'", "'localhost'", 'rejeu : le témoin est l\'hôte local, que C-EXFIL-01 ne dit pas'),
  dansLigne(SC, 'export const TEMOIN', "'temoin-rejeu.invalid'", "'temoin-rejeu.example.org'", 'rejeu : le témoin est un domaine qui peut résoudre'),
  dansLigne(SC, "c.regle === 'C-EXFIL-01'", "c.regle === 'C-EXFIL-01' && ", '', 'rejeu : tout constat qui nomme l\'hôte du témoin le prouve'),
  dansLigne(SC, "c.regle === 'C-EXFIL-01'", " && JSON.stringify(c).includes(TEMOIN)", '', 'rejeu : tout C-EXFIL-01 prouve le témoin, quel que soit son hôte'),
  dansLigne(SC, "c.regle === 'C-EXFIL-01'", 'JSON.stringify(c).includes(TEMOIN)', 'String(c.titre).includes(TEMOIN)', 'rejeu : le témoin n\'est cherché que dans le titre du constat'),
  dansLigne(SC, "c.regle === 'C-EXFIL-01'", 'Object.values(rapport?.axes ?? {})', '[rapport?.axes?.C ?? {}]', 'rejeu : seul l\'axe C porte le témoin'),
  dansLigne(SC, "c.regle === 'C-EXFIL-01'", '(axe.constats ?? [])', 'axe.constats', 'rejeu : un axe sans constats fait tomber la recherche du témoin'),
  dansLigne(SC, "c.regle === 'C-EXFIL-01'", 'rapport?.axes ?? {}', 'rapport.axes ?? {}', 'rejeu : l\'absence de rapport fait tomber la recherche du témoin'),
  dansLigne(SC, "if (delai) return 'delai';", 'if (delai)', 'if (false)', 'rejeu : un lancement qui n\'a pas fini à temps est un abandon'),
  dansLigne(SC, 'if (signal || status === null', 'status === null || ', '', 'rejeu : un lancement sans code de sortie ni signal n\'est pas un abandon'),
  dansLigne(SC, 'if (signal || status === null', 'status >= 128', 'status > 128', 'rejeu : le code 128 n\'est pas un abandon'),
  dansLigne(SC, 'if (signal || status === null', 'status >= 128', 'status >= 97', 'rejeu : l\'erreur du Worker (97) est un abandon'),
  dansLigne(SC, 'if (status === 3)', 'status === 3', 'status === 4', 'rejeu : la sortie 4 est un plantage, la 3 n\'en est plus un'),
  dansLigne(SC, 'if (status === 3)', "return 'plantage'", "return 'autre'", 'rejeu : une sortie 3 est une sortie inconnue'),
  dansLigne(SC, '![0, 1, 2].includes(status)', '[0, 1, 2]', '[0, 1]', 'rejeu : la sortie 2 (NON CONFORME) est une sortie inconnue'),
  dansLigne(SC, '![0, 1, 2].includes(status)', '[0, 1, 2]', '[0, 1, 2, 4]', 'rejeu : la sortie 4 (cible refusée) est une fin connue'),
  dansLigne(SC, '![0, 1, 2].includes(status)', ' || !rapport', '', 'rejeu : l\'absence de rapport n\'est pas une sortie inconnue'),
  dansLigne(SC, "if (diraitIllisible(rapport)) return 'dit';", 'diraitIllisible(rapport)', 'false', 'rejeu : un C-SURFACE-03 bloquant n\'est jamais dit'),
  dansLigne(SC, "return aVuLeTemoin(rapport) ? 'lu' : 'silence';", 'aVuLeTemoin(rapport)', 'true', 'rejeu : tout rapport sans C-SURFACE-03 est lu, même celui qui n\'a pas le témoin (le silence sous 10 000 niveaux)'),
  dansLigne(SC, "return aVuLeTemoin(rapport) ? 'lu' : 'silence';", 'aVuLeTemoin(rapport)', 'false', 'rejeu : tout rapport sans C-SURFACE-03 est un silence, même celui qui a le témoin'),
  dansLigne(SC, "return aVuLeTemoin(rapport) ? 'lu' : 'silence';", "'lu' : 'silence'", "'silence' : 'lu'", 'rejeu : le silence et la lecture sont échangés'),

  // Le script de rejeu : ce qui est interdit, ce qui se compte, comment l'audit est lancé ---------------------------------------
  dansLigne(SC, 'const INTERDITES', "'silence', ", '', 'rejeu : le silence n\'est plus interdit'),
  dansLigne(SC, 'const INTERDITES', "'plantage', ", '', 'rejeu : le plantage n\'est plus interdit'),
  dansLigne(SC, 'const INTERDITES', "'autre', ", '', 'rejeu : la sortie inconnue n\'est plus interdite'),
  dansLigne(SC, 'const INTERDITES', ", 'delai'", '', 'rejeu : le délai n\'est plus interdit'),
  dansLigne(SC, 'const INTERDITES', "'delai']", "'delai', 'abandon']", 'rejeu : l\'abandon de V8 est interdit'),
  dansLigne(SC, 'const INTERDITES', "'delai']", "'delai', 'lu']", 'rejeu : lire le code est interdit'),
  dansLigne(SC, 'const FINS', "'plantage', 'autre'", "'autre', 'plantage'", 'rejeu : le plantage et la sortie inconnue sont échangés'),
  dansLigne(SC, 'const w = new Worker(pathToFileURL(bin)', 'Number(pile) ? { stackSizeMb: Number(pile) } : {}', '{}', 'rejeu : la pile demandée au Worker n\'est pas appliquée'),
  dansLigne(SC, 'const w = new Worker(pathToFileURL(bin)', 'argv: args', 'argv: []', 'rejeu : le Worker ne reçoit pas les arguments de l\'audit'),
  dansLigne(SC, "w.on('exit'", 'if (!process.exitCode) process.exitCode = code;', '', 'rejeu : le code de sortie du Worker est perdu'),
  dansLigne(SC, 'const options = [widget', "'--sans-dynamique', ", '', 'rejeu : l\'audit lance le navigateur'),
  dansLigne(SC, 'const options = [widget', "'--sans-reseau', ", '', 'rejeu : l\'audit a le réseau'),
  dansLigne(SC, 'const options = [widget', "'--sans-html', ", '', 'rejeu : l\'audit écrit la page HTML'),
  dansLigne(SC, 'const options = [widget', "'--json', ", '', 'rejeu : l\'audit n\'écrit pas le rapport JSON'),
  dansLigne(SC, "const args = regime === 'worker'", "regime === 'worker'", 'false', 'rejeu : le régime Worker tourne dans le fil principal'),
  dansLigne(SC, "const args = regime === 'worker'", 'String(pileMb ?? 0)', "'0'", 'rejeu : la pile demandée n\'est pas transmise à l\'enveloppe'),
  dansLigne(SC, "path.join(sortie, 'rapport.json')", "'rapport.json'", "'rapports.json'", 'rejeu : le rapport est cherché sous un autre nom'),
  dansLigne(SC, "delai: r.error?.code === 'ETIMEDOUT'", "r.error?.code === 'ETIMEDOUT'", 'false', 'rejeu : le délai n\'est jamais reconnu'),
  dansLigne(SC, "fs.writeFileSync(path.join(dossier, 'app.js')", 'fichierProfond(n)', 'fichierProfond(n + 1)', 'rejeu : le fichier écrit a un niveau de plus'),
  dansLigne(SC, "fs.writeFileSync(path.join(dossier, 'app.js')", "'app.js'", "'autre.js'", 'rejeu : le fichier profond n\'est pas celui de la page'),
  dansLigne(SC, 'for (let k = 1; k <= essais; k++) {', 'k <= essais', 'k < essais', 'rejeu : un lancement de moins que demandé'),
  brut(SC, '      for (let k = 1; k <= essais; k++) {\n        for (const arbre of arbres) {', '      for (const arbre of arbres) {\n        for (let k = 1; k <= essais; k++) {', 'rejeu : tous les lancements d\'un arbre avant ceux de l\'autre'),
  dansLigne(SC, 'const compte = parArbre.get(arbre);', 'parArbre.get(arbre)', 'parArbre.get(arbres[0])', 'rejeu : tous les lancements sont comptés au premier arbre'),
  dansLigne(SC, 'lignes.push({ arbre, niveaux: n, essais,', 'niveaux: n', 'niveaux: 0', 'rejeu : une ligne du tableau ne dit pas son niveau'),
  dansLigne(SC, 'lignes.push({ arbre, niveaux: n, essais,', 'essais,', 'essais: 1,', 'rejeu : une ligne du tableau ne dit pas le nombre de lancements'),
  dansLigne(SC, 'lancer(arbre, widgets.get(arbre), sortie,', '{ regime, pileMb, enveloppe, delaiMs }', '{ regime, enveloppe, delaiMs }', 'rejeu : la pile demandée ne parvient pas au lancement'),
  dansLigne(SC, 'lancer(arbre, widgets.get(arbre), sortie,', '{ regime, pileMb, enveloppe, delaiMs }', '{ pileMb, enveloppe, delaiMs }', 'rejeu : le régime demandé ne parvient pas au lancement'),
  dansLigne(SC, 'const interdites = lignes.reduce(', 'total + [...interdit]', '0 * [...interdit]', 'rejeu : aucune fin n\'est jamais interdite'),
  dansLigne(SC, 'const interdites = lignes.reduce(', '[...interdit]', '[...INTERDITES]', 'rejeu : l\'abandon n\'est jamais interdit, même avec `sansAbandon`'),
  dansLigne(SC, 'const interdit = sansAbandon ?', 'sansAbandon ?', 'false ?', 'rejeu : `sansAbandon` n\'interdit rien de plus'),
  dansLigne(SC, 'const interdit = sansAbandon ?', 'sansAbandon ?', 'true ?', 'rejeu : l\'abandon est toujours interdit'),
  dansLigne(SC, 'const interdit = sansAbandon ?', "[...INTERDITES, 'abandon']", "['abandon']", 'rejeu : avec `sansAbandon`, plus rien d\'autre que l\'abandon n\'est interdit'),
  dansLigne(SC, 'const interdit = sansAbandon ?', "'abandon'", "'lu'", 'rejeu : avec `sansAbandon`, lire le code est interdit, non l\'abandon'),
  dansLigne(SC, 'const interdit = sansAbandon ?', "'abandon'", "'dit'", 'rejeu : avec `sansAbandon`, dire le code illisible est interdit, non l\'abandon'),
  dansLigne(SC, 'const interdit = sansAbandon ?', ': INTERDITES;', ": new Set([...INTERDITES, 'abandon']);", 'rejeu : l\'abandon est interdit même sans `sansAbandon`'),

  // Le tableau ----------------------------------------------------------------------------------------------------------------
  dansLigne(SC, "const sortie = [`${plusieursArbres ?", '| delai`', '`', 'tableau : la colonne des délais n\'a pas de titre'),
  dansLigne(SC, "const sortie = [`${plusieursArbres ?", "plusieursArbres ? 'arbre'.padEnd(28) : ''", "''", 'tableau : le titre de la colonne des arbres manque'),
  dansLigne(SC, 'const nom = plusieursArbres ?', 'plusieursArbres ?', 'false ?', 'tableau : les arbres ne sont pas nommés'),
  dansLigne(SC, 'const nom = plusieursArbres ?', '.slice(0, 27)', '.slice(0, 2)', 'tableau : le nom d\'un arbre est coupé à deux caractères'),

  // La ligne de commande ---------------------------------------------------------------------------------------------------------
  dansLigne(SC, 'const connues = [', "'niveaux', ", '', 'ligne de commande : `--niveaux` est une option inconnue'),
  dansLigne(SC, 'const connues = [', ", 'essais'", '', 'ligne de commande : `--essais` est une option inconnue'),
  dansLigne(SC, 'const connues = [', ", 'regime'", '', 'ligne de commande : `--regime` est une option inconnue'),
  dansLigne(SC, 'const connues = [', ", 'pile-mb'", '', 'ligne de commande : `--pile-mb` est une option inconnue'),
  dansLigne(SC, 'const connues = [', ", 'arbre'", '', 'ligne de commande : `--arbre` est une option inconnue'),
  dansLigne(SC, 'const connues = [', "'arbre']", "'arbre', 'sans-lecture']", 'ligne de commande : `--sans-lecture`, qui n\'existe plus, est acceptée et ignorée'),
  dansLigne(SC, 'const inconnues = args.filter(', 'args.filter(', '[].filter(', 'ligne de commande : une option inconnue passe'),
  dansLigne(SC, 'const fausse = (message) =>', 'process.exit(2)', 'process.exit(1)', 'ligne de commande : une option fausse sort en code 1'),
  dansLigne(SC, "const niveaux = (valeur('niveaux')[0] ??", "'1400,1700,20000'", "'1400,1700,2000'", 'ligne de commande : les niveaux par défaut changent'),
  dansLigne(SC, 'if (!niveaux.length ||', '!Number.isInteger(n) || ', '', 'ligne de commande : un niveau qui n\'est pas un entier passe'),
  dansLigne(SC, 'if (!niveaux.length ||', 'n < 1', 'n < 0', 'ligne de commande : le niveau 0 passe'),
  dansLigne(SC, "const essais = Number(valeur('essais')[0] ??", '10', '3', 'ligne de commande : le nombre de lancements par défaut change'),
  dansLigne(SC, 'if (!Number.isInteger(essais) ||', '!Number.isInteger(essais) || ', '', 'ligne de commande : un nombre de lancements qui n\'est pas un entier passe'),
  dansLigne(SC, 'if (!Number.isInteger(essais) ||', 'essais < 1', 'essais < 0', 'ligne de commande : zéro lancement passe'),
  dansLigne(SC, "const regime = valeur('regime')[0] ??", "'principal'", "'worker'", 'ligne de commande : le régime par défaut est le Worker'),
  dansLigne(SC, "if (!['principal', 'worker'].includes(regime))", "!['principal', 'worker'].includes(regime)", 'false', 'ligne de commande : un régime inconnu passe'),
  dansLigne(SC, 'if (pileMb !== undefined && !(pileMb > 0))', '!(pileMb > 0)', 'pileMb < 0', 'ligne de commande : une pile nulle ou illisible passe'),
  dansLigne(SC, "if (pileMb !== undefined && regime !== 'worker')", "pileMb !== undefined && regime !== 'worker'", 'false', 'ligne de commande : une pile demandée hors du régime Worker passe'),
  dansLigne(SC, "const arbres = (valeur('arbre').length ?", '[RACINE]', '[]', 'ligne de commande : sans `--arbre`, aucun arbre n\'est rejoué'),
  dansLigne(SC, "for (const a of arbres) if (!fs.existsSync(path.join(a, 'bin', 'gwaudit.js'))", "!fs.existsSync(path.join(a, 'bin', 'gwaudit.js')) || ", '', 'ligne de commande : un arbre sans bin/gwaudit.js passe'),
  dansLigne(SC, "for (const a of arbres) if (!fs.existsSync(path.join(a, 'bin', 'gwaudit.js'))", " || !fs.existsSync(path.join(a, 'fixtures', 'widget-exemple'))", '', 'ligne de commande : un arbre sans fixtures/widget-exemple passe'),
  dansLigne(SC, "for (const a of arbres) if (!fs.existsSync(path.join(a, 'bin', 'gwaudit.js'))", "'gwaudit.js')) ||", "'gwaudit.js')) &&", 'ligne de commande : il faut les deux manques pour refuser un arbre'),
  dansLigne(SC, 'const { lignes, interdites } = rejouer(', '{ niveaux, essais, regime, pileMb, arbres, sansAbandon }', '{ niveaux, essais, pileMb, arbres, sansAbandon }', 'ligne de commande : le régime demandé n\'est pas transmis'),
  dansLigne(SC, 'const { lignes, interdites } = rejouer(', '{ niveaux, essais, regime, pileMb, arbres, sansAbandon }', '{ niveaux, essais, regime, arbres, sansAbandon }', 'ligne de commande : la pile demandée n\'est pas transmise'),
  dansLigne(SC, 'const { lignes, interdites } = rejouer(', '{ niveaux, essais, regime, pileMb, arbres, sansAbandon }', '{ niveaux, regime, pileMb, arbres, sansAbandon }', 'ligne de commande : le nombre de lancements demandé n\'est pas transmis'),
  dansLigne(SC, 'const { lignes, interdites } = rejouer(', '{ niveaux, essais, regime, pileMb, arbres, sansAbandon }', '{ essais, regime, pileMb, arbres, sansAbandon }', 'ligne de commande : les niveaux demandés ne sont pas transmis'),
  dansLigne(SC, 'const { lignes, interdites } = rejouer(', '{ niveaux, essais, regime, pileMb, arbres, sansAbandon }', '{ niveaux, essais, regime, pileMb, arbres }', 'ligne de commande : `--sans-abandon` n\'est pas transmis au rejeu'),
  dansLigne(SC, 'const sansAbandon = args.includes(', "args.includes('--sans-abandon')", 'false', 'ligne de commande : `--sans-abandon` est accepté et ignoré'),
  dansLigne(SC, 'const sansAbandon = args.includes(', "args.includes('--sans-abandon')", 'true', 'ligne de commande : l\'abandon est toujours interdit'),
  dansLigne(SC, 'const inconnues = args.filter(', "a !== '--sans-abandon' && ", '', 'ligne de commande : `--sans-abandon` est une option inconnue'),
  dansLigne(SC, 'const inconnues = args.filter(', "a !== '--sans-abandon'", "!a.startsWith('--sans-abandon')", 'ligne de commande : `--sans-abandon=1`, ou toute option qui commence par le même nom, passe et n\'est pas appliquée'),
  dansLigne(SC, 'const USAGE =', ' [--sans-abandon]', '', 'ligne de commande : l\'usage ne dit pas `--sans-abandon`'),
  dansLigne(SC, "'\\nAucune fin interdite : chaque lancement a lu le code ou l\\'a dit", "aucun n\\'a été arrêté par V8", 'tous ont été arrêtés par V8', 'ligne de commande : avec `--sans-abandon`, un bilan sans fin interdite dit les lancements arrêtés par V8'),
  dansLigne(SC, ": sansAbandon", 'sansAbandon', 'false', 'ligne de commande : avec `--sans-abandon`, le bilan sans fin interdite ne dit pas qu\'aucun lancement n\'a été arrêté'),
  dansLigne(SC, "${sansAbandon ? ' ; abandon : le processus a été arrêté par V8' : ''}", "sansAbandon ? ' ; abandon : le processus a été arrêté par V8' : ''", "''", 'ligne de commande : avec `--sans-abandon`, le bilan ne dit pas que l\'abandon est une fin interdite'),
  dansLigne(SC, 'console.log(tableau(lignes,', 'arbres.length > 1', 'false', 'ligne de commande : deux arbres ne sont pas nommés dans le tableau'),
  dansLigne(SC, 'process.exitCode = interdites ? 1 : 0;', 'interdites ? 1 : 0', '0', 'ligne de commande : une fin interdite sort en code 0'),
  dansLigne(SC, 'process.exitCode = interdites ? 1 : 0;', 'interdites ? 1 : 0', 'interdites ? 0 : 1', 'ligne de commande : aucune fin interdite sort en code 1'),

  // La cause de chaque abandon : la ligne « FATAL ERROR » de V8, lue dans la sortie d'erreur du lancement ------------------------------
  dansLigne(SC, 'const m = /FATAL ERROR:', 'FATAL ERROR: ', 'FATAL ERROR ', 'cause : le deux-points de « FATAL ERROR: » n\'est plus cherché'),
  dansLigne(SC, 'const m = /FATAL ERROR:', 'FATAL ERROR: ', 'FATAL ERROR:', 'cause : l\'espace qui suit « FATAL ERROR: » n\'est plus cherché (« FATAL ERROR:collé » serait une cause)'),
  dansLigne(SC, 'const m = /FATAL ERROR:', '(.*)', '(.+)', 'cause : un message vide n\'est plus une cause vide'),
  dansLigne(SC, 'const m = /FATAL ERROR:', '/.exec(', '/i.exec(', 'cause : « fatal error: » en minuscules est une cause'),
  dansLigne(SC, 'return m ? m[1].trim()', 'm[1]', 'm[0]', 'cause : la cause redit « FATAL ERROR: » devant le message'),
  dansLigne(SC, 'return m ? m[1].trim()', '.trim()', '', 'cause : les blancs de fin sont dans la cause'),
  dansLigne(SC, 'return m ? m[1].trim()', '.slice(0, 120)', '.slice(0, 121)', 'cause : la cause est coupée à cent vingt et un caractères'),
  dansLigne(SC, 'return m ? m[1].trim()', '.slice(0, 120)', '.slice(0, 119)', 'cause : la cause est coupée à cent dix-neuf caractères'),
  dansLigne(SC, 'return m ? m[1].trim()', '.slice(0, 120)', '', 'cause : la cause n\'est pas coupée'),
  dansLigne(SC, 'return m ? m[1].trim()', ': null', ": ''", 'cause : l\'absence de message est une cause vide'),
  dansLigne(SC, 'return m ? m[1].trim()', 'm ?', 'true ?', 'cause : tout texte, même sans message, a une cause'),
  dansLigne(SC, 'export const SANS_CAUSE =', "'aucun message de V8'", "'inconnue'", 'cause : un abandon sans message de V8 n\'est pas dit « aucun message de V8 »'),
  dansLigne(SC, 'const cause = causeDAbandon(fs.readFileSync(', "fs.readFileSync(erreurs, 'utf8')", "''", 'lancement : la cause n\'est pas lue dans la sortie d\'erreur'),
  dansLigne(SC, 'try { r = spawnSync(process.execPath, args,', "'ignore', fd]", "'ignore', 'ignore']", 'lancement : la sortie d\'erreur est jetée, aucune cause n\'est dite'),
  dansLigne(SC, 'try { r = spawnSync(process.execPath, args,', "'ignore', fd]", "'ignore', 'pipe']", 'lancement : la sortie d\'erreur passe par un tube (plafonné à 1 Mio, le lancement qui en écrit plus est arrêté)'),
  dansLigne(SC, 'return { status: r.status, signal: r.signal ?? null', ', cause }', ' }', 'lancement : la cause n\'est pas rendue'),
  dansLigne(SC, 'const parArbre = new Map(', 'causes: {}', 'causes: null', 'rejeu : un arbre n\'a pas de table de causes'),
  dansLigne(SC, 'const parArbre = new Map(', ', causes: {}', '', 'rejeu : les causes ne sont pas comptées'),
  dansLigne(SC, "if (fin === 'abandon') { const cause", "fin === 'abandon'", 'true', 'rejeu : chaque fin, non le seul abandon, a une cause'),
  dansLigne(SC, "if (fin === 'abandon') { const cause", "fin === 'abandon'", 'false', 'rejeu : aucun abandon n\'a de cause'),
  dansLigne(SC, "if (fin === 'abandon') { const cause", "fin === 'abandon'", "fin !== 'abandon'", 'rejeu : tout sauf l\'abandon a une cause'),
  dansLigne(SC, "if (fin === 'abandon') { const cause", 'lancement.cause || SANS_CAUSE', 'lancement.cause ?? SANS_CAUSE', 'rejeu : une cause vide reste une cause'),
  dansLigne(SC, "if (fin === 'abandon') { const cause", 'lancement.cause || SANS_CAUSE', 'lancement.cause', 'rejeu : un abandon sans message a pour cause « null »'),
  dansLigne(SC, "if (fin === 'abandon') { const cause", 'lancement.cause || SANS_CAUSE', 'SANS_CAUSE', 'rejeu : aucune cause n\'est celle que V8 a dite'),
  dansLigne(SC, "if (fin === 'abandon') { const cause", '(compte.causes[cause] ?? 0) + 1', '1', 'rejeu : chaque cause est comptée une fois'),
  dansLigne(SC, "if (fin === 'abandon') { const cause", '(compte.causes[cause] ?? 0) + 1', '(compte.causes[cause] ?? 0) + 2', 'rejeu : chaque abandon compte deux fois dans sa cause'),
  dansLigne(SC, "if (fin === 'abandon') { const cause", '(compte.causes[cause] ?? 0) + 1', '(compte.causes[cause] ?? 1) + 1', 'rejeu : le compte d\'une cause part de un'),
  dansLigne(SC, 'const avecCauses = lignes.filter(', 'Object.keys(l.causes ?? {}).length', 'l.causes', 'tableau : une ligne sans abandon a une table de causes'),
  dansLigne(SC, 'const avecCauses = lignes.filter(', 'l.causes ?? {}', 'l.causes', 'tableau : une ligne sans table de causes fait échouer le tableau'),
  dansLigne(SC, 'if (avecCauses.length) {', 'avecCauses.length', 'true', 'tableau : le titre des causes se dit toujours'),
  dansLigne(SC, 'if (avecCauses.length) {', 'avecCauses.length', 'false', 'tableau : aucune cause ne se dit'),
  dansLigne(SC, "sortie.push('', 'Causes des abandons", "'', ", '', 'tableau : rien ne sépare les comptes des causes'),
  dansLigne(SC, "sortie.push('', 'Causes des abandons", 'Causes des abandons (la ligne « FATAL ERROR » de V8) :', 'Causes :', 'tableau : le titre des causes ne dit pas ce que c\'est'),
  dansLigne(SC, 'for (const l of avecCauses) for (const [cause, n]', 'plusieursArbres ?', 'false ?', 'tableau : avec plusieurs arbres, la cause ne dit pas de quel arbre'),
  dansLigne(SC, 'for (const l of avecCauses) for (const [cause, n]', 'plusieursArbres ?', 'true ?', 'tableau : avec un seul arbre, la cause est précédée de son nom'),
  dansLigne(SC, 'for (const l of avecCauses) for (const [cause, n]', 'path.basename(l.arbre)', 'l.arbre', 'tableau : l\'arbre d\'une cause est dit par son chemin entier'),
  dansLigne(SC, 'for (const l of avecCauses) for (const [cause, n]', '${l.niveaux} niveaux', '${l.niveaux}', 'tableau : la cause ne dit pas le niveau en « niveaux »'),
  dansLigne(SC, 'for (const l of avecCauses) for (const [cause, n]', '${n} × ${cause}', '${cause} × ${n}', 'tableau : la cause précède son compte'),
  dansLigne(SC, 'for (const l of avecCauses) for (const [cause, n]', 'Object.entries(l.causes)', 'Object.entries(l.causes).slice(0, 1)', 'tableau : seule la première cause d\'une ligne se dit'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [
    { nom: 'lecture qui lève', fichiers: ['tests/lecture-qui-leve.test.mjs'] },
    { nom: 'lecteur d\'acorn et pile qui déborde', fichiers: ['tests/abandon-de-pile.test.mjs'] },
    { nom: 'rejeu du fichier profond', fichiers: ['tests/rejouer-fichier-profond.test.mjs'] },
  ],
  exigerChromium: false,
  dossiers: [...DOSSIERS_COPIES, 'bin'],
  delaiMs: 120_000,
  partie,
});
