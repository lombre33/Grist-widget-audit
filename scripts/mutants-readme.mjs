#!/usr/bin/env node
/**
 * Rejoue les mutants de la reconnaissance du README (`src/regles/b-lisibilite.js`, méthode : `scripts/lib/rejouer-mutants.mjs`) : les noms qu'on
 * prend pour un README (`README`, `LISEZMOI`, la langue, l'extension), ce qu'on n'en prend pas (un dossier, une image, une sauvegarde), le README
 * qu'on cite, les rubriques cherchées dans tous les README, le README dont aucun texte n'est lu.
 * Chaque mutant est tué par une assertion de `tests/b-doc-readme.test.mjs`, sauf un.
 *
 * Mutant qui ne se voit qu'au temps : `[^\S\n]*` remplacé par `\s*` (la recherche d'un titre relit alors toute la suite de lignes vides depuis
 * chacune : quadratique). Aucun essai ne juge le temps ; les README piégés de `tests/b-doc-readme-pieges.test.mjs` (seuls dans leur fichier, pour
 * qu'un mutant qui ne s'arrête plus ne cache pas les essais qui jugent les autres) ne s'arrêtent plus avec ce mutant, et le délai du rejeu le
 * tue : le bilan le dit (« par un délai »).
 *
 * Usage : node scripts/mutants-readme.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const B = 'src/regles/b-lisibilite.js';
const TESTS = ['tests/b-doc-readme.test.mjs'];
const TESTS_PIEGES = ['tests/b-doc-readme-pieges.test.mjs'];
const NOM = 'const NOM_DE_README =';

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- le nom d'un README
  dansLigne(B, NOM, '^(?:readme|lisez', '(?:readme|lisez', 'nom : un nom qui contient README n\'importe où est un README (mon-readme.md, docs/README.md)'),
  dansLigne(B, NOM, ')?$/i', ')?/i', 'nom : un nom qui commence par README est un README (README.md.bak)'),
  dansLigne(B, NOM, '|lisez[-_]?moi', '', 'nom : LISEZMOI n\'est pas un README'),
  dansLigne(B, NOM, 'lisez[-_]?moi', 'lisezmoi', 'nom : LISEZ-MOI et LISEZ_MOI ne sont pas des README'),
  dansLigne(B, NOM, 'lisez[-_]?moi', 'lisez-?moi', 'nom : LISEZ_MOI n\'est pas un README'),
  dansLigne(B, NOM, 'lisez[-_]?moi', 'lisez_?moi', 'nom : LISEZ-MOI n\'est pas un README'),
  dansLigne(B, NOM, '$/i', '$/', 'nom : la casse compte (Readme.MD, LISEZMOI)'),
  dansLigne(B, NOM, '(?:readme|', '(?:readme.|', 'nom : README prend un caractère de plus'),
  dansLigne(B, NOM, '[._-](?:[a-z]{2}', '[.](?:[a-z]{2}', 'nom : README_fr.md et README-fr.md ne sont pas des README'),
  dansLigne(B, NOM, '[._-](?:[a-z]{2}', '[._](?:[a-z]{2}', 'nom : README-fr.md n\'est pas un README'),
  dansLigne(B, NOM, '[._-](?:[a-z]{2}', '[.-](?:[a-z]{2}', 'nom : README_fr.md n\'est pas un README'),
  dansLigne(B, NOM, '(?:[a-z]{2}|', '(?:', 'nom : une langue de deux lettres n\'est pas une langue (README.fr.md)'),
  dansLigne(B, NOM, '|[a-z]{3}(?=\\.))', ')', 'nom : une langue de trois lettres n\'est pas une langue (README.fra.md)'),
  dansLigne(B, NOM, '[a-z]{3}(?=\\.)', '[a-z]{3}', 'nom : README.png et README.exe sont des README (trois lettres sans extension)'),
  dansLigne(B, NOM, '(?=\\.))', '(?=\\.|$))', 'nom : README.fra est un README'),
  dansLigne(B, NOM, '[a-z]{3}(?=\\.)', '[a-z]{4}(?=\\.)', 'nom : une langue de quatre lettres remplace celle de trois'),
  dansLigne(B, NOM, '[a-z]{2}|', '[a-z]{1,2}|', 'nom : une langue d\'une lettre est une langue'),
  dansLigne(B, NOM, '(?:[-_][a-z0-9]{2,8})?)?(?:\\.', ')?(?:\\.', 'nom : une région n\'est pas reconnue (README.en-US.md)'),
  dansLigne(B, NOM, '[-_][a-z0-9]{2,8}', '[-][a-z0-9]{2,8}', 'nom : README.pt_BR.md n\'est pas un README'),
  dansLigne(B, NOM, '[-_][a-z0-9]{2,8}', '[_][a-z0-9]{2,8}', 'nom : README.en-US.md n\'est pas un README'),
  dansLigne(B, NOM, '{2,8}', '{2,}', 'nom : une région de onze caractères est une région'),
  dansLigne(B, NOM, '{2,8}', '{2,9}', 'nom : une région de neuf caractères est une région'),
  dansLigne(B, NOM, '{2,8}', '{2,7}', 'nom : une région de huit caractères n\'est pas une région'),
  dansLigne(B, NOM, '{2,8}', '{1,8}', 'nom : une région d\'un caractère est une région'),
  dansLigne(B, NOM, '[a-z0-9]{2,8}', '[a-z]{2,8}', 'nom : une région avec des chiffres n\'est pas une région'),
  dansLigne(B, NOM, '(?:md|mdx', '(?:mdx', 'nom : .md n\'est pas une extension de README'),
  ...['mdx', 'markdown', 'mdown', 'mkd', 'txt', 'text', 'rst', 'adoc', 'asciidoc', 'org', 'textile'].map((ext) => dansLigne(B, NOM, `|${ext}`, '', `nom : .${ext} n'est pas une extension de README`)),
  dansLigne(B, NOM, '|html?))', '))', 'nom : .html et .htm ne sont pas des extensions de README'),
  dansLigne(B, NOM, 'html?', 'html', 'nom : .htm n\'est pas une extension de README'),
  dansLigne(B, NOM, '(?:\\.(?:md|', '(?:\\.(?:md|exe|png|pdf|', 'nom : .exe, .png et .pdf sont des extensions de README'),

  // --- quels fichiers
  // (Un mutant qui ôtait le test « pas de séparateur » du filtre a survécu : le motif, ancré, n'en accepte aucun, le test était mort ; il est retiré du code.)
  dansLigne(B, '.filter((f) => NOM_DE_README.test(f.chemin))', 'NOM_DE_README.test(f.chemin)', 'true', 'readme : tout fichier de la racine est un README'),
  dansLigne(B, '.filter((f) => NOM_DE_README.test(f.chemin))', 'NOM_DE_README.test(f.chemin)', 'NOM_DE_README.test(f.chemin.split(\'/\').pop())', 'readme : le nom de fichier d\'un dossier est jugé comme celui de la racine'),  dansLigne(B, 'if (!readmes.length) {', '!readmes.length', 'readmes.length', 'readme : le README manque quand il y en a un'),
  dansLigne(B, 'if (!readmes.length) {', '!readmes.length', 'false', 'readme : jamais de B-DOC-01'),

  // --- lequel est cité
  dansLigne(B, "const rangDeReadme = (f) =>", "=== 'readme.md' ? 0 : 1", "=== 'readme.md' ? 1 : 0", 'readme : README.md passe en dernier'),
  dansLigne(B, "const rangDeReadme = (f) =>", "=== 'readme.md' ? 0 : 1", "=== 'readme.md' ? 0 : 0", 'readme : aucun nom ne passe avant les autres'),
  dansLigne(B, "const rangDeReadme = (f) =>", '.toLowerCase()', '', 'readme : README.md en capitales n\'est pas README.md'),
  dansLigne(B, '.sort((a, b) => rangDeReadme(a) - rangDeReadme(b)', 'rangDeReadme(a) - rangDeReadme(b)', 'rangDeReadme(b) - rangDeReadme(a)', 'readme : README.md passe après les autres README'),
  dansLigne(B, '.sort((a, b) => rangDeReadme(a) - rangDeReadme(b)', '(a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0)', '(a.chemin < b.chemin ? 1 : a.chemin > b.chemin ? -1 : 0)', 'readme : les noms se rangent à l\'envers'),
  dansLigne(B, '.sort((a, b) => rangDeReadme(a) - rangDeReadme(b)', '|| (a.chemin', '&& (a.chemin', 'readme : les noms ne départagent plus les README de même rang'),
  dansLigne(B, 'const readme = lisibles[0];', 'lisibles[0]', 'readmes[0]', 'readme : le constat cite un README dont aucun texte n\'est lu'),
  dansLigne(B, 'const readme = lisibles[0];', 'lisibles[0]', 'lisibles.at(-1)', 'readme : le constat cite le dernier README'),

  // --- le texte jugé
  dansLigne(B, 'const lisibles = readmes.filter(', "typeof f.contenu === 'string'", 'true', 'readme : un README sans texte est jugé vide'),
  dansLigne(B, 'const lisibles = readmes.filter(', "typeof f.contenu === 'string'", "f.contenu", 'readme : un README vide n\'est pas lu'),
  dansLigne(B, 'if (!lisibles.length) return constats;', '!lisibles.length', 'false', 'readme : un README sans texte est jugé'),
  dansLigne(B, 'const texte = lisibles.map((f) => f.contenu)', "lisibles.map((f) => f.contenu).join('\\n')", 'readme.contenu', 'readme : seul le premier README est lu'),
  dansLigne(B, 'const texte = lisibles.map((f) => f.contenu)', ".join('\\n')", ".join('')", 'readme : deux README se collent sans fin de ligne'),
  dansLigne(B, 'const texte = lisibles.map((f) => f.contenu)', '.toLowerCase()', '', 'readme : le texte n\'est pas mis en minuscules'),

  // --- les titres
  dansLigne(B, "{ cle: 'role',", '(^|#|=|\\*|\\n)', '(#|=|\\*|\\n)', 'titre : le premier mot du fichier n\'est pas un titre'),
  dansLigne(B, "{ cle: 'role',", '(^|#|=|\\*|\\n)', '(^|=|\\*|\\n)', 'titre : un titre Markdown n\'est pas un titre'),
  dansLigne(B, "{ cle: 'role',", '(^|#|=|\\*|\\n)', '(^|#|\\*|\\n)', 'titre : un titre AsciiDoc n\'est pas un titre'),
  dansLigne(B, "{ cle: 'role',", '(^|#|=|\\*|\\n)', '(^|#|=|\\n)', 'titre : un titre Org n\'est pas un titre'),
  dansLigne(B, "{ cle: 'role',", '(^|#|=|\\*|\\n)', '(^|#|=|\\*)', 'titre : une ligne qui commence par un mot de rubrique n\'est pas un titre'),
  dansLigne(B, "{ cle: 'role',", '(^|#|=|\\*|\\n)', '(^|#|=|\\*|\\n|\\s)', 'titre : un mot de rubrique au milieu d\'une phrase est un titre'),
  dansLigne(B, "{ cle: 'role',", '[^\\S\\n]*', '\\s*', 'titre : la recherche d\'un titre relit toute la suite de lignes vides depuis chacune (quadratique)'),
  dansLigne(B, "{ cle: 'role',", '[^\\S\\n]*', '', 'titre : un titre n\'est pas précédé de blancs'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de la reconnaissance du README', fichiers: TESTS }, { nom: 'tests des README piégés', fichiers: TESTS_PIEGES }],
  exigerChromium: false,
  partie,
  delaiMs: 90_000,
});
