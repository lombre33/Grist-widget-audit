#!/usr/bin/env node
/**
 * Audite chaque cible sous trois ordres de dossier (celui du système de fichiers, son contraire, et une rotation d'un cran) et dit si les trois rapports sont les mêmes : le même
 * dépôt doit donner le même rapport sur toute machine, quel que soit l'ordre où son système de fichiers rend les entrées d'un dossier (`scripts/lib/ordre-des-dossiers.mjs`).
 * Ce que `comparer-avant-apres.mjs` ne peut pas voir : deux versions de l'outil, sur une même machine, lisent les dossiers dans le même ordre.
 *
 * Usage :
 *   node scripts/comparer-ordre-des-dossiers.mjs [--racine <racine>] [--sortie <dossier>] <cible>…
 *
 *   --racine   racine de la version de l'outil à mesurer (par défaut ce dépôt) : `git worktree add --detach <dossier> <commit>`, puis un lien `node_modules` vers celui de ce dépôt
 *   --sortie   garde les rapports JSON de chaque cible dans ce dossier (`<nom>/<ordre>/`) ; sinon un dossier temporaire, supprimé à la fin
 *
 * Les axes statiques seulement (`--sans-dynamique --sans-reseau`). Une cible par argument. Un audit qui échoue arrête tout (code 1).
 * Sortie : une ligne par cible (`=` si les trois rapports sont identiques, `≠` sinon) avec, pour chaque ordre qui diffère du naturel, les notes et les constats qui changent,
 * puis le nombre de cibles dont le rapport change. Code 0 : la comparaison est faite, elle ne juge pas.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { comparerRapports } from './lib/comparer-rapports.mjs';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DEPOT = path.resolve(ICI, '..');
const HOOK = path.join(ICI, 'lib', 'ordre-des-dossiers.mjs');
const ORDRES = ['naturel', 'inverse', 'tourne'];
const DELAI_MS = 15 * 60 * 1000;

const { values, positionals } = parseArgs({
  options: { racine: { type: 'string', default: DEPOT }, sortie: { type: 'string' } },
  allowPositionals: true,
});
if (!positionals.length) {
  console.error('Usage : node scripts/comparer-ordre-des-dossiers.mjs [--racine <racine>] [--sortie <dossier>] <cible>…');
  process.exit(2);
}
if (!fs.existsSync(path.join(values.racine, 'bin', 'gwaudit.js'))) {
  console.error(`--racine : ${values.racine} n'est pas la racine de l'outil (bin/gwaudit.js introuvable).`);
  process.exit(2);
}
for (const cible of positionals) {
  if (!fs.existsSync(cible)) { console.error(`Cible introuvable : ${cible}`); process.exit(2); }
}

const sortie = values.sortie ? path.resolve(values.sortie) : fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-ordre-'));
fs.mkdirSync(sortie, { recursive: true });
const nettoyer = () => { if (!values.sortie) fs.rmSync(sortie, { recursive: true, force: true }); };

function auditer(cible, ordre, dossier) {
  fs.rmSync(dossier, { recursive: true, force: true });
  fs.mkdirSync(dossier, { recursive: true });
  const args = ['--import', HOOK, path.join(values.racine, 'bin', 'gwaudit.js'), path.resolve(cible), '--json', '--sortie', dossier, '--sans-dynamique', '--sans-reseau'];
  try {
    execFileSync('node', args, { cwd: values.racine, env: { ...process.env, GWAUDIT_ORDRE_FS: ordre }, stdio: ['ignore', 'pipe', 'pipe'], timeout: DELAI_MS, maxBuffer: 1 << 26 });
  } catch (e) {
    // Le code de sortie de l'outil suit le verdict : seul un rapport absent est un échec.
    if (!fs.existsSync(path.join(dossier, 'rapport.json'))) throw new Error(`audit de ${cible} sous l'ordre « ${ordre} » : ${String(e.stderr ?? e.message).slice(0, 500)}`);
  }
  return JSON.parse(fs.readFileSync(path.join(dossier, 'rapport.json'), 'utf8'));
}

const decompte = (liste) => liste.reduce((n, d) => n + d.n, 0);
let code = 0;
try {
  const noms = new Set();
  let different = 0;
  for (const cible of positionals) {
    let nom = path.basename(path.resolve(cible));
    for (let i = 2; noms.has(nom); i++) nom = `${path.basename(path.resolve(cible))}-${i}`;
    noms.add(nom);

    const rapports = Object.fromEntries(ORDRES.map((ordre) => [ordre, auditer(cible, ordre, path.join(sortie, nom, ordre))]));
    const ecarts = ORDRES.slice(1).map((ordre) => [ordre, comparerRapports(rapports.naturel, rapports[ordre])]).filter(([, r]) => !r.identique);
    if (ecarts.length) different++;

    console.log(`${ecarts.length ? '≠' : '='} ${nom.padEnd(28)} ${rapports.naturel.verdict} ${rapports.naturel.scoreGlobal}`);
    for (const [ordre, r] of ecarts) {
      console.log(`    ${ordre} : notes ${r.notesAvant} → ${r.notesApres} ; constats ${r.constatsAvant} → ${r.constatsApres} (−${decompte(r.retires)} +${decompte(r.ajoutes)} ~${r.textes.length})`);
      for (const d of r.retires) console.log(`      − ${d.cle}${d.n > 1 ? ` ×${d.n}` : ''}`);
      for (const d of r.ajoutes) console.log(`      + ${d.cle}${d.n > 1 ? ` ×${d.n}` : ''}`);
      for (const d of r.textes) console.log(`      ~ ${d.cle} : ${d.champs.join(', ')}`);
    }
  }
  console.log(`\n${positionals.length} cibles, ${different} dont le rapport change avec l'ordre des dossiers (outil : ${values.racine})`);
} catch (e) {
  console.error(e.message);
  code = 1;
} finally {
  nettoyer();
}
process.exit(code);
