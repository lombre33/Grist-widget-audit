#!/usr/bin/env node
/**
 * Balaie l'analyse statique avec des widgets dont un fichier n'est pas lu par l'inventaire : un texte d'un octet au-delà du plafond de lecture par fichier
 * (ramené à 2 000 octets pour l'essai, au lieu de 16 Mio), ou un binaire. Une règle qui lit le texte d'un fichier sans vérifier qu'il existe fait lever
 * une exception : `statique.js` n'attrape rien, l'analyse s'arrête et le programme sort sans rapport. Chaque widget est un petit widget valide (`index.html`,
 * `app.js`, `style.css`) dont UN fichier est celui que l'inventaire ne lit pas, sous chacun des noms connus des règles (README, licence, manifestes,
 * verrous, dossiers `vendor/`, tests, `dist/`…) et de chacune des façons de le référencer depuis la page ou le code (balise `<script>`, `<iframe>`,
 * `new Worker`, `@import`, import map…). Les tables sont celles des essais : `scripts/lib/pieges.mjs`.
 *
 * Il rend le nombre de widgets éprouvés, puis chaque cause d'échec (le message de l'exception et la ligne de `src/` qui l'a levée) avec les cas qui
 * y mènent : un balayage qui ne trouve rien le dit. Il sort avec le code 1 quand une cause est trouvée.
 *
 * Usage : node scripts/balayer-fichiers-non-lus.mjs [--racine <dossier>] [--plafond <octets>] [--liste] [sous-chaîne du nom…]
 *   --racine   racine d'une autre version de l'outil (worktree) : le même balayage, deux versions, ce que le correctif a fermé
 *   --plafond  le plafond de lecture par fichier (2 000 octets par défaut) ; le fichier non lu en fait un de plus
 *   --liste    compte les widgets sans rien lancer
 *   un nom, ou un morceau de nom : seuls les fichiers dont le nom le contient (`LICENSE`, `README`, `vendor/`)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NOMS_DE_FICHIERS_NON_LUS, FORMES_DE_REFERENCE, NATURES_NON_LUES, widgetAvecFichierNonLu } from './lib/pieges.mjs';

const ICI = fileURLToPath(import.meta.url);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { racine: { type: 'string' }, plafond: { type: 'string' }, liste: { type: 'boolean' } },
});
const racine = path.resolve(values.racine ?? path.join(path.dirname(ICI), '..'));
const plafond = Number(values.plafond ?? 2000);
const EXTENSIONS_BINAIRES = /\.(pdf|png|wasm|woff2)$/;

/** Les widgets à éprouver : `[nom, forme, nature]`. Un binaire se joue sous un nom d'extension de binaire, un texte sous tous les noms. */
const cas = NOMS_DE_FICHIERS_NON_LUS
  .filter((nom) => !positionals.length || positionals.some((p) => nom.includes(p)))
  .flatMap((nom) => Object.keys(FORMES_DE_REFERENCE).flatMap((forme) => NATURES_NON_LUES
    .filter((nature) => nature === 'texte' || EXTENSIONS_BINAIRES.test(nom))
    .map((nature) => [nom, forme, nature])));

if (values.liste) {
  console.log(`${cas.length} widgets : ${NOMS_DE_FICHIERS_NON_LUS.length} noms, ${Object.keys(FORMES_DE_REFERENCE).length} façons de référencer le fichier`);
  process.exit(0);
}

const { construireContexte } = await import(pathToFileURL(path.join(racine, 'src/contexte/inventaire.js')).href);
const { analyseStatique } = await import(pathToFileURL(path.join(racine, 'src/moteur/statique.js')).href);

const echecs = new Map();
for (const [nom, forme, nature] of cas) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-non-lus-'));
  try {
    for (const [fichier, contenu] of Object.entries(widgetAvecFichierNonLu(nom, forme, nature, plafond + 1))) {
      fs.mkdirSync(path.dirname(path.join(dossier, fichier)), { recursive: true });
      fs.writeFileSync(path.join(dossier, fichier), contenu);
    }
    await analyseStatique(construireContexte(dossier, { maxOctetsFichier: plafond }), { reseau: false });
  } catch (e) {
    const lieu = String(e.stack).split('\n').find((ligne) => /src[\\/]/.test(ligne))?.trim().replace(/^.*[\\/]src[\\/]/, 'src/').replace(/\)$/, '');
    const cle = `${e.constructor.name}: ${String(e.message).slice(0, 100)} @ ${lieu ?? '?'}`;
    if (!echecs.has(cle)) echecs.set(cle, []);
    echecs.get(cle).push(`${nom}/${forme}/${nature}`);
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}

console.log(`${cas.length} widgets éprouvés (plafond de lecture ${plafond} octets) ; ${echecs.size} cause(s) d'échec`);
for (const [cle, liste] of echecs) console.log(`\n${liste.length} cas : ${cle}\n   ${liste.slice(0, 8).join(', ')}${liste.length > 8 ? ', …' : ''}`);
process.exitCode = echecs.size ? 1 : 0;
