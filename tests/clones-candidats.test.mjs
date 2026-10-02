import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chercher, endroits, fonctionDe, lignes, mesureDe, separateur, SI, TANT } from './aide-clones.mjs';

/**
 * Ce qui se compare seul, sans une série autour : chaque type d'instruction (une fonction, une classe, une condition, une boucle, un bloc, une déclaration, un `return`…) et les deux
 * façons d'écrire une fonction sans nom. Puis l'ordre où la recherche rend ses clones : du plus gros au plus petit, et à masse égale dans l'ordre des unités, puis des positions.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Les types de nœuds qui se comparent

/** Une instruction de chaque type, écrite pour avoir quelques nœuds de logique : les noms qui s'y trouvent sont ceux que la copie reprend tels quels. */
const INSTRUCTIONS = [
  ['FunctionDeclaration', 'function g(a) { return h(a, 1); }'],
  ['ClassDeclaration', 'class G { m() { return h(1); } }'],
  ['IfStatement', 'if (a) { h(a); } else { k(a); }'],
  ['ForStatement', 'for (let i = 0; i < a; i++) { h(i); }'],
  ['ForInStatement', 'for (const k in a) { h(k); }'],
  ['ForOfStatement', 'for (const k of a) { h(k); }'],
  ['WhileStatement', 'while (a) { h(a); }'],
  ['DoWhileStatement', 'do { h(a); } while (a);'],
  ['SwitchStatement', 'switch (a) { case 1: h(a); break; default: k(a); }'],
  ['TryStatement', 'try { h(a); } catch (e) { k(e); }'],
  ['BlockStatement', '{ h(a); k(a); }'],
  ['VariableDeclaration', 'const r = h(a, k(a), m(a));'],
  ['ExpressionStatement', 'h(a, k(a), m(a));'],
  ['ReturnStatement', 'return h(a, k(a), m(a));'],
  ['ThrowStatement', 'throw h(a, k(a), m(a));'],
  ['LabeledStatement', 'etiquette: while (a) { h(a); }'],
];
const dansUneFonction = (nom, avant, instruction) => `function ${nom}() {\n  ${avant}\n  ${instruction}\n}\n`;

for (const [type, instruction] of INSTRUCTIONS) {
  test(`${type} : l'instruction se compare seule à sa copie, la fonction qui l'entoure étant différente`, () => {
    const a = dansUneFonction('f', 'premier();', instruction);
    const b = dansUneFonction('g', 'second(1);', instruction);
    const { masse } = mesureDe(a, (ast) => ast.body[0].body.body[1]);
    const { clones } = chercher({ 'a.js': a, 'b.js': b }, { masse, logique: 0 });         // la masse de l'instruction exactement : ce qu'elle contient est trop petit pour faire un clone
    assert.equal(clones.length, 1);
    assert.equal(clones[0].forme, type === 'FunctionDeclaration' ? 'fonction' : 'bloc');
    assert.equal(clones[0].type, 'identique');
    assert.equal(clones[0].masse, masse);
    assert.deepEqual(endroits(clones[0]), ['a.js:3-3', 'b.js:3-3']);
  });
}

for (const [type, fonction] of [['FunctionExpression', 'function (e) { h(e); k(e); }'], ['ArrowFunctionExpression', '(e) => { h(e); k(e); }']]) {
  test(`${type} : une fonction sans nom se compare seule à sa copie, et c'est une fonction`, () => {
    const a = `x.on('a', ${fonction});\n`;
    const b = `y.once('b', 1, ${fonction});\n`;
    const { masse } = mesureDe(a, (ast) => ast.body[0].expression.arguments[1]);
    const { clones } = chercher({ 'a.js': a, 'b.js': b }, { masse, logique: 0 });
    assert.equal(clones.length, 1);
    assert.equal(clones[0].forme, 'fonction');
    assert.deepEqual(endroits(clones[0]), ['a.js:1-1', 'b.js:1-1']);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// L'ordre des clones à masse égale : les unités, puis les positions

/** Deux formes de fonctions de même masse (60) et de logiques différentes : deux clones de même masse. */
const X = (nom) => fonctionDe(nom, 60, 2);
const Y = (nom) => fonctionDe(nom, 60, 3);
const L2 = { logique: 2 };

test('deux clones de même masse se rendent dans l\'ordre de leur premier exemplaire : l\'unité d\'abord, la position seulement ensuite', () => {
  // X : u0 (loin du début du fichier) et u3 ; Y : u1 (au début) et u2. Le dernier exemplaire de X est après celui de Y, sa position avant.
  const { clones } = chercher({ 'u0.js': `var z = 1;\n${X('x0')}`, 'u1.js': Y('y1'), 'u2.js': Y('y2'), 'u3.js': X('x3') }, L2);
  assert.deepEqual(clones.map(endroits), [['u0.js:2-2', 'u3.js:1-1'], ['u1.js:1-1', 'u2.js:1-1']]);
});

test('deux clones de même masse dont les premiers exemplaires sont dans la même unité se rendent dans l\'ordre de ces exemplaires, non des derniers', () => {
  // X puis Y dans u0 ; le dernier exemplaire de X est loin dans u1, celui de Y est au début de u2
  const { clones } = chercher({ 'u0.js': lignes(separateur(1), X('x0').trim(), Y('y0').trim()), 'u1.js': lignes(separateur(2), separateur(3), X('x1').trim()), 'u2.js': Y('y2') }, L2);
  assert.deepEqual(clones.map(endroits), [['u0.js:2-2', 'u1.js:3-3'], ['u0.js:3-3', 'u2.js:1-1']]);
});

test('un clone plus gros passe avant un plus petit, quelles que soient leurs unités', () => {
  const grand = (nom) => fonctionDe(nom, 61, 2);
  const { clones } = chercher({ 'u0.js': X('x0'), 'u1.js': X('x1'), 'u2.js': grand('g2'), 'u3.js': grand('g3') }, L2);
  assert.deepEqual(clones.map((c) => c.masse), [61, 60]);
});

const F = 'if (a) { b(); c(); d(); }';           // une instruction de masse 12 et de logique 4, comme une série de deux de `SI`, `TANT` ou `POUR`
const DOUZE = { masse: 12, logique: 4 };

test('à masse égale, une série qui commence avant une instruction seule passe d\'abord, et après elle passe ensuite', () => {
  const serieAvant = chercher({
    'u0.js': lignes(SI(), TANT(), separateur(1), F),
    'u1.js': lignes(SI(), TANT(), separateur(2), F),
  }, DOUZE).clones;
  assert.deepEqual(serieAvant.map((c) => [c.forme, endroits(c)]), [['suite', ['u0.js:1-2', 'u1.js:1-2']], ['bloc', ['u0.js:4-4', 'u1.js:4-4']]]);
  const serieApres = chercher({
    'u0.js': lignes(separateur(1), F, separateur(2), SI(), TANT()),
    'u1.js': lignes(separateur(3), F, separateur(4), SI(), TANT()),
  }, DOUZE).clones;
  assert.deepEqual(serieApres.map((c) => [c.forme, endroits(c)]), [['bloc', ['u0.js:2-2', 'u1.js:2-2']], ['suite', ['u0.js:4-5', 'u1.js:4-5']]]);
});

test('deux séries de même masse se rendent dans l\'ordre de leur premier exemplaire : l\'unité d\'abord, quel que soit le nombre d\'exemplaires', () => {
  // la série `TANT SI` (u0, u1, u4) a plus d'exemplaires que `SI TANT` (u2, u3) mais commence dans une unité plus tôt ; elle commence aussi plus loin dans son fichier
  const { clones } = chercher({
    'u0.js': lignes(separateur(1), TANT(), SI()),
    'u1.js': lignes(separateur(2), TANT(), SI()),
    'u2.js': lignes(SI(), TANT()),
    'u3.js': lignes(SI(), TANT()),
    'u4.js': lignes(separateur(3), TANT(), SI()),
  }, DOUZE);
  assert.deepEqual(clones.map(endroits), [['u0.js:2-3', 'u1.js:2-3', 'u4.js:2-3'], ['u2.js:1-2', 'u3.js:1-2']]);
});

test('deux séries de même masse qui commencent dans la même unité se rendent dans l\'ordre de leur position, quel que soit le nombre d\'exemplaires', () => {
  // `SI TANT` (u0, u1) commence plus loin dans u0 que `TANT SI` (u0, u1, u2), qui a plus d'exemplaires
  const { clones } = chercher({
    'u0.js': lignes(TANT(), SI(), separateur(1), SI(), TANT()),
    'u1.js': lignes(TANT(), SI(), separateur(2), SI(), TANT()),
    'u2.js': lignes(TANT(), SI(), separateur(3)),
  }, DOUZE);
  assert.deepEqual(clones.map(endroits), [['u0.js:1-2', 'u1.js:1-2', 'u2.js:1-2'], ['u0.js:4-5', 'u1.js:4-5']]);
});

test('deux séries de même masse qui commencent dans la même unité se rendent dans l\'ordre de leur premier exemplaire, non du dernier', () => {
  // `TANT SI` (u0 puis u2, où il est loin du début) commence avant `SI TANT` (u0 puis u1, où il est au début du fichier) dans u0
  const { clones } = chercher({
    'u0.js': lignes(TANT(), SI(), separateur(1), SI(), TANT()),
    'u1.js': lignes(SI(), TANT(), separateur(2)),
    'u2.js': lignes(separateur(3), TANT(), SI()),
  }, DOUZE);
  assert.deepEqual(clones.map(endroits), [['u0.js:1-2', 'u2.js:2-3'], ['u0.js:4-5', 'u1.js:1-2']]);
});
