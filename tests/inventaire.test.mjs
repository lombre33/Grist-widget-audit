import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/mini-widget');

test('la surface exécutée suit les références depuis index.html', () => {
  const ctx = construireContexte(FIXTURE);
  assert.deepEqual(ctx.entrees, ['index.html']);
  assert.ok(ctx.surface.has('app.js'), 'app.js doit être dans la surface exécutée');
  assert.ok(ctx.surface.has('index.html'));
});
