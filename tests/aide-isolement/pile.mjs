// La profondeur de récursion atteinte avant le dépassement de pile : plus la pile du fil de travail est grande, plus elle l'est.
export async function executer(entree, { etape }) {
  etape('regles');
  let profondeur = 0;
  const descendre = () => { profondeur += 1; descendre(); };
  try { descendre(); } catch (e) { if (!(e instanceof RangeError)) throw e; }
  return { profondeur };
}
