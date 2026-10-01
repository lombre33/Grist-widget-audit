/**
 * Budget de temps de `constat()` (src/moteur/modele.js), déplacé de `tests/modele.test.mjs` : l'extrait d'un texte
 * de plusieurs Mio ne doit pas coûter le repli du texte entier, sinon quatre cents constats sur un même fichier
 * font un quadratique. Voir scripts/lib/budgets.mjs.
 */
import assert from 'node:assert/strict';
import { constat } from '../../src/moteur/modele.js';

export const cas = [{
  nom: "constat() : l'extrait d'un texte de plusieurs Mio, 400 fois de suite",
  budgetMs: 1000,
  executer() {
    const enorme = 'x y '.repeat(768 * 1024);
    let dernier;
    for (let i = 0; i < 400; i++) dernier = constat({ regle: 'X', axe: 'A', titre: 't', severite: 'mineur', constat: 'c', extrait: enorme });
    assert.equal(dernier.extrait, 'x y '.repeat(75));
  },
}];
