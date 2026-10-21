import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { axeDNonExecute } from './aide-chromium.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { estGrist, documentGristVise } from '../src/contexte/hotes-grist.js';
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

const OFFICIELLES = ['https://docs.getgrist.com/api/session/access/active', 'https://monequipe.getgrist.com/api/orgs'];
const DINUM = 'https://grist.numerique.gouv.fr/api/orgs';
// Un document précis d'un hôte Grist : le document ouvert n'est jamais nommé dans le code, il vient de `getAccessToken`.
const DOCUMENTS = ['https://docs.getgrist.com/api/docs/abc/tables', 'https://grist.numerique.gouv.fr/api/docs/def/tables/T/records'];
const IMITATIONS = ['https://getgrist.com.exemple.org/api/docs/abc', 'https://evilgetgrist.com/api/docs/abc'];
const EXTERNE = 'https://collecte.exemple.org/api/docs/abc';

test("estGrist reconnaît l'API Grist officielle et l'instance de l'État, jamais un hôte qui y ressemble", () => {
  for (const h of ['docs.getgrist.com', 'monequipe.getgrist.com', 'getgrist.com', 'grist.numerique.gouv.fr']) assert.ok(estGrist(h), h);
  for (const h of ['collecte.exemple.org', 'getgrist.com.exemple.org', 'evilgetgrist.com', 'numerique.gouv.fr', null, '']) assert.ok(!estGrist(h), String(h));
});

test("documentGristVise nomme le document d'une adresse de l'API Grist, rien pour le reste", () => {
  assert.equal(documentGristVise('https://docs.getgrist.com/api/docs/abc/tables'), 'abc');
  assert.equal(documentGristVise('https://monequipe.getgrist.com/api/docs/def'), 'def');
  for (const url of ['https://docs.getgrist.com/api/orgs', 'https://docs.getgrist.com/grist-plugin-api.js', 'https://docs.getgrist.com/api/docs/', 'https://evilgetgrist.com/api/docs/abc/tables', '/api/docs/abc', 'pas une adresse', null]) {
    assert.equal(documentGristVise(url), null, String(url));
  }
});

test("axe C : un appel à l'API Grist officielle n'est ni C-EXFIL ni un service à documenter, un document précis ou un hôte externe l'est toujours", (t) => {
  const ctx = construireContexte(widget(t, [...OFFICIELLES, DINUM, ...DOCUMENTS, ...IMITATIONS, EXTERNE]));
  const constats = analyserSortiesReseau(ctx);

  assert.equal(constats.filter((c) => c.regle === 'C-EXFIL-01').length, 3, 'les trois hôtes non-Grist sont signalés, aucun hôte Grist');
  assert.ok(constats.filter((c) => c.regle === 'C-EXFIL-01').every((c) => c.bloquant), 'une destination externe littérale reste bloquante');
  const documents = constats.filter((c) => c.regle === 'C-EXFIL-08');
  assert.deepEqual(documents.map((c) => c.titre.split(' : ').pop()).sort(), ['abc', 'def'], 'un document Grist écrit dans le code est signalé, pas les appels sans document');
  assert.ok(documents.every((c) => c.severite === 'majeur' && !c.bloquant));
  assert.deepEqual([...ctx.destinationsExternes].sort(), ['collecte.exemple.org', 'evilgetgrist.com', 'getgrist.com.exemple.org'], 'B-DOC-04 ne réclame que les hôtes non-Grist');
});

test("axe D : l'API Grist officielle sans document ne donne aucun constat réseau, un document précis donne D-RESEAU-03, un hôte externe ou qui imite Grist D-RESEAU-01", async (t) => {
  const ctx = construireContexte(widget(t, [...OFFICIELLES, DINUM, ...DOCUMENTS, ...IMITATIONS, EXTERNE]));
  const { constats, brut, nonExecute } = await auditDynamique(ctx, {});
  if (nonExecute) { axeDNonExecute(t, constats); return; }

  const reseau = constats.filter((c) => c.regle === 'D-RESEAU-01');
  assert.deepEqual(reseau.map((c) => c.preuve.hote).sort(), ['collecte.exemple.org', 'evilgetgrist.com', 'getgrist.com.exemple.org']);
  assert.ok(reseau.every((c) => c.bloquant));
  const documents = constats.filter((c) => c.regle === 'D-RESEAU-03');
  assert.deepEqual(documents.map((c) => c.preuve.document).sort(), ['abc', 'def']);
  assert.ok(documents.every((c) => c.severite === 'majeur' && !c.bloquant));
  // Neutralisés comme tous les autres : rien n'est sorti vers l'hôte Grist non plus.
  assert.ok(brut.requetes.some((r) => r.hote === 'docs.getgrist.com'), "l'appel Grist est vu et neutralisé, pas laissé passer");
});

test("axe D : un widget qui n'appelle que l'API Grist officielle sans document ne sort avec aucun constat réseau bloquant", async (t) => {
  const ctx = construireContexte(widget(t, OFFICIELLES));
  const { constats, nonExecute } = await auditDynamique(ctx, {});
  if (nonExecute) { axeDNonExecute(t, constats); return; }

  assert.equal(constats.filter((c) => c.regle === 'D-RESEAU-01' || c.regle === 'D-RESEAU-03').length, 0);
  assert.ok(constats.some((c) => c.regle === 'D-RESEAU-00'));
  assert.ok(!constats.some((c) => c.bloquant), 'aucun bloquant : ni le réseau, ni autre chose');
});
