import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as walk from 'acorn-walk';
import { lire } from '../src/moteur/analyse-js.js';
import { mesurerFonction, nomDeFonction, estAutoAppelee } from '../src/moteur/fonctions.js';
import { analyserFonctions } from '../src/regles/a-qualite.js';

/**
 * Une fonction se mesure sur son propre corps (voir `src/moteur/fonctions.js`) : la complexité et l'imbrication ne comptent pas ce que contiennent
 * les fonctions qu'elle déclare, une chaîne de `else if` est à plat, une flèche à corps-expression est mesurée comme une autre, et le nom d'une
 * méthode, d'une affectation ou d'un rappel se lit dans l'arbre. Ces essais mesurent les fonctions une à une, puis les constats des règles
 * A-FONC-01, A-FONC-02 et A-FONC-03 sur des fichiers de test.
 */

/** Les fonctions d'une source, dans l'ordre où l'arbre les rencontre (les plus internes d'abord), avec leurs ancêtres. */
function fonctionsDe(source) {
  const { ast, erreur } = lire(source);
  assert.ok(ast, `la source doit se lire : ${erreur?.message}`);
  const trouvees = [];
  const visiter = (noeud, _etat, ancetres) => trouvees.push({ noeud, ancetres: [...ancetres] });
  walk.ancestor(ast, { FunctionDeclaration: visiter, FunctionExpression: visiter, ArrowFunctionExpression: visiter });
  return trouvees;
}

const mesure = (source, indice = 0) => mesurerFonction(fonctionsDe(source)[indice].noeud);
const nomme = (source, indice = 0) => { const { noeud, ancetres } = fonctionsDe(source)[indice]; return nomDeFonction(noeud, ancetres); };

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
}
const constatsDe = (contenu, chemin = 'app.js') => analyserFonctions({ fichiers: [fichier(chemin, contenu)] });
const lignesDe = (n, fabrique = (i) => `  v.push(${i});`) => Array.from({ length: n }, (_, i) => fabrique(i)).join('\n');

// ---------------------------------------------------------------------------------------------------------------------
// La complexité

const COMPLEXITES = [
  ['une fonction sans branche', 'function f() { return 1; }', 1],
  ['if', 'function f(a) { if (a) { return 1; } }', 2],
  ['for', 'function f() { for (let i = 0; i < 3; i++) { g(); } }', 2],
  ['for in', 'function f(o) { for (const k in o) { g(k); } }', 2],
  ['for of', 'function f(o) { for (const k of o) { g(k); } }', 2],
  ['while', 'function f() { while (g()) { h(); } }', 2],
  ['do while', 'function f() { do { h(); } while (g()); }', 2],
  ['chaque case à test, non le default', 'function f(a) { switch (a) { case 1: return 1; case 2: return 2; default: return 0; } }', 3],
  ['catch', 'function f() { try { g(); } catch (e) { h(e); } }', 2],
  ['ternaire', 'function f(a) { return a ? 1 : 2; }', 2],
  ['&&', 'function f(a, b) { return a && b; }', 2],
  ['||', 'function f(a, b) { return a || b; }', 2],
  ['??', 'function f(a, b) { return a ?? b; }', 2],
  ['un opérateur qui n\'est pas logique', 'function f(a, b) { return a + b * 2; }', 1],
  ['une valeur par défaut de paramètre', 'function f(a = b ? 1 : 2) { return a; }', 2],
  ['une flèche à corps-expression', 'const f = (a) => (a ? 1 : 2);', 2],
  ['une flèche à corps-expression : quarante ternaires', `const f = (x) => ${Array.from({ length: 40 }, (_, i) => `x === ${i} ? ${i} :`).join(' ')} -1;`, 41],
  ['une méthode de classe', 'class A { m(a) { if (a) { return 1; } return 0; } }', 2],
];
for (const [nom, source, attendu] of COMPLEXITES) {
  test(`complexité : ${nom}`, () => assert.equal(mesure(source, 0).complexite, attendu));
}

test('complexité : ce que contiennent les fonctions déclarées dedans n\'est pas compté, chaque fonction a la sienne', () => {
  const source = 'function dehors(a) { if (a) { g(); } function dedans(b) { if (b) { h(); } return b ? 1 : 2; } const f = (c) => c || 0; return dedans; }';
  // l'ordre de l'arbre : les plus internes d'abord (dedans, f, dehors)
  assert.deepEqual(fonctionsDe(source).map(({ noeud }) => mesurerFonction(noeud).complexite), [3, 2, 2]);
});

test('complexité : l\'enveloppe d\'un module de trente fonctions de deux chemins reste à 1 (elle valait 31)', () => {
  const corps = Array.from({ length: 30 }, (_, i) => `  function f${i}(x) { return x ? ${i} : 0; }`).join('\n');
  const fonctions = fonctionsDe(`(function () {\n${corps}\n})();`);
  assert.equal(fonctions.length, 31);
  assert.equal(mesurerFonction(fonctions.at(-1).noeud).complexite, 1, 'l\'enveloppe est la dernière rencontrée');
  assert.ok(fonctions.slice(0, -1).every(({ noeud }) => mesurerFonction(noeud).complexite === 2));
});

test('complexité : une classe ou un objet déclaré dans une fonction a ses méthodes mesurées à part', () => {
  const source = 'function f() { class A { m(a) { return a ? 1 : 2; } } return { n(b) { return b && 1; } }; }';
  assert.deepEqual(fonctionsDe(source).map(({ noeud }) => mesurerFonction(noeud).complexite), [2, 2, 1]);
});

// ---------------------------------------------------------------------------------------------------------------------
// L'imbrication

const IMBRICATIONS = [
  ['aucun bloc', 'function f() { return 1; }', 0],
  ['un if', 'function f(a) { if (a) { g(); } }', 1],
  ['huit else if à la suite : à plat, un seul niveau', `function f(x) { if (x === 0) { a(); }${Array.from({ length: 8 }, (_, i) => ` else if (x === ${i + 1}) { a(); }`).join('')} else { b(); } }`, 1],
  ['un if dans le else : un niveau de plus', 'function f(a, b) { if (a) { g(); } else { if (b) { h(); } } }', 2],
  ['un if dans un else if : deux niveaux', 'function f(a, b, c) { if (a) { g(); } else if (b) { if (c) { h(); } } }', 2],
  ['un if dans le corps d\'un if', 'function f(a, b) { if (a) { if (b) { h(); } } }', 2],
  ['un if sans accolades dans un if', 'function f(a, b) { if (a) if (b) h(); }', 2],
  ['six niveaux : if, for, while, if, try, if', 'function f() { if (a) { for (;;) { while (b) { if (c) { try { if (d) { g(); } } catch (e) { h(e); } } } } } }', 6],
  ['switch', 'function f(a, b) { switch (a) { case 1: if (b) { g(); } } }', 2],
  ['try, puis catch', 'function f() { try { g(); } catch (e) { if (e) { h(); } } }', 2],
  ['do while', 'function f() { do { if (a) { g(); } } while (b); }', 2],
  ['une boucle for of', 'function f(o) { for (const k of o) { for (const j of k) { g(j); } } }', 2],
  ['une boucle for in', 'function f(o) { for (const k in o) { for (const j in o[k]) { g(j); } } }', 2],
  ['une chaîne else if dans un if', 'function f(a, b, c) { if (a) { if (b) { g(); } else if (c) { h(); } } }', 2],
  ['un if dans la branche d\'un else if, lui-même dans un if : trois niveaux', 'function f(a, b, c, d) { if (a) { if (b) { g(); } else if (c) { if (d) { h(); } } } }', 3],
  ['les fonctions déclarées dedans ont leur propre profondeur', 'function f() { if (a) { const g = () => { if (b) { if (c) { h(); } } }; } }', 1],
];
for (const [nom, source, attendu] of IMBRICATIONS) {
  test(`imbrication : ${nom}`, () => assert.equal(mesure(source, fonctionsDe(source).length - 1).imbrication, attendu));
}

test('imbrication : une fonction déclarée dans trois boucles a sa profondeur à elle (0 ici), non celle des boucles', () => {
  const source = 'function f() { for (;;) { for (;;) { for (;;) { items.forEach(function (x) { g(x); }); } } } }';
  assert.deepEqual(fonctionsDe(source).map(({ noeud }) => mesurerFonction(noeud).imbrication), [0, 3]);
});

test('imbrication : un code très profond ne fait pas déborder la mesure (pile explicite)', () => {
  const profondeur = 20_000;
  const noeud = {
    type: 'FunctionDeclaration', params: [], loc: { start: { line: 1 }, end: { line: 1 } },
    body: Array.from({ length: profondeur }).reduce((corps) => ({ type: 'IfStatement', test: { type: 'Identifier' }, consequent: corps, alternate: null }), { type: 'EmptyStatement' }),
  };
  const { imbrication, complexite } = mesurerFonction(noeud);
  assert.equal(imbrication, profondeur);
  assert.equal(complexite, profondeur + 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// Les lignes

test('lignes : l\'étendue est de la première à la dernière ligne ; les lignes propres retirent les lignes de chaque fonction interne qui en a plusieurs', () => {
  const source = ['function f() {', '  a();', '  g(function () {', '    b();', '    c();', '  });', '  d();', '}'].join('\n');
  const { noeud } = fonctionsDe(source).at(-1);
  assert.deepEqual(mesurerFonction(noeud), { complexite: 1, imbrication: 0, etendue: 8, lignesPropres: 4 });
});

test('lignes : une fonction interne d\'une seule ligne ne retire rien (sa ligne est aussi celle du code de l\'extérieur)', () => {
  const source = ['function f() {', '  g(() => 1);', '  h(function () { return 2; });', '}'].join('\n');
  assert.equal(mesurerFonction(fonctionsDe(source).at(-1).noeud).lignesPropres, 4);
});

test('lignes : deux fonctions internes se retirent chacune ; celle d\'une fonction interne n\'est retirée que de cette fonction interne', () => {
  const source = ['function f() {', '  g(function () {', '    a();', '    h(function () {', '      b();', '      c();', '    });', '  });', '  k(function () {', '    d();', '  });', '}'].join('\n');
  const [h, g, k, f] = fonctionsDe(source).map(({ noeud }) => mesurerFonction(noeud));   // l'ordre de l'arbre : les plus internes d'abord
  assert.deepEqual([f.etendue, f.lignesPropres], [12, 2], 'f : 12 lignes, moins g (lignes 2 à 8, soit 7) et k (lignes 9 à 11, soit 3) ; h n\'est pas retirée de f');
  assert.deepEqual([g.etendue, g.lignesPropres], [7, 3], 'g : 7 lignes, moins h (lignes 4 à 7, soit 4)');
  assert.deepEqual([h.etendue, h.lignesPropres], [4, 4]);
  assert.deepEqual([k.etendue, k.lignesPropres], [3, 3]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Les fonctions appelées là où elles sont écrites

const AUTO_APPELEES = [
  ['(function () {})()', '(function () {})();', true],
  ['(() => {})()', '(() => {})();', true],
  ['(async () => {})()', '(async () => {})();', true],
  ['!function () {}()', '!function () {}();', true],
  ['(function () {}).call(this)', '(function () {}).call(this);', true],
  ['(function () {}).apply(this, [])', '(function () {}).apply(this, []);', true],
  ['new function () {}', 'new function () {};', true],
  ['une fonction nommée appelée aussitôt', '(function main() {})();', true],
  ['un rappel', 'f(function () {});', false],
  ['une fonction que `bind` renvoie', '(function () {}).bind(this);', false],
  ['une méthode dont le nom est une variable : `[call]`', '(function () {})[call](this);', false],
  ['une fonction dont on passe `call` en argument', 'g((function () {}).call);', false],
  ['une fonction dont `call` est construit avec `new`', 'new (function () {}).call(this);', false],
  ['une fonction que l\'on lit seulement `call`', 'const c = (function () {}).call;', false],
  ['une affectation', 'x = function () {};', false],
  ['une déclaration', 'function f() {}', false],
];
for (const [nom, source, attendu] of AUTO_APPELEES) {
  test(`auto-appelée : ${nom} → ${attendu}`, () => {
    const { noeud, ancetres } = fonctionsDe(source).at(-1);
    assert.equal(estAutoAppelee(noeud, ancetres), attendu);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Les noms

const NOMS = [
  ['une déclaration', 'function ouvrir() {}', 'ouvrir', 'la fonction `ouvrir`'],
  ['une expression nommée', 'const f = function interne() {};', 'interne', 'la fonction `interne`'],
  ['une variable', 'const rendre = () => {};', 'rendre', 'la fonction `rendre`'],
  ['une affectation à une propriété', 'this.render = function () {};', 'this.render', 'la fonction `this.render`'],
  ['une affectation à une chaîne de propriétés', 'window.app.ui.draw = () => {};', 'window.app.ui.draw', 'la fonction `window.app.ui.draw`'],
  ['une propriété d\'objet', 'const o = { dessiner: function () {} };', 'dessiner', 'la fonction `dessiner`'],
  ['une méthode d\'objet', 'const o = { dessiner() {} };', 'dessiner', 'la méthode `dessiner`'],
  ['un accesseur d\'objet', 'const o = { get taille() { return 1; } };', 'get taille', 'la fonction `get taille`'],
  ['un mutateur d\'objet', 'const o = { set taille(v) {} };', 'set taille', 'la fonction `set taille`'],
  ['une clé numérique', 'const o = { 7: function () {} };', '7', 'la fonction `7`'],
  ['une clé calculée : pas de nom', 'const o = { [cle]: function () {} };', '(fonction anonyme)', 'la fonction anonyme'],
  ['une déstructuration : pas de nom', 'const { length } = function () {};', '(fonction anonyme)', 'la fonction anonyme'],
  ['une méthode de classe', 'class Carte { dessiner() {} }', 'Carte.dessiner', 'la méthode `Carte.dessiner`'],
  ['un accesseur de classe', 'class Carte { get taille() { return 1; } }', 'Carte.get taille', 'la méthode `Carte.get taille`'],
  ['un mutateur de classe', 'class Carte { set taille(v) {} }', 'Carte.set taille', 'la méthode `Carte.set taille`'],
  ['une méthode privée (le # est cité, comme tout caractère qu\'une sortie pourrait lire autrement)', 'class Carte { #cacher() {} }', '`Carte.#cacher`', 'la méthode `Carte.#cacher`'],
  ['un champ de classe', 'class Carte { dessiner = () => {}; }', 'Carte.dessiner', 'la fonction `Carte.dessiner`'],
  ['le constructeur', 'class Carte { constructor() {} }', 'Carte.constructor', 'le constructeur de `Carte`'],
  ['le constructeur d\'une classe affectée à une variable', 'const Carte = class { constructor() {} };', 'Carte.constructor', 'le constructeur de `Carte`'],
  ['le constructeur d\'une classe anonyme', 'new (class { constructor() {} })();', 'constructor', 'le constructeur'],
  ['la méthode d\'une classe affectée à une variable', 'const Carte = class { dessiner() {} };', 'Carte.dessiner', 'la méthode `Carte.dessiner`'],
  ['une clé qui est une chaîne', 'const o = { "tracer-vite": function () {} };', 'tracer-vite', 'la fonction `tracer-vite`'],
  ['un rappel passé à un appel', 'grist.onRecords(function () {});', '(rappel de grist.onRecords)', 'le rappel passé à `grist.onRecords`'],
  ['un rappel passé à un appel simple', 'ready(() => {});', '(rappel de ready)', 'le rappel passé à `ready`'],
  ['un rappel passé à un appel dont l\'objet est un appel', '$(document).ready(function () {});', '(rappel de ready)', 'le rappel passé à `ready`'],
  ['un rappel passé à new', 'new Promise((resolve) => {});', '(rappel de Promise)', 'le rappel passé à `Promise`'],
  ['un rappel passé à un appelé qui n\'a pas de nom', '(0, f)(function () {});', '(fonction anonyme)', 'la fonction anonyme'],
  ['une fonction exportée par défaut', 'export default function () {}', '(fonction exportée par défaut)', 'la fonction exportée par défaut'],
  ['une enveloppe appelée aussitôt', '(function () {})();', '(fonction auto-appelée)', 'la fonction auto-appelée'],
  ['une enveloppe flèche appelée aussitôt', '(() => {})();', '(fonction auto-appelée)', 'la fonction auto-appelée'],
  ['une fonction qui n\'a pas de nom', 'const l = [function () {}];', '(fonction anonyme)', 'la fonction anonyme'],
  ['une fonction renvoyée', 'function f() { return () => {}; }', '(fonction anonyme)', 'la fonction anonyme'],
];
for (const [nom, source, titre, groupe] of NOMS) {
  test(`nom : ${nom}`, () => assert.deepEqual(nomme(source, 0), { titre, groupe }));
}

test('nom : un nom du widget que le Markdown lirait autrement est cité, et un nom trop long est borné', () => {
  assert.deepEqual(nomme('const o = {}; o["<img src=x onerror=alert(1)>"] = function () {};', 0), { titre: '`o.<img src=x onerror=alert(1)>`', groupe: 'la fonction `o.<img src=x onerror=alert(1)>`' });
  assert.deepEqual(nomme('const o = { "a`b": () => {} };', 0), { titre: '``a`b``', groupe: 'la fonction ``a`b``' });
  const long = 'n'.repeat(500);
  const { titre, groupe } = nomme(`function ${long}() {}`, 0);
  assert.equal(titre, `${'n'.repeat(60)}…`);
  assert.equal(groupe, `la fonction \`${'n'.repeat(60)}…\``);
  const longCle = nomme(`const o = { "${'<'.repeat(500)}": () => {} };`, 0);
  assert.ok(longCle.titre.length < 100, 'un nom cité reste borné aussi');
});

test('nom : un nom de 60 caractères se dit en entier, un de 61 est borné à 60', () => {
  assert.equal(nomme(`function ${'n'.repeat(60)}() {}`, 0).titre, 'n'.repeat(60));
  assert.equal(nomme(`function ${'n'.repeat(61)}() {}`, 0).titre, `${'n'.repeat(60)}…`);
});

test('nom : un nom pointé de plus de huit propriétés n\'est pas un nom, et une chaîne de dizaines de milliers de propriétés ne fait pas déborder la pile', () => {
  assert.deepEqual(nomme(`${'a.'.repeat(9)}b = function () {};`, 0), { titre: '(fonction anonyme)', groupe: 'la fonction anonyme' });
  assert.deepEqual(nomme(`${'a.'.repeat(8)}b = function () {};`, 0), { titre: `${'a.'.repeat(8)}b`, groupe: `la fonction \`${'a.'.repeat(8)}b\`` }, 'huit propriétés : encore un nom');
  const { ast } = lire(`x.${'a.'.repeat(30_000)}b = function () {};`);        // acorn lit une chaîne de propriétés sans récursion ; le parcours de l'arbre, lui, ne s'y risque pas ici
  const affectation = ast.body[0].expression;
  assert.deepEqual(nomDeFonction(affectation.right, [ast, ast.body[0], affectation, affectation.right]), { titre: '(fonction anonyme)', groupe: 'la fonction anonyme' });
});

test('nom : une coupe au milieu d\'une paire de substitution ne laisse pas une moitié seule', () => {
  const nom = `${'x'.repeat(59)}\u{1d4d0}suite`;                       // la paire occupe les positions 59 et 60 : la coupe à 60 la sépare
  const { titre } = nomme(`function ${nom}() {}`, 0);
  assert.ok(titre.isWellFormed(), JSON.stringify(titre));
  assert.ok(titre.endsWith('…'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Les constats

test('A-FONC-02 : l\'enveloppe de trente fonctions de deux chemins n\'a plus aucun constat (elle valait « complexité 31 », majeur)', () => {
  const corps = Array.from({ length: 30 }, (_, i) => `  function f${i}(x) { return x ? ${i} : 0; }`).join('\n');
  assert.deepEqual(constatsDe(`(function () {\n${corps}\n})();\n`), []);
});

test('A-FONC-02 : la complexité d\'une fonction dans l\'enveloppe est la sienne, avec son nom et sa ligne', () => {
  const branches = Array.from({ length: 16 }, (_, i) => `    if (x === ${i}) { y(); }`).join('\n');
  const [c, ...autres] = constatsDe(`(function () {\n  function trier(x) {\n${branches}\n  }\n  function simple(x) { return x ? 1 : 2; }\n})();\n`);
  assert.equal(autres.length, 0);
  assert.equal(c.regle, 'A-FONC-02');
  assert.equal(c.severite, 'mineur');
  assert.equal(c.titre, 'Complexité cyclomatique de 17 : trier');
  assert.equal(c.ligne, 2);
  assert.equal(c.constat, 'La fonction `trier` comporte 17 chemins d\'exécution indépendants (seuil retenu : 15).');
});

test('A-FONC-02 : seuils 15 (mineur) et 30 (majeur), au-delà et non à', () => {
  const avec = (chemins) => `function f(x) {\n${Array.from({ length: chemins - 1 }, (_, i) => `  if (x === ${i}) { y(); }`).join('\n')}\n}\n`;
  const rendu = (chemins) => constatsDe(avec(chemins)).filter((c) => c.regle === 'A-FONC-02').map((c) => c.severite);
  assert.deepEqual([rendu(15), rendu(16), rendu(30), rendu(31)], [[], ['mineur'], ['mineur'], ['majeur']]);
});

test('A-FONC-02 : une flèche à corps-expression de 41 chemins est mesurée (elle ne l\'était pas)', () => {
  const [c] = constatsDe(`const choisir = (x) => ${Array.from({ length: 40 }, (_, i) => `x === ${i} ? ${i} :`).join(' ')} -1;\n`);
  assert.equal(c.regle, 'A-FONC-02');
  assert.equal(c.severite, 'majeur');
  assert.equal(c.titre, 'Complexité cyclomatique de 41 : choisir');
});

test('A-FONC-01 : le constructeur d\'une classe porte le nom de la classe (il s\'appelait « fonction anonyme »)', () => {
  const [c, ...autres] = constatsDe(`class Carte {\n  constructor() {\n${lignesDe(90, (i) => `    this.a${i} = ${i};`)}\n  }\n  rendre() {}\n}\n`);
  assert.equal(autres.length, 0);
  assert.equal(c.regle, 'A-FONC-01');
  assert.equal(c.titre, 'Fonction de 92 lignes : Carte.constructor');
  assert.equal(c.constat, 'Le constructeur de `Carte` s\'étend sur 92 lignes.');
  assert.equal(c.ligne, 2);
});

test('A-FONC-01 : seuils 80 (mineur) et 200 (majeur) lignes, au-delà et non à', () => {
  const de = (lignes) => `function f() {\n${lignesDe(lignes - 2)}\n}\n`;
  const rendu = (lignes) => constatsDe(de(lignes)).filter((c) => c.regle === 'A-FONC-01').map((c) => c.severite);
  assert.deepEqual([rendu(80), rendu(81), rendu(200), rendu(201)], [[], ['mineur'], ['mineur'], ['majeur']]);
});

test('A-FONC-01 : un rappel de grist.onRecords de 92 lignes est nommé par l\'appel qui le reçoit', () => {
  const [c] = constatsDe(`grist.onRecords(function (rows) {\n${lignesDe(90)}\n});\n`);
  assert.equal(c.titre, 'Fonction de 92 lignes : (rappel de grist.onRecords)');
  assert.equal(c.constat, 'Le rappel passé à `grist.onRecords` s\'étend sur 92 lignes.');
});

test('A-FONC-01 : l\'enveloppe d\'un module ne se mesure que sur ses lignes propres : quarante fonctions de cinq lignes ne font pas une fonction de 200 lignes', () => {
  const fonctions = Array.from({ length: 40 }, (_, i) => `  function f${i}(x) {\n    a();\n    b();\n    c();\n  }`).join('\n');
  assert.deepEqual(constatsDe(`(function () {\n${fonctions}\n})();\n`), []);
});

test('A-FONC-01 : une enveloppe de 90 lignes de code à elle est une fonction longue, et le constat dit ce qu\'il ne compte pas', () => {
  const fonctions = Array.from({ length: 10 }, (_, i) => `  function f${i}(x) {\n    a();\n    b();\n    c();\n  }`).join('\n');
  const [c, ...autres] = constatsDe(`(function () {\n${lignesDe(90)}\n${fonctions}\n})();\n`);
  assert.equal(autres.length, 0);
  assert.equal(c.regle, 'A-FONC-01');
  assert.equal(c.titre, 'Fonction de 92 lignes : (fonction auto-appelée)');
  assert.equal(c.constat, 'La fonction auto-appelée occupe 92 lignes en propre, sans compter les 50 lignes des fonctions qu\'elle contient, mesurées chacune à part.');
});

test('A-FONC-01 : une enveloppe sans aucune fonction dedans s\'étend sur ses lignes, comme toute fonction', () => {
  const [c] = constatsDe(`(function () {\n${lignesDe(90)}\n})();\n`);
  assert.equal(c.constat, 'La fonction auto-appelée s\'étend sur 92 lignes.');
});

test('A-FONC-01 : une fonction qui n\'est pas appelée là où elle est écrite compte ses lignes en entier, fonctions internes comprises', () => {
  const [c] = constatsDe(`function main() {\n${lignesDe(30)}\n  function dedans() {\n${lignesDe(60)}\n  }\n}\n`);
  assert.equal(c.titre, 'Fonction de 94 lignes : main');
  assert.equal(c.constat, 'La fonction `main` s\'étend sur 94 lignes.');
});

test('A-FONC-01, A-FONC-02, A-FONC-03 : une fonction qui est exactement sur un seuil n\'est pas relevée pour celui-là, même quand elle l\'est pour un autre', () => {
  const regles = (source) => constatsDe(source).map((c) => c.regle);
  const conditions = (n) => Array.from({ length: n }, (_, i) => `  if (x === ${i}) { y(); }`).join('\n');
  // 80 lignes et 16 chemins : A-FONC-02 seul
  assert.deepEqual(regles(`function f(x) {\n${conditions(15)}\n${lignesDe(80 - 17)}\n}\n`), ['A-FONC-02']);
  // 81 lignes et 15 chemins : A-FONC-01 seul
  assert.deepEqual(regles(`function f(x) {\n${conditions(14)}\n${lignesDe(81 - 16)}\n}\n`), ['A-FONC-01']);
  // 81 lignes et 5 niveaux : A-FONC-01 seul ; 80 lignes et 6 niveaux : A-FONC-03 seul
  const niveaux = (n) => `${'if (a) { '.repeat(n)}g();${' }'.repeat(n)}`;
  assert.deepEqual(regles(`function f(a) {\n${niveaux(5)}\n${lignesDe(81 - 3)}\n}\n`), ['A-FONC-01']);
  assert.deepEqual(regles(`function f(a) {\n${niveaux(6)}\n${lignesDe(80 - 3)}\n}\n`), ['A-FONC-03']);
  // 200 lignes (mineur) et 30 chemins (mineur) : aucun majeur ; 201 lignes et 31 chemins : deux majeurs
  const gravites = (source) => constatsDe(source).map((c) => `${c.regle}:${c.severite}`);
  assert.deepEqual(gravites(`function f(x) {\n${conditions(29)}\n${lignesDe(200 - 31)}\n}\n`), ['A-FONC-01:mineur', 'A-FONC-02:mineur']);
  assert.deepEqual(gravites(`function f(x) {\n${conditions(30)}\n${lignesDe(201 - 32)}\n}\n`), ['A-FONC-01:majeur', 'A-FONC-02:majeur']);
});

test('A-FONC-03 : huit else if à la suite ne sont pas une imbrication de huit niveaux (le constat valait « profondeur 7 »)', () => {
  const chaine = `if (x === 0) { a(); }${Array.from({ length: 8 }, (_, i) => ` else if (x === ${i + 1}) { a(); }`).join('')} else { b(); }`;
  assert.deepEqual(constatsDe(`function f(x) {\n${chaine}\n}\n`), []);
});

test('A-FONC-03 : six blocs emboîtés sont relevés, avec la profondeur', () => {
  const [c, ...autres] = constatsDe('function f() {\n if (a) { for (;;) { while (b) { if (c) { try { if (d) { g(); } } catch (e) { h(e); } } } } }\n}\n');
  assert.equal(autres.length, 0);
  assert.equal(c.regle, 'A-FONC-03');
  assert.equal(c.titre, 'Imbrication de profondeur 6 : f');
  assert.equal(c.constat, 'Le corps de la fonction `f` atteint 6 niveaux de blocs imbriqués.');
});

test('A-FONC-03 : seuil à 5 niveaux, au-delà et non à', () => {
  const emboites = (n) => `function f() {\n${'if (a) { '.repeat(n)}g();${' }'.repeat(n)}\n}\n`;
  const rendu = (n) => constatsDe(emboites(n)).filter((c) => c.regle === 'A-FONC-03').length;
  assert.deepEqual([rendu(5), rendu(6)], [0, 1]);
});

test('A-FONC-03 : un rappel déclaré dans cinq boucles n\'hérite pas de leur profondeur', () => {
  const source = `function f() {\n${'for (;;) { '.repeat(5)}items.forEach(function (x) { if (x) { g(x); } });${' }'.repeat(5)}\n}\n`;
  assert.deepEqual(constatsDe(source), []);
});

test('un constat sur un nom que le widget choisit le cite, partout où il paraît', () => {
  const [c] = constatsDe(`const o = {};\no["<img src=x onerror=alert(1)>"] = function () {\n${lignesDe(90)}\n};\n`);
  assert.equal(c.titre, 'Fonction de 92 lignes : `o.<img src=x onerror=alert(1)>`');
  assert.equal(c.constat, 'La fonction `o.<img src=x onerror=alert(1)>` s\'étend sur 92 lignes.');
});

test('une fonction d\'un script inline d\'une page est à sa ligne dans la page', () => {
  const page = `<!doctype html>\n<html><body>\n<script>\nfunction ouvrir() {\n${lignesDe(90)}\n}\n</script>\n</body></html>\n`;
  const [c, ...autres] = analyserFonctions({ fichiers: [fichier('index.html', page)] });
  assert.equal(autres.length, 0);
  assert.equal(c.fichier, 'index.html');
  assert.equal(c.ligne, 4);
  assert.equal(c.titre, 'Fonction de 92 lignes : ouvrir');
});

test('un fichier qu\'acorn ne lit pas n\'a aucun constat de fonction, et le fait est relevé comme illisible', () => {
  const ctx = { fichiers: [fichier('vue.js', 'const a = <div>x</div>;\nfunction f() {}\n')] };
  assert.deepEqual(analyserFonctions(ctx), []);
  assert.equal([...ctx.illisibles.values()].length, 1);
});
