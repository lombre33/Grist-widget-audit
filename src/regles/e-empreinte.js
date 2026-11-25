/**
 * Axe E — ce qui a été audité, et ce que l'adresse sert aujourd'hui (E-FIGE-01).
 *
 * Grist charge un widget par son adresse : ce que cette adresse sert demain n'est pas forcément ce qui a été audité (un dépôt qui avance, une branche qui bouge,
 * un compte compromis). Le rapport garde donc l'empreinte de ce qui a été lu : le SHA-256 des contenus de tous les fichiers du dépôt (hors `.git` et
 * `node_modules`), avec le commit et la branche quand le dépôt est un dépôt git. `gwaudit --verifier rapport.json` la compare à ce que la cible est aujourd'hui.
 *
 * Une information, jamais une pénalité : ce n'est pas un défaut du widget, c'est une limite de ce que l'audit prouve dans le temps. Une empreinte égale dit
 * « les mêmes octets » ; elle ne dit rien d'un service externe que le widget appelle, ni d'une bibliothèque chargée de loin (voir E-DEP-01).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constat } from '../moteur/modele.js';

/** Ce que l'empreinte ne lit pas : l'historique git, et les paquets installés (que `npm install` change sans que le widget change). */
const EXCLUS = new Set(['.git', 'node_modules']);
/** Bornes d'une lecture : un dépôt hostile ou énorme n'épuise ni le temps ni la mémoire ; au-delà, l'empreinte dit qu'elle est partielle. */
export const MAX_FICHIERS = 20_000;
export const MAX_OCTETS = 512 * 1024 * 1024;
/** Les fichiers dont le rapport garde l'empreinte propre (seize premiers caractères), pour dire lesquels ont changé. */
export const MAX_DETAIL = 2000;
const TAILLE_LECTURE = 1 << 20;

const sha256 = (donnee) => crypto.createHash('sha256').update(donnee).digest('hex');

/** SHA-256 d'un fichier lu par blocs : un fichier de plusieurs centaines de Mo n'est jamais entier en mémoire. */
function empreinteDeFichier(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const tampon = Buffer.allocUnsafe(TAILLE_LECTURE);
    for (let n = fs.readSync(fd, tampon, 0, TAILLE_LECTURE, null); n > 0; n = fs.readSync(fd, tampon, 0, TAILLE_LECTURE, null)) h.update(tampon.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function git(racine, ...args) {
  try { return execFileSync('git', ['-C', racine, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

/**
 * L'empreinte du dépôt : un SHA-256 sur la liste triée des (chemin, SHA-256 du contenu), ce qu'il faut pour que deux copies identiques en donnent la même
 * quelle que soit la machine. Un lien symbolique compte par sa cible (jamais suivi). Un fichier qui ne se lit pas est compté dans `illisibles`.
 * @returns {{empreinte: string, fichiers: number, octets: number, tronque: boolean, illisibles: number, liste: Array<{chemin: string, sha: string}>, commit: ?string, branche: ?string}}
 */
export function empreinteDuDepot(racine) {
  const entrees = [];
  let octets = 0, tronque = false, illisibles = 0;
  const pile = [''];
  while (pile.length) {
    const rel = pile.pop();
    let contenu;
    try { contenu = fs.readdirSync(path.join(racine, rel), { withFileTypes: true }); } catch { illisibles++; continue; }
    for (const e of contenu) {
      if (EXCLUS.has(e.name)) continue;
      const chemin = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { pile.push(chemin); continue; }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      if (entrees.length >= MAX_FICHIERS || octets >= MAX_OCTETS) { tronque = true; continue; }
      try {
        const abs = path.join(racine, chemin);
        if (e.isSymbolicLink()) { entrees.push({ chemin, sha: sha256(`lien:${fs.readlinkSync(abs)}`) }); continue; }
        octets += fs.statSync(abs).size;
        entrees.push({ chemin, sha: empreinteDeFichier(abs) });
      } catch { illisibles++; }
    }
  }
  entrees.sort((a, b) => (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0));
  return {
    empreinte: sha256(entrees.map((f) => `${f.chemin}\0${f.sha}`).join('\n')),
    fichiers: entrees.length, octets, tronque, illisibles,
    liste: entrees.slice(0, MAX_DETAIL).map((f) => ({ chemin: f.chemin, sha: f.sha.slice(0, 16) })),
    commit: git(racine, 'rev-parse', 'HEAD'),
    branche: git(racine, 'symbolic-ref', '--short', '-q', 'HEAD'),
  };
}

/**
 * Ce qui a changé entre l'empreinte gardée dans un rapport et celle d'aujourd'hui.
 * @param {{empreinte: string, liste?: Array<{chemin: string, sha: string}>, fichiers?: number}} avant la preuve de E-FIGE-01 du rapport
 * @param {ReturnType<typeof empreinteDuDepot>} apres
 * @returns {{identique: boolean, modifies: string[], ajoutes: string[], retires: string[], partiel: boolean}} `partiel` : une des deux listes est coupée, les fichiers changés au-delà ne sont pas nommés
 */
export function comparerEmpreintes(avant, apres) {
  if (avant.empreinte === apres.empreinte) return { identique: true, modifies: [], ajoutes: [], retires: [], partiel: false };
  const ancien = new Map((avant.liste ?? []).map((f) => [f.chemin, f.sha]));
  const nouveau = new Map(apres.liste.map((f) => [f.chemin, f.sha]));
  const partiel = (avant.fichiers ?? ancien.size) > ancien.size || apres.fichiers > nouveau.size;
  return {
    identique: false,
    modifies: [...nouveau].filter(([c, sha]) => ancien.has(c) && ancien.get(c) !== sha).map(([c]) => c),
    ajoutes: [...nouveau.keys()].filter((c) => !ancien.has(c)),
    retires: [...ancien.keys()].filter((c) => !nouveau.has(c)),
    partiel,
  };
}

/**
 * Le constat E-FIGE-01 : ce qui a été audité, et l'avertissement quand la cible est la pointe d'une branche (l'adresse que Grist charge peut alors changer).
 * @param {ReturnType<typeof empreinteDuDepot>} lue
 * @param {{cible?: ?string}} [origine] `cible` : l'adresse clonée, absente pour un dossier local
 */
export function constatEmpreinte(lue, { cible = null } = {}) {
  const brancheMobile = Boolean(cible && lue.branche);
  const court = lue.empreinte.slice(0, 12);
  return constat({
    regle: 'E-FIGE-01', axe: 'E', severite: 'info', confiance: 'certain',
    titre: `Ce qui a été audité : empreinte ${court}…`,
    constat: `L'audit porte sur ${lue.fichiers} fichier(s) dont l'empreinte (SHA-256 des contenus) est ${lue.empreinte}${lue.commit ? `, au commit ${lue.commit.slice(0, 12)}` : ''}${lue.branche ? ` de la branche « ${lue.branche} »` : ''}.`
      + (brancheMobile ? ` L'audit a lu la pointe de cette branche : elle avance à chaque envoi, et l'adresse par laquelle Grist charge le widget peut servir autre chose que ce qui a été audité.` : '')
      + (lue.tronque ? ` L'empreinte est partielle : le dépôt dépasse ${MAX_FICHIERS} fichiers ou ${MAX_OCTETS / (1024 * 1024)} Mo, la suite n'est pas lue.` : '')
      + (lue.illisibles ? ` ${lue.illisibles} fichier(s) ou dossier(s) n'ont pas pu être lus et ne sont pas dans l'empreinte.` : ''),
    impact: "Un widget est chargé par son adresse : ce que Grist sert demain n'est pas forcément ce que l'audit a lu aujourd'hui (une branche qui avance, un compte compromis, un dépôt remplacé après l'audit). Une empreinte égale dit « les mêmes octets » ; elle ne dit rien des services externes que le widget appelle ni des bibliothèques qu'il charge de loin (voir E-DEP-01).",
    remediation: brancheMobile
      ? "Pour savoir si le dépôt a changé depuis cet audit : `gwaudit --verifier rapport.json`. Pour que l'adresse ne bouge pas, charger le widget depuis un tag ou un commit précis, non depuis la branche."
      : "Pour savoir si le dépôt a changé depuis cet audit : `gwaudit --verifier rapport.json <dossier>`.",
    referentiels: ['ANSSI — Sécurisation de la chaîne de production logicielle', 'OWASP Top 10 A08:2021 — Software and Data Integrity Failures'],
    preuve: { empreinte: lue.empreinte, fichiers: lue.fichiers, octets: lue.octets, tronque: lue.tronque, illisibles: lue.illisibles, commit: lue.commit, branche: lue.branche, cible, brancheMobile, liste: lue.liste },
  });
}
