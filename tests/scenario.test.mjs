import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validerScenario } from '../src/runtime/scenario.js';
import { documentDeTest } from '../src/runtime/dynamique.js';

test('validerScenario rejette un scénario mal formé', () => {
  assert.throws(() => validerScenario(null));
  assert.throws(() => validerScenario('pas un objet'));
  assert.throws(() => validerScenario([1, 2]));
  assert.throws(() => validerScenario({}), /colonnes/);
  assert.throws(() => validerScenario({ colonnes: {} }), /colonnes/);
  assert.throws(() => validerScenario({ colonnes: { Nom: 'pas un tableau' } }), /Nom/);
});

test('validerScenario accepte un scénario minimal valide et le renvoie tel quel', () => {
  const brut = { tableId: 'X', colonnes: { id: [1, 2] } };
  assert.equal(validerScenario(brut), brut);
});

test('documentDeTest() sans scénario renvoie le document fixe avec la sonde XSS intégrée', () => {
  const doc = documentDeTest(undefined);
  assert.equal(doc.tableId, 'Contacts');
  assert.ok(doc.colonnes.Nom.includes('<img src=x onerror="window.parent.__poc_xss_exec=(window.parent.__poc_xss_exec||0)+1">'));
});

test('documentDeTest(scenario) garde les colonnes fournies et ajoute quand même sa propre sonde XSS', () => {
  const scenario = { tableId: 'Commandes', colonnes: { id: [1, 2, 3], Client: ['Marie Curie', 'Ada Lovelace', 'Alan Turing'] } };
  const doc = documentDeTest(scenario);

  assert.equal(doc.tableId, 'Commandes');
  assert.deepEqual(doc.colonnes.id, [1, 2, 3]);
  assert.deepEqual(doc.colonnes.Client, ['Marie Curie', 'Ada Lovelace', 'Alan Turing']);
  // Le scénario fourni ne contient aucune charge XSS : la sonde doit quand
  // même être présente, dans sa propre colonne, pour que D-XSS-01 reste
  // vérifiable même avec des données entièrement personnalisées.
  assert.ok(doc.colonnes._GwauditSondeXss, 'la sonde XSS doit toujours être ajoutée');
  assert.equal(doc.colonnes._GwauditSondeXss.length, 3, 'la sonde doit couvrir autant de lignes que la plus longue colonne fournie');
  assert.ok(doc.colonnes._GwauditSondeXss.every((v) => v.includes('onerror')));
});

test('documentDeTest(scenario) utilise un nom de table par défaut si non fourni', () => {
  const doc = documentDeTest({ colonnes: { seule: ['une valeur'] } });
  assert.equal(doc.tableId, 'Contacts');
  assert.equal(doc.colonnes._GwauditSondeXss.length, 1);
});
