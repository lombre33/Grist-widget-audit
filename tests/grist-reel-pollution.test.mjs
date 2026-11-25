// Essai 3 : des données de cellule piégées (JSON avec `__proto__` ou `constructor.prototype`, chemin `__proto__.clé`) font-elles ajouter une clé aux
// prototypes du widget ? Une clé qui n'existe que par ces données, trouvée dans Object.prototype, est un fait prouvé. Les observations sont fabriquées ;
// le test de bout en bout, qui lance un vrai Grist Desktop, est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { construireJeu, lignesHostiles, CLES_POLLUTION } from '../src/runtime/grist-reel/donnees.js';
import { kitPollution } from '../src/runtime/grist-reel/kit.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jeu = construireJeu(undefined, 'cafe0003');
const obs = (extra = {}) => ({ charge: true, canariRecu: true, hostileRecu: true, appelsRpc: [{}], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, canaux: null, pollution: { polluees: [] }, erreur: null, ...extra });
const passe = (o) => evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs() }, canaux: { niveau: 'read table', obs: o } }, jeu);
const e3 = (r) => r.essais.find((e) => e.id === 3);

test("lignesHostiles : trois pièges de pollution (JSON __proto__, JSON constructor.prototype, chemin) et des mots-clés dangereux, dans les colonnes de texte seulement", () => {
  const lignes = lignesHostiles(jeu);
  const texte = lignes.map((l) => l.Nom);
  assert.ok(texte.some((t) => t.includes('"__proto__"') && t.includes(CLES_POLLUTION[0])));
  assert.ok(texte.some((t) => t.includes('"constructor"') && t.includes('"prototype"') && t.includes(CLES_POLLUTION[1])));
  assert.ok(texte.some((t) => t === `__proto__.${CLES_POLLUTION[2]}`));
  for (const mot of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.ok(texte.includes(mot), mot);
  for (const l of lignes) assert.ok(!('GwauditCanari' in l), 'jamais dans la colonne des canaris');
  for (const t of texte.slice(0, 2)) assert.doesNotThrow(() => JSON.parse(t));
  for (const cle of CLES_POLLUTION) assert.ok(!({})[cle], "ces clés n'existent nulle part avant l'essai");
});

test("kitPollution : ne signale que les clés réellement présentes dans Object.prototype (jamais une clé ordinaire), et rend l'objet propre après le test", () => {
  assert.deepEqual(kitPollution({ cles: CLES_POLLUTION }).polluees, []);
  Object.prototype[CLES_POLLUTION[1]] = 'x';
  try { assert.deepEqual(kitPollution({ cles: CLES_POLLUTION }).polluees, [CLES_POLLUTION[1]]); }
  finally { delete Object.prototype[CLES_POLLUTION[1]]; }
  assert.deepEqual(kitPollution({ cles: ['toString', 'constructor'] }).polluees, ['toString', 'constructor'], "les clés héritées normales seraient prises pour une pollution : la liste de l'essai ne doit donc contenir que des clés inventées");
});

test("essai 3 : une clé ajoutée à Object.prototype par les données = constat majeur non bloquant ; rien ajouté après réception des données = rien observé", () => {
  const pollue = passe(obs({ pollution: { polluees: [CLES_POLLUTION[0]] } }));
  assert.equal(e3(pollue).resultat, 'reussi');
  assert.equal(e3(pollue).severite, 'majeur');
  const c = pollue.constats.find((x) => x.regle === 'D-REEL-03');
  assert.equal(c.severite, 'majeur'); assert.equal(c.bloquant, false); assert.equal(c.confiance, 'prouve');
  assert.equal(verdictEssai(e3(pollue)).cle, 'pas_bien');

  const propre = passe(obs());
  assert.equal(e3(propre).resultat, 'rien_observe');
  assert.equal(propre.constats.filter((x) => x.regle === 'D-REEL-03').length, 0);
  assert.equal(verdictEssai(e3(propre)).cle, 'bien');
});

test("essai 3 : jamais « rien observé » à tort : données hostiles non reçues par le widget, lignes non ajoutées, contrôle non joué, page non chargée", () => {
  assert.equal(e3(passe(obs({ hostileRecu: false }))).resultat, 'non_teste', "le widget n'a pas reçu les lignes : rien n'est prouvé");
  assert.match(e3(passe(obs({ hostileRecu: false }))).detail, /n'ont pas atteint le widget/);
  assert.equal(e3(passe(obs({ pollution: null }))).resultat, 'non_teste');
  assert.equal(e3(passe(obs({ pollution: { erreur: 'cadre fermé' } }))).resultat, 'non_teste');
  assert.equal(e3(passe(obs({ charge: false, erreur: 'pas de cadre' }))).resultat, 'non_teste');
  assert.equal(e3(evaluerEssais({ none: obs({ canariRecu: false }), demande: null }, jeu)), undefined, "pas de passe : pas d'essai");
  // une pollution observée reste vraie même si la réception n'a pas été vue : la clé ne peut venir que des données
  assert.equal(e3(passe(obs({ hostileRecu: false, pollution: { polluees: [CLES_POLLUTION[2]] } }))).resultat, 'reussi');
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
test("bout en bout : un widget qui fusionne naïvement ses cellules JSON est pollué ; un widget qui n'affiche que du texte ne l'est pas", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const pollue = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-pollue')), {});
  assert.equal(pollue.nonExecute, undefined, pollue.resume.cause);
  const e = pollue.resume.essais.find((x) => x.id === 3);
  assert.equal(e.resultat, 'reussi', e.detail);
  assert.ok(pollue.constats.some((c) => c.regle === 'D-REEL-03' && c.severite === 'majeur' && !c.bloquant));

  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  assert.equal(sain.resume.essais.find((x) => x.id === 3).resultat, 'rien_observe', sain.resume.essais.find((x) => x.id === 3).detail);
  assert.equal(sain.constats.filter((c) => c.regle === 'D-REEL-03').length, 0);
});

test("bout en bout : un widget qui ne lit que la ligne sélectionnée reçoit les lignes piégées (le curseur de Grist y est conduit) : pollué ou non, jamais « non testé »", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 600_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const pollue = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-pollue-ligne')), {});
  assert.equal(pollue.nonExecute, undefined, pollue.resume.cause);
  const e = pollue.resume.essais.find((x) => x.id === 3);
  assert.equal(e.resultat, 'reussi', e.detail);
  assert.ok(pollue.constats.some((c) => c.regle === 'D-REEL-03' && c.severite === 'majeur' && !c.bloquant));

  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain-ligne')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  const es = sain.resume.essais.find((x) => x.id === 3);
  assert.equal(es.resultat, 'rien_observe', es.detail);
  assert.equal(sain.constats.filter((c) => c.regle === 'D-REEL-03').length, 0);
});
