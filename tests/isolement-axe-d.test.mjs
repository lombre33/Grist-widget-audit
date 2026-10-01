/**
 * L'axe D joué sur un contexte qui n'est pas celui de l'analyse entière (src/isolement, src/contexte/resume.js) :
 *  1. le résumé d'un contexte complet donne à l'axe D les mêmes constats que le contexte entier (D-PERIMETRE-01
 *     lit le README et le niveau d'accès demandé) ;
 *  2. quand l'analyse du code s'est interrompue APRÈS l'inventaire, le résumé sorti avant la mort suffit à jouer
 *     l'axe D, et le constat qui aurait besoin du niveau d'accès demandé (que l'axe C n'a pas eu le temps de lire)
 *     le dit au lieu de passer pour une absence d'annonce ;
 *  3. quand elle s'est interrompue AVANT la fin de l'inventaire, l'axe D n'a rien à ouvrir : il est dit non
 *     exécuté (D-INDISPONIBLE), sans lancer de navigateur.
 *
 * La mort est celle de V8 (SIGABRT) provoquée par le travail lui-même juste après l'inventaire
 * (tests/aide-isolement/mort-apres-inventaire.mjs) : elle ne dépend ni de la mémoire ni de la vitesse.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { axeDNonExecute } from './aide-chromium.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { contexteDepuisResume, resumerContexte } from '../src/contexte/resume.js';
import { analyserEnEnfant } from '../src/isolement/analyse-isolee.js';
import { auditerAxeD } from '../src/isolement/axe-d.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { auditDynamique } from '../src/runtime/dynamique.js';

const MORT = fileURLToPath(new URL('./aide-isolement/mort-apres-inventaire.mjs', import.meta.url));

/** Un widget qui demande l'accès complet, énumère les tables puis les lit toutes : D-PERIMETRE-01, bloquant, quand le README ne l'annonce pas. */
function widgetQuiLitToutesLesTables(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-isolement-d-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'index.html'),
    '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget de test</title><script src="https://docs.getgrist.com/grist-plugin-api.js"></script></head><body><div id="app"></div><script src="app.js"></script></body></html>');
  fs.writeFileSync(path.join(d, 'app.js'),
    "grist.ready({ requiredAccess: 'full' });\n(async () => {\n  const tables = await grist.docApi.listTables();\n  for (const t of tables) { await grist.docApi.fetchTable(t); }\n})();\n");
  fs.writeFileSync(path.join(d, 'README.md'), '# Widget\n\nUn widget de test.\n');
  return d;
}

const perimetre = (constats) => constats.find((c) => c.regle === 'D-PERIMETRE-01');

test('axe D sur le résumé d\'un contexte complet : le même D-PERIMETRE-01 que sur le contexte entier', { timeout: 240_000 }, async (t) => {
  const racine = widgetQuiLitToutesLesTables(t);
  const ctx = construireContexte(racine);
  await analyseStatique(ctx, { reseau: false });
  const entier = await auditDynamique(ctx, {});
  if (entier.nonExecute) { axeDNonExecute(t, entier.constats); return; }
  const resume = await auditDynamique(contexteDepuisResume(resumerContexte(ctx)), {});
  assert.ok(perimetre(entier.constats), 'le widget déclenche D-PERIMETRE-01 : la comparaison porte sur quelque chose');
  assert.equal(perimetre(entier.constats).bloquant, true);
  assert.deepEqual(perimetre(resume.constats)?.constat, perimetre(entier.constats).constat);
});

test('axe D après une mort de l\'analyse en cours de règles : il joue sur le résumé sorti avant, et D-PERIMETRE-01 dit ce qui lui manque', { timeout: 240_000 }, async (t) => {
  const racine = widgetQuiLitToutesLesTables(t);
  const analyse = await analyserEnEnfant({ racine, reseau: false, limites: {}, relayerStderr: null, module: MORT });
  assert.equal(analyse.ok, false);
  assert.equal(analyse.interruption.genre, 'abandon');
  assert.equal(analyse.interruption.etape, 'regles');
  assert.ok(analyse.ctx, 'le contexte est sorti avant la mort');
  assert.equal(analyse.ctx.usagesGrist, undefined, 'le niveau d\'accès est lu par l\'axe C, qui n\'a pas tourné');
  assert.deepEqual(analyse.ctx.entrees, ['index.html']);

  const d = await auditerAxeD(analyse, {});
  if (d.nonExecute) { axeDNonExecute(t, d.constats); return; }
  assert.equal(d.joue, true);
  const c = perimetre(d.constats);
  assert.ok(c, 'l\'axe D a joué sur le résumé et a trouvé la lecture de la table témoin');
  assert.equal(c.bloquant, true);
  assert.match(c.constat, /Précision : l'analyse statique s'est interrompue avant de lire le niveau d'accès/);
});

test('axe D après une analyse qui a abouti : aucune précision ajoutée, l\'axe joue comme avant', { timeout: 240_000 }, async (t) => {
  const racine = widgetQuiLitToutesLesTables(t);
  const analyse = await analyserEnEnfant({ racine, reseau: false, limites: {}, relayerStderr: null });
  assert.equal(analyse.ok, true);
  const d = await auditerAxeD(analyse, {});
  if (d.nonExecute) { axeDNonExecute(t, d.constats); return; }
  assert.doesNotMatch(perimetre(d.constats).constat, /Précision : l'analyse statique s'est interrompue/);
});

test('axe D sans contexte (l\'analyse est morte avant la fin de l\'inventaire) : non exécuté, D-INDISPONIBLE, aucun navigateur lancé', async () => {
  const cause = { genre: 'noyau', raison: 'processus tué par le noyau', etape: 'inventaire', code: null, signal: 'SIGKILL', fin: '' };
  const d = await auditerAxeD({ ok: false, ctx: null, interruption: cause }, {});
  assert.equal(d.joue, false);
  assert.equal(d.nonExecute, true);
  assert.deepEqual(d.constats.map((c) => c.regle), ['D-INDISPONIBLE']);
  assert.match(d.constats[0].constat, /processus tué par le noyau/);
});
