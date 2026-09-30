#!/usr/bin/env node
/**
 * Rejoue l'audit d'un fichier qui empile « x=>{ » N fois puis « } » N fois, derrière widget-exemple (le fichier qu'une lecture
 * qui échoue sans rien dire a déjà fait passer pour conforme), lancement après lancement, chacun dans son processus.
 *
 * Pourquoi un processus par lancement : ce que devient une lecture qui déborde la pile dépend de l'état du compilateur JIT et de
 * celui du compilateur d'expressions régulières de V8, donc d'un lancement à l'autre. Il y a trois fins, dans un ordre qui varie :
 *  - `lu` : le code se lit, l'audit rend son rapport ;
 *  - `dit` : la lecture (ou le parcours des règles) lève un dépassement de pile et l'audit le dit, C-SURFACE-03, critique et
 *    bloquant, les axes du fichier empêchés ;
 *  - `abandon` : V8 arrête le processus (« FATAL ERROR: RegExpCompiler Allocation failed », code 134 sous Linux) quand le
 *    dépassement tombe dans la compilation d'une expression régulière, ce qu'aucun `try` n'attrape ; aucun rapport ne sort, et
 *    c'est l'enfant qui isole l'analyse (V2) qui le contient.
 * Une quatrième fin ne doit pas exister : un rapport complet qui conclut sans avoir lu le fichier (`silence`, une lecture qui
 * échoue et que personne ne dit). À un niveau que nulle pile de Node ne lit (`--sans-lecture`, 10 000 par défaut), tout rapport
 * sans C-SURFACE-03 bloquant en est une : le script le dit et sort en code 1, de même qu'une sortie 3 (`plantage` : l'outil a
 * planté, ce qu'un widget ne doit jamais pouvoir provoquer), une sortie que l'outil n'a pas (`autre`) ou un lancement qui n'a pas
 * fini dans le temps donné (`delai`, 180 s : l'audit d'un fichier de 100 Kio ne prend pas trois minutes, une boucle est un déni de
 * service, et n'est pas un abandon de V8).
 *
 * Usage : node scripts/rejouer-fichier-profond.mjs [--niveaux=1400,1700,20000] [--essais=10] [--regime=principal|worker] [--pile-mb=3.5]
 *                                                 [--arbre=<dossier>]… [--sans-lecture=10000]
 *   --regime=worker : l'audit tourne dans un Worker (pile de 4 Mio, que `--pile-mb` change), le régime d'un processus enfant qui
 *   isole l'analyse ; `principal` : le fil principal de Node (984 Kio), le régime de la ligne de commande.
 *   --arbre : l'arbre de l'outil à lancer (le dépôt courant par défaut). Répété, les arbres sont lancés en alternance, un
 *   lancement de chacun à tour de rôle : la machine a la même charge pour tous (comparer un arbre à celui d'avant un correctif).
 * Code 0 : aucune fin interdite ; code 1 : un silence, un plantage, une sortie inconnue ou un délai ; code 2 : option fausse.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Le fichier : « x=>{ » N fois puis « } » N fois, sur une seule ligne. */
export const fichierProfond = (niveaux) => 'x=>{'.repeat(niveaux) + '}'.repeat(niveaux);

/** Vrai si le rapport (`--json`) porte un C-SURFACE-03 critique et bloquant : ce que l'audit dit d'un code qu'il n'a pas lu. */
export function diraitIllisible(rapport) {
  return Object.values(rapport?.axes ?? {}).some((axe) => (axe.constats ?? []).some((c) => c.regle === 'C-SURFACE-03' && c.severite === 'critique' && c.bloquant === true));
}

/**
 * La fin d'un lancement : `delai` (il n'a pas fini dans le temps donné), `abandon` (V8 a arrêté le processus : un signal, un code de
 * 128 ou plus), `plantage` (sortie 3 : l'outil a planté), `autre` (une sortie que l'outil n'a pas, ou aucun rapport alors que l'outil a
 * fini), sinon `dit`, `lu` ou, à un niveau que nulle pile ne lit, `silence`.
 * @param {{ status: ?number, signal: ?string, rapport: ?object, delai?: boolean }} lancement
 */
export function classer({ status, signal, rapport, delai = false }, niveaux, sansLecture) {
  if (delai) return 'delai';
  if (signal || status === null || status >= 128) return 'abandon';
  if (status === 3) return 'plantage';
  if (![0, 1, 2].includes(status) || !rapport) return 'autre';
  if (diraitIllisible(rapport)) return 'dit';
  return niveaux >= sansLecture ? 'silence' : 'lu';
}

const FINS = ['lu', 'dit', 'abandon', 'silence', 'plantage', 'autre', 'delai'];
const INTERDITES = new Set(['silence', 'plantage', 'autre', 'delai']);
const DELAI_MS = 180_000;

/** Un Worker qui lance le CLI de l'arbre : sa pile est celle d'un Worker (4 Mio par défaut), non celle du fil principal. */
const ENVELOPPE_WORKER = `import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
const [bin, pile, ...args] = process.argv.slice(2);
const w = new Worker(pathToFileURL(bin), { argv: args, resourceLimits: Number(pile) ? { stackSizeMb: Number(pile) } : {} });
w.on('error', (e) => { console.error('worker error:', e?.name, String(e?.message).slice(0, 200)); process.exitCode = 97; });
w.on('exit', (code) => { if (!process.exitCode) process.exitCode = code; });
`;

/** Un lancement de l'audit de `widget` par le CLI de `arbre` ; le rapport `--json` qu'il a écrit, sinon null. */
function lancer(arbre, widget, sortie, { regime, pileMb, enveloppe, delaiMs }) {
  const cli = path.join(arbre, 'bin', 'gwaudit.js');
  const options = [widget, '--sans-dynamique', '--sans-reseau', '--sans-html', '--json', '--sortie', sortie];
  const args = regime === 'worker' ? [enveloppe, cli, String(pileMb ?? 0), ...options] : [cli, ...options];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: delaiMs, stdio: ['ignore', 'ignore', 'ignore'] });
  let rapport = null;
  try { rapport = JSON.parse(fs.readFileSync(path.join(sortie, 'rapport.json'), 'utf8')); } catch { /* pas de rapport : l'abandon, ou une panne */ }
  return { status: r.status, signal: r.signal ?? null, rapport, delai: r.error?.code === 'ETIMEDOUT' };
}

/**
 * Rejoue. Rend `{ lignes, interdites }` : pour chaque (arbre, niveaux), le nombre de lancements par fin ; `interdites` le nombre de
 * lancements qui ont fini d'une fin qui ne doit pas exister.
 * @param {{ niveaux: number[], essais: number, regime: 'principal'|'worker', pileMb?: number, arbres: string[], sansLecture: number, delaiMs?: number }} options
 *   `delaiMs` : le temps d'un lancement (180 s par défaut), au-delà duquel il est arrêté et compté `delai`.
 */
export function rejouer({ niveaux, essais, regime, pileMb, arbres, sansLecture, delaiMs = DELAI_MS }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-profond-'));
  try {
    const enveloppe = path.join(tmp, 'enveloppe-worker.mjs');
    fs.writeFileSync(enveloppe, ENVELOPPE_WORKER);
    const lignes = [];
    for (const n of niveaux) {
      const parArbre = new Map(arbres.map((a) => [a, Object.fromEntries(FINS.map((f) => [f, 0]))]));
      const widgets = new Map();
      for (const arbre of arbres) {
        const dossier = path.join(tmp, `widget-${widgets.size}-${n}`);
        fs.cpSync(path.join(arbre, 'fixtures', 'widget-exemple'), dossier, { recursive: true });
        fs.writeFileSync(path.join(dossier, 'app.js'), fichierProfond(n));
        widgets.set(arbre, dossier);
      }
      for (let k = 1; k <= essais; k++) {
        for (const arbre of arbres) {
          const sortie = path.join(tmp, `sortie-${n}-${k}-${widgets.size}-${arbres.indexOf(arbre)}`);
          const fin = classer(lancer(arbre, widgets.get(arbre), sortie, { regime, pileMb, enveloppe, delaiMs }), n, sansLecture);
          parArbre.get(arbre)[fin]++;
          fs.rmSync(sortie, { recursive: true, force: true });
        }
      }
      for (const arbre of arbres) lignes.push({ arbre, niveaux: n, essais, ...parArbre.get(arbre) });
    }
    const interdites = lignes.reduce((total, l) => total + [...INTERDITES].reduce((s, f) => s + l[f], 0), 0);
    return { lignes, interdites };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Le tableau, une ligne par (arbre, niveaux). */
export function tableau(lignes, { plusieursArbres }) {
  const sortie = [`${plusieursArbres ? 'arbre'.padEnd(28) : ''}${'niveaux'.padStart(8)} | lancements |  lu | dit | abandon | silence | plantage | autre | delai`];
  for (const l of lignes) {
    const nom = plusieursArbres ? `${path.basename(l.arbre).slice(0, 27).padEnd(28)}` : '';
    sortie.push(`${nom}${String(l.niveaux).padStart(8)} | ${String(l.essais).padStart(10)} | ${FINS.map((f, i) => String(l[f]).padStart([3, 3, 7, 7, 8, 5, 5][i])).join(' | ')}`);
  }
  return sortie.join('\n');
}

// ---------------------------------------------------------------------------
// La ligne de commande (rien ne se lance à l'import).
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const USAGE = 'Usage : node scripts/rejouer-fichier-profond.mjs [--niveaux=1400,1700,20000] [--essais=10] [--regime=principal|worker] [--pile-mb=3.5] [--arbre=<dossier>]… [--sans-lecture=10000]';
  const valeur = (nom) => args.filter((a) => a.startsWith(`--${nom}=`)).map((a) => a.slice(nom.length + 3));
  const connues = ['niveaux', 'essais', 'regime', 'pile-mb', 'arbre', 'sans-lecture'];
  const inconnues = args.filter((a) => !connues.some((nom) => a.startsWith(`--${nom}=`)));
  const fausse = (message) => { console.error(`${message}\n${USAGE}`); process.exit(2); };
  if (inconnues.length) fausse(`Option inconnue : ${inconnues.join(' ')}`);
  const niveaux = (valeur('niveaux')[0] ?? '1400,1700,20000').split(',').map(Number);
  if (!niveaux.length || niveaux.some((n) => !Number.isInteger(n) || n < 1)) fausse(`Niveaux invalides : « ${valeur('niveaux')[0]} » (des entiers positifs séparés par des virgules).`);
  const essais = Number(valeur('essais')[0] ?? 10);
  if (!Number.isInteger(essais) || essais < 1) fausse(`Nombre d'essais invalide : « ${valeur('essais')[0]} ».`);
  const regime = valeur('regime')[0] ?? 'principal';
  if (!['principal', 'worker'].includes(regime)) fausse(`Régime inconnu : « ${regime} » (principal ou worker).`);
  const pileDite = valeur('pile-mb')[0];
  const pileMb = pileDite === undefined ? undefined : Number(pileDite);
  if (pileMb !== undefined && !(pileMb > 0)) fausse(`Pile invalide : « ${pileDite} » (des Mio, positifs).`);
  if (pileMb !== undefined && regime !== 'worker') fausse('`--pile-mb` ne vaut que pour `--regime=worker` : la pile du fil principal est celle de Node.');
  const sansLecture = Number(valeur('sans-lecture')[0] ?? 10_000);
  if (!Number.isInteger(sansLecture) || sansLecture < 1) fausse(`Niveau invalide : « ${valeur('sans-lecture')[0]} ».`);
  const arbres = (valeur('arbre').length ? valeur('arbre') : [RACINE]).map((a) => path.resolve(a));
  for (const a of arbres) if (!fs.existsSync(path.join(a, 'bin', 'gwaudit.js')) || !fs.existsSync(path.join(a, 'fixtures', 'widget-exemple'))) fausse(`Pas un arbre de l'outil : ${a} (bin/gwaudit.js ou fixtures/widget-exemple manque).`);
  const { lignes, interdites } = rejouer({ niveaux, essais, regime, pileMb, arbres, sansLecture });
  console.log(tableau(lignes, { plusieursArbres: arbres.length > 1 }));
  console.log(interdites
    ? `\n${interdites} lancement(s) ont fini d'une fin qui ne doit pas exister (silence : un rapport complet sans C-SURFACE-03 à un niveau que nulle pile ne lit ; plantage : sortie 3 ; autre : sortie inconnue ; delai : pas fini à temps).`
    : '\nAucune fin interdite : chaque lancement a lu le code, l\'a dit (C-SURFACE-03 bloquant) ou a été arrêté par V8.');
  process.exitCode = interdites ? 1 : 0;
}
