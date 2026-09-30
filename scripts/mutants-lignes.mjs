#!/usr/bin/env node
/**
 * Rejoue les mutants du numéro de ligne d'une occurrence (méthode : `scripts/lib/rejouer-mutants.mjs`) :
 *   - `numeroLigne` (`src/moteur/lignes.js`) : le décompte, l'index des sauts de ligne relevé une fois, la mémoire bornée à huit contenus ;
 *   - A-DEV-03 et F-SOUV-01, qui posent la question pour chaque occurrence d'un motif : la ligne rendue, et le travail
 *     (aucun début de fichier recopié à chaque occurrence, le fichier d'origine d'un littéral cherché dans une table,
 *     son contenu parcouru une fois par hôte) ;
 *   - ce que F-SOUV-01 fait d'un littéral passé à `eval` : une référence déjà en clair dans son fichier d'origine
 *     n'est pas comptée deux fois, une référence qu'un encodage y cache l'est.
 * Les essais comptent le travail (appels à `indexOf`, caractères passés à `split`, appels à `includes`) au lieu de
 * mesurer un temps : chaque mutant meurt par un essai déterministe, quelle que soit la machine.
 *
 * Mutants équivalents, laissés de côté :
 *   - `m.index` → `m.index + 1` (A-DEV-03, F-SOUV-01) : le motif commence sur la ligne qu'il désigne, un caractère plus loin est encore sur elle ;
 *   - `SAUTS_DE_LIGNE.clear()` remplacé par la suppression d'une seule entrée : hors de portée d'un essai, la mémoire retenue n'est pas observable d'ici.
 *
 * Usage : node scripts/mutants-lignes.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const L = 'src/moteur/lignes.js';
const A = 'src/regles/a-qualite.js';
const F = 'src/regles/f-conformite.js';
const I = 'src/contexte/inventaire.js';
const TESTS = ['tests/lignes.test.mjs', 'tests/numeros-de-ligne-regles.test.mjs'];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- numeroLigne
  dansLigne(L, 'if (sauts[milieu] < index) a = milieu + 1;', '<', '<=', 'numeroLigne : le saut de ligne lui-même compté'),
  dansLigne(L, 'return a + 1;', 'a + 1', 'a', 'numeroLigne : numéro à partir de 0'),
  dansLigne(L, 'let sauts = SAUTS_DE_LIGNE.get(contenu);', 'SAUTS_DE_LIGNE.get(contenu)', 'undefined', 'numeroLigne : sauts recalculés à chaque appel (quadratique)'),
  dansLigne(L, 'if (SAUTS_DE_LIGNE.size >= TAILLE_SAUTS) SAUTS_DE_LIGNE.clear();', 'if (SAUTS_DE_LIGNE.size >= TAILLE_SAUTS) SAUTS_DE_LIGNE.clear();', '', 'numeroLigne : la mémoire des sauts ne se vide jamais (croît avec chaque contenu)'),
  dansLigne(L, 'const TAILLE_SAUTS = 8;', '8', '0', 'numeroLigne : rien n\'est gardé au-delà du dernier contenu'),
  dansLigne(L, 'const TAILLE_SAUTS = 8;', '8', '1', 'numeroLigne : un seul contenu gardé'),
  dansLigne(L, 'for (let i = contenu.indexOf(\'\\n\'); i !== -1; i = contenu.indexOf(\'\\n\', i + 1)) sauts.push(i);', 'i + 1)', 'i)', 'numeroLigne : la relève des sauts ne finit pas'),
  dansLigne(I, 'return numeroLigne(contenu, index);', 'numeroLigne(contenu, index)', '1', 'ligneDe : toujours la première ligne'),
  dansLigne(I, 'return numeroLigne(contenu, index);', 'numeroLigne(contenu, index)', 'contenu.slice(0, index).split(\'\\n\').length', 'ligneDe : le début du contenu recopié à chaque appel (quadratique)'),

  // --- A-DEV-03
  dansLigne(A, 'marqueurs.push({ fichier: f.chemin, ligne: numeroLigne(', 'numeroLigne(f.contenu, m.index)', 'f.contenu.slice(0, m.index).split(\'\\n\').length', 'A-DEV-03 : le début du fichier recopié à chaque marqueur (quadratique)'),
  dansLigne(A, 'marqueurs.push({ fichier: f.chemin, ligne: numeroLigne(', 'numeroLigne(f.contenu, m.index)', '1', 'A-DEV-03 : tous les marqueurs à la ligne 1'),
  dansLigne(A, 'marqueurs.push({ fichier: f.chemin, ligne: numeroLigne(', 'numeroLigne(f.contenu, m.index)', 'numeroLigne(f.contenu, m.index) - 1', 'A-DEV-03 : lignes à partir de 0'),

  // --- F-SOUV-01
  dansLigne(F, 'trouves.get(cle).emplacements.push({ fichier: f.chemin, ligne: numeroLigne(f.contenu, m.index), hote: h });', 'numeroLigne(f.contenu, m.index)', 'f.contenu.slice(0, m.index).split(\'\\n\').length', 'F-SOUV-01 : le début du fichier recopié à chaque référence (quadratique)'),
  dansLigne(F, 'trouves.get(cle).emplacements.push({ fichier: f.chemin, ligne: numeroLigne(f.contenu, m.index), hote: h });', 'numeroLigne(f.contenu, m.index)', '1', 'F-SOUV-01 : toutes les références à la ligne 1'),
  dansLigne(F, 'const origineDe = (f) =>', '(fichiersParChemin ??= new Map(ctx.fichiers.map((of) => [of.chemin, of]))).get(f.origineReelle.chemin)', 'ctx.fichiers.find((of) => of.chemin === f.origineReelle.chemin)', 'F-SOUV-01 : le fichier d\'origine cherché par un `find` sur tout l\'inventaire à chaque référence'),
  dansLigne(F, 'const origineDe = (f) =>', '(fichiersParChemin ??= new Map(', '(fichiersParChemin = new Map(', 'F-SOUV-01 : la table des fichiers refaite à chaque référence'),
  dansLigne(F, 'if (!deja.has(h)) deja.set(h, origine.contenu.includes(h));', 'if (!deja.has(h)) ', '', 'F-SOUV-01 : le contenu de l\'origine parcouru à chaque référence, non une fois par hôte'),
  dansLigne(F, 'if (!origine?.contenu) return false;', '!origine?.contenu', 'false', 'F-SOUV-01 : une origine absente de l\'inventaire casse la lecture'),
  dansLigne(F, 'if (enClairDansLOrigine(origineDe(f), h)) continue;', 'continue', '{ /* comptée quand même */ }', 'F-SOUV-01 : une référence déjà en clair dans l\'origine est comptée deux fois'),
  dansLigne(F, 'if (enClairDansLOrigine(origineDe(f), h)) continue;', 'enClairDansLOrigine(origineDe(f), h)', '!enClairDansLOrigine(origineDe(f), h)', 'F-SOUV-01 : une référence qu\'un encodage cache est ignorée, celle qui est en clair comptée'),
  dansLigne(F, 'if (enClairDansLOrigine(origineDe(f), h)) continue;', 'enClairDansLOrigine(origineDe(f), h)', 'true', 'F-SOUV-01 : toute référence d\'un littéral est tenue pour déjà vue'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests des numéros de ligne', fichiers: TESTS }],
  exigerChromium: false,
  partie,
  delaiMs: 90_000,                                                // un mutant dont la relève ne finit pas est tué par le délai, dit comme tel
});
