/**
 * La bibliothèque qu'une adresse de chargement désigne, pour dire de quoi un widget dépend : `https://esm.sh/react-dom@18.3.1/client` est le module `react-dom/client`
 * de la bibliothèque `react-dom`, version 18.3.1. Plusieurs chargements d'une même bibliothèque (ses sous-modules) se regroupent sous son nom.
 *
 * Seuls les hébergeurs de paquets connus se lisent, à leur forme d'adresse ; une autre adresse ne désigne aucune bibliothèque (`null`) : on ne devine pas un nom.
 * Le texte vient du widget : les morceaux rendus sont bornés.
 */

const BORNE_NOM = 100;
const BORNE_VERSION = 40;
const BORNE_MODULE = 150;
const BORNE_ADRESSE = 300;

/** Les hébergeurs dont le chemin commence par un nom de paquet npm (`nom@version/sous/chemin`). */
const HOTES_NPM = new Set(['esm.sh', 'esm.run', 'unpkg.com', 'cdn.skypack.dev', 'cdn.jsdelivr.net', 'ga.jspm.io']);

/** Le paquet que les `nb` premiers segments nomment (`nom@version`, `@portee/nom@version`, `proprietaire/depot@version`), et ce qui suit dans le chemin. */
function lirePaquet(segments, nb, prefixe = '') {
  if (segments.length < nb) return null;
  const dernier = segments[nb - 1];
  const arobase = dernier.indexOf('@', 1);
  const nom = prefixe + [...segments.slice(0, nb - 1), arobase > 0 ? dernier.slice(0, arobase) : dernier].join('/');
  if (!nom) return null;
  return { nom, version: arobase > 0 ? dernier.slice(arobase + 1) || null : null, sousChemin: segments.slice(nb).join('/') };
}

/** Le paquet d'une adresse d'hébergeur npm : son préfixe de version de build (`/v135/`, `/stable/`), son indicateur de dépendance externe (`*`), ses raccourcis `gh/` et `jsr/`. */
function paquetNpm(hote, segments) {
  if (hote === 'esm.sh') {
    if (/^(v\d+|stable)$/.test(segments[0] ?? '')) segments.shift();
    if (segments[0]?.startsWith('*')) segments[0] = segments[0].slice(1);
  }
  if (hote === 'ga.jspm.io' && segments[0]?.startsWith('npm:')) segments[0] = segments[0].slice(4);
  if (hote === 'cdn.jsdelivr.net') {
    if (segments[0] === 'npm') segments.shift();
    else if (segments[0] === 'gh') return lirePaquet(segments.slice(1), 2, 'gh/');
    else return null;
  }
  if ((hote === 'esm.sh') && (segments[0] === 'gh' || segments[0] === 'jsr')) return lirePaquet(segments.slice(1), 2, `${segments[0]}/`);
  return lirePaquet(segments, segments[0]?.startsWith('@') ? 2 : 1);
}

/** cdnjs : `/ajax/libs/<bibliothèque>/<version>/<fichier>` ; le « sous-module » est le fichier. */
function paquetCdnjs(segments) {
  if (segments[0] !== 'ajax' || segments[1] !== 'libs' || !segments[2]) return null;
  const version = /^\d/.test(segments[3] ?? '') ? segments[3] : null;
  return { nom: segments[2], version, sousChemin: segments.slice(version ? 4 : 3).join('/') };
}

/**
 * @param {string} adresse une adresse absolue
 * @returns {?{nom: string, version: ?string, module: string}} `module` : le module chargé, le nom de la bibliothèque suivi de son sous-chemin (`react-dom/client`)
 */
export function bibliothequeDeAdresse(adresse) {
  let u;
  try { u = new URL(adresse); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const hote = u.hostname.toLowerCase();
  const segments = u.pathname.split('/').filter(Boolean);
  const paquet = hote === 'cdnjs.cloudflare.com' ? paquetCdnjs(segments) : HOTES_NPM.has(hote) ? paquetNpm(hote, segments) : null;
  if (!paquet) return null;
  const nom = paquet.nom.slice(0, BORNE_NOM);
  return {
    nom,
    version: paquet.version ? paquet.version.slice(0, BORNE_VERSION) : null,
    module: (paquet.sousChemin ? `${paquet.nom}/${paquet.sousChemin}` : paquet.nom).slice(0, BORNE_MODULE),
  };
}

/** Ce qu'un constat de chargement garde dans sa preuve : l'adresse, et la bibliothèque quand elle se lit. */
export function preuveDeChargement(adresse) {
  const b = bibliothequeDeAdresse(adresse);
  return { adresse: String(adresse).slice(0, BORNE_ADRESSE), ...(b ? { bibliotheque: b.nom, version: b.version, module: b.module } : {}) };
}

/** Une bibliothèque en une expression : `react-dom/client (18.3.1)`. */
export const libelleDeBibliotheque = (preuve) => (preuve?.bibliotheque ? `${preuve.module}${preuve.version ? ` (${preuve.version})` : ''}` : null);

/**
 * Les constats qui portent une bibliothèque, regroupés par bibliothèque : ses versions, ses modules (un module chargé plusieurs fois n'est cité qu'une fois, avec son
 * nombre de chargements) et son nombre de chargements. Les plus chargées d'abord.
 * @param {Array<{preuve: ?{bibliotheque?: string, version?: ?string, module?: string}}>} constats
 * @returns {Array<{nom: string, versions: string[], modules: Array<{module: string, chargements: number}>, chargements: number}>}
 */
export function regrouperParBibliotheque(constats) {
  const parNom = new Map();
  for (const c of constats) {
    const p = c.preuve;
    if (!p?.bibliotheque) continue;
    let b = parNom.get(p.bibliotheque);
    if (!b) parNom.set(p.bibliotheque, b = { nom: p.bibliotheque, versions: new Set(), modules: new Map(), chargements: 0 });
    if (p.version) b.versions.add(p.version);
    b.modules.set(p.module, (b.modules.get(p.module) ?? 0) + 1);
    b.chargements++;
  }
  return [...parNom.values()]
    .map((b) => ({ nom: b.nom, versions: [...b.versions].sort(), modules: [...b.modules].map(([module, chargements]) => ({ module, chargements })).sort((x, y) => (x.module < y.module ? -1 : x.module > y.module ? 1 : 0)), chargements: b.chargements }))
    .sort((x, y) => y.chargements - x.chargements || (x.nom < y.nom ? -1 : x.nom > y.nom ? 1 : 0));
}
