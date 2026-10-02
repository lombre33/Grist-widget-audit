import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clonesDe, endroits, lignes, POUR, separateur, SI, TANT } from './aide-clones.mjs';

/**
 * Une suite d'appels du même appelé (`set('a', 1); set('b', 2); …`), de déclarations ou d'affectations dont la valeur est un tel appel, ou d'affectations de valeurs
 * littérales est un tableau écrit en instructions : la répétition y est l'idiome, ce n'est pas du code copié. Ces essais prennent chaque ingrédient de ce qui fait une telle
 * suite, un à un : le nom de l'appelé, ce qui est un littéral, ce qui est une affectation, une déclaration, un appel. Chacun met deux fois douze lignes de même forme
 * côte à côte : ce n'est pas un clone quand elles sont l'idiome, c'en est un sinon.
 */

const AUTOUR = (nom, corps, avant, apres) => `function ${nom}() {\n  ${avant}\n${corps.join('\n')}\n  ${apres}\n}\n`;
const DOUZE = (fabrique) => Array.from({ length: 12 }, (_, i) => fabrique(i));
const SEUILS = { masse: 20, logique: 0 };
/** Les clones de deux fonctions qui n'ont en commun que les douze lignes du milieu (3 à 14) : leurs première et dernière lignes diffèrent, la série ne se prolonge pas. */
const entre = (corpsA, corpsB = corpsA) => clonesDe({
  'a.js': AUTOUR('f', corpsA, 'init();', 'return 1;'),
  'b.js': AUTOUR('g', corpsB, 'var z = 0;', 'if (z) { fin(); }'),
}, SEUILS);

// ---------------------------------------------------------------------------------------------------------------------
// Ce qui est un idiome : douze lignes qui ne sont pas un clone

const IDIOMES = [
  ['des affectations d\'un même appel', (i) => `  ui.a${i} = document.getElementById('a${i}');`],
  ['des déclarations d\'un même appel', (i) => `  const a${i} = document.getElementById('a${i}');`],
  ['des appels du même nom', (i) => `  set('a${i}', ${i}, options.a${i});`],
  ['des appels du même nom pointé', (i) => `  a.b.set('a${i}', ${i});`],
  ['des appels du même nom pointé trois fois', (i) => `  a.b.c.set('a${i}', ${i});`],
  ['des appels du même nom pointé sur this', (i) => `  this.set('a${i}', ${i});`],
  ['des affectations de chaînes', (i) => `  Code["a${i}"] = "${i}";`],
  ['des affectations de nombres', (i) => `  Code.a${i} = ${i};`],
  ['des affectations de nombres signés', (i) => `  Code.a${i} = -${i};`],
  ['des affectations de nombres précédés d\'un plus', (i) => `  Code.a${i} = +${i};`],
  ['des affectations de booléens niés', (i) => `  Code.a${i} = !${i % 2};`],
  ['des affectations de gabarits sans expression', (i) => `  Code.a${i} = \`texte ${i}\`;`],
  ['des affectations d\'appels du même nom', (i) => `  x.k${i} = lire(${i});`],
];
for (const [nom, ligne] of IDIOMES) {
  test(`${nom} : l'idiome, pas un clone`, () => {
    assert.deepEqual(entre(DOUZE(ligne)), []);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Ce qui n'en est pas un : douze lignes de même forme sont un clone

const ECRITES = [
  ['des appels de noms différents', (i) => `  appel${i}(options, ${i});`],
  ['des appels mêlés d\'une autre instruction', (i) => (i === 6 ? '  if (options) { fin(); }' : `  set('k${i}', ${i});`)],
  ['des appels du même nom mêlés d\'une seule affectation de littéral', (i) => (i === 5 ? '  options.k = 5;' : `  set('k${i}', ${i});`)],
  ['des affectations de littéraux mêlées d\'affectations d\'appels', (i) => (i % 2 ? `  x.k${i} = ${i};` : `  x.k${i} = lire(${i});`)],
  ['des affectations d\'appels de deux noms', (i) => `  x.k${i} = ${i % 2 ? 'lire' : 'ecrire'}(${i});`],
  ['des affectations de valeurs qui ne sont pas des littéraux', (i) => `  x.k${i} = v${i};`],
  ['des affectations d\'une opération sur un littéral', (i) => `  x.k${i} = typeof ${i};`],
  ['des affectations de gabarits à expression', (i) => `  Code.a${i} = \`texte \${v${i}}\`;`],
  ['des affectations composées d\'un même appel', (i) => `  x.k${i} += lire(${i});`],
  ['des déclarations de deux déclarants', (i) => `  const a${i} = lire(${i}), b${i} = lire(${i});`],
  ['des déclarations sans valeur', (i) => `  let a${i};`],
  ['des appels d\'un appelé calculé', () => '  handlers[kind](options);'],
  ['des appels d\'un appelé qui est un appel', (i) => `  fabriquer('a${i}')(options, ${i});`],
  ['des appels dont le nom pointé s\'écrit tantôt a.b, tantôt ab', (i) => (i % 2 ? `  a.b(options, ${i});` : `  ab(options, ${i});`)],
  ['des appels dont le premier est d\'un appelé sans nom', (i) => (i === 0 ? '  fabriquer(a)(b);' : `  set('k${i}', ${i});`)],
  ['des appels dont le dernier a un autre nom', (i) => (i === 11 ? '  autre(options, 11);' : `  set('k${i}', ${i});`)],
  ['des appels dont un seul, au milieu, a un autre nom', (i) => (i === 5 ? '  autre(options, 5);' : `  set('k${i}', ${i});`)],
  ['des appels dont le premier a un autre nom', (i) => (i === 0 ? '  autre(options, 0);' : `  set('k${i}', ${i});`)],
];
for (const [nom, ligne] of ECRITES) {
  test(`${nom} : du code copié, un clone`, () => {
    const clones = entre(DOUZE(ligne));
    assert.equal(clones.length, 1);
    assert.equal(clones[0].forme, 'suite');
    assert.deepEqual(endroits(clones[0]), ['a.js:3-14', 'b.js:3-14']);
  });
}

test('des appels d\'un appelé à propriété privée ne sont pas un idiome : le nom d\'un appelé qui n\'est ni un nom ni this ne se compare pas', () => {
  const classe = (corps, avant, apres) => `class A {\n  #envoyer() {}\n  m(options) {\n    ${avant}\n${corps.join('\n')}\n    ${apres}\n  }\n}\n`;
  const lignesPrivees = DOUZE((i) => `    this.#envoyer(options, ${i});`);
  const clones = clonesDe({ 'a.js': classe(lignesPrivees, 'init();', 'return 1;'), 'b.js': classe(lignesPrivees, 'var z = 0;', 'if (z) { fin(); }') }, SEUILS);
  assert.equal(clones.length, 1);
  assert.deepEqual(endroits(clones[0]), ['a.js:5-16', 'b.js:5-16']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Un idiome à lui seul n'est pas un clone, même entre des copies de même forme que lui

/** Une fonction dont les douze lignes du milieu sont `corps`, entre deux instructions de forme propre à `k` : aucune autre fonction ne lui ressemble que par ces douze lignes. */
const unique = (nom, corps, k) => AUTOUR(nom, corps, separateur(k), separateur(k + 10));

test('un idiome qui a la forme de copies n\'est pas un clone : seules les copies le sont', () => {
  const clones = clonesDe({
    'idiome.js': unique('f', DOUZE((i) => `  set('k${i}', ${i});`), 1),
    'copie1.js': unique('g', DOUZE((i) => `  placer${i}('k${i}', ${i});`), 2),
    'copie2.js': unique('h', DOUZE((i) => `  placer${i}('k${i}', ${i});`), 3),
  }, SEUILS);
  assert.deepEqual(clones.map(endroits), [['copie1.js:3-14', 'copie2.js:3-14']]);
});

test('une copie qui a la forme d\'un idiome reste une copie, et deux idiomes qui lui ressemblent ne sont pas un clone', () => {
  const clones = clonesDe({
    'idiome1.js': unique('f', DOUZE((i) => `  set('k${i}', ${i});`), 1),
    'copie1.js': unique('g', DOUZE((i) => `  placer${i}('k${i}', ${i});`), 2),
    'idiome2.js': unique('h', DOUZE((i) => `  put('k${i}', ${i});`), 3),
    'copie2.js': unique('k', DOUZE((i) => `  placer${i}('k${i}', ${i});`), 4),
  }, SEUILS);
  assert.deepEqual(clones.map(endroits), [['copie1.js:3-14', 'copie2.js:3-14']]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Les listes d'instructions où se cherche une série

const SERIE = [SI(), TANT(), POUR()].map((instruction) => `    ${instruction}`).join('\n');
const TROIS = { masse: 15, logique: 3 };

test('une série dans un bloc statique de classe est comparée', () => {
  const classeA = `class A {\n  m() { return 1; }\n  static {\n${SERIE}\n  }\n}\n`;
  const classeB = `class B {\n  static {\n${SERIE}\n  }\n  n(a) { return a; }\n}\n`;
  const clones = clonesDe({ 'a.js': classeA, 'b.js': classeB }, TROIS);
  assert.deepEqual(clones.map((c) => [c.forme, ...endroits(c)]), [['suite', 'a.js:4-6', 'b.js:3-5']]);
});

test('une série dans un `case` est comparée', () => {
  const choixA = `function f(x) {\n  switch (x) {\n    case 1:\n${SERIE}\n  }\n}\n`;
  const choixB = `function g(x, y) {\n  switch (y) {\n    case 2:\n${SERIE}\n    case 3:\n      z();\n  }\n  return x;\n}\n`;
  const clones = clonesDe({ 'a.js': choixA, 'b.js': choixB }, TROIS);
  assert.deepEqual(clones.map((c) => [c.forme, ...endroits(c)]), [['suite', 'a.js:4-6', 'b.js:4-6']]);
});

test('une série dans un bloc, dans une fonction, au niveau supérieur d\'un fichier est comparée', () => {
  const plat = (avant) => lignes(avant, SI(), TANT(), POUR());
  const dansBloc = (avant) => `{\n${plat(avant)}}\n`;
  const dansFonction = (avant) => `function f() {\n${plat(avant)}}\n`;
  assert.deepEqual(clonesDe({ 'a.js': plat('a;'), 'b.js': plat('a.b;') }, TROIS).map(endroits), [['a.js:2-4', 'b.js:2-4']]);
  assert.deepEqual(clonesDe({ 'a.js': dansBloc('a;'), 'b.js': dansBloc('a.b;') }, TROIS).map(endroits), [['a.js:3-5', 'b.js:3-5']]);
  assert.deepEqual(clonesDe({ 'a.js': dansFonction('a;'), 'b.js': dansFonction('a.b;') }, TROIS).map(endroits), [['a.js:3-5', 'b.js:3-5']]);
});
