// Essais 17 et 18 : les droits du navigateur que Grist donne au cadre du widget. L'essai 17 va jusqu'au bout pour le presse-papier (clic réel de l'audit,
// écriture par le cadre, relecture depuis la page Grist) ; l'essai 18 lit la politique d'autorisations appliquée au cadre. Les observations sont
// fabriquées ; le test de bout en bout, qui lance un vrai Grist Desktop, est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = { prefixe: 'GWC-x-', valeursCherchees: [] };
const obs = (extra = {}) => ({ charge: true, canariRecu: true, appelsRpc: [{}], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, canaux: null, droits: null, erreur: null, ...extra });
const SENSIBLES = ['camera', 'microphone', 'geolocation', 'display-capture', 'fullscreen', 'payment', 'usb', 'serial', 'hid', 'bluetooth', 'midi', 'clipboard-read', 'web-share', 'publickey-credentials-get', 'otp-credentials', 'identity-credentials-get', 'screen-wake-lock', 'accelerometer', 'gyroscope', 'magnetometer', 'window-management', 'local-fonts'];
const CONNUES = [...SENSIBLES, 'clipboard-write', 'sync-xhr', 'unload', 'gamepad'];
const POLITIQUE_GRIST = ['clipboard-write', 'gamepad', 'sync-xhr', 'unload'];
const droits = (o = {}, cadre = {}) => ({
  attributs: { allow: 'clipboard-write', sandbox: null }, pagePosee: true, pageRelit: true, clic: true, relu: 'attendu',
  cadre: { activation: true, politique: POLITIQUE_GRIST, connues: CONNUES, ecriture: { ok: true }, ...cadre }, ...o,
});
const passe = (d, o = {}) => evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs() }, canaux: { niveau: 'read table', obs: obs({ droits: d, ...o }) } }, jeu);
const e = (r, id) => r.essais.find((x) => x.id === id);

test("essai 17 : écriture acceptée après un clic et relue depuis la page Grist = information, sans pénalité ; essai 18 : aucun autre droit sensible donné = bloqué", () => {
  const r = passe(droits());
  assert.equal(e(r, 17).resultat, 'reussi');
  assert.equal(e(r, 17).severite, 'info');
  const c = r.constats.find((x) => x.regle === 'D-REEL-17');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false);
  assert.match(c.constat, /clipboard-write/);
  assert.match(verdictEssai(e(r, 17)).precision, /dépendance piégée/);
  assert.equal(e(r, 18).resultat, 'bloque');
  assert.match(e(r, 18).barriere, /politique d'autorisations/);
  assert.equal(r.constats.filter((x) => x.regle === 'D-REEL-18').length, 0);
  assert.equal(verdictEssai(e(r, 18)).cle, 'bien');
});

test("essai 17 : Grist ne délègue pas l'écriture = bloqué ; essai 18 : un droit sensible délégué (caméra, position) = information, sans pénalité", () => {
  const refus = passe(droits({ relu: 'autre' }, { politique: ['gamepad', 'sync-xhr'], ecriture: { ok: false, erreur: "Failed to execute 'writeText' on 'Clipboard': The Clipboard API has been blocked because of a permissions policy applied to the current document." } }));
  assert.equal(e(refus, 17).resultat, 'bloque');
  assert.match(e(refus, 17).barriere, /politique d'autorisations/);
  assert.equal(refus.constats.filter((x) => x.regle === 'D-REEL-17').length, 0);

  const large = passe(droits({}, { politique: [...POLITIQUE_GRIST, 'camera', 'geolocation'] }));
  assert.equal(e(large, 18).resultat, 'reussi');
  assert.deepEqual(e(large, 18).ouverts, ['caméra', 'position']);
  const c = large.constats.find((x) => x.regle === 'D-REEL-18');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false);
});

test("essais 17 et 18 : jamais « bien » à tort : clic non reçu, presse-papier de l'audit illisible, texte non retrouvé, politique illisible, page non chargée, kit non joué", () => {
  assert.equal(e(passe(droits({ relu: 'autre' }), { ecriture: { ok: true } }), 17).resultat, 'non_teste', "écrit selon le cadre, mais non retrouvé : rien n'est prouvé");
  const sansClic = passe(droits({ relu: null, clic: true }, { activation: false, ecriture: { ok: false, erreur: 'Document is not focused.' } }));
  assert.equal(e(sansClic, 17).resultat, 'non_teste');
  assert.match(e(sansClic, 17).detail, /clic/);
  const illisible = passe(droits({ pageRelit: false, relu: null }, { ecriture: { ok: false, erreur: 'Write permission denied.' } }));
  assert.equal(e(illisible, 17).resultat, 'non_teste');
  assert.match(e(illisible, 17).detail, /presse-papier du navigateur de l'audit/);

  const sansPolitique = passe(droits({}, { politique: null, connues: null }));
  assert.equal(e(sansPolitique, 18).resultat, 'non_teste');
  const peuConnues = passe(droits({}, { connues: ['clipboard-write', 'camera'] }));
  assert.equal(e(peuConnues, 18).resultat, 'non_teste', 'un Chromium qui ne connaît presque aucun droit sensible ne prouve rien');

  for (const r of [passe(null), passe({ erreur: 'cadre fermé' }), passe(droits({}, { erreur: 'cadre fermé' })), passe(droits(), { charge: false, erreur: 'pas de cadre' })]) {
    assert.equal(e(r, 17).resultat, 'non_teste');
    assert.equal(e(r, 18).resultat, 'non_teste');
  }
  assert.equal(e(evaluerEssais({ none: obs({ canariRecu: false }), demande: null }, jeu), 17), undefined, "pas de passe : pas d'essai");
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test('bout en bout : le cadre peut écrire dans le presse-papier après un clic ; aucun autre droit sensible ne lui est donné', { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 360_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const r = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(r.nonExecute, undefined, r.resume.cause);
  const essai = (id) => r.resume.essais.find((x) => x.id === id);
  assert.equal(essai(17).resultat, 'reussi', essai(17).detail);
  assert.equal(essai(18).resultat, 'bloque', essai(18).detail);
  assert.ok(r.constats.some((c) => c.regle === 'D-REEL-17' && c.severite === 'info'));
  assert.equal(r.constats.filter((c) => c.regle === 'D-REEL-18').length, 0);
  assert.equal(essai(22).resultat, 'reussi', "le clic de l'essai 17 ne perturbe pas la passe des voies de sortie");
});
