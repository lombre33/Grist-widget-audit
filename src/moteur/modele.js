/**
 * Modèle de données commun à tout l'outil : axes d'audit, sévérités, constats.
 *
 * Un « constat » est l'unité atomique du rapport. Toute règle, statique comme
 * dynamique, ne produit que des constats : c'est ce qui permet de scorer,
 * filtrer et exporter de façon homogène.
 */

/** Les six axes d'audit. Les lettres A à E reprennent la demande initiale. */
export const AXES = {
  A: { code: 'A', titre: 'Qualité du code', poids: 20 },
  B: { code: 'B', titre: 'Lisibilité et maintenabilité humaine', poids: 15 },
  C: { code: 'C', titre: 'Sécurité applicative (analyse statique, RSSI)', poids: 25 },
  D: { code: 'D', titre: 'Sécurité en condition réelle (tests dynamiques)', poids: 25 },
  E: { code: 'E', titre: "Chaîne d'approvisionnement et dépendances", poids: 10 },
  F: { code: 'F', titre: 'Conformité Grist.Gouv, souveraineté, accessibilité', poids: 5 },
};

/**
 * Sévérités. `penalite` est le nombre de points retirés au score de l'axe pour
 * une occurrence ; `plafond` limite la casse quand une règle remonte des
 * dizaines d'occurrences d'un même défaut mineur.
 */
export const SEVERITES = {
  critique: { rang: 4, penalite: 35, libelle: 'Critique' },
  majeur:   { rang: 3, penalite: 12, libelle: 'Majeur' },
  mineur:   { rang: 2, penalite: 3,  libelle: 'Mineur' },
  info:     { rang: 1, penalite: 0,  libelle: 'Information' },
};

/**
 * Facteur d'aggravation en fonction du nombre d'occurrences d'une même règle.
 * Vingt `innerHTML` dynamiques ne valent pas vingt fois un seul : c'est le même
 * défaut de conception, répété. La croissance est donc logarithmique et
 * plafonnée à 2,5 fois la pénalité de base.
 */
export function facteurOccurrences(n) {
  return Math.min(1 + Math.log(n), 2.5);
}

/** Niveau de confiance : distingue une preuve d'exécution d'une heuristique. */
export const CONFIANCES = {
  prouve: "Prouvé (observé à l'exécution)",
  certain: 'Certain (motif non ambigu dans le code)',
  probable: 'Probable (heuristique, à confirmer par un relecteur)',
  a_verifier: 'À vérifier manuellement',
};

let compteur = 0;

/**
 * Construit un constat normalisé.
 *
 * @param {object} c
 * @param {string} c.regle       identifiant stable de la règle (ex. C-EXFIL-01)
 * @param {'A'|'B'|'C'|'D'|'E'|'F'} c.axe
 * @param {string} c.titre       une ligne, en français, lisible par un non-développeur
 * @param {'critique'|'majeur'|'mineur'|'info'} c.severite
 * @param {boolean} [c.bloquant] rédhibitoire pour un hébergement sur instance officielle
 * @param {string} c.constat     ce qui a été observé
 * @param {string} [c.impact]    conséquence concrète
 * @param {string} [c.remediation] comment corriger
 * @param {string} [c.fichier]   chemin relatif au dépôt audité
 * @param {number} [c.ligne]
 * @param {string} [c.extrait]
 * @param {string[]} [c.referentiels]
 * @param {'prouve'|'certain'|'probable'|'a_verifier'} [c.confiance]
 * @param {object} [c.preuve]    trace brute (requête réseau capturée, log…)
 * @param {boolean} [c.mesurePartielle] une vérification de cet axe n'a pas pu
 *   aboutir (ex. `npm audit` injoignable) — l'axe garde son score calculé sur
 *   ce qu'il a pu mesurer, mais `noter()` plafonne le verdict à SOUS RÉSERVE
 *   et le dit dans `motif`, plutôt que de laisser un score partiel se
 *   présenter comme complet. Ne pas confondre avec un axe non exécuté
 *   (`axesNonExecutes` dans `noter()`) : ici l'axe a bien tourné, une seule
 *   vérification en son sein a échoué.
 */
export function constat(c) {
  if (!SEVERITES[c.severite]) throw new Error(`Sévérité inconnue : ${c.severite}`);
  if (!AXES[c.axe]) throw new Error(`Axe inconnu : ${c.axe}`);
  return {
    uid: `${c.regle}#${++compteur}`,
    regle: c.regle,
    axe: c.axe,
    titre: c.titre,
    severite: c.severite,
    bloquant: Boolean(c.bloquant),
    constat: c.constat,
    impact: c.impact ?? null,
    remediation: c.remediation ?? null,
    fichier: c.fichier ?? null,
    ligne: c.ligne ?? null,
    extrait: c.extrait ? String(c.extrait).replace(/\s+/g, ' ').slice(0, 300) : null,
    referentiels: c.referentiels ?? [],
    confiance: c.confiance ?? 'probable',
    preuve: c.preuve ?? null,
    mesurePartielle: Boolean(c.mesurePartielle),
  };
}

/** Tri de lecture : bloquants d'abord, puis sévérité, puis axe, puis fichier. */
export function trierConstats(constats) {
  return [...constats].sort((x, y) =>
    Number(y.bloquant) - Number(x.bloquant) ||
    SEVERITES[y.severite].rang - SEVERITES[x.severite].rang ||
    x.axe.localeCompare(y.axe) ||
    String(x.fichier).localeCompare(String(y.fichier)) ||
    (x.ligne ?? 0) - (y.ligne ?? 0));
}
