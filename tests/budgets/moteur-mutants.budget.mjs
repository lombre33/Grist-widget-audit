/**
 * Budget de temps du moteur de mutants, déplacé de `tests/rejouer-mutants-processus.test.mjs` : un lot est
 * synchrone de bout en bout, `kill` doit l'arrêter sur-le-champ (aucun gestionnaire de signal ne le retient) et non
 * à la fin de sa suite. Ce qui distingue un gestionnaire qui retient le signal, lui, est dans la suite par défaut
 * (le lot meurt du signal, pas d'un code). Voir scripts/lib/budgets.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MODULE_MOTEUR, MUTANTS, creerProjet, nettoyerDossier, prive } from '../aide-moteur-mutants.mjs';

export const cas = [{
  nom: 'moteur de mutants : un lot tué par SIGTERM s\'arrête sur-le-champ, sans attendre la fin de sa suite (60 s)',
  budgetMs: 5000,
  async executer() {
    const dossier = prive();
    const copies = path.join(dossier, 'tmp');
    fs.mkdirSync(copies);
    const projet = creerProjet(dossier);
    const fichierPid = path.join(dossier, 'orphelin.pid');
    const script = path.join(dossier, 'lot.mjs');
    fs.writeFileSync(script, [
      `import { rejouerMutants } from ${JSON.stringify(MODULE_MOTEUR)};`,
      `const mutants = [${JSON.stringify(MUTANTS.orphelin)}];`,
      `process.exitCode = rejouerMutants({ mutants, groupes: [{ nom: 'essai', fichiers: ['tests/f.test.mjs'] }], exigerChromium: false, dossiers: ['src', 'tests'], racine: ${JSON.stringify(projet)}, delaiMs: 60000 });`,
    ].join('\n'));
    const lot = spawn(process.execPath, [script], { env: { ...process.env, TMPDIR: copies, ESSAI_MOTEUR_PID: fichierPid }, stdio: 'ignore' });
    const fini = new Promise((resolve) => lot.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      // Le lot tourne quand son orphelin a dit son numéro : c'est de là que le temps compte, pas du démarrage.
      for (let i = 0; i < 400 && !fs.existsSync(fichierPid); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(fs.existsSync(fichierPid), 'le mutant tourne : son orphelin a dit son numéro');
      const debut = performance.now();
      lot.kill('SIGTERM');
      const { signal } = await fini;
      assert.equal(signal, 'SIGTERM', 'le lot est mort du signal');
      return { dureeMs: performance.now() - debut };
    } finally {
      lot.kill('SIGKILL');
      nettoyerDossier(dossier);
    }
  },
}];
