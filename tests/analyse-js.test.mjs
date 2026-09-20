import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parser, nomPointe, estDynamique, pourChaqueUniteJs } from '../src/moteur/analyse-js.js';
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
