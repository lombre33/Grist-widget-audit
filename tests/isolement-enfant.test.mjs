/**
 * L'exécution isolée (src/isolement/enfant.js) : un travail qui tourne dans un processus enfant à
 * limite de mémoire et de temps, et dont chaque fin autre qu'un résultat complet est nommée.
 *
 * Chaque fin possible a son essai, indépendant de la machine : les fins que V8 ou le noyau imposent
 * (abandon SIGABRT, SIGKILL, tas épuisé) sont provoquées par le travail lui-même (voir
 * tests/aide-isolement/) plutôt que par une charge dont l'effet dépendrait de la mémoire disponible.
 * Le parent ne prend aucune fin pour un résultat : sans le marqueur `termine`, c'est une interruption.
 *
 * Ce que ces essais ne prouvent pas, dit tel quel : qu'un vrai fichier hostile épuise la mémoire au
 * seuil annoncé (mesuré à part, docs/ARCHITECTURE-V2.md) ni qu'un noyau réel tue le bon processus
 * (preuve dans l'image avec son plafond, docker/ci/verifier.sh, scénario `interruption`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ErreurLancement, executerEnEnfant, expliquer } from '../src/isolement/enfant.js';

const AIDE = (nom) => fileURLToPath(new URL(`./aide-isolement/${nom}.mjs`, import.meta.url));
const POSIX = process.platform !== 'win32';

const lancer = (nom, entree = {}, options = {}) => executerEnEnfant({ module: AIDE(nom), entree, relayerStderr: null, ...options });
const vivant = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function attendreLaMort(pid, delaiMs = 6000) {
  const debut = Date.now();
  while (vivant(pid) && Date.now() - debut < delaiMs) await new Promise((r) => setTimeout(r, 100));
  return !vivant(pid);
}

test('un travail qui aboutit rend son résultat et ce qu\'il a sorti en cours de route', async () => {
  const r = await lancer('ok', { a: 2, b: 3 });
  assert.equal(r.termine, true);
  assert.deepEqual(r.resultat, { somme: 5 });
  assert.deepEqual(r.partiel, { vu: 'partiel' });
});

test('SIGABRT avec le texte du tas épuisé de V8 : cause « tas », la limite dite', { skip: !POSIX && 'SIGABRT : sous Windows le processus est tué sans signal' }, async () => {
  const r = await lancer('abandon', { texteDuTas: true }, { limiteMo: 300 });
  assert.equal(r.termine, false);
  assert.equal(r.cause.genre, 'tas');
  assert.equal(r.cause.signal, 'SIGABRT');
  assert.equal(r.cause.etape, 'regles');
  assert.match(r.cause.raison, /mémoire épuisée.*300 Mio/);
  assert.match(r.cause.fin, /heap out of memory/);
  assert.deepEqual(r.partiel, { vu: 'partiel' }, 'ce qui était sorti avant l\'abandon survit à la mort du processus');
});

test('la fin de la sortie d\'erreur est gardée, pas son début : un message de V8 précédé de 40 Kio de bruit (plus du double de ce qui est gardé, 16 Kio) est reconnu', { skip: !POSIX && 'SIGABRT : sous Windows le processus est tué sans signal' }, async () => {
  const r = await lancer('abandon', { texteDuTas: true, bruit: 40_000 });
  assert.equal(r.cause.genre, 'tas');
  assert.match(r.cause.fin, /heap out of memory/);
  assert.ok(r.cause.fin.length <= 400);
});

test('SIGABRT sans texte de mémoire : cause « abandon », jamais dite mémoire épuisée sans preuve', { skip: !POSIX && 'SIGABRT : sous Windows le processus est tué sans signal' }, async () => {
  const r = await lancer('abandon', {});
  assert.equal(r.termine, false);
  assert.equal(r.cause.genre, 'abandon');
  assert.doesNotMatch(r.cause.raison, /^mémoire épuisée/, 'sans le texte de V8, la mémoire n\'est pas affirmée comme la cause');
  assert.match(r.cause.raison, /SIGABRT.*sans autre précision/);
});

test('SIGABRT du compilateur d\'expressions régulières (pile presque pleine) : cause « pile », jamais « mémoire épuisée » malgré « process out of memory » et « Allocation failed » dans son message', { skip: !POSIX && 'SIGABRT : sous Windows le processus est tué sans signal' }, async () => {
  const r = await lancer('abandon', { textePileRegexp: true }, { limiteMo: 300 });
  assert.equal(r.termine, false);
  assert.equal(r.cause.genre, 'pile');
  assert.equal(r.cause.signal, 'SIGABRT');
  assert.doesNotMatch(r.cause.raison, /^mémoire épuisée/);
  assert.match(r.cause.raison, /expression régulière : la pile est presque pleine/);
  assert.match(r.cause.raison, /la mémoire n'y est pour rien/);
  assert.deepEqual(r.partiel, { vu: 'partiel' });
});

test('le message fatal de V8 est dit dans la cause même quand sa trace native, dessous, est plus longue que trois lignes et que quatre Kio', { skip: !POSIX && 'SIGABRT : sous Windows le processus est tué sans signal' }, async () => {
  const r = await lancer('abandon', { textePileRegexp: true, trace: 55 });
  assert.equal(r.cause.genre, 'pile', 'le message est au-dessus de plus de quatre Kio de trace : il est encore lu');
  assert.match(r.cause.fin, /^FATAL ERROR: RegExpCompiler Allocation failed - process out of memory \| .*\[\/opt\/node22\/bin\/node\]$/, 'le message en tête, entier, puis la fin de la trace');
  assert.ok(r.cause.fin.length <= 400, `${r.cause.fin.length}`);
  assert.ok(r.cause.fin.length > 300, 'la place que le message laisse est remplie par la fin de la trace');
  const court = await lancer('abandon', { textePileRegexp: true, trace: 1 });
  assert.equal(court.cause.genre, 'pile');
  assert.equal((court.cause.fin.match(/process out of memory/g) ?? []).length, 1, 'le message n\'est pas répété (même coupé) quand il est déjà parmi les dernières lignes');
  assert.match(court.cause.fin, /^FATAL ERROR: RegExpCompiler Allocation failed - process out of memory \| ----- Native stack trace ----- \| 1: /);
});

test('l\'abandon du compilateur d\'expressions régulières sans signal (Windows : le processus sort avec le code 3) est dit « pile » aussi ; le même texte cité au milieu d\'une ligne, ou avec un SIGKILL, ne l\'est pas', () => {
  const fatal = 'FATAL ERROR: RegExpCompiler Allocation failed - process out of memory';
  const cause = (o) => expliquer({ code: null, signal: null, delaiAtteint: false, delaiMs: null, limiteMo: 300, etape: 'inventaire', fin: '', echec: null, resultatPresent: false, ...o });
  const sansSignal = cause({ code: 3, fin: `[9859:0x7f63e4001000]      174 ms: Scavenge 12.7 (17.4) -> 11.1 (17.6) MB\n\n<--- JS stacktrace --->\n\n${fatal}\n----- Native stack trace -----\n\n 1: 0x1 v8` });   // comme la vraie sortie : le message n'est pas sur la première ligne
  assert.equal(sansSignal.genre, 'pile');
  assert.equal(sansSignal.code, 3);
  assert.equal(sansSignal.signal, null);
  const cite = cause({ code: 3, fin: `⚠ fichier ${fatal}\n` });
  assert.equal(cite.genre, 'sortie', 'un avertissement qui cite le message n\'est pas le message de V8');
  assert.match(cite.raison, /code 3/);
  assert.equal(cause({ signal: 'SIGABRT', fin: `⚠ fichier ${fatal}\n` }).genre, 'tas', 'cité, le message ne fait pas une pile pleine (« Allocation failed » : le motif de la mémoire, lui, reste large)');
  assert.equal(cause({ signal: 'SIGKILL', fin: `${fatal}\n` }).genre, 'noyau', 'un SIGKILL n\'est pas un abandon de V8');
  assert.equal(cause({ code: 0, fin: `${fatal}\n` }).genre, 'incomplet', 'une sortie 0 n\'est pas un abandon');
  assert.equal(cause({ signal: 'SIGABRT', fin: `${fatal}\n` }).genre, 'pile');
  assert.equal(cause({ code: 134, fin: `${fatal}\n` }).genre, 'pile');
});

test('SIGKILL (le noyau à court de mémoire) : cause « noyau »', { skip: !POSIX && 'signaux POSIX' }, async () => {
  const r = await lancer('noyau');
  assert.equal(r.termine, false);
  assert.equal(r.cause.genre, 'noyau');
  assert.equal(r.cause.signal, 'SIGKILL');
  assert.match(r.cause.raison, /noyau/);
  assert.deepEqual(r.partiel, { vu: 'partiel' });
});

for (const [variante, precision] of [['tronque', /aucun résultat lisible|sans écrire de résultat/], ['sans-marqueur', /marqueur de fin absent/]]) {
  test(`un fichier de résultat ${variante === 'tronque' ? 'tronqué' : 'sans marqueur de fin'}, code de sortie 0 : « incomplet », jamais pris pour un résultat`, async () => {
    const r = await lancer('incomplet', { variante });
    assert.equal(r.termine, false);
    assert.equal(r.cause.genre, 'incomplet');
    assert.equal(r.cause.code, 0);
    assert.match(r.cause.raison, precision);
  });
}

test('un tas épuisé que le Worker rattrape : cause « tas » avec la limite', async () => {
  const r = await lancer('tas', {}, { limiteMo: 64 });
  assert.equal(r.termine, false);
  assert.equal(r.cause.genre, 'tas');
  assert.match(r.cause.raison, /64 Mio/);
  assert.equal(r.cause.etape, 'regles');
  assert.deepEqual(r.partiel, { vu: 'partiel' });
  // Ce que le travail a voulu prendre est un Gio : c'est la limite du tas, pas la fin de sa charge, qui l'a arrêté (l'enfant a eu le temps d'écrire son pic).
  assert.ok(r.mesures?.rssMaxMo > 0 && r.mesures.rssMaxMo < 500, `pic de mémoire résidente : ${JSON.stringify(r.mesures)}`);
});

test('le pic de mémoire résidente de l\'enfant est rendu avec un résultat', async () => {
  const r = await lancer('ok', { a: 1, b: 1 });
  assert.ok(r.mesures.rssMaxMo > 20 && r.mesures.rssMaxMo < 500, JSON.stringify(r.mesures));
});

test('une erreur du travail : cause « exception » avec son message', async () => {
  const r = await lancer('exception');
  assert.equal(r.termine, false);
  assert.equal(r.cause.genre, 'exception');
  assert.match(r.cause.raison, /la règle X a planté sur ce fichier/);
});

test('le message d\'une erreur interne peut porter du texte du widget : cité comme du texte quand un caractère y a un sens, tel quel sinon, et un message absent est dit tel', () => {
  const raison = (echec) => expliquer({ code: 1, signal: null, delaiAtteint: false, delaiMs: null, limiteMo: 300, etape: 'regles', fin: '', echec, resultatPresent: false }).raison;
  assert.equal(raison({ genre: 'exception', message: 'la règle X a planté sur ce fichier' }), "erreur interne de l'analyse : la règle X a planté sur ce fichier", 'un message sans caractère fragile s\'écrit comme avant');
  assert.equal(raison({ genre: 'exception', message: 'a`b <b>' }), "erreur interne de l'analyse : ``a`b <b>``", 'la barre d\'ouverture est plus longue que toute suite de guillemets inversés du message');
  assert.equal(raison({ genre: 'exception', message: 'Cannot read properties of undefined (reading \'x\')' }), "erreur interne de l'analyse : `Cannot read properties of undefined (reading 'x')`");
  const echappement = '\u001b[2J\u001b]0;pwnd\u0007 # Faux titre';
  assert.equal(raison({ genre: 'exception', message: echappement }), "erreur interne de l'analyse : `\\u001b[2J\\u001b]0;pwnd\\u0007 # Faux titre`", 'un caractère d\'échappement n\'atteint ni le terminal ni le Markdown');
  assert.equal(raison({ genre: 'exception' }), "erreur interne de l'analyse : sans message");
  assert.equal(raison({ genre: 'exception', message: '' }), "erreur interne de l'analyse : sans message");
});

test('un travail qui sort avec un code sans résultat : « exception », le code est dit', async () => {
  const r = await lancer('sortie', { code: 3 });
  assert.equal(r.termine, false);
  assert.equal(r.cause.genre, 'exception');
  assert.match(r.cause.raison, /code 3/);
});

test('le délai atteint tue l\'enfant et son petit-enfant, cause « delai », ce qui était sorti est gardé', { skip: !POSIX && 'groupe de processus POSIX', timeout: 60_000 }, async (t) => {
  const pids = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-enfant-')), 'pids.json');
  t.after(() => fs.rmSync(path.dirname(pids), { recursive: true, force: true }));
  const r = await lancer('dort', { fichierPids: pids }, { delaiMs: 1500 });
  assert.equal(r.termine, false);
  assert.equal(r.cause.genre, 'delai');
  assert.match(r.cause.raison, /2 s|1 s|délai dépassé/);
  const { enfant, petitEnfant } = JSON.parse(fs.readFileSync(pids, 'utf8'));
  assert.ok(await attendreLaMort(enfant), 'l\'enfant est mort');
  assert.ok(await attendreLaMort(petitEnfant), 'ce que l\'enfant avait lancé est mort avec lui');
});

test('sans délai, un travail long n\'est pas coupé (V1 : aucune limite de temps par défaut)', async () => {
  const r = await lancer('ok', { a: 1, b: 1 }, { delaiMs: null });
  assert.equal(r.termine, true);
});

test('un enfant qui ne peut pas être lancé : ErreurLancement, jamais un résultat ni une cause d\'interruption', async () => {
  // Une valeur d'environnement de plus de 128 Kio dépasse la limite d'une chaîne d'exec (E2BIG).
  await assert.rejects(
    lancer('ok', { a: 1, b: 1 }, { env: { ...process.env, GWAUDIT_TROP_LONGUE: 'x'.repeat(300_000) } }),
    (e) => e instanceof ErreurLancement && /impossible de lancer/.test(e.message),
  );
});

test('la sortie d\'erreur de l\'enfant est relayée telle quelle et sa fin est gardée pour la cause', async () => {
  let vu = '';
  const r = await lancer('bavard', { ligne: '→ une ligne de progression' }, { relayerStderr: { write: (m) => { vu += m; } } });
  assert.equal(r.termine, true);
  assert.match(vu, /→ une ligne de progression/);
});

test('l\'enfant relève son propre score de mort par manque de mémoire (le noyau le tue avant le parent)', { skip: !fs.existsSync('/proc/self/oom_score_adj') && 'pas de /proc' }, async () => {
  const r = await lancer('bavard', { ligne: 'x' }, { scoreOom: 700 });
  assert.equal(r.resultat.score, '700');
  const parDefaut = await lancer('bavard', { ligne: 'x' });
  assert.equal(parDefaut.resultat.score, '1000', 'valeur par défaut : la plus haute');
});

test('le dossier de travail est retiré après un résultat comme après chaque fin anormale', { skip: !POSIX && 'TMPDIR et SIGABRT : POSIX' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-enfant-'));
  const ancien = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  t.after(() => { if (ancien === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = ancien; fs.rmSync(tmp, { recursive: true, force: true }); });
  await lancer('ok', { a: 1, b: 1 });
  await lancer('abandon', {});
  await lancer('exception');
  await lancer('incomplet', { variante: 'tronque' });
  assert.deepEqual(fs.readdirSync(tmp), []);
});

for (const [nom, periode] of [['sonde de 200 ms', 'sondeParentMs: 200'], ['sonde par défaut', '']]) {
test(`le parent tué sans pouvoir tuer son enfant : l'enfant s'arrête de lui-même (${nom})`, { skip: !POSIX && 'ppid POSIX', timeout: 60_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-enfant-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const pids = path.join(tmp, 'pids.json');
  const lanceur = path.join(tmp, 'lanceur.mjs');
  fs.writeFileSync(lanceur, `import { executerEnEnfant } from ${JSON.stringify(new URL('../src/isolement/enfant.js', import.meta.url).href)};
await executerEnEnfant({ module: ${JSON.stringify(AIDE('dort'))}, entree: { fichierPids: ${JSON.stringify(pids)} }, relayerStderr: null${periode ? ', ' + periode : ''} });
`);
  const travail = path.join(tmp, 'travail');
  fs.mkdirSync(travail);
  const parent = spawn(process.execPath, [lanceur], { stdio: 'ignore', env: { ...process.env, TMPDIR: travail } });
  const debut = Date.now();
  while (!fs.existsSync(pids) && Date.now() - debut < 20_000) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(pids), 'l\'enfant a démarré');
  assert.equal(fs.readdirSync(travail).filter((n) => n.startsWith('gwaudit-enfant-')).length, 1, 'témoin : le dossier de travail existe tant que l\'enfant travaille');
  const { enfant, petitEnfant } = JSON.parse(fs.readFileSync(pids, 'utf8'));
  t.after(() => { for (const p of [enfant, petitEnfant]) { try { process.kill(p, 'SIGKILL'); } catch { /* déjà mort */ } } });
  parent.kill('SIGKILL');
  assert.ok(await attendreLaMort(enfant, 15_000), 'l\'enfant s\'est arrêté après la mort de son parent');
  assert.ok(await attendreLaMort(petitEnfant, 15_000), 'ce que l\'enfant avait lancé s\'est arrêté avec lui');
  assert.deepEqual(fs.readdirSync(travail), [], 'l\'enfant a retiré le dossier de travail que son parent n\'a pas pu retirer');
});
}

test('un résultat complet écrit puis une fin en erreur : « exception », le résultat n\'est pas rendu', async () => {
  const r = await lancer('resultat-puis-erreur');
  assert.equal(r.termine, false);
  assert.equal(r.cause.genre, 'exception');
  assert.match(r.cause.raison, /erreur après le résultat/);
});

test('la taille de pile du fil de travail est celle qu\'on lui donne : une pile plus grande descend plus profond', async () => {
  const petite = await lancer('pile', {}, { pileMo: 1 });
  const grande = await lancer('pile', {}, { pileMo: 8 });
  assert.equal(petite.termine, true);
  assert.equal(grande.termine, true);
  assert.ok(grande.resultat.profondeur > 3 * petite.resultat.profondeur, `1 Mio : ${petite.resultat.profondeur}, 8 Mio : ${grande.resultat.profondeur}`);
});

test('ce que l\'enfant a lancé et laissé tourner est tué à sa sortie, résultat ou non', { skip: !POSIX && 'groupe de processus POSIX', timeout: 30_000 }, async (t) => {
  const pids = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-enfant-')), 'pids.json');
  t.after(() => fs.rmSync(path.dirname(pids), { recursive: true, force: true }));
  // Le délai n'est qu'un garde-fou : un enfant qui ne finirait pas (un processus laissé ouvert le retient) est coupé et l'essai échoue, au lieu de laisser le fichier de test pendre.
  const r = await lancer('orphelin', { fichierPids: pids }, { delaiMs: 20_000 });
  assert.equal(r.termine, true, r.cause?.raison);
  const { petitEnfant } = JSON.parse(fs.readFileSync(pids, 'utf8'));
  t.after(() => { try { process.kill(petitEnfant, 'SIGKILL'); } catch { /* déjà mort */ } });
  assert.ok(await attendreLaMort(petitEnfant, 5000), 'le petit-enfant est mort avec l\'enfant');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`le parent qui reçoit ${signal} (le plafond du conteneur) tue l'enfant et ce qu'il a lancé avant de s'arrêter, sans attendre la sonde`, { skip: !POSIX && 'signaux POSIX', timeout: 60_000 }, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-enfant-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const pids = path.join(tmp, 'pids.json');
    const lanceur = path.join(tmp, 'lanceur.mjs');
    // La sonde du parent est réglée à une minute : seul le gestionnaire de signal peut arrêter l'enfant dans le délai de l'essai.
    fs.writeFileSync(lanceur, `import { executerEnEnfant } from ${JSON.stringify(new URL('../src/isolement/enfant.js', import.meta.url).href)};
await executerEnEnfant({ module: ${JSON.stringify(AIDE('dort'))}, entree: { fichierPids: ${JSON.stringify(pids)} }, relayerStderr: null, sondeParentMs: 60_000 });
`);
    const travail = path.join(tmp, 'travail');
    fs.mkdirSync(travail);
    const parent = spawn(process.execPath, [lanceur], { stdio: 'ignore', env: { ...process.env, TMPDIR: travail } });
    const fini = new Promise((resolve) => parent.once('exit', (code, sig) => resolve({ code, sig })));
    const debut = Date.now();
    while (!fs.existsSync(pids) && Date.now() - debut < 20_000) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(pids), 'l\'enfant a démarré');
    const { enfant, petitEnfant } = JSON.parse(fs.readFileSync(pids, 'utf8'));
    t.after(() => { for (const p of [enfant, petitEnfant]) { try { process.kill(p, 'SIGKILL'); } catch { /* déjà mort */ } } });
    parent.kill(signal);
    const sortie = await fini;
    assert.equal(sortie.sig, signal, 'le signal reprend son cours : le parent s\'arrête comme s\'il n\'avait pas été rattrapé');
    assert.ok(await attendreLaMort(enfant, 3000), 'l\'enfant est mort');
    assert.ok(await attendreLaMort(petitEnfant, 3000), 'ce que l\'enfant avait lancé est mort avec lui');
    assert.deepEqual(fs.readdirSync(travail), [], 'le parent a retiré le dossier de travail avant de s\'arrêter');
  });
}
