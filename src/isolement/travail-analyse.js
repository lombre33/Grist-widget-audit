/**
 * Le travail que `bin/gwaudit.js` confie à l'enfant (voir enfant.js) : construire le
 * contexte du dépôt puis lancer les règles statiques (axes A, B, C, E, F). C'est ce qui
 * lit le code du widget, donc ce qu'un widget hostile peut faire tomber.
 *
 * Écrit en deux temps (voir src/contexte/resume.js) : le résumé du contexte sort dès que
 * l'inventaire est fait, pour que l'axe D puisse tourner même si les règles ne finissent pas.
 */
import { construireContexte, raisonsDeTroncature } from '../contexte/inventaire.js';
import { resumerContexte } from '../contexte/resume.js';
import { analyseStatique } from '../moteur/statique.js';

export const ETAPE_INVENTAIRE = 'inventaire';
export const ETAPE_REGLES = 'regles';

/**
 * @param {{racine: string, reseau: boolean}} entree
 * @param {{etape: (nom: string) => void, partiel: (objet: object) => void}} rappels
 * @returns {Promise<{constats: Array, contexte: object}>}
 */
export async function executer({ racine, reseau }, { etape, partiel }) {
  etape(ETAPE_INVENTAIRE);
  console.error(`→ Inventaire du dépôt : ${racine}`);
  const ctx = construireContexte(racine);
  console.error(`  ${ctx.fichiers.length} fichier(s), ${ctx.surface.size} dans la surface exécutée, point(s) d'entrée : ${ctx.entrees.join(', ') || '(aucun)'}`);
  if (ctx.tronque) {
    console.error(`  ⚠ Inventaire tronqué (dépôt anormalement volumineux) : ${raisonsDeTroncature(ctx.tronque).join(', ')} — le rapport porte sur une partie du dépôt seulement.`);
  }
  partiel(resumerContexte(ctx));

  etape(ETAPE_REGLES);
  console.error('→ Analyse statique (axes A, B, C, E, F)…');
  const constats = await analyseStatique(ctx, { reseau });
  return { constats, contexte: resumerContexte(ctx) };
}
