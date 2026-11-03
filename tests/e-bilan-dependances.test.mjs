/**
 * Bilan des dépendances (E-DEP-07) : maintenues ? présumées sûres ? Un constat d'information qui dit ce qui est mesuré et ce qui ne l'est pas.
 * Aucun essai n'atteint le réseau : l'état de `npm audit` est fourni par des constats E-VULN-* construits à la main, la lecture du registre par une
 * fonction d'essai (ou coupée par `reseau: false`, comme `--sans-reseau`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { bilanDependances } from '../src/regles/e-bilan.js';
import { estDuRegistre, resumerPublications, interrogerRegistre, MAX_INTERROGEES } from '../src/regles/e-registre.js';
import { interpreterAudit } from '../src/regles/e-dependances.js';
import { constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';

const PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>w</title></head><body><main><h1>w</h1></main></body></html>';
const PAQUET = JSON.stringify({ name: 'w', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' }, devDependencies: { vieux: '1.0.0' } });
const VERROU = (deprecated) => JSON.stringify({
  name: 'w', lockfileVersion: 3,
  packages: { '': { name: 'w' }, 'node_modules/left-pad': { version: '1.3.0' }, 'node_modules/vieux': { version: '1.0.0', dev: true, ...(deprecated && { deprecated: 'plus maintenu' }) } },
});

function contexte(fichiers) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-bilan-'));
  for (const [nom, contenu] of Object.entries({ 'index.html': PAGE, ...fichiers })) fs.writeFileSync(path.join(dossier, nom), contenu);
  return construireContexte(dossier);
}
const vuln = (regle, preuve) => constat({ regle, axe: 'E', severite: 'info', titre: 't', constat: 'c', preuve });
const SANS_RESEAU = { reseau: false };
const bilan = async (ctx, constatsE = [], options = SANS_RESEAU, lire = async () => { throw new Error('le registre ne doit pas être lu'); }) => (await bilanDependances(ctx, constatsE, options, lire))[0];

const ilYA = (mois) => new Date(Date.now() - mois * 30.44 * 24 * 3600 * 1000).toISOString();
const publie = (mois, latest) => ({ time: { created: ilYA(100), modified: ilYA(0), '1.0.0': ilYA(mois) }, latest });

test('sans aucune dépendance, pas de bilan', async () => {
  assert.deepEqual(await bilanDependances(contexte({}), [], SANS_RESEAU), []);
});

test("npm audit mesuré sans avis, --sans-reseau : présumée sûre, régularité dite non mesurée et pourquoi", async () => {
  const c = await bilan(contexte({ 'package.json': PAQUET, 'package-lock.json': VERROU(false) }), [vuln('E-VULN-02')]);
  assert.equal(c.regle, 'E-DEP-07');
  assert.equal(c.severite, 'info');
  assert.match(c.constat, /aucun avis publié .* présumés sûrs au sens des avis connus, non relus/);
  assert.match(c.constat, /aucun paquet verrouillé n'en porte/);
  assert.match(c.constat, /n'est PAS mesurée : audit lancé avec --sans-reseau, le registre npm n'a pas été interrogé/);
  assert.match(c.constat, /ne veut donc pas dire « maintenue régulièrement »/);
  assert.equal(c.preuve.registre, 'option');
  assert.deepEqual(c.preuve.dependances.map((d) => [d.nom, d.surete.etat, d.maintenance.regularite.etat]), [['left-pad', 'aucun-avis', 'non-mesuree'], ['vieux', 'aucun-avis', 'non-mesuree']]);
});

test("un paquet que le verrou marque déprécié est nommé ; un avis d'npm audit aussi ; le reste n'est pas déclaré sûr par défaut", async () => {
  const c = await bilan(contexte({ 'package.json': PAQUET, 'package-lock.json': VERROU(true) }), [vuln('E-VULN-01', { nom: 'left-pad', avis: { severity: 'high' } })]);
  assert.match(c.constat, /1 paquet verrouillé est marqué déprécié .* vieux@1\.0\.0 \(développement\)/);
  assert.match(c.constat, /avis sur left-pad \(E-VULN-01\)/);
  const parNom = Object.fromEntries(c.preuve.dependances.map((d) => [d.nom, d]));
  assert.equal(parNom.vieux.maintenance.depreciee, true);
  assert.equal(parNom['left-pad'].maintenance.depreciee, false);
  assert.deepEqual(parNom['left-pad'].surete, { etat: 'avis', gravite: 'high' });
  assert.equal(parNom.vieux.surete.etat, 'aucun-avis');
});

test("npm audit non lancé ou en échec : la sûreté est dite non établie, jamais présumée", async () => {
  for (const [regle, cause] of [['E-VULN-OPTION', /--sans-reseau/], ['E-VULN-00', /n'a pas abouti/]]) {
    const c = await bilan(contexte({ 'package.json': PAQUET, 'package-lock.json': VERROU(false) }), [vuln(regle)]);
    assert.match(c.constat, /Sûreté : non établie/);
    assert.match(c.constat, cause);
    assert.ok(c.preuve.dependances.every((d) => d.surete.etat === 'non-mesuree'));
    assert.doesNotMatch(c.constat, /présumés sûrs/);
  }
});

test("le registre : dernière publication récente ou ancienne, retard de version majeure, introuvable ; la définition de « récente » est dite", async () => {
  const paquet = JSON.stringify({ name: 'w', dependencies: { frais: '^2.0.0', fige: '^1.0.0', fantome: '^1.0.0', 'depuis-git': 'github:u/r', '--registry=x': '1.0.0' } });
  const verrou = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/frais': { version: '2.0.0' }, 'node_modules/fige': { version: '1.0.0' } } });
  const interroges = [];
  const lire = async (noms) => {
    interroges.push(...noms);
    return new Map([['frais', publie(2, '2.0.0')], ['fige', publie(40, '3.1.0')], ['fantome', { erreur: 'introuvable' }]]);
  };
  const c = await bilan(contexte({ 'package.json': paquet, 'package-lock.json': verrou }), [], {}, lire);
  assert.deepEqual(interroges, ['frais', 'fige', 'fantome'], "ni une adresse git, ni un nom qui ressemble à une option de npm n'est passé à npm");
  assert.match(c.constat, /Régularité des publications \(registre npm, à la date de l'audit\) : 2 dépendance\(s\) directe\(s\) de production sur 5 mesurée\(s\), 1 avec une publication de moins de 24 mois/);
  assert.match(c.constat, /sans publication depuis plus de 24 mois : fige \(dernière le \d{4}-\d{2}-\d{2}\), abandon possible mais non prouvé/);
  assert.match(c.constat, /en retard d'une version majeure ou plus sur la dernière : fige@1\.0\.0 \(2\)/);
  assert.match(c.constat, /3 non mesurée\(s\)/);
  assert.match(c.constat, /indice de maintenance, non une preuve/);
  const r = Object.fromEntries(c.preuve.dependances.map((d) => [d.nom, d.maintenance.regularite]));
  assert.equal(r.frais.etat, 'recente');
  assert.equal(r.fige.etat, 'ancienne');
  assert.deepEqual(r.fantome, { etat: 'non-mesuree', raison: 'introuvable' });
  assert.deepEqual(r['depuis-git'], { etat: 'non-mesuree', raison: 'hors-registre-public' });
  assert.equal(c.preuve.regulariteMesuree, 2);
});

test('registre injoignable : rien n\'est affirmé sur la régularité, et le constat reste une information sans mesure partielle', async () => {
  const lire = async (noms) => new Map(noms.map((n) => [n, { erreur: 'injoignable' }]));
  const c = await bilan(contexte({ 'package.json': PAQUET, 'package-lock.json': VERROU(false) }), [vuln('E-VULN-02')], {}, lire);
  assert.match(c.constat, /n'est PAS mesurée : le registre npm n'a pas répondu/);
  assert.doesNotMatch(c.constat, /moins de 24 mois/);
  assert.equal(c.mesurePartielle, false);
  assert.equal(c.bloquant, false);
});

test("--sans-reseau ne lit pas le registre ; au-delà de la borne, les dépendances ne sont pas interrogées", async () => {
  const dependencies = Object.fromEntries(Array.from({ length: MAX_INTERROGEES + 5 }, (_, i) => [`dep-${i}`, '1.0.0']));
  const ctx = contexte({ 'package.json': JSON.stringify({ name: 'w', dependencies }) });
  let appels = 0;
  await bilan(ctx, [], SANS_RESEAU, async () => { appels++; return new Map(); });
  assert.equal(appels, 0);
  let lus = [];
  await bilan(ctx, [], {}, async (noms) => { lus = noms; return new Map(); });
  assert.equal(lus.length, MAX_INTERROGEES);
});

test("estDuRegistre et resumerPublications : noms et adresses, date de publication hors « modified », retard de version", () => {
  assert.ok(estDuRegistre('lodash', '^4.17.0') && estDuRegistre('@grist/x', '1.2.3') && estDuRegistre('a', 'latest'));
  assert.ok(!estDuRegistre('--registry=x', '1.0.0') && !estDuRegistre('lodash', 'github:u/r') && !estDuRegistre('lodash', 'file:../l') && !estDuRegistre('lodash', 'npm:autre@1') && !estDuRegistre('Majuscule', '1.0.0'));
  const maintenant = Date.parse('2026-11-03T00:00:00Z');
  const r = resumerPublications({ time: { created: '2020-01-01T00:00:00Z', modified: '2026-11-01T00:00:00Z', '1.0.0': '2020-01-01T00:00:00Z', '1.1.0': '2024-06-15T00:00:00Z' }, latest: '1.1.0' }, '1.0.0', maintenant);
  assert.deepEqual(r, { etat: 'ancienne', dernierePublication: '2024-06-15', ageMois: 28, retardMajeur: 0 });
  assert.equal(resumerPublications({ time: { created: 'x', modified: 'y' } }, '1.0.0', maintenant), null);
});

test("une bibliothèque embarquée n'est vue par aucune base d'avis ; le bilan n'ajoute ni pénalité, ni plafond, ni mesure partielle", async () => {
  const ctx = contexte({ 'package.json': PAQUET, 'package-lock.json': VERROU(false), LICENSE: 'MIT License\n' });
  const constatsE = [vuln('E-DEP-02')];
  constatsE[0].fichier = 'vendor/lib.js';
  const c = await bilan(ctx, constatsE);
  assert.match(c.constat, /1 bibliothèque embarquée ou distante n'est vue par aucune base d'avis : sûreté non vérifiée/);
  assert.equal(c.mesurePartielle, false);
  assert.equal(c.bloquant, false);
  const avec = await analyseStatique(ctx, SANS_RESEAU);
  const sans = avec.filter((x) => x.regle !== 'E-DEP-07');
  assert.equal(avec.filter((x) => x.regle === 'E-DEP-07').length, 1);
  const [n1, n2] = [noter(sans, new Set(['D'])), noter(avec, new Set(['D']))];
  assert.equal(n2.global, n1.global);
  assert.equal(n2.verdict, n1.verdict);
  assert.equal(n2.parAxe.E.score, n1.parAxe.E.score);
});

test('verrou illisible ou absent : aucun signal de maintenance affirmé', async () => {
  const c = await bilan(contexte({ 'package.json': PAQUET, 'package-lock.json': '{pas du json' }), []);
  assert.match(c.constat, /aucun signal lu : le verrou .* absent ou illisible/);
  assert.ok(c.preuve.dependances.every((d) => d.maintenance.depreciee === null));
});

test("npm audit : un registre injoignable (JSON d'erreur) est un audit raté, non « aucune vulnérabilité »", () => {
  const erreur = JSON.stringify({ message: 'request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: self-signed certificate', error: { summary: '', detail: '' } });
  assert.match(interpreterAudit(erreur).erreur, /self-signed certificate/);
  assert.equal(interpreterAudit('  ').erreur, 'sortie vide');
  assert.deepEqual(interpreterAudit(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} })), { avis: {} });
  assert.ok(interpreterAudit(JSON.stringify({ vulnerabilities: { x: { severity: 'high' } } })).avis.x);
});

test('lecture du registre : réponse, 404, sortie illisible ; un registre qui ne répond à personne arrête la lecture après le premier lot', async () => {
  const reponses = {
    bon: { stdout: JSON.stringify({ time: { created: 'a', '1.0.0': '2026-01-01T00:00:00Z' }, 'dist-tags': { latest: '1.0.0' } }) },
    absent: Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ error: { code: 'E404' } }) }),
    muet: Object.assign(new Error('délai'), { killed: true, stdout: '' }),
  };
  let appels = [];
  const creer = (table) => () => ({ lancer: async (args) => { appels.push(args[1]); const r = table(args[1]); if (r instanceof Error) throw r; return r; }, nettoyer() {} });
  const lus = await interrogerRegistre(['bon', 'absent', 'muet'], creer((nom) => reponses[nom]));
  assert.deepEqual([lus.get('bon').latest, lus.get('absent').erreur, lus.get('muet').erreur], ['1.0.0', 'introuvable', 'injoignable']);
  appels = [];
  const noms = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const rien = await interrogerRegistre(noms, creer(() => reponses.muet));
  assert.equal(appels.length, 5, 'le deuxième lot n\'est pas lancé');
  assert.equal(rien.size, 5);
});
