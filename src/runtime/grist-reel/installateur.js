/**
 * Installation automatique de Grist Desktop pour l'axe D « Grist réel ».
 *
 * Rien à préparer à la main : la première fois, gwaudit télécharge la version
 * épinglée de Grist Desktop (`grist-desktop.json`, empreinte SHA-256 comprise),
 * vérifie l'empreinte, l'extrait dans un dossier de cache et ne touche JAMAIS
 * à une installation existante. Les fois suivantes, le cache sert tel quel.
 *
 * - Windows : l'archive .zip publiée (version « portable », aucun installeur, aucun droit
 *   d'administrateur), extraite avec le `tar.exe` livré avec Windows 10 et suivants.
 * - Linux : l'AppImage, extraite par elle-même (`--appimage-extract`, sans FUSE).
 * - macOS : pas de version épinglée ; `GWAUDIT_GRIST_DESKTOP` indique alors un Grist
 *   Desktop déjà installé (même variable pour forcer un autre exécutable ailleurs).
 *
 * Si le téléchargement échoue (proxy d'entreprise, hors-ligne), l'erreur dit l'adresse, le
 * dossier exact où déposer le fichier à la main et l'empreinte attendue : le fichier
 * déposé est vérifié exactement comme un fichier téléchargé.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
export const EPINGLE = JSON.parse(fs.readFileSync(path.join(ICI, 'grist-desktop.json'), 'utf8'));

export class InstallationImpossible extends Error {}

/** Dossier de cache : `GWAUDIT_CACHE`, sinon l'emplacement habituel de la plateforme (jamais dans le dépôt). */
export function dossierCache(env = process.env, plateforme = process.platform) {
  if (env.GWAUDIT_CACHE) return path.resolve(env.GWAUDIT_CACHE);
  if (plateforme === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'gwaudit', 'cache');
  if (plateforme === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'gwaudit');
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'gwaudit');
}

/** L'archive épinglée pour cette plateforme, ou une erreur qui dit quoi faire à la place. */
export function choisirAsset(plateforme = process.platform, arch = process.arch) {
  const cle = `${plateforme}-${arch}`;
  const asset = EPINGLE.assets[cle];
  if (!asset) {
    throw new InstallationImpossible(`Aucun Grist Desktop épinglé pour ${cle} (disponibles : ${Object.keys(EPINGLE.assets).join(', ')}). Indiquer un Grist Desktop déjà installé avec GWAUDIT_GRIST_DESKTOP=<chemin de l'exécutable>.`);
  }
  return { cle, ...asset };
}

export async function empreinteDe(fichier) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(fichier), h);
  return h.digest('hex');
}

/** Au bout de ce temps sans recevoir un seul octet, le téléchargement est abandonné (ligne coupée, proxy muet) au lieu d'attendre sans fin. */
const INACTIVITE_MAX_MS = 60_000;

/** Télécharge `url` vers `destination` et rend l'empreinte SHA-256 de ce qui a été reçu. Exporté pour les tests. */
export async function telecharger(url, destination, asset, journal, inactiviteMs = INACTIVITE_MAX_MS) {
  const arret = new AbortController();
  let minuteur;
  const armer = () => { clearTimeout(minuteur); minuteur = setTimeout(() => arret.abort(new Error(`aucune donnée reçue depuis ${Math.round(inactiviteMs / 1000)} s`)), inactiviteMs); };
  armer();
  try {
    const reponse = await fetch(url, { redirect: 'follow', signal: arret.signal });
    if (!reponse.ok || !reponse.body) throw new Error(`réponse ${reponse.status} de ${new URL(url).host}`);
    const h = crypto.createHash('sha256');
    const total = Number(reponse.headers.get('content-length')) || asset.taille;
    let recu = 0; let palier = 0;
    await pipeline(
      Readable.fromWeb(reponse.body),
      async function* (source) {
        for await (const morceau of source) {
          armer();
          h.update(morceau); recu += morceau.length;
          const pct = Math.floor((recu / total) * 10);
          if (pct > palier) { palier = pct; journal(`  ${pct * 10} % (${Math.round(recu / 1048576)} Mo)`); }
          yield morceau;
        }
      },
      fs.createWriteStream(destination),
      { signal: arret.signal },
    );
    return h.digest('hex');
  } catch (e) {
    throw arret.signal.aborted ? (arret.signal.reason instanceof Error ? arret.signal.reason : e) : e;
  } finally {
    clearTimeout(minuteur);
  }
}

function extraire(asset, archive, dossier) {
  fs.rmSync(dossier, { recursive: true, force: true });
  fs.mkdirSync(dossier, { recursive: true });
  if (asset.format === 'zip') {
    // `tar.exe` de Windows lit les .zip ; on prend celui de System32 pour ne pas tomber sur un GNU tar (Git Bash) qui ne les lit pas.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    try {
      if (process.platform === 'win32') execFileSync(tar, ['-xf', archive, '-C', dossier], { stdio: 'ignore' });
      else execFileSync('unzip', ['-q', archive, '-d', dossier], { stdio: 'ignore' });
    } catch (e) {
      if (process.platform !== 'win32') throw e;
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dossier.replace(/'/g, "''")}' -Force`], { stdio: 'ignore' });
    }
  } else if (asset.format === 'appimage') {
    fs.chmodSync(archive, 0o755);
    execFileSync(archive, ['--appimage-extract'], { cwd: dossier, stdio: 'ignore' });
  } else {
    throw new InstallationImpossible(`Format d'archive inconnu : ${asset.format}`);
  }
}

/**
 * Assure la présence d'un Grist Desktop utilisable et rend son exécutable.
 * @param {{journal?: (ligne: string) => void, env?: object, plateforme?: string, arch?: string}} [options]
 * @returns {Promise<{executable: string, version: string, source: 'epingle'|'impose'}>}
 */
export async function assurerGristDesktop(options = {}) {
  const journal = options.journal ?? (() => {});
  const env = options.env ?? process.env;
  const plateforme = options.plateforme ?? process.platform;

  if (env.GWAUDIT_GRIST_DESKTOP) {
    if (!fs.existsSync(env.GWAUDIT_GRIST_DESKTOP)) {
      throw new InstallationImpossible(`GWAUDIT_GRIST_DESKTOP="${env.GWAUDIT_GRIST_DESKTOP}" ne pointe vers aucun fichier.`);
    }
    return { executable: env.GWAUDIT_GRIST_DESKTOP, version: 'imposée par GWAUDIT_GRIST_DESKTOP', source: 'impose' };
  }

  const asset = choisirAsset(plateforme, options.arch ?? process.arch);
  const cache = path.join(dossierCache(env, plateforme), 'grist-desktop', EPINGLE.version);
  const dossier = path.join(cache, asset.cle);
  const executable = path.join(dossier, asset.executable);
  const marque = path.join(dossier, '.complet');
  if (fs.existsSync(marque) && fs.readFileSync(marque, 'utf8').trim() === asset.sha256 && fs.existsSync(executable)) {
    return { executable, version: EPINGLE.version, source: 'epingle' };
  }

  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, asset.fichier);
  let empreinte = fs.existsSync(archive) ? await empreinteDe(archive) : null;
  if (empreinte !== asset.sha256) {
    const url = EPINGLE.depot + asset.fichier;
    journal(`  Téléchargement de Grist Desktop ${EPINGLE.version} (environ ${Math.round(asset.taille / 1048576)} Mo, une seule fois) : ${url}`);
    try {
      empreinte = await telecharger(url, `${archive}.part`, asset, journal);
    } catch (e) {
      fs.rmSync(`${archive}.part`, { force: true });
      throw new InstallationImpossible(`Téléchargement impossible (${e.message}). À faire à la main : télécharger ${url} et le déposer dans ${cache} (SHA-256 attendu : ${asset.sha256}), puis relancer.`);
    }
    if (empreinte !== asset.sha256) {
      fs.rmSync(`${archive}.part`, { force: true });
      throw new InstallationImpossible(`Empreinte SHA-256 inattendue pour ${asset.fichier} : ${empreinte} au lieu de ${asset.sha256}. Fichier refusé, rien n'a été installé.`);
    }
    fs.renameSync(`${archive}.part`, archive);
  }
  journal(`  Extraction dans ${dossier}…`);
  extraire(asset, archive, dossier);
  if (!fs.existsSync(executable)) throw new InstallationImpossible(`Extraction terminée mais ${executable} est introuvable.`);
  fs.writeFileSync(marque, asset.sha256, 'utf8');
  return { executable, version: EPINGLE.version, source: 'epingle' };
}
