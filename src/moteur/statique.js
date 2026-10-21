/**
 * Exécute l'ensemble des règles statiques (axes A, B, C, E, F) sur un
 * contexte déjà construit, et retourne la liste plate des constats.
 * L'axe D (dynamique) est orchestré séparément : il a besoin d'un navigateur.
 */
import { reglesA } from '../regles/a-qualite.js';
import { reglesB } from '../regles/b-lisibilite.js';
import { analyserMinifie } from '../regles/b-minifie.js';
import { reglesC } from '../regles/c-securite.js';
import { reglesE } from '../regles/e-dependances.js';
import { reglesF } from '../regles/f-conformite.js';
import { analyserSurface } from '../regles/c-surface.js';
import { analyserIllisibles } from '../regles/c-illisibles.js';
import { mentionsParLigne } from './analyse-js.js';
import { constat } from './modele.js';

// Règles dont l'emplacement est une balise de la page et non du code : elles disent elles-mêmes ce que la page a de particulier (gabarit, standard seul).
const REGLES_DE_PAGE = new Set(['C-EXFIL-03', 'C-DOM-01', 'C-DOM-02', 'C-CSP-01', 'C-CSP-02']);

/**
 * Un constat sur du code que le navigateur n'exécute pas tel quel (script d'un
 * `<template>`, module lu par le seul standard) doit le dire, sans quoi le
 * lecteur croit à une exécution immédiate. On ne l'ajoute que si toutes les
 * unités qui couvrent sa ligne en portent la même mention.
 */
function ajouterMentions(ctx, constats) {
  const parChemin = new Map(ctx.fichiers.map((f) => [f.chemin, f]));
  const mentions = new Map();
  for (const c of constats) {
    if (!c.fichier || !c.ligne || c.axe === 'E' || c.axe === 'F' || REGLES_DE_PAGE.has(c.regle)) continue;
    const fichier = parChemin.get(c.fichier);
    if (!fichier) continue;
    if (!mentions.has(c.fichier)) mentions.set(c.fichier, mentionsParLigne(fichier));
    const mention = mentions.get(c.fichier)(c.ligne);
    if (mention && !c.constat.includes(mention)) c.constat = `${c.constat} Précision : ${mention}.`;
  }
}

// Même test que `e-dependances.js`, qui ne lance `npm audit` que sur un dépôt qui verrouille ses dépendances.
const VERROU_DE_DEPENDANCES = /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

/**
 * `--sans-reseau` : `npm audit` (E-VULN-01) n'a pas été lancé. Pour un dépôt qui verrouille ses dépendances, l'axe E est vu en
 * partie, non propre : sans ce constat, un E à 100 se lisait comme « aucune vulnérabilité connue ». Même statut qu'un `npm audit` en échec (E-VULN-00).
 */
function constatsSansReseau(ctx) {
  if (!ctx.fichiers.some((f) => VERROU_DE_DEPENDANCES.test(f.chemin))) return [];
  return [constat({
    regle: 'E-VULN-OPTION', axe: 'E', severite: 'info', confiance: 'certain', mesurePartielle: true,
    titre: 'Recherche de vulnérabilités connues non lancée : option --sans-reseau',
    constat: "L'audit a été lancé avec --sans-reseau : `npm audit` n'a pas interrogé le registre npm, les dépendances verrouillées du dépôt n'ont donc pas été comparées aux avis de vulnérabilité publiés.",
    impact: "L'axe E est noté sans cette vérification. L'absence de constat de vulnérabilité ne vaut pas absence de vulnérabilité : c'est une absence de mesure ; le verdict ne peut pas être « CONFORME » sans elle.",
    remediation: "Relancer sans --sans-reseau depuis un poste qui atteint registry.npmjs.org (derrière un proxy d'entreprise, HTTP(S)_PROXY).",
  })];
}

export async function analyseStatique(ctx, options = {}) {
  const constats = [];
  // C avant B : B-DOC-03/04 lisent ctx.usagesGrist et ctx.destinationsExternes,
  // que seul l'axe C renseigne (voir analyserAccesGrist / analyserSortiesReseau).
  for (const regle of [...reglesA, ...reglesC, ...reglesB, analyserMinifie, ...reglesF]) {
    constats.push(...regle(ctx));
  }
  // Ce que l'outil n'a pas pu lire se dit en dernier, avec les axes qu'il empêche de mesurer : le budget des arêtes de document
  // ne se sait épuisé qu'une fois les graphes de document demandés (par les règles de C, puis celles de E).
  for (const regle of reglesE) {
    const r = await regle(ctx, options);
    constats.push(...(r ?? []));
  }
  if (options.reseau === false) constats.push(...constatsSansReseau(ctx));
  constats.push(...analyserSurface(ctx));
  constats.push(...analyserIllisibles(ctx));
  ajouterMentions(ctx, constats);
  return constats;
}
