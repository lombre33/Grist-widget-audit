// Essai 20 : du code dans le cadre du widget (origine différente de celle de Grist) peut-il lire le document par l'API REST de l'instance AVEC la
// session de la personne, sans passer par le niveau d'accès du widget ? Le même appel fait depuis la page Grist sert de témoin. Les observations sont
// fabriquées ; le test de bout en bout, qui lance un vrai Grist Desktop, est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = { prefixe: 'GWC-x-', graine: 'x', valeursCherchees: [] };
const obs = (extra = {}) => ({ charge: true, canariRecu: true, appelsRpc: [{}], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, canaux: null, apiInstance: null, erreur: null, ...extra });
const lu = { statut: 200, canari: true };
const bloque = { erreur: 'Failed to fetch' };
const temoin = { records: lu, sql: lu, violations: [] };
const passe = (api) => evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'none', obs: obs() }, canaux: { niveau: 'none', obs: obs({ apiInstance: api }) } }, jeu);
const e20 = (r) => r.essais.find((e) => e.id === 20);

test("essai 20 : le navigateur arrête l'appel du widget (CORS) alors que le témoin lit le document = bloqué ; la CSP du widget qui l'arrête est nommée", () => {
  const cors = passe({ temoin, widget: { records: bloque, sql: bloque, violations: [] } });
  assert.equal(e20(cors).resultat, 'bloque');
  assert.match(e20(cors).barriere, /CORS/);
  assert.equal(cors.constats.filter((c) => c.regle === 'D-REEL-20').length, 0);
  assert.equal(verdictEssai(e20(cors)).cle, 'bien');

  const csp = passe({ temoin, widget: { records: bloque, sql: bloque, violations: ['connect-src'] } });
  assert.equal(e20(csp).resultat, 'bloque');
  assert.match(e20(csp).barriere, /CSP/);

  const anonyme = passe({ temoin, widget: { records: { statut: 403, canari: false }, sql: { statut: 401, canari: false }, violations: [] } });
  assert.equal(e20(anonyme).resultat, 'bloque', "une réponse sans les données (accès refusé) est aussi une barrière");
});

test("essai 20 : le widget lit le document avec la session = information « défaut de Grist, pas du widget », sans pénalité", () => {
  const r = passe({ temoin, widget: { records: lu, sql: bloque, violations: [] } });
  assert.equal(e20(r).resultat, 'reussi');
  assert.equal(e20(r).severite, 'info');
  const c = r.constats.find((x) => x.regle === 'D-REEL-20');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false); assert.equal(c.confiance, 'prouve');
  assert.match(verdictEssai(e20(r)).precision, /défaut de Grist/);
});

test("essai 20 : jamais « bloqué » à tort : le témoin ne lit pas non plus, kits non joués, page non chargée", () => {
  const sansTemoin = passe({ temoin: { records: { statut: 401, canari: false }, sql: bloque, violations: [] }, widget: { records: bloque, sql: bloque, violations: [] } });
  assert.equal(e20(sansTemoin).resultat, 'non_teste', "si la page Grist ne lit pas le document, l'échec du widget ne prouve rien");
  assert.match(e20(sansTemoin).detail, /témoin/);
  assert.equal(e20(passe(null)).resultat, 'non_teste');
  assert.equal(e20(passe({ temoin, widget: { erreur: 'cadre fermé' } })).resultat, 'non_teste');
  assert.equal(e20(passe({ widget: { records: bloque, sql: bloque, violations: [] }, temoin: { erreur: 'page fermée' } })).resultat, 'non_teste');
  assert.equal(e20(evaluerEssais({ none: obs({ canariRecu: false }), demande: null }, jeu)), undefined, "pas de passe : pas d'essai");
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : depuis le widget, l'API de l'instance n'est pas lisible avec la session (CORS) ; avec une CSP stricte, c'est la CSP qui arrête", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  const e = sain.resume.essais.find((x) => x.id === 20);
  assert.equal(e.resultat, 'bloque', e.detail);
  assert.match(e.barriere, /CORS/);
  assert.equal(sain.constats.filter((c) => c.regle === 'D-REEL-20').length, 0);

  const csp = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-csp')), {});
  assert.equal(csp.nonExecute, undefined, csp.resume.cause);
  const f = csp.resume.essais.find((x) => x.id === 20);
  assert.equal(f.resultat, 'bloque', f.detail);
  assert.match(f.barriere, /CSP/);
});
