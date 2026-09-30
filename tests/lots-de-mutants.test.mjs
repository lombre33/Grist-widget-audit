/**
 * Chaque lot de mutants (`scripts/mutants-*.mjs`) désigne encore le code qu'il muté : la chaîne d'origine de
 * chacun de ses mutants s'y trouve une fois, le code muté compile, les fichiers de test existent. Un lot dont
 * un motif est périmé (le code a changé de place ou de forme) ne tue plus rien, et rien ne le dit tant que
 * personne ne le rejoue ; il devient muet sans faire échouer aucun test. Cet essai lance la vérification
 * d'avance du moteur (`--valider`) sur tous les lots : la suite passe au rouge dès qu'un lot devient muet, et
 * le message dit chaque motif périmé avec son fichier (voir `tests/rejouer-mutants-valider.test.mjs` pour le
 * moteur lui-même).
 *
 * Les lots sont trouvés dans `scripts/` : un lot de plus est vérifié sans toucher à cet essai. Aucun
 * Chromium n'est nécessaire (la vérification ne lance aucune suite) : la variable qui le désigne est retirée
 * de l'environnement des lots, ce qui éprouve aussi qu'un lot qui l'exige la vérifie sans lui.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = new URL('../scripts/', import.meta.url);
const LOTS = fs.readdirSync(SCRIPTS).filter((nom) => /^mutants-.+\.mjs$/.test(nom)).sort();

/** Un lot lancé avec `--valider`, dans son processus : ce qu'il rend. */
function verifier(lot) {
  const env = { ...process.env };
  delete env.GWAUDIT_CHROMIUM_PATH;
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const enfant = spawn(process.execPath, [fileURLToPath(new URL(lot, SCRIPTS)), '--valider'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let sortie = '';
    let erreur = '';
    enfant.stdout.on('data', (d) => { sortie += d; });
    enfant.stderr.on('data', (d) => { erreur += d; });
    enfant.on('close', (status, signal) => resolve({ lot, status, signal, sortie, erreur }));
  });
}

test('les lots de mutants sont trouvés dans scripts/ (l\'essai qui suit ne vérifie pas un ensemble vide)', () => {
  assert.ok(LOTS.length > 0, 'aucun scripts/mutants-*.mjs');
  assert.ok(LOTS.includes('mutants-rejouer.mjs'), 'le lot du moteur lui-même est de ceux-là');
});

test('chaque lot de mutants désigne encore le code qu\'il mute (chaîne d\'origine unique, code muté qui compile, fichiers de test présents)', { timeout: 600_000 }, async () => {
  const file = [...LOTS];
  const resultats = [];
  const ouvrier = async () => {
    while (file.length) resultats.push(await verifier(file.shift()));
  };
  await Promise.all(Array.from({ length: Math.max(2, Math.min(os.availableParallelism(), 8)) }, ouvrier));
  assert.equal(resultats.length, LOTS.length);
  const perimes = resultats.filter((r) => r.status !== 0 || !/aucun problème/.test(r.sortie));
  assert.deepEqual(
    perimes.map((r) => `${r.lot} : ${r.signal ? `tué par ${r.signal}` : `code ${r.status}`}\n${r.erreur.trim() || r.sortie.trim()}`),
    [],
    'ces lots ne désignent plus le code qu\'ils mutent : chaque motif à corriger est dit avec son fichier',
  );
});
