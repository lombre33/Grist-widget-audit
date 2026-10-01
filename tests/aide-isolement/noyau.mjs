// Le noyau qui tue le processus faute de mémoire : SIGKILL, rien à rattraper.
export async function executer(entree, { etape, partiel }) {
  etape('regles');
  partiel({ vu: 'partiel' });
  process.kill(process.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
