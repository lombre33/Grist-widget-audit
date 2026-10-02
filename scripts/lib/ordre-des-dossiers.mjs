/**
 * Chargé par `node --import` : `fs.readdirSync` rend ses entrées dans l'ordre que dit `GWAUDIT_ORDRE_FS` : `naturel` (celui du système de fichiers), `inverse`, ou `tourne`
 * (la première entrée passe en dernier). Aucun système de fichiers ne promet un ordre (ext4, NTFS, overlayfs et APFS en rendent chacun un) : cela le fait varier sans changer
 * de machine (`scripts/comparer-ordre-des-dossiers.mjs`).
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const ordre = process.env.GWAUDIT_ORDRE_FS ?? 'naturel';
// Un ordre inconnu rendrait l'ordre du système de fichiers sans le dire : la mesure ne prouverait rien.
if (!['naturel', 'inverse', 'tourne'].includes(ordre)) throw new Error(`GWAUDIT_ORDRE_FS : « ${ordre} » n'est pas un ordre connu (naturel, inverse, tourne).`);

const reel = fs.readdirSync;
fs.readdirSync = function readdirSync(...args) {
  const entrees = reel.apply(this, args);
  if (!Array.isArray(entrees) || entrees.length < 2) return entrees;
  if (ordre === 'inverse') return [...entrees].reverse();
  if (ordre === 'tourne') return [...entrees.slice(1), entrees[0]];
  return entrees;
};
// Un `import { readdirSync } from 'node:fs'` voit lui aussi la version qui range.
syncBuiltinESMExports();
