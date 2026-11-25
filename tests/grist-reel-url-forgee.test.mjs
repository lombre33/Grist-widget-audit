// Essai 5 : le widget règle-t-il sa conduite sur ce que son adresse affirme (access=full) plutôt que sur ce que Grist lui accorde ? Ses appels à Grist,
// avec l'adresse forgée, sont comparés à ceux de la passe normale du même niveau. Les observations sont fabriquées ; le test de bout en bout, qui lance un
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
const jeu = construireJeu(undefined, 'cafe0005');
const appel = (interf, methode, issue = 'accepte', args = '[]') => ({ interface: interf, methode, issue, args });
const lecture = appel('GristView', 'fetchSelectedTable', 'accepte', '[{"format":"rows"}]');
const ecriture = (issue = 'refuse') => appel('GristDocAPI', 'applyUserActions', issue, '[[["BulkUpdateRecord","Contacts",[1],{"Nom":["Alice "]}]],{}]');
const obs = (appelsRpc, acces = 'read table', extra = {}) => ({ charge: true, canariRecu: true, appelsRpc, configure: acces ? { requiredAccess: acces } : null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, erreur: null, ...extra });
const jouer = (forgee, reference = [obs([lecture])], niveau = 'read table') => evaluerEssais({ none: obs([lecture], 'none', { canariRecu: false }), demande: { niveau, obs: reference[0] }, forgee: { niveau, reference, obs: forgee } }, jeu);
const e5 = (r) => r.essais.find((e) => e.id === 5);

test("essai 5 : une écriture tentée seulement avec l'adresse forgée = information sans pénalité (comportement du widget)", () => {
  const r = jouer(obs([lecture, ecriture()]));
  assert.equal(e5(r).resultat, 'reussi');
  assert.equal(e5(r).severite, 'info');
  assert.equal(e5(r).nature, 'comportement');
  assert.match(e5(r).detail, /tente d'écrire dans le document \(1 appel\(s\) applyUserActions, refusés par Grist\)/);
  const c = r.constats.find((x) => x.regle === 'D-REEL-05');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false);
  assert.equal(verdictEssai(e5(r)).cle, 'a_savoir');
  assert.match(verdictEssai(e5(r)).precision, /comportement du widget/);
});

test("essai 5 : un accès demandé différent avec l'adresse forgée = constat ; le même accès = rien", () => {
  const change = jouer(obs([lecture], 'full'));
  assert.equal(e5(change).resultat, 'reussi');
  assert.match(e5(change).detail, /il demande l'accès « full » \(au lieu de « read table »\)/);
  const pareil = jouer(obs([lecture]));
  assert.equal(e5(pareil).resultat, 'rien_observe');
  assert.equal(pareil.constats.filter((x) => x.regle === 'D-REEL-05').length, 0);
  assert.equal(verdictEssai(e5(pareil)).cle, 'bien');
});

test("essai 5 : jamais de constat sur une écriture déjà faite avec l'adresse normale, ni sur un simple appel de plus", () => {
  const dejaEcrit = jouer(obs([lecture, ecriture()]), [obs([lecture, ecriture()])]);
  assert.equal(e5(dejaEcrit).resultat, 'rien_observe');
  assert.equal(dejaEcrit.constats.filter((x) => x.regle === 'D-REEL-05').length, 0);
  const autre = jouer(obs([lecture, appel('GristDocAPI', 'getAccessToken')]));
  assert.equal(e5(autre).resultat, 'rien_observe');
  assert.match(e5(autre).detail, /GristDocAPI\.getAccessToken/);
  assert.equal(autre.constats.filter((x) => x.regle === 'D-REEL-05').length, 0);
  // Une référence où l'accès n'est pas déclaré ne prouve pas qu'il ait changé.
  const sansDeclaration = jouer(obs([lecture], 'full'), [obs([lecture], null)]);
  assert.equal(e5(sansDeclaration).resultat, 'rien_observe');
});

test("essai 5 : une écriture présente dans l'une des passes normales (deux références) n'est pas imputée à l'adresse", () => {
  const r = jouer(obs([lecture, ecriture()]), [obs([lecture]), obs([lecture, ecriture()])]);
  assert.equal(e5(r).resultat, 'rien_observe');
});

test("essai 5 : jamais « rien observé » à tort : rien à comparer, page non chargée, niveau full, passe absente", () => {
  assert.equal(e5(jouer(obs([]))).resultat, 'non_teste');
  assert.equal(e5(jouer(obs([lecture], 'read table', { charge: false, erreur: 'pas de cadre' }))).resultat, 'non_teste');
  assert.equal(e5(jouer(obs([lecture]), [obs([])])).resultat, 'non_teste');
  const full = evaluerEssais({ none: obs([lecture], 'none', { canariRecu: false }), demande: { niveau: 'full', obs: obs([lecture], 'full') }, forgee: { niveau: 'full', sansObjet: true } }, jeu);
  assert.equal(e5(full).resultat, 'non_teste');
  assert.match(e5(full).detail, /la même chose que Grist/);
  assert.equal(e5(evaluerEssais({ none: obs([lecture], 'none', { canariRecu: false }), demande: { niveau: 'read table', obs: obs([lecture]) } }, jeu)), undefined);
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : un widget qui se règle sur `access` de son adresse est signalé ; un widget qui l'ignore ne l'est pas", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const url = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-url')), {});
  assert.equal(url.nonExecute, undefined, url.resume.cause);
  const e = url.resume.essais.find((x) => x.id === 5);
  assert.equal(e.resultat, 'reussi', e.detail);
  assert.ok(url.constats.some((c) => c.regle === 'D-REEL-05' && c.severite === 'info'));

  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  assert.equal(sain.resume.essais.find((x) => x.id === 5).resultat, 'rien_observe', sain.resume.essais.find((x) => x.id === 5).detail);
  assert.equal(sain.constats.filter((c) => c.regle === 'D-REEL-05').length, 0);
});
