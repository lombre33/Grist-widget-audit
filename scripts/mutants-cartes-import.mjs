#!/usr/bin/env node
/**
 * Rejoue les mutants des noms que du code importe et que la carte d'import d'une page résout : la résolution elle-même (clé exacte, plus
 * long préfixe, portées, cartes fusionnées, adresses bloquées : comparée à `import.meta.resolve` de Chromium), puis ce que la surface en fait
 * (les noms que le code lu importe, l'ordre où la file rencontre la page et le code, les réserves du gabarit et de l'import de données, le
 * plafond d'analyse qu'une résolution consomme). Chaque mutant pose, sur la ligne qui porte le choix, le défaut plausible : un des essais
 * doit alors échouer (méthode : `scripts/lib/rejouer-mutants.mjs`). Un navigateur est requis (`GWAUDIT_CHROMIUM_PATH`, et
 * `GWAUDIT_CHROMIUM_SANS_SANDBOX=1` sous root) : la résolution se juge contre Chromium, pas contre la norme lue de mémoire.
 *
 * Usage : node scripts/mutants-cartes-import.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const AJ = 'src/moteur/analyse-js.js';
const I = 'src/contexte/inventaire.js';
const IL = 'src/regles/c-illisibles.js';
const TESTS_DESIGNATION = ['tests/code-illisible.test.mjs', 'tests/surface-code-charge.test.mjs', 'tests/plafonds-surface.test.mjs'];
const TESTS_CHROMIUM = ['tests/carte-import-chromium.test.mjs'];

/** Une chaîne qui s'étend sur plusieurs lignes : `[fichier, chaîne d'origine, chaîne mutée, libellé]`. */
const brut = (fichier, ancien, nouveau, libelle) => [fichier, ancien, nouveau, libelle];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // La table d'une carte : les clés normalisées comme Chromium le fait ---------------------------------------------------------
  dansLigne(AJ, "const PROTOCOLES_SPECIAUX = new Set(", "'https:', ", '', 'carte d\'import : une clé de préfixe en https ne s\'applique pas'),
  dansLigne(AJ, "const PROTOCOLES_SPECIAUX = new Set(", "'http:', ", '', 'carte d\'import : une clé de préfixe en http ne s\'applique pas'),
  dansLigne(AJ, "const PROTOCOLES_SPECIAUX = new Set(", "'ws:', ", '', 'carte d\'import : une clé de préfixe en ws ne s\'applique pas'),
  dansLigne(AJ, "const PROTOCOLES_SPECIAUX = new Set(", "'wss:', ", '', 'carte d\'import : une clé de préfixe en wss ne s\'applique pas'),
  dansLigne(AJ, "const PROTOCOLES_SPECIAUX = new Set(", "'ftp:', ", '', 'carte d\'import : une clé de préfixe en ftp ne s\'applique pas'),
  dansLigne(AJ, "const PROTOCOLES_SPECIAUX = new Set(", ", 'file:'", '', 'carte d\'import : une clé de préfixe en file ne s\'applique pas'),
  dansLigne(AJ, "const PROTOCOLES_SPECIAUX = new Set(", "'http:', ", "'data:', 'http:', ", 'carte d\'import : une adresse data: est d\'un schéma spécial'),
  dansLigne(AJ, 'if (cle === \'\') continue;', 'cle === \'\'', 'false', 'carte d\'import : une clé vide est une clé comme une autre'),
  dansLigne(AJ, 'const normalisee = urlDeCarte(cle, s.baseBrute, cheminPage)?.href ?? cle;', 'urlDeCarte(cle, s.baseBrute, cheminPage)?.href ?? cle', 'cle', 'carte d\'import : une clé qui est une adresse ne se compare pas résolue'),
  dansLigne(AJ, 'let adresse = typeof valeur === \'string\' ?', 'typeof valeur === \'string\'', 'true', 'carte d\'import : une adresse qui n\'est pas une chaîne est une adresse'),
  dansLigne(AJ, 'let adresse = typeof valeur === \'string\' ?', 'urlDeCarte(valeur, s.baseBrute, cheminPage)', 'urlDe(valeur, s.baseBrute, cheminPage)', 'carte d\'import : une adresse nue est une adresse relative'),
  dansLigne(AJ, "if (adresse && cle.endsWith('/') && !adresse.href.endsWith('/')) adresse = null;", " && !adresse.href.endsWith('/')", '', 'carte d\'import : l\'adresse d\'une clé de préfixe n\'a pas à finir par une barre'),
  dansLigne(AJ, "if (adresse && cle.endsWith('/') && !adresse.href.endsWith('/')) adresse = null;", "adresse && cle.endsWith('/')", 'adresse && cle.endsWith(\'.js\')', 'carte d\'import : une clé qui ne finit pas par une barre exige aussi une adresse à barre'),
  dansLigne(AJ, 'propres.set(normalisee, adresse);', 'propres.set(normalisee, adresse);', 'if (!propres.has(normalisee)) propres.set(normalisee, adresse);', 'carte d\'import : de deux clés qui se normalisent pareil, la première l\'emporte'),
  dansLigne(AJ, 'for (const [cle, adresse] of propres) if (!table.entrees.has(cle))', 'if (!table.entrees.has(cle)) ', '', 'carte d\'import : la dernière carte qui nomme une clé l\'emporte'),

  // Ce qu'une table rend d'un nom -----------------------------------------------------------------------------------------------
  dansLigne(AJ, 'if (table.entrees.has(normalise)) return table.entrees.get(normalise);', 'table.entrees.has(normalise)', 'false', 'carte d\'import : la clé exacte ne passe pas avant le préfixe'),
  dansLigne(AJ, 'if (!special) return undefined;', '!special', 'false', 'carte d\'import : une adresse d\'un schéma non spécial s\'apparie à un préfixe'),
  dansLigne(AJ, 'if (!normalise.startsWith(cle)) continue;', 'normalise.startsWith(cle)', 'normalise.includes(cle)', 'carte d\'import : un préfixe peut être au milieu du nom'),
  dansLigne(AJ, 'if (adresse === null) return null;', 'return null;', 'continue;', 'carte d\'import : un préfixe bloqué laisse la main à un préfixe plus court'),
  dansLigne(AJ, 'return url.href.startsWith(adresse.href) ? url : null;', 'url.href.startsWith(adresse.href) ? url : null', 'url', 'carte d\'import : un nom qui sort du dossier du préfixe par `..` est résolu'),
  dansLigne(AJ, "const special = enAdresse === null || PROTOCOLES_SPECIAUX.has(enAdresse.protocol);", 'enAdresse === null || ', '', 'carte d\'import : un nom nu est un schéma d\'adresse'),
  dansLigne(AJ, "const special = enAdresse === null || PROTOCOLES_SPECIAUX.has(enAdresse.protocol);", 'PROTOCOLES_SPECIAUX.has(enAdresse.protocol)', 'true', 'carte d\'import : toute adresse est d\'un schéma spécial'),
  dansLigne(AJ, 'table.prefixes = [...table.entrees.keys()].filter(', '.filter((cle) => cle.endsWith(\'/\'))', '', 'carte d\'import : toute clé est un préfixe'),
  dansLigne(AJ, 'table.prefixes = [...table.entrees.keys()].filter(', '(a, b) => b.length - a.length', '(a, b) => a.length - b.length', 'carte d\'import : le plus court préfixe l\'emporte'),

  // Les cartes, les portées, le référent ----------------------------------------------------------------------------------------
  dansLigne(AJ, 'ajouterALaTable(imports, carte?.imports, s, cheminPage);', 'ajouterALaTable(imports, carte?.imports, s, cheminPage);', '', 'carte d\'import : les noms de `imports` ne sont pas lus'),
  dansLigne(AJ, 'ajouterALaTable(table, source, s, cheminPage);', 'ajouterALaTable(table, source, s, cheminPage);', '', 'carte d\'import : les noms des portées ne sont pas lus'),
  dansLigne(AJ, 'if (imports.entrees.size === 0 && blocs.size === 0) return null;', 'imports.entrees.size === 0 && blocs.size === 0', 'imports.entrees.size === 0 || blocs.size === 0', 'carte d\'import : une carte sans portée n\'a pas de résolveur'),
  dansLigne(AJ, 'if (imports.entrees.size === 0 && blocs.size === 0) return null;', 'imports.entrees.size === 0 && blocs.size === 0', 'false', 'carte d\'import : une carte sans aucune clé a un résolveur'),
  dansLigne(AJ, 'const cartes = cartesDeLaPage(contenu).filter(', " && !(sans === 'standard' && s.seulementStandard)", '', 'carte d\'import : une carte que Chromium n\'applique pas (standard) résout des noms'),
  dansLigne(AJ, 'const cartes = cartesDeLaPage(contenu).filter(', "!(sans === 'gabarit' && s.dansTemplate) && ", '', 'carte d\'import : une carte de gabarit résout des noms avant son rendu'),
  dansLigne(AJ, 'const cle = urlDe(prefixe, s.baseBrute, cheminPage)?.href;', 'urlDe(prefixe, s.baseBrute, cheminPage)?.href', 'prefixe', 'carte d\'import : le préfixe d\'une portée ne se résout pas contre la page'),
  dansLigne(AJ, "if (!liste) duReferent.set(href, liste = portees.filter(", "prefixe === href || ", '', 'carte d\'import : une portée sans barre finale vaut pour tout le dossier, non pour l\'adresse exacte'),
  dansLigne(AJ, "if (!liste) duReferent.set(href, liste = portees.filter(", "prefixe.endsWith('/') && ", '', 'carte d\'import : une portée sans barre finale vaut aussi pour les modules du dossier'),
  dansLigne(AJ, 'const parPortee = blocsDe(baseDe(baseBrute, chemin).url.href)', 'baseDe(baseBrute, chemin).url.href', 'new URL(chemin, \'http://widget.local/\').href', 'carte d\'import : la base d\'un script de page ne compte pas pour ses portées'),
  dansLigne(AJ, 'if (parPortee.length > 0) return', 'parPortee.length > 0', 'parPortee.length > 1', 'carte d\'import : une seule portée qui nomme le nom ne ferme pas la résolution'),
  dansLigne(AJ, 'if (parPortee.length > 0) return', '.filter(Boolean)', '', 'carte d\'import : une portée qui bloque le nom plante la résolution'),
  dansLigne(AJ, 'if (trouve !== undefined) return trouve ? [trouve] : [];', 'trouve ? [trouve] : []', '[trouve]', 'carte d\'import : un nom que les `imports` bloquent donne une adresse vide'),
  dansLigne(AJ, 'return enAdresse ? [enAdresse] : [];', 'enAdresse ? [enAdresse] : []', '[]', 'carte d\'import : une adresse qu\'aucune clé ne remappe ne se résout pas'),
  dansLigne(AJ, 'return enAdresse ? [enAdresse] : [];', 'enAdresse ? [enAdresse] : []', 'enAdresse ? [enAdresse] : [urlDeCarte(specificateur, baseBrute, chemin) ?? new URL(\'http://widget.local/\')]', 'carte d\'import : un nom nu qu\'aucune clé ne nomme se résout en adresse'),

  // Ce que la surface fait des noms ---------------------------------------------------------------------------------------------
  dansLigne(I, 'const cle = `${deDonnees ? 1 : 0}${specificateur}`;', '${deDonnees ? 1 : 0}', '', 'noms importés : un import de données et un import de code du même nom n\'en font qu\'un'),
  brut(I, "            (deDonnees ? donnees : module)(n.source.value);\n            nom(n.source.value, deDonnees);\n", "            (deDonnees ? donnees : module)(n.source.value);\n", 'noms importés : un import statique ne donne pas son nom'),
  brut(I, "            (deDonnees ? donnees : module)(valeur);\n            nom(valeur, deDonnees);\n", "            (deDonnees ? donnees : module)(valeur);\n", 'noms importés : un import() littéral ne donne pas son nom'),
  dansLigne(I, '// lus par expressions régulières, les noms peuvent être dans un commentaire ou une chaîne', 'refs = [];', 'refs = []; specificateurs = [];', 'noms importés : un arbre que le parcours ne porte pas perd les noms qu\'il a déjà donnés'),
  dansLigne(I, 'specificateurs.push({ ...specificateur, chemin: f.chemin, baseBrute: s.baseBrute, page: f.chemin,', 'page: f.chemin,', 'page: null,', 'noms importés : le nom d\'un script de page vaut pour la carte de toute page'),
  dansLigne(I, 'specificateurs.push({ ...specificateur, chemin: f.chemin, baseBrute: s.baseBrute, page: f.chemin,', 'baseBrute: s.baseBrute,', 'baseBrute: null,', 'noms importés : un script de page ne se résout pas sous la `<base>` qui le précède'),
  dansLigne(I, 'specificateurs.push({ ...specificateur, chemin: f.chemin, baseBrute: s.baseBrute, page: f.chemin,', 'gabarit: Boolean(s.dansTemplate)', 'gabarit: false', 'noms importés : le nom d\'un script de gabarit est résolu avant le rendu'),
  dansLigne(I, 'specificateurs.push({ ...specificateur, chemin: f.chemin, baseBrute: s.baseBrute, page: f.chemin,', 'standard: Boolean(s.seulementStandard)', 'standard: false', 'noms importés : le nom d\'un script que Chromium n\'exécute pas est résolu'),
  dansLigne(I, 'specificateurs.push({ ...specificateur, chemin: f.chemin, baseBrute: null, page: null,', 'page: null,', 'page: f.chemin,', 'noms importés : le nom d\'un fichier n\'est résolu que par la carte de sa propre page'),
  dansLigne(I, 'liste.specificateurs = refs.specificateurs;', 'liste.specificateurs = refs.specificateurs;', 'liste.specificateurs = [];', 'noms importés : les noms d\'un fichier ne parviennent pas à la surface'),
  dansLigne(I, 'if (nom.donnees || (evite && nom[evite]) ||', 'nom.donnees || ', '', 'noms importés : un import de données par un nom désigne du code'),
  dansLigne(I, 'if (nom.donnees || (evite && nom[evite]) ||', '(evite && nom[evite]) || ', '', 'noms importés : un nom que la réserve écarte désigne quand même'),
  dansLigne(I, 'if (nom.donnees || (evite && nom[evite]) ||', '(nom.page !== null && nom.page !== carte.page)', 'false', 'noms importés : la carte d\'une autre page résout le nom d\'un script de page'),
  dansLigne(I, 'if (!depenserPasDocuments(1 + carte.resolveur.taille)) return;', 'if (!depenserPasDocuments(1 + carte.resolveur.taille)) return;', '', 'noms importés : la résolution ne coûte aucun pas d\'analyse de document'),
  dansLigne(I, 'if (!depenserPasDocuments(1 + carte.resolveur.taille)) return;', '1 + carte.resolveur.taille', '1', 'noms importés : la résolution ne coûte que son pas, non la taille de la carte'),
  dansLigne(I, '        if (chemin === null) continue;\n'.trimEnd(), 'chemin === null', 'chemin !== null', 'noms importés : seule une adresse hors du widget désigne un fichier'),
  dansLigne(I, 'if (trouver(candidat)) mettre(candidat, true, true);', 'mettre(candidat, true, true)', 'mettre(candidat, true, false)', 'noms importés : le fichier qu\'un nom désigne n\'est pas désigné'),
  dansLigne(I, 'if (trouver(candidat)) mettre(candidat, true, true);', 'mettre(candidat, true, true)', "mettre(candidat, true, 'probable')", 'noms importés : le fichier qu\'un nom désigne ne l\'est que probablement'),
  dansLigne(I, 'if (trouver(candidat)) mettre(candidat, true, true);', 'mettre(candidat, true, true)', 'mettre(candidat, false, true)', 'noms importés : le fichier qu\'un nom désigne n\'est pas du code atteint'),
  dansLigne(I, "if (['.html', '.htm'].includes(f.ext) && !pagesAvecCarte.has(rel)) {", ' && !pagesAvecCarte.has(rel)', '', 'noms importés : une page relue compte de nouveau sa carte'),
  dansLigne(I, 'const resolveur = resolveurDePage(rel, f, evite);', 'resolveurDePage(rel, f, evite)', 'resolveurDePage(rel, f, null)', 'noms importés : les réserves du gabarit ne s\'appliquent pas à la carte de la page'),
  dansLigne(I, 'for (const nom of noms) appliquer(carte, nom);', 'for (const nom of noms) appliquer(carte, nom);', '', 'noms importés : les noms vus avant la page ne sont pas résolus par sa carte'),
  dansLigne(I, 'for (const carte of cartes) appliquer(carte, nom);', 'for (const carte of cartes) appliquer(carte, nom);', '', 'noms importés : les noms vus après la page ne sont pas résolus par sa carte'),
  dansLigne(I, 'const cle = `${nom.chemin}\\0${nom.page ?? \'\'}', '${nom.chemin}\\0', '', 'noms importés : deux fichiers qui importent le même nom se confondent'),
  dansLigne(I, 'const cle = `${nom.chemin}\\0${nom.page ?? \'\'}', '${nom.baseBrute ?? \'\'}\\0', '', 'noms importés : deux scripts de page sous deux `<base>` se confondent'),

  // Les textes du constat ---------------------------------------------------------------------------------------------------------
  dansLigne(IL, 'remediation: cause.remediation,', 'cause.remediation', 'CAUSES_ILLISIBLE.syntaxe.remediation', 'C-SURFACE-03 : une erreur de l\'outil sur un code lisible conseille de réécrire le code'),
  dansLigne(IL, 'remediation: [...new Set(reste.map((n) => CAUSES_ILLISIBLE[n.cause].remediation))].join', '[...new Set(reste.map((n) => CAUSES_ILLISIBLE[n.cause].remediation))]', 'reste.map((n) => CAUSES_ILLISIBLE[n.cause].remediation)', 'C-SURFACE-03 : le groupe répète la même remédiation autant de fois qu\'il regroupe de fichiers'),
  dansLigne(IL, 'remediation: [...new Set(reste.map((n) => CAUSES_ILLISIBLE[n.cause].remediation))].join', 'reste.map((n) => CAUSES_ILLISIBLE[n.cause].remediation)', '[CAUSES_ILLISIBLE[reste[0].cause].remediation]', 'C-SURFACE-03 : le groupe ne donne que la remédiation de son premier fichier'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de la désignation par carte d\'import', fichiers: TESTS_DESIGNATION }, { nom: 'différentiel contre Chromium', fichiers: TESTS_CHROMIUM }],
  exigerChromium: true,
  partie,
});
