import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/mini-widget');

test('la fixture minimale déclenche les règles attendues (accès full, exfiltration, injection DOM)', async () => {
  const ctx = construireContexte(FIXTURE);
  const constats = await analyseStatique(ctx, { reseau: false });
  const regles = new Set(constats.map((c) => c.regle));

  assert.ok(regles.has('C-GRIST-03'), 'demande d\'accès full sans écriture doit être détectée');
  // L'URL du fixture concatène un domaine littéral avec une variable : elle est
  // donc classée dynamique (C-EXFIL-02), pas littérale (C-EXFIL-01).
  assert.ok(regles.has('C-EXFIL-02'), 'fetch() vers une URL construite dynamiquement doit être détecté');
  assert.ok(regles.has('C-XSS-01'), 'innerHTML avec valeur dynamique doit être détecté');
  assert.ok(regles.has('B-DOC-01'), 'absence de README doit être détectée');
});
