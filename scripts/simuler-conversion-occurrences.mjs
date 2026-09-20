#!/usr/bin/env node
/**
 * Outil de préparation, PAS un changement de comportement : mesure ce que
 * donnerait la conversion des 14 règles « agrégées » (Pattern B) en un
 * constat par occurrence réelle, sans jamais toucher noter() ni aucune
 * règle. Sert à trancher rapidement la décision différée par la
 * coordination (voir docs/PISTES-EXHAUSTIVITE.md) une fois les nouvelles
 * règles de sécurité stabilisées : lancé sur un rapport.json déjà produit,
 * il répond « qu'est-ce qui bougerait si on convertissait cette règle ? »
 * axe par axe et globalement, verdict compris.
 *
 * Usage : node scripts/simuler-conversion-occurrences.mjs <rapport.json>
 *
 * Réutilise le moteur réel (facteurOccurrences, noterAxe, AXES, SEVERITES)
 * plutôt que de réimplémenter la formule : la simulation ne peut donc pas
 * dériver silencieusement du comportement réel de noter().
 */
import fs from 'node:fs';
import { AXES, SEVERITES, facteurOccurrences } from '../src/moteur/modele.js';
import { noterAxe } from '../src/moteur/notation.js';

/**
 * Les 14 règles identifiées comme "Pattern B" (un seul constat pour toutes
 * les occurrences réelles) et la clé de `preuve` où compter le nombre réel
 * d'occurrences que la règle a déjà déterminé en interne — voir la mémoire
 * du projet (cardinalité, 2026-09-20) pour la liste et sa méthode.
 */
const REGLES_AGREGEES = {
  'A-DEV-01': 'emplacements', 'A-DEV-03': 'emplacements', 'A-DUP-01': 'groupes',
  'A-LANG-01': 'emplacements', 'A-LANG-02': 'emplacements', 'A-MORT-01': 'emplacements',
  'B-NOM-01': 'emplacements', 'B-DOC-04': 'hotes', 'B-IA-01': 'signaux',
  'C-GRIST-04': 'emplacements', 'C-XSS-06': 'emplacements', 'C-STOCK-01': 'emplacements',
  'E-DEP-05': 'emplacements', 'F-SOUV-01': 'hotes',
};

function occurrencesReelles(constat, cle) {
  const v = constat.preuve?.[cle];
  return Array.isArray(v) ? v.length : null;
}

/**
 * @param {object} rapport  rapport.json déjà chargé (genererJson())
 * @returns {Array} une entrée par règle agrégée présente dans ce rapport
 */
export function simuler(rapport) {
  const resultats = [];
  const poidsTotal = Object.entries(rapport.axes)
    .filter(([, a]) => !a.nonExecute)
    .reduce((s, [code]) => s + AXES[code].poids, 0) || 1;

  for (const [regle, cle] of Object.entries(REGLES_AGREGEES)) {
    for (const [code, axe] of Object.entries(rapport.axes)) {
      if (axe.nonExecute) continue;
      const constat = axe.constats.find((c) => c.regle === regle);
      if (!constat) continue;
      const n = occurrencesReelles(constat, cle);
      if (n == null) {
        resultats.push({ regle, axe: code, erreur: `preuve.${cle} absente ou non tableau : conversion non mesurable en l'état` });
        continue;
      }

      const sev = SEVERITES[constat.severite];
      const penaliteActuelle = sev.penalite * facteurOccurrences(1); // = sev.penalite, un seul constat aujourd'hui
      const penaliteSimulee = sev.penalite * facteurOccurrences(n);
      const penaliteBruteAxeSimulee = axe.penaliteBrute - penaliteActuelle + penaliteSimulee;

      const scoreAxeActuel = axe.score;
      const scoreAxeSimule = noterAxe(penaliteBruteAxeSimulee);

      // Score global : moyenne pondérée, en ne changeant que cet axe.
      const poidsAxe = AXES[code].poids;
      const deltaGlobalPondere = ((scoreAxeSimule - scoreAxeActuel) * poidsAxe) / poidsTotal;
      const scoreGlobalSimule = Math.round(rapport.scoreGlobal + deltaGlobalPondere);

      resultats.push({
        regle, axe: code, occurrencesReelles: n, severite: constat.severite,
        penaliteActuelle: Math.round(penaliteActuelle * 10) / 10,
        penaliteSimulee: Math.round(penaliteSimulee * 10) / 10,
        scoreAxeActuel, scoreAxeSimule,
        scoreGlobalActuel: rapport.scoreGlobal, scoreGlobalSimule,
        verdictPourraitBouger: (rapport.scoreGlobal >= 60) !== (scoreGlobalSimule >= 60)
          || (rapport.scoreGlobal >= 80) !== (scoreGlobalSimule >= 80),
      });
    }
  }
  return resultats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chemin = process.argv[2];
  if (!chemin) {
    console.error('Usage : node scripts/simuler-conversion-occurrences.mjs <rapport.json>');
    process.exit(1);
  }
  const rapport = JSON.parse(fs.readFileSync(chemin, 'utf8'));
  const resultats = simuler(rapport);
  if (!resultats.length) {
    console.log("Aucune des 14 règles agrégées ne s'est déclenchée dans ce rapport.");
  } else {
    console.table(resultats.map((r) => r.erreur
      ? { regle: r.regle, axe: r.axe, erreur: r.erreur }
      : { regle: r.regle, axe: r.axe, occ: r.occurrencesReelles, sev: r.severite,
          'pénalité avant': r.penaliteActuelle, 'pénalité après': r.penaliteSimulee,
          'score axe avant': r.scoreAxeActuel, 'score axe après': r.scoreAxeSimule,
          'score global avant': r.scoreGlobalActuel, 'score global après': r.scoreGlobalSimule,
          'verdict pourrait bouger': r.verdictPourraitBouger ? 'OUI' : 'non' }));
  }
}
