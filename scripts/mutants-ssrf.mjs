#!/usr/bin/env node
/**
 * Rejoue les mutants de la validation des cibles de clonage de `bin/gwaudit.js`
 * (`validerHoteClone` et ce qui l'entoure) : chacun réintroduit un défaut que
 * `tests/ssrf.test.mjs` doit voir : littéral IPv6 (crochets, IPv4 inscrit,
 * plages) échappant au contrôle, refus de cible sorti comme une erreur interne
 * (méthode : `scripts/lib/rejouer-mutants.mjs`).
 *
 * Aucun Chromium n'est nécessaire.
 * Usage : node scripts/mutants-ssrf.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, DOSSIERS_COPIES } from './lib/rejouer-mutants.mjs';

const B = 'bin/gwaudit.js';
const TESTS = ['tests/ssrf.test.mjs'];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- littéral IPv6
  [B, ".hostname.replace(/^\\[(.*)\\]$/, '$1');", '.hostname;', 'IPv6 : les crochets cachent le littéral'],
  [B, 'if (inscrit) {', 'if (false) {', 'IPv6 : IPv4 inscrit (::ffff:a.b.c.d) non décodé'],
  [B, '/^fe[89ab][0-9a-f]:/.test(a)', "a.startsWith('fe80:')", 'IPv6 : lien-local réduit à fe80::'],
  [B, "a === '::' || ", '', "IPv6 : l'adresse non spécifiée « :: » passe"],
  [B, '/^f[cd][0-9a-f]{2}:/.test(a)', "a.startsWith('fd')", 'IPv6 : adresses locales uniques fc00::/7 réduites à fd'],

  // --- un refus n'est pas une panne
  [B, 'process.exitCode = 4; return; }', 'process.exitCode = 3; return; }', 'refus : code 3 au lieu de 4'],
  [B, 'if (e instanceof CibleRefusee) {', 'if (false) {', 'refus : la pile de Node sort'],
  [B, 'throw new CibleRefusee(expliquerEchecClonage(cible, e));', 'throw e;', 'clonage en échec : erreur brute'],
  [B, 'throw new CibleRefusee(`chemin introuvable', 'throw new Error(`chemin introuvable', 'chemin introuvable : erreur interne'],
];
const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants[0] ? new RegExp(restants[0]) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests ssrf', fichiers: TESTS }],
  exigerChromium: false,
  partie,
  dossiers: [...DOSSIERS_COPIES, 'bin', 'ressources'],
});
