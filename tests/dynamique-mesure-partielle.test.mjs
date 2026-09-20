import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constatsA11y, constatsNegociationAcces } from '../src/runtime/dynamique.js';

/**
 * `brut.a11yErreur` et `journal.erreursRpc` étaient capturés puis jamais
 * lus (trouvé le 2026-09-20 en câblant la table appât) : un échec
 * d'injection axe-core ou un appel RPC en échec produisait un rapport
 * muet sur ce point, se présentant comme complet alors qu'il ne l'était
 * pas — même défaut déjà corrigé pour E-VULN-00 (`npm audit` en échec).
 * Comme pour E-VULN-00 (voir tests/notation.test.mjs), on teste
 * l'assemblage du constat ici ; la conséquence sur la notation
 * (`mesurePartielle` plafonne le verdict) est déjà couverte génériquement.
 */

test("constatsA11y signale une mesure non aboutie quand l'injection axe-core a échoué", () => {
  const constats = constatsA11y(null, 'CSP bloque addScriptTag');
  assert.equal(constats.length, 1);
  assert.equal(constats[0].regle, 'D-RGAA-INDISPONIBLE');
  assert.equal(constats[0].mesurePartielle, true);
  assert.match(constats[0].constat, /CSP bloque addScriptTag/);
});

test('constatsA11y ne renvoie toujours rien sans violations ni erreur (ex. pas de frame widget)', () => {
  assert.deepEqual(constatsA11y(null, undefined), []);
});

test('constatsA11y garde son comportement normal quand axe-core a bien tourné', () => {
  const constats = constatsA11y([], 'peu importe, ignoré si violations n\'est pas null');
  assert.equal(constats.length, 1);
  assert.equal(constats[0].regle, 'D-RGAA-00');
});

test('constatsNegociationAcces signale un canal RPC partiellement en échec', () => {
  const journal = { configureRecu: { requiredAccess: 'full' }, erreursRpc: ["RPC_UNKNOWN_FORWARD_DEST Unknown forward destination: grist"] };
  const constats = constatsNegociationAcces(journal);
  const c = constats.find((x) => x.regle === 'D-GRIST-02');
  assert.ok(c, 'D-GRIST-02 doit se déclencher');
  assert.equal(c.mesurePartielle, true);
  assert.match(c.constat, /RPC_UNKNOWN_FORWARD_DEST/);
  // La négociation d'accès a par ailleurs bien eu lieu : pas de D-GRIST-01 en plus.
  assert.equal(constats.some((x) => x.regle === 'D-GRIST-01'), false);
});

test('constatsNegociationAcces ne signale rien quand erreursRpc est vide', () => {
  const constats = constatsNegociationAcces({ configureRecu: {}, erreursRpc: [] });
  assert.equal(constats.some((x) => x.regle === 'D-GRIST-02'), false);
});
