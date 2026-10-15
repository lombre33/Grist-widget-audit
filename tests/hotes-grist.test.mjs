import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { axeDNonExecute } from './aide-chromium.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { estGrist } from '../src/contexte/hotes-grist.js';
import { analyserSortiesReseau } from '../src/regles/c-securite.js';
import { auditDynamique } from '../src/runtime/dynamique.js';

/**
 * Appeler l'API Grist officielle est l'usage normal d'un widget Grist : ni
 * l'axe C (C-EXFIL, B-DOC-04) ni l'axe D (D-RESEAU-01, critique et bloquant)
 * ne doivent le compter. La liste blanche est celle de `contexte/hotes-grist.js`,
 * partagée par les deux axes ; ce qui sort vers tout autre hôte reste signalé.
 */

const PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget de test</title>' +
  '<script src="https://docs.getgrist.com/grist-plugin-api.js"></script></head><body><div id="app"></div><script src="app.js"></script></body></html>';

function widget(t, urls) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-hotes-grist-'));
  fs.writeFileSync(path.join(racine, 'index.html'), PAGE);
  fs.writeFileSync(path.join(racine, 'app.js'),
    "grist.ready({ requiredAccess: 'read table' });\n" +
    urls.map((u) => `fetch('${u}').catch(() => {});\n`).join(''));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  return racine;
}

const OFFICIELLES = ['https://docs.getgrist.com/api/docs/abc/tables', 'https://monequipe.getgrist.com/api/docs/abc/tables/T/records'];
const DINUM = 'https://grist.numerique.gouv.fr/api/docs/abc/tables';
const IMITATIONS = ['https://getgrist.com.exemple.org/api/docs/abc', 'https://evilgetgrist.com/api/docs/abc'];
const EXTERNE = 'https://collecte.exemple.org/api/docs/abc';

test("estGrist reconnaît l'API Grist officielle et l'instance de l'État, jamais un hôte qui y ressemble", () => {
  for (const h of ['docs.getgrist.com', 'monequipe.getgrist.com', 'getgrist.com', 'grist.numerique.gouv.fr']) assert.ok(estGrist(h), h);
  for (const h of ['collecte.exemple.org', 'getgrist.com.exemple.org', 'evilgetgrist.com', 'numerique.gouv.fr', null, '']) assert.ok(!estGrist(h), String(h));
});

test("axe C : un appel à l'API Grist officielle n'est ni C-EXFIL ni un service à documenter, un hôte externe l'est toujours", (t) => {
  const ctx = construireContexte(widget(t, [...OFFICIELLES, DINUM, ...IMITATIONS, EXTERNE]));
  const constats = analyserSortiesReseau(ctx);

  assert.equal(constats.filter((c) => c.regle === 'C-EXFIL-01').length, 3, 'les trois hôtes non-Grist sont signalés, aucun hôte Grist');
  assert.ok(constats.every((c) => c.bloquant), 'une destination externe littérale reste bloquante');
  assert.deepEqual([...ctx.destinationsExternes].sort(), ['collecte.exemple.org', 'evilgetgrist.com', 'getgrist.com.exemple.org'], 'B-DOC-04 ne réclame que les hôtes non-Grist');
});

test("axe D : l'API Grist officielle ne donne pas D-RESEAU-01, un hôte externe ou qui imite Grist le donne toujours", async (t) => {
  const ctx = construireContexte(widget(t, [...OFFICIELLES, DINUM, ...IMITATIONS, EXTERNE]));
  const { constats, brut, nonExecute } = await auditDynamique(ctx, {});
  if (nonExecute) { axeDNonExecute(t, constats); return; }

  const reseau = constats.filter((c) => c.regle === 'D-RESEAU-01');
  assert.deepEqual(reseau.map((c) => c.preuve.hote).sort(), ['collecte.exemple.org', 'evilgetgrist.com', 'getgrist.com.exemple.org']);
  assert.ok(reseau.every((c) => c.bloquant));
  // Neutralisés comme tous les autres : rien n'est sorti vers l'hôte Grist non plus.
  assert.ok(brut.requetes.some((r) => r.hote === 'docs.getgrist.com'), "l'appel Grist est vu et neutralisé, pas laissé passer");
});

test("axe D : un widget qui n'appelle que l'API Grist officielle ne sort avec aucun constat réseau bloquant", async (t) => {
  const ctx = construireContexte(widget(t, OFFICIELLES));
  const { constats, nonExecute } = await auditDynamique(ctx, {});
  if (nonExecute) { axeDNonExecute(t, constats); return; }

  assert.equal(constats.filter((c) => c.regle === 'D-RESEAU-01').length, 0);
  assert.ok(constats.some((c) => c.regle === 'D-RESEAU-00'));
  assert.ok(!constats.some((c) => c.bloquant), 'aucun bloquant : ni le réseau, ni autre chose');
});
