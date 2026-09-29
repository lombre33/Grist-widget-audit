/**
 * Résolution d'une référence de la page contre sa base, exacte quelle que soit
 * la longueur de la base.
 *
 * `new URL(référence, base)` relit et reparse la base entière à chaque appel :
 * sous une `<base href>` de 1 Mio, 50 000 scripts font lire 50 Gio (217 s
 * mesurés). Tronquer la base rendait l'appel bon marché mais changeait en
 * silence ce qui est audité : le code local que Chromium exécute n'était plus
 * lu. Ici la base garde toute son information, et c'est la résolution qui
 * devient bon marché : pour chaque référence, la base longue est remplacée par
 * une base de substitution courte qui garde ce dont le résultat dépend, chaque
 * morceau long étant un jeton que l'on remet à sa place dans le résultat.
 *
 * Ce dont la résolution dépend, dans une base `http:` ou `https:` :
 *  - le schéma et le port, courts ;
 *  - l'hôte et les identifiants : copiés tels quels quand la référence n'en a
 *    pas, jamais lus, donc un jeton chacun ;
 *  - la requête : copiée seulement quand la référence est vide, un jeton ;
 *  - le fragment : jamais copié (`new URL('', 'http://h/a#f')` n'en garde pas) ;
 *  - le chemin : la référence en retient les segments qu'elle ne remonte pas,
 *    dont le dernier (le « fichier ») est écarté quand elle a un chemin. Une
 *    référence remonte au plus autant de segments qu'elle a de séparateurs
 *    plus un : les segments de tête, que rien ne remonte, ne forment qu'un
 *    jeton, et les autres un jeton chacun, dont le compte suit la référence
 *    et non la base.
 * Le coût d'une référence suit donc sa taille, pas celle de la base.
 *
 * Le résultat n'est pas un `URL` mais un objet qui en offre les mêmes
 * propriétés de lecture, avec l'hôte, les identifiants, la requête et les
 * segments de la base remis à leur place sans être recopiés à chaque référence.
 * Une seule différence, dite : un chemin de plus de `PLAFOND_CHEMIN`
 * caractères est remplacé par un chemin qui ne désigne aucun fichier (voir plus bas).
 *
 * Une base qui n'est ni `http:` ni `https:` ne charge rien : ses références
 * relatives se résolvent en `ftp:`, `file:`… que personne ne lit, et les
 * références absolues ne dépendent pas d'elle. Trop longue, elle est remplacée
 * par `about:blank`, où une référence relative ne se résout pas : même verdict
 * pour toutes les règles (voir `preparerBase`).
 */
import { randomBytes } from 'node:crypto';

/** Origine fictive des fichiers du widget : ce qui s'y résout est local pour l'analyse. */
export const ORIGINE_LOCALE = 'https://widget.local';

/** Longueur de `href` à partir de laquelle une base se résout par substitution : le résultat est le même, seul le coût change. */
export const SEUIL_BASE_LONGUE = 4096;

/**
 * Plafond de longueur d'un chemin de résultat. Aucun fichier du widget n'a un
 * chemin de cette longueur (PATH_MAX est de 4 096 octets sous Linux, soit
 * 12 288 caractères une fois encodés ; les chemins longs de Windows vont
 * jusqu'à 32 767 unités) : au-delà, le chemin ne désigne rien, et le rendre en
 * entier recopierait à chaque référence un chemin de plusieurs Mio.
 * `CHEMIN_TROP_LONG` désigne, lui aussi, un fichier qui n'existe pas (le
 * `%00` ne se trouve dans aucun nom de fichier).
 */
export const PLAFOND_CHEMIN = 32768;
export const CHEMIN_TROP_LONG = '/%00chemin-trop-long';

/**
 * Jeton propre à ce processus, écrit en hexadécimal minuscule : ni majuscule ni
 * caractère que l'analyseur d'URL transforme. La page ne peut pas l'écrire
 * sans le connaître ; si elle l'écrit quand même, la référence est résolue
 * contre la vraie base, à l'identique et plus lentement.
 */
export const MARQUEUR = randomBytes(6).toString('hex');
const JETON_HOTE = `h${MARQUEUR}.invalid`;
const JETON_UTILISATEUR = `u${MARQUEUR}`;
const JETON_MOT_DE_PASSE = `w${MARQUEUR}`;
const JETON_REQUETE = `q${MARQUEUR}`;
const JETON_PREFIXE = `s${MARQUEUR}p`;
const DEBUT_JETON_SEGMENT = `s${MARQUEUR}n`;

const estHttp = (protocole) => protocole === 'http:' || protocole === 'https:';

/** Ce qu'une base longue offre à la substitution : ses morceaux, lus une fois. */
class BaseLongue {
  /** @param {URL} url une base `http:` ou `https:` */
  constructor(url) {
    this.url = url;
    this.protocol = url.protocol;
    this.hostname = url.hostname;
    this.username = url.username;
    this.password = url.password;
    this.search = url.search;
    this.chemin = url.pathname;
    // Une requête vide (`http://h/a?`) se recopie dans une référence vide, sans se distinguer de « pas de requête » par `search`.
    const href = url.href;
    const fragment = href.indexOf('#');
    this.requetePresente = (fragment < 0 ? href : href.slice(0, fragment)).includes('?');
    this.decoupe = null;
    this.prefixes = new Map();
  }

  /** Les segments du chemin, et la longueur de la jonction (par `/`) des `i` premiers. */
  segments() {
    if (!this.decoupe) {
      const partes = this.chemin.slice(1).split('/');
      const sommes = new Float64Array(partes.length + 1);
      for (let i = 1; i <= partes.length; i++) sommes[i] = sommes[i - 1] + partes[i - 1].length + (i > 1 ? 1 : 0);
      this.decoupe = { partes, sommes };
    }
    return this.decoupe;
  }

  /** Les `n` premiers segments joints ; mémorisé (peu de valeurs de `n` par page), jamais appelé au-delà du plafond. */
  prefixe(n) {
    let texte = this.prefixes.get(n);
    if (texte === undefined) {
      if (this.prefixes.size >= 8) this.prefixes.clear();
      texte = this.segments().partes.slice(0, n).join('/');
      this.prefixes.set(n, texte);
    }
    return texte;
  }
}

/**
 * Une base prête à résoudre des références en nombre. `url` est la base exacte ;
 * `longue` est ce dont la substitution a besoin, ou null quand l'appel direct suffit.
 * @param {URL} url
 * @param {number} [seuil]
 * @returns {{ url: URL, longue: BaseLongue|null }}
 */
export function preparerBase(url, seuil = SEUIL_BASE_LONGUE) {
  if (url.href.length <= seuil) return { url, longue: null };
  if (!estHttp(url.protocol)) return { url: new URL('about:blank'), longue: null };
  return { url, longue: new BaseLongue(url) };
}

/**
 * `new URL(valeur, base)` ; lève comme lui quand la référence ne se résout pas.
 * @returns {URL|UrlSousBaseLongue}
 */
export function resoudre(valeur, base) {
  if (base.longue === null) return new URL(valeur, base.url);
  return resoudreSousBaseLongue(String(valeur), base.longue);
}

/** Nombre de segments qu'une référence peut remonter, au plus : ses séparateurs plus un (`/` et `\`, que les URL spéciales confondent). */
function remontees(valeur) {
  let n = 1;
  for (let i = 0; i < valeur.length; i++) {
    const c = valeur.charCodeAt(i);
    if (c === 47 || c === 92) n++;
  }
  return n;
}

/** @param {string} valeur @param {BaseLongue} base */
export function resoudreSousBaseLongue(valeur, base) {
  if (valeur.toLowerCase().includes(MARQUEUR)) return new URL(valeur, base.url);
  const { partes } = base.segments();
  const k = partes.length;
  const m = Math.min(k - 1, remontees(valeur));
  const enTete = k - 1 - m;                                  // segments de tête, regroupés en un jeton
  const chemin = enTete > 0 ? [JETON_PREFIXE] : [];
  for (let j = enTete; j < k; j++) chemin.push(`${DEBUT_JETON_SEGMENT}${j}`);
  const identifiants = base.username || base.password
    ? `${base.username ? JETON_UTILISATEUR : ''}${base.password ? `:${JETON_MOT_DE_PASSE}` : ''}@`
    : '';
  const port = base.url.port ? `:${base.url.port}` : '';
  let requete = '';
  if (base.requetePresente) requete = base.search === '' ? '?' : `?${JETON_REQUETE}`;
  const substitut = `${base.protocol}//${identifiants}${JETON_HOTE}${port}/${chemin.join('/')}${requete}`;
  return new UrlSousBaseLongue(new URL(valeur, substitut), base, enTete);
}

/** Les propriétés de lecture d'un `URL` pour un résultat de substitution, avec ce qui vient de la base remis à sa place. */
export class UrlSousBaseLongue {
  #r;
  #base;
  #enTete;
  #depuisBase;
  #chemin;

  constructor(r, base, enTete) {
    this.#r = r;
    this.#base = base;
    this.#enTete = enTete;
    // L'hôte de la base ne se retrouve que si la référence n'en a pas nommé un autre.
    this.#depuisBase = r.hostname === JETON_HOTE;
  }

  get protocol() { return this.#r.protocol; }
  get port() { return this.#r.port; }
  get hash() { return this.#r.hash; }
  get hostname() { return this.#depuisBase ? this.#base.hostname : this.#r.hostname; }
  get host() { return this.#depuisBase ? this.#base.hostname + (this.#r.port ? `:${this.#r.port}` : '') : this.#r.host; }
  get origin() { return this.#depuisBase ? `${this.#r.protocol}//${this.host}` : this.#r.origin; }
  get username() { return this.#r.username === JETON_UTILISATEUR ? this.#base.username : this.#r.username; }
  get password() { return this.#r.password === JETON_MOT_DE_PASSE ? this.#base.password : this.#r.password; }
  get search() { return this.#r.search === `?${JETON_REQUETE}` ? this.#base.search : this.#r.search; }

  /** Le chemin de la base y compris (au plus `PLAFOND_CHEMIN` caractères ; au-delà, `CHEMIN_TROP_LONG`). */
  get pathname() {
    if (!this.#depuisBase) return this.#r.pathname;
    this.#chemin ??= cheminReel(this.#r.pathname, this.#base, this.#enTete);
    return this.#chemin;
  }

  get href() {
    if (!this.#depuisBase) return this.#r.href;
    const r = this.#r;
    const identifiants = this.username || this.password ? `${this.username}${this.password ? `:${this.password}` : ''}@` : '';
    const fragment = r.href.indexOf('#');
    const requetePresente = (fragment < 0 ? r.href : r.href.slice(0, fragment)).includes('?');
    return `${r.protocol}//${identifiants}${this.host}${this.pathname}${requetePresente ? this.search || '?' : ''}${fragment >= 0 ? r.hash || '#' : ''}`;
  }

  toString() { return this.href; }
  toJSON() { return this.href; }
}

/** Le chemin du résultat de substitution, les jetons remplacés par les segments de la base : sa longueur se mesure d'abord, on ne construit que ce qui tient sous le plafond. */
function cheminReel(cheminJeton, base, enTete) {
  const { partes, sommes } = base.segments();
  const segments = cheminJeton.split('/');                    // le premier est vide : un chemin commence par `/`
  const indice = (s) => Number(s.slice(DEBUT_JETON_SEGMENT.length));
  let longueur = segments.length - 1;
  for (const s of segments) {
    if (s === JETON_PREFIXE) longueur += sommes[enTete];
    else if (s.startsWith(DEBUT_JETON_SEGMENT)) longueur += partes[indice(s)].length;
    else longueur += s.length;
  }
  if (longueur > PLAFOND_CHEMIN) return CHEMIN_TROP_LONG;
  return segments.map((s) => {
    if (s === JETON_PREFIXE) return base.prefixe(enTete);
    if (s.startsWith(DEBUT_JETON_SEGMENT)) return partes[indice(s)];
    return s;
  }).join('/');
}
