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
      // Le représentant du groupe doit être le pire cas, pas le premier
      // fichier rencontré dans l'ordre de parcours — un tirage au sort de cet
      // ordre n'a pas de raison de refléter la gravité. À sévérité égale (cas
      // le plus fréquent, la sévérité étant déjà uniforme par règle), l'ordre
      // de parcours départage, ce qui reste stable et déterministe.
      const pire = [...constatsRegle].sort((a, b) => SEVERITES[b.severite].rang - SEVERITES[a.severite].rang)[0];
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
        // Le titre d'un constat individuel embarque parfois une mesure propre
        // à cette seule occurrence (ex. A-FONC-02 : « Complexité cyclomatique
        // de 62 »). Affiché à côté du décompte d'occurrences du groupe (« 68
        // occurrences »), les deux nombres se lisent à tort comme une seule
        // série. Qualifier explicitement évite l'ambiguïté sans changer le
        // titre lui-même.
        titre: (pire?.titre ?? d.regle) + (d.occurrences > 1 ? ' (pire cas)' : ''),
        gainGlobalEstime: Math.round(((gainAxe * axe.poids) / poidsTotal) * 10) / 10,
        effortEstime: null, // pas encore de données : à charge du consommateur d'afficher « non estimé »
        hotes: [...new Set(constatsRegle.flatMap(hotesDe))],
        concerneAussi: [],
      });
    }
  }

  // Passe purement additive, après coup : deux étapes qui citent le même
  // hôte externe parlent probablement de la même dépendance (ex. vendoriser
  // une police corrige à la fois la requête réseau, le README qui ne la
  // documente pas, et le service non souverain). On le DIT — « concerne
  // aussi » — sans jamais promettre que corriger l'une élimine les autres :
  // ce n'est pas garanti en général (documenter un service ne le rend pas
  // souverain). Ne change ni le tri ni aucun score, uniquement une
  // métadonnée en plus sur des entrées déjà calculées.
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const partages = items[i].hotes.filter((h) => items[j].hotes.includes(h));
      for (const hote of partages) {
        items[i].concerneAussi.push({ regle: items[j].regle, axe: items[j].axe, hote });
        items[j].concerneAussi.push({ regle: items[i].regle, axe: items[i].axe, hote });
      }
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

/**
 * Hôte(s) externe(s) qu'un constat identifie explicitement, quand la règle
 * qui l'a produit l'expose. Deux formes coexistent selon que la règle pousse
 * un constat par hôte (`preuve.hote`, ex. F-SOUV-01, D-RESEAU-01) ou un seul
 * constat pour plusieurs hôtes (`preuve.hotes`, ex. B-DOC-04). Ni l'un ni
 * l'autre n'est garanti présent : une règle qui n'identifie pas d'hôte
 * précis ne contribue simplement à aucun regroupement.
 */
function hotesDe(constat) {
  const p = constat.preuve;
  if (!p) return [];
  if (typeof p.hote === 'string') return [p.hote];
  if (Array.isArray(p.hotes)) return p.hotes;
  return [];
}
