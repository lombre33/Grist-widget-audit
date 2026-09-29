// Aide des tests qui lancent Chromium (axe D).
//
// Le bac à sable natif de Chromium est actif par défaut dans gwaudit
// (src/runtime/dynamique.js). Ces tests vérifient le comportement du widget
// audité, pas le bac à sable : sous root, ou là où les espaces de noms
// utilisateur sont interdits (ce dépôt en développement cloud), Chromium ne
// peut pas démarrer avec — ils posent donc EUX-MÊMES la dérogation explicite,
// ce que le rapport dira (D-INDISPONIBLE-BAC-A-SABLE). Importer ce module
// suffit. Les tests du bac à sable lui-même sont dans
// bac-a-sable-chromium.test.mjs et ne l'importent pas.
import assert from 'node:assert/strict';

process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX = '1';

/**
 * À appeler quand l'axe D n'a pas pu s'exécuter : la suite ÉCHOUE, elle ne
 * saute pas — un test de l'axe D qui ne tourne pas ne prouve rien, et un saut
 * sortirait avec le code 0. Seul GWAUDIT_SUITE_SANS_CHROMIUM=1, posée
 * explicitement (machine sans Chromium), autorise le saut, et il se voit.
 */
export function axeDNonExecute(t, constats = []) {
  const raison = constats.find((c) => c.regle === 'D-INDISPONIBLE')?.constat ?? '(raison inconnue)';
  if (process.env.GWAUDIT_SUITE_SANS_CHROMIUM === '1') {
    t.skip(`Axe D non exécutable (GWAUDIT_SUITE_SANS_CHROMIUM=1) : ${raison}`);
    return;
  }
  assert.fail(`Axe D non exécuté : ${raison} — ce test ne prouve rien sans lui. Sur une machine sans Chromium, GWAUDIT_SUITE_SANS_CHROMIUM=1 saute explicitement ces tests.`);
}
