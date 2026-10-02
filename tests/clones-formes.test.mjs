import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lire } from '../src/moteur/analyse-js.js';
import { creerTables, detecterClones, noeudsDe, numeroter } from '../src/moteur/clones.js';

/**
 * La forme d'un nœud (voir `numeroter` dans `src/moteur/clones.js`) dit ce qui rend deux morceaux de code « le même » : son type, ses attributs, ses enfants, la valeur de ses
 * littéraux. Ces essais prennent chaque ingrédient un à un : le type de nœud qui porte de la logique, l'attribut qui change le sens d'un nœud (`const` et `let`, `a[b]` et `a.b`),
 * la façon dont un littéral se compare, la place d'un enfant. Chacun montre deux morceaux qui ne diffèrent que par cela : un clone ou non selon que cela compte, et, pour un clone,
 * `identique` ou `renomme`. Les essais de `tests/clones.test.mjs` disent ce que la recherche fait de ces formes.
 */

const unite = (chemin, source) => {
  const { ast, erreur } = lire(source);
  assert.ok(ast, `la source doit se lire : ${erreur?.message}`);
  return { chemin, ast, ligneDe: (n) => n.loc.start.line, ligneFinDe: (n) => n.loc.end.line };
};
const clonesDe = (a, b, seuils) => detecterClones([unite('a.js', a), unite('b.js', b)], seuils).clones;
/** Les seuils les plus bas : le moindre bloc compte, si bien que seule la forme décide. */
const BAS = { masse: 1, logique: 0 };
/** Le nombre de nœuds du premier bloc d'une source. */
const masseDe = (source) => {
  const { ast } = lire(source);
  numeroter(noeudsDe(ast), creerTables());
  return ast.body[0].__m;
};
/** Les seuils où seul le bloc entier compte, avec ce qu'il a de commun comme sans : une partie commune (un corps vide, une instruction) est trop petite pour faire un clone à elle seule. */
const SEUILS_DU_BLOC = (a, b) => ({ masse: Math.min(masseDe(a), masseDe(b)), logique: 0 });

// ---------------------------------------------------------------------------------------------------------------------
// La logique : chaque type de nœud de la liste compte, un à un

/**
 * Pour chaque type de nœud qui porte de la logique : un bloc qui n'en porte pas d'autre que lui et ceux que sa syntaxe impose (la fonction d'un `yield`, la boucle d'un `continue` ;
 * le troisième terme les compte). Deux copies du bloc sont un clone au seuil de logique `n`, et pas au seuil `n + 1` : si un des types ne comptait plus, le seuil `n` ne serait pas atteint.
 */
const BLOCS_DE_LOGIQUE = [
  ['CallExpression', '{ f(); }', 1],
  ['NewExpression', '{ new A(); }', 1],
  ['AssignmentExpression', '{ a = b; }', 1],
  ['UpdateExpression', '{ a++; }', 1],
  ['IfStatement', '{ if (a) b; }', 1],
  ['ForStatement', '{ for (;;) a; }', 1],
  ['ForInStatement', '{ for (a in b) c; }', 1],
  ['ForOfStatement', '{ for (a of b) c; }', 1],
  ['WhileStatement', '{ while (a) b; }', 1],
  ['DoWhileStatement', '{ do a; while (b); }', 1],
  ['SwitchStatement', '{ switch (a) { case b: c; } }', 1],
  ['TryStatement', '{ try { a; } catch (e) { b; } }', 1],
  ['ReturnStatement', '{ function g() { return a; } }', 2],
  ['ThrowStatement', '{ throw a; }', 1],
  ['FunctionExpression', '{ (function () {}); }', 1],
  ['ArrowFunctionExpression', '{ (() => {}); }', 1],
  ['FunctionDeclaration', '{ function g() {} }', 1],
  ['ClassDeclaration', '{ class A {} }', 1],
  ['ClassExpression', '{ (class {}); }', 1],
  ['YieldExpression', '{ function* g() { yield a; } }', 2],
  ['AwaitExpression', '{ async function g() { await a; } }', 2],
  ['ConditionalExpression', '{ a ? b : c; }', 1],
  ['LogicalExpression', '{ a && b; }', 1],
  ['BreakStatement', '{ l: { break l; } }', 1],
  ['ContinueStatement', '{ while (a) continue; }', 2],
];

for (const [type, bloc, logique] of BLOCS_DE_LOGIQUE) {
  test(`${type} porte de la logique : deux copies de ${bloc} sont un clone au seuil ${logique}, pas au seuil ${logique + 1}`, () => {
    assert.equal(clonesDe(bloc, bloc, { masse: 1, logique }).length, 1);
    assert.equal(clonesDe(bloc, bloc, { masse: 1, logique: logique + 1 }).length, 0);
  });
}

test('un bloc de nœuds qui ne portent pas de logique (une déclaration, un identifiant, une opération) ne compte aucune logique', () => {
  const bloc = '{ const a = b + c * 2; d.e; [f, g]; ({ h: 1 }); }';
  assert.equal(clonesDe(bloc, bloc, { masse: 1, logique: 0 }).length, 1);
  assert.equal(clonesDe(bloc, bloc, { masse: 1, logique: 1 }).length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Les attributs : ce qui change le sens d'un nœud sans changer ses enfants

/**
 * Pour chaque attribut dont la forme tient compte : deux blocs qui ne diffèrent que par lui, avec les mêmes enfants et les mêmes noms. Le bloc n'a qu'une instruction, qui porte la
 * différence : aucune partie commune ne fait un clone à elle seule.
 */
const PAIRES_D_ATTRIBUT = [
  ['operator', '{ a + b; }', '{ a - b; }'],
  ['kind', '{ const a = 1; }', '{ let a = 1; }'],
  ['computed', '{ a[b]; }', '{ a.b; }'],
  ['async', '{ async function f() {} }', '{ function f() {} }'],
  ['generator', '{ function* f() {} }', '{ function f() {} }'],
  ['delegate', '{ function* f() { yield* a; } }', '{ function* f() { yield a; } }'],
  ['prefix', '{ ++a; }', '{ a++; }'],
  ['static', '{ class A { static m() {} } }', '{ class A { m() {} } }'],
  ['shorthand', '{ ({ a }); }', '{ ({ a: a }); }'],
  ['method', '{ ({ m() {} }); }', '{ ({ m: function () {} }); }'],
  ['optional', '{ a?.b.c; }', '{ a?.b?.c; }'],
  ['await', '{ async function f() { for await (a of b) c; } }', '{ async function f() { for (a of b) c; } }'],
];

for (const [attribut, a, b] of PAIRES_D_ATTRIBUT) {
  test(`l'attribut « ${attribut} » compte : ${a} et ${b} ne sont pas des clones`, () => {
    const seuils = SEUILS_DU_BLOC(a, b);
    assert.equal(clonesDe(a, a, seuils).length, 1, 'la même copie est un clone');
    assert.equal(clonesDe(b, b, seuils).length, 1, 'la même copie est un clone');
    assert.deepEqual(clonesDe(a, b, seuils), []);
  });
}

test('les attributs d\'un nœud comptent tous, non le dernier seul : une méthode statique et une qui ne l\'est pas, de même genre, ne sont pas des clones', () => {
  for (const [a, b] of [['{ class A { static get m() { return 1; } } }', '{ class A { get m() { return 1; } } }'], ['{ class A { static m() {} } }', '{ class A { static [m]() {} } }']]) {
    assert.deepEqual(clonesDe(a, b, SEUILS_DU_BLOC(a, b)), []);
  }
});

test('le type d\'un nœud compte : deux nœuds de mêmes enfants, de même attribut, de types différents ne sont pas des clones', () => {
  for (const [a, b] of [['{ function f(a) { return a; } }', '{ function f(a) { throw a; } }'], ['{ async function f(a) { f(...a); } }', '{ async function f(a) { f(await a); } }']]) {
    assert.deepEqual(clonesDe(a, b, SEUILS_DU_BLOC(a, b)), []);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Les littéraux et les noms : ce qui change et ne change pas la forme

const typeDuClone = (a, b, seuils = SEUILS_DU_BLOC(a, b)) => {
  const clones = clonesDe(a, b, seuils);
  assert.equal(clones.length, 1, `${a} et ${b} sont un clone`);
  return clones[0].type;
};

test('un nom privé se renomme : deux classes qui ne diffèrent que par le nom d\'un champ privé sont un clone « renomme », deux classes pareilles un clone « identique »', () => {
  const classe = (nom) => `{ class A { #${nom} = 1; m() { return this.#${nom}; } } }`;
  assert.equal(typeDuClone(classe('x'), classe('y')), 'renomme');
  assert.equal(typeDuClone(classe('x'), classe('x')), 'identique');
});

test('un nom privé n\'est pas un nom ordinaire : `this.#x` et `this.x` ne sont pas des clones', () => {
  const a = '{ class A { #x = 1; m() { return this.#x; } } }';
  const b = '{ class A { x = 1; m() { return this.x; } } }';
  assert.deepEqual(clonesDe(a, b, SEUILS_DU_BLOC(a, b)), []);
});

test('un gabarit de texte se compare par son texte interprété : `\\x41` et `A` sont le même texte, `a` et `b` non', () => {
  assert.equal(typeDuClone('{ f(`\\x41${x}`); }', '{ f(`A${x}`); }'), 'identique');
  assert.equal(typeDuClone('{ f(`a${x}`); }', '{ f(`b${x}`); }'), 'renomme');
  assert.equal(typeDuClone('{ f(`a${x}`); }', '{ f(`a${x}`); }'), 'identique');
});

test('un grand entier est une valeur comme une autre : deux valeurs différentes sont un clone « renomme », deux pareilles un clone « identique »', () => {
  assert.equal(typeDuClone('{ f(1n); }', '{ f(2n); }'), 'renomme');
  assert.equal(typeDuClone('{ f(1n); }', '{ f(1n); }'), 'identique');
});

test('une chaîne et un nombre sont deux genres de valeurs : `f(\'a\')` et `f(1)` ne sont pas des clones', () => {
  assert.deepEqual(clonesDe("{ f('a'); }", '{ f(1); }', SEUILS_DU_BLOC("{ f('a'); }", '{ f(1); }')), []);
  assert.equal(typeDuClone("{ f('a'); }", "{ f('b'); }"), 'renomme');
  assert.equal(typeDuClone('{ f(1); }', '{ f(2); }'), 'renomme');
});

test('la place d\'un élément absent compte : `[a, , b]` et `[a, b]` ne sont pas des clones, ni `[, a]` et `[a]`', () => {
  for (const [a, b] of [['{ x = [a, , b]; }', '{ x = [a, b]; }'], ['{ x = [, a]; }', '{ x = [a]; }'], ['{ x = [a, , b]; }', '{ x = [a, b, ,]; }'], ['{ x = [a, , b]; }', '{ x = [a, c, b]; }'], ['{ x = [, a]; }', '{ x = [b, a]; }']]) {
    assert.deepEqual(clonesDe(a, b, SEUILS_DU_BLOC(a, b)), [], `${a} et ${b}`);
  }
  assert.equal(typeDuClone('{ x = [a, , b]; }', '{ x = [c, , d]; }'), 'renomme');
});

test('ce qu\'un enfant est pour son parent compte : le même identifiant en `init` et en `test` d\'une boucle ne fait pas des clones', () => {
  const a = '{ for (a;;) b; }';
  const b = '{ for (;a;) b; }';
  assert.deepEqual(clonesDe(a, b, SEUILS_DU_BLOC(a, b)), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// La numérotation et la lecture de l'arbre

test('numéroter donne une forme, une masse et une logique à chaque nœud, la racine comprise', () => {
  const { ast } = lire('f(a); g(b);');
  const noeuds = noeudsDe(ast);
  numeroter(noeuds, creerTables());
  for (const n of noeuds) {
    assert.equal(typeof n.__h1, 'number', n.type);
    assert.equal(typeof n.__h3, 'number', n.type);
  }
  assert.equal(ast.__m, noeuds.length);
  assert.equal(ast.__l, 2);
});

test('les commentaires d\'un arbre ne sont pas des nœuds : ils ne se lisent pas, ne pèsent rien et ne se numérotent pas', () => {
  const { ast } = lire('/* un */ f(a); // deux\ng(b);');
  assert.equal(ast.commentaires.length, 2);
  const noeuds = noeudsDe(ast);
  assert.equal(noeuds.length, noeudsDe(lire('f(a); g(b);').ast).length);
  assert.ok(noeuds.every((n) => typeof n.type === 'string'));
  numeroter(noeuds, creerTables());
  assert.equal(ast.__m, noeuds.length);
});

test('un élément absent d\'un tableau (`[, a]`) se lit sans erreur et ne compte pas parmi les nœuds', () => {
  const { ast } = lire('[, a];');
  assert.equal(ast.body[0].expression.elements[0], null);
  const noeuds = noeudsDe(ast);
  assert.deepEqual(noeuds.map((n) => n.type), ['Program', 'ExpressionStatement', 'ArrayExpression', 'Identifier']);
  numeroter(noeuds, creerTables());
  assert.equal(ast.__m, 4);
});

test('les formes de deux listes dont les numéros se recollent (1 puis 11, 11 puis 1) ne se confondent pas, ni les exactes ni les abstraites', () => {
  const feuille = (h1, h3) => ({ type: 'Literal', value: 0, raw: '0', __h1: h1, __h3: h3, __m: 1, __l: 0 });
  const tableau = (...elements) => ({ type: 'ArrayExpression', elements });
  const tables = creerTables();
  const [un, onze] = [tableau(feuille(1, 1), feuille(11, 11)), tableau(feuille(11, 11), feuille(1, 1))];
  numeroter([un], tables);
  numeroter([onze], tables);
  assert.notEqual(un.__h1, onze.__h1);
  assert.notEqual(un.__h3, onze.__h3);
});

test('le premier nom lu se renomme comme les autres : le nom qu\'on répète ne devient pas un nom neuf, quelle que soit sa place', () => {
  const partout = '{ a(a, a); }';
  // `x` prend, l'une après l'autre, la place de chacun des trois noms : l'une de ces places est celle du premier nom que la recherche lit
  for (const autre of ['{ x(a, a); }', '{ a(x, a); }', '{ a(a, x); }']) {
    assert.deepEqual(clonesDe(partout, autre, SEUILS_DU_BLOC(partout, autre)), [], `${partout} et ${autre}`);
  }
  assert.equal(typeDuClone(partout, '{ x(x, x); }'), 'renomme', 'témoin : le même nom partout est un clone');
});

test('le renommage se lit sur la suite des noms numérotés par première occurrence, sans que deux suites aux chiffres recollés se confondent', () => {
  // Treize identifiants : 0 à 9, puis 1, 0 et un nouveau (10) ; contre 0 à 9, puis le nouveau (10), 1 et 0. Les chiffres collés sont les mêmes (`01234567891010`), les suites non.
  const noms = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'];
  const a = `{ [${[...noms, 'n1', 'n0', 'n10'].join(', ')}]; }`;
  const b = `{ [${[...noms, 'n10', 'n1', 'n0'].join(', ')}]; }`;
  assert.deepEqual(clonesDe(a, b, SEUILS_DU_BLOC(a, b)), []);
  assert.equal(typeDuClone(a, a), 'identique');
});

// ---------------------------------------------------------------------------------------------------------------------
// Les numéros de forme

test('chaque forme a le numéro de sa propre table : de 0 à la taille de la table moins un, un par forme distincte', () => {
  const { ast } = lire('f(a); f(b); g(a, b); g(a, a); c = a ? b : a;');            // des noms qui diffèrent : plus de formes exactes que de formes abstraites
  const tables = creerTables();
  const noeuds = noeudsDe(ast);
  numeroter(noeuds, tables);
  assert.ok(tables.exacte.size > tables.abstraite.size);
  for (const [champ, taille] of [['__h1', tables.exacte.size], ['__h3', tables.abstraite.size]]) {
    const numeros = new Set(noeuds.map((n) => n[champ]));
    assert.equal(numeros.size, taille, `${champ} : un numéro par forme distincte`);
    assert.equal(Math.min(...numeros), 0);
    assert.equal(Math.max(...numeros), taille - 1);
  }
});

test('une expression régulière que l\'exécution ne sait pas construire (acorn lui donne la valeur null) se compare par son motif et ses drapeaux', () => {
  const programme = (pattern, flags) => ({ type: 'Program', sourceType: 'script', body: [{ type: 'ExpressionStatement', expression: { type: 'Literal', value: null, regex: { pattern, flags }, raw: `/${pattern}/${flags}` } }] });
  const tables = creerTables();
  const forme = (pattern, flags, champ) => { const ast = programme(pattern, flags); numeroter(noeudsDe(ast), tables); return ast.body[0].expression[champ]; };
  for (const champ of ['__h1', '__h3']) {
    assert.equal(forme('ab+', '', champ), forme('ab+', '', champ), `${champ} : la même expression a la même forme`);
    assert.notEqual(forme('ab+', '', champ), forme('ab*', '', champ), `${champ} : le motif compte`);
    assert.notEqual(forme('ab+', '', champ), forme('ab+', 'i', champ), `${champ} : les drapeaux comptent`);
  }
});

/** Le numéro de la forme exacte et celui de la forme abstraite de la racine de chaque programme (une source, ou un arbre fait à la main), numérotés dans les mêmes tables. */
const formesDe = (...programmes) => {
  const tables = creerTables();
  return programmes.map((p) => {
    const ast = typeof p === 'string' ? lire(p).ast : p;
    numeroter(noeudsDe(ast), tables);
    return { exacte: ast.__h1, abstraite: ast.__h3 };
  });
};
const racine = (...enfants) => ({ type: 'Program', sourceType: 'script', body: enfants });
const nom = (n) => ({ type: 'Identifier', name: n });

/** Deux morceaux qui ne diffèrent que par une chose : la forme exacte la voit toujours, la forme abstraite seulement quand ce n'est ni un nom ni la valeur d'une chaîne ou d'un nombre. */
const PAIRES_DE_FORMES = [
  ['le type d\'un nœud', 'function f() { return a; }', 'function f() { throw a; }', true],
  ['l\'opérateur d\'un nœud', 'a = b + c;', 'a = b - c;', true],
  ['la place d\'un trou dans un tableau', 'x = [a, , b];', 'x = [a, b, ,];', true],
  ['un trou, que ne remplit aucun nœud : même le premier numéroté, de numéro 0', 'a = [, a];', 'a = [a, a];', true],           // le premier nœud numéroté est le côté gauche : `a`, de numéro 0
  ['le nom d\'un enfant', 'for (a; ; ) b;', 'for (; a; ) b;', true],
  ['le nom d\'une liste', racine({ type: 'Essai', premiere: [nom('a')] }), racine({ type: 'Essai', seconde: [nom('a')] }), true],
  ['le genre d\'un littéral', 'x = 1;', 'x = "1";', true],
  ['une valeur booléenne', 'x = true;', 'x = false;', true],
  ['un nom', 'x = a;', 'x = b;', false],
  ['la valeur d\'un nombre', 'x = 1;', 'x = 2;', false],
  ['le texte d\'une chaîne', 'x = "a";', 'x = "b";', false],
  ['le texte d\'un gabarit', 'x = `a${y}`;', 'x = `b${y}`;', false],
];
for (const [ingredient, a, b, abstraiteAussi] of PAIRES_DE_FORMES) {
  test(`${ingredient} : ${abstraiteAussi ? 'les formes exacte et abstraite le voient' : 'la forme exacte le voit, la forme abstraite non'}`, () => {
    const [x, y] = formesDe(a, b);
    assert.notEqual(x.exacte, y.exacte);
    if (abstraiteAussi) assert.notEqual(x.abstraite, y.abstraite);
    else assert.equal(x.abstraite, y.abstraite);
  });
}

test('deux morceaux identiques ont les mêmes formes, exacte et abstraite, quelle que soit leur place dans les tables', () => {
  const [x, y, z] = formesDe('x = a + 1;', 'f(b);', 'x = a + 1;');
  assert.deepEqual(x, z);
  assert.notDeepEqual(x, y);
});
