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

test("constat() : l'extrait est replié en blancs puis coupé à 300 caractères", () => {
  const c = (extrait) => constat({ regle: 'X', axe: 'A', titre: 't', severite: 'mineur', constat: 'c', extrait });
  assert.equal(c('a \t\n  b\r\nc').extrait, 'a b c');
  assert.equal(c('x'.repeat(500)).extrait, 'x'.repeat(300));
  assert.equal(c(`${'x '.repeat(400)}`).extrait, 'x '.repeat(150).slice(0, 300));
  assert.equal(c('').extrait, null);
  assert.equal(c(undefined).extrait, null);
});

test("constat() : l'extrait d'un texte de plusieurs Mio est coupé sans replier le texte entier (le temps de 400 constats : tests/budgets/modele.budget.mjs)", () => {
  const enorme = 'x y '.repeat(768 * 1024);
  const c = constat({ regle: 'X', axe: 'A', titre: 't', severite: 'mineur', constat: 'c', extrait: enorme });
  assert.equal(c.extrait, 'x y '.repeat(75));
});
