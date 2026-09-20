import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserTests } from '../src/regles/a-qualite.js';

/**
 * Faux positif trouvé sur `publipostageGrist` (docs/PISTES-EXHAUSTIVITE.md
 * §3) : le dossier `dev-tests/` a `dev-` collé sans séparateur avant `tests`,
 * et son lanceur e2e charge Playwright via un chemin absolu
 * (`require('/opt/.../playwright')`) plutôt que le spécificateur nu attendu.
 * L'ancien motif ratait les deux et déclarait « aucun test » sur un dépôt qui
 * en a un vrai (15 scénarios + un lanceur Chromium headless).
 */

function fichier(chemin, contenu = '') {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false };
}

test('A-TEST-01 : dev-tests/ (préfixe collé, pas de / avant "tests") est reconnu comme dossier de tests unitaires', () => {
  const ctx = { fichiers: [fichier('dev-tests/scenario-01.js', 'test();')] };
  const constats = analyserTests(ctx);
  assert.ok(!constats.find((c) => c.regle === 'A-TEST-01'), 'ne doit plus déclarer "aucun test unitaire"');
});

test('A-TEST-02 : un lanceur qui charge Playwright par chemin absolu et pilote un vrai Chromium est reconnu comme test e2e', () => {
  const contenu = [
    "const { chromium } = require('/opt/node22/lib/node_modules/playwright');",
    "const browser = await chromium.launch({ args: ['--no-sandbox'] });",
    'const page = await context.newPage();',
  ].join('\n');
  const ctx = { fichiers: [fichier('dev-tests/run-headless.mjs', contenu)] };
  const constats = analyserTests(ctx);
  assert.ok(!constats.find((c) => c.regle === 'A-TEST-02'), 'ne doit plus déclarer "aucun test e2e"');
});

test('A-TEST-01/02 combinés : le dossier dev-tests/ complet de publipostageGrist ne déclenche plus aucun faux positif', () => {
  const runner = [
    "const { chromium } = require('/opt/node22/lib/node_modules/playwright');",
    "const browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });",
    'const page = await context.newPage();',
  ].join('\n');
  const ctx = {
    fichiers: [
      fichier('dev-tests/scenarios-base.js', 'test();'),
      fichier('dev-tests/runner.js', ''),
      fichier('dev-tests/run-headless.mjs', runner),
      fichier('dev-tests/helpers.js', ''),
    ],
  };
  const constats = analyserTests(ctx);
  assert.equal(constats.filter((c) => c.regle === 'A-TEST-01' || c.regle === 'A-TEST-02').length, 0);
  assert.ok(constats.find((c) => c.regle === 'A-TEST-03'), 'doit au contraire signaler positivement les tests présents');
});

test('A-TEST-01 : ne doit toujours pas reconnaître un fichier sans rapport ("latest.js", "contest.js") comme test', () => {
  const ctx = { fichiers: [fichier('src/latest.js', ''), fichier('src/contest.js', '')] };
  const constats = analyserTests(ctx);
  assert.ok(constats.find((c) => c.regle === 'A-TEST-01'), 'aucun vrai test : le faux positif ne doit pas se transformer en faux négatif');
});

test('A-TEST-02 : ne doit toujours pas reconnaître un simple mot "browser" dans un commentaire ou nom de variable comme preuve e2e', () => {
  const ctx = { fichiers: [fichier('src/app.js', '// compatible avec tous les browser modernes')] };
  const constats = analyserTests(ctx);
  assert.ok(constats.find((c) => c.regle === 'A-TEST-02'), 'un simple mot dans le contenu ne doit pas suffire (seul le chemin ou un motif de pilotage compte)');
});
