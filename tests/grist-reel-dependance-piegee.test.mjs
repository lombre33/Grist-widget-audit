// Essais 8, 9 et 12 (« dépendance piégée ») : du code étranger joué DANS le cadre du widget montre ce que le niveau d'accès réellement
// accordé lui permettrait. Les observations sont fabriquées (le vrai Grist n'est pas lancé) ; le test de bout en bout, qui lance un vrai
// Grist Desktop, est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { construireEnvironnement } from '../src/runtime/grist-reel/instance.js';
import { construireJeu } from '../src/runtime/grist-reel/donnees.js';
import { verdictEssai, htmlGristReel } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = construireJeu(undefined, 'cafe0002');
const par = (r, id) => r.essais.find((e) => e.id === id);
const refus = { ok: false, erreur: 'Access not granted. Current access level read table' };
const lecture = { ok: true, colonnes: 3, lignes: 2, canari: true };

const obs = (kit, o = {}) => ({
  charge: true, appelsRpc: [{ interface: 'CustomSectionAPI', methode: 'configure', issue: 'accepte' }], configure: null, canariRecu: true, texteDuCadre: '',
  xss: { executions: 0, lu: null, refus: null, erreur: null }, requetesExternes: [], apiSubstituee: [], navigations: [], navigationsRefusees: [],
  popups: [], dialogues: [], telechargements: [], consoles: [], erreursPage: [], erreur: null, dependancesNonResolues: [], kit, ...o,
});
const kitFull = (o = {}) => ({
  grist: true, violations: [], tables: { ok: true, nombre: 3 }, appat: lecture,
  systeme: { _grist_Tables_column: lecture, _grist_ACLRules: lecture, _grist_Views_section: lecture },
  jetonLecture: { ok: true, dureeMs: 900000 }, jetonEcriture: { ok: true, dureeMs: 900000 },
  tablesRest: { ok: true, statut: 200, erreurGrist: null, cite: true }, sql: { ok: true, statut: 200, erreurGrist: null, cite: true },
  autreDoc: { ok: true, statut: 403, erreurGrist: 'Document access denied', canari: false },
  webhook: { ok: true, statut: 403, erreurGrist: 'Provided url is forbidden', cree: false },
  ...o,
});
const kitRead = () => ({
  grist: true, violations: [], tables: refus, appat: refus, systeme: { _grist_Tables_column: refus, _grist_ACLRules: refus, _grist_Views_section: refus },
  jetonLecture: refus, jetonEcriture: refus,
});
const jouer = (kit, niveau = 'full') => evaluerEssais({ none: obs(null, { canariRecu: false }), demande: { niveau, obs: obs(kit) } }, jeu);

test('essais 8, 9, 12 à « full » : lecture de tout le document et jeton d\'accès = informations sans pénalité ; webhook refusé par Grist = bloqué', () => {
  const r = jouer(kitFull());
  assert.equal(par(r, 8).resultat, 'reussi');
  assert.equal(par(r, 8).severite, 'info');
  assert.equal(par(r, 9).resultat, 'reussi');
  assert.equal(par(r, 9).autreDocumentFerme, true, 'le jeton ne rouvre pas un autre document');
  assert.equal(par(r, 12).resultat, 'bloque');
  assert.match(par(r, 12).barriere, /réglage par défaut de Grist/);
  const regles = r.constats.map((c) => c.regle).sort();
  assert.deepEqual(regles, ['D-REEL-08', 'D-REEL-09']);
  for (const c of r.constats) { assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false); }
  // Le verdict dit ce que c'est : une mesure du risque, pas un défaut de Grist ni du widget.
  const v = verdictEssai(par(r, 8));
  assert.equal(v.cle, 'a_savoir');
  assert.match(v.precision, /dépendance piégée/);
});

test('essais 8, 9, 12 à « read table » : Grist refuse tout, donc « bloqué » avec la barrière nommée, et aucun constat', () => {
  const r = jouer(kitRead(), 'read table');
  for (const id of [8, 9, 12]) assert.equal(par(r, id).resultat, 'bloque', `essai ${id}`);
  assert.match(par(r, 8).barriere, /Grist/);
  assert.equal(r.constats.filter((c) => /^D-REEL-(08|09|12)$/.test(c.regle)).length, 0);
  assert.equal(verdictEssai(par(r, 9)).cle, 'bien');
});

test("essais 8, 9, 12 : sans cadre exploitable (API Grist absente, kit non joué, page non chargée) c'est « non testé » avec la raison, jamais « bloqué » ni « rien trouvé »", () => {
  for (const [kit, raison] of [[{ grist: false, violations: [] }, /n'expose pas l'API Grist/], [null, /n'a pas pu être joué/], [{ erreur: 'cadre fermé' }, /cadre fermé/]]) {
    const r = jouer(kit);
    for (const id of [8, 9, 12]) { assert.equal(par(r, id).resultat, 'non_teste', `essai ${id}`); assert.match(par(r, id).detail, raison); }
  }
  const sans = evaluerEssais({ none: obs(null, { charge: false, erreur: 'pas de cadre' }), demande: null }, jeu);
  for (const id of [8, 9, 12]) assert.equal(par(sans, id).resultat, 'non_teste');
});

test("essai 9 : un jeton utilisable sur un autre document est dit défaut de Grist ; une CSP qui coupe l'appel direct arrête l'essai ; un webhook créé est un constat majeur", () => {
  const autre = jouer(kitFull({ autreDoc: { ok: true, statut: 200, erreurGrist: null, canari: true } }));
  assert.equal(par(autre, 9).resultat, 'reussi');
  assert.equal(verdictEssai(par(autre, 9)).precision, 'défaut de Grist, pas du widget');
  assert.equal(autre.constats.find((c) => c.regle === 'D-REEL-09').severite, 'info');

  const csp = jouer(kitFull({ violations: ["connect-src http://localhost:1/"], tablesRest: { ok: false, erreur: 'Failed to fetch' }, sql: { ok: false, erreur: 'Failed to fetch' }, autreDoc: undefined }));
  assert.equal(par(csp, 9).resultat, 'bloque');
  assert.match(par(csp, 9).barriere, /CSP/);

  const cree = jouer(kitFull({ webhook: { ok: true, statut: 200, erreurGrist: null, cree: true, listeContientLeWebhook: true } }));
  assert.equal(par(cree, 12).resultat, 'reussi');
  const c = cree.constats.find((x) => x.regle === 'D-REEL-12');
  assert.equal(c.severite, 'majeur'); assert.equal(c.bloquant, false);
  assert.equal(verdictEssai(par(cree, 12)).cle, 'pas_bien');
});

test("rapport et instance : le texte « en clair » des essais 8, 9, 12 est affiché ; l'instance jetable ignore la configuration des webhooks de la machine", () => {
  const r = jouer(kitFull());
  const html = htmlGristReel({ execute: true, produit: 'Grist Desktop', version: '0.3.17', plateforme: 'linux-x64', date: '2026-11-25T09:00:00Z', phases: [{ niveau: 'none' }, { niveau: 'full' }], essaisPasEncore: '2 à 6, 10, 11, 14, 17 à 20', essais: r.essais, bibliotheques: null });
  assert.match(html, /dépendance piégée/i);
  assert.match(html, /Avec le niveau « full », du code étranger/);
  assert.match(html, /réglage par défaut de Grist/);
  const env = construireEnvironnement('/tmp/profil', 4000, { ALLOWED_WEBHOOK_DOMAINS: '*', GRIST_PROXY_FOR_UNTRUSTED_URLS: 'http://x', PATH: '/usr/bin' });
  assert.equal(env.ALLOWED_WEBHOOK_DOMAINS, undefined);
  assert.equal(env.GRIST_PROXY_FOR_UNTRUSTED_URLS, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test('bout en bout : à « full » du code étranger lit tout le document et obtient un jeton (un autre document reste fermé) ; à « read table » Grist refuse tout', { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 360_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');

  const full = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-full')), {});
  assert.equal(full.nonExecute, undefined, full.resume.cause);
  const e = (id) => full.resume.essais.find((x) => x.id === id);
  assert.equal(e(8).resultat, 'reussi', e(8).detail);
  assert.equal(e(9).resultat, 'reussi', e(9).detail);
  assert.equal(e(9).autreDocumentFerme, true, "le jeton n'a pas ouvert l'autre document de l'instance");
  assert.equal(e(12).resultat, 'bloque', e(12).detail);
  assert.deepEqual(full.constats.map((c) => c.regle).sort(), ['D-REEL-08', 'D-REEL-09', 'D-REEL-10', 'D-REEL-17', 'D-REEL-19', 'D-REEL-22']);
  assert.ok(full.constats.every((c) => c.severite === 'info'), 'rien de ce qui précède ne pèse sur la note');

  const lecture = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(lecture.nonExecute, undefined, lecture.resume.cause);
  for (const id of [8, 9, 12]) assert.equal(lecture.resume.essais.find((x) => x.id === id).resultat, 'bloque', `essai ${id}`);
  assert.deepEqual(lecture.constats.map((c) => c.regle).sort(), ['D-REEL-17', 'D-REEL-19', 'D-REEL-22'], 'seules informations : presse-papier (droit donné par Grist à tous les widgets) et voies de sortie ouvertes (widget de test sans CSP)');
});
