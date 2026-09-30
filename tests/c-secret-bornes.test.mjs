/**
 * Les bornes de lecture d'une valeur de configuration (4 096 caractères) : chaque texte ci-dessous ferme ses valeurs (guillemet,
 * blanc, fin de ligne) avant la fin du texte. C'est voulu. La borne est aussi ce qui arrête la lecture d'une valeur qui irait
 * jusqu'à la fin du texte (`texte[j]` y vaut `undefined`, ni guillemet ni blanc) : sans elle, le mutant qui la retire ne
 * s'arrêterait jamais sur les textes des autres essais, et serait tué par un délai, non par un essai. `scripts/mutants-c-secret.mjs`
 * lance ce fichier le premier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { affectationsDeConfiguration } from '../src/regles/c-secrets.js';

/** Le nom et la longueur de chaque valeur lue (la valeur elle-même, de plusieurs milliers de caractères, n'est pas recopiée dans un échec). */
const lire = (texte) => [...affectationsDeConfiguration(texte)].map((t) => [t.nom, t.valeur.length]);

test('une valeur entre guillemets se lit jusqu\'à 4 096 caractères, pas au-delà', () => {
  const entre = (n) => `token="${'a'.repeat(n)}"\n`;
  assert.deepEqual(lire(entre(4095)), [['token', 4095]]);
  assert.deepEqual(lire(entre(4096)), [['token', 4096]]);
  assert.deepEqual(lire(entre(4097)), [], 'une de plus : la valeur n\'est pas lue');
  assert.deepEqual(lire(entre(5000)), []);
});

test('une valeur sans guillemets est coupée à 4 096 caractères', () => {
  const nue = (n) => `token=${'a'.repeat(n)} suite\n`;
  assert.deepEqual(lire(nue(4095)), [['token', 4095]]);
  assert.deepEqual(lire(nue(4096)), [['token', 4096]]);
  assert.deepEqual(lire(nue(5000)), [['token', 4096]], 'au-delà, la valeur est coupée, non ignorée');
});

test('une valeur que la borne coupe n\'empêche pas de lire le nom qui la suit', () => {
  assert.deepEqual(lire(`token=${'a'.repeat(4095)},secret=zzzzzzzz \n`), [['token', 4095], ['secret', 8]]);
});
