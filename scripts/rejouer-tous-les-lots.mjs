#!/usr/bin/env node
/**
 * Rejoue tous les lots de mutants (`scripts/mutants-*.mjs`), plusieurs processus à la fois, et dit lot par lot ce que chacun a compté :
 * tués par un test, tués par un délai, plantages, survivants, non jugés. Rien n'y est écrit à la main : chaque ligne est celle que le lot
 * a imprimée, additionnée entre ses paquets.
 *
 *  - Avant de rien lancer, chaque lot est vérifié d'avance (`--valider`) : le nombre de mutants qu'il annonce est celui que ses paquets
 *    doivent rejouer ; un lot dont un motif est périmé fait échouer le tout sans qu'on attende des heures.
 *  - Un lot de plus de `--par-paquet` mutants est coupé en paquets (`--part=i/n`), lancés côte à côte ; la somme de leurs mutants
 *    jugés doit être celle du lot : un lot qui ignorerait `--part` (le moteur le refuse) ou un paquet qui se tairait ne passe pas pour un succès.
 *  - Un paquet qui finit sans avoir imprimé son bilan (plantage de l'outil, tué de l'extérieur) fait échouer le rejeu : il n'a rien jugé.
 *  - Les lots qui exigent une machine calme (`mutants-budgets.mjs` : chaque mutant y meurt par l'horloge) se rejouent seuls, après les autres.
 *  - Code 0 : tous les mutants de tous les lots tués (par un test ou un délai, dits à part) ; 1 : un survivant, un plantage, un mutant
 *    non jugé, un décompte qui ne tombe pas juste ou un paquet sans bilan ; 2 : un lot qui ne se vérifie pas, ou un usage faux.
 *
 * Usage : node scripts/rejouer-tous-les-lots.mjs [--travailleurs=N] [--par-paquet=N] [--journaux=dossier] [--valider] [expression régulière sur le nom du lot]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('./', import.meta.url));
export const LOTS_SEULS = ['mutants-budgets.mjs'];
const BILAN = /^(\d+)\/(\d+) mutants tués : (\d+) par un test, (\d+) par un délai ; (\d+) plantages? ; (\d+) survivants?(?: ; (\d+) non jugés?)?$/m;
const MOT_DE_CONTROLE = /^(SURVIT|PLANTAGE|TUÉ délai)\s/;

/** Le bilan qu'un lot ou un paquet a imprimé (ou null), et les lignes des mutants qui ne sont pas tués par un test. */
export function lireBilan(sortie) {
  const m = BILAN.exec(sortie);
  const aPart = sortie.split('\n').filter((l) => MOT_DE_CONTROLE.test(l)).map((l) => l.trim());
  if (!m) return { bilan: null, aPart };
  const [, tues, retenus, test, delai, plantages, survivants, nonJuges] = m;
  return { bilan: { tues: Number(tues), retenus: Number(retenus), test: Number(test), delai: Number(delai), plantages: Number(plantages), survivants: Number(survivants), nonJuges: Number(nonJuges ?? 0) }, aPart };
}

/** Combien de paquets pour `n` mutants (au moins un : un lot qui n'en annonce aucun est refusé plus tôt) quand un paquet en porte au plus `parPaquet` (au moins 1 : jamais plus de paquets que de mutants). */
export const paquetsPour = (n, parPaquet) => Math.ceil(n / parPaquet);

const arrondi = (ms) => `${Math.round(ms / 1000)} s`;
/** L'environnement d'un lot, sans la variable qui lui ferait croire qu'il tourne sous `node --test` (quand l'essai qui le lance en est un). */
const environnementDeLot = (env) => { const e = { ...env }; delete e.NODE_TEST_CONTEXT; return e; };

/**
 * @param {{ dossier?: string, travailleurs?: number, parPaquet?: number, journaux?: ?string, valider?: boolean, filtre?: ?RegExp, sortie?: (l: string) => void, erreur?: (l: string) => void, env?: object, seuls?: string[], horloge?: () => number }} options
 * @returns {Promise<number>} le code de sortie
 */
export async function rejouerTousLesLots({
  dossier = SCRIPTS, travailleurs = Math.max(1, Math.min(os.cpus().length - 1, 4)), parPaquet = 60, journaux = null, valider = false, filtre = null,
  sortie = console.log, erreur = console.error, env = process.env, seuls = LOTS_SEULS, horloge = Date.now,
} = {}) {
  const noms = fs.readdirSync(dossier).filter((n) => /^mutants-.+\.mjs$/.test(n) && (!filtre || filtre.test(n))).sort();
  if (!noms.length) { erreur('Aucun lot ne correspond.'); return 2; }
  if (journaux) fs.mkdirSync(journaux, { recursive: true });

  // 1. La vérification d'avance de chaque lot : son nombre de mutants, ou pourquoi il ne peut pas être rejoué.
  const lots = [];
  let refuses = 0;
  for (const nom of noms) {
    const r = spawnSync(process.execPath, [path.join(dossier, nom), '--valider'], { encoding: 'utf8', env: environnementDeLot(env) });
    const n = Number(/(\d+) mutants/.exec(r.stdout ?? '')?.[1] ?? NaN);
    if (r.status !== 0 || !(n > 0)) {
      refuses += 1;
      erreur(`${nom} : ne se vérifie pas d'avance (code ${r.status ?? r.signal}) :\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-6).map((l) => `  ${l}`).join('\n')}`);
      continue;
    }
    lots.push({ nom, n, seul: seuls.includes(nom), paquets: [] });
  }
  if (refuses) { erreur(`${refuses} lot(s) à corriger avant de rien rejouer.`); return 2; }
  sortie(`${lots.length} lots, ${lots.reduce((s, l) => s + l.n, 0)} mutants, vérifiés d'avance.`);
  if (valider) return 0;

  // 2. Les paquets : un fichier de journal par paquet, les gros lots coupés.
  const travaux = [];
  for (const lot of lots) {
    const k = lot.seul ? 1 : paquetsPour(lot.n, parPaquet);
    for (let i = 1; i <= k; i++) {
      const argv = k > 1 ? [`--part=${i}/${k}`] : [];
      const etiquette = k > 1 ? `${lot.nom.replace(/\.mjs$/, '')}.${i}sur${k}` : lot.nom.replace(/\.mjs$/, '');
      const paquet = { lot, argv, etiquette, sortie: '', code: null, signal: null, debut: 0, fin: 0 };
      lot.paquets.push(paquet);
      travaux.push(paquet);
    }
  }
  const lancer = (paquet, seulement) => new Promise((resolve) => {
    paquet.debut = horloge();
    const enfant = spawn(process.execPath, [path.join(dossier, paquet.lot.nom), ...paquet.argv], { env: environnementDeLot(env), stdio: ['ignore', 'pipe', 'pipe'] });
    const noter = (d) => { paquet.sortie += d; if (journaux) fs.appendFileSync(path.join(journaux, `${paquet.etiquette}.log`), d); };
    enfant.stdout.on('data', noter);
    enfant.stderr.on('data', noter);
    enfant.on('error', (e) => { paquet.sortie += `\n${e.message}\n`; });
    enfant.on('close', (code, signal) => { paquet.code = code; paquet.signal = signal; paquet.fin = horloge(); if (!seulement) sortie(`  fini : ${paquet.etiquette} (${arrondi(paquet.fin - paquet.debut)})`); resolve(); });
  });

  // Les plus gros d'abord : le dernier paquet à finir est le plus court possible ; les lots « seuls » après tous les autres, un à la fois.
  const communs = travaux.filter((t) => !t.lot.seul).sort((a, b) => b.lot.n / b.lot.paquets.length - a.lot.n / a.lot.paquets.length);
  const file = [...communs];
  await Promise.all(Array.from({ length: Math.max(1, travailleurs) }, async () => {
    for (let t = file.shift(); t; t = file.shift()) await lancer(t, false);
  }));
  for (const t of travaux.filter((x) => x.lot.seul)) await lancer(t, true);

  // 3. Les comptes, lot par lot.
  let echec = false;
  const total = { retenus: 0, test: 0, delai: 0, plantages: 0, survivants: 0, nonJuges: 0 };
  const details = [];
  sortie('');
  sortie('lot'.padEnd(34) + 'mutants'.padStart(8) + 'test'.padStart(8) + 'délai'.padStart(8) + 'plantage'.padStart(10) + 'survit'.padStart(8) + 'non jugés'.padStart(11) + 'durée'.padStart(9));
  for (const lot of lots) {
    const somme = { retenus: 0, test: 0, delai: 0, plantages: 0, survivants: 0, nonJuges: 0 };
    const remarques = [];
    for (const p of lot.paquets) {
      const { bilan, aPart } = lireBilan(p.sortie);
      details.push(...aPart.map((l) => `${p.etiquette} : ${l.slice(0, 260)}`));
      if (!bilan) { remarques.push(`${p.etiquette} : aucun bilan imprimé (code ${p.code ?? p.signal})`); continue; }
      for (const cle of Object.keys(somme)) somme[cle] += bilan[cle];
    }
    if (somme.retenus !== lot.n) remarques.push(`${somme.retenus} mutants jugés pour ${lot.n} annoncés`);
    const ok = !remarques.length && somme.plantages === 0 && somme.survivants === 0 && somme.nonJuges === 0;
    if (!ok) echec = true;
    for (const cle of Object.keys(total)) total[cle] += somme[cle];
    const debut = Math.min(...lot.paquets.map((p) => p.debut));
    const fin = Math.max(...lot.paquets.map((p) => p.fin));
    sortie(`${ok ? ' ' : '✗'} ${lot.nom.replace(/^mutants-|\.mjs$/g, '').padEnd(31)}${String(somme.retenus).padStart(7)}${String(somme.test).padStart(8)}${String(somme.delai).padStart(8)}${String(somme.plantages).padStart(10)}${String(somme.survivants).padStart(8)}${String(somme.nonJuges).padStart(11)}${arrondi(fin - debut).padStart(9)}`);
    for (const r of remarques) sortie(`    ! ${r}`);
  }
  sortie('total'.padEnd(34) + String(total.retenus).padStart(8) + String(total.test).padStart(8) + String(total.delai).padStart(8) + String(total.plantages).padStart(10) + String(total.survivants).padStart(8) + String(total.nonJuges).padStart(11));
  if (details.length) { sortie('\nÀ lire :'); for (const d of details) sortie(`  ${d}`); }
  sortie('');
  sortie(`${echec ? 'ÉCHEC' : 'Tous les mutants sont tués'} : ${total.test} par un test, ${total.delai} par un délai ; ${total.plantages} plantage(s), ${total.survivants} survivant(s), ${total.nonJuges} non jugé(s).`);
  return echec ? 1 : 0;
}

function lireLigne(argv) {
  const options = {};
  const restants = [];
  for (const a of argv) {
    let m;
    if (a === '--valider') options.valider = true;
    else if ((m = /^--travailleurs=(\d+)$/.exec(a))) options.travailleurs = Number(m[1]);
    else if ((m = /^--par-paquet=(\d+)$/.exec(a))) options.parPaquet = Number(m[1]);
    else if ((m = /^--journaux=(.+)$/.exec(a))) options.journaux = m[1];
    else if (a.startsWith('--')) throw new Error(`option inconnue : ${a}`);
    else restants.push(a);
  }
  if (options.travailleurs === 0 || options.parPaquet === 0) throw new Error('--travailleurs et --par-paquet valent au moins 1');
  if (restants.length > 1) throw new Error('une seule expression régulière sur le nom du lot');
  if (restants.length) options.filtre = new RegExp(restants[0]);
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let options;
  try { options = lireLigne(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  process.exitCode = await rejouerTousLesLots(options);
}
