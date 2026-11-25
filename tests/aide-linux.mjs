import testNode from 'node:test';

/**
 * `test` pour les essais d'un outil de mise au point qui ne tourne que sous Linux : le moteur de rejeu de mutants
 * (`scripts/lib/rejouer-mutants.mjs`) lit /proc, tue ses orphelins par pkill, copie l'arbre et lie node_modules —
 * rien de tout cela n'existe sous Windows, où il n'est jamais lancé. Sous Windows chaque essai est SAUTÉ en le disant
 * (jamais écarté en silence) ; sous Linux c'est `test` de node:test, tel quel.
 */
const RAISON = "outil de mise au point des mutants, propre à Linux (/proc, pkill, copie de l'arbre) : jamais lancé sous Windows";

export default process.platform === 'win32' ? (nom) => testNode(nom, { skip: RAISON }) : testNode;
