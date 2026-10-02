#!/usr/bin/env node
/**
 * Mesure ce que demande chaque widget à la recherche de duplication : le plus petit plafond de pas (`SEUILS_CLONES.pas`, `src/moteur/clones.js`) avec lequel
 * elle rend le même résultat que sans plafond qui la coupe. C'est la mesure sur laquelle le plafond du moteur est réglé : à rejouer sur des widgets réels
 * avant de le changer. Ce que coûte une entrée piégée qui atteint le plafond se chronomètre à part (`scripts/chronometrer-pieges.mjs`).
 *
 * Usage : node scripts/mesurer-pas-clones.mjs <dossier de widget…>
 * Une ligne par dossier : le plus petit plafond essayé, et le temps de la recherche à ce plafond (la recherche seule : le contexte est lu une fois).
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { construireContexte } from '../src/contexte/inventaire.js';
import { SEUILS_CLONES } from '../src/moteur/clones.js';
import { analyserDuplication } from '../src/regles/a-qualite.js';

/** Les plafonds essayés, du plus petit au plus grand ; le dernier est la référence : au-dessus de tout ce qu'un widget réel demande. */
const ESSAIS = [1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000, 3_000_000, 10_000_000, 30_000_000];
const REFERENCE = ESSAIS.at(-1);

/** Ce que la recherche rend, sans ce qui change d'un lancement à l'autre (l'identifiant d'un constat). */
const resultat = (ctx, pas) => JSON.stringify(analyserDuplication(ctx, { seuils: { pas } }).map(({ uid, ...reste }) => reste));

const { positionals: dossiers } = parseArgs({ allowPositionals: true });
if (!dossiers.length) { console.error('Usage : node scripts/mesurer-pas-clones.mjs <dossier de widget…>'); process.exit(2); }

const pad = (n) => n.toLocaleString('fr-FR').replaceAll(/\s/g, ' ');
console.log(`Plafond du moteur : ${pad(SEUILS_CLONES.pas)} pas.`);
for (const dossier of dossiers) {
  const ctx = construireContexte(path.resolve(dossier));
  const attendu = resultat(ctx, REFERENCE);
  let demande = null;
  let ms = 0;
  for (const pas of ESSAIS) {
    const t = performance.now();
    const rendu = resultat(ctx, pas);
    ms = performance.now() - t;
    if (rendu === attendu) { demande = pas; break; }
  }
  const nom = path.basename(path.resolve(dossier)).padEnd(32);
  if (demande === null) console.log(`${nom} résultat instable : la référence ne rend pas deux fois la même chose`);
  else console.log(`${nom} ${pad(demande).padStart(12)} pas  (${Math.round(ms)} ms)${demande > SEUILS_CLONES.pas ? '  > plafond du moteur' : ''}`);
}
