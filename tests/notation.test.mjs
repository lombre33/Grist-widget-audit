import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constat } from '../src/moteur/modele.js';
import { noter, noterAxe } from '../src/moteur/notation.js';

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

test('un axe non exécuté abaisse le verdict et le dit dans le motif, jamais silencieusement', () => {
  const n = noter([], new Set(['D']));
  assert.equal(n.verdict, 'CONFORME SOUS RÉSERVE');
  assert.match(n.motif, /non exécuté/);
  assert.match(n.motif, /\bD\b/);
});

test('sans axe manquant, un score haut reste CONFORME sans réserve', () => {
  const n = noter([], new Set());
  assert.equal(n.verdict, 'CONFORME');
  assert.doesNotMatch(n.motif, /non exécuté/);
});

test('noterAxe est non-croissante : une pénalité plus grande ne rend jamais une note supérieure', () => {
  // Défaut corrigé cette fois : à la jonction entre les deux branches, une
  // remontée artificielle ferait qu'une pénalité plus grande obtienne une
  // MEILLEURE note. Le score arrondi peut plafonner par paliers une fois la
  // pénalité très grande (il n'y a que 8 valeurs entières disponibles entre
  // le seuil et 0), mais il ne doit jamais remonter.
  let precedent = noterAxe(0);
  for (let p = 1; p <= 1000; p++) {
    const score = noterAxe(p);
    assert.ok(score <= precedent, `pénalité ${p} : score ${score} ne doit jamais dépasser le score en ${p - 1} (${precedent})`);
    precedent = score;
  }
});

test('noterAxe ne touche aucun score déjà publié sous le seuil du plancher souple', () => {
  assert.equal(noterAxe(0), 100);
  assert.equal(noterAxe(12), 88);
  assert.equal(noterAxe(38), 62); // axe D mesuré sur publipostageGrist
  assert.equal(noterAxe(92), 8); // le seuil exact : jonction entre les deux branches
});

test('noterAxe reste distincte et cohérente au-delà de l\'ancien plancher à 0', () => {
  const a = noterAxe(141); // axe A mesuré sur publipostageGrist
  const c = noterAxe(130); // axe C mesuré sur publipostageGrist
  assert.ok(a > 0 && c > 0, 'les deux doivent rester au-dessus de 0, jamais atteint exactement');
  assert.notEqual(a, c, 'deux pénalités différentes ne doivent plus rendre le même score muet');
  assert.ok(a < 8 && c < 8, 'toujours nettement pire que le seuil, pas une remontée artificielle');
});

test('la pénalité brute est exposée telle quelle, même quand le score arrondi sature', () => {
  const beaucoup = Array.from({ length: 5 }, (_, i) => constat({ regle: `R${i}`, axe: 'A', titre: 't', severite: 'critique', bloquant: false, constat: 'c' }));
  const n = noter(beaucoup, new Set());
  assert.ok(n.parAxe.A.penaliteBrute > 100, `pénalité brute attendue > 100, obtenue ${n.parAxe.A.penaliteBrute}`);
  assert.equal(n.parAxe.A.score, noterAxe(n.parAxe.A.penaliteBrute));
});

test('les occurrences répétées d\'une même règle sont plafonnées, pas simplement additionnées', () => {
  const beaucoup = Array.from({ length: 50 }, () => constat({ regle: 'REP', axe: 'A', titre: 't', severite: 'mineur', constat: 'c' }));
  const n = noter(beaucoup, new Set());
  // Avec une pénalité linéaire non plafonnée, 50 occurrences mineures (3 pts) auraient annulé le score.
  assert.ok(n.parAxe.A.score > 0, `score attendu > 0, obtenu ${n.parAxe.A.score}`);
});
