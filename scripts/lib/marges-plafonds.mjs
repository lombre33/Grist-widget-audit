/**
 * Ce que chaque plafond de l'outil coûte à un dépôt donné, et la marge qui reste : la mesure qui décide si un plafond peut être un
 * constat bloquant (aucune cible honnête ne doit y buter, et avec quelle marge). Les valeurs sont celles que l'outil consomme
 * réellement, jamais une estimation : un plafond d'une option de `construireContexte` se mesure par recherche de la plus petite
 * valeur qui ne tronque pas le dépôt, les autres se lisent sur le contexte après l'analyse statique.
 *
 * `mesurerRacine` rend, pour un dépôt : `fichiers`, `octets` (texte lu en tout), `octetsFichier` (le plus gros fichier de texte),
 * `entreesListees` (dossiers exclus listés pour suivre une adresse à préfixe), `resolutions` (adresses de worker résolues),
 * `pasDocuments` (arêtes de document parcourues), `profondeur` (niveaux de code littéral emboîté lus). `marges` en tire le plus
 * gros de chaque valeur sur plusieurs dépôts et son rapport au plafond.
 */
import path from 'node:path';
import { construireContexte, PLAFONDS } from '../../src/contexte/inventaire.js';
import { analyseStatique } from '../../src/moteur/statique.js';
import { MAX_PROFONDEUR_CODE_IMBRIQUE } from '../../src/regles/c-securite.js';

/** Aucun plafond n'est atteint avec cette valeur : le dépôt se lit en entier, on compte ce qu'il coûte. */
const SANS_PLAFOND = 2 ** 40;

/** Les plafonds que l'outil applique, dans l'ordre où la mesure les dit : clé de la mesure, plafond, libellé. */
export const PLAFONDS_MESURES = [
  { cle: 'fichiers', plafond: PLAFONDS.fichiers, libelle: 'fichiers inventoriés', unite: '' },
  { cle: 'octets', plafond: PLAFONDS.octets, libelle: 'octets de texte lus en tout', unite: 'octets' },
  { cle: 'octetsFichier', plafond: PLAFONDS.octetsFichier, libelle: 'octets du plus gros fichier de texte', unite: 'octets' },
  { cle: 'entreesListees', plafond: PLAFONDS.entreesListees, libelle: 'entrées listées dans les dossiers exclus', unite: '' },
  { cle: 'resolutions', plafond: PLAFONDS.resolutions, libelle: "résolutions d'adresses de worker", unite: '' },
  { cle: 'pasDocuments', plafond: PLAFONDS.pasDocuments, libelle: 'pas d\'analyse de document', unite: '' },
  { cle: 'profondeur', plafond: MAX_PROFONDEUR_CODE_IMBRIQUE, libelle: 'niveaux de code littéral emboîté', unite: '' },
];

/**
 * La plus petite valeur de l'option `option` de `construireContexte` qui ne fait pas dire `drapeau` à `tronque` pour ce dépôt : ce que
 * le dépôt consomme de ce plafond. Doublement puis dichotomie ; 0 quand rien n'est consommé, null quand même `borne` ne suffit pas.
 */
export function plusPetitPlafond(racine, option, drapeau, { borne = 2 ** 31 } = {}) {
  const tronque = (valeur) => Boolean(construireContexte(racine, { [option]: valeur }).tronque?.[drapeau]);
  if (!tronque(0)) return 0;
  let haut = 1;
  while (tronque(haut)) {
    haut *= 2;
    if (haut > borne) return null;
  }
  let bas = haut / 2;                                            // tronque(bas) est vrai, tronque(haut) est faux
  while (haut - bas > 1) {
    const milieu = Math.floor((bas + haut) / 2);
    if (tronque(milieu)) bas = milieu; else haut = milieu;
  }
  return haut;
}

/** Les niveaux de code littéral emboîté qu'une analyse a lus : chaque niveau de plus ajoute un « (code littéral » au chemin du fichier synthétique. */
const niveaux = (chemin) => (chemin.match(/\(code littéral/g) ?? []).length;

/**
 * Ce qu'un dépôt consomme de chaque plafond (voir l'en-tête). Les plafonds d'octets et de fichiers sont levés pendant la mesure : le
 * dépôt se lit en entier, on compte ce qu'il coûte. `construire` : le constructeur de contexte, que les essais remplacent pour voir
 * avec quelles options il est appelé.
 */
export async function mesurerRacine(racine, { construire = construireContexte } = {}) {
  const ctx = construire(racine, { maxFichiers: SANS_PLAFOND, maxOctetsCumules: SANS_PLAFOND, maxOctetsFichier: SANS_PLAFOND });
  const reels = ctx.fichiers.slice(0, ctx.fichiersReels);
  const lus = reels.filter((f) => f.contenu !== undefined);
  await analyseStatique(ctx, { reseau: false });
  let profondeur = 0;
  for (const f of ctx.fichiers.slice(ctx.fichiersReels)) profondeur = Math.max(profondeur, niveaux(f.chemin));
  let octetsFichier = 0;
  for (const f of lus) octetsFichier = Math.max(octetsFichier, f.taille);
  return {
    racine,
    fichiers: ctx.fichiersReels,
    octets: lus.reduce((somme, f) => somme + f.taille, 0),
    octetsFichier,
    entreesListees: plusPetitPlafond(racine, 'maxEntreesListees', 'listage'),
    resolutions: plusPetitPlafond(racine, 'maxResolutions', 'surface'),
    pasDocuments: ctx.pasDocuments(),
    profondeur,
  };
}

/**
 * Pour chaque plafond : le plus gros de ses valeurs sur les mesures (`maximum`, et le dépôt qui le porte), le plafond, et la marge
 * (plafond / maximum, null quand le maximum est nul : aucune cible ne le consomme). Une valeur que la recherche n'a pas pu borner
 * (null) compte comme infinie : la marge est alors 0 et le dépôt est nommé.
 */
export function marges(mesures) {
  return PLAFONDS_MESURES.map(({ cle, plafond, libelle, unite }) => {
    let maximum = 0;
    let depot = null;
    for (const m of mesures) {
      const valeur = m[cle] ?? Infinity;
      if (valeur > maximum) { maximum = valeur; depot = m.racine; }
    }
    return { cle, libelle, unite, plafond, maximum, depot, marge: maximum === 0 ? null : plafond / maximum };
  });
}

const nombre = (n) => (Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : 'non borné');
const mio = (octets) => `${(octets / 1024 / 1024).toFixed(2).replace('.', ',')} Mio`;
const valeur = (ligne, n) => (ligne.unite === 'octets' && Number.isFinite(n) ? `${nombre(n)} octets (${mio(n)})` : nombre(n));
const facteur = (m) => (m === null ? 'aucune cible ne le consomme' : m === 0 ? 'aucune marge' : `×${m >= 100 ? Math.round(m) : m.toFixed(1).replace('.', ',')}`);

/** Les marges en clair, une rubrique par plafond : le plus gros (et le dépôt qui le porte), le plafond, la marge. */
export function dire(resume, nombreDeDepots) {
  const lignes = [`${nombreDeDepots} dépôt(s) mesuré(s)`, ''];
  for (const ligne of resume) {
    lignes.push(ligne.libelle);
    lignes.push(`  plus gros : ${valeur(ligne, ligne.maximum)}${ligne.depot ? ` (${path.basename(ligne.depot)})` : ''}`);
    lignes.push(`  plafond   : ${valeur(ligne, ligne.plafond)}`);
    lignes.push(`  marge     : ${facteur(ligne.marge)}`);
  }
  return lignes.join('\n');
}
