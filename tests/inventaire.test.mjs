import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

test("un manifest.json dans un sous-dossier résout son widget relatif malgré le changement à path.posix.* (évite la régression Windows de path.join/normalize natifs)", () => {
  // `path.join`/`path.normalize` natifs rendent `\` sous Windows même à
  // partir d'entrées en '/' (vérifié directement avec path.win32.* : voir
  // le message à la coordination), ce qui romprait la comparaison avec les
  // chemins déjà normalisés — d'où le passage à path.posix.* dans
  // trouverPointsDEntree(). Ce test vérifie sur le vrai système de fichiers
  // que la résolution relative (y compris un remontée `..`) fonctionne
  // toujours après ce changement.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-manifest-'));
  try {
    fs.mkdirSync(path.join(dir, 'manifestes'));
    fs.mkdirSync(path.join(dir, 'widgets'));
    fs.writeFileSync(path.join(dir, 'manifestes', 'manifest.json'), JSON.stringify([{ name: 'W', url: '../widgets/mon-widget.html' }]));
    fs.writeFileSync(path.join(dir, 'widgets', 'mon-widget.html'), '<script src="app.js"></script>');
    fs.writeFileSync(path.join(dir, 'widgets', 'app.js'), '');
    const ctx = construireContexte(dir);
    assert.deepEqual(ctx.entrees, ['widgets/mon-widget.html']);
    assert.ok(ctx.surface.has('widgets/mon-widget.html'));
    assert.ok(ctx.surface.has('widgets/app.js'), 'la surface doit suivre la référence relative depuis le widget résolu');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ctx.fichiers[].chemin est normalisé en '/', jamais le séparateur natif de la plateforme qui exécute l'audit", () => {
  // `path.relative()` rend le séparateur natif (`\` sous Windows) : toute
  // règle qui teste un chemin avec un motif `/` littéral (la grande
  // majorité) romprait silencieusement sur cette seule plateforme si ce
  // n'était pas normalisé une fois pour toutes à la construction du
  // contexte (voir src/contexte/inventaire.js, parcourir()). Un dossier
  // imbriqué le fait apparaître : sur POSIX ce test passerait même sans la
  // normalisation, c'est le garde-fou contre une régression qui la
  // retirerait, plus que la preuve du comportement Windows lui-même.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-inventaire-'));
  try {
    fs.mkdirSync(path.join(dir, 'dev-tests'));
    fs.writeFileSync(path.join(dir, 'dev-tests', 'scenario.js'), 'test();');
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="app.js"></script>');
    fs.writeFileSync(path.join(dir, 'app.js'), '');
    const ctx = construireContexte(dir);
    const nested = ctx.fichiers.find((f) => f.chemin.endsWith('scenario.js'));
    assert.ok(nested, 'le fichier imbriqué doit être inventorié');
    assert.equal(nested.chemin, 'dev-tests/scenario.js');
    assert.ok(!ctx.fichiers.some((f) => f.chemin.includes('\\')), 'aucun chemin ne doit porter de séparateur natif Windows');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
