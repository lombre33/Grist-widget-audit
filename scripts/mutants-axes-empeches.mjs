#!/usr/bin/env node
/**
 * Rejoue les mutants de la mesure empêchée (`axesEmpeches`) : la validation d'un constat qui l'annonce
 * (liste de codes connus, bloquant), le zéro de chaque axe empêché et ce qu'il garde (`scoreMesure`,
 * `causes`), l'axe non lancé qui reste non exécuté, le motif du verdict, la feuille de route (la cause
 * rend l'axe, les autres règles de l'axe ne gagnent rien), les trois rapports, la comparaison de deux
 * rapports (`--diff` et l'outil de mesure avant/après). Chaque mutant pose, sur la ligne qui porte le
 * choix, le défaut plausible : un des essais doit alors échouer (méthode : `scripts/lib/rejouer-mutants.mjs`).
 * Aucun navigateur n'est requis. Le constat D-TIMEOUT-01, qui empêche D et F, a ses mutants dans
 * `scripts/mutants-axe-d.mjs`.
 *
 * Usage : node scripts/mutants-axes-empeches.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const MODELE = 'src/moteur/modele.js';
const NOTATION = 'src/moteur/notation.js';
const PRIO = 'src/moteur/priorisation.js';
const JSON_ = 'src/rapport/json.js';
const HTML = 'src/rapport/html.js';
const MD = 'src/rapport/markdown.js';
const DIFF = 'src/rapport/diff.js';
const COMPARER = 'scripts/lib/comparer-rapports.mjs';
const TESTS = ['tests/axes-empeches.test.mjs', 'tests/comparer-rapports.test.mjs', 'tests/diff.test.mjs'];

const MUTANTS = [
  // --- ce qu'un constat a le droit d'annoncer
  dansLigne(MODELE, 'if (!Array.isArray(demandes)) throw', 'if (!Array.isArray(demandes))', 'if (false)', 'modèle : une chaîne ou un objet passe pour une liste d\'axes'),
  dansLigne(MODELE, 'Axe inconnu dans axesEmpeches', 'if (!AXES[code])', 'if (false)', 'modèle : un axe inconnu est ignoré'),
  dansLigne(MODELE, 'if (demandes.length && !c.bloquant) {', 'demandes.length && !c.bloquant', 'false', 'modèle : un constat qui empêche sans être bloquant est accepté'),
  dansLigne(MODELE, 'if (demandes.length && !c.bloquant) {', 'demandes.length && !c.bloquant', '!c.bloquant', 'modèle : tout constat non bloquant est refusé, même sans axe empêché'),
  dansLigne(MODELE, 'return Object.keys(AXES).filter((code) => demandes.includes(code));', 'Object.keys(AXES).filter((code) => demandes.includes(code))', '[...demandes]', 'modèle : les axes ne sont ni rangés ni dédoublonnés'),
  dansLigne(MODELE, 'const demandes = c.axesEmpeches ?? [];', '?? []', "?? ['D']", 'modèle : par défaut, l\'axe D est empêché'),

  // --- la notation
  dansLigne(NOTATION, 'if (axesNonExecutes.has(code)) continue;', 'if (axesNonExecutes.has(code)) continue;', '', 'notation : un axe que l\'utilisateur n\'a pas lancé est dit empêché par le widget'),
  dansLigne(NOTATION, '        score: 0,', 'score: 0,', 'score: parAxe[code].score,', 'notation : l\'axe empêché garde sa note'),
  dansLigne(NOTATION, 'scoreMesure: parAxe[code].score,', 'scoreMesure: parAxe[code].score,', 'scoreMesure: 0,', 'notation : ce que l\'axe vaut sur ce qui a pu être lu est perdu'),
  dansLigne(NOTATION, '        empeche: true,', 'empeche: true,', '', 'notation : l\'axe empêché n\'est pas marqué'),
  dansLigne(NOTATION, 'causes: empeches.get(code).map(causeDe),', 'empeches.get(code).map(causeDe)', '[]', 'notation : l\'axe empêché ne nomme aucune cause'),
  dansLigne(NOTATION, 'return { uid: c.uid, regle: c.regle', ', fichier: c.fichier, ligne: c.ligne }', ' }', 'notation : la cause ne dit ni fichier ni ligne'),
  dansLigne(NOTATION, 'return { uid: c.uid, regle: c.regle', 'uid: c.uid, ', '', 'notation : la cause ne porte pas son identifiant (le lien du rapport ne mène nulle part)'),
  dansLigne(NOTATION, 'axesEmpeches: Object.keys(AXES).filter', 'Object.keys(AXES).filter((code) => empeches.has(code))', '[]', 'notation : la liste des axes empêchés est vide'),
  dansLigne(NOTATION, 'if (empeches.size) {', 'if (empeches.size) {', 'if (false) {', 'motif : une mesure empêchée n\'est pas dite'),
  dansLigne(NOTATION, 'motif = `⛔ Mesure empêchée par le widget', "${plusieurs ? 'ces axes n\\'ont' : 'cet axe n\\'a'}", "${plusieurs ? 'cet axe n\\'a' : 'ces axes n\\'ont'}", 'motif : le singulier et le pluriel permutés'),
  dansLigne(NOTATION, "causes.length > 1 ? ` (et ${causes.length - 1} autre${causes.length > 2 ? 's' : ''})`", "causes.length > 2 ? 's' : ''", "'s'", 'motif : « et 1 autres »'),
  dansLigne(NOTATION, "causes.length > 1 ? ` (et ${causes.length - 1} autre${causes.length > 2 ? 's' : ''})`", "causes.length > 2 ? 's' : ''", "''", 'motif : « et 2 autre »'),
  dansLigne(NOTATION, "causes.length > 1 ? ` (et ${causes.length - 1} autre${causes.length > 2 ? 's' : ''})`", 'causes.length > 1 ?', 'false ?', 'motif : les autres causes d\'un axe ne sont pas comptées'),
  dansLigne(NOTATION, 'motif = `⛔ Mesure empêchée par le widget', 'et la cause est elle-même un point bloquant. ${motif}`', 'et la cause est elle-même un point bloquant.`', 'motif : le motif du verdict d\'avant est perdu'),

  // --- la feuille de route
  dansLigne(PRIO, 'let gainPondere = ', '(axe.empeche ? 0 : scoreSansCetteRegle - axe.score)', '(scoreSansCetteRegle - axe.score)', 'route : une règle d\'un axe à 0 gagne comme si l\'axe était mesuré'),
  dansLigne(PRIO, 'return Object.values(notation.parAxe).filter', 'x.causes.every((c) => c.regle === regle)', 'x.causes.some((c) => c.regle === regle)', 'route : une règle rétablit un axe qu\'une autre règle tient aussi à 0'),
  dansLigne(PRIO, 'return Object.values(notation.parAxe).filter', 'x.empeche && ', '', 'route : un axe mesuré passe pour empêché'),
  dansLigne(PRIO, 'for (const x of retablis) gainPondere +=', '(x.code === axe.code ? d.penalite : 0)', '0', 'route : la pénalité de la cause elle-même reste dans l\'axe rétabli'),
  dansLigne(PRIO, 'for (const x of retablis) gainPondere +=', 'for (const x of retablis)', 'for (const x of [])', 'route : la cause ne rend rien aux axes qu\'elle tient à 0'),
  dansLigne(PRIO, 'for (const x of retablis) gainPondere +=', '* x.poids;', '* axe.poids;', 'route : un axe rétabli compte au poids de l\'axe de la règle'),
  dansLigne(PRIO, 'retabliMesure: retablis.map', 'retablis.map((x) => x.code)', '[]', 'route : les axes rétablis ne sont pas dits'),

  // --- les rapports
  dansLigne(JSON_, 'if (a.empeche) Object.assign', 'if (a.empeche)', 'if (false)', 'JSON : les axes empêchés ne sont pas marqués'),
  dansLigne(JSON_, 'if (a.empeche) Object.assign', 'scoreMesure: a.scoreMesure, ', '', 'JSON : ce que l\'axe vaut sur ce qui a pu être lu est perdu'),
  dansLigne(JSON_, 'if (a.empeche) Object.assign', ', causes: a.causes', '', 'JSON : les causes sont perdues'),
  dansLigne(JSON_, 'axesEmpeches: notation.axesEmpeches,', 'notation.axesEmpeches', '[]', 'JSON : la liste des axes empêchés est vide au sommet'),
  dansLigne(HTML, 'const partiel = notation.axesNonExecutes.length > 0', ' || (notation.axesEmpeches ?? []).length > 0', '', 'HTML : le motif d\'une mesure empêchée n\'est pas mis en valeur'),
  dansLigne(HTML, '${axe.empeche ? blocAxeEmpeche(axe) : \'\'}', 'axe.empeche ? blocAxeEmpeche(axe) : \'\'', '\'\'', 'HTML : l\'axe empêché ne le dit pas sous sa note'),
  dansLigne(HTML, 'class="metre-piste" role="img"', "axe.empeche ? 'noté 0 sur 100, mesure empêchée par le widget' : ", '', 'HTML : la jauge lue à voix haute dit 0 sans dire pourquoi'),
  dansLigne(HTML, 'class="metre-valeur"', "axe.empeche ? '0/100 · mesure empêchée' : ", '', 'HTML : la jauge affiche 0/100 sans dire pourquoi'),
  dansLigne(HTML, 'Sur ce qui a pu être lu, il vaut', '${axe.scoreMesure}/100', '${axe.score}/100', 'HTML : ce que l\'axe vaut sur ce qui a pu être lu est dit 0'),
  dansLigne(HTML, 'const causes = axe.causes.map', 'href="#${c.uid}"', 'href="#${c.regle}"', 'HTML : le lien vers la cause ne mène nulle part'),
  dansLigne(MD, 'if (axe.empeche) {', 'if (axe.empeche) {', 'if (false) {', 'Markdown : l\'axe empêché ne le dit pas'),
  dansLigne(MD, '> ⛔ Mesure empêchée par le widget', '${axe.scoreMesure}/100', '${axe.score}/100', 'Markdown : ce que l\'axe vaut sur ce qui a pu être lu est dit 0'),
  dansLigne(MD, '> ⛔ Mesure empêchée par le widget', "axe.causes.map((c) => `[${c.regle}] ${c.titre}`).join(' ; ')", "''", 'Markdown : la cause n\'est pas dite'),

  // --- la comparaison de deux rapports
  dansLigne(DIFF, 'empecheAvant: Boolean(', 'Boolean(ancien.axes?.[code]?.empeche)', 'false', 'comparaison : l\'axe empêché de l\'ancien rapport n\'est pas vu'),
  dansLigne(DIFF, 'empecheAvant: Boolean(', 'Boolean(nouveau.axes?.[code]?.empeche)', 'false', 'comparaison : l\'axe empêché du nouveau rapport n\'est pas vu'),
  dansLigne(DIFF, 'const marque = ', "empeche ? ' ⛔' : ''", "''", 'comparaison : la note 0 d\'un axe empêché n\'est pas marquée'),
  dansLigne(DIFF, 'if (Object.values(diff.deltaParAxe).some(', 'if (Object.values(diff.deltaParAxe).some((d) => d.empecheAvant || d.empecheApres))', 'if (true)', 'comparaison : la légende du ⛔ s\'écrit toujours'),
  dansLigne(DIFF, 'if (Object.values(diff.deltaParAxe).some(', 'd.empecheAvant || d.empecheApres', 'd.empecheAvant', 'comparaison : la légende oublie le nouveau rapport'),
  dansLigne(COMPARER, 'const DEFAUTS = ', '{ axesEmpeches: [] }', '{}', 'outil avant/après : un rapport sans axesEmpeches n\'est pas un rapport à []'),
  dansLigne(COMPARER, 'export const CHAMPS_LUS = ', ", 'axesEmpeches']", ']', 'outil avant/après : un constat qui se met à empêcher un axe n\'est pas vu'),
  dansLigne(COMPARER, "a.empeche ? `⛔(${a.scoreMesure})` : ''", "a.empeche ? `⛔(${a.scoreMesure})` : ''", "''", 'outil avant/après : un axe empêché se lit comme un 0 mesuré'),
  dansLigne(COMPARER, "a.empeche ? `⛔(${a.scoreMesure})` : ''", '(${a.scoreMesure})', '', 'outil avant/après : ce que l\'axe empêché vaut sur ce qui a pu être lu n\'est pas comparé'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de la mesure empêchée', fichiers: TESTS }],
  exigerChromium: false,
  partie,
});
