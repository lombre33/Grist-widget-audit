// Essai 24 : le widget écrit-il dans le document dès son chargement, sans que personne n'ait rien fait ? Le journal des appels à Grist le dit (appels
// `applyUserActions` acceptés). Les observations sont fabriquées ; le test de bout en bout, qui lance un vrai Grist Desktop, est joué à la demande :
// GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { construireJeu } from '../src/runtime/grist-reel/donnees.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = construireJeu(undefined, 'cafe0024');
const appel = (interf, methode, issue = 'accepte', args = '[]') => ({ interface: interf, methode, issue, args });
const lecture = appel('GristView', 'fetchSelectedTable', 'accepte', '[{"format":"rows"}]');
const ecriture = (issue = 'accepte', args = '[[["BulkUpdateRecord","Contacts",[1],{"Nom":["Alice "]}]],{}]') => appel('GristDocAPI', 'applyUserActions', issue, args);
const obs = (appelsRpc, extra = {}) => ({ charge: true, canariRecu: true, appelsRpc, configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, erreur: null, ...extra });
const jouer = (o) => evaluerEssais({ none: obs([lecture], { canariRecu: false }), demande: { niveau: 'full', obs: o } }, jeu);
const e24 = (r) => r.essais.find((e) => e.id === 24);

test("essai 24 : un appel applyUserActions accepté pendant le chargement = information sans pénalité, avec le nombre d'appels et les actions", () => {
  const r = jouer(obs([lecture, ecriture(), ecriture()]));
  assert.equal(e24(r).resultat, 'reussi');
  assert.equal(e24(r).severite, 'info');
  assert.equal(e24(r).appels, 2);
  assert.deepEqual(e24(r).actions, ['BulkUpdateRecord']);
  const c = r.constats.find((x) => x.regle === 'D-REEL-24');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false);
  assert.match(verdictEssai(e24(r)).precision, /comportement du widget/);
  assert.equal(verdictEssai(e24(r)).cle, 'a_savoir');
});

test("essai 24 : sans écriture = rien observé ; une écriture refusée par Grist n'a rien changé et ne fait pas de constat (elle est dite dans le détail)", () => {
  const rien = jouer(obs([lecture]));
  assert.equal(e24(rien).resultat, 'rien_observe');
  assert.equal(rien.constats.filter((x) => x.regle === 'D-REEL-24').length, 0);
  assert.equal(verdictEssai(e24(rien)).cle, 'bien');
  const refus = jouer(obs([lecture, ecriture('refuse')]));
  assert.equal(e24(refus).resultat, 'rien_observe');
  assert.match(e24(refus).detail, /1 tentative\(s\) d'écriture refusée\(s\)/);
  const autre = jouer(obs([lecture, appel('GristDocAPI', 'getAccessToken'), appel('CustomSectionAPI', 'configure')]));
  assert.equal(e24(autre).resultat, 'rien_observe', "une autre méthode du document n'est pas une écriture");
});

test("essai 24 : jamais « rien observé » à tort : aucun échange avec Grist, page non chargée, pas de passe au niveau demandé", () => {
  assert.equal(e24(jouer(obs([]))).resultat, 'non_teste');
  assert.equal(e24(jouer(obs([lecture], { charge: false, erreur: 'pas de cadre' }))).resultat, 'non_teste');
  assert.equal(e24(evaluerEssais({ none: obs([lecture], { canariRecu: false }), demande: null }, jeu)), undefined);
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : un widget qui met une cellule à jour au chargement est signalé ; un widget qui ne fait que lire ne l'est pas", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const ecrit = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-ecrit')), {});
  assert.equal(ecrit.nonExecute, undefined, ecrit.resume.cause);
  const e = ecrit.resume.essais.find((x) => x.id === 24);
  assert.equal(e.resultat, 'reussi', e.detail);
  assert.ok(e.actions.some((a) => /Update/.test(a)), e.detail);
  assert.ok(ecrit.constats.some((c) => c.regle === 'D-REEL-24' && c.severite === 'info'));

  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  assert.equal(sain.resume.essais.find((x) => x.id === 24).resultat, 'rien_observe');
  assert.equal(sain.constats.filter((c) => c.regle === 'D-REEL-24').length, 0);
});
