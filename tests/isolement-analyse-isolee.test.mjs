/**
 * L'analyse isolée (src/isolement/analyse-isolee.js) : ce qu'elle rend selon que l'enfant a abouti, est mort
 * après ou avant la fin de l'inventaire, ou n'a jamais commencé. Un enfant mort avant sa première étape n'a rien
 * lu du dépôt : c'est une panne de l'outil, pas un fait du widget, et elle ne devient jamais un rapport de repli
 * (sortie 3 à la ligne de commande, pas un NON CONFORME inventé).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeSynthetique } from '../scripts/lib/code-synthetique.mjs';
import { analyserEnEnfant } from '../src/isolement/analyse-isolee.js';
import { ErreurLancement } from '../src/isolement/enfant.js';

const AIDE = (nom) => fileURLToPath(new URL(`./aide-isolement/${nom}.mjs`, import.meta.url));
const EXEMPLE = path.resolve(import.meta.dirname, '..', 'fixtures', 'widget-exemple');
const analyser = (options) => analyserEnEnfant({ racine: EXEMPLE, reseau: false, limites: {}, relayerStderr: null, ...options });

test('une analyse qui aboutit : les constats, le contexte et le pic de mémoire de l\'enfant, aucune interruption', async () => {
  const a = await analyser({});
  assert.equal(a.ok, true);
  assert.equal(a.interruption, null);
  assert.ok(a.constats.length > 0);
  assert.equal(a.constats.some((c) => c.regle === 'C-SURFACE-03' && c.preuve?.cause === 'interruption'), false);
  assert.deepEqual(a.ctx.entrees, ['index.html']);
  assert.ok(a.ctx.usagesGrist, 'le contexte de fin porte ce que l\'axe C a lu');
  assert.ok(a.mesures.rssMaxMo > 20);
});

test('mort après l\'inventaire : le rapport de repli (un seul constat) et le contexte sorti avant la mort', { skip: process.platform === 'win32' && 'SIGABRT : sous Windows le processus est tué sans signal' }, async () => {
  const a = await analyser({ module: AIDE('mort-apres-inventaire') });
  assert.equal(a.ok, false);
  assert.equal(a.interruption.genre, 'abandon');
  assert.equal(a.interruption.etape, 'regles');
  assert.deepEqual(a.constats.map((c) => c.regle), ['C-SURFACE-03']);
  assert.equal(a.constats[0].preuve.etape, 'regles');
  assert.match(a.constats[0].constat, /plus gros fichier de code du widget est `grist-plugin-api\.js`/, 'le résumé sorti avant la mort désigne le plus gros fichier de code');
  assert.deepEqual(a.ctx.entrees, ['index.html']);
  assert.equal(a.ctx.usagesGrist, undefined);
});

test('mort pendant l\'inventaire (tas de 64 Mio, 1,1 Mio de code) : le rapport de repli sans contexte', { timeout: 120_000 }, async (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-analyse-isolee-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dossier, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><script src="gros.js"></script></body></html>\n');
  fs.writeFileSync(path.join(dossier, 'gros.js'), codeSynthetique(1_100_000, 7));
  const a = await analyser({ racine: dossier, limites: { limiteMo: 64 } });
  assert.equal(a.ok, false);
  assert.equal(a.interruption.genre, 'tas');
  assert.equal(a.interruption.etape, 'inventaire');
  assert.equal(a.ctx, null, 'aucun contexte : l\'inventaire n\'a pas fini');
  assert.deepEqual(a.constats.map((c) => c.regle), ['C-SURFACE-03']);
  assert.doesNotMatch(a.constats[0].constat, /plus gros fichier/, 'sans inventaire, aucun fichier n\'est désigné');
  assert.match(a.constats[0].constat, /64 Mio/);
});

test('un enfant qui meurt avant sa première étape : ErreurLancement, pas de rapport de repli', async () => {
  await assert.rejects(analyser({ module: AIDE('mort-avant-etape') }), (e) => e instanceof ErreurLancement && /avant de commencer.*SIGKILL/.test(e.message));
});

test('un module de travail qui ne se charge pas : ErreurLancement, pas de rapport de repli', async () => {
  await assert.rejects(analyser({ module: AIDE('n-existe-pas') }), (e) => e instanceof ErreurLancement && /avant de commencer/.test(e.message));
});

test('une erreur du travail après sa première étape : un rapport de repli (cause « exception »), jamais une sortie 3', async () => {
  const a = await analyser({ module: AIDE('exception') });
  assert.equal(a.ok, false);
  assert.equal(a.interruption.genre, 'exception');
  assert.deepEqual(a.constats.map((c) => c.regle), ['C-SURFACE-03']);
});
