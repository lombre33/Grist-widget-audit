import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';

test('un seul point bloquant condamne le verdict quel que soit le score', () => {
  const constats = [constat({ regle: 'X', axe: 'C', titre: 'fuite', severite: 'critique', bloquant: true, constat: 'c' })];
  const n = noter(constats, new Set(['D']));
  assert.equal(n.verdict, 'NON CONFORME');
  assert.equal(n.bloquants.length, 1);
});

test('un axe non exécuté est exclu du score global plutôt que noté 100', () => {
  const n1 = noter([], new Set());
  const n2 = noter([], new Set(['D']));
  assert.equal(n1.parAxe.D.score, 100);
  assert.equal(n2.parAxe.D.score, null);
  assert.ok(n2.axesNonExecutes.includes('D'));
});

test('les occurrences répétées d\'une même règle sont plafonnées, pas simplement additionnées', () => {
  const beaucoup = Array.from({ length: 50 }, () => constat({ regle: 'REP', axe: 'A', titre: 't', severite: 'mineur', constat: 'c' }));
  const n = noter(beaucoup, new Set());
  // Avec une pénalité linéaire non plafonnée, 50 occurrences mineures (3 pts) auraient annulé le score.
  assert.ok(n.parAxe.A.score > 0, `score attendu > 0, obtenu ${n.parAxe.A.score}`);
});
