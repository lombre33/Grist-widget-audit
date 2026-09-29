#!/usr/bin/env node
/**
 * Rejoue les mutants du bac à sable de Chromium : chaque décision (actif par
 * défaut, dérogation explicite et seulement la valeur 1, refus du bac à sable
 * nommé avec sa cause et ses deux issues, marqueur de dérogation gardé quelle
 * que soit l'issue de l'axe) est gardée par `tests/bac-a-sable-chromium.test.mjs`
 * (méthode : `scripts/lib/rejouer-mutants.mjs`). La suite lance Chromium :
 * GWAUDIT_CHROMIUM_PATH est requis, et elle doit être verte et sans test sauté
 * avant le premier mutant.
 *
 * Les cas qui exigent un Chromium démarré AVEC son bac à sable (aucun marqueur de
 * dérogation quand il n'y en a pas) tournent sous un utilisateur sans privilège
 * quand la suite est lancée en root (voir enfantAvecBacASable dans le test).
 *
 * Ce que ce script ne peut PAS rejouer : le lancement Windows
 * (`launchServer({ chromiumSandbox: bacASableChromium() })`) ne s'exécute que
 * sous Windows. Un mutant qui l'affaiblirait survivrait ici ; c'est le job
 * « windows » de .github/workflows/image-v2.yml qui le voit (niveau d'intégrité
 * des rendus, `--no-sandbox` dans la ligne de commande — la même sonde voit
 * l'un et l'autre sous la dérogation, c'est son témoin).
 *
 * Usage : node scripts/mutants-bac-a-sable.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, DOSSIERS_COPIES } from './lib/rejouer-mutants.mjs';

const D = 'src/runtime/dynamique.js';
const TESTS = ['tests/bac-a-sable-chromium.test.mjs'];

const MOTIF = "const MOTIF_CAUSE_BAC_A_SABLE = /No usable sandbox|Failed to move to new namespace|sys_chroot|Running as root without --no-sandbox|sandbox_host_linux|zygote_host_impl_linux|setuid sandbox|creating a user namespace|CLONE_NEWUSER/i;";
const SIGNES = ['No usable sandbox', 'Failed to move to new namespace', 'sys_chroot', 'Running as root without --no-sandbox', 'sandbox_host_linux', 'zygote_host_impl_linux', 'setuid sandbox', 'creating a user namespace', 'CLONE_NEWUSER'];
const SANS_SIGNE = (signe) => MOTIF.replace(new RegExp(`\\|?${signe.replace(/[-]/g, '\\-')}(?=\\||/)`), '').replace('= /|', '= /');

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- actif par défaut, dérogation explicite
  [D, "return process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX !== '1';", 'return false;', 'défaut : jamais de bac à sable'],
  [D, "return process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX !== '1';", 'return true;', 'dérogation : ignorée'],
  [D, "return process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX !== '1';", 'return !process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX;', 'dérogation : toute valeur non vide déroge'],
  [D, "return process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX !== '1';", "return String(process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX ?? '').trim() !== '1';", 'dérogation : la valeur est rognée'],
  [D, "return bacASableChromium() ? argsReseau : [...argsReseau, '--no-sandbox'];", "return [...argsReseau, '--no-sandbox'];", 'arguments : --no-sandbox toujours ajouté'],
  // (Retirer `--no-sandbox` des arguments sous dérogation ne change rien : Playwright l'ajoute lui-même dès
  // que `chromiumSandbox` est false. Mutant équivalent, donc absent.)
  [D, 'chromiumSandbox: bacASableChromium(),\n', 'chromiumSandbox: false,\n', 'lancement (hors Windows) : Playwright ajoute --no-sandbox'],

  // --- le refus du bac à sable est nommé, chaque signe reconnu
  [D, MOTIF, MOTIF.replace(/= \/.*\/i;/, '= /Running as root without --no-sandbox/i;'), 'refus : seul le message root reconnu'],
  ...SIGNES.map((signe) => [D, MOTIF, SANS_SIGNE(signe), `refus : « ${signe} » non reconnu`]),
  [D, 'const MOTIF_SIGNE_BAC_A_SABLE = /Chromium sandboxing failed/i;', 'const MOTIF_SIGNE_BAC_A_SABLE = /a^/;', 'refus : le message générique de Playwright non reconnu'],
  [D, 'const indice = bacASableChromium() ? indiceBacASable(erreurLancement) : null;', 'const indice = indiceBacASable(erreurLancement);', 'refus : nommé aussi sous dérogation'],
  [D, 'const indice = bacASableChromium() ? indiceBacASable(erreurLancement) : null;', 'const indice = null;', 'refus : jamais nommé'],

  // --- le marqueur de dérogation
  [D, 'if (!bacASableChromium()) { constats.push(constatSansBacASable()); demarreSansBacASable = true; }', 'if (!bacASableChromium()) { demarreSansBacASable = true; }', 'marqueur : jamais posé'],
  [D, 'if (!bacASableChromium()) { constats.push(constatSansBacASable()); demarreSansBacASable = true; }', 'constats.push(constatSansBacASable()); demarreSansBacASable = !bacASableChromium();', 'marqueur : posé même sans dérogation'],
  [D, '[...(demarreSansBacASable ? [constatSansBacASable()] : []), constat({', '[constat({', "marqueur : perdu quand l'axe D échoue après le lancement"],
  [D, '[...(demarreSansBacASable ? [constatSansBacASable()] : []), constat({', '[...[constatSansBacASable()], constat({', "marqueur : posé à l'échec même sans dérogation"],

  // --- le marqueur n'entre pas dans le verdict (le test compare le score global, une clé qui existe)
  ['src/moteur/modele.js', "info:     { rang: 1, penalite: 0,  libelle: 'Information' },", "info:     { rang: 1, penalite: 3,  libelle: 'Information' },", "l'information pèse dans la note"],
];
const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants[0] ? new RegExp(restants[0]) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests bac à sable', fichiers: TESTS }],
  exigerChromium: true,
  partie,
  dossiers: [...DOSSIERS_COPIES, 'bin', 'ressources'],
});
