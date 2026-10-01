/**
 * Budget de temps de l'axe D face à un widget qui boucle, déplacé de `tests/axe-d-bloque.test.mjs` : l'audit
 * doit conclure de lui-même (D-TIMEOUT-01, bloquant), et vite, avec un délai de l'axe D réduit à 20 s. Ce cas
 * lance un vrai Chromium : il est ignoré, en le disant, là où il n'y en a pas. Voir scripts/lib/budgets.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RACINE = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(RACINE, 'bin', 'gwaudit.js');
const EXEMPLE = path.join(RACINE, 'fixtures', 'widget-exemple');

/** Le Chromium que l'audit utiliserait : celui que GWAUDIT_CHROMIUM_PATH désigne, sinon celui de Playwright. */
async function chromiumIntrouvable() {
  if (process.env.GWAUDIT_CHROMIUM_PATH) return fs.existsSync(process.env.GWAUDIT_CHROMIUM_PATH) ? null : `GWAUDIT_CHROMIUM_PATH (${process.env.GWAUDIT_CHROMIUM_PATH}) n'existe pas`;
  try {
    const { chromium } = await import('playwright');
    return fs.existsSync(chromium.executablePath()) ? null : "le Chromium de Playwright n'est pas installé";
  } catch {
    return "Playwright n'est pas installé";
  }
}

export const cas = [{
  nom: "axe D : l'audit d'un widget qui boucle conclut de lui-même (délai de l'axe D : 20 s)",
  budgetMs: 90_000,
  ignorerSi: chromiumIntrouvable,
  executer() {
    const travail = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-budget-axe-d-'));
    try {
      const widget = path.join(travail, 'widget');
      fs.cpSync(EXEMPLE, widget, { recursive: true });
      fs.writeFileSync(path.join(widget, 'ajout.js'), 'for(;;){}');
      const html = fs.readFileSync(path.join(widget, 'index.html'), 'utf8');
      assert.ok(html.includes('</body>'), "widget-exemple n'a plus de </body> : le cas ne saurait où ajouter le script");
      fs.writeFileSync(path.join(widget, 'index.html'), html.replace('</body>', '<script src="ajout.js"></script></body>'));
      const sortie = path.join(travail, 'sortie');
      const r = spawnSync(process.execPath, [CLI, widget, '--json', '--sortie', sortie], {
        encoding: 'utf8', timeout: 240_000, env: { ...process.env, GWAUDIT_DELAI_AXE_D_MS: '20000' },
      });
      assert.ok(r.status !== null && r.status <= 2, `gwaudit a échoué (code ${r.status}) : ${(r.stderr ?? '').slice(-400)}`);
      const rapport = JSON.parse(fs.readFileSync(path.join(sortie, 'rapport.json'), 'utf8'));
      // Un budget tenu par un audit qui n'a pas joué l'axe D ne prouverait rien.
      assert.equal(rapport.axes.D.causes?.[0]?.regle, 'D-TIMEOUT-01', "l'audit n'a pas conclu par D-TIMEOUT-01");
    } finally {
      fs.rmSync(travail, { recursive: true, force: true });
    }
  },
}];
