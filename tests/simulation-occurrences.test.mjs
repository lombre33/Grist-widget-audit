import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simuler } from '../scripts/simuler-conversion-occurrences.mjs';

/**
 * Outil de préparation pour la décision différée par la coordination : la
 * conversion des 14 règles "Pattern B" en un constat par occurrence
 * bougerait-elle un score, et jusqu'à faire basculer un verdict ? Ces tests
 * verrouillent la mécanique du simulateur lui-même (pas une prédiction sur
 * un vrai dépôt, qui évoluera avec les règles) : il ne doit jamais modifier
 * le rapport qu'on lui donne, et son calcul doit rester celui du moteur réel.
 */

function rapportMinimal({ regle, severite, occurrences, poidsAxeUnique = 100, scoreGlobal, penaliteBruteAxe, scoreAxe, cle = 'emplacements' }) {
  return {
    scoreGlobal,
    axes: {
      A: {
        nonExecute: false,
        score: scoreAxe,
        penaliteBrute: penaliteBruteAxe,
        constats: [{ regle, severite, preuve: { [cle]: Array.from({ length: occurrences }, (_, i) => i) } }],
      },
    },
  };
}

test('ne modifie jamais le rapport qu\'on lui passe (outil de lecture seule)', () => {
  const rapport = rapportMinimal({ regle: 'A-DEV-01', severite: 'mineur', occurrences: 10, scoreGlobal: 90, penaliteBruteAxe: 10, scoreAxe: 90 });
  const copie = JSON.parse(JSON.stringify(rapport));
  simuler(rapport);
  assert.deepEqual(rapport, copie);
});

test('une règle non "Pattern B" ou absente du rapport ne produit aucune entrée', () => {
  const rapport = rapportMinimal({ regle: 'A-INCONNUE', severite: 'mineur', occurrences: 10, scoreGlobal: 90, penaliteBruteAxe: 10, scoreAxe: 90 });
  assert.deepEqual(simuler(rapport), []);
});

test('une occurrence unique ne change rien (facteurOccurrences(1) = facteur actuel)', () => {
  const rapport = rapportMinimal({ regle: 'A-DEV-01', severite: 'mineur', occurrences: 1, scoreGlobal: 90, penaliteBruteAxe: 10, scoreAxe: 90 });
  const [r] = simuler(rapport);
  assert.equal(r.penaliteActuelle, r.penaliteSimulee);
  assert.equal(r.scoreAxeActuel, r.scoreAxeSimule);
  assert.equal(r.verdictPourraitBouger, false);
});

test('de nombreuses occurrences augmentent la pénalité simulée et peuvent faire basculer le verdict', () => {
  // Axe déjà proche du seuil de 80 : une conversion qui l'abaisse de plus
  // de quelques points doit faire passer scoreGlobalSimule sous 80.
  const rapport = rapportMinimal({ regle: 'C-STOCK-01', severite: 'majeur', occurrences: 8, scoreGlobal: 81, penaliteBruteAxe: 12, scoreAxe: 88 });
  const [r] = simuler(rapport);
  assert.ok(r.penaliteSimulee > r.penaliteActuelle);
  assert.ok(r.scoreGlobalSimule < r.scoreGlobalActuel);
  assert.equal(r.verdictPourraitBouger, true, 'un franchissement du seuil 80 doit être signalé');
});

test('preuve absente ou de forme inattendue est signalée comme non mesurable, jamais silencieusement ignorée ou plantée', () => {
  const rapport = {
    scoreGlobal: 90,
    axes: { A: { nonExecute: false, score: 90, penaliteBrute: 10, constats: [{ regle: 'A-DEV-01', severite: 'mineur', preuve: null }] } },
  };
  const [r] = simuler(rapport);
  assert.ok(r.erreur, 'doit signaler explicitement que la conversion n\'est pas mesurable sur ce rapport');
});

test('un axe non exécuté est ignoré, comme dans noter()', () => {
  const rapport = rapportMinimal({ regle: 'A-DEV-01', severite: 'mineur', occurrences: 10, scoreGlobal: 90, penaliteBruteAxe: 10, scoreAxe: 90 });
  rapport.axes.A.nonExecute = true;
  assert.deepEqual(simuler(rapport), []);
});
