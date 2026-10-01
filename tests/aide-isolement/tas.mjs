// Un tas épuisé : le Worker le rattrape (ERR_WORKER_OUT_OF_MEMORY) pour une limite explicite.
export async function executer(entree, { etape, partiel }) {
  etape('regles');
  partiel({ vu: 'partiel' });
  // Sans limite de tas appliquée, l'essai finit à 1 Go au lieu de s'emballer : le test voit alors un travail qui « aboutit ».
  const garde = [];
  for (let i = 0; i < 1250; i++) garde.push(new Array(100_000).fill(i));
  return { alloue: garde.length };
}
