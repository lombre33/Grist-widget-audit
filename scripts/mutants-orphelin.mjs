#!/usr/bin/env node
/**
 * Rejoue les mutants du contrôle « aucun Chromium orphelin » de
 * docker/ci/verifier.sh : le motif à crochets (qui ne se reconnaît pas
 * lui-même sous `bash -c`), l'échec quand un processus survit, et le fait que
 * cmd_plafond passe par la même fonction que les autres contrôles. Chaque
 * point est gardé par `tests/orphelin-pgrep.test.mjs` (méthode :
 * `scripts/lib/rejouer-mutants.mjs`). Pas de Chromium requis.
 *
 * Usage : node scripts/mutants-orphelin.mjs [expression régulière sur le libellé]
 */
import { lireArguments, rejouerMutants, DOSSIERS_COPIES } from './lib/rejouer-mutants.mjs';

const V = 'docker/ci/verifier.sh';
const TESTS = ['tests/orphelin-pgrep.test.mjs'];
const TEST_FONCTION = "  if pgrep -f '[/]ms-playwright/chromium-' >/dev/null; then\n    pgrep -af '[/]ms-playwright/chromium-' | cut -c1-200 || true\n    echec \"un Chromium survit $1\"\n  fi";

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  [V, TEST_FONCTION, TEST_FONCTION.replaceAll('[/]ms-playwright', '/ms-playwright'), 'fonction : ancien motif, qui se reconnaît lui-même'],
  [V, TEST_FONCTION, "  if false; then\n    pgrep -af '[/]ms-playwright/chromium-' | cut -c1-200 || true\n    echec \"un Chromium survit $1\"\n  fi", 'fonction : ne cherche rien'],
  [V, TEST_FONCTION, TEST_FONCTION.replace('    echec "un Chromium survit $1"\n', '    true\n'), 'fonction : un survivant ne fait pas échouer'],
  [V, '  aucun_chromium_orphelin "à la destruction du conteneur, coupé au plafond"\n', "  if pgrep -f '/ms-playwright/chromium-' >/dev/null; then echec \"un Chromium survit\"; fi\n", 'plafond : motif recopié, sans les crochets'],
];
const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants[0] ? new RegExp(restants[0]) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests orphelin', fichiers: TESTS }],
  exigerChromium: false,
  dossiers: [...DOSSIERS_COPIES, 'docker'],
  partie,
});
