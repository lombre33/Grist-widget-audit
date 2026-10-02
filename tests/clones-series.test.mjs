import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chercher, endroits, fonctionDe, lignes, POUR, separateur, SI, TANT } from './aide-clones.mjs';

/**
 * Une série d'instructions se cherche comme une chaîne de formes : des couples d'instructions voisines, groupés par forme, que les exemplaires prolongent tant qu'ils s'accordent ;
 * ce qu'un clone plus gros couvre déjà n'en est pas un autre. Ces essais fixent chaque étape de cette recherche sur des fichiers de quelques lignes (`SI`, `TANT` et `POUR` sont trois
 * instructions de masse 6 et de logique 2 : deux d'entre elles font une série de masse 12 et de logique 4), jusqu'au nombre exact de pas qu'elle compte.
 */

const S = { masse: 12, logique: 4 };
const BORNEE = { pas: 10_000 };                                  // un plafond bas : une boucle qui ne finirait plus s'arrête sur lui et fait échouer l'essai, au lieu de tourner jusqu'au plafond par défaut
const serie = (sources, seuils = S) => chercher(sources, { ...BORNEE, ...seuils });
const clonesDe = (sources, seuils) => serie(sources, seuils).clones;
/** Aucun exemplaire de aucun clone n'en recouvre un autre : une instruction n'est comptée qu'une fois. */
function sansRecouvrement(clones) {
  const parFichier = new Map();
  for (const c of clones) for (const i of c.instances) parFichier.set(i.chemin, [...(parFichier.get(i.chemin) ?? []), [i.ligne, i.ligneFin]]);
  for (const [chemin, plages] of parFichier) {
    plages.sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < plages.length; k++) assert.ok(plages[k][0] > plages[k - 1][1], `${chemin} : lignes ${plages[k - 1]} et ${plages[k]} comptées deux fois`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Les seuils d'une série

const DEUX_FICHIERS = { 'a.js': lignes(SI(), TANT()), 'b.js': lignes(SI('x', 'y'), TANT('z', 'w')) };

test('une série passe les seuils à la masse et à la logique exactes de toutes ses instructions : douze nœuds dont quatre de logique', () => {
  assert.equal(clonesDe(DEUX_FICHIERS, S).length, 1);
  assert.equal(clonesDe(DEUX_FICHIERS, { masse: 13, logique: 4 }).length, 0, 'la masse compte les deux instructions : 12, pas 13');
  assert.equal(clonesDe(DEUX_FICHIERS, { masse: 12, logique: 5 }).length, 0, 'la logique compte les deux instructions : 4, pas 5');
  assert.equal(clonesDe(DEUX_FICHIERS, { masse: 13, logique: 5 }).length, 0);
  assert.equal(clonesDe(DEUX_FICHIERS, { masse: 12, logique: 4 })[0].masse, 12);
});

test('la logique d\'une série est celle de ses instructions, non de celles qui la précèdent dans la liste', () => {
  const declarations = lignes('const a = b;', 'const c = d;');         // masse 8, aucune logique
  const sources = (avantA, avantB) => ({ 'a.js': lignes(avantA, declarations), 'b.js': lignes(avantB, declarations) });
  assert.equal(clonesDe(sources(SI(), TANT()), { masse: 8, logique: 0 }).length, 1, 'témoin : la série passe sans exigence de logique');
  assert.deepEqual(clonesDe(sources(SI(), TANT()), { masse: 8, logique: 1 }), [], 'des instructions de logique avant elle, de formes qui diffèrent d\'un fichier à l\'autre, n\'en donnent pas à la série');
});

test('la masse d\'une série est celle de ses instructions, non de celles qui la précèdent dans la liste', () => {
  const declarations = lignes('const a = b;', 'const c = d;');         // masse 8
  const sources = { 'a.js': lignes(separateur(5), declarations), 'b.js': lignes(separateur(6), declarations) };
  assert.equal(clonesDe(sources, { masse: 8, logique: 0 }).length, 1);
  assert.deepEqual(clonesDe(sources, { masse: 9, logique: 0 }), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Les couples d'instructions voisines

test('deux listes qui ne partagent aucun couple de voisines ne partagent aucune série, même avec la première et la dernière instruction communes', () => {
  assert.deepEqual(clonesDe({ 'a.js': lignes(SI(), TANT(), POUR()), 'b.js': lignes(SI(), POUR(), POUR()) }, { masse: 15, logique: 3 }), []);
});

test('une série commence à deux instructions voisines et n\'est jamais celle d\'une instruction seule', () => {
  const sources = { 'a.js': lignes(SI(), separateur(1)), 'b.js': lignes(SI(), separateur(2)) };
  assert.deepEqual(clonesDe(sources, { masse: 6, logique: 2 }).map((c) => c.forme), ['bloc'], 'seule l\'instruction qu\'elles ont en commun est un clone');
});

// ---------------------------------------------------------------------------------------------------------------------
// Le bout d'une liste

/**
 * `debugger` n'a pas d'enfant : quand c'est la dernière instruction de la première unité, c'est le premier nœud que la numérotation lit, et sa forme est celle de numéro 0.
 * Le numéro d'une instruction qui n'existe pas (avant la première d'une liste, après la dernière) ne doit se confondre avec aucune forme, celle-là non plus.
 */
const TROIS_APPELS = (a, b, c, d) => `${a}();\n${b}(c1);\n${c}(c1, d1);\n`.replace(/c1/g, c).replace(/d1/g, d);
const AVEC = { masse: 8, logique: 2 };

test('l\'instruction qui finit une liste, quelle que soit la forme qu\'elle a, se prolonge comme une autre : la première forme numérotée n\'est pas « aucune instruction »', () => {
  const fin = (...noms) => `${TROIS_APPELS(...noms)}debugger;\n`;
  const { clones, limites } = serie({ 'a.js': fin('p', 'q', 'r', 'a'), 'b.js': fin('x', 'y', 'z', 'c') }, AVEC);
  assert.deepEqual(clones.map(endroits), [['a.js:1-4', 'b.js:1-4']], 'la série va jusqu\'à `debugger` : quatre instructions, non trois');
  assert.equal(clones[0].masse, 13);
  assert.equal(limites.pas, 40, 'six pas pour étendre jusqu\'au bout de la liste, huit pour garder la série, vingt-six pour comparer ses deux exemplaires');
});

test('l\'instruction qui commence une liste, quelle que soit la forme qu\'elle a, n\'est pas « aucune instruction » : la série qui la suit n\'est pas cherchée une seconde fois', () => {
  const debut = (...noms) => `debugger;\n${TROIS_APPELS(...noms)}`;
  const { clones, limites } = serie({ 'u0.js': 'debugger;\n', 'u1.js': debut('p', 'q', 'r', 'a'), 'u2.js': debut('x', 'y', 'z', 'c') }, AVEC);
  assert.deepEqual(clones.map(endroits), [['u1.js:1-4', 'u2.js:1-4']]);
  assert.equal(limites.pas, 40, 'le couple (`p`, `q`) n\'est que le décalage du couple (`debugger`, `p`) : il ne coûte rien');
});

// ---------------------------------------------------------------------------------------------------------------------
// Les exemplaires d'une série

test('deux répétitions qui se touchent sans se recouvrir sont deux exemplaires', () => {
  const { clones } = serie({ 'a.js': lignes(SI(), SI(), SI(), SI()) });
  assert.deepEqual(clones.map(endroits), [['a.js:1-2', 'a.js:3-4']]);
});

test('une répétition qui en recouvre une autre ne compte pas, et n\'arrête pas la recherche des suivantes', () => {
  assert.deepEqual(serie({ 'a.js': lignes(SI(), SI(), SI(), SI(), SI()) }).clones.map(endroits), [['a.js:1-2', 'a.js:3-4']]);
  assert.deepEqual(serie({ 'a.js': lignes(SI(), SI(), SI(), SI(), SI(), SI(), SI()) }).clones.map(endroits), [['a.js:1-3', 'a.js:4-6']]);
  assert.deepEqual(serie({ 'a.js': lignes(SI(), SI(), SI(), SI(), SI(), SI()) }).clones.map(endroits), [['a.js:1-3', 'a.js:4-6']]);
});

test('une répétition d\'un autre fichier ne recouvre jamais celle d\'un fichier précédent', () => {
  const { clones } = serie({ 'a.js': lignes(SI(), SI()), 'b.js': lignes(SI(), SI()) });
  assert.deepEqual(clones.map(endroits), [['a.js:1-2', 'b.js:1-2']]);
});

test('une série d\'une instruction de moins ne fait pas un exemplaire de moins : les exemplaires d\'un clone ont tous la même longueur', () => {
  const { clones } = serie({ 'a.js': lignes(SI(), TANT(), POUR(), separateur(1)), 'b.js': lignes(SI(), TANT(), POUR(), separateur(2)) });
  assert.deepEqual(clones.map(endroits), [['a.js:1-3', 'b.js:1-3']]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Ce qu'un clone plus gros couvre déjà

test('un exemplaire dont une seule instruction est couverte par un clone plus gros n\'est pas libre : aucune instruction n\'est comptée deux fois', () => {
  const [a, b, c, d, e, f, x] = [1, 2, 3, 4, 5, 6, 7].map(separateur);       // sept instructions de formes différentes, de masses 4, 6, 8, 10, 12, 14, 16
  const { clones } = serie({ 'u1.js': lignes(a, b, c, d, e), 'u2.js': lignes(a, b, c, d, f), 'u3.js': lignes(x, c, d, e) }, { masse: 18, logique: 0 });
  assert.deepEqual(clones.map(endroits), [['u1.js:3-5', 'u3.js:2-4']], 'la suite `c d e` est la plus grosse (30) ; `a b c d` (28) en recouvre la moitié dans u1 : un exemplaire de moins');
  sansRecouvrement(clones);
});

test('un clone retenu couvre tout ce qu\'il contient, pour tous ses exemplaires', () => {
  const bloc = (profondeur) => `if (a) {\n  p();\n  q(a);\n  r(a, b);\n  ${separateur(profondeur)}\n}\n`;
  const { clones } = serie({ 'a.js': bloc(1), 'b.js': bloc(1), 'c.js': bloc(1) }, { masse: 6, logique: 1 });
  assert.equal(clones.length, 1, 'le bloc entier, trois exemplaires, plutôt que chacune de ses instructions');
  assert.deepEqual(endroits(clones[0]), ['a.js:1-6', 'b.js:1-6', 'c.js:1-6']);
  sansRecouvrement(clones);
});

// ---------------------------------------------------------------------------------------------------------------------
// Quand les exemplaires divergent

test('un exemplaire dont la liste s\'arrête avant les autres ne retient pas ceux qui continuent ensemble', () => {
  const { clones, limites } = serie({ 'a.js': lignes(SI(), TANT()), 'b.js': lignes(SI(), TANT(), POUR()), 'c.js': lignes(SI(), TANT(), POUR()) });
  assert.deepEqual(clones.map(endroits), [['b.js:1-3', 'c.js:1-3']]);
  assert.equal(limites.pasEpuises, false);
});

test('trois exemplaires dont deux seulement continuent ensemble : un clone de la série commune aux trois, un de la série plus longue des deux', () => {
  const sources = { 'a.js': lignes(SI(), TANT(), POUR()), 'b.js': lignes(SI(), TANT(), POUR()), 'c.js': lignes(SI(), TANT(), separateur(1)) };
  assert.deepEqual(serie(sources).clones.map(endroits), [['a.js:1-3', 'b.js:1-3']], 'le premier couvre ce que les deux ont en commun avec le troisième : celui-ci reste seul');
});

test('deux exemplaires qui divergent sur chacun de leurs voisins ne sont une série que de leur partie commune', () => {
  const sources = { 'a.js': lignes(separateur(1), SI(), TANT(), separateur(2)), 'b.js': lignes(separateur(3), SI(), TANT(), separateur(4)) };
  assert.deepEqual(serie(sources).clones.map(endroits), [['a.js:2-3', 'b.js:2-3']]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Le compte de pas

test('le compte de pas d\'une divergence à la deuxième instruction : l\'extension de tous, puis celle du sous-groupe qui continue', () => {
  const sources = { 'a.js': lignes(SI(), TANT(), POUR()), 'b.js': lignes(SI(), TANT(), POUR()), 'c.js': lignes(SI(), TANT(), separateur(1)) };
  const { clones, limites } = serie(sources);
  assert.deepEqual(clones.map(endroits), [['a.js:1-3', 'b.js:1-3']]);
  const extension = 3 + (3 * 2) + 2 + 2;       // trois exemplaires qui divergent d'emblée ; les trois gardés (série de deux) ; le sous-groupe : un tour pour la partager, un pour la fin de sa liste
  const gardes = 2 * 3;                         // le sous-groupe gardé : deux exemplaires de trois instructions
  const choix = 2 * 18;                         // la comparaison des noms des deux exemplaires de la série de trois
  assert.equal(limites.pas, extension + gardes + choix);
  assert.equal(limites.pasEpuises, false);
});

test('le compte de pas d\'une divergence à la troisième instruction : le sous-groupe reprend où les exemplaires ont divergé, pas avant, pas après', () => {
  const sources = { 'a.js': lignes(SI(), TANT(), POUR(), separateur(2)), 'b.js': lignes(SI(), TANT(), POUR(), separateur(2)), 'c.js': lignes(SI(), TANT(), POUR(), separateur(3)) };
  const { clones, limites } = serie(sources);
  assert.deepEqual(clones.map(endroits), [['a.js:1-4', 'b.js:1-4']]);
  const premiere = 3 + 3 + (3 * 3);            // trois exemplaires : un tour pour `POUR`, un où ils divergent, puis les trois gardés (série de trois)
  const sousGroupe = 2 + 2 + (2 * 4);          // deux exemplaires : un tour pour la quatrième instruction, un pour la fin de leur liste, puis les deux gardés (série de quatre)
  const choix = 2 * 24;                        // la comparaison des noms des deux exemplaires de la série de quatre
  assert.equal(limites.pas, premiere + sousGroupe + choix);
  assert.equal(limites.pasEpuises, false);
});

test('une série dont un seul exemplaire reste, les autres se recouvrant, ne coûte aucun pas de comparaison', () => {
  const { clones, limites } = serie({ 'a.js': lignes(SI(), SI(), SI()) });
  assert.deepEqual(clones, []);
  assert.equal(limites.pas, 2, 'le seul tour d\'extension des deux exemplaires, qui se recouvrent : rien n\'est gardé, rien n\'est comparé');
});

test('un seul exemplaire libre n\'est pas comparé : il ne coûte aucun pas, un clone déjà couvert n\'en coûte pas davantage', () => {
  const instruction = 'if (a) { b(c(d())); }';                              // masse 10, logique 4, sans liste d'instructions à parcourir
  const fonction = (nom) => `function ${nom}() {\n  premier();\n  ${instruction}\n  dernier(1);\n}\n`;
  const sources = { 'a.js': fonction('f'), 'b.js': fonction('g') };
  const seuils = { masse: 10, logique: 4 };
  const sans = serie(sources, seuils);
  assert.equal(sans.clones.length, 1);
  assert.equal(sans.clones[0].forme, 'fonction');
  const avec = serie({ ...sources, 'c.js': `${instruction}\n` }, seuils);
  assert.deepEqual(avec.clones.map(endroits), sans.clones.map(endroits), 'l\'instruction isolée de c.js n\'est pas un clone : les deux autres exemplaires sont couverts par la fonction');
  assert.equal(avec.limites.pas, sans.limites.pas);
});

test('les plus petits groupes d\'abord : un groupe de nombreux exemplaires ne prive pas de pas les copies ordinaires', () => {
  const six = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.js`, lignes(SI(), TANT())]));
  const deux = Object.fromEntries(Array.from({ length: 2 }, (_, i) => [`s${i}.js`, lignes(POUR(), SI())]));
  const { clones, limites } = chercher({ ...six, ...deux }, { ...S, pas: 4 });
  assert.deepEqual(clones.map(endroits), [['s0.js:1-2', 's1.js:1-2']], 'deux exemplaires coûtent 2 pas d\'extension : le groupe de six, qui en coûterait 6, passe en dernier, et le plafond l\'arrête');
  assert.equal(limites.pasEpuises, true);
  const tout = serie({ ...six, ...deux });
  assert.deepEqual(tout.clones.map(endroits), [Object.keys(six).map((c) => `${c}:1-2`), ['s0.js:1-2', 's1.js:1-2']], 'sans plafond atteint, les deux sont rendus, à masse égale dans l\'ordre des unités');
  assert.equal(tout.limites.pasEpuises, false);
});

test('un groupe de très nombreux exemplaires se compare comme un autre, pour les séries aussi : il est dit en entier, au pas près', () => {
  const sources = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`f${i}.js`, lignes(SI(), TANT())]));
  const { clones, limites } = chercher(sources, { ...S, pas: 1_000_000 });
  assert.equal(clones.length, 1);
  assert.equal(clones[0].instances.length, 5001);
  assert.equal(limites.pasEpuises, false);
  assert.equal(limites.pas, 5001 * (1 + 2 + 12), 'par exemplaire : un pas pour constater que la série ne se prolonge pas, deux pour la garder (ses deux instructions), douze pour comparer ses noms (sa masse)');
});

// ---------------------------------------------------------------------------------------------------------------------
// Ce que dit un clone de série

test('un clone de série dit `identique` quand toutes ses instructions le sont, `renomme` quand une seule ne l\'est pas', () => {
  const type = (a, b) => serie({ 'a.js': lignes(...a), 'b.js': lignes(...b) }).clones[0].type;
  assert.equal(type([SI('a', 'b'), TANT('c', 'd')], [SI('a', 'b'), TANT('c', 'd')]), 'identique');
  assert.equal(type([SI('a', 'b'), TANT('c', 'd')], [SI('a', 'b'), TANT('x', 'y')]), 'renomme', 'la première instruction est identique, la seconde non');
  assert.equal(type([SI('a', 'b'), TANT('c', 'd')], [SI('x', 'y'), TANT('c', 'd')]), 'renomme', 'la seconde instruction est identique, la première non');
});

test('un clone dit pour ses lignes celles de son exemplaire le plus long', () => {
  const courte = fonctionDe('f', 60, 6);
  const longue = fonctionDe('g', 60, 6).replace(/; /g, ';\n');
  const [clone] = clonesDe({ 'a.js': courte, 'b.js': longue }, { logique: 2 });
  assert.deepEqual(endroits(clone), ['a.js:1-1', 'b.js:1-6']);
  assert.equal(clone.lignes, 6);
});
