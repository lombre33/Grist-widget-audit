/**
 * Point d'entrée du processus enfant lancé par `executerEnEnfant` (enfant.js). Ne
 * s'importe pas : il s'exécute.
 *
 *   node [--max-old-space-size=N] enfant-travail.mjs <dossier-de-travail>
 *
 * Le dossier de travail contient `entree.json` ({ module, entree, limiteMo, pileMo,
 * scoreOom, sondeParentMs }). Le module désigné exporte `executer(entree, { etape, partiel })`.
 *
 * Le travail tourne dans un Worker, pas dans le fil principal de l'enfant : c'est le
 * seul moyen de régler la taille de pile sur toute plateforme, et un dépassement de
 * tas du Worker se rattrape ici (`ERR_WORKER_OUT_OF_MEMORY`) au lieu d'abattre le
 * processus. Ce que le Worker ne peut pas contenir (l'abandon du compilateur
 * d'expressions régulières de V8 quand la pile est presque pleine, la mort par le
 * noyau) tue l'enfant entier : c'est pour cela qu'il y a un enfant, et le parent
 * le dit (`cause`).
 *
 * Ce que l'enfant rend, il l'écrit dans des fichiers du dossier de travail :
 *   etape.txt      la dernière étape annoncée (elle survit à la mort du processus)
 *   partiel.json   ce que le module a jugé utile de sortir avant la fin
 *   resultat.json  { "termine": true, "resultat": … }, écrit d'un bloc puis renommé :
 *                  un fichier qui n'a pas ce marqueur, ou qui ne se lit pas, n'est pas un résultat
 *   echec.json     la cause quand l'enfant a pu la dire (tas épuisé, exception)
 *   mesures.json   { "rssMaxMo" } : le pic de mémoire résidente du processus, écrit quand l'enfant
 *                  se termine de lui-même (absent quand il est tué : il n'a pas pu l'écrire)
 * Codes de sortie : 0 résultat écrit · 86 tas du Worker épuisé · 87 exception.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { CODE_EXCEPTION, CODE_TAS_EPUISE } from './codes.js';

function ecrireAtomique(chemin, contenu) {
  const tmp = `${chemin}.tmp`;
  fs.writeFileSync(tmp, contenu);
  fs.renameSync(tmp, chemin);
}

if (isMainThread) {
  const dossier = process.argv[2];
  const { module: cheminModule, entree, limiteMo, pileMo, scoreOom, sondeParentMs } = JSON.parse(fs.readFileSync(path.join(dossier, 'entree.json'), 'utf8'));

  // Le noyau, à court de mémoire dans le conteneur, tue d'abord le processus qui a le plus fort score : celui-ci, jamais le parent qui écrira le repli.
  // Relever son propre score est permis sans privilège ; sans /proc (Windows, macOS) ce n'est pas nécessaire.
  if (scoreOom != null) { try { fs.writeFileSync('/proc/self/oom_score_adj', String(scoreOom)); } catch { /* pas de /proc, ou refus : sans effet sur le reste */ } }

  // Un parent tué sans avoir pu nous tuer ne doit pas laisser une analyse tourner dans le vide.
  const parentInitial = process.ppid;
  // Il mène son propre groupe de processus (voir enfant.js) : ce qu'il a lancé (npm audit) meurt avec lui.
  setInterval(() => {
    if (process.ppid === parentInitial) return;
    // Le parent n'a pas pu nettoyer (tué sans préavis) : le dossier de travail est à nous, il part avec nous.
    try { fs.rmSync(dossier, { recursive: true, force: true }); } catch { /* déjà parti */ }
    if (process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGKILL'); } catch { /* pas chef de groupe */ } }
    process.exit(0);
  }, sondeParentMs).unref();

  // La limite du tas est celle de l'option `--max-old-space-size` du processus (enfant.js) ; celle-ci ne fait que la répéter au Worker.
  const resourceLimits = {};
  if (limiteMo) resourceLimits.maxOldGenerationSizeMb = limiteMo;
  if (pileMo) resourceLimits.stackSizeMb = pileMo;
  const mesurer = () => {
    try { ecrireAtomique(path.join(dossier, 'mesures.json'), JSON.stringify({ rssMaxMo: Math.round(process.resourceUsage().maxRSS / 1024) })); } catch { /* une mesure de moins */ }
  };
  const echec = (code, cause) => {
    try { ecrireAtomique(path.join(dossier, 'echec.json'), JSON.stringify(cause)); } catch { /* le code de sortie suffit */ }
    mesurer();
    process.exit(code);
  };
  let worker;
  try {
    worker = new Worker(new URL(import.meta.url), { workerData: { dossier, cheminModule, entree }, resourceLimits });
  } catch (e) { // pile ou mémoire demandées que le système ne peut pas donner : le fil ne démarre pas, rien n'a été lu
    echec(CODE_EXCEPTION, { genre: 'exception', message: `le fil de travail n'a pas pu démarrer : ${e?.code ?? ''} ${e?.message ?? e}`.replace(/\s+/g, ' ').trim() });
  }
  worker.on('error', (e) => {
    if (e?.code === 'ERR_WORKER_OUT_OF_MEMORY') echec(CODE_TAS_EPUISE, { genre: 'tas', message: String(e.message).split('\n')[0], limiteMo: limiteMo ?? null });
    else echec(CODE_EXCEPTION, { genre: 'exception', message: String(e?.message ?? e).split('\n')[0].slice(0, 500), pile: String(e?.stack ?? '').split('\n').slice(0, 6).join('\n') });
  });
  worker.on('exit', (code) => {
    // Un Worker qui se termine sans erreur a écrit son résultat ; le parent le vérifie de toute façon.
    if (code === 0) { mesurer(); process.exit(0); }
    echec(CODE_EXCEPTION, { genre: 'exception', message: `le Worker s'est terminé avec le code ${code}` });
  });
} else {
  const { dossier, cheminModule, entree } = workerData;
  const etape = (nom) => fs.writeFileSync(path.join(dossier, 'etape.txt'), String(nom));
  const partiel = (objet) => ecrireAtomique(path.join(dossier, 'partiel.json'), JSON.stringify(objet));
  const module = await import(pathToFileURL(cheminModule).href);
  const resultat = await module.executer(entree, { etape, partiel });
  ecrireAtomique(path.join(dossier, 'resultat.json'), JSON.stringify({ termine: true, resultat }));
  // Le résultat est écrit : rien de ce que le travail a laissé ouvert (un processus lancé, un minuteur) ne doit retenir la fin. Le parent tue ce qui reste.
  process.exit(0);
}
