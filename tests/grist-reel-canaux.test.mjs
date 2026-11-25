// Essai 22 : par quelles voies du navigateur du code étranger, dans le cadre du widget, pourrait envoyer ce qu'il a lu. Passe à part, vers un hôte
// factice distinct du puits : ces requêtes ne se mêlent jamais à celles du widget (essais 1 et 13). Le test de bout en bout, qui lance un vrai
// Grist Desktop, est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { HOTE_CANAUX, HOTE_PUITS } from '../src/runtime/grist-reel/donnees.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = { prefixe: 'GWC-x-', valeursCherchees: [] };
const NOMS = ['fetch', 'xhr', 'image', 'beacon', 'websocket', 'script', 'iframe', 'feuille', 'cssurl', 'prefetch', 'formulaire'];
const obs = (extra = {}) => ({ charge: true, canariRecu: true, appelsRpc: [{}], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, canaux: null, erreur: null, ...extra });
const requete = (nom) => ({ url: `https://${nom}.${HOTE_CANAUX}/c?d=GWC-x--CANAL-${nom.toUpperCase()}`, methode: 'GET', hote: `${nom}.${HOTE_CANAUX}`, type: 'fetch', provenance: 'widget', canari: `GWC-x--CANAL-${nom.toUpperCase()}` });
const violation = (nom, directive) => ({ directive, bloque: `https://${nom}.${HOTE_CANAUX}/c?d=x` });
const passe = (obsCanaux) => evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs() }, canaux: { niveau: 'read table', obs: obsCanaux } }, jeu);
const e22 = (r) => r.essais.find((e) => e.id === 22);

test("essai 22 : sans politique de sécurité toutes les voies sont ouvertes = information, sans pénalité, avec la liste des voies", () => {
  const r = passe(obs({ requetesExternes: [...NOMS.filter((n) => n !== 'websocket'), 'navigation'].map(requete), canaux: { tentatives: {}, violations: [], reseau: { websocket: 'tentative' } } }));
  assert.equal(e22(r).resultat, 'reussi');
  assert.equal(e22(r).ouverts, 11); assert.equal(e22(r).total, 11);
  assert.equal(e22(r).severite, 'info');
  assert.equal(e22(r).navigation, true);
  const c = r.constats.find((x) => x.regle === 'D-REEL-22');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false);
  // La page du widget sans CSP est une faute du widget, déjà comptée par C-CSP-01/02/03 : « Pas bien », sans pénalité de plus.
  assert.equal(verdictEssai(e22(r)).cle, 'pas_bien');
  assert.match(verdictEssai(e22(r)).precision, /déjà compté par C-CSP-01, C-CSP-02 ou C-CSP-03/);
});

test("essai 22 : une CSP stricte qui arrête toutes les voies = « bloqué » ; une WebSocket n'est ouverte que si aucune CSP ne l'arrête (jamais déduite de l'interception de Playwright)", () => {
  const toutes = NOMS.map((n) => violation(n, 'connect-src'));
  const bloque = passe(obs({ canaux: { tentatives: {}, violations: toutes, reseau: { websocket: 'tentative' } } }));
  assert.equal(e22(bloque).resultat, 'bloque');
  assert.match(e22(bloque).barriere, /CSP/);
  assert.equal(bloque.constats.filter((c) => c.regle === 'D-REEL-22').length, 0);
  assert.equal(verdictEssai(e22(bloque)).cle, 'bien');

  const unePasseLeReste = passe(obs({ requetesExternes: [requete('image')], canaux: { tentatives: {}, violations: NOMS.filter((n) => n !== 'image').map((n) => violation(n, 'connect-src')), reseau: { websocket: 'tentative' } } }));
  assert.equal(e22(unePasseLeReste).resultat, 'reussi');
  assert.equal(e22(unePasseLeReste).ouverts, 1, "seule l'image passe : la WebSocket est arrêtée par la CSP malgré sa tentative");
});

test("essai 22 : jamais « bien » à tort : voies sans observation, kit non joué, page non chargée, passe absente", () => {
  const sansObservation = passe(obs({ requetesExternes: [], canaux: { tentatives: {}, violations: [], reseau: {} } }));
  assert.equal(e22(sansObservation).resultat, 'non_teste', 'ni requête vue ni blocage signalé : la mesure ne prouve rien');
  assert.equal(e22(passe(obs({ canaux: null }))).resultat, 'non_teste');
  assert.equal(e22(passe(obs({ canaux: { erreur: 'cadre fermé' } }))).resultat, 'non_teste');
  assert.equal(e22(passe(obs({ charge: false, erreur: 'pas de cadre' }))).resultat, 'non_teste');
  assert.equal(e22(evaluerEssais({ none: obs({ canariRecu: false }), demande: null }, jeu)), undefined, "pas de passe : pas d'essai");
});

test("essai 22 : les requêtes de cette passe ne se mêlent jamais aux essais 1 et 13 (hôte distinct du puits, passe à part)", () => {
  assert.notEqual(HOTE_CANAUX, HOTE_PUITS);
  assert.ok(!HOTE_CANAUX.endsWith(HOTE_PUITS) && !HOTE_PUITS.endsWith(HOTE_CANAUX));
  const r = evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs() }, canaux: { niveau: 'read table', obs: obs({ requetesExternes: NOMS.map(requete), canaux: { tentatives: {}, violations: [], reseau: { websocket: 'tentative' } } }) } }, jeu);
  assert.equal(r.essais.find((e) => e.id === 13).resultat, 'rien_observe', "les requêtes de la passe des voies de sortie ne comptent pas comme des fuites du widget");
  assert.equal(r.essais.find((e) => e.id === 1).resultat, 'rien_observe');
  assert.deepEqual(r.constats.map((c) => c.regle), ['D-REEL-22']);
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test('bout en bout : sans politique de sécurité les 11 voies sont ouvertes ; avec une CSP stricte elles sont toutes arrêtées', { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');

  const sans = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sans.nonExecute, undefined, sans.resume.cause);
  const ouvert = sans.resume.essais.find((e) => e.id === 22);
  assert.equal(ouvert.resultat, 'reussi', ouvert.detail);
  assert.equal(ouvert.ouverts, 11, ouvert.detail);
  assert.equal(sans.resume.essais.find((e) => e.id === 13).resultat, 'rien_observe', 'les voies essayées ne sont pas prises pour des fuites du widget');
  assert.deepEqual(sans.constats.map((c) => c.regle).sort(), ['D-REEL-17', 'D-REEL-19', 'D-REEL-22']);

  const csp = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-csp')), {});
  assert.equal(csp.nonExecute, undefined, csp.resume.cause);
  const ferme = csp.resume.essais.find((e) => e.id === 22);
  assert.equal(ferme.resultat, 'bloque', ferme.detail);
  assert.equal(csp.constats.filter((c) => c.regle === 'D-REEL-22').length, 0);
});
