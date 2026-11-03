/**
 * Lancer `npm` hors du dépôt audité. `npm` lit le `.npmrc` du dossier courant avant toute option de ligne de commande : un dépôt hostile pourrait
 * sinon y déclarer un `registry` arbitraire et faire partir la requête (avec l'environnement du process qui l'exécute, dont d'éventuels secrets)
 * vers un hôte qu'il contrôle plutôt que vers le registre npm réel (docs/ARCHITECTURE-V2.md, constat 2). Chaque appel de l'audit à `npm`
 * (`npm audit`, `npm view`) passe donc par un dossier neutre, un `HOME` isolé et un environnement réduit, jamais le dépôt.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * `npm` est un script (`npm.cmd`), pas un binaire, sous Windows. `execFile` refuse de le lancer sans passer par un shell depuis Node 18.20.2 /
 * 20.12.2 (CVE-2024-27980) : sans ce contournement, l'appel échoue systématiquement sur ce système d'exploitation. Résoudre le nom exact évite
 * d'avoir à passer `shell: true` (et donc la responsabilité d'échapper des arguments).
 */
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export const REGISTRE_NPM = 'https://registry.npmjs.org/';

/** @returns {{dossier: string, lancer: (args: string[], options?: object) => Promise<{stdout: string}>, nettoyer: () => void}} */
export function creerNpmIsole() {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-npm-'));
  const npmrcVide = path.join(dossier, '.npmrc-audit-gwaudit');
  fs.writeFileSync(npmrcVide, '');
  const env = {
    PATH: process.env.PATH,
    HOME: dossier,                   // pas le HOME réel : pas de ~/.npmrc surprenant à hériter non plus
    npm_config_userconfig: npmrcVide, // écarte tout ~/.npmrc réel malgré HOME
    npm_config_registry: REGISTRE_NPM,
    // `npm` a, lui, réellement besoin d'atteindre le registre — contrairement à l'axe D, dont tout le trafic est neutralisé par construction. On transmet
    // donc le proxy éventuel de l'environnement (pas le reste : ni secrets, ni config surprenante), pour qu'un poste derrière un proxy d'entreprise
    // continue de fonctionner.
    ...Object.fromEntries(
      ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
        .filter((cle) => process.env[cle] !== undefined)
        .map((cle) => [cle, process.env[cle]])
    ),
  };
  return {
    dossier,
    lancer: (args, options = {}) => execFileAsync(NPM_BIN, args, { cwd: dossier, timeout: 120000, maxBuffer: 32 * 1024 * 1024, env, ...options }),
    nettoyer: () => fs.rmSync(dossier, { recursive: true, force: true }),
  };
}
