#!/usr/bin/env node
/**
 * Rejoue les mutants de la résolution sous base longue (`src/moteur/base-url.js`) :
 * chaque garde de la substitution (le compte des remontées, le jeton, les
 * identifiants, la requête, le plafond du chemin…) est gardée par un test de
 * `tests/base-url.test.mjs` (méthode : `scripts/lib/rejouer-mutants.mjs`).
 * Aucun navigateur n'est requis.
 *
 * Usage : node scripts/mutants-base-url.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants } from './lib/rejouer-mutants.mjs';

const B = 'src/moteur/base-url.js';
const P = 'src/moteur/page-html.js';
const TESTS = ['tests/base-url.test.mjs'];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- le seuil et le chemin pris
  [B, 'if (url.href.length <= seuil) return { url, longue: null };', 'if (true) return { url, longue: null };', 'seuil : la substitution n\'est jamais prise (la base entière est relue à chaque référence)'],
  [B, 'export const SEUIL_BASE_LONGUE = 4096;', 'export const SEUIL_BASE_LONGUE = 4096 * 1000000;', 'seuil : constante repoussée à l\'infini'],
  [B, 'export const SEUIL_BASE_LONGUE = 4096;', 'export const SEUIL_BASE_LONGUE = 0;', 'seuil : constante à 0 (même une base courte est substituée)'],
  [B, 'if (url.href.length <= seuil) return', 'if (url.href.length < seuil) return', 'seuil : exclusif au lieu d\'inclusif'],
  [B, "if (!estHttp(url.protocol)) return { url: new URL('about:blank'), longue: null };", "if (false) return { url: new URL('about:blank'), longue: null };", 'base longue non http(s) : substituée comme une base http(s)'],
  [B, "return { url: new URL('about:blank'), longue: null };", 'return { url, longue: null };', 'base longue non http(s) : gardée entière au lieu d\'about:blank'],
  [P, 'base = preparerBase(urlDeBase(baseBrute, cheminPage));', 'base = preparerBase(urlDeBase(baseBrute, cheminPage), Infinity);', 'page-html : la base n\'est jamais substituée'],
  [P, 'if (base === undefined) {', 'if (true) {', 'page-html : base recalculée à chaque référence (mémoïsation retirée)'],

  // --- le jeton propre au processus
  [B, 'if (valeur.toLowerCase().includes(MARQUEUR)) return new URL(valeur, base.url);', 'if (false) return new URL(valeur, base.url);', 'jeton : une référence qui le contient n\'est pas résolue contre la vraie base'],
  [B, 'if (valeur.toLowerCase().includes(MARQUEUR)) return', 'if (valeur.includes(MARQUEUR)) return', 'jeton : la casse de la référence n\'est pas normalisée (l\'hôte est mis en minuscules)'],
  [B, "const MARQUEUR = randomBytes(6).toString('hex');", "const MARQUEUR = randomBytes(6).toString('hex').toUpperCase();", 'jeton : majuscules (l\'analyseur les change dans l\'hôte)'],

  // --- le compte des segments gardés
  [B, 'const m = Math.min(k - 1, remontees(valeur));', 'const m = Math.min(k - 1, remontees(valeur) - 1);', 'remontées : une de moins que nécessaire'],
  [B, 'const m = Math.min(k - 1, remontees(valeur));', 'const m = Math.min(k - 1, 1);', 'remontées : toujours une seule'],
  [B, 'const m = Math.min(k - 1, remontees(valeur));', 'const m = Math.min(k, remontees(valeur));', 'remontées : le fichier compté parmi les répertoires'],
  [B, '  let n = 1;\n  for (let i = 0; i < valeur.length; i++) {', '  let n = 0;\n  for (let i = 0; i < valeur.length; i++) {', 'remontées : sans le « plus un »'],
  [B, 'if (c === 47 || c === 92) n++;', 'if (c === 47) n++;', 'remontées : l\'antislash ne sépare pas'],
  [B, 'if (c === 47 || c === 92) n++;', 'if (c === 92) n++;', 'remontées : la barre ne sépare pas'],
  [B, 'const enTete = k - 1 - m;', 'const enTete = k - m;', 'segments de tête : un de trop dans le jeton de tête'],
  [B, 'const chemin = enTete > 0 ? [JETON_PREFIXE] : [];', 'const chemin = [JETON_PREFIXE];', 'segments de tête : jeton de tête même quand il n\'y en a aucun'],
  [B, 'const chemin = enTete > 0 ? [JETON_PREFIXE] : [];', 'const chemin = [];', 'segments de tête : jamais de jeton de tête'],
  [B, 'for (let j = enTete; j < k; j++) chemin.push', 'for (let j = enTete; j < k - 1; j++) chemin.push', 'segments gardés : le fichier (dernier segment) oublié'],
  [B, 'for (let j = enTete; j < k; j++) chemin.push', 'for (let j = enTete + 1; j < k; j++) chemin.push', 'segments gardés : le premier des gardés oublié'],

  // --- ce que la base copie dans le résultat
  [B, "    ? `${base.username ? JETON_UTILISATEUR : ''}${base.password ? `:${JETON_MOT_DE_PASSE}` : ''}@`\n    : '';", "    ? ''\n    : '';", 'identifiants : ceux de la base perdus'],
  [B, "${base.password ? `:${JETON_MOT_DE_PASSE}` : ''}@`", "@`", 'identifiants : le mot de passe de la base perdu'],
  [B, "`${base.username ? JETON_UTILISATEUR : ''}${base.password", "`${JETON_UTILISATEUR}${base.password", 'identifiants : un nom d\'utilisateur inventé quand la base n\'en a pas'],
  [B, "const port = base.url.port ? `:${base.url.port}` : '';", "const port = '';", 'port : celui de la base perdu'],
  [B, "if (base.requetePresente) requete = base.search === '' ? '?' : `?${JETON_REQUETE}`;", "if (false) requete = '';", 'requête : celle de la base perdue'],
  [B, "requete = base.search === '' ? '?' : `?${JETON_REQUETE}`;", "requete = '?';", 'requête : toujours vide'],
  [B, "requete = base.search === '' ? '?' : `?${JETON_REQUETE}`;", 'requete = `?${JETON_REQUETE}`;', 'requête : la requête vide devient un jeton'],
  [B, "this.requetePresente = (fragment < 0 ? href : href.slice(0, fragment)).includes('?');", "this.requetePresente = href.includes('?');", 'requête : cherchée aussi dans le fragment'],
  [B, "this.requetePresente = (fragment < 0 ? href : href.slice(0, fragment)).includes('?');", "this.requetePresente = url.search !== '';", 'requête : la requête vide n\'est pas reconnue'],

  // --- ce que le résultat rend à la base
  [B, 'this.#depuisBase = r.hostname === JETON_HOTE;', 'this.#depuisBase = true;', 'hôte : toujours celui de la base'],
  [B, 'this.#depuisBase = r.hostname === JETON_HOTE;', 'this.#depuisBase = false;', 'hôte : le jeton de l\'hôte jamais remis'],
  [B, "get hostname() { return this.#depuisBase ? this.#base.hostname : this.#r.hostname; }", 'get hostname() { return this.#r.hostname; }', 'hostname : le jeton fuit'],
  [B, "get host() { return this.#depuisBase ? this.#base.hostname + (this.#r.port ? `:${this.#r.port}` : '') : this.#r.host; }", "get host() { return this.#depuisBase ? this.#base.hostname : this.#r.host; }", 'host : sans le port'],
  [B, "get origin() { return this.#depuisBase ? `${this.#r.protocol}//${this.host}` : this.#r.origin; }", 'get origin() { return this.#r.origin; }', 'origin : le jeton fuit'],
  [B, "get username() { return this.#r.username === JETON_UTILISATEUR ? this.#base.username : this.#r.username; }", 'get username() { return this.#r.username; }', 'username : le jeton fuit'],
  [B, "get password() { return this.#r.password === JETON_MOT_DE_PASSE ? this.#base.password : this.#r.password; }", 'get password() { return this.#r.password; }', 'password : le jeton fuit'],
  [B, "get search() { return this.#r.search === `?${JETON_REQUETE}` ? this.#base.search : this.#r.search; }", 'get search() { return this.#r.search; }', 'search : le jeton fuit'],
  [B, "if (!this.#depuisBase) return this.#r.pathname;", "if (!this.#depuisBase) return this.#base.chemin;", 'pathname : le chemin de la base pour un autre hôte'],
  [B, 'this.#chemin ??= cheminReel(this.#r.pathname, this.#base, this.#enTete);', 'this.#chemin = cheminReel(this.#r.pathname, this.#base, this.#enTete + 1);', 'pathname : mauvais nombre de segments de tête'],
  [B, "if (!this.#depuisBase) return this.#r.href;", "if (!this.#depuisBase) return this.pathname;", 'href : sans tenir compte de l\'hôte'],
  [B, "${requetePresente ? this.search || '?' : ''}", "${requetePresente ? this.search : ''}", 'href : la requête vide perdue'],
  [B, "${fragment >= 0 ? r.hash || '#' : ''}", "${fragment >= 0 ? r.hash : ''}", 'href : le fragment vide perdu'],
  [B, "const identifiants = this.username || this.password ? `${this.username}${this.password ? `:${this.password}` : ''}@` : '';", "const identifiants = '';", 'href : sans les identifiants'],

  // --- le chemin du résultat et son plafond
  [B, 'if (longueur > PLAFOND_CHEMIN) return CHEMIN_TROP_LONG;', 'if (longueur >= PLAFOND_CHEMIN) return CHEMIN_TROP_LONG;', 'plafond : exclusif'],
  [B, 'if (longueur > PLAFOND_CHEMIN) return CHEMIN_TROP_LONG;', 'if (false) return CHEMIN_TROP_LONG;', 'plafond : jamais appliqué'],
  [B, 'let longueur = segments.length - 1;', 'let longueur = segments.length;', 'plafond : un séparateur de trop'],
  [B, 'let longueur = segments.length - 1;', 'let longueur = segments.length - 2;', 'plafond : un séparateur de moins'],
  [B, 'if (s === JETON_PREFIXE) longueur += sommes[enTete];', 'if (s === JETON_PREFIXE) longueur += 0;', 'plafond : le préfixe non mesuré'],
  [B, 'else if (s.startsWith(DEBUT_JETON_SEGMENT)) longueur += partes[indice(s)].length;', 'else if (s.startsWith(DEBUT_JETON_SEGMENT)) longueur += 0;', 'plafond : les segments gardés non mesurés'],
  [B, 'else longueur += s.length;', 'else longueur += 0;', 'plafond : les segments de la référence non mesurés'],
  [B, 'for (let i = 1; i <= partes.length; i++) sommes[i] = sommes[i - 1] + partes[i - 1].length + (i > 1 ? 1 : 0);', 'for (let i = 1; i <= partes.length; i++) sommes[i] = sommes[i - 1] + partes[i - 1].length + 1;', 'plafond : jonction du préfixe comptée avec un séparateur de trop pour le premier segment'],
  [B, 'for (let i = 1; i <= partes.length; i++) sommes[i] = sommes[i - 1] + partes[i - 1].length + (i > 1 ? 1 : 0);', 'for (let i = 1; i <= partes.length; i++) sommes[i] = sommes[i - 1] + partes[i - 1].length;', 'plafond : jonction du préfixe sans aucun séparateur'],
  [B, "export const CHEMIN_TROP_LONG = '/%00chemin-trop-long';", "export const CHEMIN_TROP_LONG = '/chemin-trop-long';", 'plafond : le chemin de remplacement peut désigner un fichier'],
  [B, 'if (this.prefixes.size >= 8) this.prefixes.clear();', 'if (false) this.prefixes.clear();', 'mémoire : préfixes gardés sans borne'],
  [B, 'const partes = this.chemin.slice(1).split(\'/\');', 'const partes = this.chemin.split(\'/\');', 'segments : le premier, vide, gardé'],
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de la résolution', fichiers: TESTS }],
  exigerChromium: false,
  partie,
});
