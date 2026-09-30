#!/usr/bin/env node
/**
 * Rejoue les mutants des petits motifs (méthode : `scripts/lib/rejouer-mutants.mjs`) :
 *   - B-IA-01 (`src/regles/b-lisibilite.js`) : le blanc de ligne des motifs (ni `\s`, ni un blanc qui franchit \r, \n, U+2028 ou
 *     U+2029), le compte et la première ligne de chaque famille, le JSDoc générique (fenêtre et type bornés à 200 caractères, un
 *     seul par commentaire, ouverture cherchée avant le `@param`, non après) ;
 *   - B-DOC-02 : la rubrique « ce que fait le widget », que reconnaît `(#|\n)[^\S\n]*` ;
 *   - A-DEV-03 (`src/regles/a-qualite.js`) : « À FAIRE » et sa borne (`MARQUEUR_INACHEVE`) ;
 *   - la borne des emplacements d'un constat (`src/moteur/modele.js`) : 500 gardés, le nombre d'omis dit.
 * Chaque mutant meurt par un essai déterministe (`tests/petits-motifs.test.mjs`) : aucun délai, aucun budget en temps réel.
 *
 * Mutant équivalent en sortie, laissé de côté : `[^\S\n]*` → `\s*` dans le motif de B-DOC-02. Le résultat est le même (la dernière fin
 * de ligne d'une suite de blancs est un départ qui convient), seul le temps change : il ne peut mourir que par un essai à budget en
 * temps réel, qui n'a pas sa place dans la suite par défaut (à ranger dans `tests/budgets/` et `scripts/mutants-budgets.mjs`).
 * Autres équivalents : `fin = m.index + m[0].length` → `fin = m.index` ne change rien tant qu'aucun `/**` n'est écrit dans le type
 * entre accolades (l'essai en met un : le mutant meurt) ; un `\b` final de `MARQUEUR_INACHEVE` serait redondant avec `[ :]` (non muté).
 *
 * Usage : node scripts/mutants-petits-motifs.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const B = 'src/regles/b-lisibilite.js';
const A = 'src/regles/a-qualite.js';
const M = 'src/moteur/modele.js';
const TESTS = ['tests/petits-motifs.test.mjs'];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- le blanc de ligne
  dansLigne(B, 'const BLANC = ', "'[^\\\\S\\\\r\\\\n\\\\u2028\\\\u2029]'", "'\\\\s'", 'B-IA-01 : `\\s`, le blanc franchit les fins de ligne'),
  dansLigne(B, 'const BLANC = ', '\\\\r', '', 'B-IA-01 : le retour chariot n\'arrête plus le blanc'),
  dansLigne(B, 'const BLANC = ', '\\\\n', '', 'B-IA-01 : le saut de ligne n\'arrête plus le blanc'),
  dansLigne(B, 'const BLANC = ', '\\\\u2028', '', 'B-IA-01 : U+2028 n\'arrête plus le blanc'),
  dansLigne(B, 'const BLANC = ', '\\\\u2029', '', 'B-IA-01 : U+2029 n\'arrête plus le blanc'),
  // --- le compte et la première ligne d'une famille
  dansLigne(B, 'for (const m of contenu.matchAll(re)) if (n++', 'n++ === 0', 'n++ === 1', 'compter : la première occurrence est la deuxième'),
  dansLigne(B, 'for (const m of contenu.matchAll(re)) if (n++', 'premier = m.index', 'premier = 0', 'compter : la première occurrence est à l\'indice 0'),
  dansLigne(B, 'if (n > 0) signaux.push(', 'n > 0', 'n >= 0', 'B-IA-01 : une famille sans occurrence est rapportée'),
  dansLigne(B, 'if (n > 0) signaux.push(', 'numeroLigne(f.contenu, premier)', '1', 'B-IA-01 : toute famille à la ligne 1'),
  dansLigne(B, 'if (n > 0) signaux.push(', 'numeroLigne(f.contenu, premier)', 'numeroLigne(f.contenu, premier) + 1', 'B-IA-01 : lignes décalées d\'une'),
  // --- les drapeaux des familles
  dansLigne(B, '(Step|Étape|Etape)', "'gim'", "'gi'", 'B-IA-01 « Étape N » : `^` seulement en tête de fichier'),
  dansLigne(B, '(Step|Étape|Etape)', "'gim'", "'gm'", 'B-IA-01 « Étape N » : sensible à la casse'),
  dansLigne(B, 'délimiteurs de bloc de code Markdown', "'gm'", "'g'", 'B-IA-01 délimiteurs : `^` seulement en tête de fichier'),
  dansLigne(B, 'commentaires de journal de modification', "'gi'", "'g'", 'B-IA-01 journal : sensible à la casse'),
  dansLigne(B, 'commentaires paraphrasant la ligne suivante', "'gim'", "'gi'", 'B-IA-01 paraphrase : `$` seulement en fin de fichier'),
  dansLigne(B, 'commentaires paraphrasant la ligne suivante', "'gim'", "'gm'", 'B-IA-01 paraphrase : sensible à la casse'),
  // --- le JSDoc générique
  dansLigne(B, 'const PORTEE_JSDOC = ', '200', '199', 'JSDoc : portée de 199 caractères'),
  dansLigne(B, 'const PORTEE_JSDOC = ', '200', '201', 'JSDoc : portée de 201 caractères'),
  dansLigne(B, 'const PARAM_GENERIQUE = ', '{0,${PORTEE_JSDOC}}', '*', 'JSDoc : type entre accolades sans borne (quadratique)'),
  dansLigne(B, 'const PARAM_GENERIQUE = ', "'gi'", "'g'", 'JSDoc : sensible à la casse'),
  dansLigne(B, 'const debutFenetre = Math.max(', 'PORTEE_JSDOC - 3', 'PORTEE_JSDOC - 2', 'JSDoc : fenêtre trop courte d\'un caractère'),
  dansLigne(B, 'const debutFenetre = Math.max(', 'PORTEE_JSDOC - 3', 'PORTEE_JSDOC - 4', 'JSDoc : fenêtre trop longue d\'un caractère'),
  dansLigne(B, 'const debutFenetre = Math.max(', 'Math.max(fin, ', 'Math.max(0, ', 'JSDoc : le texte d\'une occurrence n\'est pas exclu de la fenêtre suivante'),
  dansLigne(B, 'const ouverture = contenu.slice(', "indexOf('/**')", "indexOf('/*')", 'JSDoc : un commentaire ordinaire `/*` ouvre'),
  dansLigne(B, 'const ouverture = contenu.slice(', '.slice(debutFenetre, m.index)', '.slice(debutFenetre)', 'JSDoc : l\'ouverture cherchée aussi après le `@param` (et jusqu\'à la fin du fichier)'),
  dansLigne(B, 'if (ouverture === -1) continue;', 'ouverture === -1', 'false', 'JSDoc : un `@param` sans ouverture compte'),
  dansLigne(B, 'if (n++ === 0) premier = debutFenetre + ouverture;', 'n++ === 0', 'n++ === 1', 'JSDoc : la première occurrence est la deuxième'),
  dansLigne(B, 'if (n++ === 0) premier = debutFenetre + ouverture;', 'debutFenetre + ouverture', 'm.index', 'JSDoc : la ligne est celle du `@param`, non de `/**`'),
  dansLigne(B, 'if (n++ === 0) premier = debutFenetre + ouverture;', 'debutFenetre + ouverture', 'debutFenetre', 'JSDoc : la ligne est celle du début de la fenêtre'),
  dansLigne(B, 'fin = m.index + m[0].length;', 'm.index + m[0].length', 'm.index', 'JSDoc : le texte de l\'occurrence n\'est consommé que jusqu\'à son début'),
  dansLigne(B, 'fin = m.index + m[0].length;', 'm.index + m[0].length', '0', 'JSDoc : le texte d\'une occurrence n\'est pas consommé (deux `@param` d\'un commentaire comptent deux fois)'),
  // --- B-DOC-02
  dansLigne(B, "cle: 'role'", '[^\\S\\n]*', '[ \\t]*', 'B-DOC-02 : `[ \\t]*`, l\'espace insécable ne suffit plus comme indentation'),
  dansLigne(B, "cle: 'role'", '(#|\\n)', '(\\n)', 'B-DOC-02 : le titre `#` ne suffit plus'),
  // --- A-DEV-03 : « À FAIRE »
  dansLigne(A, 'const MARQUEUR_INACHEVE = ', '(?<![\\p{L}\\p{N}_])', '', 'A-DEV-03 : « À FAIRE » sans borne devant lui'),
  dansLigne(A, 'const MARQUEUR_INACHEVE = ', '\\p{L}', '', 'A-DEV-03 : « À FAIRE » accolé à une lettre compte'),
  dansLigne(A, 'const MARQUEUR_INACHEVE = ', '\\p{N}_]', '_]', 'A-DEV-03 : « À FAIRE » accolé à un chiffre compte'),
  dansLigne(A, 'const MARQUEUR_INACHEVE = ', '\\p{N}_]', '\\p{N}]', 'A-DEV-03 : « À FAIRE » accolé à un soulignement compte'),
  dansLigne(A, 'const MARQUEUR_INACHEVE = ', '/gu;', '/g;', 'A-DEV-03 : sans le drapeau u, `\\p{L}` n\'est plus une propriété'),
  dansLigne(A, 'const MARQUEUR_INACHEVE = ', '(?:\\b(TODO', '(?:(TODO', 'A-DEV-03 : TODO accolé à une lettre compte'),
  dansLigne(A, 'const MARQUEUR_INACHEVE = ', '(?<![\\p{L}\\p{N}_])(À FAIRE)', '\\b(À FAIRE)', 'A-DEV-03 : « À FAIRE » borné par `\\b` comme avant (jamais isolé)'),
  dansLigne(A, 'type: m[1] ?? m[2]', 'm[1] ?? m[2]', 'm[1]', 'A-DEV-03 : le type d\'un « À FAIRE » est perdu'),
  // --- la borne des emplacements
  dansLigne(M, 'export const MAX_EMPLACEMENTS = ', '500', '501', 'emplacements : borne à 501'),
  dansLigne(M, 'export const MAX_EMPLACEMENTS = ', '500', '499', 'emplacements : borne à 499'),
  dansLigne(M, 'export const MAX_EMPLACEMENTS = ', '500', '5000', 'emplacements : borne à 5 000'),
  dansLigne(M, 'emplacements.length <= MAX_EMPLACEMENTS', '<= MAX_EMPLACEMENTS', '< MAX_EMPLACEMENTS', 'emplacements : la liste exactement à la borne est coupée'),
  dansLigne(M, 'emplacements.length <= MAX_EMPLACEMENTS', '!Array.isArray(emplacements) || ', '', 'emplacements : une valeur qui n\'est pas une liste est coupée'),
  dansLigne(M, 'emplacements.length <= MAX_EMPLACEMENTS', 'return preuve ?? null;', 'return preuve;', 'emplacements : une preuve absente reste `undefined`'),
  dansLigne(M, 'emplacementsOmis: emplacements.length', '...preuve, ', '', 'emplacements : le reste de la preuve est perdu à la coupe'),
  dansLigne(M, 'emplacementsOmis: emplacements.length', 'slice(0, MAX_EMPLACEMENTS)', 'slice(1, MAX_EMPLACEMENTS + 1)', 'emplacements : le premier est perdu, un autre gardé'),
  dansLigne(M, 'emplacementsOmis: emplacements.length', 'slice(0, MAX_EMPLACEMENTS)', 'slice(0, MAX_EMPLACEMENTS - 1)', 'emplacements : 499 gardés'),
  dansLigne(M, 'emplacementsOmis: emplacements.length', 'emplacements.length - MAX_EMPLACEMENTS', 'emplacements.length', 'emplacements : le nombre d\'omis est le total'),
  dansLigne(M, 'emplacementsOmis: emplacements.length', 'emplacements.length - MAX_EMPLACEMENTS', 'emplacements.length - MAX_EMPLACEMENTS + 1', 'emplacements : le nombre d\'omis est trop grand d\'un'),
  dansLigne(M, 'preuve: preuveBornee(c.preuve),', 'preuveBornee(c.preuve)', 'c.preuve ?? null', 'emplacements : la borne n\'est pas appliquée'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests des petits motifs', fichiers: TESTS }],
  exigerChromium: false,
  partie,
  delaiMs: 90_000,
});
