import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparerRapports } from '../src/rapport/diff.js';

function rapport(scoreGlobal, verdict, constatsParAxe) {
  const axes = {};
  for (const [code, constats] of Object.entries(constatsParAxe)) axes[code] = { score: 80, constats };
  return { verdict, scoreGlobal, axes };
}

test('un constat qui disparaît est classé corrigé, un constat qui apparaît est classé nouveau', () => {
  const c1 = { axe: 'A', regle: 'A-1', fichier: 'x.js', ligne: 3, titre: 'a', severite: 'majeur' };
  const c2 = { axe: 'A', regle: 'A-2', fichier: 'x.js', ligne: 9, titre: 'b', severite: 'mineur' };
  const ancien = rapport(70, 'CONFORME SOUS RÉSERVE', { A: [c1] });
  const nouveau = rapport(85, 'CONFORME', { A: [c2] });

  const diff = comparerRapports(ancien, nouveau);
  assert.deepEqual(diff.corriges.map((c) => c.regle), ['A-1']);
  assert.deepEqual(diff.nouveaux.map((c) => c.regle), ['A-2']);
  assert.equal(diff.persistants.length, 0);
  assert.equal(diff.deltaScore, 15);
});

test('un constat identique (axe+règle+fichier+ligne) des deux côtés est persistant, pas corrigé ni nouveau', () => {
  const c = { axe: 'C', regle: 'C-1', fichier: 'y.js', ligne: 1, titre: 't', severite: 'critique' };
  const ancien = rapport(50, 'NON CONFORME', { C: [c] });
  const nouveau = rapport(50, 'NON CONFORME', { C: [{ ...c }] });

  const diff = comparerRapports(ancien, nouveau);
  assert.equal(diff.corriges.length, 0);
  assert.equal(diff.nouveaux.length, 0);
  assert.equal(diff.persistants.length, 1);
});

test('deux occurrences de la même règle dans des fichiers différents ne se masquent pas mutuellement', () => {
  const cA = { axe: 'B', regle: 'B-1', fichier: 'a.js', ligne: null, titre: 't', severite: 'mineur' };
  const cB = { axe: 'B', regle: 'B-1', fichier: 'b.js', ligne: null, titre: 't', severite: 'mineur' };
  const ancien = rapport(90, 'CONFORME', { B: [cA] });
  const nouveau = rapport(90, 'CONFORME', { B: [cA, cB] });

  const diff = comparerRapports(ancien, nouveau);
  assert.equal(diff.persistants.length, 1);
  assert.deepEqual(diff.nouveaux.map((c) => c.fichier), ['b.js']);
});
