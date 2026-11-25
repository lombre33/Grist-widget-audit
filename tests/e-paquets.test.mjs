/**
 * E-DEP-08 (paquet introuvable au registre), E-DEP-09 (créé il y a moins de 90 jours), E-DEP-10 (version publiée il y a moins de 7 jours).
 * Aucun essai n'atteint le réseau : la lecture du registre est une fonction d'essai, comme pour E-DEP-07.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { bilanDependances } from '../src/regles/e-bilan.js';
import { constat } from '../src/moteur/modele.js';
import { preuveDeChargement } from '../src/moteur/bibliotheque.js';

const PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>w</title></head><body><main><h1>w</h1></main></body></html>';
function contexte(fichiers) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-paquets-'));
  for (const [nom, contenu] of Object.entries({ 'index.html': PAGE, ...fichiers })) fs.writeFileSync(path.join(dossier, nom), contenu);
  return construireContexte(dossier);
}
const paquet = (dependencies) => JSON.stringify({ name: 'w', version: '1.0.0', dependencies });
const verrou = (versions) => JSON.stringify({ name: 'w', lockfileVersion: 3, packages: { '': { name: 'w' }, ...Object.fromEntries(Object.entries(versions).map(([n, v]) => [`node_modules/${n}`, { version: v }])) } });
const ilYAJours = (jours) => new Date(Date.now() - jours * 24 * 3600 * 1000).toISOString();
/** Un paquet du registre : créé il y a `creeJours`, avec ses versions publiées il y a tant de jours. */
const existe = (creeJours, versions = { '1.0.0': creeJours }) => ({ time: { created: ilYAJours(creeJours), modified: ilYAJours(0), ...Object.fromEntries(Object.entries(versions).map(([v, j]) => [v, ilYAJours(j)])) }, latest: Object.keys(versions).at(-1) });
const INTROUVABLE = { erreur: 'introuvable' };
/** Une lecture du registre qui rend ce qu'on lui donne, et note ce qu'on lui a demandé. */
const registre = (reponses) => { const appels = []; const lire = async (noms) => { appels.push(noms); return new Map(noms.filter((n) => n in reponses).map((n) => [n, reponses[n]])); }; lire.appels = appels; return lire; };
const chargement = (adresse) => constat({ regle: 'E-DEP-01', axe: 'E', severite: 'critique', titre: 't', constat: 'c', fichier: 'index.html', ligne: 3, preuve: preuveDeChargement(adresse) });
const regles = (constats) => constats.map((c) => c.regle);
const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''} ${c.confiance}`;

test("E-DEP-08 : un nom que le registre ne connaît pas est « majeur probable » (« mineur à vérifier » pour un nom à portée), jamais bloquant, et le paquet qui existe n'est pas nommé", async () => {
  const lire = registre({ 'paquet-invente': INTROUVABLE, '@acme/prive': INTROUVABLE, 'vrai': existe(2000) });
  const ctx = contexte({ 'package.json': paquet({ 'paquet-invente': '^1.0.0', '@acme/prive': '1.0.0', vrai: '1.0.0' }) });
  const r = await bilanDependances(ctx, [], { reseau: true }, lire);
  const [c, ...autres] = r.filter((x) => x.regle === 'E-DEP-08');
  assert.equal(autres.length, 0);
  assert.equal(etat(c), 'majeur probable');
  assert.equal(c.fichier, 'package.json');
  assert.deepEqual(c.preuve.paquets.map((p) => p.nom), ['paquet-invente', '@acme/prive']);
  assert.doesNotMatch(c.titre, /vrai/);
  // Un nom à portée seul : un paquet privé est plausible, le constat est mineur à vérifier.
  const seul = await bilanDependances(contexte({ 'package.json': paquet({ '@acme/prive': '1.0.0', vrai: '1.0.0' }) }), [], { reseau: true }, registre({ '@acme/prive': INTROUVABLE, vrai: existe(2000) }));
  assert.equal(etat(seul.find((x) => x.regle === 'E-DEP-08')), 'mineur a_verifier');
});

test("E-DEP-08 : un registre qui répond « introuvable » à tout n'est pas cru (le paquet témoin n'existe pas non plus) ; un registre qui connaît le témoin est cru", async () => {
  const ctx = contexte({ 'package.json': paquet({ 'paquet-invente': '1.0.0' }) });
  const incroyable = registre({ 'paquet-invente': INTROUVABLE, lodash: INTROUVABLE });
  assert.deepEqual(regles(await bilanDependances(ctx, [], { reseau: true }, incroyable)), ['E-DEP-07']);
  assert.deepEqual(incroyable.appels, [['paquet-invente'], ['lodash']], 'le témoin est demandé une fois, après la première lecture');
  const credible = registre({ 'paquet-invente': INTROUVABLE, lodash: existe(5000) });
  assert.deepEqual(regles(await bilanDependances(ctx, [], { reseau: true }, credible)), ['E-DEP-07', 'E-DEP-08']);
});

test("E-DEP-09 et E-DEP-10 : un paquet créé il y a moins de 90 jours, une version publiée il y a moins de 7 jours ; un paquet installé par plage sans verrou n'a pas de version datée", async () => {
  const lire = registre({
    neuf: existe(30),                                              // créé il y a 30 jours, sa version 1.0.0 aussi
    frais: existe(900, { '1.0.0': 900, '1.1.0': 2 }),               // ancien, mais la version verrouillée date d'avant-hier
    sage: existe(900, { '1.0.0': 900, '1.1.0': 20 }),               // ancien, version verrouillée de 20 jours
    plage: existe(900, { '1.0.0': 900, '1.1.0': 1 }),               // la plage `^1.0.0` irait chercher 1.1.0, mais aucune version n'est verrouillée
  });
  const ctx = contexte({
    'package.json': paquet({ neuf: '1.0.0', frais: '1.1.0', sage: '1.1.0', plage: '^1.0.0' }),
    'package-lock.json': verrou({ neuf: '1.0.0', frais: '1.1.0', sage: '1.1.0' }),
  });
  const r = await bilanDependances(ctx, [], { reseau: true }, lire);
  assert.deepEqual(regles(r), ['E-DEP-07', 'E-DEP-09', 'E-DEP-10']);
  const [, neuf, recente] = r;
  assert.equal(etat(neuf), 'mineur a_verifier');
  assert.deepEqual(neuf.preuve.paquets.map((p) => p.nom), ['neuf']);
  assert.equal(neuf.preuve.paquets[0].ageJours, 30);
  assert.equal(etat(recente), 'mineur a_verifier');
  assert.deepEqual(recente.preuve.versions.map((v) => `${v.nom}@${v.version}`), ['frais@1.1.0']);
});

test("les bibliothèques chargées de loin sous un nom npm (esm.sh, unpkg) sont lues au registre ; cdnjs, gh/ et jsr/ ne le sont pas", async () => {
  const lire = registre({ 'react-domm': INTROUVABLE, frais: existe(900, { '2.0.0': 1 }), react: existe(5000, { '18.3.1': 700 }), lodash: existe(5000) });
  const constatsE = [
    chargement('https://esm.sh/react-domm@18.3.1/client'),
    chargement('https://unpkg.com/frais@2.0.0/dist/frais.js'),
    chargement('https://esm.sh/react@18.3.1'),
    chargement('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js'),
    chargement('https://cdn.jsdelivr.net/gh/proprietaire/depot@1.0.0/x.js'),
    chargement('https://esm.sh/jsr/@std/path@1.0.0'),
    chargement('https://exemple.org/lib.js'),
  ];
  const r = await bilanDependances(contexte({}), constatsE, { reseau: true }, lire);
  assert.deepEqual(lire.appels[0].sort(), ['frais', 'react', 'react-domm']);
  assert.deepEqual(regles(r), ['E-DEP-07', 'E-DEP-08', 'E-DEP-10']);
  assert.match(r[1].constat, /react-domm \(chargé depuis esm\.sh\)/);
  assert.equal(r[1].fichier, 'index.html');
  assert.match(r[2].titre, /frais@2\.0\.0/);
});

test("--sans-reseau : le registre n'est pas lu et aucun de ces constats n'est produit", async () => {
  const ctx = contexte({ 'package.json': paquet({ 'paquet-invente': '1.0.0' }) });
  const r = await bilanDependances(ctx, [chargement('https://esm.sh/react-domm@18.3.1')], { reseau: false }, async () => { throw new Error('le registre ne doit pas être lu'); });
  assert.deepEqual(regles(r), ['E-DEP-07']);
});
