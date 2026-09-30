/**
 * Exécute l'ensemble des règles statiques (axes A, B, C, E, F) sur un
 * contexte déjà construit, et retourne la liste plate des constats.
 * L'axe D (dynamique) est orchestré séparément : il a besoin d'un navigateur.
 */
import { reglesA } from '../regles/a-qualite.js';
import { reglesB } from '../regles/b-lisibilite.js';
import { reglesC } from '../regles/c-securite.js';
import { reglesE } from '../regles/e-dependances.js';
import { reglesF } from '../regles/f-conformite.js';
import { analyserSurface } from '../regles/c-surface.js';
import { analyserIllisibles } from '../regles/c-illisibles.js';
import { mentionsParLigne } from './analyse-js.js';

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

export async function analyseStatique(ctx, options = {}) {
  const constats = [];
  // C avant B : B-DOC-03/04 lisent ctx.usagesGrist et ctx.destinationsExternes,
  // que seul l'axe C renseigne (voir analyserAccesGrist / analyserSortiesReseau).
  for (const regle of [...reglesA, ...reglesC, ...reglesB, ...reglesF]) {
    constats.push(...regle(ctx));
  }
  // Ce que l'outil n'a pas pu lire se dit en dernier, avec les axes qu'il empêche de mesurer : le budget des arêtes de document
  // ne se sait épuisé qu'une fois les graphes de document demandés (par les règles de C, puis celles de E).
  for (const regle of reglesE) {
    const r = await regle(ctx, options);
    constats.push(...(r ?? []));
  }
  constats.push(...analyserSurface(ctx));
  constats.push(...analyserIllisibles(ctx));
  ajouterMentions(ctx, constats);
  return constats;
}
