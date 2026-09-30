#!/usr/bin/env node
/**
 * Rejoue les mutants de l'axe D « qui ne peut pas dire ce qu'il a mesuré ou
 * qu'un widget empêche de mesurer » : chaque défaut corrigé (cause d'un échec
 * dite, D-TIMEOUT-01 émis et bloquant, raison d'un axe non exécuté dans les
 * trois rapports, absence jamais écrite comme une mesure) est gardé par un test
 * de `tests/axe-d-bloque.test.mjs` (méthode : `scripts/lib/rejouer-mutants.mjs`).
 * Les tests lancent Chromium : GWAUDIT_CHROMIUM_PATH est requis, et la suite
 * ciblée doit être verte et sans test sauté avant le premier mutant.
 *
 * Usage : node scripts/mutants-axe-d.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, DOSSIERS_COPIES } from './lib/rejouer-mutants.mjs';

const D = 'src/runtime/dynamique.js';
const H = 'src/rapport/html.js';
const M = 'src/rapport/markdown.js';
const B = 'bin/gwaudit.js';
const TESTS = ['tests/axe-d-bloque.test.mjs'];

const TIMEOUT = "regle: 'D-TIMEOUT-01', axe: 'D', severite: 'critique', bloquant: true, confiance: 'prouve', axesEmpeches: ['D', 'F'],";

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- la cause d'un échec
  [D, "const texte = [...new Set(retenues)].join(' ; ').slice(0, max);", "const texte = retenues.slice(0, 1).join(' ; ').slice(0, max);", 'cause : première ligne seulement'],
  [D, '|| /^<launch(ing|ed)>/i.test(l) ', '', 'cause : la ligne de commande de Chromium reprise'],
  [D, "console.error(`⚠ Échec du lancement de Chromium (tentative ${tentative}/${TENTATIVES_LANCEMENT}), nouvel essai : ${resumerCauseErreur(e, 400)}`);", "console.error(`⚠ Échec du lancement de Chromium (tentative ${tentative}/${TENTATIVES_LANCEMENT}), nouvel essai : ${String(e?.message ?? e).split('\\n')[0]}`);", "relance : l'avertissement ne cite pas la cause"],
  [D, 'constat: resumerCauseErreur(e),', "constat: String(e?.message ?? e).split('\\n')[0],", "D-INDISPONIBLE : première ligne du message"],

  // --- le widget qui bloque
  [D, "else if (e?.name === 'TimeoutError') { delaiDepasse = 'chargement'; causeDelai = resumerCauseErreur(e, 200); }\n", '', 'blocage au chargement : le TimeoutError de goto retombe dans le filet générique'],
  [D, TIMEOUT, TIMEOUT.replace("severite: 'critique', bloquant: true", "severite: 'majeur'"), 'D-TIMEOUT-01 : majeur, non bloquant'],
  [D, TIMEOUT, TIMEOUT.replace('bloquant: true', 'bloquant: false'), 'D-TIMEOUT-01 : critique mais non bloquant'],
  [D, TIMEOUT, TIMEOUT.replace(" axesEmpeches: ['D', 'F'],", ''), 'D-TIMEOUT-01 : aucun axe empêché'],
  [D, TIMEOUT, TIMEOUT.replace("['D', 'F']", "['D']"), 'D-TIMEOUT-01 : F pas empêché'],
  [D, TIMEOUT, TIMEOUT.replace("['D', 'F']", "['F']"), 'D-TIMEOUT-01 : D pas empêché'],
  [D, TIMEOUT, TIMEOUT.replace("['D', 'F']", "['D', 'F', 'C']"), 'D-TIMEOUT-01 : C empêché à tort'],
  [D, "Un widget qui empêche de mesurer ce qu'il fait se juge comme du code illisible : on ne peut pas le déclarer conforme. ", '', 'D-TIMEOUT-01 : la raison du caractère bloquant n\'est plus dite'],
  [D, 'const DELAI_CHARGEMENT_MS = Math.max(1_000, DELAI_GLOBAL_AXE_D_MS - 15_000);', 'const DELAI_CHARGEMENT_MS = 30_000;', 'délai de chargement : fixe au lieu de dérivé du délai global'],
  [D, 'timeout: DELAI_CHARGEMENT_MS });', 'timeout: 30000 });', 'goto : délai en dur'],
  [D, '    if (!scenarioComplet) return constats;\n', '', "D-RESEAU-00 écrit après un scénario interrompu"],
  [D, "if (brut.a11y == null && !brut.a11yErreur) brut.a11yErreur =", "if (false) brut.a11yErreur =", "accessibilité non mesurée : rien n'est dit"],
  [D, 'constats.push(...constatsReseau(brut.requetes, brut.substitutionApiGrist, { scenarioComplet: !delaiDepasse }));', 'if (!delaiDepasse) constats.push(...constatsReseau(brut.requetes, brut.substitutionApiGrist, { scenarioComplet: !delaiDepasse }));', 'ce qui a été observé avant le blocage est jeté'],

  // --- la raison d'un axe non exécuté, dans chacun des rapports
  [B, '      constats.push(constatAxeDIgnoreParOption());\n', '', "--sans-dynamique : aucune raison au rapport"],
  [H, "${constats.length ? `<div class=\"liste-constats\">${grouperEtRendre(constats)}</div>` : ''}", "${axe.nonExecute ? '' : `<div class=\"liste-constats\">${grouperEtRendre(constats)}</div>`}", 'HTML : les constats d\'un axe non exécuté masqués'],
  [M, '      if (!constats.length) continue;\n', '      continue;\n', "Markdown : les constats d'un axe non exécuté masqués"],
];
const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants[0] ? new RegExp(restants[0]) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests axe D', fichiers: TESTS }],
  exigerChromium: true,
  partie,
  dossiers: [...DOSSIERS_COPIES, 'bin', 'ressources'],
});
