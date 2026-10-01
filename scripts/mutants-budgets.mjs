#!/usr/bin/env node
/**
 * Rejoue les mutants que la suite par défaut ne voit pas parce qu'ils ne changent aucun résultat, seulement le temps qu'il faut
 * pour l'obtenir : une regex qui devient quadratique sur un mégaoctet de blancs, un extrait replié en entier avant d'être coupé,
 * l'ancien repli des workers (deux expressions qui relisaient le texte à chaque occurrence). Et ceux qui ne finissent jamais :
 * une recherche qui reprend avant sa position ou ne s'arrête pas faute de parenthèse fermante boucle sans fin, qu'aucun essai ne
 * juge (l'essai qui les contient ne finit pas) et que seul un délai voit. Dans un lot de la base, c'est le délai du lot qui les tue,
 * et il le dit ; ici c'est la limite dure d'un cas, qui le dit aussi.
 * Seul un budget de temps les tue (`tests/budgets/`, joués ici par `tests/budgets/lot.mjs`) ; ils sortaient de la suite par défaut
 * avec ces tests (aucun temps mesuré dans la suite par défaut ni dans la base des mutants des autres lots).
 *
 * Ce lot mesure une horloge : à lancer machine au calme et seul, il refuse de partir sinon (une charge qui fait passer un budget
 * pour dépassé ferait « tuer » un mutant que rien n'a tué). Sa suite non mutée doit passer avant chaque rejeu, comme pour tout
 * lot. Un mutant quadratique sur un mégaoctet dure des minutes : c'est la limite dure du cas (`limiteDure`, scripts/lib/budgets.mjs)
 * qui l'arrête ; il est dit « tué par un test » puisque le budget est un test, mais c'est l'horloge qui l'a tué, et ce lot le dit.
 *
 * Usage : node scripts/mutants-budgets.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants } from './lib/rejouer-mutants.mjs';
import { mesurerOccupation, refusSousCharge } from './lib/budgets.mjs';

const P = 'src/moteur/page-html.js';
const S = 'src/moteur/css.js';
const M = 'src/moteur/modele.js';
const I = 'src/contexte/inventaire.js';

// Le repli des workers tel que `e42a8a6` l'écrit (une recherche de `importScripts(`, la parenthèse fermante par `indexOf`), et tel qu'il
// était avant : une seule expression, `importScripts\s*\(([^)]*)\)`, relue jusqu'à la fin du texte à chaque appel qui ne se ferme pas.
const IMPORTSCRIPTS_RECHERCHE = [
  '  const entete = /\\bimportScripts\\s*\\(/g;',
  '  while (entete.exec(contenu) !== null) {',
  "    const fin = contenu.indexOf(')', entete.lastIndex);",
  '    if (fin < 0) break;                                            // plus aucune `)` : aucun des appels suivants ne se ferme non plus',
  '    for (const t of contenu.slice(entete.lastIndex, fin).matchAll(/["\']([^"\']+)["\']/g)) refs.push(duWorker(t[1]));',
  '    entete.lastIndex = fin + 1;',
  '  }',
].join('\n');
const IMPORTSCRIPTS_EXPRESSION = [
  '  for (const m of contenu.matchAll(/\\bimportScripts\\s*\\(([^)]*)\\)/g)) {',
  '    for (const t of m[1].matchAll(/["\']([^"\']+)["\']/g)) refs.push(duWorker(t[1]));',
  '  }',
].join('\n');

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  [S, "while (b > a && texte.charCodeAt(b - 1) <= 32) b--;", "{ const m = /[\\u0000- ]+$/.exec(texte.slice(a)); if (m) b = a + m.index; }", 'rognerUrl : regex quadratique'],
  [P, "  while (b > a && espace(texte.charCodeAt(b - 1))) b--;\n  return texte.slice(a, b);", "  return texte.replace(/^[\\t\\n\\f\\r ]+|[\\t\\n\\f\\r ]+$/g, '');", 'sansBlancsDeBord : regex quadratique'],
  [M, "masquerLesSecrets(String(c.extrait).slice(0, LONGUEUR_LUE_EXTRAIT)).replace(", "masquerLesSecrets(String(c.extrait)).replace(", 'extrait : replié en entier avant la coupe (quadratique)'],
  [M, "const LONGUEUR_LUE_EXTRAIT = 4096;", "const LONGUEUR_LUE_EXTRAIT = 1 << 30;", 'extrait : longueur lue sans borne'],
  [I, IMPORTSCRIPTS_RECHERCHE, IMPORTSCRIPTS_EXPRESSION, 'repli des workers : importScripts\\s*\\(([^)]*)\\) relu à chaque appel (quadratique)'],
  [I, "(?:serviceWorker\\.register|", "(?:\\w+\\.)*(?:serviceWorker\\.register|", 'repli des workers : préfixe (?:\\w+\\.)* relu à chaque point (quadratique)'],
  [I, "contenu.indexOf(')', entete.lastIndex)", "contenu.indexOf(')')", 'repli des workers : la parenthèse fermante est cherchée depuis le début du texte (ne finit pas)'],
  [I, "    if (fin < 0) break;", "", 'repli des workers : sans parenthèse fermante, la recherche repart du début (ne finit pas)'],
].map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

const { partie, restants } = lireArguments(process.argv.slice(2));
const argv = process.argv.slice(2);
const filtre = restants[0];
const retenus = filtre ? MUTANTS.filter((m) => new RegExp(filtre).test(m.libelle)) : MUTANTS;

if (!argv.includes('--valider')) {
  const refus = refusSousCharge(mesurerOccupation());
  if (refus) {
    console.error(`Lot des budgets non rejoué : ${refus}`);
    process.exit(2);
  }
  console.log('Lot des budgets : chaque mutant meurt par l\'horloge (budget de temps ou limite dure du cas), pas par un résultat faux. Machine au calme.\n');
}

// Les cas de l'axe D et du moteur de mutants lancent un vrai Chromium ou un lot entier : aucun mutant d'ici ne les touche.
process.env.GWAUDIT_BUDGETS_CAS = '^(?!axe D|moteur de mutants)';

process.exitCode = rejouerMutants({
  mutants: retenus,
  groupes: [{ nom: 'budgets de temps', fichiers: ['tests/budgets/lot.mjs'] }],
  exigerChromium: false,
  partie,
  delaiMs: 600_000,                                               // un cas mort à sa limite dure (40 s) laisse le lot aller à son terme : le délai du lot n'est qu'un filet
});
