/**
 * Le code minifié : un fichier minifié est exempté des axes A et B, donc ne note jamais mieux que le même code lisible,
 * c'est B-MIN-01 qui plafonne la note globale. Le cas doux est une bibliothèque tierce que son en-tête identifie (axe E).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { estMinifie } from '../src/moteur/minifie.js';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { noter } from '../src/moteur/notation.js';
import { constat } from '../src/moteur/modele.js';
import { genererJson } from '../src/rapport/json.js';
import { genererHtml } from '../src/rapport/html.js';

const LISIBLE = Array.from({ length: 60 }, (_, i) => `
// Calcule la valeur numéro ${i}
export function calculer${i}(entree, options) {
  const resultat = [];
  for (const element of entree) {
    if (element.actif && options.filtre(element)) resultat.push({ cle: element.id, valeur: element.valeur * ${i + 2} });
  }
  return resultat;
}`).join('\n');
const MINIFIE = transformSync(LISIBLE, { minify: true, format: 'esm' }).code;

const PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>w</title></head><body><main><h1>w</h1></main><script type="module" src="app.js"></script></body></html>';
const README = '# w\n\nUn widget de test qui calcule des valeurs.\n\n## Installation\n\nOuvrir la page.\n\n## Accès\n\nAucun accès à Grist.\n';
const LICENCE = 'MIT License\n\nCopyright (c) 2026\n';

async function auditer(code) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-minifie-'));
  for (const [nom, contenu] of Object.entries({ 'index.html': PAGE, 'app.js': code, 'README.md': README, LICENSE: LICENCE })) fs.writeFileSync(path.join(dossier, nom), contenu);
  const ctx = construireContexte(dossier);
  const constats = await analyseStatique(ctx, { reseau: false });
  return { ctx, constats, notation: noter(constats, new Set(['D'])) };
}

test('estMinifie : du code minifié oui ; du code lisible, des commentaires très longs, une image en base64, un tableau de nombres non', () => {
  assert.equal(estMinifie(MINIFIE), true);
  assert.equal(estMinifie(LISIBLE), false);
  const commentaires = Array.from({ length: 30 }, (_, i) => `// ${'mot '.repeat(60)}${i}\nconst a${i} = ${i};`).join('\n');
  assert.equal(estMinifie(commentaires), false, 'des lignes longues de commentaire ne sont pas du code minifié');
  assert.equal(estMinifie(`const IMAGE = "data:image/png;base64,${'QUJD'.repeat(2000)}";\nexport const f = () => IMAGE;\n`), false);
  assert.equal(estMinifie(`export const D = [${Array.from({ length: 3000 }, (_, i) => i * 1.5).join(',')}];\n`), false);
});

test('un bundle minifié sans nom ni dossier : un seul constat B-MIN-01, la note plafonnée, aucun faux constat de qualité', async () => {
  const { constats, notation } = await auditer(MINIFIE);
  const min = constats.filter((c) => c.regle === 'B-MIN-01');
  assert.equal(min.length, 1);
  assert.equal(min[0].fichier, 'app.js');
  assert.equal(min[0].plafonneLaNote, true);
  assert.equal(constats.filter((c) => ['A-FONC-01', 'A-FONC-02', 'A-FONC-03', 'B-NOM-01'].includes(c.regle) && c.fichier === 'app.js').length, 0, 'le bundle est exempté des axes A et B');
  assert.ok(notation.global <= 79);
  assert.notEqual(notation.verdict, 'CONFORME');
  assert.deepEqual(notation.plafonne?.causes.map((c) => c.regle), ['B-MIN-01']);
  assert.match(notation.motif, /Note plafonnée à 79\/100 \(\d+\/100 avant le plafond\) : Code minifié sans origine identifiée : app\.js\./);
});

test('le même code lisible : pas de B-MIN-01, et il ne note pas moins bien que le minifié', async () => {
  const lisible = await auditer(LISIBLE);
  const minifie = await auditer(MINIFIE);
  assert.equal(lisible.constats.filter((c) => c.regle === 'B-MIN-01').length, 0);
  assert.equal(lisible.notation.plafonne, null);
  assert.ok(lisible.notation.global >= minifie.notation.global);
});

test('une bibliothèque tierce minifiée que son en-tête identifie : suivie par l\'axe E, pas plafonnée', async () => {
  const { constats, notation } = await auditer(`/*! calcul v2.4.1 | MIT License | (c) 2024 Les auteurs */\n${MINIFIE}`);
  assert.equal(constats.filter((c) => c.regle === 'B-MIN-01').length, 0);
  assert.equal(constats.find((c) => c.regle === 'E-DEP-02')?.severite, 'info');
  assert.equal(notation.plafonne, null);
});

test('noter : le plafond ne fait que baisser une note, laisse le bloquant maître du verdict et se dit dans le rapport', () => {
  const plafonnant = constat({ regle: 'X-1', axe: 'B', severite: 'info', confiance: 'certain', plafonneLaNote: true, titre: 'Code illisible', constat: 'c' });
  const n = noter([plafonnant], new Set());
  assert.equal(n.global, 79);
  assert.equal(n.verdict, 'CONFORME SOUS RÉSERVE');
  assert.equal(n.plafonne.globalMesure, 100);
  const json = JSON.parse(genererJson({ ctx: { fichiers: [], surface: new Set(), entrees: [] }, notation: n, meta: { nomDepot: 'w', version: '0' } }));
  assert.equal(json.plafonne.plafond, 79);
  assert.match(genererHtml({ ctx: { fichiers: [], surface: new Set(), entrees: [] }, notation: n, meta: { nomDepot: 'w', version: '0' } }), /class="motif-verdict motif-partiel">Note plafonnée/);

  const critiques = ['A', 'B', 'C', 'E', 'F'].map((axe) => constat({ regle: `X-${axe}`, axe, severite: 'critique', confiance: 'certain', titre: 't', constat: 'c' }));
  const dejaBas = noter([plafonnant, ...critiques], new Set(['D']));
  assert.ok(dejaBas.global < 79);
  assert.equal(dejaBas.plafonne, null, 'une note déjà sous le plafond n\'est pas relevée ni modifiée');
  assert.equal(dejaBas.global, noter(critiques, new Set(['D'])).global);
  const bloque = noter([plafonnant, constat({ regle: 'X-4', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain', titre: 't', constat: 'c' })], new Set());
  assert.equal(bloque.verdict, 'NON CONFORME');
});
