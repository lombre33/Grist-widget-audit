/**
 * Les budgets de temps (`tests/budgets/*.budget.mjs`) : ce que la suite par défaut ne mesure jamais.
 *
 * Un budget dit qu'une entrée hostile (un mégaoctet de blancs, quarante mille références sur une ligne) se lit en un
 * temps borné, et c'est ce qui fait d'un algorithme quadratique un déni de service en V2. Ce n'est pas un test comme
 * les autres : son verdict dépend de la machine, de sa charge, de ce qui tourne à côté. Il n'a donc sa place ni dans
 * la suite par défaut (un test vert ne doit pas dépendre de l'horloge), ni dans la base des mutants (un mutant tué par
 * la charge de la machine n'est pas un mutant tué). Il se lance à part, `scripts/verifier-budgets.mjs`, et il se
 * rejoue sur les mutants qu'il est seul à tuer, `scripts/mutants-budgets.mjs`.
 *
 * Un fichier de budgets exporte `cas` : `{ nom, budgetMs, executer, ignorerSi? }`. `executer` fait le travail et lève si son
 * résultat est faux (un budget tenu par un résultat faux ne prouve rien) ; il n'est mesuré que lui, pas le chargement du
 * module. `ignorerSi` (optionnel, éventuellement asynchrone) rend la raison pour laquelle le cas ne peut pas être joué
 * ici (Chromium absent) ou null : le cas est alors dit ignoré, jamais passé sous silence.
 * Chaque cas tourne dans son propre processus, avec une limite dure : un quadratique sur un mégaoctet dure des
 * centaines de secondes, et il faut le dire (`limite`) au lieu de l'attendre.
 *
 * Deux modes :
 *   local (par défaut)   le budget lui-même, et l'exécution refusée si la machine n'est pas au calme ;
 *   CI (`--ci`)          un ordre de grandeur au-dessus du budget (`FACTEUR_CI`), sans refus sous charge : un runner partagé
 *                        est bruyant, et ce mode n'est là que pour qu'une régression algorithmique (×100 et plus) ne passe pas.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DOSSIER_BUDGETS = fileURLToPath(new URL('../../tests/budgets/', import.meta.url));
const ENFANT = fileURLToPath(new URL('./cas-budget.mjs', import.meta.url));

/** En mode CI, le budget d'un cas est celui du cas fois ce facteur (un ordre de grandeur). */
export const FACTEUR_CI = 10;
/** La limite dure d'un cas : au moins `LIMITE_DURE_MIN_MS`, et `FACTEUR_LIMITE` fois le budget retenu ; au-delà, le processus est tué. */
export const FACTEUR_LIMITE = 20;
export const LIMITE_DURE_MIN_MS = 30_000;
/** Part du temps de processeur occupée, mesurée sur `ECHANTILLON_MS`, au-delà de laquelle le mode local refuse de mesurer. */
export const OCCUPATION_MAX = 0.25;
export const ECHANTILLON_MS = 1500;

/** Le temps de processeur occupé et le temps total d'un instantané de `os.cpus()`. */
const totaux = (cpus) => {
  let occupe = 0;
  let total = 0;
  for (const { times } of cpus) {
    const somme = times.user + times.nice + times.sys + times.idle + times.irq;
    total += somme;
    occupe += somme - times.idle;
  }
  return { occupe, total };
};

/** La part du processeur occupée entre deux instantanés de `os.cpus()` (0 à 1) ; null si rien n'a avancé (deux instantanés identiques : rien à en conclure). */
export function occupationEntre(avant, apres) {
  const a = totaux(avant);
  const b = totaux(apres);
  if (!(b.total > a.total)) return null;
  return (b.occupe - a.occupe) / (b.total - a.total);
}

/** Mesure l'occupation de la machine pendant `ms` millisecondes (synchrone : elle attend sans rien exécuter d'autre). */
export function mesurerOccupation({ ms = ECHANTILLON_MS, lire = () => os.cpus(), attendre = (d) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, d) } = {}) {
  const avant = lire();
  attendre(ms);
  return occupationEntre(avant, lire());
}

/** Pourquoi le mode local refuse de mesurer, ou null. Une occupation inconnue (null) est un refus : un budget mesuré à l'aveugle ne dit rien. */
export function refusSousCharge(occupation, { max = OCCUPATION_MAX } = {}) {
  if (occupation === null || occupation === undefined || Number.isNaN(occupation)) return "l'occupation de la machine n'a pas pu être mesurée : un budget de temps mesuré à l'aveugle ne dit rien";
  if (occupation > max) {
    return `la machine n'est pas au calme (${Math.round(occupation * 100)} % du processeur occupé, ${Math.round(max * 100)} % au plus) : un budget de temps mesuré sous charge dit la charge, pas le code. Rejouer quand plus rien ne tourne, ou en mode CI (--ci), qui ne mesure qu'un ordre de grandeur.`;
  }
  return null;
}

/** Ce que le mode fait du budget d'un cas : le budget lui-même en local, un ordre de grandeur au-dessus en CI. */
export const budgetRetenu = (budgetMs, ci) => (ci ? budgetMs * FACTEUR_CI : budgetMs);
export const limiteDure = (budgetMs, ci) => Math.max(LIMITE_DURE_MIN_MS, FACTEUR_LIMITE * budgetRetenu(budgetMs, ci));

/**
 * Le verdict d'un cas d'après ce que son processus a rendu.
 * @param {{ statut: 'ok' | 'echec' | 'limite', dureeMs: ?number, raison: ?string }} resultat
 * @returns {{ verdict: 'passe' | 'lent' | 'echec' | 'limite', dureeMs: ?number, budgetMs: number, raison: ?string }}
 */
export function jugerCas(resultat, budgetMs, ci) {
  const retenu = budgetRetenu(budgetMs, ci);
  if (resultat.statut === 'limite') return { verdict: 'limite', dureeMs: null, budgetMs: retenu, raison: resultat.raison };
  if (resultat.statut !== 'ok') return { verdict: 'echec', dureeMs: resultat.dureeMs ?? null, budgetMs: retenu, raison: resultat.raison };
  if (resultat.dureeMs > retenu) return { verdict: 'lent', dureeMs: resultat.dureeMs, budgetMs: retenu, raison: null };
  return { verdict: 'passe', dureeMs: resultat.dureeMs, budgetMs: retenu, raison: null };
}

/** Les cas de tous les fichiers `*.budget.mjs` de `dossier`, dans l'ordre : `{ fichier, indice, nom, budgetMs, ignore }` (`ignore` : la raison, ou null). */
export async function listerCas(dossier = DOSSIER_BUDGETS) {
  const cas = [];
  for (const nom of fs.readdirSync(dossier).filter((n) => n.endsWith('.budget.mjs')).sort()) {
    const fichier = path.join(dossier, nom);
    const module = await import(pathToFileURL(fichier).href);
    if (!Array.isArray(module.cas) || !module.cas.length) throw new Error(`${nom} : doit exporter \`cas\`, une liste non vide de { nom, budgetMs, executer }`);
    for (const [indice, c] of module.cas.entries()) {
      if (typeof c.nom !== 'string' || !c.nom || typeof c.executer !== 'function' || !(c.budgetMs > 0)) throw new Error(`${nom}, cas ${indice + 1} : { nom, budgetMs > 0, executer } attendus`);
      cas.push({ fichier, indice, nom: c.nom, budgetMs: c.budgetMs, ignore: (await c.ignorerSi?.()) ?? null });
    }
  }
  return cas;
}

/**
 * Lance un cas dans son processus, avec une limite dure. Rend ce que le processus a dit : `{ statut, dureeMs, raison }`.
 * @param {{ fichier: string, indice: number }} cas
 * @param {{ limiteMs: number, env?: object }} options
 */
export function executerCas(cas, { limiteMs, env = process.env }) {
  const r = spawnSync(process.execPath, [ENFANT, cas.fichier, String(cas.indice)], { encoding: 'utf8', timeout: limiteMs, killSignal: 'SIGKILL', maxBuffer: 1 << 24, env });
  if (r.error?.code === 'ETIMEDOUT') return { statut: 'limite', dureeMs: null, raison: `pas fini au bout de la limite dure de ${Math.round(limiteMs / 1000)} s : le processus a été tué` };
  if (r.error) return { statut: 'echec', dureeMs: null, raison: `le processus du cas n'a pas pu être lancé : ${r.error.code ?? r.error.message}` };
  const ligne = (r.stdout ?? '').split('\n').filter(Boolean).pop() ?? '';
  let rendu = null;
  try { rendu = JSON.parse(ligne); } catch { /* pas de JSON : le cas est mort avant de le dire */ }
  if (r.status === 0 && rendu && Number.isFinite(rendu.dureeMs)) return { statut: 'ok', dureeMs: rendu.dureeMs, raison: null };
  const fin = (r.stderr ?? '').trim().split('\n').slice(-3).join(' | ').slice(-400);
  return { statut: 'echec', dureeMs: null, raison: rendu?.erreur ?? (r.signal ? `tué par ${r.signal}` : `sorti avec le code ${r.status}${fin ? ` : ${fin}` : ''}`) };
}

const ETIQUETTE = { passe: 'ok       ', lent: 'TROP LENT', echec: 'FAUTIF   ', limite: 'TUÉ      ' };

/**
 * `scripts/verifier-budgets.mjs` : lister ou rejouer les cas de `dossier`.
 * @param {object} o
 * @param {string[]} o.argv       `--ci`, `--liste`, et une expression régulière sur le nom du cas
 * @param {string} [o.dossier]    le dossier des fichiers `*.budget.mjs`
 * @param {() => ?number} [o.occupation]   la part du processeur occupée (0 à 1) ; null si elle n'a pas pu être mesurée
 * @param {(ligne: string) => void} [o.sortie]
 * @param {(ligne: string) => void} [o.erreur]
 * @returns {Promise<number>} 0 tous les cas tenus, 1 un cas trop lent, fautif ou tué, 2 rien n'a pu être mesuré (machine chargée, aucun cas)
 */
export async function verifierBudgets({ argv, dossier = DOSSIER_BUDGETS, occupation = () => mesurerOccupation(), sortie = console.log, erreur = console.error }) {
  const ci = argv.includes('--ci');
  const filtre = argv.filter((a) => !a.startsWith('--'))[0];
  const cas = (await listerCas(dossier)).filter((c) => !filtre || new RegExp(filtre).test(c.nom));
  if (!cas.length) {
    erreur(`Aucun cas de budget${filtre ? ` pour « ${filtre} »` : ''} : rien à mesurer.`);
    return 2;
  }
  if (argv.includes('--liste')) {
    for (const c of cas) sortie(`${String(budgetRetenu(c.budgetMs, ci)).padStart(7)} ms  ${c.nom}${c.ignore ? `  (ignoré : ${c.ignore})` : ''}`);
    return 0;
  }
  if (!ci) {
    const refus = refusSousCharge(occupation());
    if (refus) {
      erreur(`Budgets non mesurés : ${refus}`);
      return 2;
    }
  }

  sortie(ci ? `Mode CI : chaque budget multiplié par ${FACTEUR_CI}, aucun refus sous charge.\n` : 'Mode local : le budget de chaque cas, machine au calme.\n');
  let mauvais = 0;
  let ignores = 0;
  for (const c of cas) {
    if (c.ignore) {
      ignores += 1;
      sortie(`IGNORÉ    ${c.nom}  (${c.ignore})`);
      continue;
    }
    const r = jugerCas(executerCas(c, { limiteMs: limiteDure(c.budgetMs, ci) }), c.budgetMs, ci);
    const mesure = r.dureeMs === null ? '' : `${Math.round(r.dureeMs)} ms sur ${r.budgetMs} ms  `;
    sortie(`${ETIQUETTE[r.verdict]} ${mesure}${c.nom}${r.raison ? `  (${r.raison})` : ''}`);
    if (r.verdict !== 'passe') mauvais += 1;
  }
  const joues = cas.length - ignores;
  sortie(`\n${joues - mauvais}/${joues} cas tenus${mauvais ? `, ${mauvais} non tenu${mauvais > 1 ? 's' : ''}` : ''}${ignores ? `, ${ignores} ignoré${ignores > 1 ? 's' : ''} (dit ci-dessus : un cas ignoré n'a rien mesuré)` : ''}.`);
  return mauvais ? 1 : 0;
}
