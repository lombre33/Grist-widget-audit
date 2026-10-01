// Une erreur non rattrapée du travail.
export async function executer(entree, { etape }) {
  etape(entree.etape ?? 'regles');
  throw new Error('la règle X a planté sur ce fichier');
}
