/**
 * `scripts/mesurer-seuil-memoire.mjs` : les chiffres de mémoire du document d'architecture se rejouent par cette commande.
 * `--cible` lit le dossier d'un vrai widget tel quel (jamais le supprimer : c'est celui d'un autre), le mode synthétique
 * fabrique son dossier et le retire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codeSynthetique } from '../scripts/lib/code-synthetique.mjs';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(RACINE, 'scripts', 'mesurer-seuil-memoire.mjs');
const lancer = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: RACINE });
const dossiersDeMesure = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gwaudit-mesure-'));

test('--cible : le dossier est analysé tel quel, la ligne dit la cible et non une taille de code fabriquée, et le dossier reste', () => {
  const cible = path.join(RACINE, 'fixtures', 'widget-exemple');
  const avant = fs.readdirSync(cible).sort();
  const r = lancer('--cible', cible, '--tas', '558');
  assert.equal(r.status, 0, r.stderr);
  const ligne = JSON.parse(r.stdout);
  assert.equal(ligne.cible, 'widget-exemple');
  assert.equal(ligne.abouti, true);
  assert.equal(ligne.tasMo, 558);
  assert.equal(ligne.cause, null);
  assert.ok(ligne.rssMaxMo > 0 && ligne.constats > 0, r.stdout);
  assert.equal('codeMio' in ligne, false, 'aucune taille fabriquée à dire pour une cible réelle');
  assert.equal('sources' in ligne, false, 'ni « synthétique » ni « fichiers fournis » : le code n\'est pas fabriqué');
  assert.deepEqual(fs.readdirSync(cible).sort(), avant, 'la cible n\'est ni retirée ni modifiée');
});

test('--cible ne se combine pas avec ce qui fabrique du code, et refuse ce qui n\'est pas un dossier (code 64, sans analyse)', () => {
  for (const autre of [['--mio', '2'], ['--fichiers', '3'], ['--sources', 'a.js']]) {
    const r = lancer('--cible', path.join(RACINE, 'fixtures', 'widget-exemple'), ...autre);
    assert.equal(r.status, 64, autre.join(' '));
    assert.match(r.stderr, /--cible analyse un dossier tel quel/);
    assert.equal(r.stdout, '');
  }
  const absent = lancer('--cible', path.join(os.tmpdir(), 'gwaudit-dossier-qui-n-existe-pas'));
  assert.equal(absent.status, 64);
  assert.match(absent.stderr, /n'est pas un dossier/);
  const fichier = lancer('--cible', path.join(RACINE, 'package.json'));
  assert.equal(fichier.status, 64, 'un fichier n\'est pas un dossier');
});

test('mode synthétique : la ligne dit la taille du code fabriqué, et le dossier fabriqué est retiré', () => {
  const avant = dossiersDeMesure();
  const r = lancer('--mio', '0.05', '--tas', '558');
  assert.equal(r.status, 0, r.stderr);
  const ligne = JSON.parse(r.stdout);
  assert.equal(ligne.sources, 'synthétique');
  assert.equal(ligne.fichiers, 1);
  assert.ok(ligne.codeMio >= 0.04 && ligne.codeMio <= 0.1, r.stdout);
  assert.equal('cible' in ligne, false);
  assert.deepEqual(dossiersDeMesure(), avant, 'aucun dossier de mesure ne reste');
});

test('--cible interrompue faute de tas : code 2, la cause et l\'étape sont dites, et le dossier de la cible reste', () => {
  const cible = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-cible-mesure-'));
  try {
    fs.writeFileSync(path.join(cible, 'gros.js'), codeSynthetique(1024 * 1024, 1));
    fs.writeFileSync(path.join(cible, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><script src="gros.js"></script></body></html>\n');
    const r = lancer('--cible', cible, '--tas', '64');
    assert.equal(r.status, 2, r.stderr + r.stdout);
    const ligne = JSON.parse(r.stdout);
    assert.equal(ligne.abouti, false);
    assert.equal(ligne.cause, 'tas', 'la mémoire d\'un tas de 64 Mio est épuisée par 1 Mio de code dense');
    assert.equal(typeof ligne.etape, 'string', 'l\'étape où l\'enfant s\'est arrêté est dite');
    assert.equal(ligne.constats, null);
    assert.equal(ligne.tasMo, 64);
    assert.ok(fs.existsSync(path.join(cible, 'gros.js')), 'la cible reste, interrompue ou non');
  } finally { fs.rmSync(cible, { recursive: true, force: true }); }
});
