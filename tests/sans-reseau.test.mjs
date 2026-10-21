/**
 * `--sans-reseau` ne lance pas `npm audit` : pour un dépôt qui verrouille ses dépendances, l'axe E est vu en partie.
 * Le rapport et le verdict le disent, comme pour un `npm audit` qui échoue (E-VULN-00) : un E à 100 ne se lit pas
 * comme « aucune vulnérabilité connue ». Aucun essai ne lance `npm audit` (réseau) : seule l'option `reseau: false` est exercée.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { noter } from '../src/moteur/notation.js';
import { genererHtml } from '../src/rapport/html.js';
import { genererMarkdown } from '../src/rapport/markdown.js';
import { genererJson } from '../src/rapport/json.js';

function depot(fichiers) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-sans-reseau-'));
  for (const [nom, contenu] of Object.entries(fichiers)) fs.writeFileSync(path.join(dossier, nom), contenu);
  return dossier;
}
const PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>w</title></head><body><main><h1>w</h1></main></body></html>';
const PAQUET = '{"name":"w","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}';
const LICENCE = 'MIT License\n\nCopyright (c) 2026\n';
const VERROU = '{"name":"w","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}';

const constatsE = async (fichiers) => {
  const ctx = construireContexte(depot(fichiers));
  return { ctx, constats: (await analyseStatique(ctx, { reseau: false })).filter((c) => c.axe === 'E') };
};

test('dépôt verrouillé et --sans-reseau : un constat E-VULN-OPTION, information, mesure partielle de l\'axe E', async () => {
  const { constats } = await constatsE({ 'index.html': PAGE, 'LICENSE': LICENCE, 'package.json': PAQUET, 'package-lock.json': VERROU });
  const c = constats.find((x) => x.regle === 'E-VULN-OPTION');
  assert.ok(c, 'le constat manque');
  assert.equal(c.severite, 'info');
  assert.equal(c.mesurePartielle, true);
  assert.equal(c.bloquant, false);
});

test('yarn.lock ou pnpm-lock.yaml verrouillent aussi ; sans verrou (ou sans dépendance), il n\'y a rien que le réseau aurait vérifié', async () => {
  const yarn = await constatsE({ 'index.html': PAGE, 'package.json': PAQUET, 'yarn.lock': '' });
  assert.ok(yarn.constats.some((c) => c.regle === 'E-VULN-OPTION'));
  const sansVerrou = await constatsE({ 'index.html': PAGE, 'package.json': PAQUET });
  assert.ok(!sansVerrou.constats.some((c) => c.regle === 'E-VULN-OPTION'), 'sans verrou npm audit n\'aurait rien lu (E-DEP-04 le dit)');
  const sansDependance = await constatsE({ 'index.html': PAGE });
  assert.ok(!sansDependance.constats.some((c) => c.regle === 'E-VULN-OPTION'));
});

const partiel = async () => (await constatsE({ 'index.html': PAGE, 'LICENSE': LICENCE, 'package.json': PAQUET, 'package-lock.json': VERROU })).constats;

test('verdict : la note de l\'axe E ne bouge pas, mais le CONFORME devient SOUS RÉSERVE et le motif nomme l\'axe E', async () => {
  const constats = await partiel();
  const n = noter(constats, new Set());
  assert.deepEqual(n.axesPartiels, ['E']);
  assert.equal(n.parAxe.E.partiel, true);
  assert.equal(n.verdict, 'CONFORME SOUS RÉSERVE');
  assert.match(n.motif, /Audit partiel — couverture incomplète : E \(.*\) — Recherche de vulnérabilités connues non lancée/);
  // Sans l'option, le même dépôt reste CONFORME : le plafond ne vient que du constat.
  const sans = noter(constats.filter((c) => c.regle !== 'E-VULN-OPTION'), new Set());
  assert.equal(sans.verdict, 'CONFORME');
  assert.deepEqual(sans.axesPartiels, []);
  assert.equal(sans.parAxe.E.partiel, undefined);
  assert.equal(n.parAxe.E.score, sans.parAxe.E.score, 'l\'axe reste dans la moyenne : seule la lecture change');
});

test('les trois rapports disent la mesure partielle : motif en valeur, jauge, section de l\'axe, tableau', async () => {
  const notation = noter(await partiel(), new Set());
  const rapport = { ctx: { fichiers: [], surface: new Set(), entrees: [] }, notation, meta: { nomDepot: 'w', version: '0' } };
  const html = genererHtml(rapport);
  assert.match(html, /<p class="motif-verdict motif-partiel">⚠️ Audit partiel/);
  assert.match(html, /\d+\/100 · mesure partielle/);
  assert.match(html, /<p class="axe-partiel">Mesure partielle/);
  assert.equal((html.match(/mesure partielle/gi) ?? []).length >= 3, true, "la jauge, son libellé accessible et la section de l'axe");
  const md = genererMarkdown(rapport);
  assert.match(md, /\| E — [^|]*\| \d+\/100 \(partiel\) \|/);
  assert.match(md, /> Axes mesurés en partie : E\./);
  const json = JSON.parse(genererJson(rapport));
  assert.deepEqual(json.axesPartiels, ['E']);
});
