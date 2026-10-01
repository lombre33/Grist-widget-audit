#!/usr/bin/env node
/**
 * Mesure ce que le test des leurres (`estCorpsDeLeurre`, `src/regles/c-secrets.js`) fait des clés tirées au hasard : pour chaque alphabet et
 * chaque longueur que les fournisseurs émettent (et pour les pires cas), combien de tirages ont la forme de mots (`motsDeLaValeur`, ce que le test
 * jugeait seul avant qu'un mot de remplacement soit exigé) et combien sont pris pour un leurre. Une clé prise pour un leurre n'est ni signalée par la
 * règle ni masquée dans un rapport : c'est une absence, le constat le plus fragile. Le relevé qui a fait exiger un mot de remplacement : une clé AWS
 * tirée au hasard sur cent était prise pour un leurre. Ce qui reste, après ce correctif : une clé dont l'un des morceaux est, par hasard, un mot de remplacement
 * entier, et dont les autres ont la forme de mots, est encore prise pour un leurre (`tests/c-secret-hasard.test.mjs`, le dernier essai) ; cette mesure le compte.
 *
 * Les tirages sont déterministes (mulberry32, `--graine`) et sans budget de temps : le même arbre, la même graine et le même nombre de tirages
 * donnent les mêmes comptes. Aucun secret n'est écrit ici ni dans la sortie : seuls des comptes sont dits.
 *
 * Usage : node scripts/mesurer-leurres-au-hasard.mjs [--tirages=1000000] [--graine=1] [--racine=<arbre>]
 *   --racine : l'arbre de l'outil à mesurer (le dépôt courant par défaut), pour comparer un arbre à celui d'avant un correctif.
 * Code 0 : moins d'un tirage sur cent mille pris pour un leurre, pour chacune des formes que les fournisseurs émettent ; code 1 : une forme de
 * fournisseur dépasse ce seuil ; code 2 : option fausse, ou arbre qui n'a pas `estCorpsDeLeurre` et `motsDeLaValeur`.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEUIL = 1e-5;

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const FORMES = [
  // [libellé, alphabet, longueur, forme d'un fournisseur ?]
  ['AWS, base 32, 16 signes', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 16, true],
  ['AWS, majuscules et chiffres, 16 signes', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16, true],
  ['GitHub, base 62, 36 signes', ALNUM, 36, true],
  ['Stripe, base 62, 24 signes', ALNUM, 24, true],
  ['OpenAI, base 62, 48 signes', ALNUM, 48, true],
  ['Google, base 64 URL, 35 signes', `${ALNUM}_-`, 35, true],
  ['base 62, 16 signes', ALNUM, 16, false],
  ['base 62, 20 signes', ALNUM, 20, false],
  ['base 64 URL, 20 signes', `${ALNUM}_-`, 20, false],
  ['base 64 URL, 32 signes', `${ALNUM}_-`, 32, false],
  ['lettres seules, 24 signes (aucun fournisseur)', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 24, false],
  ['lettres seules, 36 signes (aucun fournisseur)', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 36, false],
];

function options(argv) {
  const o = { tirages: 1000000, graine: 1, racine: RACINE };
  for (const a of argv) {
    const m = /^--(tirages|graine|racine)=(.+)$/.exec(a);
    if (!m) return null;
    if (m[1] === 'racine') o.racine = path.resolve(m[2]);
    else {
      const n = Number(m[2]);
      if (!Number.isInteger(n) || n < 1) return null;
      o[m[1]] = n;
    }
  }
  return o;
}

/** mulberry32 : les mêmes tirages à chaque lancement pour une graine donnée. */
function generateur(graine) {
  let x = graine >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const o = options(process.argv.slice(2));
  if (!o) {
    console.error('Usage : node scripts/mesurer-leurres-au-hasard.mjs [--tirages=1000000] [--graine=1] [--racine=<arbre>]');
    return 2;
  }
  const { estCorpsDeLeurre, motsDeLaValeur } = await import(pathToFileURL(path.join(o.racine, 'src/regles/c-secrets.js')).href);
  if (typeof estCorpsDeLeurre !== 'function' || typeof motsDeLaValeur !== 'function') {
    console.error(`${o.racine} : ce que cet arbre exporte de src/regles/c-secrets.js n'a pas estCorpsDeLeurre et motsDeLaValeur : rien à mesurer.`);
    return 2;
  }
  const alea = generateur(o.graine);
  let depassement = false;
  console.log(`${o.tirages} tirages par forme, graine ${o.graine}, arbre ${o.racine}`);
  for (const [libelle, alphabet, longueur, fournisseur] of FORMES) {
    let formeDeMots = 0;
    let pris = 0;
    for (let i = 0; i < o.tirages; i++) {
      let corps = '';
      for (let k = 0; k < longueur; k++) corps += alphabet[Math.floor(alea() * alphabet.length)];
      if (motsDeLaValeur(corps) !== null) formeDeMots++;
      if (estCorpsDeLeurre(corps)) pris++;
    }
    const trop = fournisseur && pris / o.tirages >= SEUIL;
    if (trop) depassement = true;
    console.log(`${trop ? 'TROP ' : '     '}${libelle.padEnd(48)} ${String(formeDeMots).padStart(8)} ont la forme de mots, ${String(pris).padStart(6)} prises pour un leurre`);
  }
  console.log(depassement ? `Une forme de fournisseur dépasse un tirage sur ${Math.round(1 / SEUIL)} pris pour un leurre.` : `Aucune forme de fournisseur ne dépasse un tirage sur ${Math.round(1 / SEUIL)} pris pour un leurre.`);
  return depassement ? 1 : 0;
}

process.exitCode = await main();
