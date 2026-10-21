/**
 * B-MIN-01 : du code minifié, dont personne ne peut dire ce qu'il est.
 *
 * Les axes A et B ne jugent pas un fichier minifié (`f.vendorise`) : sa qualité et sa lisibilité ne se lisent pas. Sans cette règle, un widget dont le code
 * propre est livré en `app.min.js` noterait mieux que le même code lisible. Un seul constat par dépôt, qui plafonne la note globale (voir `plafonneLaNote`).
 *
 * Le cas doux est une bibliothèque tierce que son en-tête identifie (version et licence) : elle est suivie par l'axe E (E-DEP-02, en information) et n'est
 * pas plafonnée. Le code reste, dans tous les cas, pleinement analysé en sécurité (C, D).
 */
import { constat } from '../moteur/modele.js';
import { enTeteIdentifiee } from '../moteur/minifie.js';

/** Le nombre de fichiers que le constat nomme : quelques-uns, pas les milliers d'un dépôt hostile. */
const MAX_NOMMES = 5;

/** Un fichier exécuté, minifié, dont l'en-tête n'en fait pas une bibliothèque identifiée : celui que B-MIN-01 dit, et que E-DEP-02 ne redit pas. */
export const minifieSansOrigine = (f) => Boolean(f.minifie && f.executee && !enTeteIdentifiee(f.contenu));

export function analyserMinifie(ctx) {
  const fichiers = ctx.fichiers.filter(minifieSansOrigine);
  if (!fichiers.length) return [];
  const nommes = fichiers.slice(0, MAX_NOMMES).map((f) => f.chemin);
  const autres = fichiers.length - nommes.length;
  return [constat({
    regle: 'B-MIN-01', axe: 'B', severite: 'majeur', confiance: 'probable', plafonneLaNote: true,
    titre: fichiers.length === 1 ? `Code minifié sans origine identifiée : ${nommes[0]}` : `Code minifié sans origine identifiée dans ${fichiers.length} fichiers`,
    fichier: nommes[0],
    constat: `${fichiers.length === 1 ? 'Ce fichier exécuté est' : 'Ces fichiers exécutés sont'} du code minifié (lignes très longues faites de code) : ${nommes.join(', ')}${autres > 0 ? ` et ${autres} autre${autres > 1 ? 's' : ''}` : ''}. Leur en-tête ne donne ni version ni licence qui en feraient une bibliothèque tierce identifiée.`,
    impact: "Personne ne peut relire ce code ni vérifier qu'il correspond à des sources : sa qualité et sa lisibilité (axes A et B) ne sont pas jugées. Pour qu'un code propre livré minifié ne note pas mieux que le même code lisible, la note globale est plafonnée sous le seuil de « CONFORME ». Le code reste analysé en sécurité (axes C et D).",
    remediation: "Livrer le code source lisible avec la façon de le construire. Pour une bibliothèque tierce, garder son en-tête d'origine (nom, version, licence) : elle est alors suivie comme une dépendance (axe E) et n'est plus plafonnée.",
    preuve: { fichiers: nommes, total: fichiers.length },
    referentiels: ['ANSSI — Maîtrise du code tiers', 'Décret n° 2021-1559 (code source et transparence)'],
  })];
}
