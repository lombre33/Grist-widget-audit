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
 *    dépassement tombe dans la compilation d'une expression régulière, ce qu'aucun `try` n'attrape ; aucun rapport ne sort. La
 *    lecture d'acorn y tombait (`catchStackOverflow` compile une expression régulière au bord de la pile) : `LecteurAcorn`
 *    (src/moteur/analyse-js.js) le corrige à la source, et `--sans-abandon` fait de l'abandon une fin interdite pour le rejouer
 *    sur un arbre qui porte ce correctif. Sans l'option, l'abandon reste une fin permise, parce qu'un arbre d'avant le correctif
 *    (comparé par `--arbre`) s'abandonne encore, et que l'enfant qui isole l'analyse (V2) contient ce qui pourrait venir d'ailleurs.
 *    Le tableau dit la cause de chaque abandon, la ligne « FATAL ERROR: … » que V8 écrit en s'arrêtant : un compte d'abandons ne dit pas
 *    à lui seul si c'est la compilation d'une expression régulière au bord de la pile (ce que ferme le correctif) ou autre chose.
 * Une quatrième fin ne doit pas exister : un rapport complet qui conclut sans avoir lu le fichier (`silence`, une lecture qui
 * échoue et que personne ne dit). Ce qui distingue `lu` de `silence`, c'est un TÉMOIN et non la profondeur : le fichier porte, au
 * cœur de ses N niveaux, un `fetch` inoffensif vers un domaine réservé (`.invalid`, RFC 2606 : il ne résout jamais, et l'audit
 * ne lance rien), que C-EXFIL-01 dit dès qu'une règle lit jusqu'au cœur. Un rapport qui porte le témoin a lu le fichier ; un
 * rapport sans témoin qui ne dit pas C-SURFACE-03 bloquant a conclu sans l'avoir lu, à toute profondeur (un seuil de niveaux, qui
 * ne dit rien de ce que la pile porte ce jour-là, rangeait ces silences en « lu » sous 10 000 niveaux). Le script dit le silence
 * et sort en code 1, de même qu'une sortie 3 (`plantage` : l'outil a planté, ce qu'un widget ne doit jamais pouvoir provoquer),
 * une sortie que l'outil n'a pas (`autre`) ou un lancement qui n'a pas fini dans le temps donné (`delai`, 180 s : l'audit d'un
 * fichier de 100 Kio ne prend pas trois minutes, une boucle est un déni de service, et n'est pas un abandon de V8).
 *
 * Usage : node scripts/rejouer-fichier-profond.mjs [--niveaux=1400,1700,20000] [--essais=10] [--regime=principal|worker] [--pile-mb=3.5]
 *                                                 [--arbre=<dossier>]… [--sans-abandon]
 *   --regime=worker : l'audit tourne dans un Worker (pile de 4 Mio, que `--pile-mb` change), le régime d'un processus enfant qui
 *   isole l'analyse ; `principal` : le fil principal de Node (984 Kio), le régime de la ligne de commande.
 *   --arbre : l'arbre de l'outil à lancer (le dépôt courant par défaut). Répété, les arbres sont lancés en alternance, un
 *   lancement de chacun à tour de rôle : la machine a la même charge pour tous (comparer un arbre à celui d'avant un correctif).
 *   --sans-abandon : un lancement arrêté par V8 est une fin interdite (le code de sortie dit alors que le correctif de la lecture ne tient pas).
 * Code 0 : aucune fin interdite ; code 1 : un silence, un plantage, une sortie inconnue, un délai (ou un abandon avec `--sans-abandon`) ;
 * code 2 : option fausse.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** L'hôte du témoin : un domaine réservé (RFC 2606), qui ne résout jamais. */
export const TEMOIN = 'temoin-rejeu.invalid';
const APPEL_TEMOIN = `fetch("https://${TEMOIN}/")`;

/** Le fichier : « x=>{ » N fois, le témoin au cœur, puis « } » N fois, sur une seule ligne. */
export const fichierProfond = (niveaux) => 'x=>{'.repeat(niveaux) + APPEL_TEMOIN + '}'.repeat(niveaux);

/** Vrai si le rapport (`--json`) porte le témoin : un C-EXFIL-01 qui nomme l'hôte planté au cœur du fichier, donc une règle qui l'a lu jusque-là. */
export function aVuLeTemoin(rapport) {
  return Object.values(rapport?.axes ?? {}).some((axe) => (axe.constats ?? []).some((c) => c.regle === 'C-EXFIL-01' && JSON.stringify(c).includes(TEMOIN)));
}

/** Vrai si le rapport (`--json`) porte un C-SURFACE-03 critique et bloquant : ce que l'audit dit d'un code qu'il n'a pas lu. */
export function diraitIllisible(rapport) {
  return Object.values(rapport?.axes ?? {}).some((axe) => (axe.constats ?? []).some((c) => c.regle === 'C-SURFACE-03' && c.severite === 'critique' && c.bloquant === true));
}

/**
 * La fin d'un lancement : `delai` (il n'a pas fini dans le temps donné), `abandon` (V8 a arrêté le processus : un signal, un code de
 * 128 ou plus), `plantage` (sortie 3 : l'outil a planté), `autre` (une sortie que l'outil n'a pas, ou aucun rapport alors que l'outil a
 * fini), sinon `dit` (C-SURFACE-03 bloquant), `lu` (le témoin est dans le rapport) ou `silence` (ni l'un ni l'autre), à toute profondeur.
 * @param {{ status: ?number, signal: ?string, rapport: ?object, delai?: boolean }} lancement
 */
export function classer({ status, signal, rapport, delai = false }) {
  if (delai) return 'delai';
  if (signal || status === null || status >= 128) return 'abandon';
  if (status === 3) return 'plantage';
  if (![0, 1, 2].includes(status) || !rapport) return 'autre';
  if (diraitIllisible(rapport)) return 'dit';
  return aVuLeTemoin(rapport) ? 'lu' : 'silence';
}

/**
 * Ce que V8 dit d'un arrêt qu'il décide : la ligne « FATAL ERROR: … » que le processus écrit sur sa sortie d'erreur (« RegExpCompiler Allocation
 * failed - process out of memory » quand la pile déborde dans la compilation d'une expression régulière, « Ineffective mark-compacts near heap
 * limit … » quand c'est le tas). `null` : le processus n'en a écrit aucune (un signal que V8 n'a pas signé). Sans cette cause, un compte d'abandons ne
 * dit pas si c'est le défaut que le correctif de la lecture ferme ou un autre.
 */
export function causeDAbandon(erreur) {
  const m = /FATAL ERROR: (.*)/.exec(erreur);
  return m ? m[1].trim().slice(0, 120) : null;
}

/** Ce que le tableau dit d'un abandon qui n'a écrit aucun « FATAL ERROR: ». */
export const SANS_CAUSE = 'aucun message de V8';

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

/** Un lancement de l'audit de `widget` par le CLI de `arbre` ; le rapport `--json` qu'il a écrit (sinon null), et la cause de l'arrêt si V8 en a dit une. */
function lancer(arbre, widget, sortie, { regime, pileMb, enveloppe, delaiMs }) {
  const cli = path.join(arbre, 'bin', 'gwaudit.js');
  const options = [widget, '--sans-dynamique', '--sans-reseau', '--sans-html', '--json', '--sortie', sortie];
  const args = regime === 'worker' ? [enveloppe, cli, String(pileMb ?? 0), ...options] : [cli, ...options];
  // La sortie d'erreur va dans un fichier, non dans un tube : V8 y écrit la cause de son arrêt, et une sortie d'erreur longue ne fait pas échouer le lancement.
  const erreurs = `${sortie}.stderr`;
  const fd = fs.openSync(erreurs, 'w');
  let r;
  try { r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: delaiMs, stdio: ['ignore', 'ignore', fd] }); } finally { fs.closeSync(fd); }
  const cause = causeDAbandon(fs.readFileSync(erreurs, 'utf8'));
  fs.rmSync(erreurs, { force: true });
  let rapport = null;
  try { rapport = JSON.parse(fs.readFileSync(path.join(sortie, 'rapport.json'), 'utf8')); } catch { /* pas de rapport : l'abandon, ou une panne */ }
  return { status: r.status, signal: r.signal ?? null, rapport, delai: r.error?.code === 'ETIMEDOUT', cause };
}

/**
 * Rejoue. Rend `{ lignes, interdites }` : pour chaque (arbre, niveaux), le nombre de lancements par fin et, pour les abandons, le nombre de chaque
 * cause que V8 a dite (`causes`) ; `interdites` le nombre de lancements qui ont fini d'une fin qui ne doit pas exister.
 * @param {{ niveaux: number[], essais: number, regime: 'principal'|'worker', pileMb?: number, arbres: string[], delaiMs?: number, sansAbandon?: boolean }} options
 *   `delaiMs` : le temps d'un lancement (180 s par défaut), au-delà duquel il est arrêté et compté `delai`.
 *   `sansAbandon` : un lancement arrêté par V8 (`abandon`) est interdit, lui aussi.
 */
export function rejouer({ niveaux, essais, regime, pileMb, arbres, delaiMs = DELAI_MS, sansAbandon = false }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-profond-'));
  try {
    const enveloppe = path.join(tmp, 'enveloppe-worker.mjs');
    fs.writeFileSync(enveloppe, ENVELOPPE_WORKER);
    const lignes = [];
    for (const n of niveaux) {
      const parArbre = new Map(arbres.map((a) => [a, { ...Object.fromEntries(FINS.map((f) => [f, 0])), causes: {} }]));
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
          const lancement = lancer(arbre, widgets.get(arbre), sortie, { regime, pileMb, enveloppe, delaiMs });
          const fin = classer(lancement);
          const compte = parArbre.get(arbre);
          compte[fin]++;
          if (fin === 'abandon') { const cause = lancement.cause || SANS_CAUSE; compte.causes[cause] = (compte.causes[cause] ?? 0) + 1; }
          fs.rmSync(sortie, { recursive: true, force: true });
        }
      }
      for (const arbre of arbres) lignes.push({ arbre, niveaux: n, essais, ...parArbre.get(arbre) });
    }
    const interdit = sansAbandon ? new Set([...INTERDITES, 'abandon']) : INTERDITES;
    const interdites = lignes.reduce((total, l) => total + [...interdit].reduce((s, f) => s + l[f], 0), 0);
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
  const avecCauses = lignes.filter((l) => Object.keys(l.causes ?? {}).length);
  if (avecCauses.length) {
    sortie.push('', 'Causes des abandons (la ligne « FATAL ERROR » de V8) :');
    for (const l of avecCauses) for (const [cause, n] of Object.entries(l.causes)) sortie.push(`  ${plusieursArbres ? `${path.basename(l.arbre)}, ` : ''}${l.niveaux} niveaux : ${n} × ${cause}`);
  }
  return sortie.join('\n');
}

// ---------------------------------------------------------------------------
// La ligne de commande (rien ne se lance à l'import).
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const USAGE = 'Usage : node scripts/rejouer-fichier-profond.mjs [--niveaux=1400,1700,20000] [--essais=10] [--regime=principal|worker] [--pile-mb=3.5] [--arbre=<dossier>]… [--sans-abandon]';
  const valeur = (nom) => args.filter((a) => a.startsWith(`--${nom}=`)).map((a) => a.slice(nom.length + 3));
  const connues = ['niveaux', 'essais', 'regime', 'pile-mb', 'arbre'];
  const inconnues = args.filter((a) => a !== '--sans-abandon' && !connues.some((nom) => a.startsWith(`--${nom}=`)));
  const sansAbandon = args.includes('--sans-abandon');
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
  const arbres = (valeur('arbre').length ? valeur('arbre') : [RACINE]).map((a) => path.resolve(a));
  for (const a of arbres) if (!fs.existsSync(path.join(a, 'bin', 'gwaudit.js')) || !fs.existsSync(path.join(a, 'fixtures', 'widget-exemple'))) fausse(`Pas un arbre de l'outil : ${a} (bin/gwaudit.js ou fixtures/widget-exemple manque).`);
  const { lignes, interdites } = rejouer({ niveaux, essais, regime, pileMb, arbres, sansAbandon });
  console.log(tableau(lignes, { plusieursArbres: arbres.length > 1 }));
  console.log(interdites
    ? `\n${interdites} lancement(s) ont fini d'une fin qui ne doit pas exister (silence : un rapport complet sans le témoin ni C-SURFACE-03, le code n'a pas été lu et personne ne le dit ; plantage : sortie 3 ; autre : sortie inconnue ; delai : pas fini à temps${sansAbandon ? ' ; abandon : le processus a été arrêté par V8' : ''}).`
    : sansAbandon
      ? '\nAucune fin interdite : chaque lancement a lu le code ou l\'a dit (C-SURFACE-03 bloquant), aucun n\'a été arrêté par V8.'
      : '\nAucune fin interdite : chaque lancement a lu le code, l\'a dit (C-SURFACE-03 bloquant) ou a été arrêté par V8.');
  process.exitCode = interdites ? 1 : 0;
}
