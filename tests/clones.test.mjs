import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lire } from '../src/moteur/analyse-js.js';
import { creerRecherche, creerTables, detecterClones, noeudsDe, numeroter, SEUILS_CLONES } from '../src/moteur/clones.js';

/**
 * Les clones se lisent sur l'arbre (voir `src/moteur/clones.js`) : des fonctions, des blocs et des suites d'instructions de même forme, aux noms et aux
 * valeurs près, à un renommage cohérent. Ces essais fixent ce qui est un clone et ce qui n'en est pas, la maximalité (une fonction copiée est un
 * clone, non trente), la façon de compter les exemplaires, et les plafonds de la recherche.
 */

const unite = (chemin, source, decalage = 0) => {
  const { ast, erreur } = lire(source);
  assert.ok(ast, `la source doit se lire : ${erreur?.message}`);
  return { chemin, ast, ligneDe: (n) => n.loc.start.line + decalage, ligneFinDe: (n) => n.loc.end.line + decalage };
};
const clonesDe = (sources, seuils) => detecterClones(Object.entries(sources).map(([chemin, source]) => unite(chemin, source)), seuils).clones;
/** Les clones qui sont des fonctions entières : ce que la copie d'une fonction qui diffère par un détail n'est pas, quand ses parties communes en sont chacune un. */
const fonctionsClonees = (sources, seuils) => clonesDe(sources, seuils).filter((c) => c.forme === 'fonction');
const endroits = (clone) => clone.instances.map((i) => `${i.chemin}:${i.ligne}-${i.ligneFin}`);

/** Une fonction de masse 59 et de logique 9, dont `a`, `b`, `actif` et `valeur` sont les noms à changer. */
const copie = (nom, a = 'liste', b = 'transformer', actif = 'actif', valeur = 'valeur') => `function ${nom}(${a}, ${b}) {
  const resultat = [];
  for (let i = 0; i < ${a}.length; i++) {
    if (${a}[i].${actif} && ${a}[i].${valeur} > 0) {
      resultat.push(${b}(${a}[i]));
    } else {
      console.log('ignoré', ${a}[i]);
    }
  }
  return resultat;
}
`;

/** Une fonction qui a exactement cette masse et cette logique (`g(1, …); g(); …` : trois nœuds par appel, un de logique chacun, la fonction elle-même en porte un). */
function fonctionDe(nom, masse, logique) {
  const appels = logique - 1;
  const remplissage = masse - 3 - 3 * appels;
  assert.ok(appels >= 1 && remplissage >= 0, `masse ${masse} et logique ${logique} : impossible`);
  return `function ${nom}() { g(${Array(remplissage).fill('1').join(', ')}); ${'g(); '.repeat(appels - 1)}}\n`;
}

const mesure = (source) => {
  const { ast } = lire(source);
  numeroter(noeudsDe(ast), creerTables());
  return { masse: ast.body[0].__m, logique: ast.body[0].__l };
};

test('les seuils par défaut : cinquante nœuds dont six de logique, 400 000 nœuds gardés, trois millions de pas', () => {
  assert.equal(SEUILS_CLONES.masse, 50);
  assert.equal(SEUILS_CLONES.logique, 6);
  assert.equal(SEUILS_CLONES.noeuds, 400_000);
  assert.equal(SEUILS_CLONES.pas, 3_000_000);
  assert.deepEqual(Object.keys(SEUILS_CLONES), ['masse', 'logique', 'noeuds', 'pas']);
  assert.equal(Object.isFrozen(SEUILS_CLONES), true);
});

test('la masse et la logique d\'une fonction se lisent comme le décrivent les essais qui suivent', () => {
  assert.deepEqual(mesure(copie('f')), { masse: 59, logique: 9 });
  assert.deepEqual(mesure(fonctionDe('f', 50, 6)), { masse: 50, logique: 6 });
  assert.deepEqual(mesure(fonctionDe('f', 49, 6)), { masse: 49, logique: 6 });
  assert.deepEqual(mesure(fonctionDe('f', 50, 5)), { masse: 50, logique: 5 });
});

// ---------------------------------------------------------------------------------------------------------------------
// Ce qui est un clone

test('deux copies d\'une fonction dont les noms changent sont un clone « renomme », aux lignes de chacune', () => {
  const clones = clonesDe({ 'a.js': copie('f'), 'b.js': `var z = 1;\n${copie('g', 'items', 'convertir', 'enabled', 'value')}` });
  assert.equal(clones.length, 1);
  const [c] = clones;
  assert.equal(c.forme, 'fonction');
  assert.equal(c.type, 'renomme');
  assert.equal(c.masse, 59);
  assert.equal(c.lignes, 11);
  assert.deepEqual(endroits(c), ['a.js:1-11', 'b.js:2-12']);
});

test('deux copies identiques sont un clone « identique » : les blancs, les commentaires et la façon d\'écrire une chaîne n\'y changent rien', () => {
  const retouchee = copie('f').replace("'ignoré'", '"ignoré"').replace('const resultat', '/* le tableau */   const   resultat').replace('{\n', '{ // début\n');
  const [c, ...autres] = clonesDe({ 'a.js': copie('f'), 'b.js': retouchee });
  assert.equal(autres.length, 0);
  assert.equal(c.type, 'identique');
});

test('une valeur de chaîne ou de nombre qui change ne fait pas un autre code : clone « renomme »', () => {
  const [c, ...autres] = clonesDe({ 'a.js': copie('f'), 'b.js': copie('f').replace("'ignoré'", "'autre message'").replace('> 0', '> 10') });
  assert.equal(autres.length, 0);
  assert.equal(c.type, 'renomme');
});

for (const [nom, retouche] of [
  ['un booléen de plus', (s) => s.replace('const resultat = [];', 'const resultat = []; const ok = true;')],
  ['un opérateur', (s) => s.replace('> 0', '< 0')],
  ['une comparaison à null au lieu d\'un nombre', (s) => s.replace('> 0', '!== null')],
  ['une instruction de plus', (s) => s.replace('return resultat;', 'resultat.sort(); return resultat;')],
  ['une branche de moins', (s) => s.replace(/ else \{[^}]*\}/, '')],
  ['une boucle for…of à la place de for', (s) => s.replace('for (let i = 0; i < liste.length; i++)', 'for (const i of liste)')],
]) {
  test(`${nom} d'écart : la fonction n'est plus un clone`, () => {
    const autre = retouche(copie('g'));
    assert.notEqual(autre, copie('g'), 'la retouche doit changer le code');
    assert.deepEqual(fonctionsClonees({ 'a.js': copie('f'), 'b.js': autre }), []);
  });
}

test('un booléen qui change est un autre code (les booléens et null se comparent exactement, les chaînes et les nombres non)', () => {
  const avec = (v) => `function f(a) {\n  if (a.x) { g(a, ${v}); h(a.y, ${v}); k(a.z); }\n  for (const e of a) { m(e, ${v}); n(e); o(e); }\n  return a.map((e) => p(e, ${v}));\n}\n`;
  const petit = { masse: 10, logique: 2 };
  assert.deepEqual(fonctionsClonees({ 'a.js': avec('true'), 'b.js': avec('false') }, petit), []);
  assert.equal(fonctionsClonees({ 'a.js': avec('1'), 'b.js': avec('2') }, petit).length, 1);
  assert.equal(fonctionsClonees({ 'a.js': avec('true'), 'b.js': avec('true') }, petit).length, 1);
  assert.deepEqual(fonctionsClonees({ 'a.js': avec('null'), 'b.js': avec('true') }, petit), []);
});

test('une expression régulière qui change est un autre code', () => {
  const avec = (motif) => `function f(a) {\n  if (${motif}.test(a.x)) { g(a); h(a.y); k(a.z); }\n  for (const e of a) { m(e); n(e); o(e); }\n  return a.map((e) => p(e));\n}\n`;
  const petit = { masse: 10, logique: 2 };
  assert.deepEqual(fonctionsClonees({ 'a.js': avec('/ab+/'), 'b.js': avec('/ab*/') }, petit), []);
  assert.deepEqual(fonctionsClonees({ 'a.js': avec('/ab+/'), 'b.js': avec('/ab+/i') }, petit), []);
  assert.equal(fonctionsClonees({ 'a.js': avec('/ab+/'), 'b.js': avec('/ab+/') }, petit).length, 1);
});

test('un gabarit de texte dont le texte change est un clone ; une expression de plus ne l\'est pas', () => {
  const avec = (gabarit) => `function f(a) {\n  const t = ${gabarit};\n  if (t.length) { g(a, t); h(t); k(a.z); }\n  for (const e of a) { m(e, t); n(e); }\n  return a.map((e) => p(e));\n}\n`;
  const petit = { masse: 10, logique: 2 };
  assert.equal(fonctionsClonees({ 'a.js': avec('`bonjour ${a.nom}`'), 'b.js': avec('`salut ${a.nom}`') }, petit).length, 1);
  assert.deepEqual(fonctionsClonees({ 'a.js': avec('`bonjour ${a.nom}`'), 'b.js': avec('`bonjour ${a.nom} ${a.id}`') }, petit), []);
});

test('un renommage doit être cohérent : la même variable doit être au même endroit', () => {
  assert.equal(fonctionsClonees({ 'a.js': copie('f'), 'b.js': copie('g', 'items', 'convertir') }).length, 1, 'témoin : le même code renommé de bout en bout est un clone');
  // `convertir(items[i])` devient `items(items[i])` : deux noms distincts de la copie d'origine y sont un seul.
  assert.deepEqual(fonctionsClonees({ 'a.js': copie('f'), 'b.js': copie('g', 'items', 'items') }), []);
});

test('un renommage cohérent vaut aussi pour le premier nom d\'un fichier : la fonction qui s\'appelle elle-même n\'est pas la copie d\'une qui en appelle une autre', () => {
  const recursive = (nom, appelee) => `function ${nom}(n) {\n  if (n > 1 && n < 100) { g(n); h(n, 2); k(n - 1); }\n  for (const e of n) { m(e); p(e); q(e); }\n  return ${appelee}(n - 1);\n}\n`;
  const petit = { masse: 10, logique: 2 };
  assert.equal(fonctionsClonees({ 'a.js': recursive('f', 'f'), 'b.js': recursive('g2', 'g2') }, petit).length, 1, 'témoin : la récursion se renomme avec la fonction');
  assert.deepEqual(fonctionsClonees({ 'a.js': recursive('f', 'f'), 'b.js': recursive('g2', 'h2') }, petit), []);
});

test('les noms de propriétés se renomment comme les autres, et de façon cohérente', () => {
  assert.equal(fonctionsClonees({ 'a.js': copie('f'), 'b.js': copie('g', 'liste', 'transformer', 'enabled', 'value') }).length, 1);
  // `actif` et `valeur` deviennent le même nom : le renommage n'est plus un pour un.
  assert.deepEqual(fonctionsClonees({ 'a.js': copie('f'), 'b.js': copie('g', 'liste', 'transformer', 'enabled', 'enabled') }), []);
});

test('un nom privé se renomme de façon cohérente, lui aussi', () => {
  const classe = (nom, a, b) => `class ${nom} {\n  #${a} = 1;\n  #${b} = 2;\n  m(x) {\n    if (this.#${a} > x) { g(this.#${b}); h(x, this.#${a}); k(x); }\n    for (const e of x) { m(e, this.#${a}); n(e, this.#${b}); }\n    return x.map((e) => p(e, this.#${b}));\n  }\n}\n`;
  const petit = { masse: 10, logique: 2 };
  const classes = (...sources) => clonesDe(Object.fromEntries(sources.map((s, i) => [`${i}.js`, s])), petit).filter((c) => c.forme === 'fonction' || c.instances[0].ligneFin - c.instances[0].ligne > 5);
  assert.equal(classes(classe('A', 'a', 'b'), classe('B', 'x', 'y')).length, 1);
  // `#a` et `#b` deviennent le même nom privé : le renommage n'est plus un pour un.
  assert.deepEqual(classes(classe('A', 'a', 'b'), classe('B', 'x', 'x').replace('  #x = 2;\n', '')), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Les seuils

test('la masse minimale : cinquante nœuds comptent, quarante-neuf non', () => {
  assert.equal(clonesDe({ 'a.js': fonctionDe('fa', 50, 6), 'b.js': fonctionDe('fb', 50, 6) }).length, 1);
  assert.deepEqual(clonesDe({ 'a.js': fonctionDe('fa', 49, 6), 'b.js': fonctionDe('fb', 49, 6) }), []);
});

test('la logique minimale : six nœuds de logique comptent, cinq non', () => {
  assert.equal(clonesDe({ 'a.js': fonctionDe('fa', 60, 6), 'b.js': fonctionDe('fb', 60, 6) }).length, 1);
  assert.deepEqual(clonesDe({ 'a.js': fonctionDe('fa', 60, 5), 'b.js': fonctionDe('fb', 60, 5) }), []);
});

test('les seuils se donnent à la recherche : un seuil plus bas trouve ce que celui par défaut laisse', () => {
  const sources = { 'a.js': fonctionDe('fa', 30, 4), 'b.js': fonctionDe('fb', 30, 4) };
  assert.deepEqual(clonesDe(sources), []);
  assert.equal(clonesDe(sources, { masse: 30, logique: 4 }).length, 1);
  assert.deepEqual(clonesDe(sources, { masse: 31, logique: 4 }), []);
  assert.deepEqual(clonesDe(sources, { masse: 30, logique: 5 }), []);
});

test('des données ne sont pas des clones : un tableau d\'objets copié reste une donnée, quelle que soit sa taille', () => {
  const donnees = (n) => `const TABLE = [\n${Array.from({ length: 40 }, (_, i) => `  { id: ${i}, nom: 'nom ${i + n}', code: [${i}, ${i + 1}, ${i + 2}] },`).join('\n')}\n];\n`;
  assert.deepEqual(clonesDe({ 'a.js': donnees(0), 'b.js': donnees(1) }), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Les exemplaires

test('trois copies sont un clone à trois exemplaires, dans l\'ordre des unités', () => {
  const clones = clonesDe({ 'a.js': copie('f'), 'b.js': copie('g'), 'c.js': copie('h') });
  assert.equal(clones.length, 1);
  assert.deepEqual(endroits(clones[0]), ['a.js:1-11', 'b.js:1-11', 'c.js:1-11']);
});

test('deux copies d\'un même fichier sont un clone, avec chacune ses lignes', () => {
  const clones = clonesDe({ 'a.js': `${copie('f')}var z = 1;\n${copie('g')}` });
  assert.equal(clones.length, 1);
  assert.deepEqual(endroits(clones[0]), ['a.js:1-11', 'a.js:13-23']);
});

test('un clone se dit aux lignes que `ligneDe` et `ligneFinDe` donnent : un script de page a son décalage dans la page', () => {
  const unites = [unite('page.html', copie('f'), 40), unite('page.html', copie('g'), 100)];
  const { clones } = detecterClones(unites);
  assert.deepEqual(endroits(clones[0]), ['page.html:41-51', 'page.html:101-111']);
});

test('une fonction copiée est un clone, non autant de clones que de blocs et d\'instructions qu\'elle contient', () => {
  const longue = (nom, p) => `function ${nom}(a) {\n${Array.from({ length: 20 }, (_, i) => `  if (a.${p}${i}) { g(a.${p}${i}, ${i}); h(a); }`).join('\n')}\n  return a;\n}\n`;
  const clones = clonesDe({ 'a.js': longue('ff', 'x'), 'b.js': longue('gg', 'y') });
  assert.equal(clones.length, 1);
  assert.equal(clones[0].forme, 'fonction');
});

test('les clones se rendent du plus gros au plus petit', () => {
  const clones = clonesDe({ 'a.js': `${copie('f')}${fonctionDe('petite', 52, 6)}`, 'b.js': `${fonctionDe('petite2', 52, 6)}${copie('g')}` });
  assert.deepEqual(clones.map((c) => c.masse), [59, 52]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Les suites d'instructions

/** Une suite de trois instructions de masse et de logique suffisantes, au milieu de deux fonctions qui diffèrent par ailleurs. */
const SUITE = [
  'const total = lignes.reduce((s, x) => s + x.prix * x.quantite, 0);',
  'if (total > limite) { notifier("trop", total); }',
  'afficher(total.toFixed(2));',
];
const CORPS = (avant, suite, apres) => `function f(lignes, limite) {\n  ${avant}\n  ${suite.join('\n  ')}\n  ${apres}\n}\n`;

test('une suite d\'instructions copiée au milieu de deux fonctions différentes est un clone « suite », de la première à la dernière de ses instructions', () => {
  const clones = clonesDe({
    'a.js': CORPS('init(lignes);', SUITE, 'return 1;'),
    'b.js': CORPS('var z = 0;', SUITE, 'if (limite) { fin(); }'),
  }, { masse: 20, logique: 4 });
  assert.equal(clones.length, 1);
  assert.equal(clones[0].forme, 'suite');
  assert.deepEqual(endroits(clones[0]), ['a.js:3-5', 'b.js:3-5']);
});

test('une suite est maximale des deux côtés : ni une instruction de moins, ni une de plus', () => {
  const commun = [...SUITE, 'sauver(total);'];
  const clones = clonesDe({
    'a.js': CORPS('init(lignes);', commun, 'return 1;'),
    'b.js': CORPS('var z = 0;', commun, 'if (limite) { fin(); }'),
  }, { masse: 20, logique: 4 });
  assert.equal(clones.length, 1);
  assert.deepEqual(endroits(clones[0]), ['a.js:3-6', 'b.js:3-6']);
});

test('une suite qui se prolonge vers la gauche pour tous ses exemplaires n\'est pas comptée deux fois : une seule suite, la plus longue', () => {
  const clones = clonesDe({
    'a.js': CORPS('init(lignes);', SUITE, 'return 1;'),
    'b.js': CORPS('init(lignes);', SUITE, 'if (limite) { fin(); }'),
  }, { masse: 20, logique: 4 });
  assert.equal(clones.length, 1);
  assert.deepEqual(endroits(clones[0]), ['a.js:2-5', 'b.js:2-5']);
});

test('trois copies d\'une suite dont une s\'arrête plus tôt : le clone des deux plus longues, et rien du troisième exemplaire s\'il est seul', () => {
  const clones = clonesDe({
    'a.js': CORPS('init(lignes);', [...SUITE, 'sauver(total);'], 'return 1;'),
    'b.js': CORPS('var z = 0;', [...SUITE, 'sauver(total);'], 'if (limite) { fin(); }'),
    'c.js': CORPS('lire();', SUITE, 'retourner();'),
  }, { masse: 20, logique: 4 });
  assert.equal(clones.length, 1);
  assert.deepEqual(endroits(clones[0]), ['a.js:3-6', 'b.js:3-6']);
});

test('trois copies d\'une suite dont l\'une est plus courte, avec des masses qui passent le seuil à trois : un clone de la suite courte à trois exemplaires, un de la longue à deux, sans recouvrement', () => {
  const clones = clonesDe({
    'a.js': CORPS('init(lignes);', [...SUITE, 'sauver(total);'], 'return 1;'),
    'b.js': CORPS('var z = 0;', [...SUITE, 'sauver(total);'], 'if (limite) { fin(); }'),
    'c.js': CORPS('lire();', SUITE, 'retourner();'),
  }, { masse: 5, logique: 1 });
  const parTaille = clones.map((c) => c.instances.length).sort();
  assert.deepEqual(parTaille, [2], 'les deux exemplaires libres de la suite la plus longue la couvrent ; il ne reste qu\'un exemplaire de la courte, qui ne fait pas un clone');
});

/** Une fonction qui porte `lignes`, entre deux instructions à elle : deux fonctions de ce genre n'ont en commun que les lignes du milieu. */
const AUTOUR = (nom, lignes, avant, apres) => `function ${nom}() {\n  ${avant}\n${lignes.join('\n')}\n  ${apres}\n}\n`;
const DOUZE = (fabrique) => Array.from({ length: 12 }, (_, i) => fabrique(i));
const entre = (lignesA, lignesB, seuils) => clonesDe({ 'a.js': AUTOUR('f', lignesA, 'init();', 'return 1;'), 'b.js': AUTOUR('g', lignesB, 'var z = 0;', 'if (z) { fin(); }') }, seuils);

test('une suite d\'appels du même appelé est un tableau écrit en instructions : pas un clone', () => {
  const petit = { masse: 20, logique: 4 };
  assert.deepEqual(entre(DOUZE((i) => `  ui.a${i} = document.getElementById('a${i}');`), DOUZE((i) => `  ui.b${i} = document.getElementById('b${i}');`), petit), [], 'des affectations d\'un même appel');
  assert.deepEqual(entre(DOUZE((i) => `  const a${i} = document.getElementById('a${i}');`), DOUZE((i) => `  const b${i} = document.getElementById('b${i}');`), petit), [], 'des déclarations d\'un même appel');
  assert.deepEqual(entre(DOUZE((i) => `  set('a${i}', ${i}, options.a${i});`), DOUZE((i) => `  set('b${i}', ${i}, options.b${i});`), petit), [], 'des appels du même nom');
  assert.deepEqual(entre(DOUZE((i) => `  a.b.set('a${i}', ${i});`), DOUZE((i) => `  a.b.set('b${i}', ${i});`), petit), [], 'des appels du même nom pointé');
  assert.deepEqual(entre(DOUZE((i) => `  Code["a${i}"] = "${i}";`), DOUZE((i) => `  Code["b${i}"] = "${i}";`), { masse: 20, logique: 0 }), [], 'des affectations de valeurs littérales');
  assert.deepEqual(entre(DOUZE((i) => `  Code.a${i} = -${i};`), DOUZE((i) => `  Code.b${i} = -${i};`), { masse: 20, logique: 0 }), [], 'des affectations de nombres signés');
  assert.deepEqual(entre(DOUZE((i) => `  Code.a${i} = \`texte ${i}\`;`), DOUZE((i) => `  Code.b${i} = \`texte ${i}\`;`), { masse: 20, logique: 0 }), [], 'des affectations de gabarits sans expression');
});

test('une suite d\'appels de noms différents, ou mêlée d\'autre chose, est un clone', () => {
  const petit = { masse: 20, logique: 4 };
  assert.equal(entre(DOUZE((i) => `  appel${i}(options, ${i});`), DOUZE((i) => `  appel${i}(options, ${i});`), petit).length, 1, 'des appels de noms différents');
  assert.equal(entre(DOUZE((i) => (i === 6 ? '  if (options) { fin(); }' : `  set('k${i}', ${i});`)), DOUZE((i) => (i === 6 ? '  if (options) { fin(); }' : `  set('k${i}', ${i});`)), petit).length, 1, 'des appels mêlés d\'une autre instruction');
  assert.equal(entre(DOUZE((i) => (i % 2 ? `  x.k${i} = ${i};` : `  x.k${i} = lire(${i});`)), DOUZE((i) => (i % 2 ? `  x.k${i} = ${i};` : `  x.k${i} = lire(${i});`)), petit).length, 1, 'des affectations de littéraux mêlées d\'affectations d\'appels');
  assert.equal(entre(DOUZE((i) => `  x.k${i} = ${i % 2 ? 'lire' : 'ecrire'}(${i});`), DOUZE((i) => `  x.k${i} = ${i % 2 ? 'lire' : 'ecrire'}(${i});`), petit).length, 1, 'des affectations d\'appels de deux noms');
});

test('le renommage d\'une suite est cohérent sur toute la suite, pas instruction par instruction', () => {
  const suite = (a, b, c, d) => [`  if (${a}) { ${a}.x(${b}); g(${a}); }`, `  if (${c}) { ${c}.y(${d}); h(${c}); }`];
  const petit = { masse: 5, logique: 1 };
  assert.equal(entre(suite('a', 'b', 'c', 'd'), suite('p', 'q', 'r', 's'), petit).length, 1, 'témoin : renommée de bout en bout');
  // la même variable aux deux instructions dans une copie, deux variables dans l'autre : chaque instruction se renomme, la suite non
  const clones = entre(suite('a', 'b', 'c', 'd'), suite('p', 'q', 'p', 's'), petit);
  assert.equal(clones.some((c) => c.forme === 'suite' && c.lignes >= 2), false);
});

test('limite connue : la suite maximale dont les noms ne se correspondent pas un à un est écartée en entier, même quand ses deux premières instructions s\'accordent', () => {
  const suite = (a, b, c, d, e) => [`  if (${a}) { ${a}.x(${b}); g(${a}); }`, `  if (${c}) { ${c}.y(${d}); h(${c}); }`, `  if (${e}) { ${e}.z(); k(${e}); }`];
  const petit = { masse: 5, logique: 1 };
  const deuxSuites = (clones) => clones.filter((c) => c.forme === 'suite' && c.lignes >= 2);
  assert.equal(deuxSuites(entre(suite('a', 'b', 'c', 'd', 'e'), suite('p', 'q', 'r', 's', 't'), petit)).length, 1, 'témoin : renommée de bout en bout, la suite est un clone');
  // la troisième instruction reprend `p`, que la première nomme déjà : `a` et `e` sont deux noms dans une copie, un seul dans l'autre ; les deux premières instructions, seules, s'accorderaient
  assert.equal(deuxSuites(entre(suite('a', 'b', 'c', 'd', 'e'), suite('p', 'q', 'r', 's', 'p'), petit)).length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Ce qui se répète en série

test('une instruction répétée à la suite est un clone à autant d\'exemplaires', () => {
  const bloc = (i) => `  if (a.v${i}) { g(a.v${i}, 'x'); h(a); k(a.z); }\n`;
  const clones = clonesDe({ 'a.js': `function f(a) {\n${[1, 2, 3].map(bloc).join('')}  return a;\n}\n` }, { masse: 15, logique: 3 });
  assert.equal(clones.length, 1);
  assert.equal(clones[0].instances.length, 3);
  assert.deepEqual(endroits(clones[0]), ['a.js:2-2', 'a.js:3-3', 'a.js:4-4']);
});

test('une suite qui se recouvre elle-même (un motif qui se répète) ne compte que des exemplaires disjoints', () => {
  const motif = (i) => `  if (a.p${i}) { g(a.p${i}); }\n  h(a, ${i});\n`;
  const clones = clonesDe({ 'a.js': `function f(a) {\n${[1, 2, 3, 4].map(motif).join('')}}\n` }, { masse: 8, logique: 2 });
  for (const c of clones) {
    const lignes = c.instances.map((i) => [i.ligne, i.ligneFin]).sort((x, y) => x[0] - y[0]);
    for (let k = 1; k < lignes.length; k++) assert.ok(lignes[k][0] > lignes[k - 1][1], `exemplaires recouverts : ${JSON.stringify(lignes)}`);
  }
  assert.ok(clones.length >= 1);
});

test('une instruction qui est déjà un clone seule n\'est pas redite quand une suite plus grosse la couvre', () => {
  const instruction = 'if (total > limite) { notifier("trop", total, lignes.length, limite); sauver(total); }';
  const suite = ['const total = lignes.reduce((s, x) => s + x.prix * x.quantite, 0);', instruction, 'afficher(total.toFixed(2));'];
  const clones = clonesDe({ 'a.js': CORPS('init(lignes);', suite, 'return 1;'), 'b.js': CORPS('var z = 0;', suite, 'if (limite) { fin(); }') }, { masse: 20, logique: 4 });
  assert.equal(clones.length, 1);
  assert.equal(clones[0].forme, 'suite');
});

// ---------------------------------------------------------------------------------------------------------------------
// Les plafonds : ce qui n'est pas comparé est dit

test('sans plafond atteint, la recherche ne laisse rien de côté', () => {
  const { limites } = detecterClones([unite('a.js', copie('f')), unite('b.js', copie('g'))]);
  const { pas, ...laisseDeCote } = limites;
  assert.deepEqual(laisseDeCote, { pasEpuises: false });
  assert.ok(pas > 0, 'la recherche a compté son travail');
});

test('une unité sans arbre est laissée de côté', () => {
  const recherche = creerRecherche();
  assert.equal(recherche.ajouter({ chemin: 'x.js', ast: null, ligneDe: () => 1, ligneFinDe: () => 1 }), false);
  assert.deepEqual(recherche.chercher(), { clones: [], limites: { pasEpuises: false, pas: 0 } });
});

test('le plafond de nœuds : une unité qui le dépasserait n\'est pas gardée, et `ajouter` le dit ; une qui l\'atteint pile l\'est', () => {
  const nombre = (source) => noeudsDe(lire(source).ast).length;
  const n = nombre(copie('f'));
  const exact = creerRecherche({ noeuds: 2 * n });
  assert.deepEqual([exact.ajouter(unite('a.js', copie('f'))), exact.ajouter(unite('b.js', copie('g')))], [true, true]);
  assert.equal(exact.chercher().clones.length, 1);
  const court = creerRecherche({ noeuds: 2 * n - 1 });
  assert.deepEqual([court.ajouter(unite('a.js', copie('f'))), court.ajouter(unite('b.js', copie('g')))], [true, false]);
  assert.deepEqual(court.chercher().clones, []);
});

test('une unité ignorée n\'ôte pas la place des suivantes : une plus petite, après elle, est gardée', () => {
  const grosse = `${copie('f')}${copie('g')}${copie('h')}`;
  const recherche = creerRecherche({ noeuds: noeudsDe(lire(copie('f')).ast).length * 2 });
  assert.equal(recherche.ajouter(unite('a.js', copie('f'))), true);
  assert.equal(recherche.ajouter(unite('grosse.js', grosse)), false);
  assert.equal(recherche.ajouter(unite('b.js', copie('g'))), true);
  assert.equal(recherche.chercher().clones.length, 1);
});

test('un groupe de très nombreux exemplaires se compare comme un autre : aucun plafond d\'exemplaires ne le laisse passer sans rien dire', () => {
  const unites = Array.from({ length: 5001 }, (_, i) => unite(`f${i}.js`, copie('f')));
  const { clones, limites } = detecterClones(unites);
  assert.equal(clones.length, 1);
  assert.equal(clones[0].instances.length, 5001, 'les cinq mille un exemplaires sont tous dits');
  assert.equal(clones[0].forme, 'fonction');
  assert.equal(limites.pasEpuises, false);
});

test('le plafond de pas : la recherche s\'arrête, le dit, et ne rend que ce qu\'elle a achevé', () => {
  const unites = () => [unite('a.js', CORPS('init(lignes);', SUITE, 'return 1;')), unite('b.js', CORPS('var z = 0;', SUITE, 'if (limite) { fin(); }'))];
  const complet = detecterClones(unites(), { masse: 20, logique: 4 });
  assert.equal(complet.clones.length, 1);
  assert.equal(complet.limites.pasEpuises, false);
  const arrete = detecterClones(unites(), { masse: 20, logique: 4, pas: 0 });
  assert.equal(arrete.limites.pasEpuises, true);
  assert.deepEqual(arrete.clones, []);
});

// Le plafond de pas se franchit quand le compte le dépasse : on le règle au pas près, sur des entrées dont le compte se calcule à la main. `limites.pas` dit le compte.

const DEUX = (a, b, c, d) => `if (${a}) { ${b}(); }\nwhile (${c}) { ${d}(); }\n`;
const TROIS = (a, b, c, d, e, f) => `if (${a}) { ${b}(); }\nwhile (${c}) { ${d}(); }\nfor (; ${e}; ) { ${f}(); }\n`;

test('le compte de pas : un pas par exemplaire à chaque instruction qu\'on ajoute à la suite qu\'on étend', () => {
  const deux = () => [unite('a.js', DEUX('a', 'b', 'c', 'd')), unite('b.js', DEUX('x', 'y', 'z', 'w'))];
  assert.equal(detecterClones(deux()).limites.pas, 2, 'deux exemplaires de deux instructions : un tour d\'extension, qui s\'arrête à la fin de la liste');
  assert.equal(detecterClones(deux(), { pas: 2 }).limites.pasEpuises, false, 'le plafond n\'est franchi que quand le compte le dépasse');
  assert.equal(detecterClones(deux(), { pas: 1 }).limites.pasEpuises, true);
  const trois = () => [unite('a.js', TROIS('a', 'b', 'c', 'd', 'e', 'f')), unite('b.js', TROIS('p', 'q', 'r', 's', 't', 'u'))];
  assert.equal(detecterClones(trois()).limites.pas, 4, 'trois instructions : deux tours, la suite de la deuxième fenêtre n\'étant que le décalage de la première');
  assert.equal(detecterClones(trois(), { pas: 4 }).limites.pasEpuises, false);
  assert.equal(detecterClones(trois(), { pas: 3 }).limites.pasEpuises, true);
});

test('le compte de pas : les instructions de chaque exemplaire qu\'on garde, puis la masse de chaque exemplaire dont on compare les noms', () => {
  const trois = () => [unite('a.js', TROIS('a', 'b', 'c', 'd', 'e', 'f')), unite('b.js', TROIS('p', 'q', 'r', 's', 't', 'u'))];
  const seuils = { masse: 15, logique: 3 };                               // la suite de trois instructions (masse 18) en est une ; une seule instruction (masse 6), non
  const complet = detecterClones(trois(), seuils);
  assert.equal(complet.clones.length, 1);
  const [clone] = complet.clones;
  assert.equal(clone.masse, 18);
  const extension = 2 * 2;                                                 // deux exemplaires, deux tours
  const gardes = 2 * 3;                                                    // deux exemplaires de trois instructions
  const noms = 2 * clone.masse;
  assert.equal(complet.limites.pas, extension + gardes + noms);
  assert.equal(complet.limites.pasEpuises, false);
});

test('chacune des deux phases a son plafond : la recherche des suites arrêtée rend ce qu\'elle a trouvé, le choix des clones arrêté rend ce qu\'il a choisi', () => {
  const trois = () => [unite('a.js', TROIS('a', 'b', 'c', 'd', 'e', 'f')), unite('b.js', TROIS('p', 'q', 'r', 's', 't', 'u'))];
  const seuils = { masse: 15, logique: 3 };
  const juste = detecterClones(trois(), { ...seuils, pas: 4 });            // les deux tours d'extension coûtent 4 : le plafond n'est franchi qu'au-delà
  assert.equal(juste.clones.length, 1, 'la suite gardée a coûté 6 de plus, que le plafond ne voit qu\'à un tour suivant : il n\'y en a pas ; le choix repart de zéro');
  assert.equal(juste.limites.pasEpuises, false);
  assert.equal(juste.limites.pas, 4 + 6 + 36);
  const court = detecterClones(trois(), { ...seuils, pas: 3 });
  assert.deepEqual(court.clones, []);
  assert.equal(court.limites.pasEpuises, true);
  assert.equal(court.limites.pas, 4, 'ce qui a été compté avant de s\'arrêter : le deuxième tour est compté, puis refusé');
});

// Deux familles de deux instructions, séparées par une instruction qui diffère d'un fichier à l'autre : elles s'examinent l'une après l'autre.
const FAMILLES = (a, b, c, d, milieu, e, f, g, h) => `if (${a}) { ${b}(); }\nwhile (${c}) { ${d}(); }\n${milieu}\nfor (; ${e}; ) { ${f}(); }\nif (${g}) { ${h}(); }\n`;

test('le compte de pas : ce que coûte une suite gardée pèse sur la recherche des suivantes', () => {
  const familles = () => [unite('a.js', FAMILLES('a', 'b', 'c', 'd', 'var m = 1;', 'e', 'f', 'g', 'h')), unite('b.js', FAMILLES('p', 'q', 'r', 's', 'm();', 't', 'u', 'v', 'w'))];
  const seuils = { masse: 12, logique: 2 };                               // une famille (deux instructions, masse 12) en est un ; une seule instruction, non
  const complet = detecterClones(familles(), seuils);
  assert.deepEqual(complet.clones.map((c) => c.masse), [12, 12]);
  assert.equal(complet.limites.pas, (2 + 2 * 2) + (2 + 2 * 2) + (2 * 12 + 2 * 12), 'par famille : un tour d\'extension et ses deux exemplaires gardés ; puis la comparaison des noms');
  assert.equal(complet.limites.pasEpuises, false);
  // Au tour de la seconde famille, le compte est 2 + 4 + 2 = 8 : la première a coûté ses 4 pas d'exemplaires gardés.
  const arrete = detecterClones(familles(), { ...seuils, pas: 7 });
  assert.equal(arrete.limites.pasEpuises, true);
  assert.deepEqual(arrete.clones.map((c) => c.masse), [12], 'la première famille est rendue, la seconde n\'a pas été cherchée');
  assert.equal(arrete.limites.pas, 8 + 2 * 12, 'huit pas de recherche, puis la comparaison des noms de la seule famille trouvée');
  const juste = detecterClones(familles(), { ...seuils, pas: 8 });
  assert.equal(juste.limites.pas, 12 + 2 * 12, 'la recherche va à son terme (douze) ; le choix, lui, s\'arrête avant la seconde famille : 24 > 8');
  assert.deepEqual(juste.clones.map((c) => c.masse), [12]);
  assert.equal(juste.limites.pasEpuises, true);
  const large = detecterClones(familles(), { ...seuils, pas: 24 });
  assert.deepEqual(large.clones.map((c) => c.masse), [12, 12]);
  assert.equal(large.limites.pasEpuises, false, 'le choix vérifie son compte avant chaque famille : 24 n\'est pas au-dessus de 24');
});

test('le compte de pas : la masse de chaque exemplaire libre, et le plafond se vérifie avant chaque clone', () => {
  const sources = { 'a.js': fonctionDe('f', 60, 2), 'b.js': fonctionDe('k', 60, 2), 'c.js': fonctionDe('h', 59, 2), 'd.js': fonctionDe('i', 59, 2) };
  const unites = () => Object.entries(sources).map(([c, src]) => unite(c, src));
  const complet = detecterClones(unites(), { logique: 2 });
  assert.deepEqual(complet.clones.map((c) => c.masse), [60, 59]);
  assert.equal(complet.limites.pas, 2 * 60 + 2 * 59, 'un pas par nœud de chaque exemplaire dont on compare les noms');
  assert.equal(detecterClones(unites(), { logique: 2, pas: 2 * 60 }).clones.length, 2, 'au plafond : la comparaison du second clone se fait');
  const arrete = detecterClones(unites(), { logique: 2, pas: 2 * 60 - 1 });
  assert.deepEqual(arrete.clones.map((c) => c.masse), [60], 'un cran sous le plafond : le premier clone est rendu, le second est laissé');
  assert.equal(arrete.limites.pasEpuises, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Les entrées piégées

test('un arbre très profond ne fait pas déborder la pile : la recherche le lit sans récursion', () => {
  const profond = (nom, n) => `function ${nom}(a) {\n${'if (a) { '.repeat(n)}g(a);${' }'.repeat(n)}\n}\n`;
  const lecture = lire(profond('f', 1500));
  if (!lecture.ast) return;                                                // acorn lui-même refuse cette profondeur : ce n'est pas ce qu'on essaie ici
  const clones = clonesDe({ 'a.js': profond('f', 1500), 'b.js': profond('g', 1500) }, { masse: 10, logique: 2 });
  assert.equal(clones.length, 1);
});

test('la recherche est la même à chaque fois, et l\'ordre des exemplaires est celui des unités', () => {
  const unites = () => [unite('c.js', copie('h')), unite('a.js', copie('f')), unite('b.js', copie('g'))];
  const une = detecterClones(unites());
  assert.deepEqual(detecterClones(unites()), une);
  assert.deepEqual(endroits(une.clones[0]), ['c.js:1-11', 'a.js:1-11', 'b.js:1-11']);
});
