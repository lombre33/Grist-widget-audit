/**
 * Budgets de temps du repli par expressions régulières de l'inventaire (src/contexte/inventaire.js, `referencesWorkerParRegex`) :
 * quand acorn ne lit pas un fichier de code (un point final suffit, n'importe quel widget peut forcer le repli), les workers se
 * cherchent par expressions régulières. Deux d'entre elles relisaient le texte à chaque occurrence, donc un fichier de 200 Kio en
 * coûtait plus d'une minute : `importScripts\s*\(([^)]*)\)` quand aucune parenthèse ne ferme, et le préfixe `(?:\w+\.)*` de la
 * forme des worklets sur une chaîne `a.a.a.…`. Le repli qui les a remplacées trouve les mêmes références (les essais de
 * `tests/inventaire-repli-workers.test.mjs` le comparent aux expressions d'origine), mais un résultat identique ne dit rien du
 * temps : seul un budget distingue l'ancienne forme de la nouvelle. Les quatre entrées de tailles sont celles de
 * `scripts/chronometrer-pieges.mjs`, mais passées à `referencesDeCode` seule, non à l'analyse complète que ce script mesure : le
 * repli est la seule chose qui change, son coût se compte en millisecondes, et le budget ne dépend ni d'un dossier à fabriquer ni du
 * reste des règles (l'analyse complète des mêmes entrées reste à `chronometrer-pieges.mjs`). Le dernier cas tient le repli à
 * terminer quand une parenthèse fermante précède l'appel.
 * Voir scripts/lib/budgets.mjs : ce n'est pas la suite par défaut qui les mesure, mais `scripts/verifier-budgets.mjs`.
 */
import assert from 'node:assert/strict';
import { referencesDeCode } from '../../src/contexte/inventaire.js';

/** Les références de workers que le repli trouve dans `texte` (un code que l'analyseur ne lit pas : `ast` et `erreur` nuls). */
const refsDe = (texte) => [...referencesDeCode(
  { chemin: 'a.ts', ext: '.ts', contenu: texte, binaire: false, executee: true },
  { source: texte, inline: false, debut: null },
  { ast: null, erreur: null },
)].map((r) => (typeof r === 'string' ? r : r.documentRelatif ?? r.relatif));

const sansReference = (nom, texte) => ({
  nom,
  budgetMs: 500,
  executer() { assert.deepEqual(refsDe(texte), [], 'aucune référence ne se cache dans cette suite'); },
});

export const cas = [
  sansReference('repli des workers : 100 000 fois « a. » (200 Kio), la chaîne ne se relit pas à chaque point', 'a.'.repeat(100_000)),
  sansReference('repli des workers : 200 000 fois « a. » (400 Kio), la chaîne ne se relit pas à chaque point', 'a.'.repeat(200_000)),
  sansReference('repli des workers : 14 000 fois « importScripts( » sans parenthèse fermante (200 Kio)', 'importScripts('.repeat(14_000)),
  sansReference('repli des workers : 28 000 fois « importScripts( » sans parenthèse fermante (400 Kio)', 'importScripts('.repeat(28_000)),
  {
    nom: "repli des workers : un importScripts( précédé d'une parenthèse fermante se lit et la recherche termine",
    budgetMs: 500,
    executer() { assert.deepEqual(refsDe("x() importScripts('a.js')"), ['a.js']); },
  },
];
