import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { axeDNonExecute } from './aide-chromium.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { auditDynamique } from '../src/runtime/dynamique.js';

/**
 * Le code que sert un hôte Grist n'est pas un tiers : charger `grist-plugin-api.js` depuis `docs.getgrist.com` (la forme que documente Grist)
 * ne donne ni constat ni pénalité, ni à l'axe C (l'ancien C-EXFIL-04), ni à l'axe E, ni à l'axe D (D-RESEAU-02). Ce qui imite un hôte Grist,
 * ou qui n'est pas du code de Grist (la pièce jointe d'un document), reste signalé.
 */

function widget(t, head, appJs = "grist.ready({ requiredAccess: 'read table' });\n") {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-code-grist-'));
  fs.writeFileSync(path.join(racine, 'index.html'),
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget de test</title>${head}</head><body><div id="app"></div><script type="module" src="app.js"></script></body></html>`);
  fs.writeFileSync(path.join(racine, 'app.js'), appJs);
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  return racine;
}

const regles = (constats) => constats.map((c) => c.regle);
const statique = (racine) => analyseStatique(construireContexte(racine), { reseau: false });

test("axes C et E : l'API Grist et le code des hôtes Grist, chargés depuis leur adresse, donnent exactement les constats de l'API en relatif", async (t) => {
  const depuisGrist = await statique(widget(t,
    '<script type="importmap">{"imports":{"gx":"https://monequipe.getgrist.com/static/gx.js"}}</script>' +
    '<script src="https://docs.getgrist.com/grist-plugin-api.js"></script>' +
    '<script src="https://docs.getgrist.com/static/autre.js"></script>',
    "import 'https://grist.numerique.gouv.fr/static/mod.js';\ngrist.ready({ requiredAccess: 'read table' });\n"));
  const enRelatif = await statique(widget(t, '<script src="/grist-plugin-api.js"></script>'));

  assert.ok(!regles(depuisGrist).includes('C-EXFIL-04'), 'la règle C-EXFIL-04 est retirée');
  for (const regle of ['C-EXFIL-01', 'C-EXFIL-03', 'E-DEP-01']) assert.ok(!regles(depuisGrist).includes(regle), regle);
  assert.deepEqual(new Set(regles(depuisGrist)), new Set(regles(enRelatif)), "mêmes règles que l'API en relatif : aucune pénalité en plus");
});

test("une adresse qui imite Grist, ou la pièce jointe d'un document Grist, reste une dépendance tierce signalée", async (t) => {
  const imitation = await statique(widget(t, '<script src="https://getgrist.com.exemple.org/grist-plugin-api.js"></script><script src="https://evilgetgrist.com/lib.js"></script>'));
  assert.ok(imitation.filter((c) => c.regle === 'C-EXFIL-03' && c.bloquant).length >= 2, 'C-EXFIL-03 bloquant pour les deux hôtes');
  assert.deepEqual(imitation.filter((c) => c.regle === 'E-DEP-01').map((c) => c.titre.split(' depuis ').pop()), ['evilgetgrist.com']);

  const piece = await statique(widget(t, '<script src="https://docs.getgrist.com/api/docs/abc/attachments/1/download"></script>'));
  assert.ok(piece.some((c) => c.regle === 'E-DEP-01' && c.bloquant), "code d'un document, pas de Grist");
});

test("axe D : l'API chargée depuis docs.getgrist.com est servie au widget sans constat, depuis un hôte qui n'est pas Grist D-RESEAU-02 reste", async (t) => {
  const officiel = await auditDynamique(construireContexte(widget(t, '<script src="https://docs.getgrist.com/grist-plugin-api.js"></script>')), {});
  if (officiel.nonExecute) { axeDNonExecute(t, officiel.constats); return; }
  assert.ok(!regles(officiel.constats).includes('D-RESEAU-02'));
  assert.ok(!regles(officiel.constats).includes('D-ERR-00'), "le widget a bien reçu l'API et s'est chargé");
  assert.ok(!officiel.constats.some((c) => c.bloquant), 'aucun bloquant');

  const imitation = await auditDynamique(construireContexte(widget(t, '<script src="https://getgrist.com.exemple.org/grist-plugin-api.js"></script>')), {});
  assert.ok(regles(imitation.constats).includes('D-RESEAU-02'));
});
