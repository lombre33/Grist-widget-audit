#!/usr/bin/env node
/**
 * Rejoue les mutants de l'épinglage des images de base (les Dockerfile de docker/) :
 * chaque façon de laisser une image repointable est gardée par
 * `tests/images-epinglees.test.mjs` (méthode : `scripts/lib/rejouer-mutants.mjs`).
 * Pas de Chromium requis.
 *
 * Usage : node scripts/mutants-images.mjs [expression régulière sur le libellé]
 */
import { lireArguments, rejouerMutants, DOSSIERS_COPIES } from './lib/rejouer-mutants.mjs';

const P = 'docker/egress-proxy/Dockerfile';
const E = 'docker/execution/Dockerfile';
const TESTS = ['tests/images-epinglees.test.mjs'];
const PROXY = 'FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251';
const ARG = 'ARG BASE_IMAGE=mcr.microsoft.com/playwright:v1.63.0-jammy@sha256:167d0506cfbe3c294fb214b2d11737326eeee028aa611fa1ba538e5057675847';

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  [P, PROXY, 'FROM debian:bookworm-slim', 'proxy : étiquette seule'],
  [P, PROXY, 'FROM debian:latest', 'proxy : latest'],
  [P, PROXY, PROXY.slice(0, PROXY.length - 8), 'proxy : empreinte tronquée'],
  [P, PROXY, PROXY.replace('@sha256:', '@md5:'), 'proxy : autre algorithme'],
  [E, ARG, ARG.replace(/@sha256:[0-9a-f]{64}/, ''), "exécution : valeur par défaut de BASE_IMAGE sans empreinte"],
  [E, ARG, 'ARG BASE_IMAGE', 'exécution : plus de valeur par défaut'],
  [E, 'FROM ${BASE_IMAGE}', 'FROM node:22-alpine', "exécution : image littérale sans empreinte"],
];
const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants[0] ? new RegExp(restants[0]) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').slice(-2).join('/')}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests images', fichiers: TESTS }],
  exigerChromium: false,
  dossiers: [...DOSSIERS_COPIES, 'docker'],
  partie,
});
