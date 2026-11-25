// Essai 14 : une pièce jointe HTML du document, servie par l'instance, s'exécute-t-elle sur l'origine de Grist ? Mesure de Grist, pas du widget : information
// sans pénalité. Les observations sont fabriquées ; le test de bout en bout, qui lance un vrai Grist Desktop, est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { construireJeu } from '../src/runtime/grist-reel/donnees.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';
import { PAGE_PIEGE_PIECE_JOINTE } from '../src/runtime/grist-reel/navigateur.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = construireJeu(undefined, 'cafe0014');
const GRIST = 'http://localhost:8484';
const obsPage = { charge: true, canariRecu: false, appelsRpc: [], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, erreur: null, entetesPage: null };
const piece = (extra) => ({ origineGrist: GRIST, statut: 200, entetes: {}, telechargement: false, executeDans: null, affichee: false, erreur: null, ...extra });
const jouer = (pieceJointe) => evaluerEssais({ none: obsPage, demande: null, pieceJointe }, jeu);
const e14 = (r) => r.essais.find((e) => e.id === 14);

test("essai 14 : la charge s'exécute sur l'origine de Grist = information sans pénalité (défaut de Grist), avec les en-têtes reçus", () => {
  const r = jouer(piece({ affichee: true, executeDans: GRIST, entetes: { 'content-type': 'text/html' } }));
  assert.equal(e14(r).resultat, 'reussi');
  assert.equal(e14(r).severite, 'info');
  const c = r.constats.find((x) => x.regle === 'D-REEL-14');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false);
  assert.equal(verdictEssai(e14(r)).cle, 'a_savoir');
  assert.match(verdictEssai(e14(r)).precision, /défaut de Grist/);
});

test("essai 14 : téléchargement forcé, origine isolée ou politique sandbox = bloqué par Grist, sans constat", () => {
  const dl = jouer(piece({ telechargement: true, entetes: { 'content-disposition': 'attachment; filename="gwaudit-piege.html"', 'content-security-policy': "sandbox; default-src 'none'" } }));
  assert.equal(e14(dl).resultat, 'bloque');
  assert.match(e14(dl).detail, /Content-Disposition: attachment/);
  assert.equal(dl.constats.filter((x) => x.regle === 'D-REEL-14').length, 0);
  assert.equal(verdictEssai(e14(dl)).cle, 'bien');
  const isole = jouer(piece({ affichee: true, executeDans: 'null', entetes: { 'content-security-policy': 'sandbox allow-scripts' } }));
  assert.equal(e14(isole).resultat, 'bloque');
  assert.equal(isole.constats.length, 0);
  const sandbox = jouer(piece({ affichee: true, entetes: { 'content-security-policy': 'sandbox' } }));
  assert.equal(e14(sandbox).resultat, 'bloque');
});

test("essai 14 : jamais « bloqué » ni « rien observé » à tort : dépôt refusé, réponse qui n'est pas un 200, rien ni téléchargé ni affiché, affichée sans sandbox", () => {
  assert.equal(e14(jouer({ depotImpossible: 'refusé' })).resultat, 'non_teste');
  assert.equal(e14(jouer(piece({ statut: 403 }))).resultat, 'non_teste');
  assert.equal(e14(jouer(piece({ statut: null, erreur: 'connexion refusée' }))).resultat, 'non_teste');
  assert.equal(e14(jouer(piece({}))).resultat, 'non_teste');
  const nue = jouer(piece({ affichee: true }));
  assert.equal(e14(nue).resultat, 'rien_observe');
  assert.equal(nue.constats.length, 0);
  assert.equal(e14(evaluerEssais({ none: obsPage, demande: null }, jeu)), undefined);
});

test("essai 14 : une origine d'exécution qui n'est pas celle de Grist ne fait jamais de constat", () => {
  const r = jouer(piece({ affichee: true, executeDans: 'http://127.0.0.1:9999' }));
  assert.equal(e14(r).resultat, 'bloque');
  assert.equal(r.constats.filter((x) => x.regle === 'D-REEL-14').length, 0);
});

test("la charge d'essai ne fait que noter l'origine où elle s'exécute", () => {
  assert.match(PAGE_PIEGE_PIECE_JOINTE, /window\.__gw_exec = location\.origin/);
  assert.doesNotMatch(PAGE_PIEGE_PIECE_JOINTE, /fetch|XMLHttpRequest|document\.cookie|localStorage|src=|href=/);
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : Grist Desktop sert la pièce jointe HTML en téléchargement, l'essai le dit sans constat", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  const e = sain.resume.essais.find((x) => x.id === 14);
  assert.equal(e.resultat, 'bloque', e.detail);
  assert.equal(sain.constats.filter((c) => c.regle === 'D-REEL-14').length, 0);
});
