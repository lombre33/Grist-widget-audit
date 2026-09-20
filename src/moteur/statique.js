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

export async function analyseStatique(ctx, options = {}) {
  const constats = [];
  // C avant B : B-DOC-03/04 lisent ctx.usagesGrist et ctx.destinationsExternes,
  // que seul l'axe C renseigne (voir analyserAccesGrist / analyserSortiesReseau).
  for (const regle of [...reglesA, ...reglesC, ...reglesB, ...reglesF]) {
    constats.push(...regle(ctx));
  }
  for (const regle of reglesE) {
    const r = await regle(ctx, options);
    constats.push(...(r ?? []));
  }
  return constats;
}
