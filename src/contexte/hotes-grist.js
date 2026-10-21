/**
 * Hôtes de l'infrastructure Grist elle-même : l'API officielle (`docs.getgrist.com`
 * pour le site personnel, `<équipe>.getgrist.com` pour un site d'équipe — page
 * « REST API usage » du centre d'aide Grist) et l'instance de l'État.
 *
 * Un appel vers l'un d'eux est l'usage normal d'un widget Grist, pas une sortie
 * de données : ni l'axe C (C-EXFIL, B-DOC-04) ni l'axe D (D-RESEAU-01) ne le
 * signalent. La correspondance est exacte sur le suffixe de l'hôte : un domaine
 * qui contient seulement « getgrist.com » (`getgrist.com.exemple.org`,
 * `evilgetgrist.com`) n'en fait pas partie.
 *
 * L'exemption ne couvre pas un document précis : voir `documentGristVise`.
 */
export const HOTES_GRIST = [/(^|\.)getgrist\.com$/i, /(^|\.)grist\.numerique\.gouv\.fr$/i, /(^|\.)gristlabs\.com$/i];

export const estGrist = (h) => h && HOTES_GRIST.some((r) => r.test(h));

/**
 * Le document qu'une adresse de l'API Grist vise (`/api/docs/<identifiant>…`), ou null. Le document que l'agent a ouvert ne se connaît qu'à
 * l'exécution, par la `baseUrl` de `getAccessToken` : un identifiant écrit dans le code, ou observé vers un hôte Grist, désigne un autre
 * document, celui de l'auteur ou un document public. L'hôte étant celui de Grist, rien d'autre ne le distingue d'un appel ordinaire.
 */
export function documentGristVise(url) {
  let u;
  try { u = new URL(url, 'https://widget.local/'); } catch { return null; }
  return estGrist(u.hostname) ? (/^\/api\/docs\/([^/]+)/.exec(u.pathname)?.[1] ?? null) : null;
}
