// Essai 23 : le widget garde-t-il des données du document dans le navigateur (localStorage, sessionStorage, IndexedDB, cookies) ? Elles y survivent à
// la fermeture du document et tout code de la même origine peut les lire. Les observations sont fabriquées ; le test de bout en bout, qui lance un
// vrai Grist Desktop, est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { construireJeu } from '../src/runtime/grist-reel/donnees.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = construireJeu(undefined, 'cafe0023');
const vide = { nombre: 0, cles: [], taille: 0, canari: false };
const stockage = (extra = {}) => ({ local: vide, session: vide, indexedDB: { nombre: 0, noms: [], canari: false }, caches: [], cookies: [], ...extra });
const obs = (extra = {}) => ({ charge: true, canariRecu: true, appelsRpc: [{}], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, canaux: null, stockage: stockage(), erreur: null, ...extra });
const jouer = (o) => evaluerEssais({ none: obs({ canariRecu: false, stockage: null }), demande: { niveau: 'read table', obs: o } }, jeu);
const e23 = (r) => r.essais.find((e) => e.id === 23);

test("essai 23 : des données du document retrouvées dans le stockage du navigateur = constat mineur non bloquant, avec le lieu ; rien retrouvé = rien observé", () => {
  const r = jouer(obs({ stockage: stockage({ local: { ...vide, nombre: 1, cles: ['cache-contacts'], canari: true }, cookies: [{ nom: 'dernier-contact', canari: false }] }) }));
  assert.equal(e23(r).resultat, 'reussi');
  assert.equal(e23(r).severite, 'mineur');
  assert.deepEqual(e23(r).gardes, ['localStorage']);
  const c = r.constats.find((x) => x.regle === 'D-REEL-23');
  assert.equal(c.severite, 'mineur'); assert.equal(c.bloquant, false); assert.equal(c.confiance, 'prouve');
  assert.match(c.constat, /dernier-contact/, 'les cookies déposés sont nommés');
  assert.equal(verdictEssai(e23(r)).cle, 'pas_bien');

  const idb = jouer(obs({ stockage: stockage({ indexedDB: { nombre: 1, noms: ['cache'], canari: true } }) }));
  assert.deepEqual(e23(idb).gardes, ['IndexedDB']);
  const cookie = jouer(obs({ stockage: stockage({ cookies: [{ nom: 'session', canari: true }] }) }));
  assert.deepEqual(e23(cookie).gardes, ['cookie']);

  const rien = jouer(obs());
  assert.equal(e23(rien).resultat, 'rien_observe');
  assert.equal(rien.constats.filter((x) => x.regle === 'D-REEL-23').length, 0);
  assert.equal(verdictEssai(e23(rien)).cle, 'bien');
  const autres = jouer(obs({ stockage: stockage({ local: { ...vide, nombre: 2, cles: ['theme', 'langue'] } }) }));
  assert.equal(e23(autres).resultat, 'rien_observe', "un réglage sans donnée du document n'est pas un constat");
  assert.match(e23(autres).detail, /localStorage \(2\)/);
});

test("essai 23 : jamais « rien observé » à tort : aucune donnée arrivée au widget, stockage illisible, lecture non jouée, page non chargée", () => {
  assert.equal(e23(jouer(obs({ canariRecu: false }))).resultat, 'non_teste', "sans donnée reçue, une conservation ne pouvait pas se produire");
  const illisible = { erreur: 'SecurityError' };
  assert.equal(e23(jouer(obs({ stockage: stockage({ local: illisible, session: illisible, indexedDB: { indisponible: true } }) }))).resultat, 'non_teste');
  assert.equal(e23(jouer(obs({ stockage: null }))).resultat, 'non_teste');
  assert.equal(e23(jouer(obs({ stockage: { erreur: 'cadre fermé' } }))).resultat, 'non_teste');
  assert.equal(e23(jouer(obs({ charge: false, erreur: 'pas de cadre' }))).resultat, 'non_teste');
  assert.equal(e23(evaluerEssais({ none: obs({ canariRecu: false }), demande: null }, jeu)), undefined, "sans passe au niveau demandé : pas d'essai");
  // des données retrouvées dans le stockage restent un fait, même si la lecture d'un autre lieu a échoué
  const partiel = jouer(obs({ stockage: stockage({ local: { ...vide, nombre: 1, canari: true }, session: { erreur: 'SecurityError' } }) }));
  assert.equal(e23(partiel).resultat, 'reussi');
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : un widget qui met ses lignes en cache dans localStorage est signalé (cookie nommé) ; un widget qui n'écrit rien n'est pas signalé", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const garde = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-stockage')), {});
  assert.equal(garde.nonExecute, undefined, garde.resume.cause);
  const e = garde.resume.essais.find((x) => x.id === 23);
  assert.equal(e.resultat, 'reussi', e.detail);
  assert.ok(e.gardes.includes('localStorage'), e.detail);
  const c = garde.constats.find((x) => x.regle === 'D-REEL-23');
  assert.ok(c && c.severite === 'mineur' && !c.bloquant);
  assert.match(c.constat, /dernier-contact/);

  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  const s = sain.resume.essais.find((x) => x.id === 23);
  assert.equal(s.resultat, 'rien_observe', s.detail);
  assert.equal(sain.constats.filter((x) => x.regle === 'D-REEL-23').length, 0);
});
