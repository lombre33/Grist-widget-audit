// Lancé par tests/bac-a-sable-chromium.test.mjs, dans un processus à part et SANS dérogation :
// l'axe D contre widget-exemple avec un scénario qui fait échouer l'axe après le lancement de Chromium
// (`colonnes: null` : documentDeTest() échoue une fois le navigateur démarré). Écrit les constats en JSON.
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { auditDynamique } from '../src/runtime/dynamique.js';

const ctx = construireContexte(path.join(import.meta.dirname, '..', 'fixtures', 'widget-exemple'));
const { constats, nonExecute } = await auditDynamique(ctx, { scenario: { colonnes: null } });
process.stdout.write(`${JSON.stringify({ constats, nonExecute })}\n`);
