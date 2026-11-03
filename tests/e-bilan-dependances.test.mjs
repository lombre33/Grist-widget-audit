/**
 * Bilan des dépendances (E-DEP-07) : maintenues ? présumées sûres ? Un constat d'information qui dit ce qui est mesuré et ce qui ne l'est pas.
 * Aucun essai ne lance `npm audit` (réseau) : l'état de l'audit est fourni par des constats E-VULN-* construits à la main, ou par `reseau: false`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { bilanDependances } from '../src/regles/e-bilan.js';
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
const bilan = (ctx, constatsE = []) => bilanDependances(ctx, constatsE)[0];

test('sans aucune dépendance, pas de bilan', () => {
  assert.deepEqual(bilanDependances(contexte({}), []), []);
});

test("npm audit mesuré sans avis : présumée sûre, mais la régularité de maintenance reste dite non mesurée", () => {
  const c = bilan(contexte({ 'package.json': PAQUET, 'package-lock.json': VERROU(false) }), [vuln('E-VULN-02')]);
  assert.equal(c.regle, 'E-DEP-07');
  assert.equal(c.severite, 'info');
  assert.match(c.constat, /aucun avis publié .* présumés sûrs au sens des avis connus, non relus/);
  assert.match(c.constat, /aucun paquet verrouillé n'en porte/);
  assert.match(c.constat, /n'est PAS mesurée/);
  assert.match(c.constat, /ne veut donc pas dire « maintenue régulièrement »/);
  assert.equal(c.preuve.regulariteMesuree, false);
  assert.deepEqual(c.preuve.dependances.map((d) => [d.nom, d.surete.etat, d.maintenance.regularite]), [['left-pad', 'aucun-avis', 'non-mesuree'], ['vieux', 'aucun-avis', 'non-mesuree']]);
});

test("un paquet que le verrou marque déprécié est nommé ; un avis d'npm audit aussi ; le reste n'est pas déclaré sûr par défaut", () => {
  const c = bilan(contexte({ 'package.json': PAQUET, 'package-lock.json': VERROU(true) }), [vuln('E-VULN-01', { nom: 'left-pad', avis: { severity: 'high' } })]);
  assert.match(c.constat, /1 paquet verrouillé est marqué déprécié .* vieux@1\.0\.0 \(développement\)/);
  assert.match(c.constat, /avis sur left-pad \(E-VULN-01\)/);
  const parNom = Object.fromEntries(c.preuve.dependances.map((d) => [d.nom, d]));
  assert.equal(parNom.vieux.maintenance.depreciee, true);
  assert.equal(parNom['left-pad'].maintenance.depreciee, false);
  assert.deepEqual(parNom['left-pad'].surete, { etat: 'avis', gravite: 'high' });
  assert.equal(parNom.vieux.surete.etat, 'aucun-avis');
});

test("npm audit non lancé ou en échec : la sûreté est dite non établie, jamais présumée", () => {
  for (const [regle, cause] of [['E-VULN-OPTION', /--sans-reseau/], ['E-VULN-00', /n'a pas abouti/]]) {
    const c = bilan(contexte({ 'package.json': PAQUET, 'package-lock.json': VERROU(false) }), [vuln(regle)]);
    assert.match(c.constat, /Sûreté : non établie/);
    assert.match(c.constat, cause);
    assert.ok(c.preuve.dependances.every((d) => d.surete.etat === 'non-mesuree'));
    assert.doesNotMatch(c.constat, /présumés sûrs/);
  }
});

test("une bibliothèque embarquée n'est vue par aucune base d'avis ; le bilan n'ajoute ni pénalité, ni plafond, ni mesure partielle", async () => {
  const ctx = contexte({ 'package.json': PAQUET, 'package-lock.json': VERROU(false), LICENSE: 'MIT License\n' });
  const constatsE = [vuln('E-DEP-02')];
  constatsE[0].fichier = 'vendor/lib.js';
  const c = bilan(ctx, constatsE);
  assert.match(c.constat, /1 bibliothèque embarquée ou distante n'est vue par aucune base d'avis : sûreté non vérifiée/);
  assert.equal(c.mesurePartielle, false);
  assert.equal(c.bloquant, false);
  const sans = (await analyseStatique(ctx, { reseau: false })).filter((x) => x.regle !== 'E-DEP-07');
  const avec = await analyseStatique(ctx, { reseau: false });
  assert.equal(avec.filter((x) => x.regle === 'E-DEP-07').length, 1);
  const [n1, n2] = [noter(sans, new Set(['D'])), noter(avec, new Set(['D']))];
  assert.equal(n2.global, n1.global);
  assert.equal(n2.verdict, n1.verdict);
  assert.equal(n2.parAxe.E.score, n1.parAxe.E.score);
});

test('verrou illisible ou absent : aucun signal de maintenance affirmé', () => {
  const c = bilan(contexte({ 'package.json': PAQUET, 'package-lock.json': '{pas du json' }), []);
  assert.match(c.constat, /aucun signal lu : le verrou .* absent ou illisible/);
  assert.ok(c.preuve.dependances.every((d) => d.maintenance.depreciee === null));
});
