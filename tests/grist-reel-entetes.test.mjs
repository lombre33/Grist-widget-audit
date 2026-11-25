// Essai 19 : la page Grist qui héberge le widget pose-t-elle ses en-têtes de sécurité (CSP, protection contre l'inclusion en cadre, Referrer-Policy, nosniff) ?
// Mesure de Grist, pas du widget : information sans pénalité. Les observations sont fabriquées ; le test de bout en bout, qui lance un vrai Grist Desktop,
// est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { construireJeu } from '../src/runtime/grist-reel/donnees.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = construireJeu(undefined, 'cafe0019');
const obs = (entetesPage, extra = {}) => ({ charge: true, canariRecu: false, appelsRpc: [], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, erreur: null, entetesPage, ...extra });
const jouer = (entetes, statut = 200) => evaluerEssais({ none: obs(entetes === null ? null : { statut, entetes }), demande: null }, jeu);
const e19 = (r) => r.essais.find((e) => e.id === 19);
const COMPLETS = { 'content-security-policy': "default-src 'self'; frame-ancestors 'self'", 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff' };

test("essai 19 : une page sans aucun en-tête de sécurité = information sans pénalité, avec la liste de ce qui manque", () => {
  const r = jouer({});
  assert.equal(e19(r).resultat, 'reussi');
  assert.equal(e19(r).severite, 'info');
  assert.equal(e19(r).absents.length, 4);
  const c = r.constats.find((x) => x.regle === 'D-REEL-19');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false);
  assert.equal(verdictEssai(e19(r)).cle, 'a_savoir');
  assert.match(verdictEssai(e19(r)).precision, /défaut de Grist/);
});

test("essai 19 : tous les en-têtes mesurés présents = rien observé, sans constat ; frame-ancestors ou X-Frame-Options suffisent à la protection contre le cadre", () => {
  const complet = jouer(COMPLETS);
  assert.equal(e19(complet).resultat, 'rien_observe');
  assert.equal(complet.constats.filter((x) => x.regle === 'D-REEL-19').length, 0);
  assert.equal(verdictEssai(e19(complet)).cle, 'bien');
  const xfo = jouer({ ...COMPLETS, 'content-security-policy': "default-src 'self'", 'x-frame-options': 'SAMEORIGIN' });
  assert.equal(e19(xfo).resultat, 'rien_observe');
  const sansCadre = jouer({ ...COMPLETS, 'content-security-policy': "default-src 'self'" });
  assert.equal(e19(sansCadre).resultat, 'reussi');
  assert.equal(e19(sansCadre).absents.length, 1);
  assert.match(e19(sansCadre).absents[0], /inclusion de la page dans un cadre/);
});

test("essai 19 : un en-tête X-Content-Type-Options autre que nosniff ne compte pas", () => {
  const r = jouer({ ...COMPLETS, 'x-content-type-options': 'autre' });
  assert.equal(e19(r).resultat, 'reussi');
  assert.deepEqual(e19(r).absents, ['X-Content-Type-Options: nosniff']);
});

test("essai 19 : jamais « rien observé » à tort : en-têtes non lus, réponse qui n'est pas un 200, page non chargée", () => {
  assert.equal(e19(jouer(null)).resultat, 'non_teste');
  assert.equal(e19(jouer(COMPLETS, 302)).resultat, 'non_teste');
  const nonChargee = evaluerEssais({ none: obs(null, { charge: false, erreur: 'pas de cadre' }), demande: null }, jeu);
  assert.equal(e19(nonChargee).resultat, 'non_teste');
});

test("essai 19 : une bibliothèque du widget non chargée ne rend pas l'essai « non testé » (aucun code du widget n'entre dans la réponse de la page)", () => {
  const r = evaluerEssais({ none: obs({ statut: 200, entetes: COMPLETS }, { dependancesNonResolues: [{ url: 'https://cdn.exemple/x.js', hote: 'cdn.exemple' }] }), demande: null }, jeu);
  assert.equal(e19(r).resultat, 'rien_observe');
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : les en-têtes de la page du document sont lus sur le vrai Grist ; un constat n'existe que si l'essai en voit un manquant", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  const e = sain.resume.essais.find((x) => x.id === 19);
  assert.ok(['reussi', 'rien_observe'].includes(e.resultat), `l'essai doit avoir été joué : ${e.resultat} ${e.detail}`);
  assert.equal(sain.constats.some((c) => c.regle === 'D-REEL-19'), e.resultat === 'reussi');
  assert.ok(sain.constats.filter((c) => c.regle === 'D-REEL-19').every((c) => c.severite === 'info' && !c.bloquant));
});
