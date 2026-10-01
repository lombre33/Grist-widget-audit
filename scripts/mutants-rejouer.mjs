#!/usr/bin/env node
/**
 * Rejoue les mutants du moteur de mutants lui-même (`scripts/lib/rejouer-mutants.mjs`) :
 * chaque décision du moteur (ce qui est un délai, un plantage, un test nommé ;
 * ce qui est tué, retiré, refusé avant le premier essai) est gardée par un test
 * des six fichiers `tests/rejouer-mutants-*.test.mjs`. Aucun navigateur n'est
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
 * Deux choix n'ont pas de mutant parce qu'aucun n'y serait observable :
 *  - l'indentation des lignes `ok N - nom` lues pour savoir si un vrai test a tourné (`\s*`) : Node imprime toujours au premier
 *    niveau la ligne du test ou de la suite qui les porte, un mutant qui la retirerait ne change rien à ce qu'il imprime ;
 *  - le code de sortie ne compte pas les non jugés : un lot qui perd sa copie compte son mutant plantage, ce qui suffit à le faire échouer.
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
const TESTS = ['classement', 'processus', 'issues', 'preparation', 'valider', 'disparition'].map((n) => `tests/rejouer-mutants-${n}.test.mjs`);

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
  ["if (r.status === 0) {", "if (false) {", 'code 0 : plus une suite qui passe'],
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
  ['tmp = racinesTemporaires()) {', "tmp = ['/tmp']) {", 'balayage : /tmp seul, jamais le dossier temporaire du processus'],
  ['tmp = racinesTemporaires()) {', 'tmp = [os.tmpdir()]) {', 'balayage : le dossier temporaire du processus seul, jamais /tmp'],
  ['for (const racine of Array.isArray(tmp) ? tmp : [tmp]) {', 'for (const racine of [tmp]) {', 'balayage : plusieurs dossiers à la fois refusés (un tableau pris pour un chemin)'],
  ['for (const racine of Array.isArray(tmp) ? tmp : [tmp]) {', 'for (const racine of Array.isArray(tmp) ? tmp.slice(0, 1) : [tmp]) {', 'balayage : seul le premier dossier est balayé'],
  ['try { noms = fs.readdirSync(racine); } catch { continue; }', 'try { noms = fs.readdirSync(racine); } catch { return retirees; }', 'balayage : un dossier illisible arrête le balayage des suivants'],
  ['try { noms = fs.readdirSync(racine); } catch { continue; }', 'noms = fs.readdirSync(racine);', 'balayage : un dossier illisible fait planter'],
  ['/^gwaudit-mutants-(\\d+)-/', '/gwaudit-mutants-(\\d+)-/', 'balayage : le préfixe est reconnu au milieu d\'un nom'],
  ['/^gwaudit-mutants-(\\d+)-/', '/^gwaudit-mutants-(\\d+)/', 'balayage : un numéro sans tiret derrière est reconnu'],
  ['if (!m || existe(Number(m[1]))) continue;', 'if (!m) continue;', 'balayage : la copie d\'un lot vivant est retirée'],
  ['existe(Number(m[1]))', 'existe(Number(m[0]))', 'balayage : le numéro lu dans le mauvais groupe'],
  ['path.join(fs.realpathSync(racine), nom)', 'path.join(racine, nom)', 'balayage : le chemin de la copie n\'est pas résolu'],
  ['tuerProcessusDe(dossier);', '', 'balayage : les processus de la copie restent'],
  ['fs.rmSync(dossier, { recursive: true, force: true });', '', 'balayage : la copie reste'],
  ['const laissees = balayerCopiesAbandonnees();', 'const laissees = [];', 'fin de lot : la copie qu\'une suite a laissée derrière elle n\'est pas balayée'],
  ['if (laissees.length) erreur(`${laissees.length} copie(s) laissée(s) par les essais', 'if (false) erreur(`${laissees.length} copie(s) laissée(s) par les essais', 'fin de lot : la copie retirée n\'est pas dite'],
  ['    if (!verifierSeulement) {\n      const laissees = balayerCopiesAbandonnees();', '    {\n      const laissees = balayerCopiesAbandonnees();', 'fin de lot : la vérification seule balaie aussi'],
  ['fs.rmSync(dossier, { recursive: true, force: true });', 'fs.rmSync(dossier, { force: true });', 'balayage : un dossier plein n\'est pas retiré (sans recursive)'],
  ['retirees.push(dossier);', '', 'balayage : la copie retirée n\'est pas dite'],

  // --- ce que rejouerMutants prend par défaut
  ['groupes, exigerChromium = true,', 'groupes, exigerChromium = false,', 'options : Chromium n\'est plus exigé par défaut'],
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
  ["if (bilan.verdict === 'delai' || bilan.verdict === 'plantage') { tuerProcessusDe(copie); tuerProcessusDe(temporaire); }", "if (bilan.verdict === 'plantage') { tuerProcessusDe(copie); tuerProcessusDe(temporaire); }", 'délai : les orphelins restent'],
  ["if (bilan.verdict === 'delai' || bilan.verdict === 'plantage') { tuerProcessusDe(copie); tuerProcessusDe(temporaire); }", "if (bilan.verdict === 'delai') { tuerProcessusDe(copie); tuerProcessusDe(temporaire); }", 'plantage : les orphelins restent'],
  ["{ tuerProcessusDe(copie); tuerProcessusDe(temporaire); }", "{ tuerProcessusDe(copie); }", 'délai ou plantage : les orphelins du dossier temporaire des suites restent'],
  ["{ tuerProcessusDe(copie); tuerProcessusDe(temporaire); }", "{ tuerProcessusDe(temporaire); }", 'délai ou plantage : les orphelins de la copie restent (seuls ceux du dossier temporaire sont tués)'],
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
  ["if (base.verdict !== 'passe' || base.saute !== 0) {", 'if (base.saute !== 0) {', 'suite non mutée : une suite rouge est acceptée'],
  ["if (base.verdict !== 'passe' || base.saute !== 0) {", "if (base.verdict !== 'passe') {", 'suite non mutée : un test sauté est accepté'],
  ["${base.raison ? `, ${base.raison}` : ''}", "${base.raison ? '' : `, ${base.raison}`}", 'suite non mutée : la raison du plantage n\'est pas dite'],
  ['rien à conclure.`);\n      return 2;', 'rien à conclure.`);\n      return 1;', 'suite non mutée refusée : code 1 au lieu de 2'],

  ["${enEchec.length ? `, en échec : ${enEchec.join(' | ')}` : ''}", "", 'suite non mutée refusée : les tests en échec ne sont pas nommés'],
  ["[...base.tueurs, ...base.fichiersEnEchec].slice(0, 3)", "[...base.tueurs].slice(0, 3)", 'suite non mutée refusée : les fichiers de test en échec ne sont pas nommés'],
  ["[...base.tueurs, ...base.fichiersEnEchec].slice(0, 3)", "[...base.tueurs, ...base.fichiersEnEchec].slice(0, 1)", 'suite non mutée refusée : un seul test en échec nommé'],
  ["(n.length > 100 ? `${n.slice(0, 97)}...` : n)", "n", 'suite non mutée refusée : un nom très long n\'est pas coupé'],

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
  [": n)).join(' | ')", ": n)).join(' ')", 'détail : les noms sans séparateur'],
  ["${enEchec.join(' | ')}", "${enEchec.join(' ')}", 'suite non mutée refusée : les tests en échec sans séparateur'],
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
  ['bilan.mutants.push({ libelle: m.libelle, ...jugement, dureeMs });', 'bilan.mutants.push({ libelle: m.libelle, dureeMs });', 'bilan : l\'issue de chaque mutant perdue'],
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
  ['    fs.rmSync(copie, { recursive: true, force: true });\n    fs.rmSync(temporaire, { recursive: true, force: true });\n    // Un essai', '    fs.rmSync(temporaire, { recursive: true, force: true });\n    // Un essai', 'fin : la copie n\'est pas retirée'],
  ['    fs.rmSync(copie, { recursive: true, force: true });\n    fs.rmSync(temporaire, { recursive: true, force: true });\n    // Un essai', '    fs.rmSync(copie, { recursive: true, force: true });\n    // Un essai', 'fin : le dossier temporaire des suites n\'est pas retiré'],

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
  ['  if (!verifierSeulement) {\n    const abandonnees', '  if (true) {\n    const abandonnees', "valider : les copies des autres lots sont retirées aussi"],
  ['  if (!verifierSeulement) {\n    const abandonnees', '  if (verifierSeulement) {\n    const abandonnees', "valider : seule la vérification retire les copies des autres lots"],
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

  // --- --part : un lot qui ne la transmet pas est refusé
  ["if (demandee && (!partie || partie.i !== demandee.i || partie.n !== demandee.n)) {", 'if (false) {', '--part : un lot qui ne la transmet pas n\'est pas refusé'],
  ["if (demandee && (!partie || partie.i !== demandee.i || partie.n !== demandee.n)) {", 'if (demandee && (partie.i !== demandee.i || partie.n !== demandee.n)) {', '--part : une `partie` absente n\'est pas vue (le moteur plante au lieu de refuser)'],
  ["if (demandee && (!partie || partie.i !== demandee.i || partie.n !== demandee.n)) {", 'if (demandee && (!partie || partie.n !== demandee.n)) {', '--part : un autre paquet du même partage passe'],
  ["if (demandee && (!partie || partie.i !== demandee.i || partie.n !== demandee.n)) {", 'if (demandee && (!partie || partie.i !== demandee.i)) {', '--part : un autre nombre de paquets passe'],
  ["if (demandee && (!partie || partie.i !== demandee.i || partie.n !== demandee.n)) {", 'if (demandee && !partie) {', '--part : seule une `partie` absente est refusée'],
  ["if (demandee && (!partie || partie.i !== demandee.i || partie.n !== demandee.n)) {", 'if (!partie || partie.i !== demandee?.i || partie.n !== demandee?.n) {', '--part : refusé aussi quand la ligne n\'en demande aucune'],
  ["demandee = lireArguments(argv).partie;", "demandee = null;", '--part : la ligne de commande n\'est pas lue'],
  ["erreur(e.message);\n    return 2;", "erreur(e.message);\n    return 1;", '--part : une partie hors de 1..n donne le code 1 au lieu de 2'],
  ["erreur(e.message);\n    return 2;", "return 2;", '--part : une partie hors de 1..n est refusée sans le dire'],
  ["erreur(e.message);\n    return 2;", "erreur(e.message);", '--part : une partie hors de 1..n ne refuse rien'],
  ["`La ligne de commande demande --part=${demandee.i}/${demandee.n}, mais", "`La ligne de commande demande --part=${demandee.n}/${demandee.i}, mais", '--part : le refus nomme les deux nombres intervertis'],
  ["${partie ? `reçue : ${partie.i}/${partie.n}` : 'absente'}", "${partie ? 'absente' : `reçue : ${partie?.i}/${partie?.n}`}", '--part : le refus dit « absente » d\'une partie reçue et inversement'],
  ["chaque paquet rejouerait le lot entier et les comptes des paquets s'additionneraient faux. Le lot doit lire", "Le lot doit lire", '--part : le refus ne dit pas pourquoi'],
  ["s'additionneraient faux. Le lot doit lire `const { partie } = lireArguments(process.argv.slice(2))` et passer `partie` à rejouerMutants.\");\n    return 2;", "s'additionneraient faux. Le lot doit lire `const { partie } = lireArguments(process.argv.slice(2))` et passer `partie` à rejouerMutants.\");\n    return 1;", '--part : un lot qui ne la transmet pas donne le code 1 au lieu de 2'],

  // --- la durée de chaque mutant
  ['      const debut = horloge();', '      const debut = 0;', 'durée : comptée depuis zéro, pas depuis le début du mutant'],
  ['      const dureeMs = horloge() - debut;', '      const dureeMs = horloge();', 'durée : l\'heure de fin au lieu de la durée'],
  ['      const dureeMs = horloge() - debut;', '      const dureeMs = debut - horloge();', 'durée : négative (début et fin intervertis)'],
  ['[${Math.round(dureeMs / 100) / 10} s]', '[${Math.round(dureeMs / 1000)} s]', 'durée dite : arrondie à la seconde'],
  ['[${Math.round(dureeMs / 100) / 10} s]', '[${dureeMs} s]', 'durée dite : des millisecondes annoncées en secondes'],
  ['horloge = Date.now,', 'horloge = () => 0,', 'durée : l\'horloge par défaut ne marche pas'],
  ['horloge = Date.now,', 'horloge = () => 1000,', 'durée : l\'horloge par défaut est arrêtée'],

  // --- les dossiers où se balaie
  ["{ tmpdir = os.tmpdir(), fixe = process.env.GWAUDIT_MUTANTS_RACINE_FIXE || '/tmp' } = {}", "{ tmpdir = '/tmp', fixe = process.env.GWAUDIT_MUTANTS_RACINE_FIXE || '/tmp' } = {}", 'racines : TMPDIR ignoré par défaut'],
  ["{ tmpdir = os.tmpdir(), fixe = process.env.GWAUDIT_MUTANTS_RACINE_FIXE || '/tmp' } = {}", "{ tmpdir = os.tmpdir(), fixe = process.env.GWAUDIT_MUTANTS_RACINE_FIXE || '/var/tmp' } = {}", 'racines : /var/tmp au lieu de /tmp'],
  ["fixe = process.env.GWAUDIT_MUTANTS_RACINE_FIXE || '/tmp' } = {}", "fixe = '/tmp' } = {}", 'racines : la variable de la seconde racine ignorée (le moteur muté balaierait le vrai /tmp)'],
  ["fixe = process.env.GWAUDIT_MUTANTS_RACINE_FIXE || '/tmp' } = {}", "fixe = process.env.GWAUDIT_MUTANTS_RACINE_FIXE ?? '/tmp' } = {}", 'racines : variable vide prise pour une racine'],
  ['for (const racine of [tmpdir, fixe]) {', 'for (const racine of [tmpdir]) {', 'racines : /tmp jamais balayé'],
  ['for (const racine of [tmpdir, fixe]) {', 'for (const racine of [fixe, tmpdir]) {', 'racines : /tmp avant TMPDIR'],
  ['    if (vues.has(reelle)) continue;\n', '', 'racines : le même dossier est balayé deux fois'],
  ['    vues.add(reelle);\n', '', 'racines : jamais dédoublonné'],
  ['try { reelle = fs.realpathSync(racine); } catch { continue; }', 'try { reelle = fs.realpathSync(racine); } catch { reelle = racine; }', 'racines : un dossier absent est gardé'],
  ['try { reelle = fs.realpathSync(racine); } catch { continue; }', 'reelle = racine;', 'racines : un lien vers le même dossier est balayé comme un autre'],
  ['    racines.push(racine);', '    racines.push(reelle);', 'racines : le chemin résolu est rendu au lieu de celui qu\'on a donné'],

  // --- la précondition de traversée (o+x)
  ['if (uid !== 0 || !exigerChromium) return null;', 'if (!exigerChromium) return null;', 'o+x : exigé aussi hors root'],
  ['if (uid !== 0 || !exigerChromium) return null;', 'if (uid !== 0) return null;', 'o+x : exigé sans Chromium'],
  ['if (uid !== 0 || !exigerChromium) return null;', 'if (uid === 0 || !exigerChromium) return null;', 'o+x : exigé hors root seulement'],
  ['if ((mode & 0o001) === 0) {', 'if ((mode & 0o004) === 0) {', 'o+x : le bit de lecture des autres pris pour celui de traversée'],
  ['if ((mode & 0o001) === 0) {', 'if ((mode & 0o100) === 0) {', 'o+x : le bit de traversée du propriétaire'],
  ['if ((mode & 0o001) === 0) {', 'if ((mode & 0o111) === 0) {', 'o+x : la traversée de n\'importe qui suffit'],
  ['if ((mode & 0o001) === 0) {', 'if ((mode & 0o001) !== 0) {', 'o+x : inversé'],
  ["if (path.dirname(dossier) === dossier) return null;", "if (dossier === '/tmp') return null;", 'o+x : la remontée s\'arrête à /tmp'],
  ["for (let dossier = path.resolve(chemin); ; dossier = path.dirname(dossier)) {", "for (let dossier = chemin; ; dossier = path.dirname(dossier)) {", 'o+x : le chemin n\'est pas résolu avant d\'être remonté'],
  ["illisible (${e.code ?? e.message})", "illisible (${e.message})", 'o+x : un dossier illisible ne dit pas son code'],
  ["mode ${(mode & 0o7777).toString(8)}", "mode ${mode.toString(8)}", 'o+x : le mode dit avec le type de fichier'],
  ["(TMPDIR=/tmp)", "(TMPDIR=/var)", 'o+x : la consigne donne un autre dossier'],
  ['const refus = preconditionTraversable(dossierTemporaire, { uid, exigerChromium });', 'const refus = preconditionTraversable(dossierTemporaire, { uid });', 'o+x : exigé même d\'un lot sans Chromium'],
  ['const refus = preconditionTraversable(dossierTemporaire, { uid, exigerChromium });', 'const refus = preconditionTraversable(dossierTemporaire, { exigerChromium });', 'o+x : l\'utilisateur du lot est ignoré'],
  ["    try { dossierTemporaire = fs.realpathSync(dossierTemporaire); } catch { /* le dossier n'existe pas : la copie ne pourra pas s'y faire, et le dira */ }\n", '', 'o+x : le chemin du dossier temporaire n\'est pas résolu (un lien vers un dossier fermé passe)'],
  ['if (refus) {\n      erreur(refus);\n      return 2;', 'if (refus) {\n      erreur(refus);\n      return 1;', 'o+x : refusé avec le code 1 au lieu de 2'],
  ['if (refus) {\n      erreur(refus);\n      return 2;', 'if (refus) {\n      return 2;', 'o+x : refusé sans le dire'],
  ['if (refus) {\n      erreur(refus);\n      return 2;', 'if (refus) {\n      erreur(refus);\n      ', 'o+x : le lot continue malgré le refus'],
  ['  if (!verifierSeulement) {\n    let dossierTemporaire', '  if (true) {\n    let dossierTemporaire', 'o+x : exigée aussi de la vérification seule'],

  // --- le dossier temporaire des suites
  ['const env = { ...process.env, TMPDIR: temporaire };', 'const env = { ...process.env };', 'suites : le dossier temporaire du lot, pas celui de la copie'],
  ['const temporaire = `${copie}-tmp`;', "const temporaire = path.join(copie, 'tmp');", 'suites : dossier temporaire dans la copie (un essai qui la liste le voit)'],
  ['    fs.mkdirSync(temporaire);\n', '', 'suites : dossier temporaire jamais créé'],
  ['fs.chmodSync(temporaire, 0o1777);', '', 'suites : dossier temporaire fermé aux autres utilisateurs (0700)'],
  ['fs.chmodSync(temporaire, 0o1777);', 'fs.chmodSync(temporaire, 0o777);', 'suites : dossier temporaire sans le bit collant'],

  // --- un lancement qui n'a rien jugé : zéro test nommé, ou un lot qui a perdu sa copie, un de ses fichiers de test, son dossier temporaire
  ["bilan.lances > 0 && [...sortie.matchAll(/^\\s*ok \\d+ - (.+)$/gm)].some((m) => !estFichier(m[1]))", "bilan.lances > 0", 'code 0 : un fichier sans test passe pour une suite verte'],
  ["bilan.lances > 0 && [...sortie.matchAll(", "[...sortie.matchAll(", 'code 0 : sans résumé (aucun compte), la suite passe'],
  ["Number.isNaN(bilan.lances) ? 'résumé absent' :", "false ? 'résumé absent' :", 'code 0 : le résumé absent est dit « 0 test lancé »'],
  ["bilan.lances === 0 ? '0 test lancé' :", "false ? '0 test lancé' :", 'code 0 : zéro test lancé est dit « seuls des fichiers sans test »'],
  ["if (!fs.existsSync(copie)) return { fatale: true,", "if (false) return { fatale: true,", 'perte : la copie retirée n\'est pas vue'],
  ["return { fatale: true, raison: \"la copie du lot a disparu pendant l'essai\" }", "return { fatale: false, raison: \"la copie du lot a disparu pendant l'essai\" }", 'perte : la copie retirée n\'arrête pas le lot'],
  ["if (manque) return { fatale: true,", "if (false) return { fatale: true,", 'perte : un fichier de test retiré n\'est pas vu'],
  ["return { fatale: true, raison: `${manque} a disparu", "return { fatale: false, raison: `${manque} a disparu", 'perte : un fichier de test retiré n\'arrête pas le lot'],
  ["if (!fs.existsSync(temporaire)) {\n      poserTemporaire();", "if (false) {\n      poserTemporaire();", 'perte : le dossier temporaire retiré n\'est pas vu'],
  ["if (!fs.existsSync(temporaire)) {\n      poserTemporaire();\n      return", "if (!fs.existsSync(temporaire)) {\n      return", 'perte : le dossier temporaire retiré n\'est pas reposé'],
  ["poserTemporaire();\n      return { fatale: false,", "poserTemporaire();\n      return { fatale: true,", 'perte : le dossier temporaire retiré arrête le lot'],
  ["bilan = { ...bilan, verdict: 'plantage', raison: `${perte.raison} : ce qui a échoué ne juge pas le mutant` };", "bilan = { ...bilan, raison: `${perte.raison} : ce qui a échoué ne juge pas le mutant` };", 'perte : le verdict reste celui de la suite (un mutant « tué » par le vide)'],
  ["bilan = { ...bilan, verdict: 'plantage', raison: `${perte.raison} : ce qui a échoué ne juge pas le mutant` };", "bilan = { ...bilan, verdict: 'plantage', raison: perte.raison };", 'perte : le plantage ne dit pas que l\'échec ne juge pas le mutant'],
  ["if (perte.fatale) lotPerdu = perte.raison;", "", 'perte : le lot ne sait jamais qu\'il a perdu sa copie'],
  ["if (lotPerdu) { bilan.nonJuges += 1; continue; }", "if (false) { bilan.nonJuges += 1; continue; }", 'lot perdu : les mutants suivants sont quand même lancés'],
  ["if (lotPerdu) { bilan.nonJuges += 1; continue; }", "if (lotPerdu) { continue; }", 'lot perdu : les mutants suivants ne sont pas comptés non jugés'],
  ["if (!lotPerdu) fs.writeFileSync(chemin, original);", "fs.writeFileSync(chemin, original);", 'lot perdu : le fichier d\'origine est réécrit dans une copie qui n\'existe plus'],
  ["${bilan.nonJuges ? ` ; ${bilan.nonJuges} non jugé", "${true ? ` ; ${bilan.nonJuges} non jugé", 'non jugés : dits même quand il n\'y en a aucun'],
  ["non jugé${bilan.nonJuges > 1 ? 's' : ''}`", "non jugé${bilan.nonJuges > 0 ? 's' : ''}`", 'non jugés : le pluriel dès un seul'],
  ["non jugé${bilan.nonJuges > 1 ? 's' : ''}`", "non jugé`", 'non jugés : jamais au pluriel'],
  ["if (lotPerdu) erreur(", "if (false) erreur(", 'lot perdu : le lot ne le dit pas'],
  ["${bilan.nonJuges ? ` : ${bilan.nonJuges} mutant(s) n'ont pas été rejoués` : ''}", "${true ? ` : ${bilan.nonJuges} mutant(s) n'ont pas été rejoués` : ''}", 'lot perdu : dit des mutants non rejoués même quand il n\'y en a aucun'],

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
