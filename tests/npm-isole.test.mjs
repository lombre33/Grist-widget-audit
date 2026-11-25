/**
 * Le `npm` isolé de l'audit. Sous Windows, `npm` est `npm.cmd` et `child_process` refuse de le lancer sans shell depuis Node 18.20.2 / 20.12.2 (CVE-2024-27980) : « spawn EINVAL »,
 * levé AVANT que `execFile` ne rende sa promesse. Un `await npm.lancer(...).catch(...)` ne le rattrapait donc pas, et l'audit sortait en erreur à la lecture du registre.
 * L'outil lance maintenant `node npm-cli.js`, sans shell. Les essais « poste Windows » tournent sur n'importe quel système (chemins et fichiers d'essai) ; le dernier lance le vrai npm.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { creerNpmIsole, environnementNpm, trouverNpmCli, REGISTRE_NPM } from '../src/regles/npm-isole.js';
import { interrogerRegistre } from '../src/regles/e-registre.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLI_DE_NODE = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const sur = (...presents) => (chemin) => presents.includes(chemin);
const win = (existe, env = {}) => trouverNpmCli({ plateforme: 'win32', execPath: NODE, env, existe });

test("trouverNpmCli : à côté de node.exe d'abord, puis npm_execpath, puis un npm.cmd du PATH ; rien d'autre n'est cru", () => {
  assert.equal(win(sur(CLI_DE_NODE)), CLI_DE_NODE);
  const autre = 'D:\\outils\\npm\\bin\\npm-cli.js';
  assert.equal(win(sur(CLI_DE_NODE, autre), { npm_execpath: autre }), CLI_DE_NODE, 'celui de node.exe passe avant');
  assert.equal(win(sur(autre), { npm_execpath: autre }), autre);
  // npm_execpath n'est cru que s'il est absolu et nomme npm-cli.js (yarn, pnpm ou un chemin relatif ne sont pas npm).
  assert.equal(win(sur('D:\\outils\\yarn.js'), { npm_execpath: 'D:\\outils\\yarn.js' }), null);
  assert.equal(win(sur('npm\\bin\\npm-cli.js'), { npm_execpath: 'npm\\bin\\npm-cli.js' }), null);
  // Un dossier du PATH qui porte npm.cmd et node_modules\npm ; un dossier relatif du PATH n'est jamais lu (le dépôt audité n'a pas à fournir npm).
  const global = 'C:\\Users\\a\\AppData\\Roaming\\npm';
  const cliGlobal = `${global}\\node_modules\\npm\\bin\\npm-cli.js`;
  assert.equal(win(sur(`${global}\\npm.cmd`, cliGlobal), { PATH: `C:\\Windows;${global}` }), cliGlobal);
  assert.equal(win(sur('.\\npm.cmd', '.\\node_modules\\npm\\bin\\npm-cli.js'), { PATH: '.;' }), null);
  assert.equal(win(sur(`${global}\\npm.cmd`), { PATH: global }), null, 'un npm.cmd sans node_modules\\npm à côté ne désigne aucun npm-cli.js');
  assert.equal(win(sur()), null);
});

test("l'environnement du npm isolé : le strict nécessaire ; sous Windows SystemRoot, le profil et TEMP ramenés au dossier neutre ; aucun secret", () => {
  const env = { PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', HTTPS_PROXY: 'http://proxy:3128', GITHUB_TOKEN: 'secret', NPM_TOKEN: 'secret', USERPROFILE: 'C:\\Users\\vrai' };
  const w = environnementNpm({ dossier: 'D:\\tmp\\n', npmrcVide: 'D:\\tmp\\n\\.npmrc', plateforme: 'win32', env });
  assert.equal(w.SystemRoot, 'C:\\Windows');
  assert.deepEqual([w.USERPROFILE, w.APPDATA, w.LOCALAPPDATA, w.TEMP, w.TMP, w.HOME], Array(6).fill('D:\\tmp\\n'), "rien du profil réel de l'utilisateur");
  assert.equal(w.HTTPS_PROXY, 'http://proxy:3128');
  assert.equal(w.npm_config_registry, REGISTRE_NPM);
  assert.equal(w.GITHUB_TOKEN, undefined);
  assert.equal(w.NPM_TOKEN, undefined);
  const p = environnementNpm({ dossier: '/tmp/n', npmrcVide: '/tmp/n/.npmrc', plateforme: 'linux', env });
  assert.equal(p.SystemRoot, undefined);
  assert.equal(p.HOME, '/tmp/n');
});

test("npm introuvable sous Windows : lancer REND un rejet (jamais une exception), et la lecture du registre dit « injoignable » au lieu de faire échouer l'audit", async () => {
  const sansNpm = () => creerNpmIsole({ plateforme: 'win32', execPath: NODE, env: { PATH: '' }, existe: () => false });
  const npm = sansNpm();
  try {
    let promesse;
    assert.doesNotThrow(() => { promesse = npm.lancer(['--version']); }, "pas d'exception synchrone : un `await npm.lancer().catch()` doit la rattraper");
    await assert.rejects(promesse, (e) => e.code === 'NPM_INTROUVABLE' && /introuvable/.test(e.message));
  } finally {
    npm.nettoyer();
  }
  const lus = await interrogerRegistre(['lodash', 'react'], sansNpm);
  assert.deepEqual([...lus], [['lodash', { erreur: 'injoignable' }], ['react', { erreur: 'injoignable' }]]);
});

test("sous Windows, le programme est node (chemin absolu) suivi de npm-cli.js puis des arguments, sans shell : un argument piégé reste un argument", async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-npm-faux-'));
  try {
    const cli = path.join(dossier, 'npm-cli.js');
    fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    // `plateforme: win32` sur un autre système : le seul chemin que l'essai peut faire exister est npm_execpath (les candidats à la façon de Windows n'existent pas ici).
    const npm = creerNpmIsole({ plateforme: 'win32', execPath: process.execPath, env: { PATH: '', npm_execpath: cli }, existe: (c) => c === cli });
    try {
      const piege = 'paquet & echo pirate > x.txt | calc "%PATH%"';
      const { stdout } = await npm.lancer(['view', piege, '--json']);
      assert.deepEqual(JSON.parse(stdout), ['view', piege, '--json']);
      assert.equal(fs.existsSync(path.join(npm.dossier, 'x.txt')), false);
    } finally {
      npm.nettoyer();
    }
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test("le vrai npm se lance par l'outil (sans réseau : --version) : c'est ce qui échouait par « spawn EINVAL » sous Windows", async () => {
  const npm = creerNpmIsole();
  try {
    const { stdout } = await npm.lancer(['--version']);
    assert.match(String(stdout).trim(), /^\d+\.\d+\.\d+/);
  } finally {
    npm.nettoyer();
  }
});
