// Mode --grist-reel : essais ciblés, sans lancer Grist (le test de bout en bout, qui lance un vrai Grist Desktop, est joué à la demande :
// GWAUDIT_GRIST_REEL_E2E=1 node --test tests/grist-reel.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { verifierIsolation, construireEnvironnement, InstanceImpossible } from '../src/runtime/grist-reel/instance.js';
import { construireJeu, trouverCanari, HOTE_PUITS } from '../src/runtime/grist-reel/donnees.js';
import { choisirAsset, assurerGristDesktop, EPINGLE, InstallationImpossible, dossierCache } from '../src/runtime/grist-reel/installateur.js';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { choisirNiveau } from '../src/runtime/grist-reel/index.js';
import { htmlGristReel, markdownGristReel } from '../src/rapport/grist-reel.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('isolation : toute variable de stockage hors du profil jetable est refusée', () => {
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
  try {
    const env = construireEnvironnement(profil, 4000, {});
    assert.doesNotThrow(() => verifierIsolation(env, profil));
    for (const cle of ['GRIST_DATA_DIR', 'GRIST_INST_DIR', 'TYPEORM_DATABASE', 'GRIST_USER_ROOT']) {
      assert.throws(() => verifierIsolation({ ...env, [cle]: path.join(os.homedir(), 'Documents') }, profil), InstanceImpossible, cle);
      assert.throws(() => verifierIsolation({ ...env, [cle]: path.join(profil, '..', 'ailleurs') }, profil), InstanceImpossible, `${cle} (..)`);
      assert.throws(() => verifierIsolation({ ...env, [cle]: undefined }, profil), InstanceImpossible, `${cle} absente`);
    }
    assert.throws(() => verifierIsolation({ ...env, GRIST_HOST: '0.0.0.0' }, profil), InstanceImpossible);
    assert.equal(env.GRIST_DESKTOP_AUTH, 'none');
    assert.equal(env.GRIST_PORT, '4000');
  } finally { fs.rmSync(profil, { recursive: true, force: true }); }
});

test('installateur : une archive épinglée par plateforme, empreinte complète, refus clair ailleurs', () => {
  assert.equal(choisirAsset('win32', 'x64').format, 'zip');
  assert.equal(choisirAsset('linux', 'x64').format, 'appimage');
  for (const a of Object.values(EPINGLE.assets)) assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => choisirAsset('darwin', 'arm64'), (e) => e instanceof InstallationImpossible && /GWAUDIT_GRIST_DESKTOP/.test(e.message));
  assert.equal(dossierCache({ GWAUDIT_CACHE: '/x/y' }, 'linux'), path.resolve('/x/y'));
});

test("installateur : un Grist Desktop imposé est pris tel quel, ou refusé s'il n'existe pas", async () => {
  await assert.rejects(assurerGristDesktop({ env: { GWAUDIT_GRIST_DESKTOP: '/chemin/inexistant/grist' } }), InstallationImpossible);
  const fichier = path.join(os.tmpdir(), `gw-fictif-${process.pid}`);
  fs.writeFileSync(fichier, '');
  try {
    const r = await assurerGristDesktop({ env: { GWAUDIT_GRIST_DESKTOP: fichier } });
    assert.equal(r.source, 'impose'); assert.equal(r.executable, fichier);
  } finally { fs.rmSync(fichier, { force: true }); }
});

test('données : canaris uniques par audit, charge XSS observable dans le cadre du widget, canari retrouvé même encodé', () => {
  const a = construireJeu(undefined, 'aaaa1111'); const b = construireJeu(undefined, 'bbbb2222');
  assert.notEqual(a.prefixe, b.prefixe);
  const toutesValeurs = a.table.colonnes.flatMap((c) => c.valeurs).filter((v) => typeof v === 'string');
  assert.ok(toutesValeurs.some((v) => v.includes('onerror=') && v.includes('window.__gw_xss')), 'la charge XSS est dans le document');
  assert.ok(!toutesValeurs.some((v) => v.includes('__poc_xss_exec')), "l'ancienne sonde (window.parent) est remplacée");
  assert.ok(a.appat.libelles.every((l) => l.includes('GWC-aaaa1111-APPAT-')));
  assert.equal(trouverCanari('rien à voir', a), null);
  assert.ok(trouverCanari(`http://x.invalid/?d=${encodeURIComponent('["GWC-aaaa1111-APPAT-1"]')}`, a));
  assert.equal(trouverCanari('GWC-bbbb2222-APPAT-1', a), null, "le canari d'un autre audit ne compte pas");
  assert.ok(trouverCanari('mail alice.dupont@exemple.gouv.fr envoyé', a), 'une valeur ordinaire du document est cherchée aussi');
});

// --- Ce que les observations veulent dire (observations fabriquées : le vrai Grist n'est pas lancé ici) ---
const jeu = construireJeu(undefined, 'cafe0001');
const obs = (o = {}) => ({
  charge: true, appelsRpc: [{ interface: 'CustomSectionAPI', methode: 'configure', issue: 'accepte' }], configure: null, canariRecu: true, texteDuCadre: '',
  xss: { executions: 0, lu: null, refus: null, erreur: null }, requetesExternes: [], apiSubstituee: [], navigations: [], navigationsRefusees: [],
  popups: [], dialogues: [], telechargements: [], consoles: [], erreursPage: [], erreur: null, ...o,
});
const par = (r, id) => r.essais.find((e) => e.id === id);

test("essais : sans page chargée, rien n'est conclu (jamais « rien trouvé »), aucun constat", () => {
  const r = evaluerEssais({ none: obs({ charge: false, erreur: 'pas de cadre' }), demande: null }, jeu);
  assert.equal(r.constats.length, 0);
  for (const e of r.essais) assert.equal(e.resultat, 'non_teste', `essai ${e.id}`);
});

test("essais : sans donnée arrivée au widget, l'exfiltration et la XSS sont « non testées », pas « rien observé »", () => {
  const r = evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs({ canariRecu: false }) } }, jeu);
  assert.equal(par(r, 1).resultat, 'non_teste');
  assert.equal(par(r, 13).resultat, 'non_teste');
  assert.equal(par(r, 7).resultat, 'bloque');
  assert.equal(r.constats.length, 0);
});

test("essais : XSS qui lit la table appât et la sort = critique bloquant ; si Grist refuse la lecture = majeur non bloquant", () => {
  const sortie = { url: `http://${HOTE_PUITS}/xss?d=x`, methode: 'GET', hote: HOTE_PUITS, type: 'image', provenance: 'widget', canari: 'GWC-cafe0001-APPAT-1' };
  const lu = evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'full', obs: obs({ xss: { executions: 1, lu: '{"Libelle":["x GWC-cafe0001-APPAT-1"]}' }, requetesExternes: [sortie] }) } }, jeu);
  const c1 = lu.constats.find((c) => c.regle === 'D-REEL-01');
  assert.equal(c1.severite, 'critique'); assert.equal(c1.bloquant, true);
  assert.equal(lu.constats.filter((c) => c.regle === 'D-REEL-13').length, 0, "la sortie de la charge XSS n'est pas comptée deux fois");

  const refuse = evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs({ xss: { executions: 1, refus: 'Access not granted. Current access level read table' } }) } }, jeu);
  const c2 = refuse.constats.find((c) => c.regle === 'D-REEL-01');
  assert.equal(c2.severite, 'majeur'); assert.equal(c2.bloquant, false);
  assert.match(par(refuse, 1).etapes[1].barriere, /refus de Grist/);
});

test("essais : un canari trouvé dans une requête sortante = D-REEL-13 critique bloquant ; des requêtes sans canari = « rien observé » dit avec ses limites", () => {
  const r13 = { url: 'https://tiers.invalid/depot', methode: 'POST', hote: 'tiers.invalid', type: 'fetch', provenance: 'widget', canari: 'GWC-cafe0001-LIGNE-1' };
  const fuite = evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs({ requetesExternes: [r13] }) } }, jeu);
  assert.equal(fuite.constats.find((c) => c.regle === 'D-REEL-13').bloquant, true);
  const sans = evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs({ requetesExternes: [{ ...r13, canari: null }] }) } }, jeu);
  assert.equal(par(sans, 13).resultat, 'rien_observe');
  assert.match(par(sans, 13).detail, /hors encodage particulier/);
  assert.equal(sans.constats.length, 0);
});

test('essais : navigation refusée par Chromium = bloqué ; fenêtre ou dialogue = D-REEL-16 majeur non bloquant', () => {
  const nav = evaluerEssais({ none: obs(), demande: { niveau: 'read table', obs: obs({ navigationsRefusees: ["Unsafe attempt to initiate navigation for frame with origin 'a'"] }) } }, jeu);
  assert.equal(par(nav, 15).resultat, 'bloque'); assert.match(par(nav, 15).barriere, /Chromium/);
  const dial = evaluerEssais({ none: obs(), demande: { niveau: 'read table', obs: obs({ dialogues: [{ type: 'alert', message: 'x' }] }) } }, jeu);
  const c = dial.constats.find((x) => x.regle === 'D-REEL-16');
  assert.equal(c.severite, 'majeur'); assert.equal(c.bloquant, false);
});

test("niveau joué : celui que le widget demande ; « none » = pas de phase de données ; sans déclaration, niveau usuel signalé", () => {
  assert.deepEqual(choisirNiveau({ requiredAccess: 'full' }), { niveau: 'full', parDefaut: false });
  assert.deepEqual(choisirNiveau({ requiredAccess: 'none' }), { niveau: null, parDefaut: false });
  assert.deepEqual(choisirNiveau(null), { niveau: 'read table', parDefaut: true });
});

test('rapport : la section dit ce qui a été joué, ce qui ne l\'a pas été, et la cause quand rien ne s\'est exécuté', () => {
  const resume = { execute: true, produit: 'Grist Desktop', version: '0.3.17', plateforme: 'linux-x64', date: '2026-11-19T06:00:00Z', phases: [{ niveau: 'none' }, { niveau: 'full' }], essaisPasEncore: '2 à 6', essais: [{ id: 7, titre: 'Niveau none', resultat: 'bloque', detail: 'rien transmis', barriere: 'Grist' }] };
  const html = htmlGristReel(resume);
  assert.match(html, /Essais contre un Grist réel/); assert.match(html, /Bloqué/); assert.match(html, /pas encore joués : 2 à 6/);
  assert.match(markdownGristReel(resume).join('\n'), /\| 7 \|/);
  assert.match(htmlGristReel({ execute: false, cause: 'Docker absent' }), /Non exécutés.*Docker absent/s);
  assert.equal(htmlGristReel(null), '');
});

// --- Bout en bout : un vrai Grist Desktop (téléchargé au besoin), un vrai Chromium. Joué à la demande. ---
test('bout en bout : widget défaillant (constats) et widget sain (aucun constat)', { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 360_000 }, async () => {
  const { construireContexte } = await import('../src/contexte/inventaire.js');
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const avant = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gwaudit-grist-'));

  const mauvais = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel')), {});
  assert.equal(mauvais.nonExecute, undefined, mauvais.resume.cause);
  const regles = mauvais.constats.map((c) => c.regle);
  for (const r of ['D-REEL-01', 'D-REEL-13', 'D-REEL-16']) assert.ok(regles.includes(r), `${r} attendu, vu : ${regles.join(', ')}`);
  assert.equal(mauvais.resume.essais.find((e) => e.id === 7).resultat, 'bloque');

  const sain = await auditGristReel(construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-sain')), {});
  assert.equal(sain.nonExecute, undefined, sain.resume.cause);
  assert.deepEqual(sain.constats.map((c) => c.regle), []);
  assert.equal(sain.resume.essais.find((e) => e.id === 1).resultat, 'rien_observe');

  const apres = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('gwaudit-grist-'));
  assert.deepEqual(apres.filter((n) => !avant.includes(n)), [], 'le profil jetable est supprimé');
});
