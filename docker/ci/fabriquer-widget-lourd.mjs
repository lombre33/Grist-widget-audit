// Fabrique, dans <dossier>, un widget dont l'analyse du code coûte beaucoup de mémoire : une page et un seul
// fichier de code synthétique de <Mio> Mio (scripts/lib/code-synthetique.mjs, déterministe). Sert à
// `verifier.sh interruption`, qui éprouve dans l'image, sous son plafond de mémoire, ce que devient un audit
// dont l'analyse du code ne tient pas dans sa limite.
//
// Usage : node docker/ci/fabriquer-widget-lourd.mjs <dossier> <Mio>
import fs from 'node:fs';
import path from 'node:path';
import { codeSynthetique } from '../../scripts/lib/code-synthetique.mjs';

const [dossier, mio] = process.argv.slice(2);
if (!dossier || !(Number(mio) > 0)) {
  console.error('usage : fabriquer-widget-lourd.mjs <dossier> <Mio>');
  process.exit(2);
}
fs.mkdirSync(dossier, { recursive: true });
fs.writeFileSync(path.join(dossier, 'index.html'), '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget lourd</title></head><body><main><h1>Widget lourd</h1></main><script src="gros.js"></script></body></html>\n');
fs.writeFileSync(path.join(dossier, 'gros.js'), codeSynthetique(Math.round(Number(mio) * 1024 * 1024), 7));
console.log(`${dossier} : ${(fs.statSync(path.join(dossier, 'gros.js')).size / 1048576).toFixed(2)} Mio de code`);
