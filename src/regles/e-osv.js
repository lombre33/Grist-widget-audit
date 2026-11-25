/**
 * Axe E — avis connus d'OSV.dev (https://osv.dev), la base ouverte qui réunit les avis de GitHub et les paquets signalés malveillants (OpenSSF).
 * Elle comble ce que `npm audit` ne voit pas : une bibliothèque chargée de loin (esm.sh, unpkg…) dont l'adresse dit le nom et la version, et les
 * paquets malveillants connus parmi les paquets verrouillés.
 *
 *  - E-VULN-03 : une bibliothèque chargée de loin, dont le nom et la version exacte se lisent dans l'adresse, ou une bibliothèque embarquée reconnue identique
 *    au paquet publié (E-DEP-12), a un avis publié. Une version mal identifiée donnerait un faux avis : on n'interroge que si le nom ET la version sont certains. Les avis ordinaires des paquets verrouillés restent
 *    à `npm audit` (E-VULN-01), pour ne pas les compter deux fois.
 *  - E-VULN-04 : le paquet (verrouillé ou chargé de loin), à cette version exacte, est signalé malveillant (avis `MAL-…`).
 *
 * Même coupure (`--sans-reseau`) que `npm audit`. Un OSV qui ne répond pas ne dit rien : « non mesurée », jamais « aucun avis ».
 */
import { constat } from '../moteur/modele.js';

export const URL_OSV = 'https://api.osv.dev';
/** Les paquets interrogés en une requête, et les avis dont on lit le détail : bornent un audit, quelle que soit la taille du verrou. */
export const MAX_PAQUETS = 500;
const MAX_DETAILS = 30;
const PAR_LOT = 5;
const DELAI = 15_000;
const LONGUEUR_MAX = 120;
const ID_OSV = /^[A-Za-z0-9._:-]{1,80}$/;

const court = (valeur) => String(valeur ?? '').slice(0, LONGUEUR_MAX);
export const cleDe = (nom, version) => `${nom}@${version}`;

async function appeler(fetchFn, url, options = {}) {
  const r = await fetchFn(url, { ...options, signal: AbortSignal.timeout(DELAI) });
  if (!r.ok) throw new Error(`OSV : HTTP ${r.status}`);
  return r.json();
}

/**
 * Ce qu'OSV dit d'une liste de (nom, version) de paquets npm. Une requête groupée donne les identifiants d'avis de chaque paquet, puis le détail
 * (résumé, gravité) de chaque avis distinct, les paquets malveillants d'abord. Un avis dont le détail ne se lit pas garde son identifiant : il est
 * connu, sa gravité ne l'est pas.
 * @param {Array<{nom: string, version: string}>} paires
 * @param {typeof fetch} [fetchFn] les essais en fournissent une sans réseau
 * @returns {Promise<{lus: Map<string, Array<{id: string, resume: string, gravite: string, malveillant: boolean}>>, erreur: null | 'injoignable' | 'illisible'}>}
 */
export async function interrogerOsv(paires, fetchFn = globalThis.fetch) {
  const demandes = paires.slice(0, MAX_PAQUETS);
  const lus = new Map();
  if (!demandes.length) return { lus, erreur: null };
  let reponse;
  try {
    reponse = await appeler(fetchFn, `${URL_OSV}/v1/querybatch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: demandes.map(({ nom, version }) => ({ package: { name: nom, ecosystem: 'npm' }, version })) }),
    });
  } catch {
    return { lus, erreur: 'injoignable' };
  }
  // Une liste qui n'a pas la taille de la demande ne se lit pas : un décalage attribuerait un avis à un autre paquet.
  if (!Array.isArray(reponse?.results) || reponse.results.length !== demandes.length) return { lus, erreur: 'illisible' };

  const idsDe = (resultat) => (Array.isArray(resultat?.vulns) ? resultat.vulns.map((v) => v?.id).filter((id) => typeof id === 'string' && ID_OSV.test(id)) : []);
  const parPaquet = demandes.map((p, i) => ({ cle: cleDe(p.nom, p.version), ids: [...new Set(idsDe(reponse.results[i]))] }));
  const distincts = [...new Set(parPaquet.flatMap((p) => p.ids))].sort((a, b) => Number(b.startsWith('MAL-')) - Number(a.startsWith('MAL-')) || (a < b ? -1 : 1));

  const details = new Map();
  for (let i = 0; i < Math.min(distincts.length, MAX_DETAILS); i += PAR_LOT) {
    await Promise.all(distincts.slice(i, i + PAR_LOT).map(async (id) => {
      try { details.set(id, await appeler(fetchFn, `${URL_OSV}/v1/vulns/${encodeURIComponent(id)}`)); } catch { /* l'identifiant suffit */ }
    }));
  }
  const gravite = (d) => { const g = String(d?.database_specific?.severity ?? '').toLowerCase(); return ['critical', 'high', 'moderate', 'low'].includes(g) ? g : 'inconnue'; };
  for (const { cle, ids } of parPaquet) {
    const avis = [];
    for (const id of ids) {
      const d = details.get(id);
      if (d?.withdrawn) continue;                      // un avis retiré n'est plus un avis
      avis.push({ id, resume: court(d?.summary), gravite: gravite(d), malveillant: id.startsWith('MAL-') });
    }
    if (avis.length) lus.set(cle, avis);
  }
  return { lus, erreur: null };
}

const REFERENTIELS = ['OSV.dev — Open Source Vulnerabilities', 'OWASP Top 10 A06:2021 — Composants vulnérables et obsolètes', 'ANSSI — Maîtrise du code tiers'];
const lienOsv = (id) => `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
const NIVEAU = { critical: 'critique', high: 'critique', moderate: 'majeur', low: 'mineur', inconnue: 'mineur' };
const RANG = { critique: 3, majeur: 2, mineur: 1 };

/**
 * Les constats E-VULN-03 et E-VULN-04 de ce qu'OSV a rendu.
 * @param {Array<{nom: string, version: string, origine: 'verrou'|'distante'|'embarquee', fichier?: string, ligne?: number, hote?: string}>} paquets ce qui a été interrogé, avec d'où vient le nom
 * @param {Map} lus le résultat d'`interrogerOsv`
 */
export function constatsOsv(paquets, lus) {
  const constats = [];
  for (const p of paquets) {
    const avis = lus.get(cleDe(p.nom, p.version));
    if (!avis) continue;
    const libelle = `${court(p.nom)}@${court(p.version)}`;
    const ou = p.origine === 'distante' ? `chargé depuis ${court(p.hote)}` : p.origine === 'embarquee' ? `embarqué dans le dépôt, ${court(p.fichier)}` : 'verrouillé dans package-lock.json';
    const preuve = (liste) => ({ source: 'osv.dev', nom: court(p.nom), version: court(p.version), origine: p.origine, avis: liste.slice(0, 10).map((a) => ({ id: a.id, gravite: a.gravite, resume: a.resume, lien: lienOsv(a.id) })), total: liste.length });

    const malveillants = avis.filter((a) => a.malveillant);
    if (malveillants.length) {
      constats.push(constat({
        regle: 'E-VULN-04', axe: 'E', severite: 'critique', bloquant: true, confiance: 'certain',
        titre: `Paquet signalé malveillant (OSV) : ${libelle}`,
        fichier: p.fichier ?? (p.origine === 'verrou' ? 'package-lock.json' : undefined), ligne: p.ligne,
        constat: `OSV.dev signale ${libelle} (${ou}) comme un paquet malveillant : ${malveillants.slice(0, 3).map((a) => `${a.id}${a.resume ? ` — ${a.resume}` : ''}`).join(' ; ')}. Le nom et la version sont exacts, la base les désigne.`,
        impact: "Ce code a été identifié comme volontairement nuisible (vol de secrets, porte dérobée, exécution à l'installation) : il s'exécute à l'installation, ou dans le navigateur de chaque agent qui ouvre le widget.",
        remediation: "Retirer ce paquet, le remplacer par celui que le widget voulait réellement, changer les secrets présents sur les postes où il a été installé, et vérifier les avis cités sur osv.dev.",
        referentiels: REFERENTIELS,
        preuve: preuve(malveillants),
      }));
    }
    // Les avis ordinaires des paquets verrouillés restent à `npm audit` (E-VULN-01) : pas de double compte.
    const ordinaires = avis.filter((a) => !a.malveillant);
    if (p.origine !== 'verrou' && ordinaires.length) {
      const niveau = ordinaires.reduce((n, a) => (RANG[NIVEAU[a.gravite]] > RANG[n] ? NIVEAU[a.gravite] : n), 'mineur');
      constats.push(constat({
        regle: 'E-VULN-03', axe: 'E', severite: niveau, bloquant: niveau === 'critique', confiance: 'certain',
        titre: `Vulnérabilité connue (OSV) : ${libelle}, ${ou}`,
        fichier: p.fichier, ligne: p.ligne,
        constat: `OSV.dev publie ${ordinaires.length > 1 ? `${ordinaires.length} avis` : 'un avis'} sur ${libelle} (${ou}) : ${ordinaires.slice(0, 3).map((a) => `${a.id}${a.gravite === 'inconnue' ? '' : ` (${a.gravite})`}${a.resume ? ` — ${a.resume}` : ''}`).join(' ; ')}. Le nom et la version sont exacts : ${p.origine === 'embarquee' ? 'le fichier est identique à celui du paquet publié (E-DEP-12)' : "lus dans l'adresse de chargement"}.`,
        impact: "La bibliothèque est livrée au navigateur de chaque agent avec cette version : la faille s'applique au widget en fonctionnement, pour autant que le code qui la porte soit atteint. La gravité est celle que la base publie, non une mesure sur ce widget.",
        remediation: p.origine === 'embarquee'
          ? `Remplacer la copie embarquée par une version corrigée (voir les avis sur osv.dev : ${ordinaires.slice(0, 3).map((a) => lienOsv(a.id)).join(' ')}), et noter sa version et son origine dans \`vendor/SOURCES.md\`.`
          : `Charger une version corrigée (voir les avis sur osv.dev : ${ordinaires.slice(0, 3).map((a) => lienOsv(a.id)).join(' ')}), de préférence embarquée dans le dépôt (\`vendor/\`) avec sa version et son origine notées.`,
        referentiels: REFERENTIELS,
        preuve: preuve(ordinaires),
      }));
    }
  }
  return constats;
}
