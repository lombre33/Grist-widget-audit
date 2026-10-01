/**
 * `scripts/mesurer-leurres-au-hasard.mjs` : le relevé de ce que le test des leurres fait des clés tirées au hasard. Les essais éprouvent ce que le
 * script juge (son code de sortie), sur l'arbre courant et sur des arbres factices dont `estCorpsDeLeurre` est décidé d'avance : un arbre qui prend
 * toute clé pour un leurre fait sortir le script en code 1, en nommant les seules formes de fournisseur ; un arbre qui n'en prend aucune, en code 0 ;
 * un arbre qui n'a pas les deux fonctions, ou une option fausse, en code 2. Les tirages sont toujours les mêmes pour une
 * même graine : aucun essai ne compare un temps.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(RACINE, 'scripts', 'mesurer-leurres-au-hasard.mjs');

const lancer = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });

/** Un arbre factice : `src/regles/c-secrets.js` n'a que ce que l'essai lui donne. */
function arbreFactice(parent, nom, source) {
  const dossier = path.join(parent, nom, 'src', 'regles');
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, 'c-secrets.js'), source);
  return path.join(parent, nom);
}

test('le script sort en code 0 sur l\'arbre courant et dit chaque forme, sans écrire une clé', () => {
  const r = lancer('--tirages=3000');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^3000 tirages par forme, graine 1, arbre /);
  for (const forme of ['AWS, base 32, 16 signes', 'GitHub, base 62, 36 signes', 'Stripe, base 62, 24 signes', 'Google, base 64 URL, 35 signes', 'lettres seules, 36 signes']) assert.ok(r.stdout.includes(forme), forme);
  assert.match(r.stdout, /Aucune forme de fournisseur ne dépasse un tirage sur 100000 pris pour un leurre\./);
  // Les comptes seuls : aucune ligne ne porte autre chose qu'un libellé et deux nombres.
  const lignes = r.stdout.trim().split('\n').slice(1, -1);
  assert.equal(lignes.length, 12);
  for (const l of lignes) assert.match(l, /^ {5}.+ +\d+ ont la forme de mots, +\d+ prises pour un leurre$/);
});

test('les mêmes tirages pour la même graine, d\'autres pour une autre', () => {
  const a = lancer('--tirages=2000', '--graine=7').stdout;
  assert.equal(lancer('--tirages=2000', '--graine=7').stdout, a);
  assert.notEqual(lancer('--tirages=2000', '--graine=8').stdout, a);
});

test('un arbre qui prend toute clé pour un leurre sort en code 1 et nomme les formes de fournisseur ; un arbre qui n\'en prend aucune, en code 0', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-leurres-'));
  try {
    const tout = arbreFactice(parent, 'tout', 'export const motsDeLaValeur = () => null;\nexport const estCorpsDeLeurre = () => true;\n');
    const rien = arbreFactice(parent, 'rien', 'export const motsDeLaValeur = () => null;\nexport const estCorpsDeLeurre = () => false;\n');
    const r1 = lancer('--tirages=200', `--racine=${tout}`);
    assert.equal(r1.status, 1, r1.stdout + r1.stderr);
    const lignes = r1.stdout.trim().split('\n').slice(1, -1);
    // Seules les six formes de fournisseur sont en faute, les six autres (les pires cas) sont dites sans l'être.
    assert.deepEqual(lignes.map((l) => l.startsWith('TROP ')), [true, true, true, true, true, true, false, false, false, false, false, false]);
    assert.match(r1.stdout, /TROP AWS, base 32, 16 signes +0 ont la forme de mots, +200 prises pour un leurre/);
    assert.match(r1.stdout, /Une forme de fournisseur dépasse un tirage sur 100000 pris pour un leurre\./);
    const r0 = lancer('--tirages=200', `--racine=${rien}`);
    assert.equal(r0.status, 0, r0.stdout + r0.stderr);
    assert.doesNotMatch(r0.stdout, /TROP/);
    assert.match(r0.stdout, /Aucune forme de fournisseur ne dépasse/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('un arbre qui n\'a pas les deux fonctions et une option fausse sortent en code 2, en le disant', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-leurres-'));
  try {
    const sans = arbreFactice(parent, 'sans', 'export const autre = 1;\n');
    const r = lancer('--tirages=10', `--racine=${sans}`);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /rien à mesurer/);
    for (const faux of ['--tirages=0', '--tirages=abc', '--graine=-1', '--foo', 'tirages=5']) {
      const f = lancer(faux);
      assert.equal(f.status, 2, faux);
      assert.match(f.stderr, /Usage : node scripts\/mesurer-leurres-au-hasard\.mjs/, faux);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
