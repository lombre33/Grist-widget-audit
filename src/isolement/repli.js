/**
 * Les constats du rapport de repli : ce que le parent écrit quand l'analyse statique, menée
 * dans un enfant (enfant.js), ne s'est pas terminée. Le widget en est la cause ou non — un
 * fichier trop lourd, une structure qui épuise la pile —, mais dans les deux cas une mesure
 * manque, et un audit qui n'a pas tout lu ne peut pas déclarer conforme ce qu'il n'a pas lu :
 * le constat est bloquant et note à 0 les axes que l'analyse alimente (`axesEmpeches`).
 *
 * C'est le constat « illisible » de la surface, C-SURFACE-03 (un fichier ou un script que l'audit
 * n'a pas su lire), avec une cause de plus, `interruption`, qui couvre l'abandon de V8, la mort par
 * le noyau, le délai, une erreur interne et un résultat incomplet ; la raison exacte est dans
 * `preuve.message`. Construit ici, avec les fonctions du moteur, pour ne rien changer aux fichiers
 * de src/moteur ni de src/rapport : la règle qui pose les autres causes (syntaxe, profondeur,
 * analyse) est celle du chantier de la notation, et les deux partagent le même numéro.
 *
 * Le nom du plus gros fichier de code est choisi par le widget : un nom peut porter des guillemets inversés, une balise, un retour à la ligne ou un
 * caractère d'échappement, et le Markdown n'échappe aucun texte de constat. Il est cité par `citer` (src/moteur/texte-du-widget.js), comme le texte
 * que les règles empruntent au widget ; un nom honnête (`app.js`) s'écrit comme avant.
 */
import { constat } from '../moteur/modele.js';
import { citer } from '../moteur/texte-du-widget.js';
import { ETAPE_INVENTAIRE, ETAPE_REGLES } from './travail-analyse.js';

/** Les axes que l'analyse statique alimente : sans elle, aucun n'est mesuré. */
export const AXES_DE_L_ANALYSE = ['A', 'B', 'C', 'E', 'F'];

const LIBELLE_ETAPE = {
  [ETAPE_INVENTAIRE]: "la construction de l'inventaire du dépôt",
  [ETAPE_REGLES]: "l'exécution des règles sur le code",
};
// Les fins qui tiennent à la taille ou à la structure de ce qui était lu : nommer le plus gros fichier de code aide à trouver quoi alléger.
const GENRES_DE_TAILLE = new Set(['tas', 'abandon', 'noyau', 'delai']);

const mio = (octets) => `${(octets / 1048576).toFixed(1).replace('.', ',')} Mio`;

/**
 * @param {{genre: string, raison: string, etape: ?string, code: ?number, signal: ?string, fin: string}} cause  ce que `executerEnEnfant` a établi
 * @param {?object} resume  le résumé du contexte, s'il est sorti avant la fin (src/contexte/resume.js)
 */
export function constatInterruption(cause, resume = null) {
  const etape = LIBELLE_ETAPE[cause.etape] ?? null;
  const plusGros = GENRES_DE_TAILLE.has(cause.genre) ? resume?.plusGrosFichierDeCode ?? null : null;
  const texte = [
    `L'analyse du code du widget s'est interrompue avant la fin (${cause.raison}) : aucune règle n'a pu lire tout le code, et ce que le navigateur en exécute n'est pas audité.`,
    etape ? `Elle s'est interrompue pendant ${etape}.` : null,
    plusGros ? `Le plus gros fichier de code du widget est ${citer(plusGros.chemin)} (${mio(plusGros.taille)}) : ce n'est pas établi comme la cause, mais c'est par lui qu'il faut commencer.` : null,
  ].filter(Boolean).join(' ');
  return constat({
    regle: 'C-SURFACE-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
    titre: "L'analyse du code du widget s'est interrompue avant la fin",
    constat: texte,
    impact: "Un code que personne n'a lu peut contenir n'importe quoi, y compris ce que les règles cherchent : un audit qui ne sait pas le lire ne peut pas le déclarer conforme.",
    remediation: cause.genre === 'pile'
      ? "Découper l'expression trop imbriquée, ou publier les sources non minifiées, pour que l'analyse les lise ; sinon, signaler l'erreur avec ce rapport."
      : 'Si le widget embarque de très gros fichiers de code, publier des fichiers plus petits ; sinon, signaler l\'erreur avec ce rapport.',
    preuve: {
      cause: 'interruption', message: cause.raison, ligne: null, colonne: null, inline: false,
      genre: cause.genre, etape: cause.etape ?? null, code: cause.code ?? null, signal: cause.signal ?? null,
      ...(plusGros ? { plusGrosFichierDeCode: plusGros } : {}),
      ...(cause.fin ? { finDeLaSortieDErreur: cause.fin } : {}),
    },
    axesEmpeches: AXES_DE_L_ANALYSE,
  });
}

/** L'axe D ne peut pas tourner quand l'enfant est mort avant que le contexte existe : pas d'inventaire, pas de page à ouvrir. */
export function constatAxeDInterrompu(cause) {
  return constat({
    regle: 'D-INDISPONIBLE', axe: 'D', severite: 'info', confiance: 'certain',
    titre: "Analyse dynamique non exécutée : l'analyse du code s'est interrompue avant que le contexte existe",
    constat: `L'analyse du code du widget s'est interrompue (${cause.raison}) avant la fin de l'inventaire du dépôt : aucun point d'entrée n'est connu, l'outil n'a pas de page à ouvrir dans le navigateur.`,
    impact: "Les constats de l'axe D (comportement réel du widget : réseau, XSS à l'exécution, accessibilité rendue) n'ont pas été produits. Ce n'est pas une absence de risque, c'est une absence de mesure.",
    remediation: "Voir le constat C-SURFACE-03 de ce rapport : il dit pourquoi l'analyse s'est interrompue.",
  });
}

const PRECISION_ACCES = "Précision : l'analyse statique s'est interrompue avant de lire le niveau d'accès que le code demande, donc l'annonce du README n'a pas pu être rapprochée de cet accès.";

/**
 * L'axe D d'un audit dont l'analyse statique s'est interrompue n'a pas `ctx.usagesGrist` : D-PERIMETRE-01
 * (une table témoin lue) ne sait pas rapprocher l'annonce du README du niveau d'accès demandé. Sa forme
 * « non annoncée » le dirait comme une absence d'annonce, ce que l'outil n'a pas pu établir : on le précise.
 */
export function preciserConstatsDeLAxeD(constats, ctx) {
  if (ctx?.usagesGrist) return;
  for (const c of constats) {
    if (c.regle === 'D-PERIMETRE-01' && !c.constat.includes(PRECISION_ACCES)) c.constat = `${c.constat} ${PRECISION_ACCES}`;
  }
}
