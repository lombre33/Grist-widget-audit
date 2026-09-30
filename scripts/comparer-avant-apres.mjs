#!/usr/bin/env node
/**
 * Compare l'audit de deux versions de l'outil sur les mêmes cibles : la mesure
 * qu'un changement partagé doit fournir, axe par axe et constat par constat,
 * avant d'être annoncé (voir `scripts/lib/comparer-rapports.mjs` pour ce qui
 * est comparé).
 *
 * Usage :
 *   node scripts/comparer-avant-apres.mjs --avant <racine> [--apres <racine>] [--dynamique] [--sortie <dossier>] <cible>…
 *
 *   --avant      racine d'une autre version de l'outil : `git worktree add --detach <dossier> <commit>`, puis un lien
 *                `node_modules` vers celui de ce dépôt
 *   --apres      racine de la version à mesurer (par défaut ce dépôt)
 *   --dynamique  garde l'axe D et le réseau (GWAUDIT_CHROMIUM_PATH si Chromium n'est pas trouvé) ; sinon
 *                `--sans-dynamique --sans-reseau` : les cinq autres axes seulement
 *   --sortie     garde les rapports JSON de chaque cible dans ce dossier (`<nom>-avant/`, `<nom>-apres/`) ; sinon un
 *                dossier temporaire, supprimé à la fin
 *
 * Une cible par argument (le dépôt d'un widget, ou le dépôt d'un recueil puis chacun de ses sous-dossiers). Un audit qui
 * échoue arrête tout (code 1) : un audit qui plante n'est pas un audit identique.
 * Sortie : une ligne par cible (`=` si notes et constats sont identiques, `≠` sinon), le détail de ce qui diffère,
 * puis les totaux. Code 0 : la comparaison est faite, elle ne juge pas.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { comparerRapports } from './lib/comparer-rapports.mjs';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DELAI_MS = 15 * 60 * 1000;

const { values, positionals } = parseArgs({
  options: {
    avant: { type: 'string' },
    apres: { type: 'string', default: RACINE },
    dynamique: { type: 'boolean', default: false },
    sortie: { type: 'string' },
  },
  allowPositionals: true,
});
if (!values.avant || !positionals.length) {
  console.error('Usage : node scripts/comparer-avant-apres.mjs --avant <racine> [--apres <racine>] [--dynamique] [--sortie <dossier>] <cible>…');
  process.exit(2);
}
for (const [nom, racine] of [['avant', values.avant], ['apres', values.apres]]) {
  if (!fs.existsSync(path.join(racine, 'bin', 'gwaudit.js'))) {
    console.error(`--${nom} : ${racine} n'est pas la racine de l'outil (bin/gwaudit.js introuvable).`);
    process.exit(2);
  }
}
for (const cible of positionals) {
  if (!fs.existsSync(cible)) { console.error(`Cible introuvable : ${cible}`); process.exit(2); }
}

const sortie = values.sortie ? path.resolve(values.sortie) : fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-comparer-'));
fs.mkdirSync(sortie, { recursive: true });
const nettoyer = () => { if (!values.sortie) fs.rmSync(sortie, { recursive: true, force: true }); };
// Aucun gestionnaire de signal : tout le travail est synchrone (`execFileSync`), un gestionnaire ne s'exécuterait qu'à la fin et `kill` n'arrêterait plus rien.
// Un script tué laisse son dossier temporaire (`gwaudit-comparer-*`) ; `--sortie` donne un dossier qu'on garde et qu'on retire soi-même.

function auditer(racine, cible, dossier) {
  fs.rmSync(dossier, { recursive: true, force: true });
  fs.mkdirSync(dossier, { recursive: true });
  const args = [path.join(racine, 'bin', 'gwaudit.js'), path.resolve(cible), '--json', '--sortie', dossier, ...(values.dynamique ? [] : ['--sans-dynamique', '--sans-reseau'])];
  try {
    execFileSync('node', args, { cwd: racine, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: DELAI_MS, maxBuffer: 1 << 26 });
  } catch (e) {
    // Le code de sortie de l'outil suit le verdict : seul un rapport absent est un échec.
    if (!fs.existsSync(path.join(dossier, 'rapport.json'))) throw new Error(`audit de ${cible} par ${racine} : ${String(e.stderr ?? e.message).slice(0, 500)}`);
  }
  return JSON.parse(fs.readFileSync(path.join(dossier, 'rapport.json'), 'utf8'));
}

let code = 0;
try {
  const noms = new Set();
  const totaux = { cibles: 0, notes: 0, constats: 0, avant: 0, apres: 0, retires: 0, ajoutes: 0, textes: 0 };
  for (const cible of positionals) {
    let nom = path.basename(path.resolve(cible));
    for (let i = 2; noms.has(nom); i++) nom = `${path.basename(path.resolve(cible))}-${i}`;
    noms.add(nom);

    const avant = auditer(values.avant, cible, path.join(sortie, `${nom}-avant`));
    const apres = auditer(values.apres, cible, path.join(sortie, `${nom}-apres`));
    const r = comparerRapports(avant, apres);

    totaux.cibles++;
    totaux.avant += r.constatsAvant;
    totaux.apres += r.constatsApres;
    if (!r.notesIdentiques) totaux.notes++;
    if (r.retires.length || r.ajoutes.length || r.textes.length) totaux.constats++;
    totaux.retires += r.retires.reduce((n, d) => n + d.n, 0);
    totaux.ajoutes += r.ajoutes.reduce((n, d) => n + d.n, 0);
    totaux.textes += r.textes.length;

    console.log(`${r.identique ? '=' : '≠'} ${nom.padEnd(28)} avant ${r.notesAvant} | après ${r.notesApres}`);
    if (r.constatsAvant !== r.constatsApres || !r.identique) console.log(`    constats : ${r.constatsAvant} → ${r.constatsApres}`);
    for (const d of r.retires) console.log(`    − ${d.cle}${d.n > 1 ? ` ×${d.n}` : ''}`);
    for (const d of r.ajoutes) console.log(`    + ${d.cle}${d.n > 1 ? ` ×${d.n}` : ''}`);
    for (const d of r.textes) console.log(`    ~ ${d.cle} : ${d.champs.join(', ')}`);
  }
  console.log(`\n${totaux.cibles} cibles ; constats comparés : ${totaux.avant} avant, ${totaux.apres} après`);
  console.log(`cibles aux notes différentes : ${totaux.notes} ; aux constats différents : ${totaux.constats} (${totaux.retires} retiré(s), ${totaux.ajoutes} ajouté(s), ${totaux.textes} au texte modifié)`);
} catch (e) {
  console.error(e.message);
  code = 1;
} finally {
  nettoyer();
}
process.exit(code);
