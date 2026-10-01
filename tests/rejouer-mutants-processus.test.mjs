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
import { balayerCopiesAbandonnees, racinesTemporaires, tuerProcessusDe } from '../scripts/lib/rejouer-mutants.mjs';
import {
  MODULE_MOTEUR, MUTANTS, RACINE_FIXE, attendre, attendreLaMort, creerProjet, dormeur, nettoyer, nettoyerDossier, pidMort, prive, processusDans, rejouer, vivant,
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
    const [copie] = fs.readdirSync(copies).filter((nom) => !nom.endsWith('-tmp'));
    assert.match(copie, new RegExp(`^gwaudit-mutants-${lot.pid}-`), 'la copie porte le numéro du lot');
    assert.ok(fs.statSync(path.join(copies, `${copie}-tmp`)).isDirectory(), 'le dossier temporaire de ses suites est à côté d\'elle, et porte le même numéro');
    const laisses = processusDans(path.join(copies, copie));
    assert.ok(laisses.length >= 3, `le lanceur, le fichier de test qui boucle et l'orphelin tournent dans la copie (vus : ${laisses.length})`);

    lot.kill('SIGTERM');
    const { code, signal } = await fini;
    // Un gestionnaire de SIGTERM laisserait le lot finir sa suite (60 s) puis sortir avec un code : ce qui le distingue est le signal, pas la durée
    // (le budget de « sur-le-champ » est à tests/budgets/, hors de la suite).
    assert.equal(signal, 'SIGTERM', `le lot est mort du signal (un gestionnaire l'aurait laissé finir sa suite ; code ${code})`);
    assert.ok(fs.existsSync(path.join(copies, copie)), 'sa copie est restée');
    assert.ok(laisses.some(vivant), 'ses processus aussi');

    assert.deepEqual(balayerCopiesAbandonnees(copies).sort(), [path.join(copies, copie), path.join(copies, `${copie}-tmp`)], 'le lot suivant la retire, avec le dossier temporaire de ses suites');
    for (const pid of laisses) assert.ok(await attendreLaMort(pid), `le processus ${pid} est mort`);
    assert.deepEqual(fs.readdirSync(copies), []);
  } finally {
    lot.kill('SIGKILL');
    nettoyerDossier(dossier);
  }
});

test('balayerCopiesAbandonnees : plusieurs dossiers à la fois (TMPDIR et /tmp), la copie d\'un lot vivant est laissée dans chacun', async () => {
  const [a, b] = [prive(), prive()];
  const mort = await pidMort();
  const abandonnees = [path.join(a, `gwaudit-mutants-${mort}-aaa`), path.join(b, `gwaudit-mutants-${mort}-bbb`), path.join(b, `gwaudit-mutants-${mort}-bbb-tmp`)];
  const vivante = path.join(b, `gwaudit-mutants-${process.pid}-ccc`);
  for (const d of [...abandonnees, vivante]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'f'), 'x'); }
  try {
    assert.deepEqual(balayerCopiesAbandonnees([a, path.join(a, 'absent'), b]).sort(), [...abandonnees].sort());
    for (const d of abandonnees) assert.ok(!fs.existsSync(d), `${d} est retirée`);
    assert.ok(fs.existsSync(vivante), 'celle du lot vivant, dans le second dossier, reste');
    assert.deepEqual(balayerCopiesAbandonnees([a, b]), [], 'rien de plus la fois suivante');
  } finally {
    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('racinesTemporaires : TMPDIR puis /tmp, chacun une fois (le même dossier, ou un lien vers lui, ne se balaie pas deux fois), un dossier absent est ignoré', () => {
  const [a, b] = [prive(), prive()];
  const lien = path.join(b, 'lien-vers-a');
  fs.symlinkSync(a, lien);
  try {
    assert.deepEqual(racinesTemporaires({ tmpdir: a, fixe: b }), [a, b]);
    assert.deepEqual(racinesTemporaires({ tmpdir: a, fixe: a }), [a]);
    assert.deepEqual(racinesTemporaires({ tmpdir: lien, fixe: a }), [lien], 'un lien vers le même dossier : une seule racine');
    assert.deepEqual(racinesTemporaires({ tmpdir: path.join(a, 'absent'), fixe: b }), [b]);
    assert.deepEqual(racinesTemporaires({ tmpdir: a, fixe: path.join(a, 'absent') }), [a]);
    const ancienne = process.env.GWAUDIT_MUTANTS_RACINE_FIXE;
    try {
      delete process.env.GWAUDIT_MUTANTS_RACINE_FIXE;
      assert.deepEqual(racinesTemporaires({ tmpdir: a }), [a, '/tmp'], '/tmp est la seconde racine par défaut (a est un dossier privé, jamais /tmp lui-même)');
      process.env.GWAUDIT_MUTANTS_RACINE_FIXE = '';
      assert.deepEqual(racinesTemporaires({ tmpdir: a }), [a, '/tmp'], 'une variable vide ne désigne aucune racine : /tmp');
      process.env.GWAUDIT_MUTANTS_RACINE_FIXE = b;
      assert.deepEqual(racinesTemporaires({ tmpdir: a }), [a, b], 'GWAUDIT_MUTANTS_RACINE_FIXE remplace /tmp');
      assert.deepEqual(racinesTemporaires({ tmpdir: a, fixe: path.join(b, 'absent') }), [a], 'un argument explicite l\'emporte sur la variable');
    } finally {
      if (ancienne === undefined) delete process.env.GWAUDIT_MUTANTS_RACINE_FIXE; else process.env.GWAUDIT_MUTANTS_RACINE_FIXE = ancienne;
    }
  } finally {
    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('moteur : le rejeu balaie aussi la seconde racine (/tmp en vrai) quand TMPDIR est ailleurs (la copie d\'un lot mort qui avait un autre TMPDIR), et le dit', async () => {
  const mort = await pidMort();
  const laissee = fs.mkdtempSync(path.join(RACINE_FIXE, `gwaudit-mutants-${mort}-essai-`));
  fs.writeFileSync(path.join(laissee, 'f'), 'x');
  const r = rejouer(['test']);   // son TMPDIR est un dossier privé : la seconde racine n'est balayée que si le moteur le fait de lui-même
  try {
    assert.equal(r.code, 0, r.erreurs.join('\n'));
    assert.ok(!fs.existsSync(laissee), 'la copie laissée dans la seconde racine est retirée');
    assert.match(r.erreurs.join('\n'), new RegExp(`copie\\(s\\) laissée\\(s\\) par un lot interrompu retirée\\(s\\), avec leurs processus : .*${path.basename(laissee)}`));
  } finally {
    nettoyer(r);
  }
});

test('moteur : les essais du moteur ne balaient jamais le vrai /tmp (celui du lot qui les lance et des lots qui tournent à côté)', async (t) => {
  // Une copie de lot mort dans le vrai /tmp : un moteur qui la retire là où les essais ne l'ont pas voulu (variable ignorée) le montre.
  const mort = await pidMort();
  const laissee = fs.mkdtempSync(path.join('/tmp', `gwaudit-mutants-${mort}-essai-jamais-`));
  t.after(() => fs.rmSync(laissee, { recursive: true, force: true }));
  fs.writeFileSync(path.join(laissee, 'f'), 'x');
  const r = rejouer(['test']);
  try {
    assert.equal(r.code, 0, r.erreurs.join('\n'));
    assert.ok(fs.existsSync(laissee), 'la copie du vrai /tmp n\'a pas été touchée');
  } finally {
    nettoyer(r);
  }
});

test('moteur : à la fin, la copie qu\'une suite a laissée derrière elle (un lot lancé par un essai et tué) est retirée, et le dit ; un lot qui ne laisse rien ne dit rien', () => {
  const laissee = () => fs.readdirSync(RACINE_FIXE).filter((n) => n.startsWith('gwaudit-mutants-'));
  assert.deepEqual(laissee(), [], 'rien dans la seconde racine avant l\'essai');
  const r = rejouer(['laisseUneCopie']);
  try {
    assert.equal(r.code, 0, r.erreurs.join('\n'));
    assert.equal(r.bilan.tuesParUnTest, 1);
    assert.deepEqual(laissee(), [], 'la copie laissée par la suite du mutant est retirée à la fin du lot');
    assert.match(r.erreurs.join('\n'), /1 copie\(s\) laissée\(s\) par les essais retirée\(s\), avec leurs processus : .*laissee-par-la-suite/);
  } finally {
    nettoyer(r);
  }
  const propre = rejouer(['test']);
  try {
    assert.equal(propre.code, 0);
    assert.doesNotMatch(propre.erreurs.join('\n'), /laissée/);
  } finally {
    nettoyer(propre);
  }
});

