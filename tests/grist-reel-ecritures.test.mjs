// Essai 10 : ce que du code étranger, dans le cadre du widget, pourrait changer dans le document. Les effets sont relus côté serveur par l'audit
// (jamais crus sur la parole du widget), sur des tables sacrifiées créées pour l'essai. Le test de bout en bout, qui lance un vrai Grist Desktop,
// est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { TABLES_SACRIFIEES, verifierEcritures } from '../src/runtime/grist-reel/donnees.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = { prefixe: 'GWC-x-', valeursCherchees: [] };
const obs = (extra = {}) => ({ charge: true, canariRecu: true, appelsRpc: [{}], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, canaux: null, ecritures: null, erreur: null, ...extra });
const refus = { ok: false, erreur: 'Access not granted. Current access level read table' };
const tousRefuses = { grist: true, ajout: refus, renom: refus, colonne: refus, table: refus, regle: refus };
const rien = { ajout: false, renom: false, colonne: false, table: false, regle: false };
const tout = { ajout: true, renom: true, colonne: true, table: true, regle: true };
const jouer = (obsFinale, serveur, niveau = 'full') => evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau, obs: obs() }, ecritures: { niveau, obs: obsFinale, serveur } }, jeu);
const e10 = (r) => r.essais.find((e) => e.id === 10);

test("essai 10 à « full » : effets relus côté serveur = information sans pénalité, avec la liste de ce qui a changé ; un frame rechargé par Grist (règle d'accès) est attendu", () => {
  const r = jouer(obs({ ecritures: { erreur: 'frame.evaluate: Frame was detached', cadreRecharge: true } }), tout);
  assert.equal(e10(r).resultat, 'reussi');
  assert.equal(e10(r).severite, 'info');
  assert.deepEqual(e10(r).faits, ['ajouter des lignes', 'renommer une colonne', 'supprimer une colonne', 'supprimer une table', "créer une règle d'accès"]);
  const c = r.constats.find((x) => x.regle === 'D-REEL-10');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false);
  assert.match(verdictEssai(e10(r)).precision, /dépendance piégée/);
});

test("essai 10 : ce qui n'a pas changé dans le document n'est jamais compté, même si le widget prétend l'avoir fait", () => {
  const menteur = { grist: true, ajout: { ok: true }, renom: { ok: true }, colonne: { ok: true }, table: { ok: true }, regle: { ok: true } };
  const partiel = jouer(obs({ ecritures: menteur }), { ...rien, ajout: true, regle: true });
  assert.deepEqual(e10(partiel).faits, ['ajouter des lignes', "créer une règle d'accès"], 'seuls les effets présents côté serveur comptent');
  const aucun = jouer(obs({ ecritures: menteur }), rien);
  assert.equal(e10(aucun).resultat, 'non_teste', "le widget dit avoir écrit, le document n'a pas changé : l'essai ne prouve rien");
});

test("essai 10 à « read table » : Grist refuse tout et le document n'a pas changé = bloqué ; sans refus identifié = non testé ; page ou relecture indisponibles = non testé", () => {
  const bloque = jouer(obs({ ecritures: tousRefuses }), rien, 'read table');
  assert.equal(e10(bloque).resultat, 'bloque');
  assert.match(e10(bloque).barriere, /Grist/);
  assert.equal(bloque.constats.filter((c) => c.regle === 'D-REEL-10').length, 0);
  assert.equal(verdictEssai(e10(bloque)).cle, 'bien');

  assert.equal(e10(jouer(obs({ ecritures: { erreur: 'cadre fermé' } }), rien)).resultat, 'non_teste', 'ni effet ni refus signalé');
  assert.equal(e10(jouer(obs({ ecritures: null }), rien)).resultat, 'non_teste');
  assert.equal(e10(jouer(obs({ charge: false, erreur: 'pas de cadre' }), rien)).resultat, 'non_teste');
  assert.equal(e10(jouer(obs({ ecritures: tousRefuses }), { erreur: 'sql refusé' })).resultat, 'non_teste');
  assert.equal(e10(evaluerEssais({ none: obs({ canariRecu: false }), demande: null }, jeu)), undefined, "pas de passe : pas d'essai");
});

test("verifierEcritures : lit côté serveur chacun des cinq effets, une table sacrifiée par effet", async () => {
  const lignesDe = (requete) => {
    if (requete.includes('from _grist_Tables_column')) return null;
    if (requete.includes('_grist_ACLRules')) return [{ p: '-R' }];
    if (requete.includes('count(*)')) return [{ n: 2 }];
    return [{ tableId: 'Contacts' }];
  };
  const client = { sql: async (_doc, requete, args = []) => {
    if (requete.includes('from _grist_Tables_column')) return { records: [{ fields: { colId: args[0] === TABLES_SACRIFIEES.renom ? 'ValeurRenommee' : 'Valeur' } }] };
    return { records: lignesDe(requete).map((fields) => ({ fields })) };
  } };
  assert.deepEqual(await verifierEcritures(client, { docId: 'd' }), tout);
  assert.deepEqual(Object.keys(TABLES_SACRIFIEES).sort(), ['ajout', 'colonne', 'regle', 'renom', 'table']);
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : à « full » les cinq écritures sont constatées dans le document ; à « read table » Grist les refuse toutes", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');

  const full = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-full')), {});
  assert.equal(full.nonExecute, undefined, full.resume.cause);
  const e = full.resume.essais.find((x) => x.id === 10);
  assert.equal(e.resultat, 'reussi', e.detail);
  assert.equal(e.faits.length, 5, e.detail);
  assert.ok(full.constats.filter((c) => c.regle === 'D-REEL-10').every((c) => c.severite === 'info'));

  const lecture = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(lecture.nonExecute, undefined, lecture.resume.cause);
  assert.equal(lecture.resume.essais.find((x) => x.id === 10).resultat, 'bloque');
  assert.equal(lecture.constats.filter((c) => c.regle === 'D-REEL-10').length, 0);
});
