// Un travail qui aboutit en laissant derrière lui un processus qui ne s'arrête pas (un `npm audit` qui traîne).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export async function executer(entree, { etape }) {
  etape('regles');
  const petit = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(entree.fichierPids, JSON.stringify({ petitEnfant: petit.pid }));
  return { fini: true };
}
