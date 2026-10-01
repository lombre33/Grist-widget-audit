// Un travail qui aboutit : annonce une étape, sort un résultat partiel, rend une somme.
export async function executer(entree, { etape, partiel }) {
  etape('addition');
  partiel({ vu: 'partiel' });
  return { somme: entree.a + entree.b };
}
