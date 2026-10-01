/**
 * Exécute un travail dans un processus enfant à limite de mémoire (et de temps), et
 * dit pourquoi il n'a pas abouti quand il n'a pas abouti.
 *
 * Pourquoi un enfant : l'analyse statique d'un widget hostile peut tuer le processus
 * qui la porte, sans exception à rattraper — un `heap out of memory` de V8 est un
 * abandon (SIGABRT, code 134), le noyau à court de mémoire tue par SIGKILL, et
 * l'abandon du compilateur d'expressions régulières sur une pile presque pleine n'est
 * rattrapable dans aucun fil. Seul un autre processus survit à ces fins, et écrit le
 * rapport que le widget a voulu empêcher.
 *
 * Le module travaillé exporte `executer(entree, { etape, partiel })` (voir
 * enfant-travail.mjs) ; `entree` et son résultat sont du JSON. Aucune fin de l'enfant
 * n'est prise pour un résultat : sans le marqueur `termine` du fichier de résultat,
 * c'est une interruption, dite avec sa cause.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { citerSiBesoin } from '../moteur/texte-du-widget.js';
import { CODE_EXCEPTION, CODE_TAS_EPUISE } from './codes.js';

const ENFANT = fileURLToPath(new URL('./enfant-travail.mjs', import.meta.url));
// Un abandon de V8 écrit son message puis une trace native de plusieurs Kio : le message doit rester dans ce qu'on garde.
const LONGUEUR_FIN_STDERR = 16384;

/** L'enfant n'a pas pu être lancé (fork refusé, mémoire ou processus épuisés) : une panne de l'outil ou de son environnement, pas un fait du widget. */
export class ErreurLancement extends Error {}

/**
 * @param {object} o
 * @param {string} o.module        chemin absolu du module ES qui exporte `executer`
 * @param {object} o.entree        JSON transmis au module
 * @param {?number} [o.limiteMo]   limite du tas de l'enfant, en Mio (null : celle de Node)
 * @param {?number} [o.pileMo]     taille de pile du fil de travail, en Mio (null : celle de Node)
 * @param {?number} [o.delaiMs]    durée au-delà de laquelle l'enfant est tué (null : aucune)
 * @param {?number} [o.scoreOom]   score que l'enfant se donne pour que le noyau le tue avant tout autre (défaut 1000)
 * @param {number} [o.sondeParentMs] période à laquelle l'enfant vérifie que son parent vit encore, pour s'arrêter (avec ce qu'il a lancé) si le parent est tué sans avoir pu le tuer (défaut 2000)
 * @param {NodeJS.WritableStream} [o.relayerStderr] où va ce que l'enfant écrit sur sa sortie d'erreur (défaut : celle du parent) ; null pour rien
 * @param {object} [o.env]         environnement de l'enfant (défaut : celui du parent)
 * @returns {Promise<{termine: true, resultat: any, partiel: any, mesures: ?{rssMaxMo: number}} | {termine: false, cause: {genre: string, raison: string, code: ?number, signal: ?string, etape: ?string, fin: string}, partiel: any, mesures: ?{rssMaxMo: number}}>}
 *   `mesures` : le pic de mémoire résidente de l'enfant, quand il a pu l'écrire (jamais quand il a été tué)
 */
export async function executerEnEnfant({ module, entree, limiteMo = null, pileMo = null, delaiMs = null, scoreOom = 1000, sondeParentMs = 2000, relayerStderr = process.stderr, env = process.env }) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-enfant-'));
  const retirer = [];
  try {
    fs.writeFileSync(path.join(dossier, 'entree.json'), JSON.stringify({ module, entree, limiteMo, pileMo, scoreOom, sondeParentMs }));
    // La limite du tas est posée par l'option du processus : mesuré (Node 22.22.2), `resourceLimits.maxOldGenerationSizeMb` d'un Worker
    // seul ne borne rien (30 millions d'objets sous « 64 Mio » : 4,6 Go), alors que l'option de ligne de commande, que le Worker reprend,
    // l'applique et rend l'épuisement rattrapable (`ERR_WORKER_OUT_OF_MEMORY`). tests/isolement-enfant.test.mjs le garde.
    const args = [...(limiteMo ? [`--max-old-space-size=${limiteMo}`] : []), ENFANT, dossier];
    // Sur un système POSIX l'enfant mène son propre groupe : ce qu'il lance (npm audit) meurt avec lui.
    const posix = process.platform !== 'win32';
    let enfant;
    try {
      enfant = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'], env, detached: posix });
    } catch (e) { // certaines erreurs (E2BIG : environnement trop gros) sont levées de suite, d'autres rendues par l'événement `error`
      throw new ErreurLancement(erreurDeLancement(e));
    }
    let fin = '';
    let delaiAtteint = false;

    const nettoyer = () => { try { fs.rmSync(dossier, { recursive: true, force: true }); } catch { /* le système de fichiers le dira à qui le regarde */ } };
    const tuer = () => {
      try { if (posix) process.kill(-enfant.pid, 'SIGKILL'); else enfant.kill('SIGKILL'); } catch { /* déjà mort */ }
    };
    enfant.stderr.on('data', (morceau) => {
      if (relayerStderr) relayerStderr.write(morceau);
      fin = (fin + morceau.toString('utf8')).slice(-LONGUEUR_FIN_STDERR);
    });

    // Le parent interrompu (SIGINT, SIGTERM du plafond du conteneur) ne laisse pas l'enfant derrière lui : le groupe est tué, puis le signal reprend son cours et arrête le parent.
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const gestionnaire = () => { tuer(); nettoyer(); process.kill(process.pid, signal); };
      process.once(signal, gestionnaire);
      retirer.push(() => process.removeListener(signal, gestionnaire));
    }
    let minuteur = null;
    if (delaiMs) minuteur = setTimeout(() => { delaiAtteint = true; tuer(); }, delaiMs);
    retirer.push(() => { if (minuteur) clearTimeout(minuteur); });

    // `close` attend la fin des flux : un petit-enfant qui garderait notre sortie d'erreur ouverte la ferait attendre sans fin. Il est tué à la sortie de l'enfant, et on n'attend les flux que 2 s de plus.
    const sortie = await new Promise((resolve, reject) => {
      enfant.once('error', (e) => reject(new ErreurLancement(erreurDeLancement(e))));
      enfant.once('exit', (code, signal) => { tuer(); setTimeout(() => resolve({ code, signal }), 2000).unref(); });
      enfant.once('close', (code, signal) => resolve({ code, signal }));
    });

    const lire = (nom) => {
      try { return JSON.parse(fs.readFileSync(path.join(dossier, nom), 'utf8')); } catch { return null; }
    };
    const partiel = lire('partiel.json');
    const resultat = lire('resultat.json');
    const mesures = lire('mesures.json');
    if (sortie.code === 0 && resultat?.termine === true) return { termine: true, resultat: resultat.resultat, partiel, mesures };

    let etape = null;
    try { etape = fs.readFileSync(path.join(dossier, 'etape.txt'), 'utf8').trim() || null; } catch { /* aucune étape annoncée */ }
    const cause = expliquer({ ...sortie, delaiAtteint, delaiMs, limiteMo, etape, fin, echec: lire('echec.json'), resultatPresent: resultat !== null });
    return { termine: false, cause, partiel, mesures };
  } finally {
    for (const r of retirer) r();
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}

const erreurDeLancement = (e) => `impossible de lancer le processus d'analyse : ${e.code ?? ''} ${e.message}`.replace(/\s+/g, ' ').trim();

const MOTIF_TAS_EPUISE = /heap out of memory|Reached heap limit|JavaScript heap|Allocation failed/i;
// « FATAL ERROR: RegExpCompiler Allocation failed - process out of memory » : le compilateur d'expressions régulières de V8 n'a plus de pile
// (un code imbriqué très profondément ; la profondeur où cela arrive dépend de la construction : `scripts/mesurer-profondeur.mjs`). Le mot
// « memory » y est, la mémoire n'y est pour rien, et il porte lui aussi « Allocation failed » : c'est ce motif, plus précis, qui passe d'abord.
// Depuis b3d12ba, la lecture du JavaScript rattrape elle-même le dépassement de pile sans expression régulière : le piège des « x=>{ » imbriqués
// n'abandonne plus. Ce classement reste, pour un abandon de cette sorte qui reviendrait ailleurs ; un enfant factice l'éprouve (tests/aide-isolement/abandon.mjs).
// En début de ligne : le message de V8 lui-même, pas un nom de fichier du widget qu'un avertissement de l'outil citerait.
const MOTIF_PILE_PLEINE = /^FATAL ERROR: RegExpCompiler Allocation failed/m;
const MOTIF_ERREUR_FATALE = /FATAL ERROR:[^\n]*/;

/**
 * La cause d'une fin sans résultat, dite pour un lecteur du rapport : `genre` pour les
 * machines (tas, pile, abandon, noyau, delai, exception, incomplet, sortie), `raison` pour les
 * gens. Tout ce qui n'est pas un résultat complet passe ici, y compris une sortie 0 sans résultat.
 *
 * Le message d'une erreur interne peut porter du texte que le widget a choisi (un nom, un motif d'expression régulière) et la raison part dans le
 * texte d'un constat, que le Markdown n'échappe pas, et sur la console : il est cité par `citerSiBesoin` (src/moteur/texte-du-widget.js), tel quel quand
 * aucun caractère n'y a de sens pour une sortie.
 */
export function expliquer({ code, signal, delaiAtteint, delaiMs, limiteMo, etape, fin, echec, resultatPresent }) {
  // Les dernières lignes de la sortie d'erreur ; pour un abandon de V8, c'est la trace native qui les remplit, et le message est au-dessus : il vient en tête.
  const dernieres = fin.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3);
  const fatale = MOTIF_ERREUR_FATALE.exec(fin)?.[0].trim();
  const tete = fatale && !dernieres.includes(fatale) ? fatale.slice(0, 200) : null;
  const queue = dernieres.join(' | ');
  const base = { code: code ?? null, signal: signal ?? null, etape, fin: tete ? `${tete} | ${queue.slice(-(400 - tete.length - 3))}` : queue.slice(-400) };
  const mo = limiteMo ? `la limite de ${limiteMo} Mio` : 'la limite de Node';
  if (delaiAtteint) return { ...base, genre: 'delai', raison: `délai dépassé : l'analyse n'était pas terminée au bout de ${Math.round(delaiMs / 1000)} s` };
  if (code === CODE_TAS_EPUISE || echec?.genre === 'tas') return { ...base, genre: 'tas', raison: `mémoire épuisée : le tas du moteur JavaScript a atteint ${mo}` };
  if (code === CODE_EXCEPTION || echec?.genre === 'exception') return { ...base, genre: 'exception', raison: `erreur interne de l'analyse : ${echec?.message ? citerSiBesoin(String(echec.message)) : 'sans message'}` };
  // L'abandon de V8 : par SIGABRT sous POSIX, par un code de sortie sans signal sous Windows (le processus y est tué sans signal).
  if (MOTIF_PILE_PLEINE.test(fin) && (signal === 'SIGABRT' || (!signal && code))) {
    return { ...base, genre: 'pile', raison: "abandon du moteur JavaScript au moment de compiler une expression régulière : la pile est presque pleine (le code est imbriqué très profondément), et la mémoire n'y est pour rien" };
  }
  if (signal === 'SIGABRT' || code === 134) {
    return MOTIF_TAS_EPUISE.test(fin)
      ? { ...base, genre: 'tas', raison: `mémoire épuisée : le moteur JavaScript a abandonné en atteignant ${mo} (SIGABRT)` }
      : { ...base, genre: 'abandon', raison: "abandon du moteur JavaScript (SIGABRT), sans autre précision : pile ou mémoire épuisée" };
  }
  if (signal === 'SIGKILL' || code === 137) return { ...base, genre: 'noyau', raison: "processus tué par le noyau (SIGKILL), très probablement faute de mémoire dans le conteneur" };
  if (signal) return { ...base, genre: 'sortie', raison: `processus terminé par le signal ${signal}` };
  if (code === 0) return { ...base, genre: 'incomplet', raison: resultatPresent ? "le fichier de résultat de l'analyse est incomplet (marqueur de fin absent)" : "l'analyse s'est terminée sans écrire de résultat lisible" };
  return { ...base, genre: 'sortie', raison: `le processus d'analyse s'est terminé avec le code ${code}` };
}
