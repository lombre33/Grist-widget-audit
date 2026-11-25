import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { axeDNonExecute } from './aide-chromium.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { auditDynamique } from '../src/runtime/dynamique.js';
import { demarrerServeur } from '../src/runtime/serveur.js';

/**
 * Le chargement de l'API Grist est l'usage normal d'un widget, d'où qu'il la demande : `/grist-plugin-api.js` à la racine du site, un chemin relatif,
 * un sous-dossier. Le dépôt n'a pas à la contenir. Un fichier du dépôt passe avant (copie embarquée), et ce que l'API officielle écrit elle-même
 * dans la console n'est pas une erreur du widget.
 */

function depot(t, fichiers) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-api-grist-'));
  for (const [nom, contenu] of Object.entries(fichiers)) {
    fs.mkdirSync(path.dirname(path.join(racine, nom)), { recursive: true });
    fs.writeFileSync(path.join(racine, nom), contenu);
  }
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  return racine;
}

const PAGE = (tete, corps = '') => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget de test</title>${tete}</head><body><main id="app">${corps}</main><script type="module" src="app.js"></script></body></html>`;
const CSP_STRICTE = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'">`;
const regles = (constats) => constats.map((c) => c.regle);

test("serveur : l'API Grist est servie à la racine, en relatif et en sous-dossier ; une copie du dépôt passe avant ; le reste de la racine reste introuvable", async (t) => {
  const racine = depot(t, { 'index.html': PAGE(''), 'js/grist-plugin-api.js': '// copie du dépôt' });
  const serveur = await demarrerServeur({ widgetRacine: racine, harnaisRacine: depot(t, {}) });
  t.after(() => serveur.fermer());
  const lire = async (chemin) => { const r = await fetch(serveur.origine + chemin); return { statut: r.status, texte: await r.text() }; };

  for (const chemin of ['/grist-plugin-api.js', '/widget/grist-plugin-api.js', '/api/grist-plugin-api.js']) {
    const r = await lire(chemin);
    assert.equal(r.statut, 200, chemin);
    assert.match(r.texte, /CustomSectionAPI/, `${chemin} : l'API officielle`);
    assert.ok(serveur.apiServie.has(chemin), `${chemin} : consigné comme servi par l'audit`);
  }
  assert.equal((await lire('/widget/js/grist-plugin-api.js')).texte, '// copie du dépôt', 'la copie du dépôt passe avant');
  assert.equal((await lire('/js/grist-plugin-api.js')).texte, '// copie du dépôt', 'même copie demandée depuis la racine du site');
  assert.ok(![...serveur.apiServie].some((p) => p.endsWith('/js/grist-plugin-api.js')), "la copie du dépôt n'est pas consignée comme officielle");
  assert.equal((await lire('/autre.js')).statut, 404, "seule l'API Grist est servie à la racine");
  assert.equal((await lire('/widget/absent.js')).statut, 404);
});

test("axe D : un widget qui charge /grist-plugin-api.js à la racine, sous une CSP stricte, n'a ni D-GRIST-01 ni D-CONSOLE-01", async (t) => {
  const racine = depot(t, {
    'index.html': PAGE(`${CSP_STRICTE}<script src="/grist-plugin-api.js"></script>`),
    'app.js': "grist.ready({ requiredAccess: 'read table' });\n",
  });
  const r = await auditDynamique(construireContexte(racine), {});
  if (r.nonExecute) { axeDNonExecute(t, r.constats); return; }
  for (const regle of ['D-GRIST-01', 'D-CONSOLE-01', 'D-ERR-00']) assert.ok(!regles(r.constats).includes(regle), regle);
  assert.ok(r.brut.consoles.some((c) => c.type === 'error' && c.apiGrist), "l'erreur de CSP produite par l'API (thème injecté) est vue, et attribuée à l'API");
});

test("axe D : les erreurs du widget lui-même, et celles d'une copie de l'API embarquée dans son dépôt, restent signalées", async (t) => {
  const propre = await auditDynamique(construireContexte(depot(t, {
    'index.html': PAGE('<script src="/grist-plugin-api.js"></script>'),
    'app.js': "grist.ready({ requiredAccess: 'read table' });\nconsole.error('erreur du widget');\n",
  })), {});
  if (propre.nonExecute) { axeDNonExecute(t, propre.constats); return; }
  assert.ok(regles(propre.constats).includes('D-CONSOLE-01'), 'une erreur du widget est comptée');

  const copie = await auditDynamique(construireContexte(depot(t, {
    'index.html': PAGE('<script src="grist-plugin-api.js"></script>'),
    'grist-plugin-api.js': "console.error('erreur de la copie embarquée');\n",
    'app.js': '\n',
  })), {});
  assert.ok(regles(copie.constats).includes('D-CONSOLE-01'), "une copie de l'API fournie par le dépôt n'est pas exemptée");
});
