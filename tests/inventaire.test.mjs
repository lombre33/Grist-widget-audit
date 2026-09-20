import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { construireContexte, estVendorise } from '../src/contexte/inventaire.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/mini-widget');

test('la surface exécutée suit les références depuis index.html', () => {
  const ctx = construireContexte(FIXTURE);
  assert.deepEqual(ctx.entrees, ['index.html']);
  assert.ok(ctx.surface.has('app.js'), 'app.js doit être dans la surface exécutée');
  assert.ok(ctx.surface.has('index.html'));
});

function fichierJs({ chemin = 'app.js', lignes = 1, longueur = 10, contenu }) {
  const texte = contenu ?? Array.from({ length: lignes }, () => 'x'.repeat(longueur)).join('\n');
  const tableauLignes = texte.split('\n');
  return { chemin, ext: '.js', binaire: false, contenu: texte, lignes: tableauLignes, taille: texte.length, locSignificatives: tableauLignes.length };
}

test('estVendorise reconnaît un chemin vendor/, un suffixe .min.js, une minification et une signature de bundleur', () => {
  assert.ok(estVendorise(fichierJs({ chemin: 'vendor/lib.js', lignes: 400, longueur: 20 })));
  assert.ok(estVendorise(fichierJs({ chemin: 'jquery.min.js', lignes: 400, longueur: 20 })));
  assert.ok(estVendorise(fichierJs({ chemin: 'lib.js', lignes: 400, longueur: 250 })), 'lignes très longues (minifié)');

  const bundle = ['"use strict";', 'var __defProp = Object.defineProperty;']
    .concat(Array.from({ length: 320 }, (_, i) => `function f${i}() { return ${i}; }`))
    .join('\n');
  assert.ok(estVendorise(fichierJs({ chemin: 'grist-plugin-api.js', contenu: bundle })),
    'signature de bundleur (esbuild/webpack) même sans ligne longue ni chemin vendor/');
});

test('estVendorise ne signale pas le code normal du contributeur', () => {
  assert.equal(estVendorise(fichierJs({ chemin: 'app.js', lignes: 50, longueur: 40 })), false);
  assert.equal(estVendorise(fichierJs({ chemin: 'app.js', lignes: 400, longueur: 40 })), false, 'long mais lignes courtes, sans signature de bundleur');
});
