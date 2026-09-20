import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { construireContexte } from '../src/contexte/inventaire.js';
import { auditDynamique } from '../src/runtime/dynamique.js';

/**
 * D-PERIMETRE-01 (src/regles/d-perimetre.js) est câblée dans auditDynamique
 * mais n'était jusqu'ici testée qu'au niveau unitaire, sur un journal
 * construit à la main (tests/d-perimetre.test.mjs) : rien ne garantissait
 * qu'elle se déclenche vraiment sur un audit réel, ni qu'elle reste
 * silencieuse sur un widget qui énumère légitimement — demandé
 * explicitement par la coordination, pour ne pas livrer un piège qui ne se
 * referme jamais sans que personne ne le sache.
 */
async function auditerWidget(app) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-perimetre-'));
  fs.writeFileSync(path.join(racine, 'index.html'),
    '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget de test périmètre</title>' +
    '<script src="https://docs.getgrist.com/grist-plugin-api.js"></script>' +
    '</head><body><div id="app"></div><script src="app.js"></script></body></html>');
  fs.writeFileSync(path.join(racine, 'app.js'), app);
  try {
    const ctx = construireContexte(racine);
    return await auditDynamique(ctx, {});
  } finally {
    fs.rmSync(racine, { recursive: true, force: true });
  }
}

test('D-PERIMETRE-01 se déclenche à partir de auditDynamique() sur un widget qui énumère puis lit toutes les tables', async (t) => {
  const { constats, nonExecute } = await auditerWidget(
    "grist.ready({ requiredAccess: 'full' });\n" +
    "(async () => {\n" +
    "  const tables = await grist.docApi.listTables();\n" +
    "  for (const t of tables) { await grist.docApi.fetchTable(t); }\n" +
    "})();\n"
  );
  if (nonExecute) { t.skip('Axe D non exécutable dans cet environnement.'); return; }

  const c = constats.find((x) => x.regle === 'D-PERIMETRE-01');
  assert.ok(c, "D-PERIMETRE-01 doit apparaître dans les constats produits par un audit réel");
  assert.equal(c.bloquant, true);
});

test("D-PERIMETRE-01 reste silencieuse sur un widget qui ne lit que sa table sélectionnée (fixtures/widget-exemple)", async (t) => {
  const ctx = construireContexte(path.join(import.meta.dirname, '..', 'fixtures', 'widget-exemple'));
  const { constats, nonExecute } = await auditDynamique(ctx, {});
  if (nonExecute) { t.skip('Axe D non exécutable dans cet environnement.'); return; }

  assert.equal(constats.some((c) => c.regle === 'D-PERIMETRE-01'), false,
    "la fixture donnée en modèle par l'outil ne doit jamais déclencher un faux positif");
});

test("D-PERIMETRE-01 reste silencieuse sur un widget qui énumère légitimement toute la structure du document (docApi.listTables() sans lire chaque table)", async (t) => {
  // Reproduit le point précis que la règle doit tolérer : un widget dont le
  // métier est de parcourir la structure (comme Grist_Table_structure_import,
  // CONFORME 81/100) appelle listTables() mais ne va PAS lire chaque table
  // trouvée — contrairement au widget du premier test ci-dessus.
  const { constats, nonExecute } = await auditerWidget(
    "grist.ready({ requiredAccess: 'full' });\n" +
    "(async () => {\n" +
    "  const tables = await grist.docApi.listTables();\n" +
    "  window.__tablesVues = tables;\n" +
    "})();\n"
  );
  if (nonExecute) { t.skip('Axe D non exécutable dans cet environnement.'); return; }

  assert.equal(constats.some((c) => c.regle === 'D-PERIMETRE-01'), false,
    "lister les tables sans les lire est une énumération légitime, pas le signal recherché");
});
