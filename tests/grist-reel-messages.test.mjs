// Essai 4 : un cadre voisin sans aucun droit (autre widget de la même page, page qui encadrerait le widget) envoie au widget des messages
// `postMessage` forgés, à l'origine « null » : le widget les prend-il pour des ordres ? Les observations sont fabriquées ; le test de bout en bout, qui
// lance un vrai Grist Desktop, est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { HOTE_MESSAGES, HOTE_CANAUX, HOTE_PUITS } from '../src/runtime/grist-reel/donnees.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = { prefixe: 'GWC-x-', graine: 'x', valeursCherchees: [] };
const obs = (extra = {}) => ({ charge: true, canariRecu: true, appelsRpc: [{}], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, canaux: null, messages: null, erreur: null, ...extra });
const messages = (extra = {}) => ({ envoye: true, retour: 'gw-envoye', formes: 4, executions: 0, forgeRecu: 4, requetes: 0, ...extra });
const passe = (o) => evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs() }, canaux: { niveau: 'read table', obs: o } }, jeu);
const e4 = (r) => r.essais.find((e) => e.id === 4);

test("essai 4 : une charge exécutée ou une adresse appelée à cause d'un message forgé = constat majeur non bloquant ; messages reçus sans effet = rien observé", () => {
  const xss = passe(obs({ messages: messages({ executions: 2 }) }));
  assert.equal(e4(xss).resultat, 'reussi');
  assert.equal(e4(xss).severite, 'majeur');
  const c = xss.constats.find((x) => x.regle === 'D-REEL-04');
  assert.equal(c.severite, 'majeur'); assert.equal(c.bloquant, false); assert.equal(c.confiance, 'prouve');
  assert.equal(verdictEssai(e4(xss)).cle, 'pas_bien');

  const url = passe(obs({ messages: messages({ requetes: 1 }) }));
  assert.equal(e4(url).resultat, 'reussi');
  assert.match(e4(url).detail, /adresse donnée par un message/);

  const rien = passe(obs({ messages: messages() }));
  assert.equal(e4(rien).resultat, 'rien_observe');
  assert.equal(rien.constats.filter((x) => x.regle === 'D-REEL-04').length, 0);
  assert.equal(verdictEssai(e4(rien)).cle, 'bien');
});

test("essai 4 : jamais « rien observé » à tort : messages non arrivés dans le cadre, cadre illisible, envoi impossible, page non chargée", () => {
  assert.equal(e4(passe(obs({ messages: messages({ forgeRecu: 0 }) }))).resultat, 'non_teste', "aucun message d'origine null vu dans le cadre : rien n'est prouvé");
  assert.equal(e4(passe(obs({ messages: { envoye: true, formes: 4, cadreIllisible: true, requetes: 0 } }))).resultat, 'non_teste');
  assert.equal(e4(passe(obs({ messages: null }))).resultat, 'non_teste');
  assert.equal(e4(passe(obs({ messages: { erreur: 'cadre du widget introuvable dans la page' } }))).resultat, 'non_teste');
  assert.equal(e4(passe(obs({ charge: false, erreur: 'pas de cadre' }))).resultat, 'non_teste');
  assert.equal(e4(evaluerEssais({ none: obs({ canariRecu: false }), demande: null }, jeu)), undefined, "pas de passe : pas d'essai");
  // un effet observé reste vrai même si le cadre n'a pas pu être relu après (le widget a pu naviguer en obéissant) : la requête a été vue
  assert.equal(e4(passe(obs({ messages: { envoye: true, formes: 4, cadreIllisible: true, requetes: 2 } }))).resultat, 'reussi');
});

test("essai 4 : l'hôte des messages forgés est distinct du puits et de l'hôte des voies de sortie (aucune requête ne se mêle aux essais 1, 13 et 22)", () => {
  for (const autre of [HOTE_PUITS, HOTE_CANAUX]) assert.ok(!HOTE_MESSAGES.endsWith(autre) && !autre.endsWith(HOTE_MESSAGES));
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : un widget qui écrit le HTML reçu par message et appelle l'adresse reçue est signalé ; un widget sain ne l'est pas", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const naif = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-message')), {});
  assert.equal(naif.nonExecute, undefined, naif.resume.cause);
  const e = naif.resume.essais.find((x) => x.id === 4);
  assert.equal(e.resultat, 'reussi', e.detail);
  assert.ok(e.executions > 0 && e.requetes > 0, e.detail);
  assert.ok(naif.constats.some((c) => c.regle === 'D-REEL-04' && c.severite === 'majeur' && !c.bloquant));
  assert.equal(naif.resume.essais.find((x) => x.id === 13).resultat, 'rien_observe', "les requêtes des messages forgés ne sont pas prises pour des fuites du widget");

  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  const s = sain.resume.essais.find((x) => x.id === 4);
  assert.equal(s.resultat, 'rien_observe', s.detail);
  assert.equal(sain.constats.filter((c) => c.regle === 'D-REEL-04').length, 0);
});
