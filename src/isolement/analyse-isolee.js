/**
 * L'analyse statique d'un dépôt dans un processus enfant à limite (enfant.js), et le repli
 * quand elle ne finit pas. Ce que `bin/gwaudit.js` appelle à la place de
 * `construireContexte` + `analyseStatique` : mêmes constats quand tout va bien (comparés
 * dans tests/analyse-isolee.test.mjs), un rapport de repli sinon, jamais une sortie 3.
 */
import { fileURLToPath } from 'node:url';
import { contexteDepuisResume } from '../contexte/resume.js';
import { ErreurLancement, executerEnEnfant } from './enfant.js';
import { constatInterruption } from './repli.js';

const TRAVAIL = fileURLToPath(new URL('./travail-analyse.js', import.meta.url));

/**
 * @param {{racine: string, reseau: boolean, limites: {limiteMo: ?number, pileMo: ?number, delaiMs: ?number}, relayerStderr?: any, env?: object}} o
 * @returns {Promise<{ok: boolean, constats: Array, ctx: ?object, interruption: ?object, mesures: ?{rssMaxMo: number}}>}
 *   `ctx` : le contexte que les rapports et l'axe D lisent (src/contexte/resume.js), null si l'enfant est mort avant
 *   la fin de l'inventaire ; `interruption` : la cause, quand `ok` est faux.
 * @throws {ErreurLancement} si l'enfant n'a pas pu être lancé, ou s'il est mort avant d'avoir annoncé sa première étape : il
 *   n'avait alors encore rien lu du dépôt, le widget n'y est pour rien, et c'est une panne de l'outil ou de son environnement
 *   (un module qui ne se charge pas, une option de Node refusée, un noyau qui tue au démarrage) : sortie 3, pas un rapport de repli.
 */
export async function analyserEnEnfant({ racine, reseau, limites, relayerStderr, env, module = TRAVAIL }) {
  const r = await executerEnEnfant({ module, entree: { racine, reseau }, ...limites, ...(relayerStderr === undefined ? {} : { relayerStderr }), ...(env ? { env } : {}) });
  if (r.termine) return { ok: true, constats: r.resultat.constats, ctx: contexteDepuisResume(r.resultat.contexte), interruption: null, mesures: r.mesures };
  if (!r.cause.etape) {
    throw new ErreurLancement(`le processus d'analyse s'est arrêté avant de commencer (${r.cause.raison})${r.cause.fin ? ` : ${r.cause.fin}` : ''}`);
  }
  return { ok: false, constats: [constatInterruption(r.cause, r.partiel)], ctx: r.partiel ? contexteDepuisResume(r.partiel) : null, interruption: r.cause, mesures: r.mesures };
}
