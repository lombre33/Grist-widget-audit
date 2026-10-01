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
 *  - un lancement qui n'a jugé rien (zéro test lancé, ou un essai qui a retiré
 *    la copie du lot, un de ses fichiers de test ou son dossier temporaire :
 *    tout ce qui échoue ensuite échoue pour cela, pas pour le mutant) est un
 *    plantage de l'outil, dit à part et qui fait échouer le lot.
 * Trois comptes sont affichés : tués par un test, tués par un délai,
 * plantages. Code 1 si un mutant survit ou plante, 0 sinon.
 *
 * Un lot est synchrone de bout en bout : `kill` l'arrête sur-le-champ, sans lui
 * laisser le temps de nettoyer. Sa copie (`gwaudit-mutants-<pid>-…`) et les
 * processus de sa suite restent alors : le lot suivant les retire au départ
 * (`balayerCopiesAbandonnees`), une copie dont le lot tourne encore n'est pas
 * touchée.
 *
 * Un mutant écrit par `dansLigne` (la ligne du fichier qui porte un motif) dont
 * le motif ne désigne plus une ligne unique est refusé avec sa raison, comme
 * une chaîne d'origine absente : le lot ne meurt plus d'une exception au
 * chargement (code 1, un seul motif dit à la fois), il dit tous ses motifs
 * périmés d'un coup (code 2).
 *
 * `--valider` (ou `valider: true`) : ne fait que la vérification d'avance
 * (chaînes d'origine uniques, code muté qui compile, fichiers de test
 * présents) et rend 0 ou 2, sans lancer aucune suite, sans exiger Chromium et
 * sans toucher aux copies d'autres lots. Un essai commité
 * (`tests/lots-de-mutants.test.mjs`) la lance sur chaque lot : un lot devenu
 * muet fait passer la suite au rouge, au lieu de se taire.
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
 *    signal, résumé absent, aucun test nommé en échec, code 0 sans aucun test
 *    nommé lancé), avec sa `raison`.
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
  // Un code 0 sans résumé, sans test ou avec pour seuls « tests » des fichiers qui n'en déclarent aucun (Node en compte un par fichier vide) ne dit rien de la suite :
  // aucun essai n'a jugé le mutant, il ne « survit » pas.
  if (r.status === 0) {
    if (bilan.lances > 0 && [...sortie.matchAll(/^\s*ok \d+ - (.+)$/gm)].some((m) => !estFichier(m[1]))) return { ...bilan, verdict: 'passe' };
    return plantage(`aucun essai n'a tourné (${Number.isNaN(bilan.lances) ? 'résumé absent' : bilan.lances === 0 ? '0 test lancé' : 'aucun test nommé, seuls des fichiers sans test'}, code 0)`);
  }
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
export function balayerCopiesAbandonnees(tmp = racinesTemporaires()) {
  const retirees = [];
  for (const racine of Array.isArray(tmp) ? tmp : [tmp]) {
    let noms;
    try { noms = fs.readdirSync(racine); } catch { continue; }
    for (const nom of noms) {
      const m = /^gwaudit-mutants-(\d+)-/.exec(nom);
      if (!m || existe(Number(m[1]))) continue;
      try {
        const dossier = path.join(fs.realpathSync(racine), nom);
        tuerProcessusDe(dossier);
        fs.rmSync(dossier, { recursive: true, force: true });
        retirees.push(dossier);
      } catch { /* une copie qui n'est pas à nous (autre utilisateur) : on n'y touche pas */ }
    }
  }
  return retirees;
}

/**
 * Les dossiers où un lot a pu laisser sa copie : celui que `os.tmpdir()` désigne (TMPDIR) et `/tmp`. Un lot lancé avec
 * un autre TMPDIR que le lot tué avant lui ne verrait pas, sinon, la copie que celui-ci a laissée ; le même dossier
 * (TMPDIR=/tmp, ou un lien vers lui) n'est balayé qu'une fois.
 * `GWAUDIT_MUTANTS_RACINE_FIXE` remplace `/tmp` : les essais du moteur le posent sur un dossier à eux, parce que le moteur
 * qu'ils éprouvent est, tour à tour, un moteur muté qui balaie ce qu'il ne devrait pas — et le vrai `/tmp` porte la copie
 * de chaque lot qui tourne en parallèle. Observé : un rejeu du lot du moteur a compté 82 mutants sur 84 « tués par un test »,
 * chacun en 0,5 s au plus, sans que les essais aient eu de terrain ; la cause exacte n'a pas été établie, la piste est celle-ci.
 */
export function racinesTemporaires({ tmpdir = os.tmpdir(), fixe = process.env.GWAUDIT_MUTANTS_RACINE_FIXE || '/tmp' } = {}) {
  const vues = new Set();
  const racines = [];
  for (const racine of [tmpdir, fixe]) {
    let reelle;
    try { reelle = fs.realpathSync(racine); } catch { continue; }
    if (vues.has(reelle)) continue;
    vues.add(reelle);
    racines.push(racine);
  }
  return racines;
}

/**
 * Un lot qui lance Chromium en tant que root le lance sous un autre utilisateur (`tests/bac-a-sable-chromium.test.mjs` :
 * uid 65534) : cet utilisateur doit pouvoir traverser chaque dossier qui mène de `/` à la copie. Un dossier qui ne
 * l'est pas (`o+x` absent : un TMPDIR sous un dossier personnel en 0700) fait échouer ces essais pour une autre raison
 * que le mutant, et rien ne le dit. Rend le refus (un message qui nomme le premier dossier et dit quoi faire), ou null
 * quand tout est traversable ou que le lot n'est pas concerné (pas root, pas de Chromium).
 */
export function preconditionTraversable(chemin, { uid = process.getuid?.(), exigerChromium = true, statut = (c) => fs.statSync(c) } = {}) {
  if (uid !== 0 || !exigerChromium) return null;
  for (let dossier = path.resolve(chemin); ; dossier = path.dirname(dossier)) {
    let mode;
    try { mode = statut(dossier).mode; } catch (e) { return `${dossier} : illisible (${e.code ?? e.message}), impossible de vérifier que les autres utilisateurs peuvent le traverser`; }
    if ((mode & 0o001) === 0) {
      return `${dossier} n'est pas traversable par les autres utilisateurs (o+x absent, mode ${(mode & 0o7777).toString(8)}) : sous root, les essais qui lancent Chromium sous un autre utilisateur échoueraient pour une autre raison que le mutant. `
        + 'Lancer le lot avec un TMPDIR dont tout le chemin est traversable (TMPDIR=/tmp) ou donner o+x à ce dossier.';
    }
    if (path.dirname(dossier) === dossier) return null;
  }
}

/**
 * La « chaîne d'origine » d'un mutant dont le motif ne désigne plus une ligne unique : elle ne
 * se retrouve dans aucun fichier, et le moteur refuse le lot en disant sa `raison` (qui nomme le
 * motif et le fichier), avec les autres motifs périmés du même lot.
 */
export class MotifRefuse {
  constructor(raison) { this.raison = raison; }
}

/**
 * Un mutant posé sur la ligne du fichier qui contient `motif` (et pas `sans`), si une seule la
 * contient : `de` y est remplacé par `par`. La ligne se lit dans `racine` (le dépôt du lot par
 * défaut) ; un mutant écrit ainsi suit le code qui change de place ou de forme, tant que la ligne
 * reste la seule à porter son motif. Sinon (aucune ligne, plusieurs, `de` absent de la ligne, fichier
 * absent) le mutant est refusé par le moteur avec la raison (`MotifRefuse`) : rien n'est levé ici.
 * @returns {[string, string | MotifRefuse, string, string]} `[fichier, chaîne d'origine, chaîne mutée, libellé]`
 */
export function dansLigne(fichier, motif, de, par, libelle, sans = null, racine = RACINE) {
  const refus = (raison) => [fichier, new MotifRefuse(`${fichier} : ${raison}`), '', libelle];
  let contenu;
  try { contenu = fs.readFileSync(path.join(racine, fichier), 'utf8'); } catch { return refus(`le fichier n'existe pas, « ${motif} » n'y est pas cherché`); }
  const trouvees = contenu.split('\n').filter((l) => l.includes(motif) && !(sans && l.includes(sans)));
  if (trouvees.length !== 1) return refus(`« ${motif} »${sans ? ` sans « ${sans} »` : ''} se trouve sur ${trouvees.length} lignes, il en faut une`);
  const [l] = trouvees;
  if (!l.includes(de)) return refus(`« ${de} » ne figure pas dans la ligne de « ${motif} »`);
  return [fichier, l, l.replace(de, () => par), libelle];
}

/**
 * @param {{
 *   mutants: Array<{ libelle: string, fichier: string, ancien: string, nouveau: string }>,
 *   groupes: Array<{ nom: string, fichiers: string[] }>,
 *   exigerChromium?: boolean,
 *   partie?: ?{ i: number, n: number },
 *   valider?: boolean,
 *   argv?: string[],
 *   dossiers?: string[],
 *   delaiMs?: number,
 *   racine?: string,
 *   sortie?: (ligne: string) => void,
 *   erreur?: (ligne: string) => void,
 *   rapporter?: ?((bilan: { retenus: number, tuesParUnTest: number, tuesParUnDelai: number, plantages: number, survivants: number, nonJuges: number, mutants: Array<{ libelle: string, issue: 'test' | 'delai' | 'plantage' | 'survit', detail: ?string, dureeMs: number }> }) => void),
 *   horloge?: () => number,
 * }} options `groupes` : suites lancées dans l'ordre, la première qui échoue tue le mutant.
 *   `delaiMs` : le délai d'une suite (10 minutes par défaut) ; un lot dont les mutants peuvent boucler sans fin (une file sans garde contre les cycles) le réduit à quelques fois la durée de sa suite, pour
 *   ne pas attendre dix minutes par mutant.
 *   `partie` : ne rejouer que le i-ième des n paquets (1 à n), pour lancer n processus à la fois ; chacun a sa copie, et
 *   vérifie quand même tous les mutants avant de commencer.
 *   `valider` : ne faire que la vérification d'avance et le dire (aucune suite lancée, Chromium non exigé, rien retiré chez les autres lots) ; `--valider` de `argv` par défaut.
 *   `argv` : la ligne de commande du lot (`process.argv.slice(2)` par défaut), où le moteur lit `--valider` et `--part` : une ligne qui demande `--part=i/n` sans que `partie` la transmette (ou en transmettant
 *   une autre) est refusée, code 2, avant tout : un lot qui la jetterait ferait rejouer à chaque paquet le lot entier, n fois le travail pour des comptes qui s'additionnent faux.
 *   `horloge` : les millisecondes, pour la durée de chaque mutant (`Date.now` par défaut) ; lue deux fois par mutant, au début et à la fin de son jugement.
 *   `uid` : l'utilisateur qui lance le lot (`process.getuid()` par défaut) ; sous root, un lot qui exige Chromium refuse un dossier temporaire que les autres utilisateurs ne peuvent pas traverser.
 *   `racine` : le projet à copier (le dépôt par défaut) ; `sortie` et `erreur` : où vont les lignes (la console par défaut) ;
 *   `rapporter` : reçoit le bilan chiffré à la fin (les essais du moteur lui-même le lisent).
 * @returns {number} le code de sortie : 0 tous tués (par un test ou un délai), 1 un mutant survit ou plante (un lot qui perd sa copie compte son mutant plantage et dit les suivants non jugés), 2 le lot n'a pas pu commencer
 */
export function rejouerMutants({
  mutants, groupes, exigerChromium = true, partie = null, valider, argv = process.argv.slice(2), dossiers = DOSSIERS_COPIES, delaiMs = DELAI_MS,
  racine = RACINE, sortie = console.log, erreur = console.error, rapporter = null, horloge = Date.now, uid = process.getuid?.(),
}) {
  // Avant tout, même pour la vérification seule : c'est elle que `tests/lots-de-mutants.test.mjs` lance sur chaque lot avec un `--part`.
  let demandee;
  try {
    demandee = lireArguments(argv).partie;
  } catch (e) {
    erreur(e.message);
    return 2;
  }
  if (demandee && (!partie || partie.i !== demandee.i || partie.n !== demandee.n)) {
    erreur(`La ligne de commande demande --part=${demandee.i}/${demandee.n}, mais le lot ne l'a pas transmise au moteur (\`partie\` ${partie ? `reçue : ${partie.i}/${partie.n}` : 'absente'}) : `
      + "chaque paquet rejouerait le lot entier et les comptes des paquets s'additionneraient faux. Le lot doit lire `const { partie } = lireArguments(process.argv.slice(2))` et passer `partie` à rejouerMutants.");
    return 2;
  }
  const verifierSeulement = valider ?? argv.includes('--valider');
  if (exigerChromium && !verifierSeulement && !process.env.GWAUDIT_CHROMIUM_PATH) {
    erreur('GWAUDIT_CHROMIUM_PATH est requis : le différentiel Chromium fait partie de la preuve, un test sauté ne tuerait rien.');
    return 2;
  }
  if (!mutants.length) {
    erreur('Aucun mutant retenu : rien à rejouer.');
    return 2;
  }

  if (!verifierSeulement) {
    let dossierTemporaire = os.tmpdir();
    try { dossierTemporaire = fs.realpathSync(dossierTemporaire); } catch { /* le dossier n'existe pas : la copie ne pourra pas s'y faire, et le dira */ }
    const refus = preconditionTraversable(dossierTemporaire, { uid, exigerChromium });
    if (refus) {
      erreur(refus);
      return 2;
    }
  }

  // Un lot tué avant celui-ci (kill, coupure) a pu laisser sa copie et des processus : ils partent d'abord (la vérification seule n'y touche pas : elle ne fait que lire). Le lot lui-même ne pose aucun gestionnaire de signal : tout son travail est synchrone, un gestionnaire ne s'exécuterait qu'à la fin et `kill` n'arrêterait plus rien.
  if (!verifierSeulement) {
    const abandonnees = balayerCopiesAbandonnees();
    if (abandonnees.length) erreur(`${abandonnees.length} copie(s) laissée(s) par un lot interrompu retirée(s), avec leurs processus : ${abandonnees.join(', ')}`);
  }

  // Le chemin réel : `/proc/<pid>/cwd` le rend ainsi, et `tuerProcessusDe` le compare tel quel (un TMPDIR qui passe par un lien symbolique ne fausse rien). Le pid du lot est dans le nom : c'est ce qui dit qu'une copie est abandonnée.
  const copie = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gwaudit-mutants-${process.pid}-`)));
  // mkdtemp crée un dossier 0700 : un test qui lance le code sous un autre utilisateur (bac à sable de Chromium sous root) doit pouvoir le lire. Ce n'est qu'une copie de sources publiques.
  fs.chmodSync(copie, 0o755);

  // Le dossier temporaire des suites est celui de la copie : un essai tué par le délai (ou par le plantage d'un autre) ne peut pas y nettoyer
  // ce qu'il a créé (`gwaudit-enfant-…`, `gwaudit-surface-…`), et le lot suivant ne le trouverait pas plus qu'il ne sait à qui il est. Il part avec la copie,
  // et se balaie avec elle : son nom porte le numéro du lot. À côté d'elle et non dedans : un essai qui liste la copie n'y voit que ce que `dossiers` demande.
  const temporaire = `${copie}-tmp`;
  // Le lanceur d'un essai n'est pas celui d'une suite qui s'exécute déjà sous `node --test` : la variable qui le dit fait croire à un sous-processus.
  const env = { ...process.env, TMPDIR: temporaire };
  delete env.NODE_TEST_CONTEXT;
  // Ouvert à tous comme /tmp : un essai qui tourne sous un autre utilisateur y écrit.
  const poserTemporaire = () => {
    fs.mkdirSync(temporaire);
    fs.chmodSync(temporaire, 0o1777);
  };
  const fichiersDeTest = groupes.flatMap((g) => g.fichiers);
  /**
   * Ce qui manque au lot après un essai, dit (ou null). Un essai qui retire la copie, un de ses fichiers de test ou son dossier temporaire
   * (un mutant qui balaie ce qu'il ne devrait pas) fait échouer tout ce qui passe après lui : ces échecs ne jugent pas le mutant, ils le
   * « tueraient » tous, le bon comme l'équivalent. Le dossier temporaire se repose (un essai en a besoin, et rien d'autre n'a changé) ;
   * la copie ou un fichier de test, non : le lot s'arrête là.
   */
  const perteDuLot = () => {
    if (!fs.existsSync(copie)) return { fatale: true, raison: "la copie du lot a disparu pendant l'essai" };
    const manque = fichiersDeTest.find((f) => !fs.existsSync(path.join(copie, f)));
    if (manque) return { fatale: true, raison: `${manque} a disparu de la copie pendant l'essai` };
    if (!fs.existsSync(temporaire)) {
      poserTemporaire();
      return { fatale: false, raison: "le dossier temporaire du lot a disparu pendant l'essai" };
    }
    return null;
  };
  let lotPerdu = null;
  const lancer = (fichiers) => {
    const r = spawnSync('node', ['--test', ...fichiers], { cwd: copie, encoding: 'utf8', env, timeout: delaiMs, maxBuffer: 1 << 26 });
    let bilan = classerLancement(r, fichiers);
    const perte = perteDuLot();
    if (perte) {
      if (perte.fatale) lotPerdu = perte.raison;
      bilan = { ...bilan, verdict: 'plantage', raison: `${perte.raison} : ce qui a échoué ne juge pas le mutant` };
    }
    // Un délai ou un plantage laisse des processus derrière lui ; un lancement qui a fini normalement, non.
    if (bilan.verdict === 'delai' || bilan.verdict === 'plantage') { tuerProcessusDe(copie); tuerProcessusDe(temporaire); }
    return bilan;
  };

  try {
    poserTemporaire();
    for (const dossier of dossiers) if (fs.existsSync(path.join(racine, dossier))) fs.cpSync(path.join(racine, dossier), path.join(copie, dossier), { recursive: true });
    if (fs.existsSync(path.join(racine, 'package.json'))) fs.copyFileSync(path.join(racine, 'package.json'), path.join(copie, 'package.json'));
    if (fs.existsSync(path.join(racine, 'node_modules'))) fs.symlinkSync(path.join(racine, 'node_modules'), path.join(copie, 'node_modules'));

    // Chaque chaîne d'origine, une seule fois, et un mutant qui compile : rien ne se lance avant que tout soit dit.
    const problemes = [];
    // Un fichier de test qui n'existe pas serait ignoré sans un mot par `node --test` (Node 22 le prend pour un motif qui ne trouve rien) : la suite serait plus petite que celle qu'on croit.
    for (const g of groupes) for (const f of g.fichiers) if (!fs.existsSync(path.join(copie, f))) problemes.push(`groupe « ${g.nom} » : le fichier de test ${f} n'existe pas (le lanceur l'ignorerait sans rien dire)`);
    for (const [numero, m] of mutants.entries()) {
      // Un motif qui ne désigne plus une ligne unique (`dansLigne`) : le mutant est refusé avec sa raison, il ne s'est pas posé.
      if (m.ancien instanceof MotifRefuse) { problemes.push(`mutant ${numero + 1} (${m.libelle}) : ${m.ancien.raison}`); continue; }
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

    if (verifierSeulement) {
      sortie(`Vérification d'avance : ${mutants.length} mutants (chaîne d'origine unique, code muté qui compile), ${groupes.flatMap((g) => g.fichiers).length} fichier(s) de test présent(s), aucun problème ; aucune suite lancée.`);
      return 0;
    }

    const base = lancer(groupes.flatMap((g) => g.fichiers));
    if (base.verdict !== 'passe' || base.saute !== 0) {
      const enEchec = [...base.tueurs, ...base.fichiersEnEchec].slice(0, 3).map((n) => (n.length > 100 ? `${n.slice(0, 97)}...` : n));
      erreur(`La suite ciblée n'est pas verte et complète sur le code non muté (verdict : ${base.verdict}${base.raison ? `, ${base.raison}` : ''}${enEchec.length ? `, en échec : ${enEchec.join(' | ')}` : ''}, sautés : ${base.saute}, lancés : ${base.lances}) : rien à conclure.`);
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

    const bilan = { retenus: retenus.length, tuesParUnTest: 0, tuesParUnDelai: 0, plantages: 0, survivants: 0, nonJuges: 0, mutants: [] };
    for (const m of retenus) {
      // Sans copie, plus rien ne se juge : ce qui reste est dit non jugé, jamais tué ni survivant.
      if (lotPerdu) { bilan.nonJuges += 1; continue; }
      const chemin = path.join(copie, m.fichier);
      const original = fs.readFileSync(chemin, 'utf8');
      fs.writeFileSync(chemin, original.replace(m.ancien, () => m.nouveau));
      let jugement;
      const debut = horloge();
      try {
        jugement = juger();
      } finally {
        if (!lotPerdu) fs.writeFileSync(chemin, original);
      }
      const dureeMs = horloge() - debut;
      if (jugement.issue === 'test') bilan.tuesParUnTest += 1;
      else if (jugement.issue === 'delai') bilan.tuesParUnDelai += 1;
      else if (jugement.issue === 'plantage') bilan.plantages += 1;
      else bilan.survivants += 1;
      bilan.mutants.push({ libelle: m.libelle, ...jugement, dureeMs });
      sortie(`${ETIQUETTE[jugement.issue]} ${m.libelle}${jugement.detail ? `  (${jugement.detail})` : ''}  [${Math.round(dureeMs / 100) / 10} s]`);
    }
    const tues = bilan.tuesParUnTest + bilan.tuesParUnDelai;
    sortie('');
    sortie(`${tues}/${bilan.retenus} mutants tués : ${bilan.tuesParUnTest} par un test, ${bilan.tuesParUnDelai} par un délai ; ${bilan.plantages} plantage${bilan.plantages > 1 ? 's' : ''} ; ${bilan.survivants} survivant${bilan.survivants > 1 ? 's' : ''}${bilan.nonJuges ? ` ; ${bilan.nonJuges} non jugé${bilan.nonJuges > 1 ? 's' : ''}` : ''}`);
    if (lotPerdu) erreur(`Le lot a perdu son terrain (${lotPerdu})${bilan.nonJuges ? ` : ${bilan.nonJuges} mutant(s) n'ont pas été rejoués` : ''}, le rejeu est à refaire.`);
    if (rapporter) rapporter(bilan);
    return bilan.survivants || bilan.plantages ? 1 : 0;   // un lot qui perd sa copie compte son mutant plantage : les non jugés n'ajoutent rien
  } finally {
    fs.rmSync(copie, { recursive: true, force: true });
    fs.rmSync(temporaire, { recursive: true, force: true });
    // Un essai qui a lui-même lancé un lot (le moteur muté qu'il éprouve, posant sa copie là où le nôtre ne la cherche pas) et l'a tué laisse une copie
    // de plus dans un dossier temporaire ; son lot est mort, elle se balaie comme les autres (les copies des lots qui tournent encore ne sont jamais touchées).
    if (!verifierSeulement) {
      const laissees = balayerCopiesAbandonnees();
      if (laissees.length) erreur(`${laissees.length} copie(s) laissée(s) par les essais retirée(s), avec leurs processus : ${laissees.join(', ')}`);
    }
  }
}

/** `--part=i/n` (1 ≤ i ≤ n) et `--valider` dans les arguments ; les autres arguments sont rendus tels quels et dans l'ordre (`--valider` n'en fait pas partie : il ne doit jamais devenir un filtre de libellés). */
export function lireArguments(argv) {
  let partie = null;
  let valider = false;
  const restants = [];
  for (const a of argv) {
    if (a === '--valider') { valider = true; continue; }
    const m = /^--part=(\d+)\/(\d+)$/.exec(a);
    if (!m) { restants.push(a); continue; }
    const [i, n] = [Number(m[1]), Number(m[2])];
    if (i < 1 || i > n) throw new Error(`--part=${i}/${n} : i doit être entre 1 et n`);
    partie = { i, n };
  }
  return { partie, valider, restants };
}
