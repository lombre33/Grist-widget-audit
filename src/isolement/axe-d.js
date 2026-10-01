/**
 * L'axe D d'un audit dont l'analyse du code a été menée dans un enfant (analyse-isolee.js) :
 *  - l'analyse a abouti : l'axe D joue sur le contexte qu'elle a rendu, comme avant ;
 *  - elle s'est interrompue APRÈS l'inventaire : le résumé du contexte sorti avant la mort suffit à jouer l'axe D
 *    (point d'entrée, racine, README), et D-PERIMETRE-01 dit que le niveau d'accès demandé n'a pas pu être lu ;
 *  - elle s'est interrompue AVANT la fin de l'inventaire : il n'y a pas de point d'entrée, l'axe D n'a rien à
 *    ouvrir. Il est dit non exécuté (D-INDISPONIBLE, hors du calcul de la note), jamais passé sous silence.
 */
import { auditDynamique } from '../runtime/dynamique.js';
import { constatAxeDInterrompu, preciserConstatsDeLAxeD } from './repli.js';

/**
 * @param {{ok: boolean, ctx: ?object, interruption: ?object}} analyse  ce que `analyserEnEnfant` a rendu
 * @param {object} [options] transmises à `auditDynamique` (`scenario`)
 * @returns {Promise<{constats: Array, nonExecute?: boolean, joue: boolean}>} `joue` : l'axe D a-t-il ouvert le widget dans le navigateur
 */
export async function auditerAxeD(analyse, options = {}) {
  if (!analyse.ctx) return { constats: [constatAxeDInterrompu(analyse.interruption)], nonExecute: true, joue: false };
  const resultat = await auditDynamique(analyse.ctx, options);
  if (!analyse.ok) preciserConstatsDeLAxeD(resultat.constats, analyse.ctx);
  return { ...resultat, joue: true };
}
