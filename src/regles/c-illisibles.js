/**
 * Ce que l'outil ne sait pas lire : le code que le navigateur exécute et qu'aucune règle n'a pu lire.
 *
 * Un code que personne n'a lu peut contenir ce que les règles cherchent : un audit qui ne sait pas le lire ne peut pas le
 * déclarer conforme, et un widget qui s'arrange pour que l'outil ne le lise pas ne note jamais mieux que s'il s'était laissé
 * lire. La syntaxe qu'acorn refuse (TypeScript, JSX que la page charge), l'imbrication que la pile de l'analyse ne porte pas, un
 * parcours qui déborde et une règle qui échoue sur un code piégé sont donc un constat critique et BLOQUANT par fichier (ou par
 * script de page), qui dit lequel et pourquoi, et qui empêche les axes que ce code aurait nourris (`axesEmpeches`, les mêmes
 * que ceux d'un fichier non lu : `axesDUnFichierNonLu`, C-SURFACE-02). Un fichier qu'aucune page n'exécute est une information
 * groupée, et un fichier que seule une carte d'import désigne (peut-être de la donnée) aussi.
 *
 * Ce passage tourne APRÈS toutes les règles (`analyseStatique`) : c'est `pourChaqueUniteJs` qui relève, dans `ctx.illisibles`,
 * ce que chaque règle n'a pas pu lire.
 */
import { constat } from '../moteur/modele.js';
import { axesDUnFichierNonLu, MAX_FICHIERS_DITS, TOUS_LES_AXES_STATIQUES, nombre } from './c-surface.js';

/** Ce que chaque cause d'illisible dit : la lecture qui a échoué, et comment y remédier. */
const CAUSES_ILLISIBLE = {
  syntaxe: {
    constat: (n) => `L'analyseur de code de l'outil (acorn, la syntaxe ECMAScript la plus récente) ne lit pas ce code : ${n.message}${n.ligne ? ` (ligne ${n.ligne}${n.colonne ? `, colonne ${n.colonne}` : ''})` : ''}. Ce que le navigateur en exécute n'est lu par aucune règle : ni injection, ni sortie réseau, ni secret, ni dépendance, ni conformité. L'axe D ne le voit que s'il s'exécute pendant l'observation.`,
    remediation: "Publier le code sous une forme que l'analyse lit (JavaScript valide, sans TypeScript ni JSX non compilé), ou le retirer des pages qui le chargent.",
  },
  profondeur: {
    constat: (n) => `Ce code est imbriqué plus profondément que ce que l'outil sait parcourir : sa pile déborde${n.ligne ? ` (ligne ${n.ligne})` : ''}. S'il s'exécute dans le navigateur, aucune règle ne l'a lu.`,
    remediation: "Découper l'expression trop imbriquée, ou publier les sources non minifiées, pour que l'analyse les lise.",
  },
  analyse: {
    constat: (n) => `L'analyse de ce code s'est interrompue sur une erreur (${n.message}) : ce que les règles en disent est incomplet.`,
    remediation: "Signaler l'erreur avec ce rapport ; tant qu'elle n'est pas corrigée, ce code n'est pas audité.",
  },
};

const IMPACT_ILLISIBLE = "Un code que personne n'a lu peut contenir n'importe quoi, y compris ce que les règles cherchent : un audit qui ne sait pas le lire ne peut pas le déclarer conforme.";

/**
 * Le code de la surface qu'aucune règle n'a pu lire (`ctx.illisibles`, relevé par `pourChaqueUniteJs` : la lecture qu'acorn refuse, le
 * parcours qui déborde la pile, la règle qui échoue sur ce code). Un par unité (un fichier, ou un script de page), les cinquante premiers
 * un à un et les autres groupés, comme les fichiers non lus ; ce qu'aucune page n'exécute est une information groupée.
 */
export function analyserIllisibles(ctx) {
  const tous = [...(ctx.illisibles?.values() ?? [])].sort((a, b) => (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : (a.ligne ?? 0) - (b.ligne ?? 0)));
  const code = tous.filter((n) => n.surface && !n.facultative);
  const probables = tous.filter((n) => n.facultative);
  const hors = tous.filter((n) => !n.surface && !n.facultative);
  const constats = [];
  for (const n of code.slice(0, MAX_FICHIERS_DITS)) {
    const cause = CAUSES_ILLISIBLE[n.cause];
    constats.push(constat({
      regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
      titre: n.inline ? 'Script de la page que l\'outil ne sait pas lire' : 'Fichier de code que l\'outil ne sait pas lire',
      fichier: n.chemin, ...(n.ligne ? { ligne: n.ligne } : {}),
      constat: cause.constat(n),
      impact: IMPACT_ILLISIBLE,
      remediation: cause.remediation,
      axesEmpeches: axesDUnFichierNonLu(n),
      preuve: { cause: n.cause, message: n.message, ligne: n.ligne, colonne: n.colonne, inline: n.inline },
    }));
  }
  if (code.length > MAX_FICHIERS_DITS) {
    const reste = code.slice(MAX_FICHIERS_DITS);
    const axes = TOUS_LES_AXES_STATIQUES.filter((a) => reste.some((n) => axesDUnFichierNonLu(n).includes(a)));
    constats.push(constat({
      regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
      titre: reste.length === 1 ? '1 autre code que l\'outil ne sait pas lire' : `${nombre(reste.length)} autres codes que l'outil ne sait pas lire`,
      constat: `${nombre(code.length)} codes exécutés par le navigateur n'ont pu être lus ; les ${MAX_FICHIERS_DITS} premiers sont dits un à un, ceux-ci sont les ${nombre(reste.length)} autres (leur liste, avec la cause de chacun, est dans la preuve du rapport JSON).`,
      impact: IMPACT_ILLISIBLE,
      remediation: [...new Set(reste.map((n) => CAUSES_ILLISIBLE[n.cause].remediation))].join(' '),
      axesEmpeches: axes,
      preuve: { emplacements: reste.map((n) => ({ fichier: n.chemin, ligne: n.ligne, cause: n.cause, message: n.message })) },
    }));
  }
  if (probables.length) {
    constats.push(constat({
      regle: 'C-SURFACE-03', axe: 'C', severite: 'info', confiance: 'certain',
      titre: probables.length === 1 ? '1 fichier désigné par une carte d\'import que l\'outil ne lit pas comme du code' : `${nombre(probables.length)} fichiers désignés par une carte d'import que l'outil ne lit pas comme du code`,
      constat: `Une carte d'import désigne ${probables.map((n) => n.chemin).slice(0, 5).join(', ')}${probables.length > 5 ? '…' : ''}, dont le contenu n'est pas du JavaScript que l'analyse lit, et aucun code que l'outil a lu ne l'importe sans type de données. Ce peut être de la donnée (importée avec \`with { type: 'css' }\` par exemple), ou du code que l'outil ne sait pas lire et que le navigateur importe d'une façon qu'il ne suit pas (un nom calculé : \`import(nom)\`).`,
      impact: "Si un module importe ce fichier sans type de données, le navigateur l'exécute, et aucune règle ne l'a lu.",
      remediation: "Vérifier que le widget n'importe ce fichier que comme donnée (`with { type: 'json' }` ou `'css'`), ou le publier en JavaScript lisible.",
      preuve: { emplacements: probables.map((n) => ({ fichier: n.chemin, cause: n.cause, message: n.message })) },
    }));
  }
  if (hors.length) {
    constats.push(constat({
      regle: 'C-SURFACE-03', axe: 'C', severite: 'info', confiance: 'certain',
      titre: `${nombre(hors.length)} fichier(s) que l'analyse n'a pas pu parcourir et que le widget n'exécute pas`,
      constat: `${nombre(hors.length)} fichier(s) dont l'analyse s'est interrompue sur une erreur, et qu'aucune page ne charge comme du code : ${hors.slice(0, 5).map((n) => `${n.chemin} (${n.message})`).join(', ')}${hors.length > 5 ? '…' : ''}.`,
      impact: "Ce que les règles en disent est incomplet ; le navigateur ne les exécute pas.",
      remediation: 'Retirer du dépôt les fichiers que le widget ne charge pas.',
      preuve: { emplacements: hors.map((n) => ({ fichier: n.chemin, cause: n.cause, message: n.message })) },
    }));
  }
  return constats;
}
