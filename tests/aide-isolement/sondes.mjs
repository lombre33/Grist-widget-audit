// Un travail qui ne finit pas, et dont le pid est écrit : pour éprouver ce qui arrête l'enfant quand son parent s'en va.
import fs from 'node:fs';

export async function executer(entree, { etape }) {
  etape('regles');
  fs.writeFileSync(entree.fichierPids, JSON.stringify({ enfant: process.pid }));
  await new Promise((resolve) => setTimeout(resolve, 120_000));
}
