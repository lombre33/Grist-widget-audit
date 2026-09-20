/**
 * Ordonnancement des corrections — la question « par où commencer ? » posée
 * à un widget déjà audité, pas un nouvel axe ni un nouveau calcul de score.
 *
 * Trois critères, dans cet ordre, jamais mélangés en une seule note :
 *  1. bloquant d'abord — un point bloquant conditionne le verdict, il n'attend
 *     jamais derrière un score plus élevé ailleurs (même logique qu'un avis
 *     RSSI dans `noter()`) ;
 *  2. le poids réel dans la note globale, PAS la sévérité seule — corriger une
 *     règle qui pèse 25 points sur l'axe C (poids 25/100) rapporte plus que
 *     corriger une règle de même sévérité sur l'axe F (poids 5/100), et une
 *     règle déjà amortie par de nombreuses occurrences (`facteurOccurrences`)
 *     a moins à gagner qu'une règle fraîche de même sévérité ;
 *  3. le coût de correction, seulement quand il est connu — sert de
 *     départage, jamais de priorité : on ne fait pas passer une correction
 *     bon marché mais négligeable devant un point bloquant.
 */
import { SEVERITES } from './modele.js';
import { noterAxe } from './notation.js';

/**
 * @param {ReturnType<typeof import('./notation.js').noter>} notation
 * @returns {Array} une entrée par (axe, règle) déclenchée, triée du premier
 *   au dernier geste à faire. Ne modifie ni les constats ni la notation.
 */
export function ordonnancerCorrections(notation) {
  const axesNotes = Object.values(notation.parAxe).filter((a) => !a.nonExecute);
  const poidsTotal = axesNotes.reduce((s, a) => s + a.poids, 0) || 1;

  const items = [];
  for (const axe of axesNotes) {
    for (const d of axe.detailPenalites) {
      const constatsRegle = axe.constats.filter((c) => c.regle === d.regle);
      const scoreSansCetteRegle = noterAxe(Math.max(0, axe.penaliteBrute - d.penalite));
      const gainAxe = scoreSansCetteRegle - axe.score;
      items.push({
        regle: d.regle,
        axe: axe.code,
        titreAxe: axe.titre,
        severite: d.severite,
        occurrences: d.occurrences,
        bloquant: constatsRegle.some((c) => c.bloquant),
        fichiers: [...new Set(constatsRegle.map((c) => c.fichier).filter(Boolean))],
        titre: constatsRegle[0]?.titre ?? d.regle,
        gainGlobalEstime: Math.round(((gainAxe * axe.poids) / poidsTotal) * 10) / 10,
        effortEstime: null, // pas encore de données : à charge du consommateur d'afficher « non estimé »
      });
    }
  }

  items.sort((a, b) =>
    Number(b.bloquant) - Number(a.bloquant) ||
    b.gainGlobalEstime - a.gainGlobalEstime ||
    SEVERITES[b.severite].rang - SEVERITES[a.severite].rang ||
    a.regle.localeCompare(b.regle)
  );

  return items;
}
