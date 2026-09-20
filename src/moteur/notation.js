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
      score: Math.max(0, Math.round(100 - penalite)),
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

  return {
    global,
    verdict,
    motif,
    parAxe,
    bloquants,
    repartition: compter(constats),
    axesNonExecutes: [...axesNonExecutes],
  };
}

function compter(liste) {
  const r = { critique: 0, majeur: 0, mineur: 0, info: 0 };
  for (const c of liste) r[c.severite]++;
  return r;
}
