/**
 * Moteur commun des scripts de mutants (`mutants-passe-html.mjs`,
 * `mutants-css.mjs`, …).
 *
 * Un mutant réintroduit UN défaut dans une copie temporaire du code (le dépôt
 * n'est jamais modifié) : la suite ciblée doit alors échouer. Un mutant qui
 * survit veut dire que le test qui devait protéger ce point ne prouve rien.
 *
 * Ce qui garde la preuve honnête :
 *  - toutes les chaînes à remplacer sont vérifiées (exactement une occurrence,
 *    et un mutant qui ne compile pas ne compte pas) AVANT le premier essai, et
 *    tous les problèmes sont dits d'un coup (code 2) ;
 *  - la suite doit être verte et complète (aucun test sauté) sur le code non
 *    muté : un mutant « tué » par une suite déjà cassée ne prouve rien ;
 *  - un mutant n'est tué que par un test nommé en échec (« par un test »), ou
 *    par un délai dépassé, dit comme tel (« par un délai » : le code muté ne
 *    finit plus, aucun test ne l'a jugé). Un plantage (le lanceur ou un
 *    fichier de test meurt sans qu'un test nommé échoue : mémoire, module qui
 *    ne se charge pas, signal, autre code de sortie) ne tue rien : il est dit
 *    à part et fait échouer le lot.
 * Trois comptes sont affichés : tués par un test, tués par un délai,
 * plantages. Code 1 si un mutant survit ou plante, 0 sinon.
 *
 * Un lot est synchrone de bout en bout : `kill` l'arrête sur-le-champ, sans lui
 * laisser le temps de nettoyer. Sa copie (`gwaudit-mutants-<pid>-…`) et les
 * processus de sa suite restent alors : le lot suivant les retire au départ
 * (`balayerCopiesAbandonnees`), une copie dont le lot tourne encore n'est pas
 * touchée.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DELAI_MS = 10 * 60 * 1000;                           // par défaut : la suite d'un lot de tests entiers ; un mutant qui boucle sans fin y est tué par ce délai (dit comme tel)
/** Ce que la copie contient par défaut ; un script dont les tests lancent `bin/gwaudit.js` ou lisent `docker/` ajoute ce qu'il lui faut via `dossiers`. */
export const DOSSIERS_COPIES = ['src', 'tests', 'fixtures', 'scripts'];

/** Un nombre du résumé que `node --test` imprime (`# tests 12`, `# fail 1`…) ; NaN s'il ne l'a pas imprimé. */
const compter = (sortie, nom) => Number(new RegExp(`^# ${nom} (\\d+)`, 'm').exec(sortie)?.[1] ?? NaN);

/**
 * Ce que dit un lancement de `node --test`, d'après ce que `spawnSync` a rendu
 * (`r`) : 'passe', 'test', 'delai' ou 'plantage'.
 *  - 'delai' : `spawnSync` a arrêté le lanceur à la fin du délai
 *    (`r.error.code === 'ETIMEDOUT'`). Le code de sortie ne le dit pas :
 *    `node --test` intercepte SIGTERM et sort en 1, sans imprimer son résumé
 *    (`status === null` n'arrive jamais).
 *  - 'test' : le lanceur a fini normalement (code 1, résumé imprimé) et au
 *    moins un test NOMMÉ est en échec. `fichiersEnEchec` liste les fichiers de
 *    test entiers qui échouent en plus (un test qui a fait mourir son
 *    processus, par exemple) : ils ne comptent pas comme un test nommé.
 *  - 'plantage' : tout autre échec (lancement impossible, code autre que 0 ou 1,
 *    signal, résumé absent, aucun test nommé en échec), avec sa `raison`.
 * @param {{ status: ?number, signal: ?string, error?: ?{ code?: string, message?: string }, stdout?: ?string }} r
 * @param {string[]} fichiers les fichiers de test passés au lanceur (leur nom entier n'est pas un test)
 */
export function classerLancement(r, fichiers) {
  const sortie = r.stdout ?? '';
  const noms = [...sortie.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((nom, k, tous) => tous.indexOf(nom) === k);
  const estFichier = (nom) => fichiers.some((f) => nom === f || nom.endsWith(`/${f}`));
  const bilan = {
    saute: compter(sortie, 'skipped'), echecs: compter(sortie, 'fail'), lances: compter(sortie, 'tests'),
    tueurs: noms.filter((nom) => !estFichier(nom)), fichiersEnEchec: noms.filter(estFichier), raison: null,
  };
  const plantage = (raison) => ({ ...bilan, verdict: 'plantage', raison });
  if (r.error?.code === 'ETIMEDOUT') return { ...bilan, verdict: 'delai' };
  if (r.error) return plantage(`le lancement a échoué : ${r.error.code ?? r.error.message}`);
  if (r.status === 0) return { ...bilan, verdict: 'passe' };
  if (r.status !== 1) return plantage(r.signal ? `tué par ${r.signal}` : `sorti avec le code ${r.status}`);
  if (Number.isNaN(bilan.echecs)) return plantage("le lanceur n'a pas imprimé son résumé");
  if (!bilan.tueurs.length) {
    return plantage(bilan.fichiersEnEchec.length ? `seuls des fichiers de test entiers échouent (${bilan.fichiersEnEchec.join(', ')}), aucun test nommé` : 'code 1 sans aucun test en échec');
  }
  return { ...bilan, verdict: 'test' };
}

/**
 * Tue les processus dont le répertoire courant est `dossier` ou l'un de ses
 * sous-dossiers (`/proc/<pid>/cwd`) : ce que le lanceur tué par le délai et un
 * test qui échoue laissent derrière eux (un Chromium, un serveur, un fichier de
 * test qui boucle). Leur ligne de commande n'a que des chemins relatifs :
 * `pkill -f <dossier>` ne les reconnaît pas. Sans `/proc` (autre système, ou
 * `proc` qui n'existe pas), repli sur `pkill -f`, qui ne voit que ceux dont la
 * ligne de commande contient le dossier. Rend le nombre de processus tués (0 au
 * repli, `pkill` ne le dit pas).
 */
export function tuerProcessusDe(dossier, { proc = '/proc' } = {}) {
  let tues = 0;
  let noms;
  try {
    noms = fs.readdirSync(proc);
  } catch {
    spawnSync('pkill', ['-KILL', '-f', dossier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]);
    return tues;
  }
  for (const nom of noms) {
    if (!/^\d+$/.test(nom) || Number(nom) === process.pid) continue;
    let cwd;
    try { cwd = fs.readlinkSync(path.join(proc, nom, 'cwd')); } catch { continue; }
    if (cwd !== dossier && !cwd.startsWith(dossier + path.sep)) continue;
    try { process.kill(Number(nom), 'SIGKILL'); tues += 1; } catch { /* déjà mort */ }
  }
  return tues;
}

/** Le processus `pid` existe-t-il ? Seul `ESRCH` dit qu'il n'y en a pas (`EPERM` : il existe, à un autre utilisateur). */
const existe = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};

/**
 * Retire ce qu'un lot tué (kill, coupure, mémoire) a laissé dans `tmp` : sa copie
 * du code, `gwaudit-mutants-<pid du lot>-…`, et les processus qui y tournent
 * encore. Le lot ne peut pas le faire lui-même : tout son travail est synchrone,
 * un gestionnaire de signal ne s'exécuterait qu'à la fin et `kill` ne l'arrêterait
 * plus. Une copie dont le lot existe encore (un autre lot en parallèle) n'est
 * pas touchée. Rend les copies retirées.
 */
export function balayerCopiesAbandonnees(tmp = os.tmpdir()) {
  const retirees = [];
  let noms;
  try { noms = fs.readdirSync(tmp); } catch { return retirees; }
  for (const nom of noms) {
    const m = /^gwaudit-mutants-(\d+)-/.exec(nom);
    if (!m || existe(Number(m[1]))) continue;
    try {
      const dossier = path.join(fs.realpathSync(tmp), nom);
      tuerProcessusDe(dossier);
      fs.rmSync(dossier, { recursive: true, force: true });
      retirees.push(dossier);
    } catch { /* une copie qui n'est pas à nous (autre utilisateur) : on n'y touche pas */ }
  }
  return retirees;
}

/**
 * @param {{
 *   mutants: Array<{ libelle: string, fichier: string, ancien: string, nouveau: string }>,
 *   groupes: Array<{ nom: string, fichiers: string[] }>,
 *   exigerChromium?: boolean,
 *   partie?: ?{ i: number, n: number },
 *   dossiers?: string[],
 *   delaiMs?: number,
 *   racine?: string,
 *   sortie?: (ligne: string) => void,
 *   erreur?: (ligne: string) => void,
 *   rapporter?: ?((bilan: { retenus: number, tuesParUnTest: number, tuesParUnDelai: number, plantages: number, survivants: number, mutants: Array<{ libelle: string, issue: 'test' | 'delai' | 'plantage' | 'survit', detail: ?string }> }) => void),
 * }} options `groupes` : suites lancées dans l'ordre, la première qui échoue tue le mutant.
 *   `delaiMs` : le délai d'une suite (10 minutes par défaut) ; un lot dont les mutants peuvent boucler sans fin (une file sans garde contre les cycles) le réduit à quelques fois la durée de sa suite, pour
 *   ne pas attendre dix minutes par mutant.
 *   `partie` : ne rejouer que le i-ième des n paquets (1 à n), pour lancer n processus à la fois ; chacun a sa copie, et
 *   vérifie quand même tous les mutants avant de commencer.
 *   `racine` : le projet à copier (le dépôt par défaut) ; `sortie` et `erreur` : où vont les lignes (la console par défaut) ;
 *   `rapporter` : reçoit le bilan chiffré à la fin (les essais du moteur lui-même le lisent).
 * @returns {number} le code de sortie : 0 tous tués (par un test ou un délai), 1 un mutant survit ou plante, 2 le lot n'a pas pu commencer
 */
export function rejouerMutants({
  mutants, groupes, exigerChromium = true, partie = null, dossiers = DOSSIERS_COPIES, delaiMs = DELAI_MS,
  racine = RACINE, sortie = console.log, erreur = console.error, rapporter = null,
}) {
  if (exigerChromium && !process.env.GWAUDIT_CHROMIUM_PATH) {
    erreur('GWAUDIT_CHROMIUM_PATH est requis : le différentiel Chromium fait partie de la preuve, un test sauté ne tuerait rien.');
    return 2;
  }
  if (!mutants.length) {
    erreur('Aucun mutant retenu : rien à rejouer.');
    return 2;
  }

  // Un lot tué avant celui-ci (kill, coupure) a pu laisser sa copie et des processus : ils partent d'abord. Le lot lui-même ne pose aucun gestionnaire de signal : tout son travail est synchrone, un gestionnaire ne s'exécuterait qu'à la fin et `kill` n'arrêterait plus rien.
  const abandonnees = balayerCopiesAbandonnees();
  if (abandonnees.length) erreur(`${abandonnees.length} copie(s) laissée(s) par un lot interrompu retirée(s), avec leurs processus : ${abandonnees.join(', ')}`);

  // Le chemin réel : `/proc/<pid>/cwd` le rend ainsi, et `tuerProcessusDe` le compare tel quel (un TMPDIR qui passe par un lien symbolique ne fausse rien). Le pid du lot est dans le nom : c'est ce qui dit qu'une copie est abandonnée.
  const copie = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gwaudit-mutants-${process.pid}-`)));
  // mkdtemp crée un dossier 0700 : un test qui lance le code sous un autre utilisateur (bac à sable de Chromium sous root) doit pouvoir le lire. Ce n'est qu'une copie de sources publiques.
  fs.chmodSync(copie, 0o755);

  // Le lanceur d'un essai n'est pas celui d'une suite qui s'exécute déjà sous `node --test` : la variable qui le dit fait croire à un sous-processus.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const lancer = (fichiers) => {
    const r = spawnSync('node', ['--test', ...fichiers], { cwd: copie, encoding: 'utf8', env, timeout: delaiMs, maxBuffer: 1 << 26 });
    const bilan = classerLancement(r, fichiers);
    // Un délai ou un plantage laisse des processus derrière lui ; un lancement qui a fini normalement, non.
    if (bilan.verdict === 'delai' || bilan.verdict === 'plantage') tuerProcessusDe(copie);
    return bilan;
  };

  try {
    for (const dossier of dossiers) if (fs.existsSync(path.join(racine, dossier))) fs.cpSync(path.join(racine, dossier), path.join(copie, dossier), { recursive: true });
    if (fs.existsSync(path.join(racine, 'package.json'))) fs.copyFileSync(path.join(racine, 'package.json'), path.join(copie, 'package.json'));
    if (fs.existsSync(path.join(racine, 'node_modules'))) fs.symlinkSync(path.join(racine, 'node_modules'), path.join(copie, 'node_modules'));

    // Chaque chaîne d'origine, une seule fois, et un mutant qui compile : rien ne se lance avant que tout soit dit.
    const problemes = [];
    // Un fichier de test qui n'existe pas serait ignoré sans un mot par `node --test` (Node 22 le prend pour un motif qui ne trouve rien) : la suite serait plus petite que celle qu'on croit.
    for (const g of groupes) for (const f of g.fichiers) if (!fs.existsSync(path.join(copie, f))) problemes.push(`groupe « ${g.nom} » : le fichier de test ${f} n'existe pas (le lanceur l'ignorerait sans rien dire)`);
    for (const [numero, m] of mutants.entries()) {
      const chemin = path.join(copie, m.fichier);
      if (!fs.existsSync(chemin)) { problemes.push(`mutant ${numero + 1} (${m.libelle}) : ${m.fichier} n'existe pas`); continue; }
      const original = fs.readFileSync(chemin, 'utf8');
      const occurrences = original.split(m.ancien).length - 1;
      if (occurrences !== 1) { problemes.push(`mutant ${numero + 1} (${m.libelle}) : « ${m.ancien.slice(0, 70).replace(/\n/g, ' ')} » trouvé ${occurrences} fois dans ${m.fichier}, exactement une attendue`); continue; }
      if (m.nouveau === m.ancien) { problemes.push(`mutant ${numero + 1} (${m.libelle}) : la chaîne mutée est identique à l'originale`); continue; }
      fs.writeFileSync(chemin, original.replace(m.ancien, () => m.nouveau));
      // Un script shell se vérifie avec bash, un fichier JavaScript avec node : un mutant qui ne s'analyse pas ne prouve rien.
      // Tout autre fichier (Dockerfile, YAML…) n'a pas d'analyse ici.
      const syntaxe = chemin.endsWith('.sh') ? spawnSync('bash', ['-n', chemin], { encoding: 'utf8' })
        : /\.[cm]?js$/.test(chemin) ? spawnSync('node', ['--check', chemin], { encoding: 'utf8' })
          : { status: 0 };
      fs.writeFileSync(chemin, original);
      if (syntaxe.status !== 0) problemes.push(`mutant ${numero + 1} (${m.libelle}) : le code muté ne compile pas, ce qui « tuerait » n'importe quoi`);
    }
    if (problemes.length) {
      erreur(`${problemes.length} mutant(s) à corriger avant de rien conclure (le code a changé ou le mutant est mal écrit) :`);
      for (const p of problemes) erreur(` - ${p}`);
      return 2;
    }

    const base = lancer(groupes.flatMap((g) => g.fichiers));
    if (base.verdict !== 'passe' || base.saute !== 0 || !(base.lances > 0)) {
      erreur(`La suite ciblée n'est pas verte et complète sur le code non muté (verdict : ${base.verdict}${base.raison ? `, ${base.raison}` : ''}, sautés : ${base.saute}, lancés : ${base.lances}) : rien à conclure.`);
      return 2;
    }
    sortie(`Suite non mutée : ${base.lances} tests, 0 sauté, ${mutants.length} mutants à rejouer.\n`);

    const retenus = partie ? mutants.filter((_, k) => k % partie.n === partie.i - 1) : mutants;
    if (partie) sortie(`Paquet ${partie.i}/${partie.n} : ${retenus.length} mutants sur ${mutants.length}.\n`);

    /** Ce que valent les suites d'un groupe après l'autre pour le mutant posé : la première qui échoue par un test ou un délai le tue, un plantage se garde pour le dire si rien d'autre ne tue. */
    const juger = () => {
      let plantage = null;
      for (const g of groupes) {
        const r = lancer(g.fichiers);
        if (r.verdict === 'passe') continue;
        if (r.verdict === 'test') {
          const noms = r.tueurs.slice(0, 2).map((n) => (n.length > 70 ? `${n.slice(0, 67)}...` : n)).join(' | ');
          const fichiers = r.fichiersEnEchec.length ? ` ; ${r.fichiersEnEchec.length > 1 ? 'les fichiers' : 'le fichier'} ${r.fichiersEnEchec.join(', ')} ${r.fichiersEnEchec.length > 1 ? 'échouent' : 'échoue'} aussi` : '';
          return { issue: 'test', detail: `${g.nom}, ${r.echecs} en échec : ${noms}${fichiers}` };
        }
        if (r.verdict === 'delai') return { issue: 'delai', detail: `${g.nom}, délai de ${Math.round(delaiMs / 100) / 10} s dépassé, aucun test n'a jugé le mutant` };
        plantage ??= `${g.nom}, ${r.raison}`;
      }
      return plantage ? { issue: 'plantage', detail: plantage } : { issue: 'survit', detail: null };
    };
    const ETIQUETTE = { test: 'TUÉ      ', delai: 'TUÉ délai', plantage: 'PLANTAGE ', survit: 'SURVIT   ' };

    const bilan = { retenus: retenus.length, tuesParUnTest: 0, tuesParUnDelai: 0, plantages: 0, survivants: 0, mutants: [] };
    for (const m of retenus) {
      const chemin = path.join(copie, m.fichier);
      const original = fs.readFileSync(chemin, 'utf8');
      fs.writeFileSync(chemin, original.replace(m.ancien, () => m.nouveau));
      let jugement;
      try {
        jugement = juger();
      } finally {
        fs.writeFileSync(chemin, original);
      }
      if (jugement.issue === 'test') bilan.tuesParUnTest += 1;
      else if (jugement.issue === 'delai') bilan.tuesParUnDelai += 1;
      else if (jugement.issue === 'plantage') bilan.plantages += 1;
      else bilan.survivants += 1;
      bilan.mutants.push({ libelle: m.libelle, ...jugement });
      sortie(`${ETIQUETTE[jugement.issue]} ${m.libelle}${jugement.detail ? `  (${jugement.detail})` : ''}`);
    }
    const tues = bilan.tuesParUnTest + bilan.tuesParUnDelai;
    sortie('');
    sortie(`${tues}/${bilan.retenus} mutants tués : ${bilan.tuesParUnTest} par un test, ${bilan.tuesParUnDelai} par un délai ; ${bilan.plantages} plantage${bilan.plantages > 1 ? 's' : ''} ; ${bilan.survivants} survivant${bilan.survivants > 1 ? 's' : ''}`);
    if (rapporter) rapporter(bilan);
    return bilan.survivants || bilan.plantages ? 1 : 0;
  } finally {
    fs.rmSync(copie, { recursive: true, force: true });
  }
}

/** `--part=i/n` dans les arguments (1 ≤ i ≤ n) ; les autres arguments sont rendus tels quels. */
export function lireArguments(argv) {
  let partie = null;
  const restants = [];
  for (const a of argv) {
    const m = /^--part=(\d+)\/(\d+)$/.exec(a);
    if (!m) { restants.push(a); continue; }
    const [i, n] = [Number(m[1]), Number(m[2])];
    if (i < 1 || i > n) throw new Error(`--part=${i}/${n} : i doit être entre 1 et n`);
    partie = { i, n };
  }
  return { partie, restants };
}
