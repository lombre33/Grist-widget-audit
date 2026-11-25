/**
 * E-VULN-03 (avis OSV sur une bibliothèque chargée de loin, nom et version exacts) et E-VULN-04 (paquet signalé malveillant par OSV).
 * Aucun essai n'atteint le réseau : OSV est une fonction d'essai. Les formes des réponses (requête groupée, avis GHSA et MAL-…) sont celles qu'OSV publie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { bilanDependances } from '../src/regles/e-bilan.js';
import { interrogerOsv, constatsOsv, cleDe } from '../src/regles/e-osv.js';
import { constat } from '../src/moteur/modele.js';
import { preuveDeChargement } from '../src/moteur/bibliotheque.js';

const GHSA = { id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command Injection in lodash', aliases: ['CVE-2021-23337'], database_specific: { severity: 'HIGH' }, severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }] };
const MAL = { id: 'MAL-2025-1', summary: 'Malicious code in 029testnpm (npm)', database_specific: { 'malicious-packages-origins': [] } };
const reponse = (corps, ok = true, status = 200) => ({ ok, status, json: async () => corps });
/** Un OSV d'essai : `groupee` est la réponse de la requête groupée, `details` les avis lus un à un ; il note ce qu'on lui demande. */
function faux({ groupee, details = {} }) {
  const appels = [];
  const f = async (url, options = {}) => {
    appels.push({ url, corps: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/v1/querybatch')) { if (groupee instanceof Error) throw groupee; return reponse(groupee); }
    const id = decodeURIComponent(url.split('/v1/vulns/')[1]);
    return id in details ? reponse(details[id]) : reponse({}, false, 404);
  };
  f.appels = appels;
  return f;
}

test("interrogerOsv : une requête groupée en npm avec la version, puis le détail de chaque avis distinct, les paquets malveillants lus d'abord", async () => {
  const f = faux({ groupee: { results: [{ vulns: [{ id: GHSA.id, modified: '2026-10-17T02:55:38Z' }] }, {}, { vulns: [{ id: MAL.id }, { id: GHSA.id }] }] }, details: { [GHSA.id]: GHSA, [MAL.id]: MAL } });
  const { lus, erreur } = await interrogerOsv([{ nom: 'lodash', version: '4.17.4' }, { nom: 'react', version: '18.3.1' }, { nom: '029testnpm', version: '1.0.0' }], f);
  assert.equal(erreur, null);
  assert.deepEqual(f.appels[0].corps, { queries: [{ package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.4' }, { package: { name: 'react', ecosystem: 'npm' }, version: '18.3.1' }, { package: { name: '029testnpm', ecosystem: 'npm' }, version: '1.0.0' }] });
  assert.ok(f.appels[1].url.endsWith(MAL.id), 'le paquet malveillant est lu avant les autres');
  assert.equal(f.appels.length, 3, 'un détail par avis distinct, pas par paquet');
  assert.deepEqual(lus.get(cleDe('lodash', '4.17.4')), [{ id: GHSA.id, resume: 'Command Injection in lodash', gravite: 'high', malveillant: false }]);
  assert.equal(lus.has(cleDe('react', '18.3.1')), false, 'aucun avis : absent');
  assert.deepEqual(lus.get(cleDe('029testnpm', '1.0.0')).map((a) => [a.id, a.malveillant]), [[MAL.id, true], [GHSA.id, false]]);
});

test("interrogerOsv : injoignable, réponse qui n'a pas la taille de la demande, détail illisible, avis retiré et identifiant étrange", async () => {
  const demande = [{ nom: 'a', version: '1.0.0' }, { nom: 'b', version: '1.0.0' }];
  assert.equal((await interrogerOsv(demande, faux({ groupee: new Error('réseau coupé') }))).erreur, 'injoignable');
  assert.equal((await interrogerOsv(demande, async () => reponse({}, false, 403))).erreur, 'injoignable');
  assert.equal((await interrogerOsv(demande, faux({ groupee: { results: [{}] } }))).erreur, 'illisible', 'un décalage attribuerait un avis à un autre paquet');
  assert.equal((await interrogerOsv(demande, faux({ groupee: 'pas du JSON attendu' }))).erreur, 'illisible');
  // Le détail d'un avis manque : l'avis reste connu par son identifiant, sa gravité non. Un avis retiré et un identifiant étrange sont écartés.
  const f = faux({ groupee: { results: [{ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }, { id: 'GHSA-retire' }, { id: '<img src=x onerror=1>' }] }, {}] }, details: { 'GHSA-retire': { ...GHSA, id: 'GHSA-retire', withdrawn: '2026-01-01T00:00:00Z' } } });
  const { lus, erreur } = await interrogerOsv(demande, f);
  assert.equal(erreur, null);
  assert.deepEqual(lus.get(cleDe('a', '1.0.0')), [{ id: 'GHSA-aaaa-bbbb-cccc', resume: '', gravite: 'inconnue', malveillant: false }]);
});

test("constatsOsv : un avis haut sur une bibliothèque chargée de loin est critique et bloquant comme npm audit, un avis modéré majeur ; un paquet malveillant est critique et bloquant ; l'avis ordinaire d'un paquet verrouillé reste à npm audit", () => {
  const lus = new Map([
    [cleDe('lodash', '4.17.4'), [{ id: GHSA.id, resume: 'Command Injection in lodash', gravite: 'high', malveillant: false }]],
    [cleDe('moyen', '1.0.0'), [{ id: 'GHSA-m', resume: 'ReDoS', gravite: 'moderate', malveillant: false }]],
    [cleDe('inconnu', '1.0.0'), [{ id: 'GHSA-i', resume: '', gravite: 'inconnue', malveillant: false }]],
    [cleDe('029testnpm', '1.0.0'), [{ id: MAL.id, resume: 'Malicious code in 029testnpm (npm)', gravite: 'inconnue', malveillant: true }]],
    [cleDe('verrouille', '2.0.0'), [{ id: 'GHSA-v', resume: 'Prototype pollution', gravite: 'critical', malveillant: false }]],
  ]);
  const paquets = [
    { nom: 'lodash', version: '4.17.4', origine: 'distante', hote: 'esm.sh', fichier: 'index.html', ligne: 7 },
    { nom: 'moyen', version: '1.0.0', origine: 'distante', hote: 'unpkg.com' },
    { nom: 'inconnu', version: '1.0.0', origine: 'distante', hote: 'unpkg.com' },
    { nom: '029testnpm', version: '1.0.0', origine: 'verrou' },
    { nom: 'verrouille', version: '2.0.0', origine: 'verrou' },
  ];
  const r = constatsOsv(paquets, lus);
  const resume = r.map((c) => `${c.regle} ${c.preuve.nom} ${c.severite}${c.bloquant ? ' bloquant' : ''}`);
  assert.deepEqual(resume, ['E-VULN-03 lodash critique bloquant', 'E-VULN-03 moyen majeur', 'E-VULN-03 inconnu mineur', 'E-VULN-04 029testnpm critique bloquant']);
  assert.equal(r[0].fichier, 'index.html');
  assert.equal(r[0].ligne, 7);
  assert.match(r[0].constat, /GHSA-35jh-r3h4-6jhm \(high\) — Command Injection in lodash/);
  assert.equal(r[0].preuve.avis[0].lien, 'https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm');
  assert.equal(r[3].fichier, 'package-lock.json');
});

test("bilanDependances : OSV est interrogé sur les bibliothèques chargées de loin à version exacte et sur les paquets verrouillés ; les noms hors npm, les versions flottantes et --sans-reseau n'y vont pas", async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-osv-'));
  const PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>w</title></head><body><main><h1>w</h1></main></body></html>';
  fs.writeFileSync(path.join(dossier, 'index.html'), PAGE);
  fs.writeFileSync(path.join(dossier, 'package.json'), JSON.stringify({ name: 'w', version: '1.0.0', dependencies: { propre: '1.0.0', pirate: '1.0.0' } }));
  fs.writeFileSync(path.join(dossier, 'package-lock.json'), JSON.stringify({ name: 'w', lockfileVersion: 3, packages: {
    '': { name: 'w' },
    'node_modules/propre': { version: '1.0.0', resolved: 'https://registry.npmjs.org/propre/-/propre-1.0.0.tgz' },
    'node_modules/pirate': { version: '1.0.0', resolved: 'https://registry.npmjs.org/pirate/-/pirate-1.0.0.tgz' },
    'node_modules/propre/node_modules/imbrique': { version: '2.1.0' },
    'node_modules/ailleurs': { version: '1.0.0', resolved: 'git+ssh://git@exemple.org/ailleurs.git' },
    'node_modules/lien': { resolved: '../lien', link: true },
    'node_modules/alias': { name: 'vrai-nom', version: '3.0.0' },
  } }));
  const ctx = construireContexte(dossier);
  const chargement = (adresse) => constat({ regle: 'E-DEP-01', axe: 'E', severite: 'critique', titre: 't', constat: 'c', fichier: 'index.html', ligne: 4, preuve: preuveDeChargement(adresse) });
  const constatsE = [chargement('https://esm.sh/lodash@4.17.4'), chargement('https://esm.sh/react@^18'), chargement('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js'), chargement('https://cdn.jsdelivr.net/gh/o/d@1.0.0/x.js')];
  const lire = async () => new Map();
  const demandes = [];
  const osv = async (paires) => { demandes.push(paires.map((p) => cleDe(p.nom, p.version))); return { erreur: null, lus: new Map([[cleDe('lodash', '4.17.4'), [{ id: GHSA.id, resume: 'Command Injection in lodash', gravite: 'high', malveillant: false }]], [cleDe('pirate', '1.0.0'), [{ id: MAL.id, resume: 'Malicious code in pirate', gravite: 'inconnue', malveillant: true }]]]) }; };
  const r = await bilanDependances(ctx, constatsE, { reseau: true }, lire, osv);
  assert.deepEqual(demandes, [['lodash@4.17.4', 'propre@1.0.0', 'pirate@1.0.0', 'imbrique@2.1.0', 'vrai-nom@3.0.0']]);
  assert.deepEqual(r.map((c) => c.regle), ['E-DEP-07', 'E-VULN-03', 'E-VULN-04']);
  assert.match(r[0].constat, /OSV\.dev interrogé sur 1 bibliothèque chargée de loin et 4 paquets verrouillés : 1 avis, 1 paquet malveillant/);
  assert.equal(r[0].preuve.osv.etat, 'interroge');
  // --sans-reseau : OSV n'est pas appelé, et E-DEP-07 le dit.
  const coupe = await bilanDependances(ctx, constatsE, { reseau: false }, lire, async () => { throw new Error('OSV ne doit pas être lu'); });
  assert.deepEqual(coupe.map((c) => c.regle), ['E-DEP-07']);
  assert.match(coupe[0].constat, /OSV\.dev n'a pas été interrogé : audit lancé avec --sans-reseau/);
  // OSV ne répond pas : « non mesurée », jamais « aucun avis ».
  const muet = await bilanDependances(ctx, constatsE, { reseau: true }, lire, async () => ({ erreur: 'injoignable', lus: new Map() }));
  assert.deepEqual(muet.map((c) => c.regle), ['E-DEP-07']);
  assert.match(muet[0].constat, /OSV\.dev n'a pas répondu \(injoignable\) : sûreté non mesurée/);
  assert.equal(muet[0].preuve.osv.etat, 'injoignable');
});
