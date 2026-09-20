import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { construireContexte } from '../src/contexte/inventaire.js';
import { auditDynamique } from '../src/runtime/dynamique.js';

/**
 * Régression pour le trou de neutralisation réseau trouvé par le fil
 * « featues à date » (docs/PISTES-EXHAUSTIVITE.md, point 1) : `context.route()`
 * n'intercepte que le trafic HTTP, jamais les WebSocket. `--host-resolver-rules`
 * bloque déjà une cible externe réelle (nom d'hôte ou IP littérale, voir
 * docs/ARCHITECTURE-V2.md §1 constat 5), mais laisse passer `127.0.0.1`/
 * `localhost` sans la vérification d'origine exacte que `context.route()`
 * applique au HTTP : avant correctif, un widget ouvrant une connexion
 * WebSocket vers un autre port local l'aurait réellement établie pendant
 * l'audit, atteignant un autre service du même poste — et le rapport
 * n'aurait rien montré du tout, la tentative n'étant même pas enregistrée.
 * On le prouve comme pour le SSRF (tests/ssrf.test.mjs) : en écoutant
 * vraiment sur un port local et en vérifiant qu'aucune connexion n'y
 * arrive, pas seulement que le rapport dit ce qu'on attend.
 */
test("l'axe D neutralise une connexion WebSocket directe et la fait remonter en D-RESEAU-01", async (t) => {
  let connexionsRecues = 0;
  const cible = net.createServer((socket) => { connexionsRecues++; socket.destroy(); });
  await new Promise((resolve) => cible.listen(0, '127.0.0.1', resolve));
  const portCible = cible.address().port;

  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-ws-'));
  fs.writeFileSync(path.join(racine, 'index.html'),
    '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget de test WebSocket</title>' +
    '<script src="https://docs.getgrist.com/grist-plugin-api.js"></script>' +
    '</head><body><div id="app"></div><script src="app.js"></script></body></html>');
  fs.writeFileSync(path.join(racine, 'app.js'),
    "grist.ready({ requiredAccess: 'full' });\n" +
    `const ws = new WebSocket('ws://127.0.0.1:${portCible}/');\n` +
    "ws.onclose = () => { window.__wsFerme = true; };\n");

  t.after(() => { fs.rmSync(racine, { recursive: true, force: true }); cible.close(); });

  const ctx = construireContexte(racine);
  const { constats, brut, nonExecute } = await auditDynamique(ctx, {});

  if (nonExecute) {
    // Axe D indisponible dans cet environnement (Chromium introuvable ou
    // autre échec de lancement — voir GWAUDIT_CHROMIUM_PATH dans le
    // README) : on ne peut pas prouver le correctif ici, mais ce n'est pas
    // une raison de faire échouer la suite pour un problème d'environnement
    // sans rapport avec ce test.
    const raison = constats.find((c) => c.regle === 'D-INDISPONIBLE')?.constat ?? '(raison inconnue)';
    t.skip(`Axe D non exécutable dans cet environnement : ${raison}`);
    return;
  }

  // La preuve qui compte : la vraie cible n'a jamais reçu de connexion TCP.
  assert.equal(connexionsRecues, 0, 'aucune connexion ne doit jamais atteindre le serveur WebSocket ciblé par le widget');

  const requetesWs = brut.requetes.filter((r) => r.ressourceType === 'websocket');
  assert.equal(requetesWs.length, 1, 'la tentative de connexion WebSocket doit être enregistrée');
  assert.equal(requetesWs[0].hote, '127.0.0.1');

  const constatReseau = constats.find((c) => c.regle === 'D-RESEAU-01');
  assert.ok(constatReseau, 'D-RESEAU-01 doit être déclenché par la tentative WebSocket');
  assert.match(constatReseau.constat, /WEBSOCKET/);
});
