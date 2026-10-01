// Un travail qui ne finit pas, avec un petit-enfant qui ne finirait pas non plus (comme `npm audit`) : les deux pids sont écrits.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export async function executer(entree, { etape }) {
  etape('regles');
  const petit = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(entree.fichierPids, JSON.stringify({ enfant: process.pid, petitEnfant: petit.pid }));
  await new Promise((resolve) => setTimeout(resolve, 120_000));
}
