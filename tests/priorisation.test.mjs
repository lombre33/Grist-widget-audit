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

test('le représentant d\'un groupe est le pire cas (sévérité la plus haute), pas le premier fichier rencontré', () => {
  const constats = [
    c('A-FONC-02', 'A', 'mineur', { fichier: 'a.js', titre: 'Complexité cyclomatique de 12 : petiteFonction' }),
    c('A-FONC-02', 'A', 'majeur', { fichier: 'b.js', titre: 'Complexité cyclomatique de 87 : grosseFonction' }),
    c('A-FONC-02', 'A', 'mineur', { fichier: 'c.js', titre: 'Complexité cyclomatique de 15 : autreFonction' }),
  ];
  const items = ordonnancerCorrections(noter(constats, new Set(['D'])));
  const item = items.find((i) => i.regle === 'A-FONC-02');
  assert.match(item.titre, /87 : grosseFonction/, 'le pire cas (majeur, 87) doit représenter le groupe, pas le premier (mineur, 12)');
});

test('le titre du groupe est qualifié « (pire cas) » dès que plusieurs occurrences existent, jamais pour une occurrence unique', () => {
  const plusieurs = [
    c('A-FONC-02', 'A', 'majeur', { fichier: 'a.js', titre: 'Complexité cyclomatique de 62 : f' }),
    c('A-FONC-02', 'A', 'majeur', { fichier: 'b.js', titre: 'Complexité cyclomatique de 40 : g' }),
  ];
  const unique = [c('C-X', 'C', 'majeur', { titre: 'Un seul constat' })];
  const items = ordonnancerCorrections(noter([...plusieurs, ...unique], new Set(['D'])));
  assert.match(items.find((i) => i.regle === 'A-FONC-02').titre, /\(pire cas\)$/);
  assert.doesNotMatch(items.find((i) => i.regle === 'C-X').titre, /\(pire cas\)/, 'une occurrence unique ne doit jamais porter cette qualification, elle n\'a rien à désambiguïser');
});

test('deux règles qui citent le même hôte externe (preuve.hote / preuve.hotes) sont annotées « concerne aussi », sans se fondre en une seule entrée', () => {
  const constats = [
    c('F-SOUV-01', 'F', 'majeur', { fichier: 'app.js', preuve: { hotes: ['fonts.googleapis.com'] } }),
    c('B-DOC-04', 'B', 'majeur', { fichier: 'README.md', preuve: { hotes: ['fonts.googleapis.com', 'esm.sh'] } }),
    c('D-RESEAU-01', 'D', 'critique', { bloquant: true, preuve: { hote: 'fonts.googleapis.com' } }),
    c('A-DUP-01', 'A', 'mineur'), // ne cite aucun hôte : ne doit jamais apparaître dans une annotation
  ];
  const items = ordonnancerCorrections(noter(constats, new Set()));
  assert.equal(items.length, 4, 'toujours une entrée par règle : l\'annotation ne fond jamais deux étapes en une');

  const souv = items.find((i) => i.regle === 'F-SOUV-01');
  const doc = items.find((i) => i.regle === 'B-DOC-04');
  const reseau = items.find((i) => i.regle === 'D-RESEAU-01');
  const dup = items.find((i) => i.regle === 'A-DUP-01');

  assert.deepEqual(new Set(souv.concerneAussi.map((x) => x.regle)), new Set(['B-DOC-04', 'D-RESEAU-01']));
  assert.deepEqual(new Set(doc.concerneAussi.map((x) => x.regle)), new Set(['F-SOUV-01', 'D-RESEAU-01']));
  assert.ok(souv.concerneAussi.every((x) => x.hote === 'fonts.googleapis.com'));
  assert.deepEqual(dup.concerneAussi, [], 'une règle sans hôte identifié ne doit jamais recevoir d\'annotation');

  // Métadonnée pure : ni le tri (bloquant D-RESEAU-01 toujours en tête) ni
  // les scores ne doivent en dépendre.
  assert.equal(items[0].regle, 'D-RESEAU-01');
});
