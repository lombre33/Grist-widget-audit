#!/usr/bin/env node
/**
 * Rejoue les mutants de ce que l'audit fait d'une lecture qui lève (`tests/lecture-qui-leve.test.mjs`) et du script qui rejoue, lancement
 * après lancement, l'audit d'un fichier trop profond (`tests/rejouer-fichier-profond.test.mjs`). Le premier essai force la lecture
 * d'acorn à lever un dépassement de pile : chaque mutant des sources pose le défaut qui faisait conclure « conforme sous réserve » d'un
 * fichier que l'outil n'avait pas lu (la lecture qui échoue n'est pas relevée, n'est pas dite, interrompt le parcours des autres
 * fichiers, ne bloque pas, n'empêche aucun axe, n'est pas notée 0). Le second éprouve ce que le script juge (silence, abandon, plantage,
 * délai, sortie inconnue), comment il lance l'audit (fil principal ou Worker, pile, options), ce qu'il compte et ce que sa ligne de
 * commande refuse. Chaque mutant pose, sur la ligne qui porte le choix, le défaut plausible : un des essais doit alors échouer (méthode :
 * `scripts/lib/rejouer-mutants.mjs`). Aucun navigateur n'est requis ; `bin/` est copié avec le reste parce que deux essais lancent
 * l'audit pour de vrai.
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

  // Ce que la lecture qui a échoué devient : relevée, sans arrêter le parcours des autres fichiers -------------------------------
  dansLigne(AJ, 'if (f.executee) noterIllisible(releves, f, u,', 'if (f.executee)', 'if (false)', 'lecture qui lève : le code exécuté que la lecture refuse n\'est jamais relevé'),
  brut(AJ, "        noterLectureRefusee(releverDans, f, u, erreur);\n        continue;", "        noterLectureRefusee(releverDans, f, u, erreur);\n        return;", 'lecture qui lève : le premier code illisible interrompt le parcours des autres fichiers'),
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
  dansLigne(SC, 'parArbre.get(arbre)[fin]++;', 'parArbre.get(arbre)', 'parArbre.get(arbres[0])', 'rejeu : tous les lancements sont comptés au premier arbre'),
  dansLigne(SC, 'lignes.push({ arbre, niveaux: n, essais,', 'niveaux: n', 'niveaux: 0', 'rejeu : une ligne du tableau ne dit pas son niveau'),
  dansLigne(SC, 'lignes.push({ arbre, niveaux: n, essais,', 'essais,', 'essais: 1,', 'rejeu : une ligne du tableau ne dit pas le nombre de lancements'),
  dansLigne(SC, 'lancer(arbre, widgets.get(arbre), sortie,', '{ regime, pileMb, enveloppe, delaiMs }', '{ regime, enveloppe, delaiMs }', 'rejeu : la pile demandée ne parvient pas au lancement'),
  dansLigne(SC, 'lancer(arbre, widgets.get(arbre), sortie,', '{ regime, pileMb, enveloppe, delaiMs }', '{ pileMb, enveloppe, delaiMs }', 'rejeu : le régime demandé ne parvient pas au lancement'),
  dansLigne(SC, 'const interdites = lignes.reduce(', 'total + [...INTERDITES]', '0 * [...INTERDITES]', 'rejeu : aucune fin n\'est jamais interdite'),

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
  dansLigne(SC, 'const { lignes, interdites } = rejouer(', '{ niveaux, essais, regime, pileMb, arbres }', '{ niveaux, essais, pileMb, arbres }', 'ligne de commande : le régime demandé n\'est pas transmis'),
  dansLigne(SC, 'const { lignes, interdites } = rejouer(', '{ niveaux, essais, regime, pileMb, arbres }', '{ niveaux, essais, regime, arbres }', 'ligne de commande : la pile demandée n\'est pas transmise'),
  dansLigne(SC, 'const { lignes, interdites } = rejouer(', '{ niveaux, essais, regime, pileMb, arbres }', '{ niveaux, regime, pileMb, arbres }', 'ligne de commande : le nombre de lancements demandé n\'est pas transmis'),
  dansLigne(SC, 'const { lignes, interdites } = rejouer(', '{ niveaux, essais, regime, pileMb, arbres }', '{ essais, regime, pileMb, arbres }', 'ligne de commande : les niveaux demandés ne sont pas transmis'),
  dansLigne(SC, 'console.log(tableau(lignes,', 'arbres.length > 1', 'false', 'ligne de commande : deux arbres ne sont pas nommés dans le tableau'),
  dansLigne(SC, 'process.exitCode = interdites ? 1 : 0;', 'interdites ? 1 : 0', '0', 'ligne de commande : une fin interdite sort en code 0'),
  dansLigne(SC, 'process.exitCode = interdites ? 1 : 0;', 'interdites ? 1 : 0', 'interdites ? 0 : 1', 'ligne de commande : aucune fin interdite sort en code 1'),
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
    { nom: 'rejeu du fichier profond', fichiers: ['tests/rejouer-fichier-profond.test.mjs'] },
  ],
  exigerChromium: false,
  dossiers: [...DOSSIERS_COPIES, 'bin'],
  delaiMs: 120_000,
  partie,
});
