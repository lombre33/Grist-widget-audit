/**
 * Lecteur CSS : ce que Chromium charge depuis un texte CSS, lu comme lui.
 *
 * Deux lectures, chacune vérifiée contre Chromium 141 (sondes du 2026-09-29,
 * `tests/passe-html-css.test.mjs`) :
 *
 * 1. L'analyseur du standard (CSS Syntax 3) : un découpeur en flux (une
 *    passe, temps linéaire, jamais de tableau de jetons) et une pile
 *    explicite (pas de récursion). Seul le fermant qui correspond au sommet
 *    de la pile ferme un bloc ; les autres sont des jetons ordinaires, ce qui
 *    fait que `@foo (}; @import url(X);` ne charge rien, comme dans Chromium.
 *    - `@import` : seulement au niveau racine, avant toute règle valide
 *      (`@charset`, `@layer a;`, un `@import` invalide n'y comptent pas), le
 *      premier jeton doit être une chaîne, `url(...)` ou `url("...")`, et
 *      l'at-règle doit finir par `;` ou par la fin du texte (un bloc `{` en
 *      fait une règle à bloc, sans import). Un jeton isolé au niveau racine
 *      (`;`, `}`, `x`) ouvre une règle qualifiée dont le prélude avale les
 *      `@import` suivants jusqu'à son bloc.
 *    - `url()` : seulement dans un bloc `{}` d'une règle qualifiée ou d'une
 *      at-règle qui applique ses déclarations (`@media`, `@font-face`…), ou
 *      dans un attribut `style`. Ni les préludes (`@namespace url(...)`,
 *      `@media`), ni les sélecteurs, ni les at-règles inconnues, ni les
 *      fonctions qui ne chargent rien dans Chromium (`cross-fade`, `src`,
 *      `image`, `element`, `paint`, `attr`, `if`). Les chaînes directes
 *      d'`image-set(` sont des URL.
 *    - `data:` en `@import` : décodé comme Chromium (fragment coupé, base64
 *      indulgent du standard, un base64 refusé ne charge rien) et relu s'il
 *      est `text/css`, ou de n'importe quel type quand la page est en mode
 *      quirks (`mimeLibre`). Dans une feuille `data:` la base est opaque : un
 *      `@import` relatif ne charge rien, seul un `@import` absolu charge, et
 *      ses `url()` se résolvent contre le document. Chromium ne borne pas la
 *      profondeur (40 niveaux vérifiés) : la borne d'ici (`LIMITES_CSS`) est
 *      dite, la borne atteinte est une entrée `borne`, jamais un silence.
 *
 * 2. Le scanner de préchargement de Chromium, qui lit le début d'un
 *    `<style>` HTML sans l'analyseur et demande `@import U;` avec `U;` pour
 *    valeur (l'hôte contacté est celui de l'URL nue). Il s'arrête à la
 *    première chose qui n'est pas un `@import`, un `@charset` ou un
 *    `@layer x;`. Demandé seulement pour un `<style>` HTML (pas dans
 *    `<template>`, `<noscript>`, un attribut `style` ni un fichier `.css`).
 */

const EOF = 'eof';

const estNl = (c) => c === 10 || c === 13 || c === 12;
const estEspace = (c) => c === 32 || c === 9 || estNl(c);
const estChiffre = (c) => c >= 48 && c <= 57;
const estHex = (c) => estChiffre(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const debutNom = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128 || c === 0;
const carNom = (c) => debutNom(c) || estChiffre(c) || c === 45;
const nonImprimable = (c) => (c >= 0 && c <= 8) || c === 11 || (c >= 14 && c <= 31) || c === 127;

function creerJetons(s) {
  const n = s.length;
  let i = 0;
  const code = (k) => (k < n ? s.charCodeAt(k) : -1);
  const echappement = (k) => code(k) === 92 && !estNl(code(k + 1));
  const debutIdent = (k) => {
    const c = code(k);
    if (c === 45) {
      const d = code(k + 1);
      return debutNom(d) || d === 45 || echappement(k + 1);
    }
    return debutNom(c) || echappement(k);
  };
  const debutNombre = (k) => {
    const c = code(k);
    if (c === 43 || c === 45) {
      const d = code(k + 1);
      return estChiffre(d) || (d === 46 && estChiffre(code(k + 2)));
    }
    if (c === 46) return estChiffre(code(k + 1));
    return estChiffre(c);
  };

  function echapper() {
    if (i >= n) return '�';
    const c = s.charCodeAt(i);
    if (estHex(c)) {
      let j = i;
      let v = 0;
      while (j < n && j - i < 6 && estHex(s.charCodeAt(j))) {
        v = v * 16 + parseInt(s[j], 16);
        j++;
      }
      if (j < n) {
        const e = s.charCodeAt(j);
        if (e === 13 && s.charCodeAt(j + 1) === 10) j += 2;
        else if (estEspace(e)) j++;
      }
      i = j;
      return v === 0 || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff) ? '�' : String.fromCodePoint(v);
    }
    i++;
    if (c >= 0xd800 && c <= 0xdbff && i < n) {
      const e = s.charCodeAt(i);
      if (e >= 0xdc00 && e <= 0xdfff) {
        i++;
        return s[i - 2] + s[i - 1];
      }
    }
    return s[i - 1];
  }

  function nom() {
    let j = i;
    while (j < n && carNom(s.charCodeAt(j))) j++;
    if (j >= n || !echappement(j)) {
      const v = s.slice(i, j);
      i = j;
      return v;
    }
    let sortie = s.slice(i, j);
    i = j;
    for (;;) {
      const c = code(i);
      if (carNom(c)) {
        let k = i + 1;
        while (k < n && carNom(s.charCodeAt(k))) k++;
        sortie += s.slice(i, k);
        i = k;
      } else if (echappement(i)) {
        i++;
        sortie += echapper();
      } else break;
    }
    return sortie;
  }

  function chaine(q) {
    let sortie = '';
    for (;;) {
      if (i >= n) return [sortie, false];
      const c = s.charCodeAt(i);
      if (c === q) {
        i++;
        return [sortie, false];
      }
      if (estNl(c)) return [sortie, true];
      if (c === 92) {
        i++;
        if (i >= n) continue;
        const d = s.charCodeAt(i);
        if (estNl(d)) {
          if (d === 13 && s.charCodeAt(i + 1) === 10) i += 2;
          else i++;
          continue;
        }
        sortie += echapper();
        continue;
      }
      let j = i + 1;
      while (j < n) {
        const e = s.charCodeAt(j);
        if (e === q || e === 92 || estNl(e)) break;
        j++;
      }
      sortie += s.slice(i, j);
      i = j;
    }
  }

  function resteUrl() {
    for (;;) {
      if (i >= n) return;
      const c = s.charCodeAt(i);
      if (c === 41) {
        i++;
        return;
      }
      if (echappement(i)) {
        i++;
        echapper();
      } else i++;
    }
  }

  function urlJeton() {
    while (i < n && estEspace(s.charCodeAt(i))) i++;
    let sortie = '';
    for (;;) {
      if (i >= n) return [sortie, false];
      const c = s.charCodeAt(i);
      if (c === 41) {
        i++;
        return [sortie, false];
      }
      if (estEspace(c)) {
        while (i < n && estEspace(s.charCodeAt(i))) i++;
        if (i >= n) return [sortie, false];
        if (s.charCodeAt(i) === 41) {
          i++;
          return [sortie, false];
        }
        resteUrl();
        return [sortie, true];
      }
      if (c === 34 || c === 39 || c === 40 || nonImprimable(c)) {
        resteUrl();
        return [sortie, true];
      }
      if (c === 92) {
        if (echappement(i)) {
          i++;
          sortie += echapper();
          continue;
        }
        resteUrl();
        return [sortie, true];
      }
      let j = i + 1;
      while (j < n) {
        const e = s.charCodeAt(j);
        if (e === 41 || estEspace(e) || e === 34 || e === 39 || e === 40 || e === 92 || nonImprimable(e)) break;
        j++;
      }
      sortie += s.slice(i, j);
      i = j;
    }
  }

  function nombre() {
    if (code(i) === 43 || code(i) === 45) i++;
    while (estChiffre(code(i))) i++;
    if (code(i) === 46 && estChiffre(code(i + 1))) {
      i++;
      while (estChiffre(code(i))) i++;
    }
    const e = code(i);
    if (e === 69 || e === 101) {
      const a = code(i + 1);
      if (estChiffre(a) || ((a === 43 || a === 45) && estChiffre(code(i + 2)))) {
        i += 2;
        while (estChiffre(code(i))) i++;
      }
    }
    if (debutIdent(i)) nom();
    else if (code(i) === 37) i++;
  }

  const jeton = (t, d, v = '') => ({ t, v, d, f: i });

  return {
    suivant() {
      while (code(i) === 47 && code(i + 1) === 42) {
        const f = s.indexOf('*/', i + 2);
        i = f < 0 ? n : f + 2;
      }
      const d = i;
      if (i >= n) return { t: EOF, v: '', d, f: d };
      const c = s.charCodeAt(i);
      if (estEspace(c)) {
        while (i < n && estEspace(s.charCodeAt(i))) i++;
        return jeton('ws', d);
      }
      if (c === 34 || c === 39) {
        i++;
        const [v, mauvais] = chaine(c);
        return jeton(mauvais ? 'badstring' : 'string', d, v);
      }
      if (c === 35) {
        if (carNom(code(i + 1)) || echappement(i + 1)) {
          i++;
          return jeton('hash', d, nom());
        }
        i++;
        return jeton('delim', d, '#');
      }
      if (c === 40 || c === 41 || c === 91 || c === 93 || c === 123 || c === 125 || c === 44 || c === 58 || c === 59) {
        i++;
        return jeton(s[d], d);
      }
      if (c === 43 || c === 46) {
        if (debutNombre(i)) {
          nombre();
          return jeton('num', d);
        }
        i++;
        return jeton('delim', d, s[d]);
      }
      if (c === 45) {
        if (debutNombre(i)) {
          nombre();
          return jeton('num', d);
        }
        if (code(i + 1) === 45 && code(i + 2) === 62) {
          i += 3;
          return jeton('cdc', d);
        }
        if (!debutIdent(i)) {
          i++;
          return jeton('delim', d, '-');
        }
      }
      if (c === 60) {
        if (code(i + 1) === 33 && code(i + 2) === 45 && code(i + 3) === 45) {
          i += 4;
          return jeton('cdo', d);
        }
        i++;
        return jeton('delim', d, '<');
      }
      if (c === 64) {
        if (debutIdent(i + 1)) {
          i++;
          return jeton('at', d, nom());
        }
        i++;
        return jeton('delim', d, '@');
      }
      if (estChiffre(c)) {
        nombre();
        return jeton('num', d);
      }
      if (debutNom(c) || c === 45 || echappement(i)) {
        const v = nom();
        if (code(i) === 40) {
          i++;
          if (v.toLowerCase() === 'url') {
            let k = i;
            while (k < n && estEspace(s.charCodeAt(k))) k++;
            const q = code(k);
            if (q !== 34 && q !== 39) {
              const [u, mauvais] = urlJeton();
              return jeton(mauvais ? 'badurl' : 'url', d, u);
            }
          }
          return jeton('fn', d, v);
        }
        return jeton('ident', d, v);
      }
      i++;
      return jeton('delim', d, s[d]);
    },
  };
}

const FONCTIONS_MUETTES = new Set(['cross-fade', '-webkit-cross-fade', 'src', 'image', 'element', 'paint', 'attr', 'if']);
const FONCTIONS_IMAGE_SET = new Set(['image-set', '-webkit-image-set']);
const AT_REGLES_LUES = new Set(['media', 'supports', 'layer', 'container', 'scope', 'starting-style', 'font-face', 'page', 'keyframes', '-webkit-keyframes']);
const AT_REGLES_TOUJOURS_VALIDES = new Set(['media', 'layer', 'scope', 'font-face', 'page', 'starting-style']);
const AT_REGLES_A_PRELUDE = new Set([
  'keyframes',
  '-webkit-keyframes',
  'property',
  'supports',
  'container',
  'counter-style',
  'font-feature-values',
  'font-palette-values',
  'position-try',
]);

export const LIMITES_CSS = Object.freeze({ profondeur: 16, octets: 1 << 20 });

export function nouveauBudgetCss() {
  return { octets: LIMITES_CSS.octets };
}

const estEspaceHtml = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const estAlpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

function octetsDeUrl(corps) {
  const morceaux = [];
  let debut = 0;
  const re = /%([0-9a-fA-F]{2})/g;
  let m;
  while ((m = re.exec(corps))) {
    if (m.index > debut) morceaux.push(Buffer.from(corps.slice(debut, m.index), 'utf8'));
    morceaux.push(Buffer.from([parseInt(m[1], 16)]));
    debut = m.index + 3;
  }
  if (debut < corps.length) morceaux.push(Buffer.from(corps.slice(debut), 'utf8'));
  return Buffer.concat(morceaux);
}

/**
 * Le base64 du standard (« forgiving-base64 ») : les blancs ASCII sont
 * retirés, un ou deux `=` de fin sont admis quand la longueur est un multiple
 * de 4, et tout autre écart (alphabet URL-safe `-_`, `=` au milieu, reste de 1
 * modulo 4) fait échouer le décodage entier : rien n'est chargé.
 */
function base64Indulgent(texte) {
  let s = texte.replace(/[\t\n\f\r ]+/g, '');
  if (s.length % 4 === 0) {
    if (s.endsWith('==')) s = s.slice(0, -2);
    else if (s.endsWith('=')) s = s.slice(0, -1);
  }
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) return null;
  return Buffer.from(s, 'base64');
}

/** Retire les caractères de contrôle C0 et l'espace en tête et en queue, comme l'analyseur d'URL du standard (pas `trim()` : l'espace insécable et l'espace idéographique restent). Linéaire. */
export function rognerUrl(texte) {
  let a = 0;
  let b = texte.length;
  while (a < b && texte.charCodeAt(a) <= 32) a++;
  while (b > a && texte.charCodeAt(b - 1) <= 32) b--;
  return a === 0 && b === texte.length ? texte : texte.slice(a, b);
}

/**
 * Décode une URL `data:` comme Chromium : espaces de contrôle retirés en tête
 * et en queue, tabulations et sauts de ligne retirés partout, fragment coupé
 * au premier `#` (un `%23` est décodé, il ne coupe pas), pourcentages puis
 * base64 si le type le dit. Renvoie `{ mime, corps }` (le corps décodé en
 * UTF-8), `{ mime, corps: null, trop: true }` au-delà du volume admis,
 * `{ mime, corps: '', invalide: true }` quand le base64 est refusé (le
 * navigateur ne charge alors rien), ou null si ce n'est pas une URL `data:`.
 */
export function decoderUrlData(url, octetsMax = LIMITES_CSS.octets) {
  let propre = rognerUrl(String(url)).replace(/[\t\n\r]/g, '');
  const diese = propre.indexOf('#');
  if (diese >= 0) propre = propre.slice(0, diese);
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(propre);
  if (!m) return null;
  const type = m[1].trim();
  const base64 = /;\s*base64$/i.test(type);
  const mime = type.replace(/;\s*base64$/i, '').split(';')[0].trim().toLowerCase() || 'text/plain';
  if (m[2].length > octetsMax * 4) return { mime, corps: null, trop: true };
  const octets = octetsDeUrl(m[2]);
  if (!base64) return { mime, corps: octets.toString('utf8') };
  const decode = base64Indulgent(octets.toString('latin1'));
  if (decode === null) return { mime, corps: '', invalide: true };
  return { mime, corps: decode.toString('utf8') };
}

function normaliserValeurBrute(brut) {
  let v = brut;
  if (/^url\(/i.test(v) && v.endsWith(')')) v = v.slice(4, -1);
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
  return v;
}

/**
 * Le scanner de préchargement de Chromium sur le texte d'un `<style>` HTML.
 * Renvoie les valeurs demandées, avec leur position dans le texte.
 */
export function lirePrechargement(s) {
  const n = s.length;
  const sorties = [];
  const c = (k) => (k < n ? s.charCodeAt(k) : -1);
  let i = 0;
  for (;;) {
    while (i < n && estEspaceHtml(c(i))) i++;
    if (i >= n) return sorties;
    const ch = c(i);
    if (ch === 47) {
      if (c(i + 1) === 42) {
        const f = s.indexOf('*/', i + 2);
        if (f < 0) return sorties;
        i = f + 2;
      } else i += 2;
      continue;
    }
    if (ch !== 64) return sorties;
    i++;
    let k = i;
    while (k < n && estAlpha(c(k))) k++;
    if (k === i) {
      i++;
      continue;
    }
    const nomRegle = s.slice(i, k).toLowerCase();
    i = k;
    if (i >= n) return sorties;
    if (c(i) === 59) {
      i++;
      continue;
    }
    if (!estEspaceHtml(c(i))) return sorties;
    while (i < n && estEspaceHtml(c(i))) i++;
    if (i >= n) return sorties;
    if (c(i) === 59) {
      i++;
      continue;
    }
    if (c(i) === 123) return sorties;
    if (nomRegle === 'charset' || nomRegle === 'layer') {
      if (!sauterJusquauPointVirgule()) return sorties;
      continue;
    }
    if (nomRegle !== 'import') return sorties;
    const debut = i;
    while (i < n && !estEspaceHtml(c(i))) i++;
    const brut = s.slice(debut, i);
    const ferme = valeurFermeeSuivieDePointVirgule(brut);
    if (ferme !== null) {
      sorties.push({ url: ferme.valeur, debut });
      i = debut + ferme.fin;
      continue;
    }
    if (i >= n) {
      sorties.push({ url: normaliserValeurBrute(brut), debut });
      return sorties;
    }
    while (i < n && estEspaceHtml(c(i))) i++;
    if (i >= n) {
      sorties.push({ url: normaliserValeurBrute(brut), debut });
      return sorties;
    }
    if (c(i) === 59) {
      sorties.push({ url: normaliserValeurBrute(brut), debut });
      i++;
      continue;
    }
    if (c(i) === 123) return sorties;
    if (!sauterJusquauPointVirgule()) return sorties;
  }

  function sauterJusquauPointVirgule() {
    while (i < n) {
      const d = c(i);
      i++;
      if (d === 59) return true;
      if (d === 123) return false;
    }
    return false;
  }

  function valeurFermeeSuivieDePointVirgule(brut) {
    const q = brut[0];
    let p;
    if (q === '"' || q === "'") {
      p = 1;
      while (p < brut.length && brut[p] !== q) p += brut[p] === '\\' ? 2 : 1;
      if (p >= brut.length || brut[p + 1] !== ';') return null;
    } else {
      p = brut.indexOf(');');
      if (p < 0) return null;
    }
    return { valeur: normaliserValeurBrute(brut.slice(0, p + 1)), fin: p + 2 };
  }
}

/**
 * Lit un texte CSS et renvoie ce que Chromium en charge.
 *
 * @param {string} texte
 * @param {{ mode?: 'feuille'|'attribut', budget?: {octets:number}, profondeur?: number, mimeLibre?: boolean }} options
 * @returns {Array<{ url?: string, sorte: 'import'|'url'|'precharge'|'borne', debut: number, apresRegle?: boolean, raison?: string }>}
 *   `debut` est le décalage dans `texte` ; `apresRegle` : un `@import` derrière
 *   une règle qualifiée que le lecteur ne sait pas dire invalide (ignoré par
 *   le navigateur si elle est valide) ; `borne` : une borne de profondeur ou
 *   de volume des feuilles `data:` a été atteinte (`raison`).
 */
export function lireCss(texte, options = {}) {
  const { mode = 'feuille', budget = nouveauBudgetCss(), profondeur = 0, mimeLibre = false } = options;
  const entrees = [];
  const jetons = creerJetons(texte);
  const RACINE = { ferm: null, scan: mode === 'attribut', muet: false, fn: null };
  const pile = [];
  let ctx = mode === 'attribut' ? 'decl' : 'racine';
  let regle = null;
  let apres = false;

  // Une chaîne entre guillemets de blancs ASCII seuls, dans une déclaration, se résout vers la base et est demandée
  // (`url("  ")`) ; vide (`url("")`, `url()`) ou dans un `@import`, rien n'est chargé. Un espace insécable n'est pas un blanc d'URL.
  const ajouterUrl = (valeur, sorte, debut, extra, citee = false) => {
    const v = rognerUrl(valeur);
    if (!v && !(citee && sorte === 'url' && valeur !== '')) return;
    entrees.push({ url: v, sorte, debut, ...extra });
    if (sorte === 'import') suivreData(v, debut);
  };

  function suivreData(v, debut) {
    const d = decoderUrlData(v);
    if (!d || d.invalide || (d.mime !== 'text/css' && !mimeLibre)) return;
    if (profondeur >= LIMITES_CSS.profondeur) {
      entrees.push({ sorte: 'borne', raison: 'profondeur', debut });
      return;
    }
    if (d.corps === null || budget.octets < d.corps.length) {
      entrees.push({ sorte: 'borne', raison: 'volume', debut });
      return;
    }
    budget.octets -= d.corps.length;
    for (const e of lireCss(d.corps, { mode: 'feuille', budget, profondeur: profondeur + 1, mimeLibre })) {
      // Base opaque : un @import relatif, absolu de chemin ou sans schéma ne charge rien depuis une feuille data:
      if (e.sorte === 'import' && !URL.canParse(e.url)) continue;
      entrees.push({ ...e, debut, via: 'data' });
    }
  }

  function nouvelleRegle(nomAt, jeton) {
    return { nom: nomAt, n: 0, premiers: [], invalide: false, bloc: false, imp: null, impNu: false, jeton };
  }

  function fermerRegle(avecBloc) {
    const r = regle;
    regle = null;
    ctx = 'racine';
    if (!r) return;
    if (r.nom === null) {
      if (avecBloc && !r.invalide) apres = true;
      return;
    }
    if (avecBloc) {
      if (AT_REGLES_TOUJOURS_VALIDES.has(r.nom) || (AT_REGLES_A_PRELUDE.has(r.nom) && r.n > 0)) apres = true;
      return;
    }
    if (r.nom === 'import') {
      if (r.imp && !r.invalide) ajouterUrl(r.imp.v, 'import', r.imp.d, apres ? { apresRegle: true } : undefined);
    } else if (r.nom === 'namespace') {
      const [a, b] = r.premiers;
      if (a === 'string' || a === 'url' || (a === 'ident' && (b === 'string' || b === 'url' || b === 'fnurl'))) apres = true;
    }
  }

  function fermerCadre(cadre) {
    if (cadre.fn === 'url' && cadre.urlN === 1 && cadre.urlTok) {
      if (cadre.scan && !cadre.muet) ajouterUrl(cadre.urlTok.v, 'url', cadre.urlTok.d, undefined, true);
      if (cadre.impUrl && regle) regle.imp = cadre.urlTok;
    }
    if (cadre.racine) fermerRegle(true);
  }

  for (;;) {
    const j = jetons.suivant();
    if (j.t === EOF) break;
    const haut = pile.length ? pile[pile.length - 1] : RACINE;
    const t = j.t;

    if (t === ')' || t === ']' || t === '}') {
      if (pile.length && haut.ferm === t) {
        pile.pop();
        fermerCadre(haut);
        continue;
      }
    }

    if (t !== 'ws' && haut.fn === 'url' && !(t === ')' && haut.ferm === ')')) {
      haut.urlN++;
      if (t === 'string' && haut.urlN === 1) haut.urlTok = j;
    }

    if (ctx === 'racine' && pile.length === 0) {
      if (t === 'ws' || t === 'cdo' || t === 'cdc') continue;
      if (t === 'at') {
        regle = nouvelleRegle(j.v.toLowerCase(), j);
        ctx = 'at';
        continue;
      }
      regle = nouvelleRegle(null, j);
      ctx = 'qual';
    }

    if (ctx === 'at' && pile.length === 0 && t === ';') {
      fermerRegle(false);
      continue;
    }

    if (haut.fn && FONCTIONS_IMAGE_SET.has(haut.fn) && t === 'string' && haut.scan && !haut.muet) {
      ajouterUrl(j.v, 'url', j.d, undefined, true);
    }

    if (t === '{') {
      if (pile.length === 0 && (ctx === 'at' || ctx === 'qual')) {
        regle.bloc = true;
        const lit = regle.nom === null ? !regle.invalide : AT_REGLES_LUES.has(regle.nom);
        pile.push({ ferm: '}', scan: lit, muet: false, fn: null, racine: true });
      } else {
        pile.push({ ferm: '}', scan: haut.scan, muet: haut.muet, fn: null });
      }
      continue;
    }
    if (t === '(' || t === '[' || t === 'fn') {
      const nomFn = t === 'fn' ? j.v.toLowerCase() : null;
      const cadre = {
        ferm: t === '[' ? ']' : ')',
        scan: haut.scan,
        muet: haut.muet || t === '[' || (nomFn !== null && FONCTIONS_MUETTES.has(nomFn)),
        fn: nomFn,
        urlN: 0,
        urlTok: null,
      };
      if (nomFn === 'url' && pile.length === 0 && ctx === 'at' && regle.nom === 'import' && regle.n === 0) cadre.impUrl = true;
      if (pile.length === 0 && (ctx === 'at' || ctx === 'qual') && t !== '[') {
        regle.n++;
        if (regle.premiers.length < 2) regle.premiers.push(nomFn === 'url' ? 'fnurl' : 'fn');
      }
      if (pile.length === 0 && ctx === 'at' && regle.nom === 'import' && regle.n === 1 && !cadre.impUrl) regle.invalide = true;
      pile.push(cadre);
      continue;
    }

    if (t === 'url' && haut.scan && !haut.muet) ajouterUrl(j.v, 'url', j.d);

    if (pile.length === 0 && ctx === 'qual') {
      if (t === ';' || (t === 'delim' && j.v === '!')) regle.invalide = true;
    } else if (pile.length === 0 && ctx === 'at' && t !== 'ws') {
      regle.n++;
      if (regle.premiers.length < 2) regle.premiers.push(t);
      if (regle.nom === 'import' && regle.n === 1) {
        if (t === 'string' || t === 'url') regle.imp = j;
        else regle.invalide = true;
      }
    }
  }

  while (pile.length) fermerCadre(pile.pop());
  if (ctx === 'at' && regle && !regle.bloc) fermerRegle(false);

  return entrees;
}

/**
 * Ce que Chromium charge depuis une feuille de `lirePage(...).feuilles` :
 * le lecteur CSS du standard sur `texte` quand le navigateur en fait une
 * feuille (`applique`), et le scanner de préchargement sur `texteScanner`
 * pour un `<style>` qu'il lit (`precharge`), y compris un `<style
 * type="text/foo">` que le navigateur ne compile pas. Une valeur du scanner
 * que l'analyseur demande à l'identique n'est comptée qu'une fois. Les
 * `debut` des entrées `precharge` sont des décalages de `texteScanner`
 * (`position(feuille, decalage, true)`), les autres de `texte`.
 * @returns {ReturnType<typeof lireCss>}
 */
export function lireFeuille(feuille, budget = nouveauBudgetCss()) {
  let entrees = feuille.applique
    ? lireCss(feuille.texte, { mode: feuille.sorte === 'attribut' ? 'attribut' : 'feuille', budget, mimeLibre: feuille.mimeLibre === true })
    : [];
  if (feuille.sorte === 'lien') {
    // Base opaque : dans une feuille `data:`, un @import relatif, absolu de chemin ou sans schéma ne charge rien.
    entrees = entrees.filter((e) => e.sorte !== 'import' || e.via === 'data' || URL.canParse(e.url));
    if (feuille.trop && feuille.applique) entrees.push({ sorte: 'borne', raison: 'volume', debut: 0 });
  }
  if (feuille.precharge) {
    const vus = new Set(entrees.filter((e) => e.sorte === 'import').map((e) => e.url));
    for (const p of lirePrechargement(feuille.texteScanner)) {
      if (p.url && !vus.has(p.url)) entrees.push({ url: p.url, sorte: 'precharge', debut: p.debut });
    }
  }
  return entrees;
}
