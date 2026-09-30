#!/usr/bin/env node
/**
 * Rejoue les mutants du moteur de mutants lui-même (`scripts/lib/rejouer-mutants.mjs`) :
 * chaque décision du moteur (ce qui est un délai, un plantage, un test nommé ;
 * ce qui est tué, retiré, refusé avant le premier essai) est gardée par un test
 * des cinq fichiers `tests/rejouer-mutants-*.test.mjs`. Aucun navigateur n'est
 * requis.
 *
 * Deux mutants sont volontairement absents parce qu'ils ne changent rien
 * d'observable ici :
 *  - `!/^\d+$/.test(nom)` de `tuerProcessusDe` : sans lui, `Number('self')` vaut
 *    NaN et `process.kill` refuse, ce que le `try` attrape ;
 *  - le `catch` de `balayerCopiesAbandonnees` et `EPERM` dans `existe` : ils ne
 *    se produisent que pour la copie d'un autre utilisateur, et ces essais
 *    tournent sous un seul.
 * Un mutant qui ferait tuer tout ce que `/proc` montre (le `continue` du filtre
 * de répertoire retiré) n'est pas écrit non plus : il tuerait aussi ce lot.
 *
 * Le moteur ne nettoie pas les noms des tests en échec : `node --test` les
 * imprime tels quels, espaces de bord compris (Node 22.22.2 : `not ok 1 -   a  `),
 * et un nom ne sert qu'à l'affichage et à le distinguer d'un nom de fichier. Un
 * `.trim()` y avait été gardé ; son mutant survivait, et il n'était pas non plus
 * strictement équivalent (il fusionne deux noms qui ne diffèrent que par leurs
 * espaces). Plutôt que d'épingler un détail par un essai sans objet, le code et
 * son mutant ont été retirés.
 *
 * Usage : node scripts/mutants-rejouer.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants } from './lib/rejouer-mutants.mjs';

const E = 'scripts/lib/rejouer-mutants.mjs';
const TESTS = ['classement', 'processus', 'issues', 'preparation', 'valider'].map((n) => `tests/rejouer-mutants-${n}.test.mjs`);

// [chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- le délai par défaut
  ['export const DELAI_MS = 10 * 60 * 1000;', 'export const DELAI_MS = 10 * 60 * 100;', 'délai par défaut : une minute au lieu de dix'],

  // --- le résumé que node --test imprime
  ["`^# ${nom} (\\\\d+)`, 'm')", "`^# ${nom} (\\\\d+)`)", 'résumé : sans le drapeau m, seule la première ligne est lue'],
  ["`^# ${nom} (\\\\d+)`, 'm')", "`^# ${nom} (\\\\d)`, 'm')", 'résumé : un seul chiffre lu'],
  ['?.[1] ?? NaN)', '?.[1] ?? 0)', 'résumé : un compte absent se lit 0'],
  ["saute: compter(sortie, 'skipped')", "saute: compter(sortie, 'todo')", 'comptes : les tests sautés lus dans la mauvaise ligne'],
  ["echecs: compter(sortie, 'fail')", "echecs: compter(sortie, 'pass')", 'comptes : les échecs lus dans la mauvaise ligne'],
  ["lances: compter(sortie, 'tests')", "lances: compter(sortie, 'suites')", 'comptes : les tests lancés lus dans la mauvaise ligne'],

  // --- les noms des tests en échec
  ['/^\\s*not ok \\d+ - (.+)$/gm', '/^not ok \\d+ - (.+)$/gm', 'noms : les lignes indentées (sous-tests) ne sont pas lues'],
  ['/^\\s*not ok \\d+ - (.+)$/gm', '/^\\s*not ok \\d+ - (.+)$/g', 'noms : sans le drapeau m, seule la première ligne est lue'],
  ['.filter((nom, k, tous) => tous.indexOf(nom) === k)', '.filter(() => true)', 'noms : les doublons gardés'],
  ['(nom) => fichiers.some((f) => nom === f || nom.endsWith(`/${f}`))', '(nom) => fichiers.some((f) => nom === f)', 'fichier de test : seul le nom exact est reconnu'],
  ['(nom) => fichiers.some((f) => nom === f || nom.endsWith(`/${f}`))', '(nom) => fichiers.some((f) => nom === f || nom.endsWith(f))', 'fichier de test : la fin d\'un nom suffit, sans séparateur'],
  ['(nom) => fichiers.some((f) => nom === f || nom.endsWith(`/${f}`))', '(nom) => fichiers.some((f) => nom.endsWith(`/${f}`))', 'fichier de test : le nom exact n\'est plus reconnu'],
  ['tueurs: noms.filter((nom) => !estFichier(nom))', 'tueurs: noms', 'tueurs : les fichiers entiers comptés comme des tests'],
  ['fichiersEnEchec: noms.filter(estFichier)', 'fichiersEnEchec: []', 'fichiers en échec : jamais vus'],

  // --- le verdict d'un lancement
  ["if (r.error?.code === 'ETIMEDOUT') return { ...bilan, verdict: 'delai' };", "if (r.status === null) return { ...bilan, verdict: 'delai' };", 'délai : reconnu par status === null (jamais vrai sous node --test)'],
  ["if (r.error?.code === 'ETIMEDOUT') return { ...bilan, verdict: 'delai' };", "if (false) return { ...bilan, verdict: 'delai' };", 'délai : jamais reconnu'],
  ["if (r.error?.code === 'ETIMEDOUT') return { ...bilan, verdict: 'delai' };", "if (r.error) return { ...bilan, verdict: 'delai' };", 'délai : toute erreur de lancement est un délai'],
  ["return { ...bilan, verdict: 'delai' };", "return { ...bilan, verdict: 'plantage' };", 'délai : dit plantage'],
  ['if (r.error) return plantage(', 'if (false) return plantage(', 'erreur de lancement : ignorée'],
  ['${r.error.code ?? r.error.message}', '${r.error.message ?? r.error.code}', 'erreur de lancement : le message avant le code'],
  ["if (r.status === 0) return { ...bilan, verdict: 'passe' };", "if (false) return { ...bilan, verdict: 'passe' };", 'code 0 : plus une suite qui passe'],
  ['if (r.status !== 1) return plantage(', 'if (false) return plantage(', 'autre code que 0 et 1 : lu comme un échec de test'],
  ['r.signal ? `tué par ${r.signal}`', '!r.signal ? `tué par ${r.signal}`', 'plantage : le signal et le code intervertis'],
  ['if (Number.isNaN(bilan.echecs)) return plantage(', 'if (false) return plantage(', 'résumé absent : accepté'],
  ['if (!bilan.tueurs.length) {', 'if (false) {', 'aucun test nommé en échec : compté comme tué'],
  ['return plantage(bilan.fichiersEnEchec.length ?', 'return plantage(!bilan.fichiersEnEchec.length ?', 'raison d\'un plantage : les deux messages intervertis'],
  ["${bilan.fichiersEnEchec.join(', ')})", "${bilan.fichiersEnEchec.join('')})", 'raison d\'un plantage : les fichiers collés'],
  ["return { ...bilan, verdict: 'test' };", "return { ...bilan, verdict: 'passe' };", 'test en échec : dit passe'],

  // --- tuerProcessusDe : ce qu'il tue
  ["{ proc = '/proc' } = {}", "{ proc = '/procx' } = {}", 'proc : par défaut un dossier qui n\'existe pas (repli sur pkill)'],
  ["'-KILL', '-f', dossier.replace(", "'-TERM', '-f', dossier.replace(", 'repli pkill : SIGTERM au lieu de SIGKILL'],
  ["['-KILL', '-f', dossier.replace(", "['-KILL', dossier.replace(", 'repli pkill : sans -f (le nom du processus, pas sa ligne de commande)'],
  ['[.*+?^${}()|[', '[.*?^${}()|[', 'repli pkill : le + du dossier n\'est pas échappé'],
  ['${}()|[', '${}|[', 'repli pkill : les parenthèses du dossier ne sont pas échappées'],
  ["if (!/^\\d+$/.test(nom) || Number(nom) === process.pid) continue;", "if (!/^\\d+$/.test(nom)) continue;", 'tuerProcessusDe : ne se garde pas de se tuer lui-même'],
  ["path.join(proc, nom, 'cwd')", "path.join(proc, nom, 'exe')", 'répertoire courant : lit l\'exécutable à la place'],
  ['if (cwd !== dossier && !cwd.startsWith(dossier + path.sep)) continue;', 'if (cwd !== dossier && !cwd.startsWith(dossier)) continue;', 'répertoire courant : un dossier voisin au même début de nom est tué'],
  ['if (cwd !== dossier && !cwd.startsWith(dossier + path.sep)) continue;', 'if (!cwd.startsWith(dossier + path.sep)) continue;', 'répertoire courant : le dossier lui-même n\'est pas tué'],
  ['if (cwd !== dossier && !cwd.startsWith(dossier + path.sep)) continue;', 'if (cwd !== dossier || !cwd.startsWith(dossier + path.sep)) continue;', 'répertoire courant : rien n\'est jamais tué'],
  ["process.kill(Number(nom), 'SIGKILL'); tues += 1;", "process.kill(Number(nom), 'SIGTERM'); tues += 1;", 'tuerProcessusDe : SIGTERM au lieu de SIGKILL (un lanceur l\'intercepte)'],
  ["process.kill(Number(nom), 'SIGKILL'); tues += 1;", "process.kill(Number(nom), 'SIGKILL'); tues += 2;", 'tuerProcessusDe : chaque processus compté deux fois'],
  ["process.kill(Number(nom), 'SIGKILL'); tues += 1;", "process.kill(Number(nom), 'SIGKILL');", 'tuerProcessusDe : les processus tués ne sont pas comptés'],
  ['  }\n  return tues;\n}', '  }\n  return 0;\n}', 'tuerProcessusDe : le nombre de processus tués perdu'],

  // --- le balayage des copies abandonnées
  ["try { process.kill(pid, 0); return true; }", "try { process.kill(pid, 0); return false; }", 'existe : un lot vivant est dit mort'],
  ["catch (e) { return e.code !== 'ESRCH'; }", 'catch (e) { return true; }', 'existe : un lot mort est dit vivant'],
  ['tmp = os.tmpdir()) {', "tmp = '/tmp') {", 'balayage : /tmp au lieu du dossier temporaire du processus'],
  ['catch { return retirees; }', 'catch { /* rien */ }', 'balayage : un dossier illisible fait planter'],
  ['/^gwaudit-mutants-(\\d+)-/', '/gwaudit-mutants-(\\d+)-/', 'balayage : le préfixe est reconnu au milieu d\'un nom'],
  ['/^gwaudit-mutants-(\\d+)-/', '/^gwaudit-mutants-(\\d+)/', 'balayage : un numéro sans tiret derrière est reconnu'],
  ['if (!m || existe(Number(m[1]))) continue;', 'if (!m) continue;', 'balayage : la copie d\'un lot vivant est retirée'],
  ['existe(Number(m[1]))', 'existe(Number(m[0]))', 'balayage : le numéro lu dans le mauvais groupe'],
  ['path.join(fs.realpathSync(tmp), nom)', 'path.join(tmp, nom)', 'balayage : le chemin de la copie n\'est pas résolu'],
  ['tuerProcessusDe(dossier);', '', 'balayage : les processus de la copie restent'],
  ['fs.rmSync(dossier, { recursive: true, force: true });', '', 'balayage : la copie reste'],
  ['fs.rmSync(dossier, { recursive: true, force: true });', 'fs.rmSync(dossier, { force: true });', 'balayage : un dossier plein n\'est pas retiré (sans recursive)'],
  ['retirees.push(dossier);', '', 'balayage : la copie retirée n\'est pas dite'],

  // --- ce que rejouerMutants prend par défaut
  ['exigerChromium = true,', 'exigerChromium = false,', 'options : Chromium n\'est plus exigé par défaut'],
  ['partie = null,', 'partie = { i: 1, n: 1 },', 'options : un paquet 1/1 par défaut'],
  ['dossiers = DOSSIERS_COPIES,', "dossiers = ['src'],", 'options : seul src est copié par défaut'],
  ['delaiMs = DELAI_MS,', 'delaiMs = 1,', 'options : un délai d\'une milliseconde par défaut'],
  ['sortie = console.log,', 'sortie = console.error,', 'options : les lignes vont sur la sortie d\'erreur'],
  ['erreur = console.error,', 'erreur = console.log,', 'options : les erreurs vont sur la sortie standard'],

  // --- ce qu'il exige avant de commencer
  ['if (exigerChromium && !verifierSeulement && !process.env.GWAUDIT_CHROMIUM_PATH) {', 'if (false) {', 'Chromium : jamais exigé'],
  ['if (exigerChromium && !verifierSeulement && !process.env.GWAUDIT_CHROMIUM_PATH) {', 'if (exigerChromium && !verifierSeulement && process.env.GWAUDIT_CHROMIUM_PATH) {', 'Chromium : exigé quand il est présent, pas quand il manque'],
  ['if (exigerChromium && !verifierSeulement && !process.env.GWAUDIT_CHROMIUM_PATH) {', 'if (!verifierSeulement && !process.env.GWAUDIT_CHROMIUM_PATH) {', 'Chromium : exigé même quand le lot dit ne pas en avoir besoin'],
  ['if (exigerChromium && !verifierSeulement && !process.env.GWAUDIT_CHROMIUM_PATH) {', 'if (exigerChromium && !process.env.GWAUDIT_CHROMIUM_PATH) {', "Chromium : exigé aussi pour la vérification d'avance, qui ne lance rien"],
  ['if (exigerChromium && !verifierSeulement && !process.env.GWAUDIT_CHROMIUM_PATH) {', 'if (exigerChromium && verifierSeulement && !process.env.GWAUDIT_CHROMIUM_PATH) {', "Chromium : exigé seulement pour la vérification d'avance"],
  ["un test sauté ne tuerait rien.');\n    return 2;", "un test sauté ne tuerait rien.');\n    return 1;", 'Chromium manquant : code 1 au lieu de 2'],
  ['if (!mutants.length) {', 'if (false) {', 'aucun mutant : le lot se lance quand même'],
  ["erreur('Aucun mutant retenu : rien à rejouer.');\n    return 2;", "erreur('Aucun mutant retenu : rien à rejouer.');\n    return 1;", 'aucun mutant : code 1 au lieu de 2'],
  ['const abandonnees = balayerCopiesAbandonnees();', 'const abandonnees = [];', 'départ : les copies abandonnées ne sont pas retirées'],
  ['if (abandonnees.length) erreur(', 'if (false) erreur(', 'départ : les copies retirées ne sont pas dites'],

  // --- la copie
  ['fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gwaudit-mutants-${process.pid}-`)))', 'fs.mkdtempSync(path.join(os.tmpdir(), `gwaudit-mutants-${process.pid}-`))', 'copie : le chemin n\'est pas résolu (un TMPDIR par lien symbolique fausse la chasse aux orphelins)'],
  ['`gwaudit-mutants-${process.pid}-`', "'gwaudit-mutants-'", 'copie : sans le numéro du lot dans le nom'],
  ['path.join(os.tmpdir(), `gwaudit-mutants-', "path.join('/tmp', `gwaudit-mutants-", 'copie : dans /tmp au lieu du dossier temporaire du processus'],
  ['fs.chmodSync(copie, 0o755);', '', 'copie : dossier privé (0700), illisible sous un autre utilisateur'],
  ['fs.chmodSync(copie, 0o755);', 'fs.chmodSync(copie, 0o777);', 'copie : ouverte en écriture à tous'],
  ['delete env.NODE_TEST_CONTEXT;', '', 'lanceur : la variable de node --test est gardée (le lanceur se croit un sous-processus)'],
  ["{ cwd: copie, encoding: 'utf8', env, timeout: delaiMs, maxBuffer: 1 << 26 }", "{ cwd: copie, encoding: 'utf8', env, maxBuffer: 1 << 26 }", 'lanceur : le délai n\'est jamais appliqué'],
  ["{ cwd: copie, encoding: 'utf8', env, timeout: delaiMs, maxBuffer: 1 << 26 }", "{ encoding: 'utf8', env, timeout: delaiMs, maxBuffer: 1 << 26 }", 'lanceur : lancé hors de la copie'],
  ["{ cwd: copie, encoding: 'utf8', env, timeout: delaiMs, maxBuffer: 1 << 26 }", '{ cwd: copie, env, timeout: delaiMs, maxBuffer: 1 << 26 }', 'lanceur : sortie en octets'],
  ["if (bilan.verdict === 'delai' || bilan.verdict === 'plantage') tuerProcessusDe(copie);", "if (bilan.verdict === 'plantage') tuerProcessusDe(copie);", 'délai : les orphelins restent'],
  ["if (bilan.verdict === 'delai' || bilan.verdict === 'plantage') tuerProcessusDe(copie);", "if (bilan.verdict === 'delai') tuerProcessusDe(copie);", 'plantage : les orphelins restent'],
  ['if (fs.existsSync(path.join(racine, dossier))) fs.cpSync(', 'if (true) fs.cpSync(', 'copie : un dossier absent fait planter'],
  ["if (fs.existsSync(path.join(racine, 'package.json'))) fs.copyFileSync(path.join(racine, 'package.json'), path.join(copie, 'package.json'));", '', 'copie : package.json non copié'],
  ["fs.symlinkSync(path.join(racine, 'node_modules'), path.join(copie, 'node_modules'));", "fs.cpSync(path.join(racine, 'node_modules'), path.join(copie, 'node_modules'), { recursive: true });", 'copie : node_modules copié au lieu d\'être lié'],

  // --- ce qu'il vérifie sur les mutants avant tout essai
  ['for (const g of groupes) for (const f of g.fichiers) if (!fs.existsSync(path.join(copie, f))) problemes.push(', 'for (const g of groupes) for (const f of g.fichiers) if (false) problemes.push(', 'fichier de test absent : accepté'],
  ['if (!fs.existsSync(chemin)) { problemes.push(', 'if (false) { problemes.push(', 'fichier à muter absent : accepté'],
  ['const occurrences = original.split(m.ancien).length - 1;', 'const occurrences = original.split(m.ancien).length - 0;', 'occurrences : une de trop comptée'],
  ['if (occurrences !== 1) {', 'if (occurrences > 1) {', 'occurrences : zéro accepté'],
  ['if (occurrences !== 1) {', 'if (occurrences < 1) {', 'occurrences : plusieurs acceptées'],
  ['if (m.nouveau === m.ancien) {', 'if (false) {', 'mutant identique à l\'original : accepté'],
  ['fs.writeFileSync(chemin, original.replace(m.ancien, () => m.nouveau));\n      // Un script shell', 'fs.writeFileSync(chemin, original.replace(m.ancien, m.nouveau));\n      // Un script shell', 'vérification : les motifs $& et $\' de la chaîne mutée sont interprétés'],
  ['fs.writeFileSync(chemin, original.replace(m.ancien, () => m.nouveau));\n      let jugement;', 'fs.writeFileSync(chemin, original.replace(m.ancien, m.nouveau));\n      let jugement;', 'pose du mutant : les motifs $& et $\' de la chaîne mutée sont interprétés'],
  ["chemin.endsWith('.sh')", "chemin.endsWith('.shx')", 'syntaxe : un script shell n\'est pas vérifié'],
  ["['-n', chemin]", "['--version']", 'syntaxe : bash sans -n'],
  ['/\\.[cm]?js$/.test(chemin)', '/\\.js$/.test(chemin)', 'syntaxe : seuls les .js sont vérifiés (ni .mjs ni .cjs)'],
  ['/\\.[cm]?js$/.test(chemin)', '/\\.[cm]js$/.test(chemin)', 'syntaxe : les .js ne sont pas vérifiés'],
  ['/\\.[cm]?js$/.test(chemin)', '/\\.[m]?js$/.test(chemin)', 'syntaxe : les .cjs ne sont pas vérifiés'],
  ["['--check', chemin]", "['--version']", 'syntaxe : node sans --check'],
  [': { status: 0 };', ': { status: 1 };', 'syntaxe : tout autre type de fichier est refusé'],
  ['      fs.writeFileSync(chemin, original);\n      if (syntaxe.status !== 0)', '      if (syntaxe.status !== 0)', 'vérification : le fichier n\'est pas remis dans son état après l\'analyse'],
  ['if (syntaxe.status !== 0) problemes.push(', 'if (false) problemes.push(', 'syntaxe : un mutant qui ne compile pas est accepté'],
  ['if (problemes.length) {', 'if (false) {', 'problèmes : le lot continue malgré eux'],
  ['for (const p of problemes) erreur(` - ${p}`);\n      return 2;', 'for (const p of problemes) erreur(` - ${p}`);\n      return 1;', 'problèmes : code 1 au lieu de 2'],

  // --- la suite non mutée
  ['const base = lancer(groupes.flatMap((g) => g.fichiers));', 'const base = lancer(groupes[0].fichiers);', 'suite non mutée : seul le premier groupe est jugé'],
  ["if (base.verdict !== 'passe' || base.saute !== 0 || !(base.lances > 0)) {", 'if (base.saute !== 0 || !(base.lances > 0)) {', 'suite non mutée : une suite rouge est acceptée'],
  ["if (base.verdict !== 'passe' || base.saute !== 0 || !(base.lances > 0)) {", "if (base.verdict !== 'passe' || !(base.lances > 0)) {", 'suite non mutée : un test sauté est accepté'],
  ["if (base.verdict !== 'passe' || base.saute !== 0 || !(base.lances > 0)) {", "if (base.verdict !== 'passe' || base.saute !== 0) {", 'suite non mutée : une suite qui ne lance aucun test est acceptée'],
  ["${base.raison ? `, ${base.raison}` : ''}", "${base.raison ? '' : `, ${base.raison}`}", 'suite non mutée : la raison du plantage n\'est pas dite'],
  ['rien à conclure.`);\n      return 2;', 'rien à conclure.`);\n      return 1;', 'suite non mutée refusée : code 1 au lieu de 2'],

  // --- les paquets
  ['k % partie.n === partie.i - 1', 'k % partie.n === partie.i', 'paquet : décalé d\'un mutant'],
  ['if (partie) sortie(`Paquet', 'if (false) sortie(`Paquet', 'paquet : la ligne qui le dit manque'],
  ['${retenus.length} mutants sur ${mutants.length}', '${mutants.length} mutants sur ${retenus.length}', 'paquet : les deux nombres intervertis'],

  // --- le jugement d'un mutant
  ["if (r.verdict === 'passe') continue;", "if (r.verdict === 'passe') {}", 'un groupe qui passe est compté comme un plantage'],
  ['r.tueurs.slice(0, 2)', 'r.tueurs.slice(0, 3)', 'détail : trois noms de tests au lieu de deux'],
  ['r.tueurs.slice(0, 2)', 'r.tueurs.slice(0, 1)', 'détail : un seul nom de test'],
  ['n.length > 70 ?', 'n.length > 69 ?', 'détail : un nom de 70 caractères est coupé'],
  ['n.length > 70 ?', 'n.length > 71 ?', 'détail : un nom de 71 caractères n\'est pas coupé'],
  ['`${n.slice(0, 67)}...`', '`${n.slice(0, 66)}...`', 'détail : un nom coupé perd un caractère de plus'],
  ["join(' | ')", "join(' ')", 'détail : les noms sans séparateur'],
  ["const fichiers = r.fichiersEnEchec.length ? ` ; ${r.fichiersEnEchec.length > 1 ? 'les fichiers' : 'le fichier'} ${r.fichiersEnEchec.join(', ')} ${r.fichiersEnEchec.length > 1 ? 'échouent' : 'échoue'} aussi` : '';", "const fichiers = '';", 'détail : le fichier entier qui échoue aussi n\'est pas dit'],
  ["r.fichiersEnEchec.length > 1 ? 'les fichiers' : 'le fichier'", "r.fichiersEnEchec.length > 0 ? 'les fichiers' : 'le fichier'", 'détail : « les fichiers » dès le premier'],
  ["r.fichiersEnEchec.length > 1 ? 'échouent' : 'échoue'", "r.fichiersEnEchec.length > 2 ? 'échouent' : 'échoue'", 'détail : « échouent » dès trois fichiers seulement'],
  ["r.fichiersEnEchec.join(', ')} ${", "r.fichiersEnEchec.join('')} ${", 'détail : les fichiers collés'],
  ['Math.round(delaiMs / 100) / 10', 'Math.round(delaiMs / 1000)', 'délai dit : arrondi à la seconde'],
  ['Math.round(delaiMs / 100) / 10', 'Math.round(delaiMs / 10) / 10', 'délai dit : dix fois trop long'],
  ['plantage ??= `${g.nom}, ${r.raison}`;', 'plantage = `${g.nom}, ${r.raison}`;', 'plantage : le dernier groupe prend la parole, pas le premier'],
  ["return plantage ? { issue: 'plantage', detail: plantage } : { issue: 'survit', detail: null };", "return { issue: 'survit', detail: null };", 'plantage : jamais dit, un survivant à la place'],

  // --- ce qui s'affiche et se compte
  ["test: 'TUÉ      '", "test: 'TUE      '", 'étiquette : sans l\'accent'],
  ["delai: 'TUÉ délai'", "delai: 'TUÉ  délai'", 'étiquette : décalée'],
  ["plantage: 'PLANTAGE '", "plantage: 'PLANTAGE'", 'étiquette : sans la colonne'],
  ["survit: 'SURVIT   '", "survit: 'SURVIT'", 'étiquette : sans la colonne (survivant)'],
  ["if (jugement.issue === 'test') bilan.tuesParUnTest += 1;", "if (jugement.issue === 'test') bilan.tuesParUnTest += 2;", 'compte : un mutant tué par un test compté deux fois'],
  ["else if (jugement.issue === 'delai') bilan.tuesParUnDelai += 1;", "else if (jugement.issue === 'delai') bilan.tuesParUnTest += 1;", 'compte : un délai compté comme un test'],
  ['bilan.plantages += 1;', 'bilan.survivants += 1;', 'compte : un plantage compté comme un survivant'],
  ['else bilan.survivants += 1;', 'else bilan.plantages += 1;', 'compte : un survivant compté comme un plantage'],
  ['bilan.mutants.push({ libelle: m.libelle, ...jugement });', 'bilan.mutants.push({ libelle: m.libelle });', 'bilan : l\'issue de chaque mutant perdue'],
  ['const tues = bilan.tuesParUnTest + bilan.tuesParUnDelai;', 'const tues = bilan.tuesParUnTest;', 'bilan : les tués par un délai ne sont pas comptés tués'],
  ["sortie('');", '', 'bilan : la ligne vide avant le résumé manque'],
  ["${bilan.plantages > 1 ? 's' : ''}", "${bilan.plantages > 0 ? 's' : ''}", 'pluriel : « plantages » dès un'],
  ["${bilan.plantages > 1 ? 's' : ''}", "${bilan.plantages > 2 ? 's' : ''}", 'pluriel : « plantages » dès trois'],
  ["${bilan.survivants > 1 ? 's' : ''}", "${bilan.survivants > 0 ? 's' : ''}", 'pluriel : « survivants » dès un'],
  ["${bilan.survivants > 1 ? 's' : ''}", "${bilan.survivants > 2 ? 's' : ''}", 'pluriel : « survivants » dès trois'],
  ['if (rapporter) rapporter(bilan);', 'rapporter(bilan);', 'rapporter : sans lui, le lot plante'],
  ['return bilan.survivants || bilan.plantages ? 1 : 0;', 'return bilan.survivants ? 1 : 0;', 'code de sortie : un plantage seul ne fait pas échouer le lot'],
  ['return bilan.survivants || bilan.plantages ? 1 : 0;', 'return bilan.plantages ? 1 : 0;', 'code de sortie : un survivant seul ne fait pas échouer le lot'],
  ['return bilan.survivants || bilan.plantages ? 1 : 0;', 'return bilan.survivants || bilan.plantages ? 0 : 1;', 'code de sortie : inversé'],
  ['    fs.rmSync(copie, { recursive: true, force: true });\n  }\n}', '  }\n}', 'fin : la copie n\'est pas retirée'],

  // --- les arguments
  ['if (i < 1 || i > n) throw', 'if (i < 0 || i > n) throw', 'arguments : --part=0/n accepté'],
  ['if (i < 1 || i > n) throw', 'if (i < 1 || i >= n) throw', 'arguments : --part=n/n refusé'],
  ['/^--part=(\\d+)\\/(\\d+)$/', '/--part=(\\d+)\\/(\\d+)$/', 'arguments : --part reconnu au milieu d\'un argument'],
  ['/^--part=(\\d+)\\/(\\d+)$/', '/^--part=(\\d+)\\/(\\d+)/', 'arguments : du texte après --part=i/n accepté'],
  ['/^--part=(\\d+)\\/(\\d+)$/', '/^--part=(\\d)\\/(\\d+)$/', 'arguments : i d\'un seul chiffre'],
  ['/^--part=(\\d+)\\/(\\d+)$/', '/^--part=(\\d+)\\/(\\d)$/', 'arguments : n d\'un seul chiffre'],
  ['if (!m) { restants.push(a); continue; }', 'if (!m) { continue; }', 'arguments : les autres arguments perdus'],
  ['partie = { i, n };', 'partie = { i: n, n: i };', 'arguments : i et n intervertis'],

  // --- la vérification d'avance (--valider)
  ["const verifierSeulement = valider ?? argv.includes('--valider');", "const verifierSeulement = argv.includes('--valider');", "valider : l'option explicite est ignorée"],
  ["const verifierSeulement = valider ?? argv.includes('--valider');", "const verifierSeulement = valider || argv.includes('--valider');", "valider : la ligne de commande l'emporte sur l'option explicite"],
  ["const verifierSeulement = valider ?? argv.includes('--valider');", 'const verifierSeulement = valider ?? false;', 'valider : la ligne de commande est ignorée'],
  ["const verifierSeulement = valider ?? argv.includes('--valider');", "const verifierSeulement = valider ?? argv.includes('--valid');", 'valider : --valid pris pour --valider'],
  ['argv = process.argv.slice(2),', 'argv = [],', "valider : la ligne de commande du processus n'est pas lue par défaut"],
  ['argv = process.argv.slice(2),', 'argv = process.argv.slice(3),', 'valider : le premier argument de la ligne de commande est sauté'],
  ['  if (!verifierSeulement) {', '  if (true) {', "valider : les copies des autres lots sont retirées aussi"],
  ['  if (!verifierSeulement) {', '  if (verifierSeulement) {', "valider : seule la vérification retire les copies des autres lots"],
  ['    if (verifierSeulement) {', '    if (false) {', "valider : la suite est lancée quand même"],
  ['aucune suite lancée.`);\n      return 0;', 'aucune suite lancée.`);\n      return 1;', "valider : code 1 quand tout est en ordre"],
  ['aucune suite lancée.`);\n      return 0;', 'aucune suite lancée.`);', "valider : la suite est lancée après le message"],
  ['${mutants.length} mutants (chaîne', '${mutants.length + 1} mutants (chaîne', "valider : le compte des mutants est faux"],
  ['${groupes.flatMap((g) => g.fichiers).length} fichier(s)', '${groupes.length} fichier(s)', "valider : le compte des fichiers de test est celui des groupes"],

  // --- un motif périmé est refusé avec sa raison
  ['if (m.ancien instanceof MotifRefuse) {', 'if (false) {', "motif refusé : traité comme une chaîne d'origine ordinaire (le lot lève au lieu de le dire)"],
  [': ${m.ancien.raison}`); continue; }', ': ${m.libelle}`); continue; }', "motif refusé : la raison n'est pas dite"],
  [': ${m.ancien.raison}`); continue; }', ': ${m.ancien.raison}`); }', 'motif refusé : le mutant refusé est examiné comme les autres'],
  ["l.includes(motif) && !(sans && l.includes(sans))", "l.includes(motif)", 'dansLigne : `sans` est ignoré'],
  ["l.includes(motif) && !(sans && l.includes(sans))", "l.includes(motif) && !(sans && !l.includes(sans))", 'dansLigne : `sans` écarte les lignes qui ne le portent pas'],
  ['if (trouvees.length !== 1) return', 'if (trouvees.length === 0) return', 'dansLigne : plusieurs lignes acceptées, la première est prise'],
  ['if (trouvees.length !== 1) return', 'if (trouvees.length > 1) return', 'dansLigne : aucune ligne acceptée, le mutant lève plus loin'],
  ['if (!l.includes(de)) return refus(', 'if (false) return refus(', 'dansLigne : un `de` absent de la ligne donne un mutant qui ne change rien'],
  ['return [fichier, l, l.replace(de, () => par), libelle];', 'return [fichier, l, l.replace(de, par), libelle];', 'dansLigne : la chaîne mutée passe par les motifs de remplacement (« $& »)'],
  ["catch { return refus(`le fichier n'existe pas, « ${motif} » n'y est pas cherché`); }", "catch { throw new Error('absent'); }", "dansLigne : un fichier absent lève au lieu d'être refusé"],
  ["new MotifRefuse(`${fichier} : ${raison}`), '', libelle]", 'new MotifRefuse(raison), \'\', libelle]', 'dansLigne : la raison ne nomme pas le fichier'],
  ["new MotifRefuse(`${fichier} : ${raison}`), '', libelle]", "new MotifRefuse(`${fichier} : ${raison}`), 'x', libelle]", 'dansLigne : un refus porte une chaîne mutée'],
  ["new MotifRefuse(`${fichier} : ${raison}`), '', libelle]", "`${fichier} : ${raison}`, '', libelle]", "dansLigne : un refus est une chaîne ordinaire, le moteur ne le reconnaît plus"],
  ['ne figure pas dans la ligne de « ${motif} »', 'ne figure pas dans la ligne de « ${de} »', 'dansLigne : la raison nomme la mauvaise chaîne quand `de` manque'],

  // --- les arguments : --valider
  ["if (a === '--valider') { valider = true; continue; }", "if (a === '--valider') { valider = true; }", '--valider : gardé parmi les filtres de libellés'],
  ["if (a === '--valider') { valider = true; continue; }", "if (a === '--valider') { valider = false; continue; }", '--valider : jamais lu'],
  ["if (a === '--valider') { valider = true; continue; }", "if (a.startsWith('--valid')) { valider = true; continue; }", '--valider : --valid… pris pour --valider'],
  ['return { partie, valider, restants };', 'return { partie, restants };', '--valider : non rendu par lireArguments'],

  // --- kill : rien ne retient le lot
  ['export const RACINE = path.resolve(', "process.on('SIGTERM', () => {});\nexport const RACINE = path.resolve(", 'un gestionnaire de SIGTERM qui ne fait rien : kill n\'arrête plus le lot'],
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , libelle]) => !filtre || filtre.test(libelle))
  .map(([ancien, nouveau, libelle]) => ({ libelle, fichier: E, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'essais du moteur', fichiers: TESTS }],
  exigerChromium: false,
  partie,
  // Un mutant qui retire le délai d'un essai laisse deux boucles de 20 s finir seules : quelques minutes suffisent, et un délai ici se dit à part.
  delaiMs: 240000,
});
