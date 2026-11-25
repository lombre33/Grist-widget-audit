/**
 * Une instance de Grist Desktop jetable, seule, sur la boucle locale.
 *
 * Verrous (tous vérifiés avant le moindre essai) :
 *  1. profil jetable : les quatre variables de stockage de Grist ET le profil d'Electron sont sous
 *     un même dossier temporaire créé ici ; `verifierIsolation` refuse tout autre emplacement ;
 *  2. port libre : choisi libre juste avant, et l'instance n'écoute que sur `localhost` ;
 *  3. instance neuve : à son démarrage elle ne contient aucun document (on ne se trompe donc
 *     jamais d'instance : si un autre Grist avait répondu sur ce port, il aurait des documents) ;
 *  4. rien n'est lu dans les dossiers de l'utilisateur : ni Documents, ni profil Electron habituel ;
 *  5. arrêt de tout l'arbre de processus et suppression du profil dans `arreter()`, appelé par un `finally`.
 *
 * `GRIST_DESKTOP_AUTH=none` n'ouvre l'instance qu'à ce profil vide pendant la durée de l'audit.
 * `GRIST_DESKTOP_TEST_MODE=1` fait accepter à Desktop les options de Chromium (`--user-data-dir`,
 * `--no-sandbox`) et évite le verrou d'instance unique d'Electron : un Grist Desktop déjà ouvert sur
 * ta machine n'est ni gêné ni touché.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

export class InstanceImpossible extends Error {}

const sous = (parent, enfant) => {
  const rel = path.relative(path.resolve(parent), path.resolve(enfant));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Refuse un environnement dont l'une des variables de stockage sort du profil jetable. Exporté pour les tests. */
export function verifierIsolation(env, profil) {
  for (const cle of ['GRIST_DATA_DIR', 'GRIST_INST_DIR', 'TYPEORM_DATABASE', 'GRIST_USER_ROOT']) {
    if (!env[cle] || !sous(profil, env[cle])) {
      throw new InstanceImpossible(`Isolation refusée : ${cle}=${env[cle] ?? '(absente)'} n'est pas sous le profil jetable ${profil}.`);
    }
  }
  if (env.GRIST_HOST !== 'localhost') throw new InstanceImpossible(`Isolation refusée : GRIST_HOST doit valoir « localhost » (${env.GRIST_HOST}).`);
}

export function portLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Construit l'environnement de l'instance ; fonction pure, testée sans lancer Desktop. */
export function construireEnvironnement(profil, port, base = process.env) {
  const env = { ...base };
  for (const cle of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[cle];
  // Réglage par défaut de Grist pour les webhooks (aucune adresse autorisée) : les essais ne dépendent pas de la configuration de la machine qui les joue.
  for (const cle of ['ALLOWED_WEBHOOK_DOMAINS', 'GRIST_PROXY_FOR_UNTRUSTED_URLS']) delete env[cle];
  Object.assign(env, {
    GRIST_DESKTOP_TEST_MODE: '1',
    GRIST_DESKTOP_AUTH: 'none',
    GRIST_DESKTOP_USE_UPDATE: 'false',
    GRIST_PORT: String(port),
    GRIST_HOST: 'localhost',
    GRIST_DATA_DIR: path.join(profil, 'data'),
    GRIST_INST_DIR: path.join(profil, 'inst'),
    TYPEORM_DATABASE: path.join(profil, 'inst', 'home.db'),
    GRIST_USER_ROOT: path.join(profil, 'racine'),
    // Les fichiers temporaires d'Electron, de Chromium et de xvfb-run vont dans le profil : ils disparaissent avec lui.
    TMPDIR: path.join(profil, 'tmp'), TEMP: path.join(profil, 'tmp'), TMP: path.join(profil, 'tmp'),
  });
  return env;
}

function arreterArbre(enfant) {
  if (!enfant?.pid || enfant.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(enfant.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-enfant.pid, 'SIGKILL');
  } catch { /* déjà arrêté */ }
}

async function attendre(url, delaiMs, enfant) {
  const fin = Date.now() + delaiMs;
  let derniere = '';
  while (Date.now() < fin) {
    if (enfant.exitCode !== null) throw new InstanceImpossible(`Grist Desktop s'est arrêté au démarrage (code ${enfant.exitCode}). ${derniere}`.trim());
    try {
      // `/status` répond avant que l'instance ait fini de démarrer : on attend aussi que la page d'accueil ne réponde plus « 503, démarrage en cours ».
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const accueil = r.ok ? await fetch(new URL('/', url), { redirect: 'manual', signal: AbortSignal.timeout(2000) }) : r;
      if (r.ok && accueil.status < 500) return;
      derniere = `réponse ${accueil.status}`;
    } catch (e) { derniere = String(e?.cause?.code ?? e?.message ?? e); }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new InstanceImpossible(`Grist Desktop n'a pas répondu en ${Math.round(delaiMs / 1000)} s (${derniere}).`);
}

/**
 * Lance l'instance et rend `{ base, port, profil, arreter }`.
 * @param {string} executable  Grist Desktop (voir installateur.js)
 * @param {{delaiMs?: number, journal?: Function}} [options]
 */
export async function lancerInstance(executable, options = {}) {
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-grist-'));
  let enfant;
  const arreter = async () => {
    arreterArbre(enfant);
    if (enfant && enfant.exitCode === null) await new Promise((r) => { enfant.once('exit', r); setTimeout(r, 4000); });
    // Windows garde un instant les fichiers ouverts après l'arrêt : quelques essais.
    for (let i = 0; i < 6; i++) {
      try { fs.rmSync(profil, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
  };
  try {
    const port = await portLibre();
    const env = construireEnvironnement(profil, port);
    verifierIsolation(env, profil);
    for (const d of [env.GRIST_DATA_DIR, env.GRIST_INST_DIR, env.GRIST_USER_ROOT, path.join(profil, 'electron'), path.join(profil, 'maison'), env.TMPDIR]) fs.mkdirSync(d, { recursive: true });
    // Les profils habituels de la personne ne sont jamais utilisés : on déplace aussi le dossier personnel (Linux, macOS).
    // Sous Windows, Electron s'appuie sur --user-data-dir.
    if (process.platform !== 'win32') env.HOME = path.join(profil, 'maison');

    let commande = executable;
    let args = ['--no-sandbox', `--user-data-dir=${path.join(profil, 'electron')}`];
    if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
      const xvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).stdout.trim();
      if (!xvfb) throw new InstanceImpossible("Grist Desktop (Electron) a besoin d'un écran et aucun n'est disponible : installer xvfb (`apt install xvfb`) ou lancer depuis une session graphique.");
      args = ['-a', executable, ...args];
      commande = xvfb;
    }
    options.journal?.(`  Lancement de Grist Desktop (profil jetable ${profil}, port ${port})…`);
    enfant = spawn(commande, args, { env, stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
    enfant.on('error', () => {});
    const base = `http://localhost:${port}`;
    await attendre(`${base}/status`, options.delaiMs ?? 90_000, enfant);
    return { base, port, profil, arreter };
  } catch (e) {
    await arreter();
    throw e;
  }
}
