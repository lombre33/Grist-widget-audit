import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserAccesAppat } from '../src/regles/d-perimetre.js';
import { TABLE_APPAT_ID } from '../src/runtime/dynamique.js';

test("D-PERIMETRE-01 détecte un fetchTable sur la table appât", () => {
  const journal = {
    appelsRpc: [
      { interface: 'GristDocAPI@grist', methode: 'listTables', args: [], t: 1 },
      { interface: 'GristDocAPI@grist', methode: 'fetchTable', args: [TABLE_APPAT_ID], t: 2 },
    ],
  };
  const constats = analyserAccesAppat(journal);
  const c = constats.find((x) => x.regle === 'D-PERIMETRE-01');
  assert.ok(c);
  assert.equal(c.bloquant, true);
  assert.equal(c.confiance, 'prouve');
  assert.ok(c.constat && c.remediation, 'trois choses : emplacement dans preuve, explication, correctif');
});

test("D-PERIMETRE-01 détecte un applyUserActions sur la table appât", () => {
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'applyUserActions', args: [TABLE_APPAT_ID, []], t: 5 }] };
  const constats = analyserAccesAppat(journal);
  assert.equal(constats.filter((x) => x.regle === 'D-PERIMETRE-01').length, 1);
});

test("D-PERIMETRE-01 ne se déclenche pas sur listTables() seul (énumération légitime)", () => {
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'listTables', args: [], t: 1 }] };
  const constats = analyserAccesAppat(journal);
  assert.equal(constats.length, 0);
});

test("D-PERIMETRE-01 ne se déclenche pas sur un accès à la vraie table du scénario", () => {
  const journal = { appelsRpc: [{ interface: 'GristDocAPI@grist', methode: 'fetchTable', args: ['Table1'], t: 1 }] };
  const constats = analyserAccesAppat(journal);
  assert.equal(constats.length, 0);
});

test('D-PERIMETRE-01 ne se déclenche pas sans journal ni appels', () => {
  assert.equal(analyserAccesAppat(null).length, 0);
  assert.equal(analyserAccesAppat({}).length, 0);
  assert.equal(analyserAccesAppat({ appelsRpc: [] }).length, 0);
});
