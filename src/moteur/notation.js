/**
 * Notation et verdict.
 *
 * Deux mécanismes indépendants, volontairement :
 *  - un SCORE par axe (0-100), qui mesure la qualité globale et permet de
 *    suivre une progression dans le temps ;
 *  - des PORTES bloquantes, qui ne se compensent pas. Un widget qui exfiltre
 *    des données reste refusé même avec 95/100 partout ailleurs. C'est la
 *    logique d'un avis RSSI : un point dur n'est pas rattrapable par du bon
 *    travail sur le reste.
 */
import { AXES, SEVERITES, facteurOccurrences } from './modele.js';

/**
 * Score d'un axe à partir de sa pénalité cumulée. En-deçà de `SEUIL_LINEAIRE`,
 * c'est la soustraction directe (100 - pénalité). Au-delà, un plancher
 * souple prend le relais au lieu d'un `Math.max(0, ...)` : une pénalité de
 * 105 et une de 300 rendaient toutes les deux 0, un widget très mauvais et
 * un widget catastrophique devenaient indiscernables — pour un audit
 * automatisé, un score muet n'aide personne à savoir par où commencer, ni à
 * comparer deux widgets avant d'en installer un.
 *
 * Le seuil ne peut pas être 100 : la branche linéaire y vaudrait déjà 0, et
 * reprendre une décroissance depuis 0 forcerait soit des valeurs négatives,
 * soit une remontée artificielle juste après le seuil — une pénalité plus
 * grande rendrait alors une meilleure note, l'inverse de ce qu'on corrige.
 * Le plancher souple part donc de la valeur de la branche linéaire à
 * `SEUIL_LINEAIRE` (8) et décroît strictement depuis là, sans jamais
 * atteindre 0 — continue à `SEUIL_LINEAIRE`, strictement décroissante
 * partout, jamais plus généreuse que l'ancienne formule.
 */
const SEUIL_LINEAIRE = 92;
const PLANCHER_SOUPLE = 100 - SEUIL_LINEAIRE;
const ECHELLE_QUEUE = 40;

export function noterAxe(penalite) {
  if (penalite <= SEUIL_LINEAIRE) return Math.round(100 - penalite);
  return Math.round(PLANCHER_SOUPLE * Math.exp(-(penalite - SEUIL_LINEAIRE) / ECHELLE_QUEUE));
}

/**
 * @param {Array} constats
 * @param {Set<string>} [axesNonExecutes] axes dont les règles n'ont pas tourné
 *   (ex. D quand l'analyse dynamique est désactivée) : ils sont notés `null`
 *   et exclus du score global plutôt que notés 100, ce qui serait mensonger.
 */
export function noter(constats, axesNonExecutes = new Set()) {
  const parAxe = {};

  for (const code of Object.keys(AXES)) {
    const liste = constats.filter((c) => c.axe === code);
    if (axesNonExecutes.has(code)) {
      parAxe[code] = { ...AXES[code], score: null, nonExecute: true, constats: liste, repartition: compter(liste) };
      continue;
    }
    // Pénalité cumulée par règle, plafonnée par sévérité : dix `innerHTML`
    // dans le même fichier sont un seul problème de conception, pas dix.
    const parRegle = {};
    for (const c of liste) (parRegle[c.regle] ??= []).push(c);

    let penalite = 0;
    const detail = [];
    for (const [regle, occ] of Object.entries(parRegle)) {
      const sev = SEVERITES[occ[0].severite];
      const p = sev.penalite * facteurOccurrences(occ.length);
      penalite += p;
      if (p > 0) detail.push({ regle, severite: occ[0].severite, occurrences: occ.length, penalite: Math.round(p * 10) / 10 });
    }
    detail.sort((a, b) => b.penalite - a.penalite);
    parAxe[code] = {
      ...AXES[code],
      score: noterAxe(penalite),
      penaliteBrute: Math.round(penalite * 10) / 10,
      nonExecute: false,
      constats: liste,
      repartition: compter(liste),
      detailPenalites: detail,
    };
  }

  const notes = Object.values(parAxe).filter((a) => a.score !== null);
  const poidsTotal = notes.reduce((s, a) => s + a.poids, 0) || 1;
  const global = Math.round(notes.reduce((s, a) => s + a.score * a.poids, 0) / poidsTotal);

  const bloquants = constats.filter((c) => c.bloquant);
  const critiques = constats.filter((c) => c.severite === 'critique' && !c.bloquant);

  let verdict, motif;
  if (bloquants.length) {
    verdict = 'NON CONFORME';
    motif = `${bloquants.length} point(s) bloquant(s) : un hébergement sur instance officielle est exclu en l'état.`;
  } else if (critiques.length || global < 60) {
    verdict = 'CONFORME SOUS RÉSERVE';
    motif = critiques.length
      ? `${critiques.length} constat(s) critique(s) à corriger avant mise en production.`
      : `Score global de ${global}/100, sous le seuil de 60 attendu pour un dépôt candidat.`;
  } else if (global < 80) {
    verdict = 'CONFORME SOUS RÉSERVE';
    motif = `Score global de ${global}/100 : le widget est recevable, des correctifs sont attendus avant hébergement.`;
  } else {
    verdict = 'CONFORME';
    motif = `Score global de ${global}/100, aucun point bloquant identifié.`;
  }

  // Un axe non exécuté est exclu du calcul (voir plus haut) : le score et le
  // verdict ci-dessus portent donc sur une partie seulement du référentiel.
  // Un « CONFORME » sans réserve serait mensonger quand un quart de la note
  // (poids de l'axe D) n'a jamais été mesuré — ça s'est produit une fois en
  // silence : le verdict seul, sans lire le détail par axe, ne le montrait
  // pas. Le dire ici le rend visible partout où `motif` est affiché, plutôt
  // que réservé au détail par axe.
  //
  // Un axe PARTIELLEMENT mesuré (`mesurePartielle` sur un constat, ex.
  // `npm audit` injoignable) est différent : l'axe a bien tourné et son score
  // reste dans la moyenne, seule une vérification en son sein a échoué. Mais
  // le même risque de silence existe — un score qui semble complet alors
  // qu'un pan entier n'a pas pu être vérifié — donc le même plafonnement et
  // le même mode d'emploi dans `motif` s'appliquent, sans exclure l'axe.
  const axesPartiels = new Map();
  for (const c of constats) {
    if (c.mesurePartielle && !axesNonExecutes.has(c.axe) && !axesPartiels.has(c.axe)) {
      axesPartiels.set(c.axe, c.titre);
    }
  }

  if (axesNonExecutes.size || axesPartiels.size) {
    const detailNonExecutes = [...axesNonExecutes]
      .map((code) => `${code} (${AXES[code].titre}, poids ${AXES[code].poids}/100) — non exécuté`);
    const detailPartiels = [...axesPartiels]
      .map(([code, titre]) => `${code} (${AXES[code].titre}) — ${titre}`);
    const detail = [...detailNonExecutes, ...detailPartiels].join(', ');
    if (verdict === 'CONFORME') verdict = 'CONFORME SOUS RÉSERVE';
    motif = `⚠️ Audit partiel — couverture incomplète : ${detail}. Score calculé sans ce qui manque, à ne pas comparer à un audit complet. ${motif}`;
  }

  return {
    global,
    verdict,
    motif,
    parAxe,
    bloquants,
    repartition: compter(constats),
    axesNonExecutes: [...axesNonExecutes],
    axesPartiels: [...axesPartiels.keys()],
  };
}

function compter(liste) {
  const r = { critique: 0, majeur: 0, mineur: 0, info: 0 };
  for (const c of liste) r[c.severite]++;
  return r;
}
