/**
 * `scripts/mesurer-profondeur.mjs` : la table de ce que Chromium exécute, de ce que l'audit lit et de ce que le parcours de ses
 * règles porte, par construction imbriquée. Ses nombres sont ceux de la pile de la machine : les essais n'en comparent aucun à une
 * valeur écrite, ils vérifient que la mesure se fait, que ses options sont refusées quand elles sont fausses, et que là où l'audit
 * dit illisible un code que Chromium exécute, le navigateur va bien plus profond que l'audit.
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumIndisponible } from './aide-chromium.mjs';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/mesurer-profondeur.mjs');
const lancer = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 180_000 });
const cheminChromium = () => {
  const impose = process.env.GWAUDIT_CHROMIUM_PATH;
  if (impose) return fs.existsSync(impose) ? impose : null;
  const defaut = chromium.executablePath();
  return fs.existsSync(defaut) ? defaut : null;
};

test('sans Chromium, la table dit pour une construction jusqu\'où l\'audit lit et jusqu\'où son parcours porte', () => {
  const r = lancer('--sans-chromium', '--json', '--precision=0.3', '--construction=parenthèses');
  assert.equal(r.status, 0, r.stderr);
  const { node, chromium: version, lignes } = JSON.parse(r.stdout);
  assert.equal(node, process.version);
  assert.equal(version, null);
  assert.equal(lignes.length, 1);
  const [l] = lignes;
  assert.match(l.construction, /^parenthèses/);
  assert.equal('navigateur' in l, false, 'sans Chromium, la colonne du navigateur n\'existe pas');
  for (const nom of ['lecture', 'parcours']) {
    assert.ok(Number.isInteger(l[nom]) && l[nom] >= 50 && l[nom] <= 20_000, `${nom} : une profondeur que la pile porte, non celle d'une mesure qui ne mesure rien (${l[nom]})`);
  }
  assert.ok(l.parcours <= l.lecture * 1.4, 'le parcours ne va pas plus profond que la lecture qui lui donne son arbre, à la précision près');
});

test('la table lit le texte d\'un tableau quand on ne demande pas le JSON, une ligne par construction qui correspond au motif', () => {
  const r = lancer('--sans-chromium', '--precision=0.5', '--construction=typeof');
  assert.equal(r.status, 0, r.stderr);
  const lignes = r.stdout.trim().split('\n');
  assert.match(lignes[0], /^Node v\d+/);
  assert.match(lignes[1], /construction\s+navigateur\s+lecture\s+parcours/);
  assert.equal(lignes.length, 3, 'un titre, un en-tête, une construction');
  assert.match(lignes[2], /^typeof typeof a\s+—\s+\S+\s+\S+/);
});

test('une option inconnue, une précision fausse ou un motif sans construction sort en code 2 sans rien mesurer', () => {
  for (const [args, dit] of [
    [['--vite'], /Option inconnue : --vite/],
    [['--precision=0'], /Précision invalide/],
    [['--precision=1'], /Précision invalide/],
    [['--precision=abc'], /Précision invalide/],
    [['--sans-chromium', '--construction=aucune-de-ces-choses'], /Aucune construction ne correspond/],
  ]) {
    const r = lancer(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, dit);
    assert.equal(r.stdout, '', 'rien n\'est mesuré');
  }
});

test('dans Chromium, le navigateur exécute les parenthèses imbriquées bien plus profond que l\'audit ne les lit : c\'est ce qui rend illisible un code que la page exécute', async (t) => {
  const executable = cheminChromium();
  if (!executable) { chromiumIndisponible(t, 'aucun Chromium lançable (voir GWAUDIT_CHROMIUM_PATH)'); return; }
  const r = lancer('--json', '--precision=0.3', '--construction=parenthèses');
  assert.equal(r.status, 0, r.stderr);
  const { chromium: version, lignes: [l] } = JSON.parse(r.stdout);
  assert.match(version, /^\d+\./);
  assert.ok(l.navigateur > l.lecture * 1.3, `Chromium ${l.navigateur} contre l'audit ${l.lecture} : la prémisse de C-SURFACE-03 pour la profondeur`);
});
