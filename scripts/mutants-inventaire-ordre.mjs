#!/usr/bin/env node
/**
 * Rejoue les mutants de l'ordre de l'inventaire (`src/contexte/inventaire.js`, méthode : `scripts/lib/rejouer-mutants.mjs`) : le tri des entrées d'un dossier, où qu'il se lise (le parcours de
 * l'inventaire, le listage des dossiers exclus), et ce qu'il compare (le nom tel quel, dans l'ordre des unités de code : ni la langue, ni la casse, ni la longueur, ni le genre de l'entrée).
 * Chaque mutant est tué par une assertion de `tests/inventaire-ordre.test.mjs`.
 *
 * Deux mutants équivalents, non écrits :
 *  - la branche `: 0` du comparateur : deux entrées d'un même dossier n'ont jamais le même nom, elle ne se prend pas ; elle garde le contrat d'un comparateur (comme dans `e-dependances.js` et
 *    `b-lisibilite.js`), pas un comportement ;
 *  - la branche `1` : le tri de V8 (Node 22) ne lit que le signe négatif du comparateur, et `(a.name < b.name ? -1 : 0)` rend le même tableau que le comparateur entier (3 300 tableaux de 1 à 3 000
 *    noms, mélangés, croissants, décroissants, tournés : aucune différence). Aucun essai ne peut les distinguer sur ce moteur.
 *
 * Usage : node scripts/mutants-inventaire-ordre.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const E = 'src/contexte/inventaire.js';
const LIRE = 'const entreesDuDossier =';
const COMPARATEUR = '(a.name < b.name ? -1 : a.name > b.name ? 1 : 0)';
const TRI = `.sort((a, b) => ${COMPARATEUR})`;
const LIRE_TOUT = 'try { entrees = entreesDuDossier(dossier); }';
const LISTER = 'try { lus = entreesDuDossier(path.join(racine, rel)); }';

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- le tri
  dansLigne(E, LIRE, TRI, '', 'tri : les entrées se suivent dans l\'ordre du système de fichiers'),
  dansLigne(E, LIRE, '? -1 : a.name > b.name ? 1 : 0', '? 1 : a.name > b.name ? -1 : 0', 'tri : l\'ordre des noms est inversé'),
  dansLigne(E, LIRE, COMPARATEUR, 'a.name.localeCompare(b.name)', 'tri : l\'ordre est celui de la langue (localeCompare)'),
  dansLigne(E, LIRE, COMPARATEUR, '(a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0)', 'tri : la casse ne compte pas'),
  dansLigne(E, LIRE, COMPARATEUR, 'a.name.length - b.name.length', 'tri : les noms les plus courts d\'abord'),
  dansLigne(E, LIRE, COMPARATEUR, '(Number(b.isDirectory()) - Number(a.isDirectory()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))', 'tri : les dossiers d\'abord'),
  dansLigne(E, LIRE, COMPARATEUR, '(a.name > b.name ? 1 : 0)', 'tri : un nom plus petit ne passe jamais avant un plus grand'),

  // --- où il s'applique
  dansLigne(E, LIRE_TOUT, 'entreesDuDossier(dossier)', 'fs.readdirSync(dossier, { withFileTypes: true })', 'parcours : l\'inventaire lit les dossiers dans l\'ordre du système de fichiers'),
  dansLigne(E, LISTER, 'entreesDuDossier(path.join(racine, rel))', 'fs.readdirSync(path.join(racine, rel), { withFileTypes: true })', 'listage : les dossiers exclus se listent dans l\'ordre du système de fichiers'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de l\'ordre de l\'inventaire', fichiers: ['tests/inventaire-ordre.test.mjs'] }],
  exigerChromium: false,
  partie,
  delaiMs: 60_000,
});
