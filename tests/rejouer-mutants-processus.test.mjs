/**
 * Le moteur de mutants et les processus : ce qu'il tue quand une suite finit par
 * un délai ou un plantage, ce qu'il retire quand un lot est tué, et ce qu'un
 * `kill` fait d'un lot (il l'arrête sur-le-champ : rien de ce qui est
 * synchrone n'attend un gestionnaire de signal). Voir aussi
 * `rejouer-mutants-classement.test.mjs` ; chaque comportement a son mutant :
 * `scripts/mutants-rejouer.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { balayerCopiesAbandonnees, tuerProcessusDe } from '../scripts/lib/rejouer-mutants.mjs';
import {
  MODULE_MOTEUR, MUTANTS, attendre, attendreLaMort, creerProjet, dormeur, nettoyerDossier, pidMort, prive, processusDans, vivant,
} from './aide-moteur-mutants.mjs';

test('tuerProcessusDe : tue ceux dont le répertoire courant est le dossier ou l\'un de ses sous-dossiers, pas ceux d\'un dossier voisin au même début de nom', async () => {
  assert.ok(fs.existsSync('/proc/self'), 'cet essai suppose /proc (Linux) : le repli de tuerProcessusDe sur pkill ne reconnaît pas des chemins relatifs');
  const racine = prive();
  const cible = path.join(racine, 'copie');
  const voisin = path.join(racine, 'copie2');
  fs.mkdirSync(path.join(cible, 'sous', 'dossier'), { recursive: true });
  fs.mkdirSync(voisin);
  const [dedans, profond, dehors] = [dormeur(cible), dormeur(path.join(cible, 'sous', 'dossier')), dormeur(voisin)];
  try {
    await attendre(300);
    assert.ok([dedans, profond, dehors].every((p) => vivant(p.pid)), 'les trois dormeurs tournent');
    const tues = tuerProcessusDe(cible);
    assert.equal(tues, 2, 'le dossier lui-même et son sous-dossier, pas le voisin');
    assert.ok(await attendreLaMort(dedans.pid) && await attendreLaMort(profond.pid), 'ceux du dossier sont morts');
    assert.ok(vivant(dehors.pid), 'celui du dossier voisin (copie2, même début de nom) tourne encore');
  } finally {
    for (const p of [dedans, profond, dehors]) p.kill('SIGKILL');
    fs.rmSync(racine, { recursive: true, force: true });
  }
});

test('tuerProcessusDe : ne se tue pas lui-même, même quand son répertoire courant est le dossier (essayé dans un processus à part)', () => {
  const dossier = prive();
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { tuerProcessusDe } from ${JSON.stringify(MODULE_MOTEUR)}; console.log(tuerProcessusDe(process.cwd()));`], { cwd: dossier, encoding: 'utf8' });
    assert.equal(r.signal, null, 'il ne s\'est pas tué');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '0', 'aucun autre processus n\'a ce dossier pour répertoire courant');
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test('tuerProcessusDe : sans /proc, il se replie sur pkill -f, qui reconnaît la ligne de commande (le chemin est lu tel quel, pas comme une expression régulière)', async () => {
  assert.equal(spawnSync('pkill', ['--version']).status, 0, 'cet essai suppose pkill (procps)');
  const racine = prive();
  const cible = path.join(racine, 'copie (a+b)');           // ce qu'une expression régulière lirait autrement
  const autre = path.join(racine, 'copie ab');              // ce que « copie (a+b) » non échappé reconnaîtrait
  fs.mkdirSync(cible);
  const [nomme, etranger] = [dormeur(undefined, cible), dormeur(undefined, autre)];
  try {
    await attendre(300);
    assert.ok(vivant(nomme.pid) && vivant(etranger.pid));
    assert.equal(tuerProcessusDe(cible, { proc: path.join(racine, 'pas-de-proc') }), 0, 'pkill ne dit pas combien');
    assert.ok(await attendreLaMort(nomme.pid), 'celui dont la ligne de commande contient le dossier est mort');
    assert.ok(vivant(etranger.pid), 'l\'autre non');
  } finally {
    for (const p of [nomme, etranger]) p.kill('SIGKILL');
    fs.rmSync(racine, { recursive: true, force: true });
  }
});

test('balayerCopiesAbandonnees : retire la copie d\'un lot qui n\'existe plus, avec ses processus ; ni celle d\'un lot vivant, ni un autre dossier', async () => {
  const tmp = prive();
  const mort = await pidMort();
  const abandonnee = path.join(tmp, `gwaudit-mutants-${mort}-abc123`);
  const intacts = {
    vivante: path.join(tmp, `gwaudit-mutants-${process.pid}-def456`),                          // le lot tourne : ce processus
    ancienneForme: path.join(tmp, `gwaudit-mutants-${mort}`),                                  // sans le tiret après le numéro : pas une copie de cette forme
    autrePrefixe: path.join(tmp, `autre-${mort}-abc123`),
    prefixeDecale: path.join(tmp, `xgwaudit-mutants-${mort}-abc123`),                          // le préfixe n'est pas au début
  };
  for (const d of [abandonnee, ...Object.values(intacts)]) {
    fs.mkdirSync(path.join(d, 'sous'), { recursive: true });
    fs.writeFileSync(path.join(d, 'sous', 'f'), 'x');
  }
  const orphelin = dormeur(path.join(abandonnee, 'sous'));
  const chezUnAutre = dormeur(intacts.vivante);
  const lien = path.join(prive(), 'lien');                    // le dossier temporaire est donné par un lien symbolique : les processus, eux, sont vus par le chemin réel
  fs.symlinkSync(tmp, lien);
  try {
    await attendre(300);
    assert.deepEqual(balayerCopiesAbandonnees(lien), [abandonnee]);
    assert.ok(!fs.existsSync(abandonnee), 'la copie abandonnée est retirée');
    for (const [nom, d] of Object.entries(intacts)) assert.ok(fs.existsSync(d), `${nom} n'est pas touchée`);
    assert.ok(await attendreLaMort(orphelin.pid), 'le processus qu\'elle a laissé est tué');
    assert.ok(vivant(chezUnAutre.pid), 'celui d\'une copie vivante tourne encore');
    assert.deepEqual(balayerCopiesAbandonnees(tmp), [], 'rien de plus à retirer la fois suivante');
    assert.deepEqual(balayerCopiesAbandonnees(path.join(tmp, 'absent')), [], 'un dossier qui n\'existe pas ne fait rien');
  } finally {
    for (const p of [orphelin, chezUnAutre]) p.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(lien), { recursive: true, force: true });
  }
});

test('un lot tué par SIGTERM s\'arrête sur-le-champ (aucun gestionnaire de signal ne le retient) ; le lot suivant retire sa copie et ses processus', async () => {
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
    for (let i = 0; i < 400 && !fs.existsSync(fichierPid); i++) await attendre(50);
    assert.ok(fs.existsSync(fichierPid), 'le mutant tourne : son orphelin a dit son numéro');
    const [copie] = fs.readdirSync(copies);
    assert.match(copie, new RegExp(`^gwaudit-mutants-${lot.pid}-`), 'la copie porte le numéro du lot');
    const laisses = processusDans(path.join(copies, copie));
    assert.ok(laisses.length >= 3, `le lanceur, le fichier de test qui boucle et l'orphelin tournent dans la copie (vus : ${laisses.length})`);

    const debut = Date.now();
    lot.kill('SIGTERM');
    const { signal } = await fini;
    assert.equal(signal, 'SIGTERM', 'le lot est mort du signal (un gestionnaire l\'aurait laissé finir sa suite)');
    assert.ok(Date.now() - debut < 5000, 'sur-le-champ, sans attendre la fin de la suite (60 s)');
    assert.ok(fs.existsSync(path.join(copies, copie)), 'sa copie est restée');
    assert.ok(laisses.some(vivant), 'ses processus aussi');

    assert.deepEqual(balayerCopiesAbandonnees(copies), [path.join(copies, copie)], 'le lot suivant la retire');
    for (const pid of laisses) assert.ok(await attendreLaMort(pid), `le processus ${pid} est mort`);
    assert.deepEqual(fs.readdirSync(copies), []);
  } finally {
    lot.kill('SIGKILL');
    nettoyerDossier(dossier);
  }
});
