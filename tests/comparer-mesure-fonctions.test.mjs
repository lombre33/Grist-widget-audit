import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/comparer-mesure-fonctions.mjs` compare la mesure d'une fonction à l'ancienne, sur chaque fonction d'un dossier de widget. Il se
 * rejoue : cet essai le lance sur un petit widget et vérifie ce qu'il dit, pour qu'un changement de `src/moteur/fonctions.js` ou de
 * l'inventaire ne le laisse pas pourrir sans qu'on le voie.
 */
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'comparer-mesure-fonctions.mjs');

function lancer(fichiers) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-comparer-mesure-'));
  try {
    for (const [nom, contenu] of Object.entries(fichiers)) fs.writeFileSync(path.join(dossier, nom), contenu);
    const r = spawnSync(process.execPath, [SCRIPT, dossier], { encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, sortie: r.stdout, erreur: r.stderr };
  } finally { fs.rmSync(dossier, { recursive: true, force: true }); }
}

const PAGE = '<!doctype html><html lang="fr"><title>t</title><script src="app.js"></script>';

test('comparer-mesure-fonctions : une fonction sans fonction interne vaut ce qu\'elle valait, une enveloppe ne vaut jamais plus, une chaîne de else if descend moins', () => {
  const app = [
    '(function () {',
    '  function feuille(x) { if (x === 0) { return 0; } else if (x === 1) { return 1; } else if (x === 2) { return 2; } return x ? 3 : 4; }',
    '  function enveloppe(x) { const a = () => x && 1; const b = () => x || 2; return a() + b(); }',
    '  function parDefaut(f = () => 1) { return f(); }',
    '})();',
    '',
  ].join('\n');
  const { code, sortie, erreur } = lancer({ 'index.html': PAGE, 'app.js': app });
  assert.equal(erreur, '');
  assert.equal(code, 0, sortie);
  // 7 fonctions : l'enveloppe du module, `feuille`, `enveloppe` et ses deux flèches, `parDefaut` et la flèche de son paramètre. Quatre n'en contiennent
  // aucune autre (`feuille`, les deux flèches de `enveloppe`, la flèche du paramètre) ; le module, `enveloppe` et `parDefaut` (par son paramètre) en contiennent.
  assert.match(sortie, /^7 fonctions, dont 4 qui n'en contiennent aucune autre et 3 qui en contiennent\./);
  assert.match(sortie, /complexité identique pour 4 sur 4/);
  assert.match(sortie, /plus basse pour 1 \(chaînes de `else if`\)/);   // `feuille` : l'ancien calcul compte trois niveaux, le nouveau un
  assert.match(sortie, /identique pour 4 sur 4 quand l'ancien calcul met les `else if` à plat/);
  assert.match(sortie, /Exceptions : 0\./);
});

test('comparer-mesure-fonctions : sans dossier, il dit comment s\'en servir et sort en code 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage : node scripts\/comparer-mesure-fonctions\.mjs/);
});
