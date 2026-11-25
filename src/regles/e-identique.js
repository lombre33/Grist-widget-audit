/**
 * Axe E — une bibliothèque embarquée dans le dépôt est-elle IDENTIQUE à la version publiée ? (E-DEP-12)
 *
 * Le nom lu dans l'en-tête d'un fichier n'est pas une preuve, et une version mal identifiée donnerait un faux avis : les bibliothèques embarquées ne sont donc pas
 * comparées à une base d'avis. Ici l'outil prend le contenu pour preuve : il télécharge au registre npm le paquet que l'en-tête et le nom du fichier laissent
 * supposer (`npm pack`, dans un dossier neutre, comme `npm view`), calcule le SHA-256 de chaque fichier de l'archive, et compare à celui de la copie. Une égalité est
 * une preuve positive : le fichier EST ce fichier de ce paquet à cette version, quel que soit le nom que l'en-tête porte. Une différence ne prouve rien (une copie
 * reconstruite, retouchée ou minifiée autrement diffère sans être piégée) : elle ne produit aucun constat, jamais « trafiquée ».
 *
 * Un paquet reconnu a un nom et une version certains : il rejoint ceux qu'OSV.dev compare aux avis connus (`e-osv.js`).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { constat } from '../moteur/modele.js';
import { versionEnTete } from '../moteur/minifie.js';
import { creerNpmIsole, REGISTRE_NPM } from './npm-isole.js';

/** Bornes d'un audit : le nombre de bibliothèques essayées, de noms essayés par bibliothèque, la taille d'une archive et le nombre de fichiers lus dedans. */
export const MAX_BIBLIOTHEQUES = 8;
const MAX_NOMS = 2;
const MAX_OCTETS_ARCHIVE = 30 * 1024 * 1024;
const MAX_ENTREES = 20_000;
const PAR_LOT = 4;
const DELAI = 30_000;
const NOM_NPM = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;

const sha256 = (donnee) => crypto.createHash('sha256').update(donnee).digest('hex');

/**
 * Les noms de paquet npm que le fichier laisse supposer : son nom de fichier sans version ni suffixe (`jquery-3.6.0.min.js` → `jquery`, `chart.umd.js` → `chart`), et
 * le mot que l'en-tête met devant le numéro de version (`jQuery v3.6.0` → `jquery`, `Chart.js v4.4.0` → `chart.js`). Des suppositions : c'est le contenu qui tranche.
 */
export function nomsProbables(chemin, contenu, version) {
  const noms = [];
  const ajouter = (n) => { const nom = n.toLowerCase().replace(/^[^a-z0-9@]+|[^a-z0-9]+$/g, ''); if (nom.length > 1 && nom.length <= 60 && NOM_NPM.test(nom) && !noms.includes(nom)) noms.push(nom); };
  const fichier = path.posix.basename(chemin).replace(/\.(?:min|umd|esm|cjs|iife|bundle|production|development)(?=\.)/g, '').replace(/\.(?:m?js|cjs)$/i, '');
  ajouter(fichier.replace(/[-_.@]v?\d+\.\d+\.\d+.*$/, '').replace(/[-_.]v?\d+(?:\.\d+)*$/, ''));
  const v = (version ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const avant = v && new RegExp(`([A-Za-z][A-Za-z0-9._-]{1,40}?)[\\s:=@-]*(?:v|version\\s*)?${v}`, 'i').exec(contenu.slice(0, 2000));
  if (avant) ajouter(avant[1]);
  return noms.slice(0, MAX_NOMS);
}

/** L'empreinte de chaque fichier d'une archive `.tgz` (le format de `npm pack`), par son chemin dans l'archive. Rien n'est écrit sur le disque. */
export function empreintesDeLArchive(tgz) {
  let tar;
  try { tar = zlib.gunzipSync(tgz, { maxOutputLength: 4 * MAX_OCTETS_ARCHIVE }); } catch { return null; }
  const empreintes = new Map();
  let nom = null;
  for (let pos = 0, entrees = 0; pos + 512 <= tar.length && entrees < MAX_ENTREES; entrees++) {
    const entete = tar.subarray(pos, pos + 512);
    if (entete.every((o) => o === 0)) break;
    const lire = (debut, fin) => entete.toString('utf8', debut, fin).replace(/\0.*$/s, '');
    const taille = parseInt(lire(124, 136).trim() || '0', 8);
    const type = lire(156, 157) || '0';
    const prefixe = lire(345, 500);
    const chemin = nom ?? (prefixe ? `${prefixe}/${lire(0, 100)}` : lire(0, 100));
    nom = null;
    if (!Number.isFinite(taille) || taille < 0 || pos + 512 + taille > tar.length) return null;
    const donnees = tar.subarray(pos + 512, pos + 512 + taille);
    if (type === '0' || type === '\0') empreintes.set(chemin, sha256(donnees));
    else if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(donnees.toString('utf8')); if (m) nom = m[1]; }   // en-tête étendu : le chemin long du fichier suivant
    pos += 512 + Math.ceil(taille / 512) * 512;
  }
  return empreintes;
}

/**
 * Télécharge l'archive d'un paquet (`npm pack` dans un dossier neutre) ; `null` si le paquet ou la version n'existe pas, si l'archive est trop grosse, ou si le registre ne répond pas.
 * `etat` suit les réponses : un registre qui n'a répondu à personne après deux essais n'est plus interrogé (inutile d'attendre trente secondes par bibliothèque).
 */
export async function archiveDuRegistre(npm, nom, version, etat = { echecs: 0, reussites: 0 }) {
  if (etat.echecs >= 2 && !etat.reussites) return null;
  const sortie = fs.mkdtempSync(path.join(npm.dossier, 'pack-'));
  try {
    const r = await npm.lancer(['pack', `${nom}@${version}`, '--json', '--pack-destination', sortie, '--registry', REGISTRE_NPM, '--ignore-scripts', '--fetch-retries=1', '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=3000'], { timeout: DELAI }).catch((e) => e);
    if (r instanceof Error) {
      if (!/E404|404 Not Found|ETARGET|notarget/i.test(`${r.stderr ?? ''}${r.message ?? ''}`)) etat.echecs++;   // introuvable : le registre a répondu
      else etat.reussites++;
      return null;
    }
    etat.reussites++;
    const fichiers = fs.readdirSync(sortie).filter((f) => f.endsWith('.tgz'));
    if (fichiers.length !== 1) return null;
    const chemin = path.join(sortie, fichiers[0]);
    return fs.statSync(chemin).size > MAX_OCTETS_ARCHIVE ? null : fs.readFileSync(chemin);
  } finally {
    fs.rmSync(sortie, { recursive: true, force: true });
  }
}

/**
 * Rapproche chaque bibliothèque embarquée (fichier vendorisé, avec une version lue en en-tête) d'un fichier du paquet publié du même nom et de la même version.
 * @param {Array<{chemin: string, contenu: string}>} fichiers les bibliothèques embarquées
 * @param {string} racine la racine du dépôt (le fichier est relu en octets : l'empreinte est celle du disque, non d'un texte décodé)
 * @param {(nom: string, version: string) => Promise<?Buffer>} archive l'archive du registre ; les essais en fournissent une sans réseau
 * @returns {Promise<Array<{fichier: string, nom: string, version: string, dans: string}>>} les bibliothèques reconnues, avec le chemin du fichier identique dans l'archive
 */
export async function reconnaitreLesBibliotheques(fichiers, racine, archive) {
  const reconnues = [];
  const a = fichiers.slice(0, MAX_BIBLIOTHEQUES);
  for (let i = 0; i < a.length; i += PAR_LOT) {
    await Promise.all(a.slice(i, i + PAR_LOT).map(async (f) => {
      const version = versionEnTete(f.contenu)?.replace(/^v/, '');
      if (!version) return;
      let empreinte;
      try { empreinte = sha256(fs.readFileSync(path.join(racine, f.chemin))); } catch { return; }
      for (const nom of nomsProbables(f.chemin, f.contenu, version)) {
        const tgz = await archive(nom, version).catch(() => null);
        const empreintes = tgz ? empreintesDeLArchive(tgz) : null;
        const dans = empreintes && [...empreintes].find(([, sha]) => sha === empreinte)?.[0];
        if (dans) { reconnues.push({ fichier: f.chemin, nom, version, dans: dans.replace(/^package\//, '') }); return; }
      }
    }));
  }
  return reconnues.sort((x, y) => (x.fichier < y.fichier ? -1 : 1));
}

/**
 * Les bibliothèques embarquées reconnues au registre npm (un `npm` isolé, nettoyé ensuite). Les essais fournissent `creerNpm` ; sans réseau, rien n'est reconnu.
 * @param {Array<{chemin: string, contenu: string}>} fichiers
 */
export async function identifierLesEmbarquees(fichiers, racine, creerNpm = creerNpmIsole) {
  const lisibles = fichiers.filter((f) => versionEnTete(f.contenu));
  if (!lisibles.length) return [];
  const npm = creerNpm();
  const etat = { echecs: 0, reussites: 0 };
  try {
    return await reconnaitreLesBibliotheques(lisibles, racine, (nom, version) => archiveDuRegistre(npm, nom, version, etat));
  } finally {
    npm.nettoyer();
  }
}

/** Le constat E-DEP-12 : ces bibliothèques embarquées sont identiques au paquet publié (une preuve positive, en information). */
export function constatsIdentiques(reconnues) {
  if (!reconnues.length) return [];
  const liste = reconnues.slice(0, 8).map((r) => `${r.fichier} = ${r.nom}@${r.version} (${r.dans})`).join(' ; ') + (reconnues.length > 8 ? ` ; et ${reconnues.length - 8} autre(s)` : '');
  return [constat({
    regle: 'E-DEP-12', axe: 'E', severite: 'info', confiance: 'prouve',
    titre: `${reconnues.length > 1 ? `${reconnues.length} bibliothèques embarquées sont identiques` : 'Une bibliothèque embarquée est identique'} à la version publiée au registre npm`,
    fichier: reconnues[0].fichier,
    constat: `Le SHA-256 de ${liste} est celui du fichier du paquet publié : le fichier est exactement celui de ce paquet à cette version. Ce nom et cette version, désormais certains, sont comparés aux avis connus (E-VULN-03, E-VULN-04).`,
    impact: "Une copie embarquée dont l'origine n'est pas établie peut être retouchée sans que rien ne le montre ; une copie identique à la version publiée est une copie dont on sait ce qu'elle est. Une copie qui diffère n'est pas dite trafiquée : une copie reconstruite ou minifiée autrement diffère sans être piégée, et elle ne produit aucun constat.",
    remediation: 'Rien à corriger. Pour que cette preuve reste lisible, noter la version et la provenance de la bibliothèque dans `vendor/SOURCES.md`.',
    referentiels: ['ANSSI — Maîtrise du code tiers'],
    preuve: { source: 'registre npm', bibliotheques: reconnues.slice(0, 50) },
  })];
}
