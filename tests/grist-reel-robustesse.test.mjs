// Essais 2 et 6 : valeurs limites dans la table, puis rafale de changements. On compte les erreurs non rattrapées du widget (celles qu'il n'avait pas dans les
// autres passes) et on regarde si son cadre répond encore. Les observations sont fabriquées ; le test de bout en bout, qui lance un vrai Grist Desktop, est
// joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { construireJeu } from '../src/runtime/grist-reel/donnees.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = construireJeu(undefined, 'cafe0002');
const erreur = (message, n = 1) => ({ message, n });
const mesure = (distinctes = [], reponseMs = 3) => ({ reponseMs, erreurs: distinctes.reduce((t, d) => t + d.n, 0), distinctes });
const obsBase = (extra = {}) => ({ charge: true, canariRecu: true, appelsRpc: [], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, erreur: null, erreursWidget: { total: 0, distinctes: [] }, robustesse: null, ...extra });
const phase = (rb, extra = {}, base = obsBase()) => evaluerEssais({ none: obsBase({ canariRecu: false }), demande: { niveau: 'read table', obs: base }, robustesse: { niveau: 'read table', lignes: 5009, obs: obsBase({ robustesse: { apresChargement: mesure(), apresRafale: mesure(), rafaleErreur: null, ...rb }, ...extra }) } }, jeu);
const e = (r, id) => r.essais.find((x) => x.id === id);

test("essai 2 : une erreur non rattrapée avec les valeurs limites, absente des autres passes = constat mineur non bloquant", () => {
  const r = phase({ apresChargement: mesure([erreur('URI malformed', 3)]) });
  assert.equal(e(r, 2).resultat, 'reussi');
  assert.equal(e(r, 2).severite, 'mineur');
  const c = r.constats.find((x) => x.regle === 'D-REEL-02');
  assert.equal(c.severite, 'mineur'); assert.equal(c.bloquant, false);
  assert.match(c.constat, /URI malformed/);
  assert.equal(verdictEssai(e(r, 2)).cle, 'pas_bien');
});

test("essai 2 : une erreur que le widget lève déjà sans valeur limite n'est pas imputée aux valeurs limites ; cadre figé = constat", () => {
  const base = obsBase({ erreursWidget: { total: 2, distinctes: [erreur('URI malformed', 2)] } });
  const r = phase({ apresChargement: mesure([erreur('URI malformed', 3)]) }, {}, base);
  assert.equal(e(r, 2).resultat, 'rien_observe');
  assert.equal(r.constats.filter((x) => x.regle === 'D-REEL-02').length, 0);
  assert.equal(verdictEssai(e(r, 2)).cle, 'bien');
  const fige = phase({ apresChargement: mesure([], null) });
  assert.equal(e(fige, 2).resultat, 'reussi');
  assert.equal(e(fige, 2).fige, true);
  assert.match(fige.constats.find((x) => x.regle === 'D-REEL-02').titre, /se fige/);
});

test("essai 6 : une erreur nouvelle après la rafale = constat ; une erreur déjà vue au chargement ou dans une autre passe n'en est pas un ; cadre figé après la rafale = constat", () => {
  const nouvelle = phase({ apresRafale: mesure([erreur('trop de mises à jour', 12)]) });
  assert.equal(e(nouvelle, 6).resultat, 'reussi');
  assert.equal(nouvelle.constats.find((x) => x.regle === 'D-REEL-06').severite, 'mineur');
  assert.equal(e(nouvelle, 2).resultat, 'rien_observe', "l'essai 2 ne voit pas une erreur née de la rafale");
  const dejaVue = phase({ apresChargement: mesure([erreur('URI malformed')]), apresRafale: mesure([erreur('URI malformed', 40)]) });
  assert.equal(e(dejaVue, 6).resultat, 'rien_observe');
  assert.equal(dejaVue.constats.filter((x) => x.regle === 'D-REEL-06').length, 0);
  const fige = phase({ apresRafale: mesure([], null) });
  assert.equal(e(fige, 6).resultat, 'reussi');
  assert.equal(e(fige, 6).fige, true);
});

test("essais 2 et 6 : jamais « rien observé » à tort : lignes refusées, page non chargée, aucune donnée arrivée, mesure absente, rafale non envoyée, cadre déjà figé", () => {
  for (const id of [2, 6]) {
    assert.equal(e(evaluerEssais({ none: obsBase(), demande: { niveau: 'read table', obs: obsBase() }, robustesse: { indisponible: 'Grist a refusé' } }, jeu), id).resultat, 'non_teste');
    assert.equal(e(phase({}, { charge: false, erreur: 'pas de cadre' }), id).resultat, 'non_teste');
    assert.equal(e(phase({}, { canariRecu: false }), id).resultat, 'non_teste');
    assert.equal(e(phase({ apresChargement: undefined }), id).resultat, 'non_teste');
  }
  assert.equal(e(phase({ rafaleErreur: 'refusée' }), 6).resultat, 'non_teste');
  assert.equal(e(phase({ apresRafale: null }), 6).resultat, 'non_teste');
  const figeDeja = phase({ apresChargement: mesure([], null) });
  assert.equal(e(figeDeja, 2).resultat, 'reussi');
  assert.equal(e(figeDeja, 6).resultat, 'non_teste');
  assert.equal(e(evaluerEssais({ none: obsBase(), demande: { niveau: 'read table', obs: obsBase() } }, jeu), 2), undefined);
});

test("les lignes limites ne restent pas dans la table (retirées ensuite) et la rafale n'utilise que des actions de la table du widget", async () => {
  const { ajouterDonneesLimites, retirerDonneesLimites, rafaleDeChangements, COLONNE_LIMITES, NB_LIGNES_LIMITES } = await import('../src/runtime/grist-reel/donnees.js');
  const appels = [];
  const client = { actions: async (docId, actions) => { appels.push(...actions); return { retValues: actions[0][0] === 'BulkAddRecord' ? [actions[0][2].map((_, i) => i + 100)] : [] }; }, sql: async () => ({ records: [{ fields: { id: 1 } }, { fields: { id: 2 } }] }) };
  const doc = { docId: 'D' };
  const limites = await ajouterDonneesLimites(client, doc, jeu);
  assert.equal(limites.lignes, 9 + NB_LIGNES_LIMITES);
  const ajouts = appels.filter((a) => a[0] === 'BulkAddRecord');
  assert.equal(ajouts.length, 2, 'la cellule de 1 Mo part seule : Grist refuse une requête de plus d\'environ 1 Mo');
  assert.ok(ajouts.every((a) => a[1] === jeu.table.id && Object.keys(a[3]).includes(COLONNE_LIMITES)));
  assert.ok(ajouts.every((a) => Object.values(a[3]).every((v) => v.length === a[2].length)));
  assert.ok(JSON.stringify(ajouts[1]).length < 500_000, 'le second envoi (lignes courtes) reste petit');
  appels.length = 0;
  await retirerDonneesLimites(client, doc, jeu, limites);
  assert.deepEqual(appels.map((a) => a[0]), ['BulkRemoveRecord', 'RemoveColumn']);
  assert.equal(appels[0][2].length, limites.lignes);
  appels.length = 0;
  await rafaleDeChangements(client, doc, jeu);
  assert.ok(appels.every((a) => a[1] === jeu.table.id), 'toutes les actions de la rafale visent la table du widget');
  assert.equal(appels.filter((a) => a[0] === 'BulkUpdateRecord').length, 30);
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : un widget fragile est signalé aux essais 2 et 6 ; un widget sain ne l'est pas", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 600_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const fragile = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-fragile')), {});
  assert.equal(fragile.nonExecute, undefined, fragile.resume.cause);
  const e2 = fragile.resume.essais.find((x) => x.id === 2);
  const e6 = fragile.resume.essais.find((x) => x.id === 6);
  assert.equal(e2.resultat, 'reussi', e2.detail);
  assert.match(e2.detail, /URI malformed/);
  assert.equal(e6.resultat, 'reussi', e6.detail);
  assert.match(e6.detail, /trop de mises à jour/);
  assert.ok(fragile.constats.some((c) => c.regle === 'D-REEL-02' && c.severite === 'mineur' && !c.bloquant));
  assert.ok(fragile.constats.some((c) => c.regle === 'D-REEL-06' && c.severite === 'mineur' && !c.bloquant));

  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  assert.equal(sain.resume.essais.find((x) => x.id === 2).resultat, 'rien_observe', sain.resume.essais.find((x) => x.id === 2).detail);
  assert.equal(sain.resume.essais.find((x) => x.id === 6).resultat, 'rien_observe', sain.resume.essais.find((x) => x.id === 6).detail);
  assert.equal(sain.constats.filter((c) => c.regle === 'D-REEL-02' || c.regle === 'D-REEL-06').length, 0);
});
