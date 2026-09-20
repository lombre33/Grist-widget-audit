import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';
import { genererSarif } from '../src/rapport/sarif.js';

test('chaque résultat SARIF référence une règle existante et porte une localisation', () => {
  const constats = [
    constat({ regle: 'C-EXFIL-01', axe: 'C', titre: 'fuite', severite: 'critique', bloquant: true, constat: 'c', fichier: 'app.js', ligne: 12 }),
    constat({ regle: 'E-DEP-01', axe: 'E', titre: 'dépendance', severite: 'mineur', constat: 'd' }),
  ];
  const notation = noter(constats, new Set());
  const sarif = JSON.parse(genererSarif({ notation, meta: { version: '1.2.3', nomDepot: 'w' } }));

  assert.equal(sarif.version, '2.1.0');
  const run = sarif.runs[0];
  assert.equal(run.results.length, 2);
  for (const r of run.results) {
    assert.ok(run.tool.driver.rules[r.ruleIndex]);
    assert.equal(run.tool.driver.rules[r.ruleIndex].id, r.ruleId);
    assert.ok(r.locations?.[0]?.physicalLocation?.artifactLocation?.uri, 'localisation attendue même sans fichier connu');
  }
});

test('la sévérité critique se traduit en niveau SARIF error, mineur en note', () => {
  const constats = [
    constat({ regle: 'X', axe: 'A', titre: 't1', severite: 'critique', constat: 'c' }),
    constat({ regle: 'Y', axe: 'A', titre: 't2', severite: 'mineur', constat: 'c' }),
  ];
  const notation = noter(constats, new Set());
  const sarif = JSON.parse(genererSarif({ notation, meta: { version: '1.0.0', nomDepot: 'w' } }));

  const parRegle = Object.fromEntries(sarif.runs[0].results.map((r) => [r.ruleId, r.level]));
  assert.equal(parRegle.X, 'error');
  assert.equal(parRegle.Y, 'note');
});
