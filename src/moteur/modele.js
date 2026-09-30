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
 * Le nombre d'emplacements qu'un constat garde dans sa preuve. Un fichier hostile en produit des
 * centaines de milliers pour une même règle (un marqueur par ligne), et le rapport JSON, seul
 * format qui porte la liste, ferait plusieurs dizaines de Mio. Au-delà, le constat garde les
 * premiers et dit combien il en omet (`preuve.emplacementsOmis`) ; son texte, écrit avant la
 * coupe, porte le total exact. La borne est très au-dessus de ce qu'une cible honnête produit.
 */
export const MAX_EMPLACEMENTS = 500;

function preuveBornee(preuve) {
  const emplacements = preuve?.emplacements;
  if (!Array.isArray(emplacements) || emplacements.length <= MAX_EMPLACEMENTS) return preuve ?? null;
  return { ...preuve, emplacements: emplacements.slice(0, MAX_EMPLACEMENTS), emplacementsOmis: emplacements.length - MAX_EMPLACEMENTS };
}

/**
 * Un `extrait` est replié (blancs) puis coupé à 300 caractères, mais seul son
 * début est lu : replier tout un texte de plusieurs Mio (une ligne CSS
 * minifiée, une balise énorme) pour chacun de milliers de constats coûtait un
 * temps et une mémoire quadratiques (8 000 `@import` sur une ligne : 11 s et
 * 2,5 Go). Ne diffère de la lecture entière que si plus de 3 800 des 4 096
 * premiers caractères sont des blancs.
 */
const LONGUEUR_LUE_EXTRAIT = 4096;

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
 * @param {string[]} [c.axesEmpeches] les axes que CE WIDGET empêche de mesurer
 *   (une boucle qui occupe le navigateur jusqu'au délai, un fichier de code
 *   qu'aucun lecteur ne lit) : `noter()` les note 0 et dit pourquoi. Ce n'est
 *   pas `mesurePartielle`, qui dit qu'une vérification a échoué pour une
 *   cause de l'environnement ou d'un choix de l'utilisateur (l'axe garde alors
 *   son score) : un widget qui empêche une mesure ne note jamais mieux que
 *   s'il l'avait laissée se faire, donc un constat qui la déclare empêchée est
 *   toujours bloquant (`constat()` refuse le contraire).
 */
export function constat(c) {
  if (!SEVERITES[c.severite]) throw new Error(`Sévérité inconnue : ${c.severite}`);
  if (!AXES[c.axe]) throw new Error(`Axe inconnu : ${c.axe}`);
  const axesEmpeches = axesEmpechesDe(c);
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
    extrait: c.extrait ? String(c.extrait).slice(0, LONGUEUR_LUE_EXTRAIT).replace(/\s+/g, ' ').slice(0, 300) : null,
    referentiels: c.referentiels ?? [],
    confiance: c.confiance ?? 'probable',
    preuve: preuveBornee(c.preuve),
    mesurePartielle: Boolean(c.mesurePartielle),
    axesEmpeches,
  };
}

/**
 * Les axes qu'un constat déclare empêchés, dédoublonnés et dans l'ordre des axes. Un code qui n'est pas
 * un axe, ou un constat qui n'est pas bloquant, est une erreur de la règle qui le pose : elle se voit à
 * la première exécution, jamais au rapport.
 */
function axesEmpechesDe(c) {
  const demandes = c.axesEmpeches ?? [];
  if (!Array.isArray(demandes)) throw new Error(`axesEmpeches doit être une liste de codes d'axe, reçu : ${JSON.stringify(demandes)}`);
  for (const code of demandes) if (!AXES[code]) throw new Error(`Axe inconnu dans axesEmpeches : ${code}`);
  if (demandes.length && !c.bloquant) {
    throw new Error(`${c.regle} déclare des axes empêchés sans être bloquante : un widget qui empêche la mesure ne note jamais mieux que s'il la laissait se faire`);
  }
  return Object.keys(AXES).filter((code) => demandes.includes(code));
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
