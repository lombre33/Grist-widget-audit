/**
 * Les outils qui mesurent la mémoire d'un audit dans l'image (`docker/ci/mesurer-pics.sh`, `pics.cjs`, `resumer-pics.cjs`) :
 * ce qu'ils ne savent pas mesurer ne doit pas passer pour une mesure. Le conteneur lui-même ne se lance pas ici (rien n'est
 * supposé de Docker dans la suite) ; ce qui est éprouvé, c'est le relevé (`pics.cjs`, sous Linux : il lit /proc), le résumé, et les
 * refus de la ligne de commande avant que rien ne soit lancé.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PICS = path.join(RACINE, 'docker', 'ci', 'pics.cjs');
const RESUMER = path.join(RACINE, 'docker', 'ci', 'resumer-pics.cjs');
const SCRIPT = path.join(RACINE, 'docker', 'ci', 'mesurer-pics.sh');
const LINUX = { skip: process.platform !== 'linux' && 'le relevé lit /proc' };
const temporaire = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-essai-pics-'));

test('pics.cjs relève le pic de chaque processus et la durée, dans le dossier demandé, et ne retient pas le parent en vie', LINUX, () => {
  const sortie = temporaire();
  try {
    const debut = Date.now();
    const r = spawnSync(process.execPath, ['-r', PICS, '-e', 'setTimeout(() => {}, 700)'], { encoding: 'utf8', env: { ...process.env, GWAUDIT_PICS_SORTIE: sortie }, timeout: 20_000 });
    assert.equal(r.status, 0, `${r.stderr} ${r.signal}`);
    assert.ok(Date.now() - debut < 15_000, 'le parent s\'arrête de lui-même : l\'intervalle du relevé ne le retient pas');
    const p = JSON.parse(fs.readFileSync(path.join(sortie, 'pics.json'), 'utf8'));
    assert.ok(p.dureeS >= 0.6, `la durée est celle du parent : ${p.dureeS}`);
    assert.ok(Array.isArray(p.processus) && p.processus.length >= 1);
    const parent = p.processus.find((x) => x.cmd.includes(PICS));
    assert.ok(parent, `le parent est relevé sous sa ligne de commande : ${JSON.stringify(p.processus)}`);
    assert.ok(parent.hwmMo > 20, 'un processus Node dépasse 20 Mo résidents');
    assert.ok(p.processus.every((x) => x.hwmMo >= 20), 'ce qui est sous 20 Mo résidents n\'est pas relevé : la liste ne noie pas les pics qui comptent');
    assert.ok('cgroupMo' in p && 'echecsDeLimite' in p, 'le pic du groupe de contrôle et les refus de mémoire sont dits, même quand l\'hôte n\'en a pas');
  } finally { fs.rmSync(sortie, { recursive: true, force: true }); }
});

test('pics.cjs : le pic est celui du noyau (VmHWM), pas la mémoire résidente du moment : un pic plus court que l\'intervalle du relevé est gardé', LINUX, () => {
  const sortie = temporaire();
  try {
    // 150 Mo alloués puis rendus dans le même tour de boucle : le relevé, qui tourne dans cette même boucle, ne peut pas les voir ; VmHWM, si.
    const script = 'let t = Buffer.alloc(150 * 1024 * 1024, 1); t = null; global.gc(); global.gc(); setTimeout(() => {}, 900);';
    const r = spawnSync(process.execPath, ['--expose-gc', '-r', PICS, '-e', script], { encoding: 'utf8', env: { ...process.env, GWAUDIT_PICS_SORTIE: sortie }, timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    const p = JSON.parse(fs.readFileSync(path.join(sortie, 'pics.json'), 'utf8'));
    const parent = p.processus.find((x) => x.cmd.includes(PICS));
    assert.ok(parent.hwmMo >= 150, `le pic de 150 Mo est gardé : ${parent.hwmMo}`);
  } finally { fs.rmSync(sortie, { recursive: true, force: true }); }
});

test('pics.cjs : le pic d\'un processus qui a fini sans être attendu (zombie, plus de VmHWM) reste dans la liste', LINUX, async () => {
  const sortie = temporaire();
  try {
    // Un processus « Z » lance le gros processus puis bloque sa boucle 2,5 s (Atomics.wait) sans l'attendre : le gros finit à 0,7 s et reste zombie
    // près de 2 s, que le relevé (toutes les 200 ms, dans un autre processus) traverse. C'est ce que l'enfant de l'analyse fait au parent quand
    // celui-ci n'a pas encore traité sa fin, et une lecture qui remplace le pic par la dernière valeur (0) le perd.
    const gros = 'const b = Buffer.alloc(150 * 1024 * 1024, 1); /* MARQUE-PIC-ZOMBIE */ setTimeout(() => {}, 700);';
    const z = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(gros)}], { stdio: 'ignore' }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);`;
    const releve = `const p = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(z)}], { stdio: 'ignore' }); p.on('close', () => {});`;
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['-r', PICS, '-e', releve], { env: { ...process.env, GWAUDIT_PICS_SORTIE: sortie }, stdio: 'ignore', timeout: 20_000 });
      p.on('close', resolve);
    });
    assert.equal(code, 0, 'le processus relevé finit de lui-même (un relevé qui le retient en vie, c\'est un conteneur qui ne s\'arrête jamais : arrêté ici par le plafond de 20 s)');
    const p = JSON.parse(fs.readFileSync(path.join(sortie, 'pics.json'), 'utf8'));
    const grosProcessus = p.processus.find((x) => x.cmd.includes('MARQUE-PIC-ZOMBIE'));
    assert.ok(grosProcessus && grosProcessus.hwmMo >= 150, `le pic de 150 Mo du processus fini est gardé : ${JSON.stringify(p.processus.map((x) => [x.cmd.slice(0, 40), x.hwmMo]))}`);
  } finally { fs.rmSync(sortie, { recursive: true, force: true }); }
});

const Mio = 1048576;
/** Lance le relevé sur un faux groupe de contrôle (`fichiers` : chemin relatif → contenu) et rend ce qu'il a écrit. */
function releverAvec(fichiers) {
  const sortie = temporaire();
  const cgroupe = temporaire();
  try {
    for (const [chemin, contenu] of Object.entries(fichiers)) {
      fs.mkdirSync(path.dirname(path.join(cgroupe, chemin)), { recursive: true });
      fs.writeFileSync(path.join(cgroupe, chemin), contenu);
    }
    const r = spawnSync(process.execPath, ['-r', PICS, '-e', '1'], { encoding: 'utf8', env: { ...process.env, GWAUDIT_PICS_SORTIE: sortie, GWAUDIT_PICS_CGROUPE: cgroupe }, timeout: 20_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(sortie, 'pics.json'), 'utf8'));
  } finally { fs.rmSync(sortie, { recursive: true, force: true }); fs.rmSync(cgroupe, { recursive: true, force: true }); }
}

test('pics.cjs, cgroup v1 : le pic vient de max_usage_in_bytes, en Mio, et les refus de mémoire de failcnt', LINUX, () => {
  const p = releverAvec({ 'memory/memory.max_usage_in_bytes': `${700 * Mio}\n`, 'memory/memory.failcnt': '3\n' });
  assert.equal(p.cgroupMo, 700);
  assert.equal(p.echecsDeLimite, '3');
});

test('pics.cjs, cgroup v2 : le pic vient de memory.peak, les refus sont le « max » et l\'« oom_kill » de memory.events, pas leurs voisins', LINUX, () => {
  const p = releverAvec({ 'memory.peak': `${650 * Mio}\n`, 'memory.events': 'low 0\nhigh 5\nmax 2\noom 7\noom_kill 1\n' });
  assert.equal(p.cgroupMo, 650);
  assert.equal(p.echecsDeLimite, 'max 2, oom_kill 1');
});

test('pics.cjs : v1 et v2 ensemble, la v1 l\'emporte ; ni l\'une ni l\'autre, le pic et les refus sont null (jamais 0) ; un pic illisible n\'est pas un pic', LINUX, () => {
  const deux = releverAvec({ 'memory/memory.max_usage_in_bytes': `${700 * Mio}`, 'memory/memory.failcnt': '0', 'memory.peak': `${650 * Mio}`, 'memory.events': 'max 9\noom_kill 9\n' });
  assert.equal(deux.cgroupMo, 700);
  assert.equal(deux.echecsDeLimite, '0');
  const rien = releverAvec({});
  assert.equal(rien.cgroupMo, null);
  assert.equal(rien.echecsDeLimite, null);
  for (const illisible of ['', '\n', 'max\n', 'pas un nombre']) assert.equal(releverAvec({ 'memory.peak': illisible }).cgroupMo, null, JSON.stringify(illisible));
  const sansCompteur = releverAvec({ 'memory.peak': `${1 * Mio}`, 'memory.events': 'low 0\n' });
  assert.equal(sansCompteur.echecsDeLimite, 'max ?, oom_kill ?', 'un compteur absent est dit « ? »');
});

const resumer = (dossier, code = '2') => spawnSync(process.execPath, [RESUMER, dossier, code, '75', '768m'], { encoding: 'utf8' });
const ecrire = (dossier, pics, rapport) => {
  if (pics) fs.writeFileSync(path.join(dossier, 'pics.json'), JSON.stringify(pics));
  if (rapport) fs.writeFileSync(path.join(dossier, 'rapport.json'), rapport);
};
const PICS_TYPE = { dureeS: 75.1, cgroupMo: 614, echecsDeLimite: '0', processus: [
  { cmd: 'node -r /pics.cjs bin/gwaudit.js /cible --json', hwmMo: 174 },
  { cmd: '/usr/bin/node --max-old-space-size=558 /app/src/isolement/enfant-travail.mjs /tmp/x', hwmMo: 613 },
  { cmd: '/ms-playwright/chromium-1243/chrome-linux64/chrome --headless', hwmMo: 180 },
] };

test('resumer-pics : une ligne avec le pic du groupe de contrôle, celui de l\'enfant et celui du parent, chacun à sa place, et l\'issue', () => {
  const d = temporaire();
  try {
    ecrire(d, PICS_TYPE, '{"axes":{}}');
    const r = resumer(d);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.match(r.stdout, /^code 2, 75 s, --memory 768m : groupe de contrôle 614 Mo, enfant 613 Mo, parent 174 Mo, refus de mémoire 0 ; analysé jusqu'au bout ; détail : /);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('resumer-pics : un rapport de repli est dit repli, un rapport absent ou illisible laisse l\'issue à « ? », jamais à « analysé jusqu\'au bout »', () => {
  const d = temporaire();
  try {
    ecrire(d, PICS_TYPE, '{"axes":{"C":{"constats":[{"preuve":{"cause":"interruption"}}]}}}');
    assert.match(resumer(d).stdout, /; REPLI \(interruption\) ;/);
    fs.rmSync(path.join(d, 'rapport.json'));
    assert.match(resumer(d).stdout, /refus de mémoire 0 ; \? ;/, 'sans rapport, on ne sait pas : c\'est dit');
    fs.writeFileSync(path.join(d, 'rapport.json'), '{pas du json');
    assert.match(resumer(d).stdout, /refus de mémoire 0 ; \? ;/, 'un rapport illisible non plus');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('resumer-pics : sans pics.json (le parent est mort avant d\'écrire) le résumé le dit et sort en 3, sans inventer de pic', () => {
  const d = temporaire();
  try {
    const r = resumer(d, '137');
    assert.equal(r.status, 3);
    assert.match(r.stdout, /^code 137 : aucun pics\.json/);
    assert.doesNotMatch(r.stdout, /groupe de contrôle/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('resumer-pics : un pic ou des refus que l\'hôte ne donne pas sont dits « ? », pas « null » ni 0', () => {
  const d = temporaire();
  try {
    ecrire(d, { ...PICS_TYPE, cgroupMo: null, echecsDeLimite: null }, '{}');
    assert.match(resumer(d).stdout, /groupe de contrôle \? Mo, enfant 613 Mo, parent 174 Mo, refus de mémoire \? ;/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('resumer-pics : un processus absent est dit « ? », pas 0 ni une valeur voisine', () => {
  const d = temporaire();
  try {
    ecrire(d, { ...PICS_TYPE, processus: [PICS_TYPE.processus[2]] }, '{}');
    assert.match(resumer(d).stdout, /enfant \? Mo, parent \? Mo/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

const script = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

test('mesurer-pics.sh refuse ce qu\'il ne saurait mesurer avant de lancer quoi que ce soit (code 64)', LINUX, () => {
  const cas = [[[], /usage : mesurer-pics\.sh/], [['--inconnue'], /option inconnue : --inconnue/], [['/dossier/qui/n/existe/pas'], /usage : mesurer-pics\.sh/],
    [['.', '..'], /une seule cible/], [['--image'], /--image demande un nom/], [['--memoire'], /--memoire demande une valeur/]];
  for (const [args, message] of cas) {
    const r = script(...args);
    assert.equal(r.status, 64, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(r.stdout, '', 'aucune ligne de mesure quand rien n\'a été mesuré');
  }
  const fichier = script(path.join(RACINE, 'package.json'));
  assert.equal(fichier.status, 64, 'un fichier n\'est pas un dossier cible');
});
