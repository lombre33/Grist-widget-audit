#!/usr/bin/env node
/**
 * Rejoue les mutants de la règle de licence (`src/regles/e-dependances.js`, méthode : `scripts/lib/rejouer-mutants.mjs`) : les noms qu'on prend pour une
 * licence (`LICENSE`, `LICENCE`, `COPYING`, `UNLICENSE`, une extension, `LICENSE-MIT`, le dossier `LICENSES/`), ce qu'on n'en prend pas (un dossier, une sauvegarde), la licence qu'on cite quand il y en a
 * plusieurs, la fenêtre lue et le type reconnu (avec l'ordre où on les essaie), la sévérité, la taille dite, et la licence dont l'outil n'a pas lu le
 * texte (présente, d'un type non identifié, sans échec). Chaque mutant est tué par une assertion de `tests/e-licence.test.mjs`. Les essais de
 * `tests/fichiers-non-lus-regles.test.mjs` n'ont pas de mutant : ils gardent une famille de défauts (une règle, quelle qu'elle soit, qui lirait le texte
 * d'un fichier non lu), pas une ligne.
 *
 * Mutant équivalent, non écrit : `LICENSES\/[^/]+` à `LICENSES\/[^/]*` dans le nom d'une licence : le chemin d'un fichier ne finit jamais par `/`, un nom vide du dossier n'existe pas.
 *
 * Usage : node scripts/mutants-licence.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const E = 'src/regles/e-dependances.js';
const NOM = 'const NOM_DE_LICENCE =';
const TYPE = 'const type = /MIT License/i';
const FILTRE = '.filter((f) => NOM_DE_LICENCE.test(f.chemin))';
const TRI = '.sort((a, b) => rangDeLicence(a)';
const L1 = "regle: 'E-LIC-01'";
const L2 = "regle: 'E-LIC-02'";
const TAILLE = '`Fichier de licence présent (';
const IMPACT_GPL = "impact: type === 'GPL/AGPL'";
const NOM_GPL = 'const NOM_GPL = ';
const NOM_LGPL = 'const NOM_LGPL = ';
const PLACE = 'const placeDe = ';
const CHOIX_LGPL = "placeDe(NOM_LGPL, t) < placeDe(NOM_GPL, t) ? 'LGPL'";
const CHOIX_GPL = ": NOM_GPL.test(t) ? 'GPL/AGPL'";

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- le nom d'une licence
  dansLigne(E, NOM, '^(?:', '(?:', 'nom : un nom qui contient LICENSE n\'importe où est une licence (MYLICENSE)'),
  dansLigne(E, NOM, ')$/i', ')/i', 'nom : un nom qui commence par LICENSE est une licence (LICENSEE, LICENSE.md.bak)'),
  dansLigne(E, NOM, ')$/i', ')$/', 'nom : la casse compte (license, License.TXT)'),
  dansLigne(E, NOM, '(?:LICEN[SC]E|COPYING|UNLICENSE)', '(?:LICENSE|COPYING|UNLICENSE)', 'nom : LICENCE n\'est pas une licence'),
  dansLigne(E, NOM, '(?:LICEN[SC]E|COPYING|UNLICENSE)', '(?:LICENCE|COPYING|UNLICENSE)', 'nom : LICENSE n\'est pas une licence'),
  dansLigne(E, NOM, '|COPYING|UNLICENSE)', '|UNLICENSE)', 'nom : COPYING n\'est pas une licence'),
  dansLigne(E, NOM, '|UNLICENSE)(?:', ')(?:', 'nom : UNLICENSE n\'est pas une licence'),
  dansLigne(E, NOM, '(?:\\.[a-z]+)?|(?:LICEN', '(?:\\.[a-z]+)|(?:LICEN', 'nom : une licence sans extension n\'est pas une licence'),
  dansLigne(E, NOM, '(?:\\.[a-z]+)?|(?:LICEN', '(?:\\.[a-z])?|(?:LICEN', 'nom : une extension de plus d\'une lettre n\'est pas une extension (LICENSE.md)'),
  dansLigne(E, NOM, '(?:\\.[a-z]+)?|(?:LICEN', '(?:\\.[a-z]+)*|(?:LICEN', 'nom : plusieurs extensions sont une extension (LICENSE.md.bak)'),
  // une double licence : un nom de licence ou une version après un tiret ou un souligné
  dansLigne(E, NOM, '(?:LICEN[SC]E|COPYING)[-_]', '(?:LICENSE|COPYING)[-_]', 'nom : LICENCE-MIT n\'est pas une licence'),
  dansLigne(E, NOM, '(?:LICEN[SC]E|COPYING)[-_]', '(?:LICENCE|COPYING)[-_]', 'nom : LICENSE-MIT n\'est pas une licence'),
  dansLigne(E, NOM, '(?:LICEN[SC]E|COPYING)[-_]', '(?:LICEN[SC]E)[-_]', 'nom : COPYING-MIT n\'est pas une licence'),
  dansLigne(E, NOM, '[-_](?:MIT', '[-](?:MIT', 'nom : LICENSE_MIT n\'est pas une licence'),
  dansLigne(E, NOM, '[-_](?:MIT', '[_](?:MIT', 'nom : LICENSE-MIT n\'est pas une licence, bis'),
  dansLigne(E, NOM, '(?:MIT|', '(?:', 'nom : LICENSE-MIT n\'est pas une licence, ter'),
  ...['APACHE', 'BSD', 'GPL', 'LGPL', 'AGPL', 'MPL', 'EUPL', 'ISC', 'CC0', 'ZLIB'].map((nom) => dansLigne(E, NOM, `|${nom}|`, '|', `nom : LICENSE-${nom} n'est pas une licence`)),
  dansLigne(E, NOM, '|UNLICENSE|\\d', '|\\d', 'nom : LICENSE-UNLICENSE n\'est pas une licence'),
  dansLigne(E, NOM, '\\d[\\d.]*)', '\\d)', 'nom : LICENSE-2.0 n\'est pas une licence'),
  dansLigne(E, NOM, '|\\d[\\d.]*)', '|[\\d.]*)', 'nom : LICENSE- est une licence'),
  dansLigne(E, NOM, '[\\d.]*)(?:\\.[a-z]+)?|LICENSES', '[\\d.]*)|LICENSES', 'nom : LICENSE-MIT.txt n\'est pas une licence'),
  dansLigne(E, NOM, '[\\d.]*)(?:\\.[a-z]+)?|LICENSES', '[\\d.]*)(?:\\.[a-z])?|LICENSES', 'nom : une extension de plus d\'une lettre n\'est pas une extension (LICENSE-MIT.txt)'),
  dansLigne(E, NOM, '[\\d.]*)(?:\\.[a-z]+)?|LICENSES', '[\\d.]*)(?:\\.[a-z]+)*|LICENSES', 'nom : plusieurs extensions sont une extension (LICENSE-MIT.txt.bak)'),
  // le dossier LICENSES
  dansLigne(E, NOM, '|LICENSES\\/[^/]+)', ')', 'nom : un texte du dossier LICENSES n\'est pas une licence'),
  dansLigne(E, NOM, 'LICENSES\\/[^/]+', 'LICENSES\\/.+', 'nom : un dossier du dossier LICENSES est une licence'),
  dansLigne(E, NOM, 'LICENSES\\/[^/]+', 'LICENSES[^/]+', 'nom : LICENSES/MIT.txt n\'est pas une licence'),
  dansLigne(E, NOM, '|LICENSES\\/', '|(?:.*\\/)?LICENSES\\/', 'nom : un dossier LICENSES qui n\'est pas à la racine est une licence'),

  // --- quels fichiers
  dansLigne(E, FILTRE, 'NOM_DE_LICENCE.test(f.chemin)', 'true', 'licence : tout fichier de la racine est une licence'),
  dansLigne(E, FILTRE, 'NOM_DE_LICENCE.test(f.chemin)', "NOM_DE_LICENCE.test(f.chemin.split('/').pop())", 'licence : le nom de fichier d\'un dossier est jugé comme celui de la racine'),
  dansLigne(E, 'if (!licence) {', '!licence', 'licence', 'licence : la licence manque quand il y en a une'),
  dansLigne(E, 'if (!licence) {', '!licence', 'false', 'licence : jamais de E-LIC-01'),

  // --- laquelle est citée
  dansLigne(E, 'const rangDeLicence =', '? 0 : 1', '? 1 : 0', 'licence : le fichier non lu passe avant le fichier lu'),
  dansLigne(E, 'const rangDeLicence =', '? 0 : 1', '? 0 : 0', 'licence : un fichier lu ne passe pas avant un fichier non lu'),
  dansLigne(E, TRI, 'rangDeLicence(a) - rangDeLicence(b)', 'rangDeLicence(b) - rangDeLicence(a)', 'licence : le fichier non lu passe avant le fichier lu (tri)'),
  dansLigne(E, TRI, '(a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0)', '(a.chemin < b.chemin ? 1 : a.chemin > b.chemin ? -1 : 0)', 'licence : les noms se rangent à l\'envers'),
  dansLigne(E, TRI, '|| (a.chemin', '&& (a.chemin', 'licence : les noms ne départagent plus les fichiers de même rang'),
  dansLigne(E, TRI, ')[0];', ').at(-1);', 'licence : on cite la dernière'),
  dansLigne(E, 'const estLu =', "typeof f.contenu === 'string'", 'true', 'licence : un fichier dont le texte n\'est pas lu est lu'),
  dansLigne(E, 'const estLu =', "typeof f.contenu === 'string'", 'f.contenu', 'licence : une licence vide n\'est pas lue'),

  // --- la fenêtre lue
  dansLigne(E, 'const t = lue ?', 'lue ?', 'true ?', 'licence : le texte d\'une licence non lue est lu'),
  dansLigne(E, 'const t = lue ?', 'lue ?', 'false ?', 'licence : le texte d\'une licence lue n\'est pas lu'),
  dansLigne(E, 'const t = lue ?', '3000', '2999', 'licence : la fenêtre lue perd un caractère'),
  dansLigne(E, 'const t = lue ?', '3000', '3001', 'licence : la fenêtre lue gagne un caractère'),
  dansLigne(E, 'const t = lue ?', "licence.contenu.slice(0, 3000) : ''", "licence.contenu.slice(0, 3000) : 'MIT License'", 'licence : une licence non lue est prise pour une MIT'),

  // --- le type
  dansLigne(E, TYPE, '/MIT License/i', '/MIT License/', 'type : MIT se reconnaît avec la casse'),
  dansLigne(E, TYPE, "? 'MIT'", "? 'mit'", 'type : MIT s\'écrit autrement'),
  dansLigne(E, ': /Apache License/i', '/Apache License/i', '/Apache License/', 'type : Apache se reconnaît avec la casse'),
  dansLigne(E, ": /Apache License/i", "? 'Apache 2.0'", "? 'Apache'", 'type : Apache s\'écrit autrement'),
  dansLigne(E, 'EUROPEAN UNION PUBLIC LICENCE|EUPL', '/i.test', '/.test', 'type : EUPL se reconnaît avec la casse'),
  dansLigne(E, 'EUROPEAN UNION PUBLIC LICENCE|EUPL', 'EUROPEAN UNION PUBLIC LICENCE|', '', 'type : « EUROPEAN UNION PUBLIC LICENCE » n\'est pas EUPL'),
  dansLigne(E, 'EUROPEAN UNION PUBLIC LICENCE|EUPL', '|EUPL', '', 'type : « EUPL » seul n\'est pas EUPL'),
  dansLigne(E, NOM_GPL, '(AFFERO )?', '', 'type : la GNU AFFERO GENERAL PUBLIC LICENSE n\'est pas reconnue'),
  dansLigne(E, NOM_GPL, '(AFFERO )?', '(AFFERO )', 'type : la GNU GENERAL PUBLIC LICENSE n\'est pas reconnue'),
  dansLigne(E, NOM_GPL, '/i;', '/;', 'type : la GPL se reconnaît avec la casse'),
  dansLigne(E, CHOIX_GPL, "? 'GPL/AGPL'", "? 'GPL'", 'type : la GPL s\'écrit autrement'),
  dansLigne(E, NOM_LGPL, '(LESSER|LIBRARY)', '(LESSER)', 'type : la GNU LIBRARY GENERAL PUBLIC LICENSE n\'est pas reconnue'),
  dansLigne(E, NOM_LGPL, '(LESSER|LIBRARY)', '(LIBRARY)', 'type : la GNU LESSER GENERAL PUBLIC LICENSE n\'est pas reconnue'),
  dansLigne(E, NOM_LGPL, '/i;', '/;', 'type : la LGPL se reconnaît avec la casse'),
  dansLigne(E, CHOIX_LGPL, "? 'LGPL'", "? 'GPL/AGPL'", 'type : la LGPL est une GPL'),
  dansLigne(E, CHOIX_LGPL, "? 'LGPL'", "? 'lgpl'", 'type : la LGPL s\'écrit autrement'),
  // La GPL et la LGPL se citent l'une l'autre : le nom qui vient d'abord, le titre, décide.
  dansLigne(E, CHOIX_LGPL, 'placeDe(NOM_LGPL, t) < placeDe(NOM_GPL, t)', 'NOM_LGPL.test(t)', 'type : une GPL qui cite la LGPL est une LGPL'),
  dansLigne(E, CHOIX_LGPL, 'placeDe(NOM_LGPL, t) < placeDe(NOM_GPL, t)', 'NOM_LGPL.test(t) && !NOM_GPL.test(t)', 'type : une LGPL qui cite la GPL est une GPL'),
  dansLigne(E, CHOIX_LGPL, 'placeDe(NOM_LGPL, t) < placeDe(NOM_GPL, t)', 'placeDe(NOM_LGPL, t) > placeDe(NOM_GPL, t)', 'type : le nom qui vient en dernier est le titre'),
  dansLigne(E, CHOIX_LGPL, 'placeDe(NOM_LGPL, t) < placeDe(NOM_GPL, t)', 'placeDe(NOM_LGPL, t) <= placeDe(NOM_GPL, t)', 'type : sans nom de la GPL ni de la LGPL, la LGPL'),
  dansLigne(E, PLACE, 'Infinity', '0', 'type : un nom absent est à la place 0'),
  dansLigne(E, PLACE, 'Infinity', '-1', 'type : un nom absent est avant tous les autres'),
  dansLigne(E, PLACE, 'i === -1', 'i === 0', 'type : un nom en tête du texte est absent'),
  dansLigne(E, ": /BSD/i.test(t)", '/BSD/i', '/BSD/', 'type : BSD se reconnaît avec la casse'),
  dansLigne(E, ": /BSD/i.test(t)", "'non identifiée'", "'BSD'", 'type : ce qu\'on ne reconnaît pas est BSD'),
  // L'ordre : le premier de la liste l'emporte, où que les noms soient dans le texte.
  dansLigne(E, TYPE, "/MIT License/i.test(t) ?", "/MIT License/i.test(t) && !/Apache License/i.test(t) ?", 'type : Apache passe avant MIT'),
  dansLigne(E, ': /Apache License/i', "/Apache License/i.test(t) ?", "/Apache License/i.test(t) && !/EUPL/i.test(t) ?", 'type : EUPL passe avant Apache'),
  dansLigne(E, 'EUROPEAN UNION PUBLIC LICENCE|EUPL', "/i.test(t) ?", "/i.test(t) && !/GNU (AFFERO )?GENERAL PUBLIC/i.test(t) ?", 'type : la GPL passe avant EUPL'),
  dansLigne(E, CHOIX_GPL, ': NOM_GPL.test(t) ?', ': NOM_GPL.test(t) && !/BSD/i.test(t) ?', 'type : BSD passe avant la GPL'),
  dansLigne(E, TYPE, "/MIT License/i.test(t) ?", "/MIT License/i.test(t) && !/GNU (LESSER|LIBRARY) GENERAL PUBLIC/i.test(t) ?", 'type : la LGPL passe avant MIT'),
  dansLigne(E, ': /Apache License/i', "/Apache License/i.test(t) ?", "/Apache License/i.test(t) && !/GNU (LESSER|LIBRARY) GENERAL PUBLIC/i.test(t) ?", 'type : la LGPL passe avant Apache'),
  dansLigne(E, 'EUROPEAN UNION PUBLIC LICENCE|EUPL', "/i.test(t) ?", "/i.test(t) && !/GNU (LESSER|LIBRARY) GENERAL PUBLIC/i.test(t) ?", 'type : la LGPL passe avant EUPL'),
  dansLigne(E, CHOIX_LGPL, 'placeDe(NOM_LGPL, t) < placeDe(NOM_GPL, t) ?', 'placeDe(NOM_LGPL, t) < placeDe(NOM_GPL, t) && !/BSD/i.test(t) ?', 'type : BSD passe avant la LGPL'),

  // --- E-LIC-01
  dansLigne(E, L1, "severite: 'majeur'", "severite: 'mineur'", 'E-LIC-01 : n\'est que mineur'),
  dansLigne(E, L1, 'bloquant: true', 'bloquant: false', 'E-LIC-01 : n\'est pas bloquant'),
  dansLigne(E, L1, "confiance: 'certain'", "confiance: 'probable'", 'E-LIC-01 : n\'est que probable'),
  dansLigne(E, "titre: 'Aucun fichier de licence à la racine'", 'Aucun fichier', 'Un fichier', 'E-LIC-01 : le titre dit l\'inverse'),
  dansLigne(E, 'impact: "Sans licence explicite', "droit d'auteur par défaut", 'droit', 'E-LIC-01 : l\'impact ne dit plus le droit d\'auteur'),
  dansLigne(E, 'remediation: "Ajouter une licence libre', 'EUPL 1.2', 'EUPL', 'E-LIC-01 : la remédiation ne cite plus l\'EUPL 1.2'),

  // --- E-LIC-02
  dansLigne(E, L2, "'mineur' : 'info'", "'info' : 'mineur'", 'E-LIC-02 : la sévérité est inversée'),
  dansLigne(E, L2, "'mineur' : 'info'", "'mineur' : 'mineur'", 'E-LIC-02 : un type reconnu est mineur'),
  dansLigne(E, L2, "'mineur' : 'info'", "'info' : 'info'", 'E-LIC-02 : un type non identifié est info'),
  dansLigne(E, L2, "type === 'non identifiée'", "type === 'GPL/AGPL'", 'E-LIC-02 : la GPL est mineure, un type non identifié est info'),
  dansLigne(E, L2, "confiance: 'certain'", "confiance: 'probable'", 'E-LIC-02 : n\'est que probable'),
  dansLigne(E, 'fichier: licence.chemin', 'licence.chemin', "'LICENSE'", 'E-LIC-02 : le constat cite toujours LICENSE'),
  dansLigne(E, 'titre: `Licence du dépôt : ${type}`', 'Licence du dépôt', 'Licence', 'E-LIC-02 : le titre ne dit plus « du dépôt »'),
  dansLigne(E, 'constat: lue', 'lue', '!lue', 'E-LIC-02 : le texte d\'une licence lue dit qu\'elle n\'est pas lue'),
  dansLigne(E, TAILLE, 'Math.round(licence.taille / 1024)', 'Math.floor(licence.taille / 1024)', 'E-LIC-02 : la taille est arrondie à l\'inférieur'),
  dansLigne(E, TAILLE, 'Math.round(licence.taille / 1024)', 'Math.ceil(licence.taille / 1024)', 'E-LIC-02 : la taille est arrondie au supérieur'),
  dansLigne(E, TAILLE, '/ 1024', '/ 1000', 'E-LIC-02 : le Ko vaut mille octets'),
  dansLigne(E, TAILLE, 'type détecté : ', 'type : ', 'E-LIC-02 : le texte ne dit plus « détecté »'),
  dansLigne(E, "n'a pas lu le texte", "n'a pas lu le texte", 'a lu le texte', 'E-LIC-02 : le texte d\'une licence non lue dit qu\'elle est lue'),
  dansLigne(E, IMPACT_GPL, "'GPL/AGPL'", "'BSD'", 'E-LIC-02 : la GPL a l\'impact des licences compatibles'),
  dansLigne(E, 'Licence à effet contaminant', 'effet contaminant', 'effet', 'E-LIC-02 : l\'impact de la GPL ne dit plus l\'effet contaminant'),
  dansLigne(E, ": type === 'LGPL'", "'LGPL'", "'MIT'", 'E-LIC-02 : la LGPL a l\'impact des licences compatibles'),
  dansLigne(E, 'Licence à copyleft faible', 'copyleft faible', 'copyleft', 'E-LIC-02 : l\'impact de la LGPL ne dit plus le copyleft faible'),
  dansLigne(E, 'à vérifier manuellement', 'à vérifier manuellement', 'rien à vérifier', 'E-LIC-02 : l\'impact d\'un type non identifié ne dit plus de vérifier'),
  dansLigne(E, "'Licence compatible avec un fork", 'compatible avec un fork', 'sans fork', 'E-LIC-02 : l\'impact d\'une licence reconnue ne dit plus qu\'elle est compatible'),
  dansLigne(E, 'remediation: !lue', '!lue', 'lue', 'E-LIC-02 : la remédiation d\'une licence non lue est celle d\'une licence lue'),
  dansLigne(E, 'remediation: !lue', 'Fournir le texte de la licence', 'Ajouter une licence', 'E-LIC-02 : la remédiation d\'une licence non lue ne dit plus de la fournir en texte'),
  dansLigne(E, ": type === 'non identifiée' ? \"Utiliser le texte standard", "type === 'non identifiée'", "type === 'MIT'", 'E-LIC-02 : la remédiation d\'un type non identifié est « rien à corriger »'),
  dansLigne(E, ": type === 'non identifiée' ? \"Utiliser le texte standard", "'Rien à corriger.'", "'Utiliser le texte standard.'", 'E-LIC-02 : la remédiation d\'une licence reconnue demande une correction'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests de la licence', fichiers: ['tests/e-licence.test.mjs'] }],
  exigerChromium: false,
  partie,
  delaiMs: 90_000,
});
