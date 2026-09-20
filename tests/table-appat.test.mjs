import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { construireContexte } from '../src/contexte/inventaire.js';
import { auditDynamique, TABLE_APPAT_ID } from '../src/runtime/dynamique.js';

/**
 * Vérifie le mécanisme de la table appât demandé par la coordination :
 * `TABLE_APPAT_ID` existe, `listTables()` la révèle (comme le ferait un vrai
 * Grist en accès `full`), `fetchTable()` lui renvoie ses propres données
 * distinctes de la table principale — et un widget qui ne s'en sert jamais
 * ne laisse aucune trace de cet identifiant dans le journal RPC. La règle
 * de détection elle-même (axe C ou D, à écrire ailleurs) n'est pas testée
 * ici : seulement que la donnée qu'elle consommera est bien produite.
 */
async function auditerWidget(app) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-appat-'));
  fs.writeFileSync(path.join(racine, 'index.html'),
    '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget de test appât</title>' +
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

test("un widget honnête (qui ne lit que sa table sélectionnée) ne touche jamais à TABLE_APPAT_ID", async (t) => {
  const { brut, nonExecute } = await auditerWidget(
    "grist.ready({ requiredAccess: 'full' });\n" +
    "grist.onRecords((records) => { window.__nbLignes = records.length; });\n"
  );
  if (nonExecute) { t.skip('Axe D non exécutable dans cet environnement.'); return; }

  const appels = brut.journalHote?.appelsRpc ?? [];
  const toucheAppat = appels.some((a) => JSON.stringify(a.args).includes(TABLE_APPAT_ID));
  assert.equal(toucheAppat, false, "un widget qui ne fait qu'écouter sa table sélectionnée ne doit jamais référencer la table appât");
});

test("un widget qui énumère puis lit une table non déclarée touche bien TABLE_APPAT_ID, avec ses propres données", async (t) => {
  const { brut, nonExecute } = await auditerWidget(
    "grist.ready({ requiredAccess: 'full' });\n" +
    "(async () => {\n" +
    "  const tables = await grist.docApi.listTables();\n" +
    "  const autre = tables.find((t) => t !== 'Contacts');\n" +
    "  if (autre) window.__donneesAppat = await grist.docApi.fetchTable(autre);\n" +
    "})();\n"
  );
  if (nonExecute) { t.skip('Axe D non exécutable dans cet environnement.'); return; }

  const appelFetch = (brut.journalHote?.appelsRpc ?? [])
    .find((a) => a.methode === 'fetchTable' && a.args?.[0] === TABLE_APPAT_ID);
  assert.ok(appelFetch, "l'appel fetchTable(TABLE_APPAT_ID) doit apparaître dans le journal RPC");
  assert.ok(
    !JSON.stringify(appelFetch.resultatResume ?? '').includes('Alice Dupont'),
    'les données renvoyées pour la table appât ne doivent pas être celles de la table principale',
  );
});
