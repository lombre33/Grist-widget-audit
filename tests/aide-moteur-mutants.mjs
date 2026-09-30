/**
 * Ce que les essais du moteur de mutants partagent (`rejouer-mutants-*.test.mjs`) :
 * un petit projet dans un dossier privé, des mutants qui sont tués par un test,
 * par un délai, par un plantage ou qui survivent, des processus qui dorment, et
 * de quoi voir ce que le moteur laisse derrière lui.
 *
 * Tout ce qui pourrait ne pas finir finit de lui-même (un dormeur au bout de
 * 30 s, une « boucle » de 20 s : plus longue que le délai des essais, sans
 * jamais laisser un processus tourner pour toujours si un essai échoue).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { rejouerMutants } from '../scripts/lib/rejouer-mutants.mjs';

export const MODULE_MOTEUR = new URL('../scripts/lib/rejouer-mutants.mjs', import.meta.url).href;

// Les sorties de `node --test` --------------------------------------------------------------------------------------

/** Ce que `node --test` imprime : des lignes ok / not ok (indentées pour un sous-test), puis le résumé (absent si `sansResume`). */
export const tap = ({ ok = [], pasOk = [], sautes = 0, sansResume = false, sousTests = [] }) => {
  const lignes = ['TAP version 13', ...ok.map((n, i) => `ok ${i + 1} - ${n}`), ...sousTests.map((n, i) => `    not ok ${i + 1} - ${n}`), ...pasOk.map((n, i) => `not ok ${ok.length + i + 1} - ${n}`)];
  if (!sansResume) {
    const lances = ok.length + sousTests.length + pasOk.length;
    lignes.push(`# tests ${lances}`, '# suites 0', `# pass ${ok.length}`, `# fail ${sousTests.length + pasOk.length}`, '# cancelled 0', `# skipped ${sautes}`, '# todo 0', '# duration_ms 12.5');
  }
  return `${lignes.join('\n')}\n`;
};

// Les processus ----------------------------------------------------------------------------------------------------

/** Un processus qui dort dans `cwd` et ignore SIGTERM (comme `node --test` : seul SIGKILL l'arrête) ; il s'arrête de lui-même au bout d'une demi-minute. `arg` : un argument de plus, pour la ligne de commande. */
export const dormeur = (cwd, arg = '') => spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)", arg], { cwd, stdio: 'ignore' });
/** Vivant au sens de ce qui compte ici : présent dans /proc et pas un zombie en attente d'être ramassé. */
export const vivant = (pid) => {
  try { return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
};
export const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
export const attendreLaMort = async (pid) => {
  for (let i = 0; i < 200 && vivant(pid); i++) await attendre(25);
  return !vivant(pid);
};
/** Les processus (autres que celui-ci) dont le répertoire courant est `dossier` ou l'un de ses sous-dossiers. */
export function processusDans(dossier) {
  const pids = [];
  for (const nom of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(nom) || Number(nom) === process.pid) continue;
    let cwd;
    try { cwd = fs.readlinkSync(`/proc/${nom}/cwd`); } catch { continue; }
    if ((cwd === dossier || cwd.startsWith(dossier + path.sep)) && vivant(Number(nom))) pids.push(Number(nom));
  }
  return pids;
}
export const prive = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-essai-moteur-')));
/** Un numéro de processus qui n'existe plus : celui d'un processus qui a fini et que son parent a ramassé. */
export async function pidMort() {
  const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => p.once('exit', r));
  return p.pid;
}

// Le petit projet et ses mutants -----------------------------------------------------------------------------------

export const F_JS = 'export const f = () => 1;\n';
const F_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f } from '../src/f.js';\ntest('f vaut 1', () => assert.equal(f(), 1));\n";
/** Une boucle de 20 s, plus longue que le délai des essais (5 s) : le délai la tue ; si un essai échoue elle finit d'elle-même. */
export const BOUCLE = 'export const f = () => { const fin = Date.now() + 20000; while (Date.now() < fin) {} return 1; };\n';
/** La même, qui laisse aussi un orphelin : un processus détaché, dont le répertoire courant est la copie, et dit son numéro. */
export const BOUCLE_ET_ORPHELIN = [
  "import { spawn } from 'node:child_process';",
  "import fs from 'node:fs';",
  "const orphelin = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });",
  'orphelin.unref();',
  'fs.writeFileSync(process.env.ESSAI_MOTEUR_PID, String(orphelin.pid));',
  BOUCLE,
].join('\n');

/** Un plantage qui laisse un orphelin : le processus détaché dit son numéro puis le fichier quitte avec le code 3. */
export const PLANTAGE_ET_ORPHELIN = [
  "import { spawn } from 'node:child_process';",
  "import fs from 'node:fs';",
  "const orphelin = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });",
  'orphelin.unref();',
  'fs.writeFileSync(process.env.ESSAI_MOTEUR_PID, String(orphelin.pid));',
  'process.exit(3);',
  F_JS,
].join('\n');

export const MUTANTS = {
  test: { libelle: 'renvoie 2', fichier: 'src/f.js', ancien: F_JS, nouveau: 'export const f = () => 2;\n' },
  delai: { libelle: 'boucle de 20 s', fichier: 'src/f.js', ancien: F_JS, nouveau: BOUCLE },
  orphelin: { libelle: 'boucle de 20 s et laisse un orphelin', fichier: 'src/f.js', ancien: F_JS, nouveau: BOUCLE_ET_ORPHELIN },
  plantage: { libelle: 'quitte au chargement', fichier: 'src/f.js', ancien: F_JS, nouveau: `process.exit(3);\n${F_JS}` },
  plantageEtOrphelin: { libelle: 'quitte au chargement et laisse un orphelin', fichier: 'src/f.js', ancien: F_JS, nouveau: PLANTAGE_ET_ORPHELIN },
  survivant: { libelle: 'équivalent', fichier: 'src/f.js', ancien: F_JS, nouveau: 'export const f = () => 1 + 0;\n' },
};

/** Trois tests qui échouent quand `f()` n'est plus 1, le premier au nom de 71 caractères (le moteur coupe au-delà de 70). */
export const NOM_LONG = 'un nom de test long : '.padEnd(71, 'x');
const TEST_ECHECS = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { f } from '../src/f.js';",
  `test(${JSON.stringify(NOM_LONG)}, () => assert.equal(f(), 1));`,
  "test('deuxième', () => assert.equal(f(), 1));",
  "test('troisième', () => assert.equal(f(), 1));",
].join('\n');
const TEST_PLANTE_SI_MUTE = (code) => `import { f } from '../src/f.js';\nif (f() !== 1) process.exit(${code});\n`;
/** Ce que la copie doit être, vue de l'intérieur : un test qui n'a de sens que dans la copie du moteur (les variables `ESSAI_MOTEUR_*` viennent de `rejouer`). */
const TEST_COPIE = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "test('la copie a la forme attendue', () => {",
  '  const cwd = process.cwd();',
  "  assert.equal(cwd, fs.realpathSync(cwd), 'le chemin réel');",
  "  assert.equal(path.dirname(cwd), process.env.ESSAI_MOTEUR_TMP, 'dans le dossier temporaire');",
  '  assert.match(path.basename(cwd), new RegExp(`^gwaudit-mutants-${process.env.ESSAI_MOTEUR_LOT}-`), \'le numéro du lot est dans le nom\');',
  "  assert.equal(fs.statSync(cwd).mode & 0o777, 0o755, 'lisible par un autre utilisateur');",
  "  assert.equal(fs.readFileSync('package.json', 'utf8'), '{ \"type\": \"module\" }\\n');",
  "  assert.ok(fs.lstatSync('node_modules').isSymbolicLink(), 'node_modules est lié, pas copié');",
  "  assert.equal(fs.readFileSync('node_modules/marqueur.txt', 'utf8'), 'ici\\n');",
  "  assert.deepEqual(fs.readdirSync('.').sort(), ['node_modules', 'package.json', 'src', 'tests'], 'seulement ce que `dossiers` demande');",
  '});',
].join('\n');
/** Le même, pour les dossiers par défaut : `fixtures` et `scripts` sont copiés aussi. */
const TEST_COPIE_PAR_DEFAUT = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import fs from 'node:fs';",
  "test('les dossiers par défaut sont copiés', () => {",
  "  assert.deepEqual(fs.readdirSync('.').sort(), ['fixtures', 'node_modules', 'package.json', 'scripts', 'src', 'tests']);",
  '});',
].join('\n');

/** Les fichiers du petit projet ; `fichiers` en ajoute ou en remplace (nom relatif → contenu). Rend la racine du projet. */
export function creerProjet(dossier, fichiers = {}) {
  const projet = path.join(dossier, 'projet');
  const ecrire = (relatif, contenu) => {
    fs.mkdirSync(path.dirname(path.join(projet, relatif)), { recursive: true });
    fs.writeFileSync(path.join(projet, relatif), contenu);
  };
  const base = {
    'package.json': '{ "type": "module" }\n',
    'src/f.js': F_JS,
    'node_modules/marqueur.txt': 'ici\n',
    'fixtures/x.txt': 'x\n',
    'scripts/y.txt': 'y\n',
    'tests/f.test.mjs': F_TEST,
    'tests/vert.test.mjs': "import test from 'node:test';\ntest('vert', () => {});\n",
    'tests/rouge.test.mjs': "import test from 'node:test';\ntest('déjà rouge', () => { throw new Error('rouge'); });\n",
    'tests/plante.test.mjs': 'process.exit(3);\n',
    'tests/saute.test.mjs': "import test from 'node:test';\ntest.skip('sauté', () => {});\ntest('vert', () => {});\n",
    'tests/sans-test.test.mjs': "import { describe } from 'node:test';\ndescribe('vide', () => {});\n",
    'tests/echecs.test.mjs': TEST_ECHECS,
    'tests/plante-si-mute-1.test.mjs': TEST_PLANTE_SI_MUTE(3),
    'tests/plante-si-mute-2.test.mjs': TEST_PLANTE_SI_MUTE(4),
    'tests/copie.test.mjs': TEST_COPIE,
    'tests/copie-par-defaut.test.mjs': TEST_COPIE_PAR_DEFAUT,
    ...fichiers,
  };
  for (const [relatif, contenu] of Object.entries(base)) ecrire(relatif, contenu);
  return projet;
}

/**
 * Le moteur sur le petit projet, avec un dossier temporaire privé pour sa copie, et ce qu'il en dit.
 *  - `noms` : des clés de `MUTANTS`, ou des mutants entiers ;
 *  - `options` : ce que `rejouerMutants` reçoit en plus (ou à la place) ;
 *  - `extra.fichiers` : fichiers de plus dans le projet ; `extra.lienTmp` : TMPDIR est un lien symbolique vers le dossier des copies ;
 *    `extra.avant` : appelé avec `{ copies, projet, dossier }` juste avant le lancement (pour y poser ce que le moteur doit trouver).
 */
export function rejouer(noms, options = {}, { fichiers = {}, lienTmp = false, avant = null } = {}) {
  const dossier = prive();
  const copies = path.join(dossier, 'tmp');
  fs.mkdirSync(copies);
  const projet = creerProjet(dossier, fichiers);
  const anciennes = { TMPDIR: process.env.TMPDIR, PID: process.env.ESSAI_MOTEUR_PID, TMP: process.env.ESSAI_MOTEUR_TMP, LOT: process.env.ESSAI_MOTEUR_LOT };
  if (lienTmp) fs.symlinkSync(copies, path.join(dossier, 'lien'));
  process.env.TMPDIR = lienTmp ? path.join(dossier, 'lien') : copies;   // la copie du moteur vit ici : on voit qu'elle est retirée
  process.env.ESSAI_MOTEUR_TMP = copies;
  process.env.ESSAI_MOTEUR_LOT = String(process.pid);          // le moteur tourne dans ce processus : son numéro est dans le nom de sa copie
  process.env.ESSAI_MOTEUR_PID = path.join(dossier, 'orphelin.pid');
  const lignes = [];
  const erreurs = [];
  let bilan = null;
  try {
    avant?.({ copies, projet, dossier });
    const code = rejouerMutants({
      mutants: noms.map((n) => (typeof n === 'string' ? MUTANTS[n] : n)), groupes: [{ nom: 'essai', fichiers: ['tests/f.test.mjs'] }], exigerChromium: false,
      dossiers: ['src', 'tests'], racine: projet, delaiMs: 5000, sortie: (l) => lignes.push(l), erreur: (l) => erreurs.push(l),
      rapporter: (b) => { bilan = b; }, ...options,
    });
    return { code, lignes, erreurs, bilan, copiesRestantes: fs.readdirSync(copies), fichierPid: process.env.ESSAI_MOTEUR_PID, dossier, projet, copies };
  } finally {
    for (const [cle, valeur] of [['TMPDIR', anciennes.TMPDIR], ['ESSAI_MOTEUR_PID', anciennes.PID], ['ESSAI_MOTEUR_TMP', anciennes.TMP], ['ESSAI_MOTEUR_LOT', anciennes.LOT]]) {
      if (valeur === undefined) delete process.env[cle]; else process.env[cle] = valeur;
    }
  }
}
/** Ce qui reste après un essai : les processus dont le répertoire courant est dans `dossier` sont tués (sans l'aide du moteur, qu'on éprouve), puis le dossier est retiré. */
export function nettoyerDossier(dossier) {
  for (const pid of processusDans(dossier)) { try { process.kill(pid, 'SIGKILL'); } catch { /* déjà mort */ } }
  fs.rmSync(dossier, { recursive: true, force: true });
}
export const nettoyer = (r) => nettoyerDossier(r.dossier);
