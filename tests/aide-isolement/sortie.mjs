// Un travail qui finit avec un code de sortie sans avoir rendu de résultat.
export async function executer(entree, { etape }) {
  etape('regles');
  process.exit(entree.code);
}
