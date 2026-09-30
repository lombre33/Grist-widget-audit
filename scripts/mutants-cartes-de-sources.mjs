#!/usr/bin/env node
/**
 * Rejoue les mutants de la carte de sources (méthode : `scripts/lib/rejouer-mutants.mjs`) : A-DEV-03 (marqueurs de travail
 * inachevé) et A-TEST-02 (preuve d'un test de bout en bout) cherchent leurs signes dans le texte de tout le dépôt, et une
 * carte de sources (`.map`), générée, embarque celui des bibliothèques tierces : elle ne compte ni dans l'un ni dans l'autre.
 *
 * Usage : node scripts/mutants-cartes-de-sources.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const A = 'src/regles/a-qualite.js';
const TESTS = ['tests/cartes-de-sources.test.mjs'];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  dansLigne(A, 'if (!f.contenu || f.binaire || f.vendorise || f.dossierExclu || estCarteDeSources(f)) continue;', ' || estCarteDeSources(f)', '', 'A-DEV-03 : les marqueurs d\'une carte de sources sont comptés'),
  dansLigne(A, 'if (!f.contenu || f.binaire || f.vendorise || f.dossierExclu || estCarteDeSources(f)) continue;', 'estCarteDeSources(f)', '!estCarteDeSources(f)', 'A-DEV-03 : seuls les marqueurs d\'une carte de sources sont comptés'),
  dansLigne(A, '(f.contenu && !estCarteDeSources(f) && CONTENU_TEST_E2E.test(f.contenu)));', ' && !estCarteDeSources(f)', '', 'A-TEST-02 : le texte d\'une carte de sources fait preuve d\'un test de bout en bout'),
  dansLigne(A, '(f.contenu && !estCarteDeSources(f) && CONTENU_TEST_E2E.test(f.contenu)));', '!estCarteDeSources(f)', 'estCarteDeSources(f)', 'A-TEST-02 : seul le texte d\'une carte de sources fait preuve'),
  dansLigne(A, 'const estCarteDeSources = (f) => f.ext', "'.map'", "'.maps'", 'carte de sources : une extension qui n\'est pas celle d\'une carte'),
  dansLigne(A, 'const estCarteDeSources = (f) => f.ext', "f.ext === '.map'", "f.ext === '.map' || f.ext === '.js'", 'carte de sources : tout fichier JavaScript est tenu pour généré'),
  dansLigne(A, 'const estCarteDeSources = (f) => f.ext', "f.ext === '.map'", 'false', 'carte de sources : aucun fichier n\'est tenu pour une carte'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de la carte de sources', fichiers: TESTS }],
  exigerChromium: false,
  partie,
});
