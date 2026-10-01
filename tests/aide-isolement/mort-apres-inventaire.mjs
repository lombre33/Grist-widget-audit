// Le travail réel jusqu'à la fin de l'inventaire (le contexte sort dans `partiel`), puis l'abandon de V8 : la mort
// en cours de règles, sans dépendre de la mémoire ni de la vitesse de la machine.
import { construireContexte } from '../../src/contexte/inventaire.js';
import { resumerContexte } from '../../src/contexte/resume.js';

export async function executer({ racine }, { etape, partiel }) {
  etape('inventaire');
  const ctx = construireContexte(racine);
  partiel(resumerContexte(ctx));
  etape('regles');
  process.kill(process.pid, 'SIGABRT');
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
