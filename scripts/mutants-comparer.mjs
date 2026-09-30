#!/usr/bin/env node
/**
 * Rejoue les mutants de `scripts/lib/comparer-rapports.mjs` : chaque différence
 * que la comparaison avant/après doit voir, et chaque faux écart qu'elle ne
 * doit pas inventer, est gardée par un test de `tests/comparer-rapports.test.mjs`
 * (méthode : `scripts/lib/rejouer-mutants.mjs`).
 *
 * Usage : node scripts/mutants-comparer.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants } from './lib/rejouer-mutants.mjs';

const L = 'scripts/lib/comparer-rapports.mjs';
const TESTS = ['tests/comparer-rapports.test.mjs'];
const TUPLE = 'const tuple = (c) => [c.axe, c.regle, c.fichier, c.ligne, c.severite, Boolean(c.bloquant), c.titre];';

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- identité d'un constat
  [L, TUPLE, TUPLE.replace('c.axe, ', ''), 'identité : sans l\'axe'],
  [L, TUPLE, TUPLE.replace('c.regle, ', ''), 'identité : sans la règle'],
  [L, TUPLE, TUPLE.replace('c.fichier, ', ''), 'identité : sans le fichier'],
  [L, TUPLE, TUPLE.replace('c.ligne, ', ''), 'identité : sans la ligne'],
  [L, TUPLE, TUPLE.replace('c.severite, ', ''), 'identité : sans la sévérité'],
  [L, TUPLE, TUPLE.replace('Boolean(c.bloquant), ', ''), 'identité : sans le caractère bloquant'],
  [L, TUPLE, TUPLE.replace('Boolean(c.bloquant)', 'c.bloquant'), 'identité : bloquant absent ≠ bloquant faux'],
  [L, TUPLE, TUPLE.replace(', c.titre]', ']'), 'identité : sans le titre'],
  [L, 'const identite = (c) => JSON.stringify(tuple(c));', "const identite = (c) => tuple(c).join('|');", 'identité : concaténation au lieu de JSON'],
  [L, '.map((c) => ({ ...c, axe }))', '.map((c) => ({ ...c }))', 'axe : celui du constat, pas de la liste qui le porte'],
  [L, '(a.constats ?? [])', '(a.constats)', 'axe sans liste de constats'],

  // --- multiplicité et texte
  [L, 'if (v.length > w.length) retires.push(', 'if (v.length > w.length && w.length === 0) retires.push(', 'multiplicité : retiré seulement si absent'],
  [L, 'if (w.length > v.length) ajoutes.push(', 'if (w.length > v.length && v.length === 0) ajoutes.push(', 'multiplicité : ajouté seulement si absent'],
  [L, 'else if (v.length === w.length) {', 'else {', 'texte comparé même en nombre différent'],
  [L, "const lire = (l) => l.map((c) => JSON.stringify(valeurLue(c, champ))).sort().join('\\n');", "const lire = (l) => l.map((c) => JSON.stringify(valeurLue(c, champ))).join('\\n');", 'texte : dépend de l\'ordre des occurrences'],
  [L, "const lire = (l) => l.map((c) => JSON.stringify(valeurLue(c, champ))).sort().join('\\n');", "const lire = (l) => l.map((c) => JSON.stringify(c[champ])).sort().join('\\n');", 'texte : absent ≠ null'],
  [L, "const lire = (l) => l.map((c) => JSON.stringify(valeurLue(c, champ))).sort().join('\\n');", 'const lire = (l) => JSON.stringify(valeurLue(l[0], champ));', 'texte : première occurrence seulement'],
  ...['constat', 'impact', 'remediation', 'extrait', 'confiance', 'mesurePartielle', 'axesEmpeches'].map((champ) => [
    L,
    "export const CHAMPS_LUS = ['constat', 'impact', 'remediation', 'extrait', 'confiance', 'mesurePartielle', 'axesEmpeches'];",
    `export const CHAMPS_LUS = [${['constat', 'impact', 'remediation', 'extrait', 'confiance', 'mesurePartielle', 'axesEmpeches'].filter((c) => c !== champ).map((c) => `'${c}'`).join(', ')}];`,
    `champs lus : sans ${champ}`,
  ]),
  [L, "identique: notesAvant === notesApres && !retires.length && !ajoutes.length && !textes.length,", "identique: notesAvant === notesApres && !retires.length && !ajoutes.length,", 'identique : textes ignorés'],
  [L, "identique: notesAvant === notesApres && !retires.length && !ajoutes.length && !textes.length,", "identique: !retires.length && !ajoutes.length && !textes.length,", 'identique : notes ignorées'],

  // --- notes
  [L, '(${rapport.bloquants.length} bloq.)', '(bloq.)', 'notes : sans le nombre de bloquants'],
  [L, '${rapport.scoreGlobal}', '', 'notes : sans le score global'],
  [L, '${rapport.verdict} ', '', 'notes : sans le verdict'],
  [L, "a.score === null ? '—' : a.score", 'a.score', 'notes : axe non exécuté écrit null'],
  [L, 'const axes = Object.entries(rapport.axes)', 'Object.entries(rapport.axes)', 'Object.entries(rapport.axes).slice(0, 5)', 'notes : le dernier axe ignoré'],
];
const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants[0] ? new RegExp(restants[0]) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({ mutants, groupes: [{ nom: 'tests ciblés', fichiers: TESTS }], exigerChromium: false, partie });
