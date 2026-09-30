#!/usr/bin/env node
/**
 * Ce que chaque plafond de l'outil coûte à des dépôts donnés, et la marge qui reste : la mesure qui décide si un plafond peut être un
 * constat bloquant (aucune cible honnête ne doit y buter). Pour chaque dépôt, ce qu'il consomme de chaque plafond ; puis, pour chaque
 * plafond, le plus gros de ces nombres, le plafond et la marge (plafond / plus gros).
 *
 * Usage : node scripts/mesurer-marges-plafonds.mjs [--json] <dépôt> [<dépôt>…]
 * Code 0 : mesuré ; code 2 : aucun dépôt, ou un dépôt qui n'existe pas (rien n'est mesuré à moitié). Voir `scripts/lib/marges-plafonds.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dire, marges, mesurerRacine } from './lib/marges-plafonds.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const racines = args.filter((a) => a !== '--json').map((a) => path.resolve(a));
if (!racines.length) {
  console.error('Usage : node scripts/mesurer-marges-plafonds.mjs [--json] <dépôt> [<dépôt>…]');
  process.exit(2);
}
const absentes = racines.filter((r) => !fs.existsSync(r) || !fs.statSync(r).isDirectory());
if (absentes.length) {
  console.error(`Dépôt introuvable : ${absentes.join(', ')}`);
  process.exit(2);
}

const mesures = [];
for (const racine of racines) mesures.push(await mesurerRacine(racine));
const resume = marges(mesures);

if (json) {
  console.log(JSON.stringify({ mesures, marges: resume }, null, 2));
} else {
  console.log(dire(resume, mesures.length));
}
