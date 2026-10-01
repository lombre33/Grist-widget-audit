/**
 * Chaque lot de mutants (`scripts/mutants-*.mjs`) désigne encore le code qu'il muté : la chaîne d'origine de
 * chacun de ses mutants s'y trouve une fois, le code muté compile, les fichiers de test existent. Un lot dont
 * un motif est périmé (le code a changé de place ou de forme) ne tue plus rien, et rien ne le dit tant que
 * personne ne le rejoue ; il devient muet sans faire échouer aucun test. Cet essai lance la vérification
 * d'avance du moteur (`--valider`) sur tous les lots : la suite passe au rouge dès qu'un lot devient muet, et
 * le message dit chaque motif périmé avec son fichier (voir `tests/rejouer-mutants-valider.test.mjs` pour le
 * moteur lui-même).
 *
 * Chaque lot est lancé avec un `--part=1/2` : le moteur refuse (code 2) un lot qui ne transmet pas `partie` à `rejouerMutants`, parce que chacun de
 * ses paquets rejouerait alors le lot entier et que les comptes des paquets s'additionneraient faux. Un lot qui l'oublie fait donc rougir cet essai.
 *
 * Les lots sont trouvés dans `scripts/` : un lot de plus est vérifié sans toucher à cet essai. Aucun
 * Chromium n'est nécessaire (la vérification ne lance aucune suite) : la variable qui le désigne est retirée
 * de l'environnement des lots, ce qui éprouve aussi qu'un lot qui l'exige la vérifie sans lui.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = new URL('../scripts/', import.meta.url);
const LOTS = fs.readdirSync(SCRIPTS).filter((nom) => /^mutants-.+\.mjs$/.test(nom)).sort();

/** Un lot lancé avec `--valider --part=1/2`, dans son processus : ce qu'il rend. `chemin` : un fichier de lot ailleurs que dans scripts/. */
function verifier(lot, chemin = fileURLToPath(new URL(lot, SCRIPTS))) {
  const env = { ...process.env };
  delete env.GWAUDIT_CHROMIUM_PATH;
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const enfant = spawn(process.execPath, [chemin, '--valider', '--part=1/2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('un lot qui ne transmet pas `partie` au moteur est refusé (code 2, avec la consigne) : c\'est ce que l\'essai ci-dessus attrape chez chaque lot', async (t) => {
  const source = fs.readFileSync(new URL('mutants-lignes.mjs', SCRIPTS), 'utf8');
  assert.equal(source.split('\n  partie,\n').length, 2, 'mutants-lignes.mjs transmet `partie` sur sa propre ligne : l\'essai la retire pour fabriquer le lot fautif');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-lot-sans-partie-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const lot = path.join(dossier, 'mutants-sans-partie.mjs');
  fs.writeFileSync(lot, source.replace('\n  partie,\n', '\n').replaceAll("'./lib/", `'${new URL('lib/', SCRIPTS).href}`));
  const r = await verifier('mutants-sans-partie.mjs', lot);
  assert.equal(r.status, 2, r.erreur || r.sortie);
  assert.match(r.erreur, /demande --part=1\/2, mais le lot ne l'a pas transmise au moteur/);
  assert.match(r.erreur, /const \{ partie \} = lireArguments/, 'et dit ce que le lot doit faire');
  const bon = await verifier('mutants-lignes.mjs');
  assert.equal(bon.status, 0, bon.erreur);
});
