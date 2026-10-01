#!/usr/bin/env node
/**
 * Mesure ce que l'analyse statique d'un widget de gros code coûte en mémoire, par le chemin
 * réel (`analyserEnEnfant`, l'enfant à limite de src/isolement) : la taille de code au-delà de
 * laquelle l'enfant est interrompu pour une limite de tas donnée, et le pic de mémoire résidente
 * du processus. Ce sont les chiffres de docs/ARCHITECTURE-V2.md (section « Mémoire de l'analyse »),
 * et cette commande les rejoue.
 *
 * Le code mesuré est synthétique (deterministe, sans dépendance : un dialecte de code minifié dont
 * chaque construction est une entrée de l'arbre d'analyse) ou, avec `--sources`, celui de vrais
 * fichiers JavaScript enveloppés en boucle jusqu'à la taille demandée (les bundles du corpus
 * gristlabs/grist-widget). La densité de l'arbre par octet de source fait varier le seuil du simple
 * au double : ne citer un seuil qu'avec le code qui l'a donné.
 *
 * Avec `--cible <dossier>`, ce n'est plus du code fabriqué : c'est le dossier d'un vrai widget (ou d'un recueil), lu tel quel,
 * pour dire ce qu'il faut de tas à une cible honnête (`chart`, la racine de gristlabs/grist-widget) : on rejoue la mesure à
 * plusieurs `--tas` et la limite retenue se compare à la plus petite qui aboutit. Le seuil ne se lit que sur l'étape où l'enfant
 * s'arrête (`etape`) : l'inventaire du dépôt lit le contenu de tous les fichiers avant que la moindre règle ne tourne.
 *
 * Usage : node scripts/mesurer-seuil-memoire.mjs --mio 8 [--fichiers 1] [--tas 558] [--delai 900]
 *                                                [--sources a.js,b.js] [--graine 1]
 *         node scripts/mesurer-seuil-memoire.mjs --cible <dossier> [--tas 558] [--delai 900]
 *   --mio       taille de code du widget, en Mio (répartie sur `--fichiers` fichiers de même taille)
 *   --cible     un dossier existant, analysé tel quel (exclut `--mio`, `--fichiers` et `--sources`)
 *   --tas       limite du tas de l'enfant en Mio (défaut : celle que l'image donnerait sous 768 Mio)
 *   --delai     durée maximale de l'analyse, en secondes (défaut : aucune)
 * Sortie : une ligne JSON. Code de sortie 0 si l'analyse a abouti, 2 si elle a été interrompue.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyserEnEnfant } from '../src/isolement/analyse-isolee.js';
import { RESERVE_HORS_TAS_MO } from '../src/isolement/limites.js';
import { codeSynthetique } from './lib/code-synthetique.mjs';

const MIO = 1024 * 1024;

function argument(nom, defaut) {
  const i = process.argv.indexOf(`--${nom}`);
  return i === -1 ? defaut : process.argv[i + 1];
}

function code(octets, sources, fichier) {
  if (!sources.length) return codeSynthetique(octets, fichier + 1);
  const morceaux = [];
  let n = 0;
  for (let i = 0; n < octets; i++) {
    const morceau = `(function(){\n${sources[i % sources.length]}\n})(); //${fichier}.${i}\n`;
    morceaux.push(morceau);
    n += morceau.length;
  }
  return morceaux.join('');
}

const cible = argument('cible', null);
if (cible && ['mio', 'fichiers', 'sources'].some((o) => process.argv.includes(`--${o}`))) {
  console.error('--cible analyse un dossier tel quel : il ne se combine pas avec --mio, --fichiers ni --sources');
  process.exit(64);
}
if (cible && !fs.statSync(cible, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`--cible : ${cible} n'est pas un dossier`);
  process.exit(64);
}

const mio = Number(argument('mio', 4));
const fichiers = Number(argument('fichiers', 1));
const tas = Number(argument('tas', Math.max(128, 768 - RESERVE_HORS_TAS_MO)));
const delai = argument('delai', null);
const sources = argument('sources', '').split(',').filter(Boolean).map((f) => fs.readFileSync(f, 'utf8'));

const racine = cible ? path.resolve(cible) : fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-mesure-'));
try {
  let octets;
  if (cible) {
    octets = null;
  } else {
    const balises = [];
    for (let i = 0; i < fichiers; i++) {
      fs.writeFileSync(path.join(racine, `m${i}.js`), code(Math.round(mio * MIO / fichiers), sources, i));
      balises.push(`<script src="m${i}.js"></script>`);
    }
    fs.writeFileSync(path.join(racine, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${balises.join('')}</body></html>\n`);
    octets = fs.readdirSync(racine).reduce((s, f) => s + fs.statSync(path.join(racine, f)).size, 0);
  }
  const debut = Date.now();
  const r = await analyserEnEnfant({ racine, reseau: false, limites: { limiteMo: tas, pileMo: null, delaiMs: delai ? Number(delai) * 1000 : null }, relayerStderr: null });
  console.log(JSON.stringify({
    ...(cible ? { cible: path.basename(racine) } : { codeMio: Number((octets / MIO).toFixed(2)), fichiers }),
    tasMo: tas, ...(cible ? {} : { sources: sources.length ? 'fichiers fournis' : 'synthétique' }),
    abouti: r.ok, cause: r.interruption ? r.interruption.genre : null, etape: r.interruption?.etape ?? null,
    rssMaxMo: r.mesures?.rssMaxMo ?? null, dureeS: Number(((Date.now() - debut) / 1000).toFixed(1)), constats: r.ok ? r.constats.length : null,
  }));
  process.exitCode = r.ok ? 0 : 2;
} finally {
  if (!cible) fs.rmSync(racine, { recursive: true, force: true });
}
