#!/usr/bin/env node
// Dérive des empreintes d'images de base : pour chaque FROM épinglé des Dockerfile
// de la brique, compare l'empreinte épinglée à celle que son étiquette désigne
// AUJOURD'HUI au registre. Elles diffèrent : l'image de base a été republiée
// (correctifs de sécurité) et rien dans le dépôt ne le dit, puisque l'empreinte
// épinglée ne change jamais d'elle-même. Contrôle quotidien de la routine de
// fraîcheur ; il constate, il ne modifie rien.
//
// Usage : node docker/ci/derive-empreintes.mjs [--json] [--registre <url>]
//   --registre : envoie toutes les demandes à ce registre (miroir, ou registre de test)
//                au lieu de celui que nomme l'image.
// Code de sortie : 0 aucune dérive · 1 au moins une dérive · 2 au moins un registre
// injoignable ou une réponse inexploitable (rien n'est alors dit « à jour » : un
// registre muet n'est pas une absence de dérive).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { analyserReference, imagesDeBase } from './lib-images.mjs';

const execFileAsync = promisify(execFile);
const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DOCKERFILES = ['docker/execution/Dockerfile', 'docker/egress-proxy/Dockerfile'];
const ACCEPTE = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * curl : présent là où ce contrôle tourne (runner, VPS), et il suit les variables de proxy du poste.
 * Asynchrone : un curl bloquant gèlerait le processus qui héberge le registre de test.
 * Une panne de curl est rendue par la ligne d'erreur de curl lui-même, JAMAIS par la commande : elle porte le
 * jeton d'accès (`Authorization: Bearer …`), qui ne doit pas finir dans un rapport ni dans un message.
 */
async function curl(args, { tete = false, suivre = false } = {}) {
  const base = ['-sS', '--max-time', '30', ...(tete ? ['-I'] : []), ...(suivre ? ['-L'] : [])];
  try {
    const { stdout } = await execFileAsync('curl', [...base, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
    return stdout;
  } catch (e) {
    const ligne = String(e?.stderr ?? '').trim().split('\n').filter(Boolean).at(-1);
    throw new Error(ligne ? `curl a échoué : ${ligne}` : `curl a échoué (${e?.code ?? e?.signal ?? 'sans code'})`);
  }
}

const STATUTS_TRANSITOIRES = new Set([429, 500, 502, 503, 504]);
const DELAIS_DE_REPRISE_MS = [3000, 8000];
const dormir = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Une demande d'en-têtes reprise quand le registre dit « trop de demandes » ou tombe en panne passagère : Docker Hub
 * limite les demandes anonymes par adresse, et un 429 isolé n'est pas une dérive ni une absence de dérive.
 * Après les reprises, le dernier statut est rendu tel quel (le contrôle le dit en erreur, jamais en « à jour »).
 */
async function entetesAvecReprises(demande, delais) {
  let reponse = await demande();
  for (const delai of delais) {
    if (!STATUTS_TRANSITOIRES.has(reponse.statut)) break;
    await dormir(delai);
    reponse = await demande();
  }
  return reponse;
}

/** Dernier bloc d'en-têtes (un proxy CONNECT en ajoute un devant) : statut et en-têtes en minuscules. */
export function lireEntetes(texte) {
  const blocs = texte.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  const dernier = blocs.at(-1) ?? '';
  const [ligne, ...reste] = dernier.split(/\r?\n/);
  const statut = Number(/^HTTP\/\S+\s+(\d{3})/.exec(ligne ?? '')?.[1] ?? NaN);
  const entetes = Object.fromEntries(reste.map((l) => { const i = l.indexOf(':'); return i < 0 ? [l.toLowerCase(), ''] : [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; }));
  return { statut, entetes };
}

function fournisseurDeRegistre(registre, urlDeBase, delais) {
  const base = urlDeBase ? urlDeBase.replace(/\/+$/, '') : `https://${registre}`;
  const jetons = new Map();

  /** Une demande authentifiée : sans jeton d'abord, puis avec celui que le registre réclame (Bearer) s'il répond 401. */
  async function demander(chemin, depot, { tete = false, suivre = false } = {}) {
    const url = `${base}${chemin}`;
    const appeler = async (jeton) => {
      const entetes = ['-H', `Accept: ${ACCEPTE}`, ...(jeton ? ['-H', `Authorization: Bearer ${jeton}`] : [])];
      return tete ? entetesAvecReprises(async () => lireEntetes(await curl([...entetes, url], { tete: true })), delais) : { corps: await curl([...entetes, url], { suivre }) };
    };
    // Le 401 n'est lisible qu'en tête (statut + WWW-Authenticate) : on sonde toujours par un HEAD.
    let jeton = jetons.get(depot);
    if (!jeton) {
      const sonde = await entetesAvecReprises(async () => lireEntetes(await curl(['-H', `Accept: ${ACCEPTE}`, url], { tete: true })), delais);
      if (sonde.statut === 401) {
        const defi = sonde.entetes['www-authenticate'] ?? '';
        const royaume = /realm="([^"]+)"/.exec(defi)?.[1];
        if (!/^Bearer/i.test(defi) || !royaume) throw new Error(`le registre ${registre} demande une authentification que ce contrôle ne sait pas faire (${defi || 'sans défi'})`);
        const service = /service="([^"]+)"/.exec(defi)?.[1];
        const portee = /scope="([^"]+)"/.exec(defi)?.[1] ?? `repository:${depot}:pull`;
        const requete = new URL(royaume);
        if (service) requete.searchParams.set('service', service);
        requete.searchParams.set('scope', portee);
        let reponse;
        try { reponse = JSON.parse(await curl([requete.toString()])); } catch { throw new Error(`le service de jetons du registre ${registre} n'a pas rendu de réponse lisible (limite de débit ?)`); }
        jeton = reponse.token ?? reponse.access_token;
        if (!jeton) throw new Error(`le registre ${registre} n'a pas rendu de jeton d'accès`);
        jetons.set(depot, jeton);
      } else if (sonde.statut !== 200) {
        throw new Error(`le registre ${registre} répond ${Number.isNaN(sonde.statut) ? 'sans statut lisible' : sonde.statut} pour ${chemin}`);
      }
    }
    return appeler(jeton);
  }
  return { demander };
}

/** Date de construction de l'image que désigne `empreinte` : annotation de l'index, sinon `created` de la configuration de l'image linux/amd64. null si aucune ne la donne. */
async function dateDeConstruction(fournisseur, depot, empreinte) {
  try {
    const manifeste = JSON.parse((await fournisseur.demander(`/v2/${depot}/manifests/${empreinte}`, depot)).corps);
    const annotees = (manifeste.manifests ?? []).map((m) => m.annotations?.['org.opencontainers.image.created']).filter(Boolean).sort();
    if (annotees.length) return annotees.at(-1);
    let unique = manifeste;
    if (manifeste.manifests) {
      const amd64 = manifeste.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
      if (!amd64) return null;
      unique = JSON.parse((await fournisseur.demander(`/v2/${depot}/manifests/${amd64.digest}`, depot)).corps);
    }
    if (!unique.config?.digest) return null;
    const config = JSON.parse((await fournisseur.demander(`/v2/${depot}/blobs/${unique.config.digest}`, depot, { suivre: true })).corps);
    return config.created ?? null;
  } catch {
    return null; // la date est un complément : sa perte ne change ni la dérive constatée ni le code de sortie
  }
}

export async function verifierDerive({ racine = RACINE, registreDeTest = null, maintenant = new Date(), delais = DELAIS_DE_REPRISE_MS } = {}) {
  const resultats = [];
  for (const dockerfile of DOCKERFILES) {
    const source = fs.readFileSync(path.join(racine, dockerfile), 'utf8');
    for (const { resolue } of imagesDeBase(source)) {
      const ref = analyserReference(resolue);
      const base = { dockerfile, image: resolue };
      if (!ref?.etiquette) { resultats.push({ ...base, etat: 'erreur', erreur: `référence sans étiquette et empreinte à comparer : ${resolue}` }); continue; }
      try {
        const fournisseur = fournisseurDeRegistre(ref.registre, registreDeTest, delais);
        const { statut, entetes } = await fournisseur.demander(`/v2/${ref.depot}/manifests/${ref.etiquette}`, ref.depot, { tete: true });
        const courante = entetes['docker-content-digest'];
        if (statut !== 200 || !/^sha256:[0-9a-f]{64}$/.test(courante ?? '')) throw new Error(`réponse inexploitable du registre ${ref.registre} pour ${ref.depot}:${ref.etiquette} (statut ${statut}, empreinte « ${courante ?? 'absente'} »)`);
        const memes = courante === ref.empreinte;
        resultats.push({
          ...base, etat: memes ? 'a-jour' : 'derive', etiquette: `${ref.depot}:${ref.etiquette}`, registre: ref.registre,
          empreinteEpinglee: ref.empreinte, empreinteActuelle: courante,
          ...(memes ? {} : { imageActuelleConstruiteLe: await dateDeConstruction(fournisseur, ref.depot, courante) }),
        });
      } catch (e) {
        resultats.push({ ...base, etat: 'erreur', erreur: String(e?.message ?? e).split('\n')[0].slice(0, 300) });
      }
    }
  }
  return { verifieLe: maintenant.toISOString(), resultats };
}

export function codeDeSortie(rapport) {
  if (rapport.resultats.some((r) => r.etat === 'erreur')) return 2;
  return rapport.resultats.some((r) => r.etat === 'derive') ? 1 : 0;
}

function texte(rapport) {
  const lignes = [`Dérive des empreintes d'images de base, vérifiée le ${rapport.verifieLe}`];
  for (const r of rapport.resultats) {
    if (r.etat === 'a-jour') lignes.push(`  à jour  ${r.dockerfile} : ${r.etiquette} = ${r.empreinteEpinglee}`);
    else if (r.etat === 'derive') lignes.push(`  DÉRIVE  ${r.dockerfile} : ${r.etiquette}\n            épinglée ${r.empreinteEpinglee}\n            actuelle ${r.empreinteActuelle}${r.imageActuelleConstruiteLe ? ` (image construite le ${r.imageActuelleConstruiteLe})` : ''}`);
    else lignes.push(`  ERREUR  ${r.dockerfile} : ${r.image} — ${r.erreur}`);
  }
  const code = codeDeSortie(rapport);
  lignes.push(code === 0 ? 'Aucune dérive.' : code === 1 ? "Des correctifs attendent : l'image de base a été republiée depuis l'épinglage." : "Registre injoignable ou réponse inexploitable : rien n'est établi, ce n'est PAS « à jour ».");
  return lignes.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--registre');
  const rapport = await verifierDerive({ registreDeTest: i >= 0 ? args[i + 1] : null });
  console.log(args.includes('--json') ? JSON.stringify(rapport, null, 2) : texte(rapport));
  process.exitCode = codeDeSortie(rapport);
}
