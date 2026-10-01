// Un résultat complet écrit, puis une fin en erreur : le processus ne finit pas proprement, le résultat n'est pas pris pour tel.
import fs from 'node:fs';
import path from 'node:path';
import { workerData } from 'node:worker_threads';

export async function executer(entree, { etape }) {
  etape('regles');
  fs.writeFileSync(path.join(workerData.dossier, 'resultat.json'), JSON.stringify({ termine: true, resultat: { faux: 'ne doit pas être rendu' } }));
  throw new Error('erreur après le résultat');
}
