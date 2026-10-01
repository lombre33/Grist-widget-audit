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

test("constat() : seul le début d'un extrait est lu, 4 096 caractères : replier un texte de plusieurs Mio pour chacun de milliers de constats était quadratique", () => {
  const extrait = (texte) => constat({ regle: 'X', axe: 'A', titre: 't', severite: 'mineur', constat: 'c', extrait: texte }).extrait;
  // Une suite de blancs qui n'en finit pas, puis `b` : lu en entier, le texte se replierait en `a b` ; le début lu s'arrête avant `b`.
  assert.equal(extrait(`a${' '.repeat(4094)}b`), 'a b', '`b` est le 4 096e caractère : lu');
  assert.equal(extrait(`a${' '.repeat(4095)}b`), 'a ', '`b` est le 4 097e : hors de ce qui est lu');
  assert.equal(extrait(`a${' '.repeat(3 * 1024 * 1024)}b`), 'a ');
  // Un texte de plusieurs Mio donne le même extrait que son début de 4 096 caractères, au contenu près des 300 premiers.
  const enorme = 'x y '.repeat(768 * 1024);
  assert.equal(extrait(enorme), 'x y '.repeat(75));
  assert.equal(extrait(enorme), extrait(enorme.slice(0, 4096)));
  // Le temps de ce repli est chronométré à part (`scripts/chronometrer-pieges.mjs`) : aucun budget en temps réel dans la suite.
});
