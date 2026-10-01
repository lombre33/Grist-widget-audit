// Un fichier de résultat qui n'en est pas un : tronqué, ou valide mais sans le marqueur de fin ; puis le
// travail se termine « proprement » (code 0) sans avoir rien rendu.
import fs from 'node:fs';
import path from 'node:path';
import { workerData } from 'node:worker_threads';

export async function executer(entree, { etape }) {
  etape('regles');
  const contenu = entree.variante === 'tronque' ? '{"termine":tr' : '{"resultat":{"constats":[]}}';
  fs.writeFileSync(path.join(workerData.dossier, 'resultat.json'), contenu);
  process.exit(0);
}
