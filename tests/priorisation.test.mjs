import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';
import { ordonnancerCorrections } from '../src/moteur/priorisation.js';

function c(regle, axe, severite, extra = {}) {
  return constat({ regle, axe, titre: `titre ${regle}`, severite, constat: 'c', ...extra });
}

test('un point bloquant passe toujours en premier, même avec un gain de score plus faible ailleurs', () => {
  const constats = [
    // Bloquant, mais gain de score minime (un seul point bloquant, axe F peu pesant).
    c('F-BLOQ', 'F', 'critique', { bloquant: true }),
    // Non bloquant, gain de score bien plus gros (axe C, poids 25, sévérité critique).
    c('C-GROS', 'C', 'critique'),
  ];
  const items = ordonnancerCorrections(noter(constats, new Set(['D'])));
  assert.equal(items[0].regle, 'F-BLOQ');
  assert.equal(items[0].bloquant, true);
});

test('à bloquant égal, la règle qui rapporte le plus au score global passe devant', () => {
  const constats = [
    c('F-PETIT', 'F', 'mineur'), // axe F, poids 5 : petit gain
    c('C-GRAND', 'C', 'critique'), // axe C, poids 25 : gros gain
  ];
  const items = ordonnancerCorrections(noter(constats, new Set(['D'])));
  assert.equal(items[0].regle, 'C-GRAND');
  assert.ok(items[0].gainGlobalEstime > items[1].gainGlobalEstime);
});

test('une règle déjà amortie par de nombreuses occurrences gagne moins qu\'une règle fraîche de même sévérité', () => {
  const uneFois = [c('A-UNIQUE', 'A', 'majeur')];
  const dixFois = Array.from({ length: 10 }, (_, i) => c('A-REPETE', 'A', 'majeur', { fichier: `f${i}.js` }));
  const items = ordonnancerCorrections(noter([...uneFois, ...dixFois], new Set(['D'])));
  const unique = items.find((i) => i.regle === 'A-UNIQUE');
  const repete = items.find((i) => i.regle === 'A-REPETE');
  assert.ok(unique.gainGlobalEstime > 0 && repete.gainGlobalEstime > 0);
  assert.ok(repete.gainGlobalEstime > unique.gainGlobalEstime, 'corriger 10 occurrences amorties doit tout de même rapporter plus que corriger 1 seule occurrence de la même règle, mais pas 10 fois plus');
});

test('les fichiers touchés par la règle sont listés sans doublon', () => {
  const constats = [
    c('A-MULTI', 'A', 'mineur', { fichier: 'a.js' }),
    c('A-MULTI', 'A', 'mineur', { fichier: 'a.js' }),
    c('A-MULTI', 'A', 'mineur', { fichier: 'b.js' }),
  ];
  const items = ordonnancerCorrections(noter(constats, new Set(['D'])));
  const item = items.find((i) => i.regle === 'A-MULTI');
  assert.deepEqual(item.fichiers.sort(), ['a.js', 'b.js']);
});

test('rien à ordonnancer quand il n\'y a aucun constat', () => {
  const items = ordonnancerCorrections(noter([], new Set(['D'])));
  assert.deepEqual(items, []);
});

test('un axe non exécuté ne contribue aucune entrée à ordonnancer', () => {
  const constats = [c('C-X', 'C', 'majeur')];
  const items = ordonnancerCorrections(noter(constats, new Set(['D'])));
  assert.ok(items.every((i) => i.axe !== 'D'));
});

test('noter() expose lui-même la roadmap, sans appel séparé à ordonnancerCorrections', () => {
  const constats = [c('C-X', 'C', 'majeur')];
  const n = noter(constats, new Set(['D']));
  assert.deepEqual(n.roadmap, ordonnancerCorrections(n));
  assert.equal(n.roadmap[0].regle, 'C-X');
});
