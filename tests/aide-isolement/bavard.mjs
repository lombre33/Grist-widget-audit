// Un travail qui écrit sur la sortie d'erreur, et rend le score de mort par manque de mémoire qu'il s'est vu donner.
import fs from 'node:fs';

export async function executer(entree, { etape }) {
  etape('regles');
  console.error(entree.ligne);
  let score = null;
  try { score = fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim(); } catch { /* pas de /proc */ }
  return { score };
}
