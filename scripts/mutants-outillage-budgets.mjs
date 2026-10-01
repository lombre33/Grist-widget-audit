#!/usr/bin/env node
/**
 * Rejoue les mutants de l'outillage des budgets de temps (`scripts/lib/budgets.mjs`, `scripts/lib/cas-budget.mjs`,
 * `scripts/verifier-budgets.mjs`) : l'occupation de la machine et le refus de mesurer sous charge, le budget retenu et la
 * limite dure de chaque mode, le jugement d'un cas (tenu, trop lent, fautif, tué), la lecture des fichiers de budgets,
 * le processus d'un cas et ce qu'on en lit, la commande et ses codes de sortie. C'est l'outil qui dit si un algorithme est
 * redevenu quadratique : un outil qui tiendrait tout budget pour tenu ne le dirait pas. Les budgets eux-mêmes (les entrées
 * piégées) sont éprouvés par `scripts/mutants-budgets.mjs`.
 *
 * Non éprouvé, dit : l'échec du lancement du processus d'un cas (`r.error` autre qu'un délai : `process.execPath` qui ne
 * s'exécute pas), et le mode (local ou CI) de la limite dure passée à chaque cas de la commande (elle n'agit que sur un cas qui
 * dure plus de 30 s). Deux mutants sont retirés parce qu'aucun essai ne peut les distinguer du code : `.sort()` des noms de fichiers
 * (libuv trie déjà ce que `readdir` rend ; l'essai de l'ordre des noms garde ce que l'outil promet) et le code de sortie 1 d'un cas
 * qui lève (le cas dit alors son erreur sur sa sortie standard, et c'est elle que la commande lit : le code n'y change rien).
 * Le mutant qui retire la limite dure d'un cas ne finit jamais : il est tué par le délai du lot, dit à part.
 *
 * Usage : node scripts/mutants-outillage-budgets.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants } from './lib/rejouer-mutants.mjs';

const L = 'scripts/lib/budgets.mjs';
const C = 'scripts/lib/cas-budget.mjs';
const V = 'scripts/verifier-budgets.mjs';

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- les constantes
  [L, 'export const FACTEUR_CI = 10;', 'export const FACTEUR_CI = 1;', 'constantes : le mode CI ne laisse aucune marge'],
  [L, 'export const FACTEUR_LIMITE = 20;', 'export const FACTEUR_LIMITE = 1;', 'constantes : la limite dure est le budget lui-même'],
  [L, 'export const LIMITE_DURE_MIN_MS = 30_000;', 'export const LIMITE_DURE_MIN_MS = 0;', 'constantes : pas de limite dure plancher'],
  [L, 'export const OCCUPATION_MAX = 0.25;', 'export const OCCUPATION_MAX = 0.5;', 'constantes : la machine est calme jusqu\'à la moitié du processeur'],
  [L, 'export const ECHANTILLON_MS = 1500;', 'export const ECHANTILLON_MS = 0;', 'constantes : l\'occupation est mesurée sur zéro milliseconde'],

  // --- l'occupation de la machine
  [L, 'const somme = times.user + times.nice + times.sys + times.idle + times.irq;', 'const somme = times.user + times.nice + times.idle + times.irq;', 'occupation : le temps système ne compte pas'],
  [L, 'const somme = times.user + times.nice + times.sys + times.idle + times.irq;', 'const somme = times.user + times.sys + times.idle + times.irq;', 'occupation : le temps « nice » ne compte pas'],
  [L, 'const somme = times.user + times.nice + times.sys + times.idle + times.irq;', 'const somme = times.user + times.nice + times.sys + times.idle;', 'occupation : le temps d\'interruptions ne compte pas'],
  [L, 'const somme = times.user + times.nice + times.sys + times.idle + times.irq;', 'const somme = times.user + times.nice + times.sys + times.irq;', 'occupation : le temps au repos n\'est pas dans le total'],
  [L, 'occupe += somme - times.idle;', 'occupe += somme;', 'occupation : le repos compte comme occupé'],
  [L, 'total += somme;', 'total += times.user;', 'occupation : le total est le seul temps utilisateur'],
  [L, 'if (!(b.total > a.total)) return null;', 'if (b.total < a.total) return null;', 'occupation : deux instantanés identiques donnent NaN, non « inconnue »'],
  [L, 'return (b.occupe - a.occupe) / (b.total - a.total);', 'return b.occupe / b.total;', 'occupation : le cumul depuis le démarrage, non l\'écart entre les instantanés'],
  [L, 'return occupationEntre(avant, lire());', 'return occupationEntre(lire(), avant);', 'mesure : les deux instantanés sont pris à l\'envers'],
  [L, 'return occupationEntre(avant, lire());', 'return occupationEntre(avant, avant);', 'mesure : le second instantané est le premier'],
  [L, 'ms = ECHANTILLON_MS,', 'ms = 0,', 'mesure : la fenêtre par défaut est nulle'],
  [L, 'attendre(ms);', 'attendre(0);', 'mesure : l\'attente demandée n\'est pas respectée'],

  // --- le refus de mesurer sous charge
  [L, "if (occupation === null || occupation === undefined || Number.isNaN(occupation)) return", "if (occupation === undefined || Number.isNaN(occupation)) return", 'refus : une occupation inconnue (null) passe pour une machine calme'],
  [L, "if (occupation === null || occupation === undefined || Number.isNaN(occupation)) return", "if (occupation === null || Number.isNaN(occupation)) return", 'refus : une occupation absente (undefined) passe pour une machine calme'],
  [L, "if (occupation === null || occupation === undefined || Number.isNaN(occupation)) return", "if (occupation === null || occupation === undefined) return", 'refus : une occupation NaN passe pour une machine calme'],
  [L, 'if (occupation > max) {', 'if (occupation >= max) {', 'refus : au seuil exact, la machine n\'est plus calme'],
  [L, 'if (occupation > max) {', 'if (occupation > max * 2) {', 'refus : le seuil est doublé'],
  [L, '{ max = OCCUPATION_MAX } = {}', '{ max = 1 } = {}', 'refus : le seuil par défaut n\'en est pas un'],
  [L, '${Math.round(occupation * 100)} % du processeur occupé, ${Math.round(max * 100)} % au plus', '${occupation} % du processeur occupé, ${max} % au plus', 'refus : la part n\'est pas dite en pourcentage'],
  [L, 'Rejouer quand plus rien ne tourne, ou en mode CI (--ci), qui ne mesure qu\'un ordre de grandeur.', 'Rejouer quand plus rien ne tourne.', 'refus : le mode qui mesure quand même n\'est pas dit'],

  // --- le budget retenu et la limite dure
  [L, '(ci ? budgetMs * FACTEUR_CI : budgetMs);', '(ci ? budgetMs : budgetMs);', 'budget : le mode CI garde le budget fin'],
  [L, '(ci ? budgetMs * FACTEUR_CI : budgetMs);', '(ci ? budgetMs * FACTEUR_CI : budgetMs * FACTEUR_CI);', 'budget : le mode local est multiplié aussi'],
  [L, 'Math.max(LIMITE_DURE_MIN_MS, FACTEUR_LIMITE * budgetRetenu(budgetMs, ci))', 'Math.min(LIMITE_DURE_MIN_MS, FACTEUR_LIMITE * budgetRetenu(budgetMs, ci))', 'limite : le plus petit des deux, non le plus grand'],
  [L, 'Math.max(LIMITE_DURE_MIN_MS, FACTEUR_LIMITE * budgetRetenu(budgetMs, ci))', 'Math.max(LIMITE_DURE_MIN_MS, FACTEUR_LIMITE * budgetMs)', 'limite : calculée sur le budget fin même en mode CI'],
  [L, 'Math.max(LIMITE_DURE_MIN_MS, FACTEUR_LIMITE * budgetRetenu(budgetMs, ci))', 'FACTEUR_LIMITE * budgetRetenu(budgetMs, ci)', 'limite : aucun plancher'],

  // --- le jugement d'un cas
  [L, "if (resultat.statut === 'limite') return", "if (false) return", 'jugement : un cas tué à la limite est dit fautif'],
  [L, "if (resultat.statut !== 'ok') return", "if (resultat.statut === 'echec') return", 'jugement : un statut inconnu est jugé sur sa durée'],
  [L, 'if (resultat.dureeMs > retenu)', 'if (resultat.dureeMs >= retenu)', 'jugement : le budget exact est dépassé'],
  [L, 'if (resultat.dureeMs > retenu)', 'if (resultat.dureeMs > retenu * 2)', 'jugement : le budget est doublé'],
  [L, "return { verdict: 'limite', dureeMs: null, budgetMs: retenu, raison: resultat.raison };", "return { verdict: 'limite', dureeMs: null, budgetMs, raison: resultat.raison };", 'jugement : un cas tué dit le budget fin en mode CI'],
  [L, "return { verdict: 'lent', dureeMs: resultat.dureeMs, budgetMs: retenu, raison: null };", "return { verdict: 'lent', dureeMs: resultat.dureeMs, budgetMs, raison: null };", 'jugement : un cas lent dit le budget fin en mode CI'],

  // --- la lecture des fichiers de budgets
  [L, ".filter((n) => n.endsWith('.budget.mjs')).sort()", ".filter((n) => n.endsWith('.mjs')).sort()", 'cas : tout fichier .mjs du dossier est un fichier de budgets'],
  [L, ".filter((n) => n.endsWith('.budget.mjs')).sort()", ".filter((n) => true).sort()", 'cas : tout fichier du dossier est un fichier de budgets'],
  [L, '!Array.isArray(module.cas) || !module.cas.length', '!module.cas.length', 'cas : un fichier sans `cas` fait planter au lieu de se dire'],
  [L, '!Array.isArray(module.cas) || !module.cas.length', '!Array.isArray(module.cas)', 'cas : une liste vide est acceptée'],
  [L, "typeof c.nom !== 'string' || !c.nom ||", '!c.nom ||', 'cas : un nom qui n\'est pas une chaîne est accepté'],
  [L, "typeof c.nom !== 'string' || !c.nom ||", "typeof c.nom !== 'string' ||", 'cas : un nom vide est accepté'],
  [L, "typeof c.executer !== 'function' || !(c.budgetMs > 0)", '!(c.budgetMs > 0)', 'cas : un cas sans executer est accepté'],
  [L, "typeof c.executer !== 'function' || !(c.budgetMs > 0)", "typeof c.executer !== 'function' || c.budgetMs < 0", 'cas : un budget nul ou absent est accepté'],
  [L, '${nom}, cas ${indice + 1} :', '${nom}, cas ${indice} :', 'cas : le numéro du cas mal formé est décalé'],
  [L, 'ignore: (await c.ignorerSi?.()) ?? null', 'ignore: null', 'cas : la raison d\'ignorer un cas est perdue'],
  [L, 'ignore: (await c.ignorerSi?.()) ?? null', 'ignore: c.ignorerSi?.() ?? null', 'cas : ignorerSi asynchrone n\'est pas attendu'],

  // --- le processus d'un cas
  [L, "if (r.error?.code === 'ETIMEDOUT') return", "if (false) return", 'processus : la limite dure n\'est pas reconnue'],
  [L, 'const ligne = (r.stdout ?? \'\').split(\'\\n\').filter(Boolean).pop() ?? \'\';', 'const ligne = (r.stdout ?? \'\').split(\'\\n\').filter(Boolean).shift() ?? \'\';', 'processus : la première ligne de sortie, non la dernière'],
  [L, 'if (r.status === 0 && rendu && Number.isFinite(rendu.dureeMs)) return', 'if (rendu && Number.isFinite(rendu.dureeMs)) return', 'processus : un code de sortie non nul passe après une durée dite'],
  [L, 'if (r.status === 0 && rendu && Number.isFinite(rendu.dureeMs)) return', 'if (r.status === 0 && rendu) return', 'processus : une durée absente est une durée'],
  [L, "raison: rendu?.erreur ?? (r.signal ? `tué par ${r.signal}` : ", "raison: (r.signal ? `tué par ${r.signal}` : ", 'processus : la raison que le cas a dite est perdue'],
  [L, "(r.signal ? `tué par ${r.signal}` : `sorti avec le code ${r.status}", "(`sorti avec le code ${r.status}", 'processus : le signal qui a tué le cas n\'est pas dit'],
  [L, ".slice(-3).join(' | ').slice(-400);", ".slice(0, 1).join(' | ').slice(-400);", 'processus : la première ligne d\'erreur, non les dernières'],
  [L, ".slice(-3).join(' | ').slice(-400);", ".slice(-3).join(' | ');", 'processus : la fin de l\'erreur n\'est pas bornée'],
  [L, "timeout: limiteMs, killSignal: 'SIGKILL'", "killSignal: 'SIGKILL'", 'processus : aucune limite dure'],

  // --- la commande
  [L, "const ci = argv.includes('--ci');", 'const ci = false;', 'commande : --ci est ignoré'],
  [L, "argv.filter((a) => !a.startsWith('--'))[0]", 'argv[argv.length - 1]', 'commande : le filtre est le dernier argument, même une option'],
  [L, 'if (!cas.length) {', 'if (false) {', 'commande : aucun cas est un succès'],
  [L, "return 2;\n  }\n  if (argv.includes('--liste')) {", "return 1;\n  }\n  if (argv.includes('--liste')) {", 'commande : aucun cas sort en 1, non en 2'],
  [L, "if (argv.includes('--liste')) {", 'if (false) {', 'commande : --liste mesure'],
  [L, 'if (!ci) {\n    const refus = refusSousCharge(occupation());', 'if (true) {\n    const refus = refusSousCharge(occupation());', 'commande : le mode CI refuse sous charge'],
  [L, 'if (!ci) {\n    const refus = refusSousCharge(occupation());', 'if (false) {\n    const refus = refusSousCharge(occupation());', 'commande : le mode local ne refuse jamais sous charge'],
  [L, "erreur(`Budgets non mesurés : ${refus}`);\n      return 2;", "erreur(`Budgets non mesurés : ${refus}`);\n      return 1;", 'commande : le refus sous charge sort en 1, non en 2'],
  [L, 'sortie(ci ? `Mode CI : chaque budget multiplié par ${FACTEUR_CI}, aucun refus sous charge.\\n` : \'Mode local : le budget de chaque cas, machine au calme.\\n\');', 'sortie(\'\');', 'commande : le mode n\'est pas dit'],
  [L, '      sortie(`IGNORÉ    ${c.nom}  (${c.ignore})`);\n      continue;', '      sortie(`IGNORÉ    ${c.nom}  (${c.ignore})`);', 'commande : un cas ignoré est joué aussi'],
  [L, '      ignores += 1;\n', '', 'commande : un cas ignoré n\'est pas compté à part'],
  [L, "const joues = cas.length - ignores;", "const joues = cas.length;", 'commande : les cas ignorés comptent parmi les joués'],
  [L, "if (r.verdict !== 'passe') mauvais += 1;", "if (r.verdict === 'echec') mauvais += 1;", 'commande : un cas trop lent ou tué n\'est pas un cas non tenu'],
  [L, "if (r.verdict !== 'passe') mauvais += 1;", "if (r.verdict === 'lent') mauvais += 1;", 'commande : un cas fautif ou tué n\'est pas un cas non tenu'],
  [L, 'return mauvais ? 1 : 0;', 'return 0;', 'commande : un cas non tenu sort en 0'],
  [L, "passe: 'ok       ', lent: 'TROP LENT', echec: 'FAUTIF   ', limite: 'TUÉ      '", "passe: 'ok       ', lent: 'ok       ', echec: 'FAUTIF   ', limite: 'TUÉ      '", 'commande : un cas trop lent est dit tenu'],
  [L, "passe: 'ok       ', lent: 'TROP LENT', echec: 'FAUTIF   ', limite: 'TUÉ      '", "passe: 'ok       ', lent: 'TROP LENT', echec: 'ok       ', limite: 'TUÉ      '", 'commande : un cas fautif est dit tenu'],
  [L, "`${Math.round(r.dureeMs)} ms sur ${r.budgetMs} ms  `", "''", 'commande : la durée et le budget ne sont pas dits'],
  [L, "r.dureeMs === null ? ''", "r.dureeMs === undefined ? ''", 'commande : un cas tué dit une durée nulle'],

  // --- le processus d'un cas (cas-budget.mjs)
  [C, 'Number.isFinite(rendu?.dureeMs) ? rendu.dureeMs : mesure', 'mesure', 'cas : la durée que le cas dit lui-même est ignorée'],
  [C, 'const debut = performance.now();', 'const debut = 0;', 'cas : le chargement du module est mesuré'],
  [C, "if (!cas) throw new Error(`${fichier} n'a pas de cas ${indice}`);", '', 'cas : un cas absent n\'est pas dit'],
  [C, ".split('\\n')[0].slice(0, 500)", ".slice(0, 500)", 'cas : l\'erreur est dite sur toutes ses lignes'],
  [C, ".split('\\n')[0].slice(0, 500)", ".split('\\n')[0].slice(0, 5)", 'cas : l\'erreur est coupée à cinq caractères'],

  // --- le script
  [V, 'verifierBudgets({ argv: process.argv.slice(2) })', 'verifierBudgets({ argv: process.argv.slice(3) })', 'script : le premier argument est perdu'],
  [V, 'process.exitCode = await', 'await', 'script : le code de sortie de la commande est perdu'],
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'outillage des budgets', fichiers: ['tests/budgets-outillage.test.mjs'] }],
  exigerChromium: false,
  partie,
  // Un mutant qui lance tous les budgets réels (une commande qui ignore `--liste`) ou qui laisse un cas boucler sans fin n'est arrêté que par la limite du cas ou du lancement : 3 minutes au plus, dit à part.
  delaiMs: 180000,
});
