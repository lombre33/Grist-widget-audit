/**
 * Axe E — dates de publication des dépendances directes de production, lues au registre npm (`npm view`) : de quoi dire si une dépendance
 * est publiée régulièrement. Même registre, même isolation (`npm-isole.js`) et même coupure (`--sans-reseau`) que `npm audit`.
 *
 * Une date de publication est un indice de maintenance, non une preuve : un paquet achevé peut ne plus bouger, un paquet abandonné peut avoir
 * été publié hier. Le résultat se dit « publication récente » ou « sans publication depuis plus de 24 mois », jamais « maintenu » ni « abandonné ».
 */
import { creerNpmIsole, REGISTRE_NPM } from './npm-isole.js';

/** Au-delà de cette ancienneté, la dernière publication n'est plus dite récente. Une constante déclarée, dite dans le rapport. */
export const SEUIL_ANCIENNETE_MOIS = 24;
/** Les dépendances directes de production interrogées, dans l'ordre du `package.json` : borne le nombre d'appels et la durée d'un audit. */
export const MAX_INTERROGEES = 25;
const PAR_LOT = 5;
const DELAI_PAR_APPEL = 20_000;
const MOIS_EN_MS = 30.44 * 24 * 3600 * 1000;

const NOM_NPM = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;

/**
 * Vrai si la dépendance se lit au registre public : un nom de paquet valide (et qui ne peut pas passer pour une option de `npm`), et une
 * version ou une plage, non une adresse (git, URL, fichier, `npm:` alias, `workspace:`).
 */
export const estDuRegistre = (nom, specification) => nom.length <= 214 && NOM_NPM.test(nom) && typeof specification === 'string' && !/[:/]/.test(specification);

/** Ce que le registre dit d'un paquet : ses dates de publication et sa dernière version, ou la cause pour laquelle on ne le sait pas. */
async function lireUn(npm, nom) {
  // Une seule reprise, courte : par défaut `npm` en attend trois, de dix secondes et plus, et un registre qui refuse tout ferait attendre l'audit.
  const r = await npm.lancer(['view', nom, 'time', 'dist-tags', '--json', '--registry', REGISTRE_NPM, '--fetch-retries=1', '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=3000'], { timeout: DELAI_PAR_APPEL }).catch((e) => e);
  let j;
  try { j = JSON.parse(String(r.stdout ?? '')); } catch { return { erreur: 'injoignable' }; }
  if (j?.error) return { erreur: j.error.code === 'E404' ? 'introuvable' : 'injoignable' };
  if (!j?.time || typeof j.time !== 'object') return { erreur: 'injoignable' };
  return { time: j.time, latest: j['dist-tags']?.latest };
}

/**
 * Interroge le registre, par lots. Le registre qui ne répond à personne arrête la lecture (inutile d'attendre vingt secondes par lot) : les
 * paquets non lus sont absents du résultat. `creerNpm` : les essais en fournissent un `npm` sans réseau.
 * @returns {Promise<Map<string, {time: object, latest?: string} | {erreur: 'introuvable'|'injoignable'}>>}
 */
export async function interrogerRegistre(noms, creerNpm = creerNpmIsole) {
  const resultats = new Map();
  const npm = creerNpm();
  try {
    for (let i = 0; i < noms.length; i += PAR_LOT) {
      const lot = noms.slice(i, i + PAR_LOT);
      const rendus = await Promise.all(lot.map((nom) => lireUn(npm, nom)));
      lot.forEach((nom, k) => resultats.set(nom, rendus[k]));
      if (rendus.every((r) => r.erreur === 'injoignable')) break;
    }
  } finally {
    npm.nettoyer();
  }
  return resultats;
}

const majeure = (version) => { const m = /^(\d+)\./.exec(String(version ?? '')); return m ? Number(m[1]) : null; };

/**
 * Ce que la réponse du registre dit de la régularité : la date de la dernière publication, son ancienneté en mois, et le retard de la version
 * verrouillée sur la dernière en versions majeures (`null` quand l'une des deux n'est pas lisible).
 */
export function resumerPublications({ time, latest }, versionVerrouillee, maintenant = Date.now()) {
  let derniere = -Infinity;
  for (const [version, date] of Object.entries(time)) {
    const t = version === 'created' || version === 'modified' ? NaN : Date.parse(date);   // `modified` bouge à chaque changement de métadonnée, pas à une publication
    if (t > derniere) derniere = t;
  }
  if (!Number.isFinite(derniere)) return null;
  const ageMois = Math.max(0, Math.floor((maintenant - derniere) / MOIS_EN_MS));
  const [v1, v2] = [majeure(latest), majeure(versionVerrouillee)];
  return {
    etat: ageMois <= SEUIL_ANCIENNETE_MOIS ? 'recente' : 'ancienne',
    dernierePublication: new Date(derniere).toISOString().slice(0, 10),
    ageMois,
    retardMajeur: v1 !== null && v2 !== null ? Math.max(0, v1 - v2) : null,
  };
}
