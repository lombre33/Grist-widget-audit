/**
 * Lancer `npm` hors du dépôt audité. `npm` lit le `.npmrc` du dossier courant avant toute option de ligne de commande : un dépôt hostile pourrait
 * sinon y déclarer un `registry` arbitraire et faire partir la requête (avec l'environnement du process qui l'exécute, dont d'éventuels secrets)
 * vers un hôte qu'il contrôle plutôt que vers le registre npm réel. Chaque appel de l'audit à `npm`
 * (`npm audit`, `npm view`, `npm pack`) passe donc par un dossier neutre, un `HOME` isolé et un environnement réduit, jamais le dépôt.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const REGISTRE_NPM = 'https://registry.npmjs.org/';

/**
 * Où est `npm-cli.js`, le programme JavaScript que `npm` et `npm.cmd` ne font que lancer.
 *
 * Sous Windows, `npm` est un script (`npm.cmd`), pas un binaire, et `child_process` refuse de le lancer sans shell depuis Node 18.20.2, 20.12.2 et 21.7.3 (CVE-2024-27980) :
 * l'appel échoue par « spawn EINVAL ». Passer `shell: true` ouvrirait la porte à l'injection par les arguments (un nom de paquet vient du dépôt audité). L'outil lance donc
 * `node npm-cli.js …`, sans shell : le programme est `process.execPath`, un chemin absolu, et les arguments restent des arguments.
 * Les endroits cherchés, dans l'ordre : à côté de `node.exe` (l'installeur de Node, nvm-windows, fnm), la variable `npm_execpath` que npm pose quand il lance l'outil,
 * puis le dossier de chaque `npm.cmd` du PATH (un npm installé par `npm install -g npm`). Un chemin du PATH qui n'est pas absolu n'est jamais lu.
 * @returns {string|null} le chemin de `npm-cli.js`, ou `null` si aucun des endroits ne le donne
 */
export function trouverNpmCli({ plateforme = process.platform, execPath = process.execPath, env = process.env, existe = fs.existsSync } = {}) {
  const p = plateforme === 'win32' ? path.win32 : path.posix;
  const dansNode = (dossier) => p.join(dossier, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const candidats = [dansNode(p.dirname(execPath))];
  const venantDeNpm = env.npm_execpath;
  if (typeof venantDeNpm === 'string' && p.isAbsolute(venantDeNpm) && p.basename(venantDeNpm).toLowerCase() === 'npm-cli.js') candidats.push(venantDeNpm);
  for (const dossier of String(env.PATH ?? env.Path ?? '').split(plateforme === 'win32' ? ';' : ':')) {
    if (dossier && p.isAbsolute(dossier) && existe(p.join(dossier, 'npm.cmd'))) candidats.push(dansNode(dossier));
  }
  return candidats.find((c) => existe(c)) ?? null;
}

/**
 * L'environnement du `npm` isolé : le strict nécessaire, jamais le reste de celui de l'outil (ni secrets, ni configuration surprenante).
 * Sous Windows, `SystemRoot` est indispensable (sans lui, la résolution de noms et les fonctions de hachage de Node échouent), et le profil, `AppData` et `TEMP` sont
 * ramenés au dossier neutre, comme `HOME` : `npm` n'y lit ni n'y écrit rien de l'utilisateur.
 */
export function environnementNpm({ dossier, npmrcVide, plateforme = process.platform, env = process.env }) {
  const proxies = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'].filter((cle) => env[cle] !== undefined);
  return {
    PATH: env.PATH ?? env.Path,
    HOME: dossier,                   // pas le HOME réel : pas de ~/.npmrc surprenant à hériter non plus
    ...(plateforme === 'win32' ? {
      SystemRoot: env.SystemRoot ?? env.SYSTEMROOT, windir: env.windir ?? env.SystemRoot ?? env.SYSTEMROOT,
      USERPROFILE: dossier, APPDATA: dossier, LOCALAPPDATA: dossier, TEMP: dossier, TMP: dossier,
    } : {}),
    npm_config_userconfig: npmrcVide, // écarte tout ~/.npmrc réel malgré HOME
    npm_config_registry: REGISTRE_NPM,
    // `npm` a, lui, réellement besoin d'atteindre le registre — contrairement à l'axe D, dont tout le trafic est neutralisé par construction. On transmet
    // donc le proxy éventuel de l'environnement (pas le reste), pour qu'un poste derrière un proxy d'entreprise continue de fonctionner.
    ...Object.fromEntries(proxies.map((cle) => [cle, env[cle]])),
  };
}

/**
 * @param {{plateforme?: string, execPath?: string, env?: object, existe?: (chemin: string) => boolean}} [reglage] les essais en fournissent un autre poste
 * @returns {{dossier: string, lancer: (args: string[], options?: object) => Promise<{stdout: string}>, nettoyer: () => void}}
 *   `lancer` rend toujours une promesse, jamais une exception : `npm` introuvable est une erreur de code `NPM_INTROUVABLE`.
 */
export function creerNpmIsole({ plateforme = process.platform, execPath = process.execPath, env: envDuProcess = process.env, existe = fs.existsSync } = {}) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-npm-'));
  const npmrcVide = path.join(dossier, '.npmrc-audit-gwaudit');
  fs.writeFileSync(npmrcVide, '');
  const env = environnementNpm({ dossier, npmrcVide, plateforme, env: envDuProcess });
  return {
    dossier,
    // `async` : `execFile` peut lever AVANT de rendre sa promesse (EINVAL sous Windows) ; l'appelant reçoit alors un rejet qu'il sait rattraper, non une exception qui sort de `await npm.lancer(...).catch(...)`.
    lancer: async (args, options = {}) => {
      let programme = 'npm';
      let tete = [];
      if (plateforme === 'win32') {
        const cli = trouverNpmCli({ plateforme, execPath, env: envDuProcess, existe });
        if (!cli) throw Object.assign(new Error("npm est introuvable : ni à côté de node.exe, ni par la variable npm_execpath, ni dans le PATH (un dossier qui porte npm.cmd et node_modules\\npm)."), { code: 'NPM_INTROUVABLE' });
        programme = execPath;
        tete = [cli];
      }
      return execFileAsync(programme, [...tete, ...args], { cwd: dossier, timeout: 120000, maxBuffer: 32 * 1024 * 1024, env, windowsHide: true, ...options });
    },
    nettoyer: () => fs.rmSync(dossier, { recursive: true, force: true }),
  };
}
