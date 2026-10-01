#!/usr/bin/env node
/**
 * Rejoue les mutants de l'exécution isolée de l'analyse statique (`src/isolement/`, `src/contexte/resume.js`,
 * le câblage de `bin/gwaudit.js`) : chaque fin possible de l'enfant, chaque limite, chaque champ du repli et du
 * résumé du contexte est gardé par `tests/isolement-*.test.mjs` (méthode : `scripts/lib/rejouer-mutants.mjs`).
 *
 * Tués par un test, pas par un délai : les essais qui pourraient attendre un enfant qui ne finit pas portent leur
 * propre délai (un test en échec), le lot ne compte sur aucun délai du moteur.
 *
 * Mutants équivalents, écartés et dits : la répétition de `maxOldGenerationSizeMb` aux `resourceLimits` du Worker
 * (l'option de processus posée par enfant.js fait tout le travail : mesuré, la répétition seule ne borne rien) ;
 * `code === 134` / `code === 137` (Node rend le signal, pas le code, à un processus lancé sans interpréteur de commandes,
 * mais un enveloppeur qui les rendrait est ainsi compris) ; `preciserConstatsDeLAxeD` appelé sur une analyse qui a abouti
 * (`usagesGrist` y existe, la fonction n'y fait rien).
 *
 * Non couvert, dit tel quel : qu'un vrai noyau tue le bon processus et qu'un vrai fichier hostile épuise la mémoire
 * au seuil mesuré (preuve dans l'image avec son plafond, `docker/ci/verifier.sh interruption`).
 *
 * Usage : node scripts/mutants-isolement.mjs [--part=i/n] [expression régulière sur le libellé]
 */
import { lireArguments, rejouerMutants, DOSSIERS_COPIES } from './lib/rejouer-mutants.mjs';

const E = 'src/isolement/enfant.js';
const T = 'src/isolement/enfant-travail.mjs';
const L = 'src/isolement/limites.js';
const R = 'src/isolement/repli.js';
const A = 'src/isolement/analyse-isolee.js';
const D = 'src/isolement/axe-d.js';
const S = 'src/contexte/resume.js';
const B = 'bin/gwaudit.js';
const M = 'scripts/mesurer-seuil-memoire.mjs';
const PX = 'docker/ci/pics.cjs';
const RS = 'docker/ci/resumer-pics.cjs';
const SH = 'docker/ci/mesurer-pics.sh';

// Du plus rapide au plus lent : un mutant est tué par le premier groupe qui échoue, la plupart n'attendent pas les essais de bout en bout.
const GROUPES = [
  { nom: 'mesure du seuil', fichiers: ['tests/mesurer-seuil-memoire.test.mjs', 'tests/mesurer-pics.test.mjs'] },
  { nom: 'limites, repli, résumé', fichiers: ['tests/isolement-limites.test.mjs', 'tests/isolement-repli.test.mjs', 'tests/isolement-resume.test.mjs'] },
  { nom: 'enfant', fichiers: ['tests/isolement-enfant.test.mjs'] },
  { nom: 'analyse isolée', fichiers: ['tests/isolement-analyse-isolee.test.mjs'] },
  { nom: 'axe D', fichiers: ['tests/isolement-axe-d.test.mjs'] },
  { nom: 'de bout en bout', fichiers: ['tests/isolement-cli.test.mjs', 'tests/isolement-equivalence.test.mjs'] },
];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- enfant.js : ce qui est pris pour un résultat, chaque fin nommée
  [E, 'if (sortie.code === 0 && resultat?.termine === true) return', 'if (resultat?.termine === true) return', 'un résultat complet suivi d\'une fin en erreur est rendu comme un résultat'],
  [E, 'resultat?.termine === true', 'resultat !== null', 'un fichier de résultat sans marqueur de fin est pris pour un résultat'],
  [E, 'sortie.code === 0 && resultat?.termine === true', 'sortie.code === 0 && resultat?.termine === true && false', 'aucun résultat n\'est jamais rendu'],
  [E, 'if (delaiMs) minuteur = setTimeout(() => { delaiAtteint = true; tuer(); }, delaiMs);', 'if (false) minuteur = setTimeout(() => { delaiAtteint = true; tuer(); }, delaiMs);', 'le délai n\'est jamais armé'],
  [E, 'delaiAtteint = true; tuer();', 'delaiAtteint = true;', 'le délai atteint ne tue pas l\'enfant'],
  [E, 'delaiAtteint = true; tuer();', 'tuer();', 'le délai atteint tue l\'enfant sans le dire (cause : le noyau)'],
  [E, "genre: 'delai'", "genre: 'sortie'", 'cause « delai » nommée « sortie »'],
  [E, "genre: 'noyau'", "genre: 'sortie'", 'cause « noyau » nommée « sortie »'],
  [E, "genre: 'incomplet'", "genre: 'sortie'", 'cause « incomplet » nommée « sortie »'],
  [E, "genre: 'exception', raison: `erreur interne", "genre: 'sortie', raison: `erreur interne", 'cause « exception » nommée « sortie »'],
  [E, "${echec?.message ? citerSiBesoin(String(echec.message)) : 'sans message'}", "${echec?.message ?? 'sans message'}", 'le message d\'une erreur interne est recopié tel quel (guillemets inversés, balise ou caractère d\'échappement du widget)'],
  [E, 'if (posix) process.kill(-enfant.pid, \'SIGKILL\'); else enfant.kill(\'SIGKILL\');', 'enfant.kill(\'SIGKILL\');', 'seul l\'enfant est tué, pas ce qu\'il a lancé'],
  [E, 'detached: posix', 'detached: false', 'l\'enfant ne mène pas son groupe de processus'],
  [E, "enfant.once('exit', (code, signal) => { tuer(); setTimeout", "enfant.once('exit', (code, signal) => { setTimeout", 'ce que l\'enfant a laissé tourner n\'est pas tué à sa sortie'],
  [E, 'if (relayerStderr) relayerStderr.write(morceau);', '', 'la sortie d\'erreur de l\'enfant n\'est pas relayée'],
  [E, "fin = (fin + morceau.toString('utf8')).slice(-LONGUEUR_FIN_STDERR);", 'fin = fin;', 'la fin de la sortie d\'erreur n\'est jamais gardée'],
  [E, ".slice(-LONGUEUR_FIN_STDERR)", '.slice(0, LONGUEUR_FIN_STDERR)', 'le début de la sortie d\'erreur est gardé au lieu de sa fin'],
  [E, ".slice(-400) };", '.slice(0, 400) };', 'la cause montre le début des dernières lignes au lieu de leur fin'],
  [E, "for (const signal of ['SIGINT', 'SIGTERM']) {", "for (const signal of ['SIGINT']) {", 'SIGTERM (le plafond du conteneur) n\'est pas rattrapé'],
  [E, "for (const signal of ['SIGINT', 'SIGTERM']) {", "for (const signal of ['SIGTERM']) {", 'SIGINT n\'est pas rattrapé'],
  [E, 'const gestionnaire = () => { tuer(); nettoyer(); process.kill(process.pid, signal); };', 'const gestionnaire = () => { nettoyer(); process.kill(process.pid, signal); };', 'le parent interrompu ne tue pas son enfant'],
  [E, 'const gestionnaire = () => { tuer(); nettoyer(); process.kill(process.pid, signal); };', 'const gestionnaire = () => { tuer(); nettoyer(); };', 'le parent interrompu absorbe le signal et continue'],
  [E, 'const gestionnaire = () => { tuer(); nettoyer(); process.kill(process.pid, signal); };', 'const gestionnaire = () => { tuer(); process.kill(process.pid, signal); };', 'le parent interrompu laisse le dossier de travail de l\'enfant'],
  [E, 'const nettoyer = () => { try { fs.rmSync(dossier, { recursive: true, force: true }); } catch {', 'const nettoyer = () => { try { /* rien */ } catch {', 'le nettoyage du dossier de travail ne retire rien'],
  [E, 'return MOTIF_TAS_EPUISE.test(fin)', 'return true', 'tout abandon de V8 est dit mémoire épuisée'],
  [E, 'return MOTIF_TAS_EPUISE.test(fin)', 'return false', 'aucun abandon de V8 n\'est dit mémoire épuisée'],
  // --- l'abandon du compilateur d'expressions régulières (pile presque pleine) : dit pile, jamais mémoire épuisée
  [E, "if (MOTIF_PILE_PLEINE.test(fin) && (signal === 'SIGABRT' || (!signal && code))) {", 'if (false) {', 'l\'abandon du compilateur d\'expressions régulières est dit mémoire épuisée'],
  [E, "if (MOTIF_PILE_PLEINE.test(fin) && (signal === 'SIGABRT' || (!signal && code))) {", "if (MOTIF_PILE_PLEINE.test(fin) && (signal === 'SIGABRT')) {", 'pile pleine : un abandon sans signal (Windows) n\'est pas reconnu'],
  [E, "if (MOTIF_PILE_PLEINE.test(fin) && (signal === 'SIGABRT' || (!signal && code))) {", 'if (MOTIF_PILE_PLEINE.test(fin)) {', 'pile pleine : un SIGKILL ou une sortie 0 qui cite le message est dit pile'],
  [E, "if (MOTIF_PILE_PLEINE.test(fin) && (signal === 'SIGABRT' || (!signal && code))) {", "if (MOTIF_PILE_PLEINE.test(fin) && (signal === 'SIGABRT' || !signal)) {", 'pile pleine : une sortie 0 avec le message est dite pile'],
  [E, 'const MOTIF_PILE_PLEINE = /^FATAL ERROR: RegExpCompiler Allocation failed/m;', 'const MOTIF_PILE_PLEINE = /FATAL ERROR: RegExpCompiler Allocation failed/m;', 'pile pleine : le message cité au milieu d\'une ligne est reconnu'],
  [E, 'const MOTIF_PILE_PLEINE = /^FATAL ERROR: RegExpCompiler Allocation failed/m;', 'const MOTIF_PILE_PLEINE = /^FATAL ERROR: RegExpCompiler Allocation failed/;', 'pile pleine : le message n\'est lu qu\'à la première ligne de la sortie d\'erreur'],
  [E, 'const LONGUEUR_FIN_STDERR = 16384;', 'const LONGUEUR_FIN_STDERR = 4096;', 'le message de V8 est perdu sous sa trace native de plus de 4 Kio'],
  [E, "const tete = fatale && !dernieres.includes(fatale) ? fatale.slice(0, 200) : null;", 'const tete = null;', 'le message fatal de V8 n\'est pas repris en tête de la fin de sortie'],
  [E, "const tete = fatale && !dernieres.includes(fatale) ? fatale.slice(0, 200) : null;", 'const tete = fatale ? fatale.slice(0, 200) : null;', 'le message fatal est répété quand il est déjà dans les dernières lignes'],
  [E, "`${tete} | ${queue.slice(-(400 - tete.length - 3))}`", "`${tete} | ${queue}`", 'la fin de sortie avec son message fatal dépasse 400 caractères'],
  [R, "remediation: cause.genre === 'pile'", 'remediation: false', 'la pile pleine reçoit la remédiation de la taille des fichiers'],
  [R, "remediation: cause.genre === 'pile'", 'remediation: true', 'toute interruption reçoit la remédiation de le découpage du code imbriqué'],
  [R, "new Set(['tas', 'abandon', 'noyau', 'delai'])", "new Set(['tas', 'abandon', 'noyau', 'delai', 'pile'])", 'la pile pleine désigne le plus gros fichier'],
  [E, "resultatPresent ? \"le fichier de résultat", "!resultatPresent ? \"le fichier de résultat", 'résultat absent et incomplet échangés'],
  [E, "const mo = limiteMo ? `la limite de ${limiteMo} Mio` : 'la limite de Node';", "const mo = 'la limite de Node';", 'la limite atteinte n\'est pas dite'],
  [E, 'scoreOom = 1000,', 'scoreOom = 0,', 'l\'enfant ne se rend pas tuable en premier par défaut'],
  [E, 'sondeParentMs = 2000,', 'sondeParentMs = 2000000,', 'la sonde du parent par défaut ne bat plus'],
  [E, 'const args = [...(limiteMo ? [`--max-old-space-size=${limiteMo}`] : []), ENFANT, dossier];', 'const args = [ENFANT, dossier];', 'la limite du tas n\'est pas posée sur le processus'],
  [E, 'JSON.stringify({ module, entree, limiteMo, pileMo, scoreOom, sondeParentMs })', 'JSON.stringify({ module, entree, limiteMo, scoreOom, sondeParentMs })', 'la taille de pile n\'est pas transmise à l\'enfant'],
  [E, 'throw new ErreurLancement(erreurDeLancement(e));', 'throw e;', 'un lancement refusé de suite n\'est pas une ErreurLancement'],
  [E, "for (const r of retirer) r();\n    fs.rmSync(dossier, { recursive: true, force: true });", 'for (const r of retirer) r();', 'le dossier de travail de l\'enfant n\'est pas retiré'],
  // --- enfant-travail.mjs : dans l'enfant
  [T, "if (scoreOom != null) {", "if (false) {", 'l\'enfant ne relève pas son score de mort par manque de mémoire'],
  [T, 'if (process.ppid === parentInitial) return;', 'if (true) return;', 'l\'enfant ne s\'arrête jamais quand son parent meurt'],
  [T, "try { fs.rmSync(dossier, { recursive: true, force: true }); } catch { /* déjà parti */ }", '', 'l\'enfant orphelin laisse le dossier de travail derrière lui'],
  [T, "}, sondeParentMs).unref();", "}, 2000000).unref();", 'la sonde de l\'enfant ne bat pas au rythme demandé'],
  [T, "if (process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGKILL'); } catch { /* pas chef de groupe */ } }", '', 'l\'enfant orphelin laisse ce qu\'il a lancé'],
  [T, 'if (pileMo) resourceLimits.stackSizeMb = pileMo;', 'if (false) resourceLimits.stackSizeMb = pileMo;', 'la taille de pile n\'est pas appliquée au fil de travail'],
  [T, "if (e?.code === 'ERR_WORKER_OUT_OF_MEMORY') echec(", "if (false) echec(", 'le tas épuisé du Worker n\'est pas reconnu'],
  [T, 'if (code === 0) { mesurer(); process.exit(0); }', 'if (code === 0) { process.exit(0); }', 'le pic de mémoire n\'est pas écrit à la fin de l\'enfant'],
  [T, "JSON.stringify({ rssMaxMo: Math.round(process.resourceUsage().maxRSS / 1024) })", "JSON.stringify({ rssMaxMo: Math.round(process.resourceUsage().maxRSS) })", 'le pic de mémoire est en Kio au lieu de Mio'],
  [T, "JSON.stringify({ termine: true, resultat })", "JSON.stringify({ resultat })", 'le résultat n\'a pas de marqueur de fin'],
  [T, "// Le résultat est écrit : rien de ce que le travail a laissé ouvert (un processus lancé, un minuteur) ne doit retenir la fin. Le parent tue ce qui reste.\n  process.exit(0);", '// Le résultat est écrit.', 'un processus laissé ouvert retient la fin du travail'],
  // --- limites.js
  [L, 'Math.max(TAS_MINIMUM_MO, memoireConteneurMo - RESERVE_HORS_TAS_MO)', 'memoireConteneurMo - RESERVE_HORS_TAS_MO', 'aucun tas minimum'],
  [L, 'export const RESERVE_HORS_TAS_MO = 210;', 'export const RESERVE_HORS_TAS_MO = 100;', 'réserve du parent réduite (tas de l\'enfant trop grand pour le conteneur)'],
  [L, 'export const RESERVE_HORS_TAS_MO = 210;', 'export const RESERVE_HORS_TAS_MO = 400;', 'réserve du parent doublée'],
  [L, 'export const TAS_MINIMUM_MO = 128;', 'export const TAS_MINIMUM_MO = 32;', 'tas minimum abaissé'],
  [L, 'octets < 2 ** 40', 'octets < 2 ** 63', 'le « illimité » de cgroup v1 est pris pour une limite'],
  [L, '/^\\d+$/.test(brut) && Number(brut) >= minimum', '/^\\d+$/.test(brut) && Number(brut) > minimum', 'le minimum d\'une variable est refusé'],
  [L, "if (brut === undefined || brut === '') return null;", "if (brut === undefined) return null;", 'une variable vide est dite invalide'],
  [L, 'if (limiteMo === null && memoireConteneurMo !== null)', 'if (memoireConteneurMo !== null)', 'la limite du conteneur l\'emporte sur la variable'],
  [L, 'delaiS === null ? null : delaiS * 1000', 'delaiS * 1000', 'aucun délai devient un délai de 0'],
  // --- repli.js
  [R, "export const AXES_DE_L_ANALYSE = ['A', 'B', 'C', 'E', 'F'];", "export const AXES_DE_L_ANALYSE = ['A', 'B', 'C', 'E'];", 'l\'axe F n\'est pas empêché'],
  [R, "export const AXES_DE_L_ANALYSE = ['A', 'B', 'C', 'E', 'F'];", "export const AXES_DE_L_ANALYSE = ['A', 'B', 'C', 'D', 'E', 'F'];", 'l\'axe D est empêché'],
  [R, "new Set(['tas', 'abandon', 'noyau', 'delai'])", "new Set(['tas', 'abandon', 'noyau'])", 'le délai ne désigne plus le plus gros fichier'],
  [R, "new Set(['tas', 'abandon', 'noyau', 'delai'])", "new Set(['tas', 'abandon', 'noyau', 'delai', 'exception', 'incomplet', 'sortie'])", 'toute fin désigne un fichier'],
  [R, "severite: 'critique', bloquant: true, confiance: 'certain',", "severite: 'majeur', bloquant: true, confiance: 'certain',", 'le constat de repli n\'est plus critique'],
  [R, "severite: 'critique', bloquant: true, confiance: 'certain',", "severite: 'critique', bloquant: true, confiance: 'probable',", 'le constat de repli n\'est plus certain'],
  [R, "etape ? `Elle s'est interrompue pendant ${etape}.` : null,", 'null,', 'l\'étape de l\'interruption n\'est pas dite'],
  [R, ".toFixed(1).replace('.', ',')", ".toFixed(1)", 'la taille du fichier est écrite avec un point'],
  [R, '...(plusGros ? { plusGrosFichierDeCode: plusGros } : {}),', '', 'la preuve ne porte pas le plus gros fichier'],
  [R, '...(cause.fin ? { finDeLaSortieDErreur: cause.fin } : {}),', '', 'la preuve ne porte pas la fin de la sortie d\'erreur'],
  [R, "est ${citer(plusGros.chemin)} (", "est \\`${plusGros.chemin}\\` (", 'le nom du plus gros fichier est recopié tel quel (guillemets inversés, balise ou retour à la ligne du widget)'],
  [R, "regle: 'C-SURFACE-03', axe: 'C',", "regle: 'C-SURFACE-02', axe: 'C',", 'le repli porte le numéro d\'une autre règle'],
  [R, "cause: 'interruption', message: cause.raison,", "cause: 'syntaxe', message: cause.raison,", 'la cause de la preuve n\'est pas « interruption »'],
  [R, "regle: 'D-INDISPONIBLE', axe: 'D', severite: 'info',", "regle: 'D-INDISPONIBLE', axe: 'D', severite: 'mineur',", 'D-INDISPONIBLE pénalise'],
  [R, 'if (ctx?.usagesGrist) return;', 'if (false) return;', 'D-PERIMETRE-01 est précisé même quand le niveau d\'accès a été lu'],
  [R, 'if (c.regle === \'D-PERIMETRE-01\' && !c.constat.includes(PRECISION_ACCES))', 'if (!c.constat.includes(PRECISION_ACCES))', 'toute règle de l\'axe D reçoit la précision'],
  [R, "&& !c.constat.includes(PRECISION_ACCES)) c.constat", ") c.constat", 'la précision est ajoutée plusieurs fois'],
  // --- analyse-isolee.js
  [A, 'if (!r.cause.etape) {', 'if (false) {', 'un enfant mort avant sa première étape donne un rapport de repli au lieu d\'une erreur de l\'outil'],
  [A, 'ctx: r.partiel ? contexteDepuisResume(r.partiel) : null', 'ctx: null', 'le contexte sorti avant la mort est perdu'],
  [A, 'constats: [constatInterruption(r.cause, r.partiel)]', 'constats: [constatInterruption(r.cause, null)]', 'le repli ne connaît pas le plus gros fichier'],
  [A, 'interruption: r.cause,', 'interruption: null,', 'la cause de l\'interruption n\'est pas rendue'],
  [A, 'mesures: r.mesures };\n  if', 'mesures: null };\n  if', 'le pic de mémoire de l\'enfant n\'est pas rendu'],
  // --- axe-d.js
  [D, 'if (!analyse.ctx) return', 'if (false) return', 'l\'axe D joue sans contexte'],
  [D, 'if (!analyse.ok) preciserConstatsDeLAxeD(resultat.constats, analyse.ctx);', '', 'D-PERIMETRE-01 ne dit pas ce qui lui manque après une interruption'],
  [D, 'return { ...resultat, joue: true };', 'return { ...resultat, joue: false };', 'l\'axe D dit ne pas avoir joué'],
  // --- resume.js
  [S, "&& !f.chemin.includes('/')) ajouter", ") ajouter", 'le README d\'un sous-dossier est pris pour celui de la racine'],
  [S, '({ contenu: x.contenu ?? null })', '({ contenu: null })', 'le README de la racine perd son contenu'],
  [S, 'if (f.litteralImbrique && f.origineReelle) {', 'if (false) {', 'les fichiers issus d\'un code exécuté depuis une chaîne sont perdus'],
  [S, "ajouter(suivant, (x) => (x.litteralImbrique && x.origineReelle ? { litteralImbrique: true, origineReelle: x.origineReelle } : {}));", "ajouter(suivant, () => ({}));", 'la chaîne d\'origines s\'arrête au premier maillon'],
  [S, 'f.code && (!plusGros || f.taille > plusGros.taille)', '(!plusGros || f.taille > plusGros.taille)', 'le plus gros fichier n\'est pas forcément du code'],
  [S, 'f.taille > plusGros.taille', 'f.taille < plusGros.taille', 'le plus petit fichier de code est nommé'],
  [S, 'fichiersReels: ctx.fichiersReels ?? fichiers.length,', 'fichiersReels: fichiers.length,', 'le nombre de fichiers réels est celui du contexte'],
  [S, 'tailleSurface: ctx.surface.size,', 'tailleSurface: 0,', 'la surface exécutée est perdue'],
  [S, "...(ctx.usagesGrist ? { usagesGrist: { acces: (ctx.usagesGrist.acces ?? []).map((a) => ({ niveau: a.niveau })) } } : {}),", '', 'les niveaux d\'accès sont perdus'],
  [S, 'tronque: resume.tronque,', 'tronque: null,', 'l\'inventaire tronqué n\'est plus dit après le résumé'],
  [S, 'surface: { size: resume.tailleSurface },', 'surface: { size: 0 },', 'la surface du contexte du résumé est nulle'],
  // --- bin/gwaudit.js : le câblage
  [B, 'limites: limitesDeLAnalyse()', 'limites: {}', 'la ligne de commande ne pose aucune limite à l\'analyse'],
  [B, "const ctx = analyse.ctx ?? { racine, entrees: [], fichiersReels: 0, surface: { size: 0 }, tronque: null, fichiers: [] };", 'const ctx = analyse.ctx;', 'un enfant mort avant l\'inventaire fait planter les rapports'],
  [B, 'if (!analyse.ok) console.error(', 'if (false) console.error(', 'l\'interruption n\'est pas dite sur la sortie d\'erreur'],
  [B, "console.error(`Erreur : ${e.message}`); process.exitCode = 3; return; }", "console.error(`Erreur : ${e.message}`); process.exitCode = 4; return; }", 'un enfant qui ne démarre pas sort avec un autre code que 3'],
  [B, "if (nonExecute) axesNonExecutes.add('D');", '', 'un axe D non exécuté entre dans la note'],
  // --- scripts/mesurer-seuil-memoire.mjs : les chiffres du document se rejouent, sur du code fabriqué ou sur la cible d'un autre
  [M, "cible ? path.resolve(cible) : fs.mkdtempSync(", 'fs.mkdtempSync(', '--cible est ignorée : la mesure porte sur un dossier vide'],
  [M, 'if (!cible) fs.rmSync(racine, { recursive: true, force: true });', 'fs.rmSync(racine, { recursive: true, force: true });', 'la cible d\'un autre est supprimée après la mesure'],
  [M, 'if (!cible) fs.rmSync(racine, { recursive: true, force: true });', '', 'le dossier fabriqué reste après la mesure'],
  [M, "['mio', 'fichiers', 'sources'].some((o) => process.argv.includes(`--${o}`))", 'false', '--cible se combine sans le dire avec du code fabriqué'],
  [M, '?.isDirectory()) {', '?.isFile()) {', 'un fichier passe pour un dossier cible (et un dossier est refusé)'],
  [M, 'throwIfNoEntry: false', 'throwIfNoEntry: true', 'une cible absente plante l\'outil au lieu d\'être refusée'],
  [M, '...(cible ? { cible: path.basename(racine) } : { codeMio: Number((octets / MIO).toFixed(2)), fichiers }),', '...({ cible: path.basename(racine), codeMio: Number((octets / MIO).toFixed(2)), fichiers }),', 'la ligne dit à la fois la cible et une taille fabriquée'],
  [M, "...(cible ? {} : { sources: sources.length ? 'fichiers fournis' : 'synthétique' })", "...({ sources: sources.length ? 'fichiers fournis' : 'synthétique' })", 'une cible réelle est dite « synthétique »'],
  [M, 'process.exitCode = r.ok ? 0 : 2;', 'process.exitCode = 0;', 'une analyse interrompue sort en code 0'],
  [M, "cause: r.interruption ? r.interruption.genre : null, etape: r.interruption?.etape ?? null,", 'cause: null, etape: null,', 'la cause et l\'étape de l\'interruption ne sont pas dites'],
  // --- docker/ci/mesurer-pics.sh, pics.cjs, resumer-pics.cjs : les pics de mémoire dans l'image
  [PX, 'minuteur.unref();', '', 'le relevé retient le parent en vie : le conteneur ne s\'arrête jamais'],
  [PX, 'ancien.hwm = Math.max(ancien.hwm, hwm);', 'ancien.hwm = hwm;', 'un processus fini et pas encore attendu (zombie) perd son pic : sa dernière lecture est 0'],
  [PX, '/VmHWM:', '/VmRSS:', 'le pic d\'un processus est sa mémoire résidente à la dernière lecture'],
  [PX, '.filter((p) => p.hwm > 20)', '.filter((p) => p.hwm > 0)', 'chaque petit processus de la machine est relevé'],
  [PX, "process.env.GWAUDIT_PICS_SORTIE || '/out'", "'/out'", 'le dossier de sortie du relevé n\'est pas réglable'],
  [PX, 'Math.round((Date.now() - debut) / 100) / 10', 'Math.round((Date.now() - debut) / 1000) / 10', 'la durée du relevé est dite en centièmes de sa valeur'],
  [RS, "?? '?';", '?? 0;', 'un processus absent est dit à 0 Mo'],
  [RS, 'pic(/enfant-travail/)', 'pic(/gwaudit\\.js/)', 'le pic de l\'enfant est celui du parent'],
  [RS, 'process.exit(3);', 'process.exit(0);', 'un relevé absent sort en 0'],
  [RS, "'REPLI (interruption)' : \"analysé jusqu'au bout\"", "\"analysé jusqu'au bout\" : 'REPLI (interruption)'", 'un repli est dit analysé jusqu\'au bout'],
  [RS, "let issue = '?';", "let issue = \"analysé jusqu'au bout\";", 'un rapport absent passe pour une analyse menée jusqu\'au bout'],
  [PX, "lire(`${CGROUPE}/memory/memory.max_usage_in_bytes`) ?? lire(`${CGROUPE}/memory.peak`)", "lire(`${CGROUPE}/memory.peak`) ?? lire(`${CGROUPE}/memory/memory.max_usage_in_bytes`)", 'cgroup v1 et v2 ensemble : la v2 l\'emporte'],
  [PX, 'Math.round(Number(octets) / 1048576)', 'Math.round(Number(octets) / 1000000)', 'le pic du groupe de contrôle est dit en millions d\'octets, non en Mio'],
  [PX, '/^max (\\d+)/m', '/^oom (\\d+)/m', 'les refus de la limite sont le compteur `oom`, pas `max`'],
  [PX, '/^oom_kill (\\d+)/m', '/^oom (\\d+)/m', 'les morts par le noyau sont le compteur `oom`, pas `oom_kill`'],
  [PX, ': evenements !== null ? `max', ': true ? `max', 'un hôte sans memory.events a des refus de mémoire chiffrés'],
  [PX, 'octets && Number.isFinite(Number(octets))', 'Number.isFinite(Number(octets))', 'un pic vide est un pic nul'],
  [PX, ".max_usage_in_bytes`) ?? lire(`${CGROUPE}/memory.peak`))?.trim();", ".max_usage_in_bytes`) ?? lire(`${CGROUPE}/memory.peak`));", 'un pic fait d\'un saut de ligne est un pic nul'],
  [PX, 'echecsV1 !== null ? echecsV1.trim()', 'echecsV1 !== null ? echecsV1', 'les refus de la v1 gardent leur saut de ligne'],
  [RS, "groupe de contrôle ${p.cgroupMo ?? '?'} Mo", 'groupe de contrôle ${p.cgroupMo} Mo', 'un pic absent est dit « null »'],
  [RS, "refus de mémoire ${p.echecsDeLimite ?? '?'} ;", 'refus de mémoire ${p.echecsDeLimite} ;', 'des refus absents sont dits « null »'],
  [SH, '--image) [ $# -ge 2 ] || { echo "--image demande un nom" >&2; exit 64; };', '--image)', 'une option sans valeur n\'est pas refusée en 64'],
  [SH, '*) [ -z "$CIBLE" ] || { echo "une seule cible" >&2; exit 64; };', '*)', 'deux cibles ne sont pas refusées'],
  [SH, '[ -n "$CIBLE" ] && [ -d "$CIBLE" ] ||', '[ -n "$CIBLE" ] ||', 'un fichier passe pour un dossier cible'],
  [SH, '-*) echo "option inconnue : $1" >&2; exit 64 ;;', '-*) shift ;;', 'une option inconnue est ignorée'],
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants[0] ? new RegExp(restants[0]) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: GROUPES,
  exigerChromium: true,
  dossiers: [...DOSSIERS_COPIES, 'bin', 'ressources', 'docker'],
  partie,
});
