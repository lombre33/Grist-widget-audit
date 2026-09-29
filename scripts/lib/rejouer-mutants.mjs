/**
 * Moteur commun des scripts de mutants (`mutants-passe-html.mjs`,
 * `mutants-css.mjs`).
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
 *  - un mutant n'est tué que par un test en échec ou par un délai dépassé
 *    (dit comme tel), jamais par un plantage silencieux.
 * Code 1 si un mutant survit, 0 sinon.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DELAI_MS = 10 * 60 * 1000;                                  // par défaut : la suite d'un lot de tests entiers ; un mutant qui boucle sans fin y est tué par ce délai (dit comme tel)
/** Ce que la copie contient par défaut ; un script dont les tests lancent `bin/gwaudit.js` ou lisent `docker/` ajoute ce qu'il lui faut via `dossiers`. */
export const DOSSIERS_COPIES = ['src', 'tests', 'fixtures', 'scripts'];

/**
 * @param {{
 *   mutants: Array<{ libelle: string, fichier: string, ancien: string, nouveau: string }>,
 *   groupes: Array<{ nom: string, fichiers: string[] }>,
 *   exigerChromium?: boolean,
 *   partie?: ?{ i: number, n: number },
 *   dossiers?: string[],
 *   delaiMs?: number,
 * }} options `groupes` : suites lancées dans l'ordre, la première qui échoue tue le mutant.
 *   `delaiMs` : le délai d'une suite (10 minutes par défaut) ; un lot dont les mutants peuvent boucler sans fin (une file sans garde contre les cycles) le réduit à quelques fois la durée de sa suite, pour que ces mutants soient tués vite plutôt qu'au bout de dix minutes.
 *   `partie` : ne rejouer que le i-ième des n paquets (1 à n), pour lancer n processus à la fois ; chacun a sa copie, et
 *   vérifie quand même tous les mutants avant de commencer.
 * @returns {number} le code de sortie
 */
export function rejouerMutants({ mutants, groupes, exigerChromium = true, partie = null, dossiers = DOSSIERS_COPIES, delaiMs = DELAI_MS }) {
  if (exigerChromium && !process.env.GWAUDIT_CHROMIUM_PATH) {
    console.error('GWAUDIT_CHROMIUM_PATH est requis : le différentiel Chromium fait partie de la preuve, un test sauté ne tuerait rien.');
    return 2;
  }
  if (!mutants.length) {
    console.error('Aucun mutant retenu : rien à rejouer.');
    return 2;
  }

  const copie = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-mutants-'));
  // mkdtemp crée un dossier 0700 : un test qui lance le code sous un autre utilisateur (bac à sable de Chromium sous root) doit pouvoir le lire. Ce n'est qu'une copie de sources publiques.
  fs.chmodSync(copie, 0o755);
  // Une interruption (Ctrl-C, kill) ne laisse pas la copie mutée derrière elle ; le signal n'est vu qu'entre deux lancements de suite.
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => { fs.rmSync(copie, { recursive: true, force: true }); process.exit(code); });
  }
  const lancer = (fichiers) => {
    const r = spawnSync('node', ['--test', ...fichiers], { cwd: copie, encoding: 'utf8', env: process.env, timeout: delaiMs, maxBuffer: 1 << 26 });
    // Le lanceur tué par le délai laisse derrière lui les processus qui exécutent les fichiers de test (et qui bouclent) : ils ne survivent pas à leur mutant.
    if (r.status === null) spawnSync('pkill', ['-KILL', '-f', copie]);
    const compte = (nom) => Number(new RegExp(`^# ${nom} (\\d+)`, 'm').exec(r.stdout ?? '')?.[1] ?? NaN);
    const tueurs = [...(r.stdout ?? '').matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter((nom, k, tous) => tous.indexOf(nom) === k);
    return { ok: r.status === 0, delai: r.status === null, saute: compte('skipped'), echecs: compte('fail'), lances: compte('tests'), tueurs };
  };

  try {
    for (const dossier of dossiers) if (fs.existsSync(path.join(RACINE, dossier))) fs.cpSync(path.join(RACINE, dossier), path.join(copie, dossier), { recursive: true });
    fs.copyFileSync(path.join(RACINE, 'package.json'), path.join(copie, 'package.json'));
    fs.symlinkSync(path.join(RACINE, 'node_modules'), path.join(copie, 'node_modules'));

    // Chaque chaîne d'origine, une seule fois, et un mutant qui compile : rien ne se lance avant que tout soit dit.
    const problemes = [];
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
      console.error(`${problemes.length} mutant(s) à corriger avant de rien conclure (le code a changé ou le mutant est mal écrit) :`);
      for (const p of problemes) console.error(` - ${p}`);
      return 2;
    }

    const base = lancer(groupes.flatMap((g) => g.fichiers));
    if (!base.ok || base.saute !== 0 || !(base.lances > 0)) {
      console.error(`La suite ciblée n'est pas verte et complète sur le code non muté (échec : ${!base.ok}, sautés : ${base.saute}, lancés : ${base.lances}) : rien à conclure.`);
      return 2;
    }
    console.log(`Suite non mutée : ${base.lances} tests, 0 sauté, ${mutants.length} mutants à rejouer.\n`);

    const retenus = partie ? mutants.filter((_, k) => k % partie.n === partie.i - 1) : mutants;
    if (partie) console.log(`Paquet ${partie.i}/${partie.n} : ${retenus.length} mutants sur ${mutants.length}.\n`);
    let survivants = 0;
    for (const m of retenus) {
      const chemin = path.join(copie, m.fichier);
      const original = fs.readFileSync(chemin, 'utf8');
      fs.writeFileSync(chemin, original.replace(m.ancien, () => m.nouveau));
      let tue = null;
      for (const g of groupes) {
        const r = lancer(g.fichiers);
        if (!r.ok) {
          const noms = r.tueurs.slice(0, 2).map((n) => (n.length > 70 ? `${n.slice(0, 67)}...` : n)).join(' | ');
          tue = r.delai ? `${g.nom}, délai dépassé` : `${g.nom}, ${Number.isNaN(r.echecs) ? '?' : r.echecs} en échec : ${noms}`;
          break;
        }
      }
      fs.writeFileSync(chemin, original);
      if (!tue) survivants += 1;
      console.log(`${tue ? 'TUÉ    ' : 'SURVIT '} ${m.libelle}${tue ? `  (${tue})` : ''}`);
    }
    console.log(`\n${retenus.length - survivants}/${retenus.length} mutants tués`);
    return survivants ? 1 : 0;
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
