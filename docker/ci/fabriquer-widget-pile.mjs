// Fabrique, dans <dossier>, le piège de la pile : une page et un `piege.js` de <niveaux> « x=>{ » imbriqués, refermés par
// autant de « } » (quelques dizaines de Kio). À 440 niveaux, sur le fil principal de Node 22, l'analyseur remplit la pile à
// l'endroit où V8 compile une expression régulière : « FATAL ERROR: RegExpCompiler Allocation failed - process out of memory »,
// SIGABRT, aucun rapport (relevé par la coordination sur 0c741ce). Dans l'enfant de l'analyse, le fil de travail a plus de pile :
// 440 niveaux se lisent, l'abandon revient à partir de 1 800 niveaux (mesuré). Sert à `verifier.sh interruption`.
//
// Usage : node docker/ci/fabriquer-widget-pile.mjs <dossier> <niveaux>
import fs from 'node:fs';
import path from 'node:path';

const [dossier, niveaux] = process.argv.slice(2);
const n = Number(niveaux);
if (!dossier || !Number.isInteger(n) || n < 1) {
  console.error('usage : fabriquer-widget-pile.mjs <dossier> <niveaux>');
  process.exit(2);
}
fs.mkdirSync(dossier, { recursive: true });
fs.writeFileSync(path.join(dossier, 'index.html'), '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget à pile pleine</title></head><body><main><h1>Widget à pile pleine</h1></main><script src="piege.js"></script></body></html>\n');
fs.writeFileSync(path.join(dossier, 'piege.js'), 'x=>{'.repeat(n) + '}'.repeat(n));
console.log(`${dossier} : ${n} niveaux d'imbrication, ${(fs.statSync(path.join(dossier, 'piege.js')).size / 1024).toFixed(1)} Kio`);
