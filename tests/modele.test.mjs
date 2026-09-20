import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constat, trierConstats } from '../src/moteur/modele.js';

test('constat() rejette un axe ou une sévérité inconnue', () => {
  assert.throws(() => constat({ regle: 'X', axe: 'Z', titre: 't', severite: 'majeur', constat: 'c' }));
  assert.throws(() => constat({ regle: 'X', axe: 'A', titre: 't', severite: 'grave', constat: 'c' }));
});

test('trierConstats place les bloquants avant tout, puis par sévérité', () => {
  const c1 = constat({ regle: 'A', axe: 'A', titre: 'mineur', severite: 'mineur', constat: 'c' });
  const c2 = constat({ regle: 'B', axe: 'A', titre: 'bloquant', severite: 'majeur', bloquant: true, constat: 'c' });
  const c3 = constat({ regle: 'C', axe: 'A', titre: 'critique', severite: 'critique', constat: 'c' });
  const tries = trierConstats([c1, c2, c3]);
  assert.equal(tries[0].titre, 'bloquant');
  assert.equal(tries[1].titre, 'critique');
  assert.equal(tries[2].titre, 'mineur');
});
