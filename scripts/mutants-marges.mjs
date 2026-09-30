#!/usr/bin/env node
/**
 * Rejoue les mutants de la mesure des marges des plafonds (`scripts/lib/marges-plafonds.mjs`, `scripts/mesurer-marges-plafonds.mjs`) :
 * la recherche de la plus petite valeur qui ne tronque pas, ce qu'un dépôt consomme de chaque plafond, le rapport au plafond, la
 * ligne de commande et les valeurs par défaut des plafonds. Chaque mutant pose, sur la ligne qui porte le choix, le défaut plausible :
 * un des essais doit alors échouer (méthode : `scripts/lib/rejouer-mutants.mjs`). Aucun navigateur n'est requis.
 *
 * Quatre mutants équivalents sont écartés, faute d'un comportement qui les distingue : le milieu de la dichotomie arrondi vers le haut (la
 * valeur rendue est la même, seul le nombre de pas change), la profondeur prise sur le dernier fichier synthétique au lieu du maximum (les
 * fichiers d'un niveau se créent avant ceux du niveau suivant : le dernier est toujours le plus profond), et les deux lectures du plafond
 * des résolutions à la place de celui des pas de document (les deux plafonds ont la même valeur).
 *
 * Usage : node scripts/mutants-marges.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const L = 'scripts/lib/marges-plafonds.mjs';
const B = 'scripts/mesurer-marges-plafonds.mjs';
const I = 'src/contexte/inventaire.js';
const TESTS = ['tests/marges-plafonds.test.mjs'];

const MUTANTS = [
  // --- la plus petite valeur qui ne tronque pas
  dansLigne(L, 'if (!tronque(0)) return 0;', 'if (!tronque(0)) return 0;', '', 'recherche : un dépôt qui ne consomme rien se mesure à 1'),
  dansLigne(L, 'if (!tronque(0)) return 0;', 'return 0;', 'return 1;', 'recherche : un dépôt qui ne consomme rien se mesure à 1'),
  dansLigne(L, 'if (haut > borne) return null;', 'haut > borne', 'haut >= borne', 'recherche : une borne qui suffit pile est dite insuffisante'),
  dansLigne(L, 'if (haut > borne) return null;', 'return null;', 'return haut;', 'recherche : une borne trop basse rend une valeur fausse'),
  dansLigne(L, 'while (haut - bas > 1) {', '> 1', '> 2', 'recherche : la dichotomie s\'arrête une valeur trop tôt'),
  dansLigne(L, 'if (tronque(milieu)) bas = milieu; else haut = milieu;', 'if (tronque(milieu))', 'if (!tronque(milieu))', 'recherche : la dichotomie va du mauvais côté'),
  dansLigne(L, 'return haut;', 'haut', 'bas', 'recherche : la valeur rendue est celle qui tronque'),
  dansLigne(L, 'const tronque = (valeur) =>', '.tronque?.[drapeau]', '.tronque?.fichiers', 'recherche : le drapeau demandé n\'est pas celui du plafond'),
  dansLigne(L, 'const tronque = (valeur) =>', '[option]: valeur', 'maxFichiers: valeur', 'recherche : l\'option mesurée n\'est pas celle du plafond'),
  dansLigne(L, 'let haut = 1;', 'let haut = 1;', 'let haut = 2;', 'recherche : un dépôt qui consomme une seule unité se mesure à 2'),

  // --- ce qu'un dépôt consomme
  dansLigne(L, 'const ctx = construire(racine, {', 'maxFichiers: SANS_PLAFOND, ', '', 'mesure : le plafond de fichiers reste en place pendant la mesure'),
  dansLigne(L, 'const ctx = construire(racine, {', 'maxOctetsCumules: SANS_PLAFOND, ', '', 'mesure : le plafond cumulé reste en place pendant la mesure'),
  dansLigne(L, 'const ctx = construire(racine, {', 'maxOctetsFichier: SANS_PLAFOND }', '}', 'mesure : le plafond par fichier reste en place pendant la mesure'),
  dansLigne(L, 'const ctx = construire(racine, {', 'maxOctetsFichier: SANS_PLAFOND', 'maxOctetsFichier: PLAFONDS.octetsFichier', 'mesure : le plafond par fichier est remis à sa valeur par défaut'),
  dansLigne(L, 'const reels = ctx.fichiers.slice(0, ctx.fichiersReels);', 'ctx.fichiersReels', '1', 'mesure : un seul fichier est dit réel'),
  dansLigne(L, 'const lus = reels.filter((f) => f.contenu !== undefined);', 'f.contenu !== undefined', 'true', 'mesure : une image est comptée comme du texte lu'),
  dansLigne(L, 'for (const f of ctx.fichiers.slice(ctx.fichiersReels)) profondeur =', 'Math.max(', 'Math.min(', 'mesure : la profondeur est la plus petite'),
  dansLigne(L, 'const niveaux = (chemin) =>', '/\\(code littéral/g', '/\\(code littéral/', 'mesure : un fichier emboîté de deux niveaux n\'en compte qu\'un'),
  dansLigne(L, 'for (const f of lus) octetsFichier = Math.max(octetsFichier, f.taille);', 'Math.max(', 'Math.min(', 'mesure : le plus gros fichier est le plus petit'),
  dansLigne(L, 'octets: lus.reduce((somme, f) => somme + f.taille, 0),', 'somme + f.taille', 'somme + 1', 'mesure : les octets lus comptent des fichiers'),
  dansLigne(L, 'fichiers: ctx.fichiersReels,', 'ctx.fichiersReels', 'ctx.fichiers.length', 'mesure : les fichiers synthétiques du code littéral comptent comme des fichiers du dépôt'),
  dansLigne(L, "entreesListees: plusPetitPlafond(racine, 'maxEntreesListees', 'listage'),", "'maxEntreesListees', 'listage'", "'maxResolutions', 'surface'", 'mesure : les entrées listées se mesurent sur le plafond des résolutions'),
  dansLigne(L, "resolutions: plusPetitPlafond(racine, 'maxResolutions', 'surface'),", "'maxResolutions', 'surface'", "'maxEntreesListees', 'listage'", 'mesure : les résolutions se mesurent sur le plafond des entrées listées'),
  dansLigne(L, 'pasDocuments: ctx.pasDocuments(),', 'ctx.pasDocuments()', '0', 'mesure : les pas de document ne sont pas comptés'),

  // --- le rapport au plafond
  dansLigne(L, 'const valeur = m[cle] ?? Infinity;', '?? Infinity', '?? 0', 'marges : une valeur non bornée compte pour nulle'),
  dansLigne(L, 'if (valeur > maximum) {', 'valeur > maximum', 'valeur >= maximum', 'marges : à égalité, le dernier dépôt porte le maximum'),
  dansLigne(L, 'if (valeur > maximum) {', 'valeur > maximum', 'valeur < maximum', 'marges : le maximum est le plus petit'),
  dansLigne(L, 'if (valeur > maximum) {', 'depot = m.racine', 'depot = null', 'marges : le dépôt qui porte le maximum n\'est pas nommé'),
  dansLigne(L, 'return { cle, libelle, unite, plafond, maximum, depot, marge:', 'plafond / maximum', 'maximum / plafond', 'marges : le rapport est inversé'),
  dansLigne(L, 'return { cle, libelle, unite, plafond, maximum, depot, marge:', 'maximum === 0 ? null :', '', 'marges : un maximum nul divise par zéro'),
  dansLigne(L, 'return { cle, libelle, unite, plafond, maximum, depot, marge:', 'maximum === 0 ? null : plafond / maximum', 'plafond / maximum', 'marges : un maximum nul rend une marge infinie'),
  dansLigne(L, "{ cle: 'fichiers', plafond: PLAFONDS.fichiers,", 'PLAFONDS.fichiers', 'PLAFONDS.octets', 'plafonds mesurés : les fichiers sont comparés au plafond des octets'),
  dansLigne(L, "{ cle: 'octetsFichier', plafond: PLAFONDS.octetsFichier,", 'PLAFONDS.octetsFichier', 'PLAFONDS.octets', 'plafonds mesurés : le plus gros fichier est comparé au plafond cumulé'),
  dansLigne(L, "{ cle: 'profondeur', plafond: MAX_PROFONDEUR_CODE_IMBRIQUE,", 'MAX_PROFONDEUR_CODE_IMBRIQUE', 'MAX_PROFONDEUR_CODE_IMBRIQUE + 1', 'plafonds mesurés : la profondeur est comparée à une profondeur de plus'),

  // --- la ligne de commande
  dansLigne(B, "const json = args.includes('--json');", "args.includes('--json')", 'false', 'ligne de commande : --json est ignoré'),
  dansLigne(B, "const racines = args.filter((a) => a !== '--json')", "a !== '--json'", 'true', 'ligne de commande : --json est pris pour un dépôt'),
  dansLigne(B, 'if (!racines.length) {', '!racines.length', 'false', 'ligne de commande : aucun dépôt n\'est une mesure vide'),
  dansLigne(B, "console.error('Usage", 'Usage', 'Mode', 'ligne de commande : le mode d\'emploi ne se dit pas'),
  [B, "[<dépôt>…]');\n  process.exit(2);", "[<dépôt>…]');\n  process.exit(1);", 'ligne de commande : le mode d\'emploi rend le code 1'],
  [B, "${absentes.join(', ')}`);\n  process.exit(2);", "${absentes.join(', ')}`);\n  process.exit(0);", 'ligne de commande : un dépôt introuvable rend le code 0'],
  dansLigne(B, 'const absentes = racines.filter(', '|| !fs.statSync(r).isDirectory()', '', 'ligne de commande : un fichier est pris pour un dépôt'),
  dansLigne(B, 'const absentes = racines.filter(', '!fs.existsSync(r) ||', '', 'ligne de commande : un dépôt qui n\'existe pas plante au lieu de se dire'),
  dansLigne(B, 'if (absentes.length) {', 'absentes.length', 'false', 'ligne de commande : un dépôt introuvable est mesuré à moitié'),
  dansLigne(B, "console.error(`Dépôt introuvable", 'Dépôt introuvable', 'Introuvable', 'ligne de commande : le dépôt introuvable n\'est pas nommé comme attendu'),

  // --- la mise en clair
  dansLigne(L, 'const nombre = (n) =>', "'non borné'", "'0'", 'dire : une valeur non bornée se dit 0'),
  dansLigne(L, 'const nombre = (n) =>', 'Number.isFinite(n) ?', 'true ?', 'dire : une valeur non bornée se dit Infinity'),
  dansLigne(L, 'const nombre = (n) =>', "' ')", "'')", 'dire : les milliers ne sont pas séparés'),
  dansLigne(L, 'const mio = (octets) =>', '/ 1024 / 1024', '/ 1000 / 1000', 'dire : les Mio se comptent par millions'),
  dansLigne(L, 'const mio = (octets) =>', 'toFixed(2)', 'toFixed(0)', 'dire : les Mio n\'ont pas de décimales'),
  dansLigne(L, 'const mio = (octets) =>', ".replace('.', ',')", '', 'dire : les Mio s\'écrivent avec un point'),
  dansLigne(L, 'const valeur = (ligne, n) =>', "ligne.unite === 'octets' && ", '', 'dire : un nombre de fichiers se dit en octets'),
  dansLigne(L, 'const valeur = (ligne, n) =>', "&& Number.isFinite(n)", '', 'dire : une valeur non bornée se dit en octets'),
  dansLigne(L, 'const facteur = (m) =>', "m >= 100 ? Math.round(m)", "m >= 100 ? m.toFixed(1).replace('.', ',')", 'dire : une grande marge garde ses décimales'),
  dansLigne(L, 'const facteur = (m) =>', 'm >= 100', 'm > 100', 'dire : une marge de cent garde ses décimales'),
  dansLigne(L, 'const facteur = (m) =>', "m.toFixed(1).replace('.', ',')", "m.toFixed(1)", 'dire : une marge s\'écrit avec un point'),
  dansLigne(L, 'const facteur = (m) =>', "'aucune cible ne le consomme'", "'aucune marge'", 'dire : un plafond que rien ne consomme se dit sans marge'),
  dansLigne(L, 'const facteur = (m) =>', "'aucune marge'", "'aucune cible ne le consomme'", 'dire : une valeur non bornée se dit consommée par personne'),
  dansLigne(L, "lignes.push(`  plus gros :", "ligne.depot ? ` (${path.basename(ligne.depot)})` : ''", "''", 'dire : le dépôt qui porte le plus gros n\'est pas nommé'),
  dansLigne(L, "lignes.push(`  plus gros :", "path.basename(ligne.depot)", "ligne.depot", 'dire : le dépôt est dit par son chemin entier'),
  dansLigne(L, "const lignes = [`${nombreDeDepots} dépôt(s) mesuré(s)`, ''];", "nombreDeDepots", "0", 'dire : le nombre de dépôts mesurés n\'est pas dit'),

  // --- les valeurs par défaut des plafonds
  dansLigne(I, 'const MAX_OCTETS_FICHIER =', '16 * 1024 * 1024', '4 * 1024 * 1024', 'plafonds : le plafond par fichier redescend à 4 Mio'),
  dansLigne(I, 'const MAX_OCTETS_FICHIER =', '16 * 1024 * 1024', '8 * 1024 * 1024', 'plafonds : le plafond par fichier passe à 8 Mio'),
  dansLigne(I, 'export const PLAFONDS = Object.freeze({', 'Object.freeze({', '({', 'plafonds : les plafonds par défaut se modifient en route'),
  dansLigne(I, '  octetsFichier: MAX_OCTETS_FICHIER,', 'MAX_OCTETS_FICHIER', 'MAX_OCTETS_LUS_CUMULES', 'plafonds : le plafond par fichier exporté est le cumulé'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de la mesure des marges', fichiers: TESTS }],
  exigerChromium: false,
  partie,
});
