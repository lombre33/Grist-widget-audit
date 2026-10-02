import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parser, nomPointe, estDynamique, pourChaqueUniteJs, ligneFinDans } from '../src/moteur/analyse-js.js';
import * as walk from 'acorn-walk';

function premierAppel(source) {
  const ast = parser(source);
  let trouve;
  walk.simple(ast, { CallExpression(n) { trouve ??= n; } });
  return trouve;
}

test('nomPointe reconstitue un accès chaîné', () => {
  const appel = premierAppel('grist.docApi.fetchTable("Table1");');
  assert.equal(nomPointe(appel.callee), 'grist.docApi.fetchTable');
});

test('estDynamique distingue littéral et valeur calculée', () => {
  assert.equal(estDynamique(premierAppel('fetch("https://x.test");').arguments[0]), false);
  assert.equal(estDynamique(premierAppel('fetch(url);').arguments[0]), true);
  assert.equal(estDynamique(premierAppel('fetch(`https://x.test/${id}`);').arguments[0]), true);
});

test('pourChaqueUniteJs avec ignorerVendorise saute les fichiers vendorisés, mais pas les autres', () => {
  const ctx = {
    fichiers: [
      { chemin: 'app.js', ext: '.js', binaire: false, executee: true, vendorise: false, contenu: 'const a = 1;' },
      { chemin: 'vendor/lib.js', ext: '.js', binaire: false, executee: true, vendorise: true, contenu: 'const b = 2;' },
    ],
  };
  const vus = [];
  pourChaqueUniteJs(ctx, { ignorerVendorise: true }, ({ unite }) => vus.push(unite.chemin));
  assert.deepEqual(vus, ['app.js']);

  const vusSansOption = [];
  pourChaqueUniteJs(ctx, {}, ({ unite }) => vusSansOption.push(unite.chemin));
  assert.deepEqual(vusSansOption, ['app.js', 'vendor/lib.js'], "sans l'option, un appelant (l'axe C) voit tout");
});

const fichierJs = (chemin, contenu, extra = {}) => ({ chemin, ext: '.js', binaire: false, executee: true, vendorise: false, contenu, ...extra });
const parChemin = (x, y) => (x.unite.chemin < y.unite.chemin ? -1 : 1);

test('pourChaqueUniteJs sans ordre visite les unités dans l\'ordre de l\'inventaire, avec ordre dans celui que la comparaison donne', () => {
  const ctx = { fichiers: [fichierJs('b.js', 'const b = 1;'), fichierJs('c.js', 'const c = 1;'), fichierJs('a.js', 'const a = 1;')] };
  const vus = [];
  pourChaqueUniteJs(ctx, {}, ({ unite }) => vus.push(unite.chemin));
  assert.deepEqual(vus, ['b.js', 'c.js', 'a.js']);
  const triees = [];
  pourChaqueUniteJs(ctx, { ordre: parChemin }, ({ unite, fichier }) => triees.push([unite.chemin, fichier.chemin]));
  assert.deepEqual(triees, [['a.js', 'a.js'], ['b.js', 'b.js'], ['c.js', 'c.js']]);
  const inverse = [];
  pourChaqueUniteJs(ctx, { ordre: (x, y) => parChemin(y, x) }, ({ unite }) => inverse.push(unite.chemin));
  assert.deepEqual(inverse, ['c.js', 'b.js', 'a.js']);
  assert.deepEqual(ctx.fichiers.map((f) => f.chemin), ['b.js', 'c.js', 'a.js'], 'le contexte garde l\'ordre de son inventaire');
});

test('pourChaqueUniteJs : la comparaison ne voit que des paires { fichier, unite } sans arbre, des unités que les filtres gardent, et tout avant la première visite', () => {
  const ctx = { fichiers: [fichierJs('b.js', 'const b = 1;'), fichierJs('v.js', 'const v = 1;', { vendorise: true }), fichierJs('hors.js', 'const h = 1;', { executee: false }), fichierJs('a.js', 'const a = 1;')] };
  const evenements = [];
  const paires = new Set();
  const ordre = (x, y) => {
    evenements.push('ordre');
    for (const p of [x, y]) { paires.add(p.unite.chemin); assert.deepEqual(Object.keys(p).sort(), ['fichier', 'unite']); assert.equal(p.fichier.chemin, p.unite.chemin); }
    return parChemin(x, y);
  };
  pourChaqueUniteJs(ctx, { ignorerVendorise: true, surfaceSeulement: true, ordre }, ({ ast }) => evenements.push(ast ? 'visite' : 'sans arbre'));
  assert.deepEqual([...paires].sort(), ['a.js', 'b.js'], 'ni le fichier vendorisé ni celui que la page ne charge pas');
  assert.deepEqual(evenements.filter((e) => e !== 'ordre'), ['visite', 'visite']);
  assert.equal(evenements.lastIndexOf('ordre') < evenements.indexOf('visite'), true, 'l\'ordre est fait avant que le premier arbre soit lu');
});

test('pourChaqueUniteJs : un fichier que la lecture refuse est relevé à sa place dans l\'ordre, sans arrêter les suivants', () => {
  const ctx = { fichiers: [fichierJs('b.js', 'const b = 1;'), fichierJs('cassé.js', 'const ( = ;'), fichierJs('a.js', 'const a = 1;')] };
  const vus = [];
  pourChaqueUniteJs(ctx, { ordre: parChemin }, ({ unite }) => vus.push(unite.chemin));
  assert.deepEqual(vus, ['a.js', 'b.js']);
  assert.deepEqual([...ctx.illisibles.values()].map((i) => i.chemin), ['cassé.js'], 'relevé une fois, comme sans ordre');
});

test('ligneFinDans : la ligne où finit un nœud, selon la page pour un script de page, selon acorn pour un fichier .js', () => {
  const page = { positionDe: (decalage) => ({ ligne: 7 + decalage, colonne: 3 + decalage }) };
  assert.equal(ligneFinDans(page, { start: 2, end: 9 }), 16, 'la ligne de la fin (7 + 9), non celle du début');
  assert.equal(ligneFinDans(page, { start: 2 }), 7, 'sans fin lisible : le début de l\'unité');
  assert.equal(ligneFinDans(page, null), 7);
  const fichier = { positionDe: null };
  assert.equal(ligneFinDans(fichier, { loc: { start: { line: 4, column: 2 }, end: { line: 6, column: 8 } } }), 6);
  assert.equal(ligneFinDans(fichier, { loc: { start: { line: 4, column: 2 } } }), 0);
  assert.equal(ligneFinDans(fichier, null), 0);
});

test('pourChaqueUniteJs : `garder` est appelée une fois par unité que les autres filtres laissent, et ce qu\'elle refuse n\'est ni lu ni visité', () => {
  const ctx = { fichiers: [
    fichierJs('a.js', 'const a = 1;'), fichierJs('cassé.js', 'const ( = ;'), fichierJs('v.js', 'const v = 1;', { vendorise: true }),
    fichierJs('hors.js', 'const h = 1;', { executee: false }), fichierJs('b.js', 'const b = 1;'),
  ] };
  const appels = [];
  const garder = ({ fichier, unite }) => {
    appels.push([fichier.chemin, unite.chemin]);
    return fichier.chemin === 'a.js';
  };
  const vus = [];
  pourChaqueUniteJs(ctx, { ignorerVendorise: true, surfaceSeulement: true, garder }, ({ unite }) => vus.push(unite.chemin));
  assert.deepEqual(appels, [['a.js', 'a.js'], ['cassé.js', 'cassé.js'], ['b.js', 'b.js']], 'une fois chacune, ni le fichier vendorisé ni celui que la page ne charge pas');
  assert.deepEqual(vus, ['a.js']);
  assert.deepEqual([...(ctx.illisibles?.values() ?? [])], [], 'un fichier refusé n\'est pas lu : sa lecture manquée n\'est pas relevée');
});

test('pourChaqueUniteJs : `garder` voit chaque script d\'une page, avec son texte, et la comparaison ne voit que ceux qu\'elle garde', () => {
  const page = { chemin: 'index.html', ext: '.html', binaire: false, executee: true, vendorise: false, contenu: '<script>const premier = 1;</script>\n<script>const second = 2;</script>\n<script>const troisieme = 3;</script>\n' };
  const textes = [];
  const compares = new Set();
  const ordre = (x, y) => { compares.add(x.unite.source).add(y.unite.source); return 0; };
  const vus = [];
  pourChaqueUniteJs({ fichiers: [page] }, { garder: ({ unite }) => { textes.push(unite.source); return !unite.source.includes('second'); }, ordre }, ({ unite }) => vus.push(unite.source));
  assert.deepEqual(textes, ['const premier = 1;', 'const second = 2;', 'const troisieme = 3;']);
  assert.deepEqual([...compares].sort(), ['const premier = 1;', 'const troisieme = 3;']);
  assert.deepEqual(vus, ['const premier = 1;', 'const troisieme = 3;']);
});
