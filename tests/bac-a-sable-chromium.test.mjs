import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { construireContexte } from '../src/contexte/inventaire.js';
import { auditDynamique } from '../src/runtime/dynamique.js';
import { noter } from '../src/moteur/notation.js';

/**
 * Le bac à sable natif de Chromium est actif par défaut ; la seule dérogation
 * est GWAUDIT_CHROMIUM_SANS_SANDBOX=1, et le rapport la dit. Playwright ajoute
 * `--no-sandbox` de lui-même tant qu'on ne lui passe pas chromiumSandbox: true
 * — ce que gwaudit ne faisait pas (constat 3, docs/ARCHITECTURE-V2.md) : ces
 * tests le prouvent sur les arguments réellement transmis au binaire.
 *
 * Un faux Chromium (script shell) enregistre ses arguments et échoue comme
 * Chromium échoue quand il ne peut pas installer son bac à sable : le test est
 * le même sur toute machine, root ou non, avec ou sans espaces de noms
 * utilisateur. Ce script ne se lance pas sous Windows (explicite ci-dessous) ;
 * la preuve sous Windows est le job « windows » de .github/workflows/image-v2.yml.
 */
const SOUS_WINDOWS = process.platform === 'win32';

function fauxChromium(t, ligneErreur) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-faux-chromium-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const fichierArgs = path.join(dossier, 'arguments.txt');
  const exe = path.join(dossier, 'faux-chromium');
  fs.writeFileSync(exe, `#!/bin/sh\nprintf '%s\\n' "$@" > "${fichierArgs}"\necho '${ligneErreur}' >&2\nexit 1\n`, { mode: 0o755 });
  return { exe, arguments: () => (fs.existsSync(fichierArgs) ? fs.readFileSync(fichierArgs, 'utf8').split('\n').filter(Boolean) : null) };
}

async function auditAvec(env, options = {}) {
  const avant = {};
  for (const [k, v] of Object.entries(env)) { avant[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    const ctx = construireContexte(path.join(import.meta.dirname, '..', 'fixtures', 'widget-exemple'));
    return await auditDynamique(ctx, options);
  } finally {
    for (const [k, v] of Object.entries(avant)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const REFUS_ROOT = '[123:123:0929/000000.000000:ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:101] Running as root without --no-sandbox is not supported. See https://crbug.com/638180.';

test('par défaut, Chromium est lancé SANS --no-sandbox ; un refus du bac à sable est nommé avec ses deux issues', { skip: SOUS_WINDOWS && 'faux Chromium en script shell (voir le job windows du workflow)' }, async (t) => {
  const faux = fauxChromium(t, REFUS_ROOT);
  const { constats, nonExecute } = await auditAvec({ GWAUDIT_CHROMIUM_PATH: faux.exe, GWAUDIT_CHROMIUM_SANS_SANDBOX: undefined, GWAUDIT_CHROMIUM_SANDBOX: undefined });

  const args = faux.arguments();
  assert.ok(args, "le binaire n'a pas été lancé : le test ne prouve rien");
  assert.equal(args.includes('--no-sandbox'), false, `Chromium doit être lancé avec son bac à sable par défaut : ${args.join(' ')}`);

  assert.equal(nonExecute, true);
  const c = constats.find((x) => x.regle === 'D-INDISPONIBLE');
  assert.match(c.titre, /bac à sable/);
  assert.match(c.constat, /Running as root without --no-sandbox is not supported/, 'la cause précise doit être citée, sans le préfixe de journal de Chromium');
  assert.doesNotMatch(c.constat, /zygote_host_impl|\[123:/);
  assert.match(c.remediation, /\(1\)[^]*Corriger l'environnement/);
  assert.match(c.remediation, /\(2\)[^]*GWAUDIT_CHROMIUM_SANS_SANDBOX=1[^]*ce que cela expose/);
  assert.match(c.remediation, /image V2 la dérogation est refusée/);
  assert.equal(c.severite, 'info');
  assert.equal(c.bloquant, false);
});

test("l'ancien nom GWAUDIT_CHROMIUM_SANDBOX=1 reste accepté et ne change rien", { skip: SOUS_WINDOWS && 'faux Chromium en script shell' }, async (t) => {
  const faux = fauxChromium(t, REFUS_ROOT);
  const { nonExecute } = await auditAvec({ GWAUDIT_CHROMIUM_PATH: faux.exe, GWAUDIT_CHROMIUM_SANS_SANDBOX: undefined, GWAUDIT_CHROMIUM_SANDBOX: '1' });
  assert.equal(nonExecute, true);
  assert.equal(faux.arguments().includes('--no-sandbox'), false);
});

test("le conseil de déroger n'apparaît que pour un refus du bac à sable, jamais pour une autre panne", { skip: SOUS_WINDOWS && 'faux Chromium en script shell' }, async (t) => {
  const faux = fauxChromium(t, 'FATAL: la mémoire partagée est indisponible');
  const { constats, nonExecute } = await auditAvec({ GWAUDIT_CHROMIUM_PATH: faux.exe, GWAUDIT_CHROMIUM_SANS_SANDBOX: undefined });
  assert.ok(faux.arguments(), 'le binaire doit avoir été lancé');
  assert.equal(nonExecute, true);
  const c = constats.find((x) => x.regle === 'D-INDISPONIBLE');
  assert.doesNotMatch(c.titre, /bac à sable/);
  assert.doesNotMatch(c.constat + c.remediation, /GWAUDIT_CHROMIUM_SANS_SANDBOX|--no-sandbox/, 'aucun conseil de couper le bac à sable pour une cause qui n\'en est pas une');
});

test('avec la dérogation explicite, Chromium est lancé avec --no-sandbox', { skip: SOUS_WINDOWS && 'faux Chromium en script shell' }, async (t) => {
  const faux = fauxChromium(t, 'FATAL: la mémoire partagée est indisponible');
  await auditAvec({ GWAUDIT_CHROMIUM_PATH: faux.exe, GWAUDIT_CHROMIUM_SANS_SANDBOX: '1' });
  assert.ok(faux.arguments()?.includes('--no-sandbox'), 'la dérogation doit se traduire par --no-sandbox');
});

test("dérogation explicite + vrai Chromium : l'axe D tourne et le rapport (JSON et HTML) dit qu'il a tourné sans bac à sable, sans que le verdict en dépende", async (t) => {
  const sortie = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-derogation-'));
  t.after(() => fs.rmSync(sortie, { recursive: true, force: true }));
  const cli = path.join(import.meta.dirname, '..', 'bin', 'gwaudit.js');
  const fixture = path.join(import.meta.dirname, '..', 'fixtures', 'widget-exemple');
  const lancer = (derogation) => {
    const dossier = path.join(sortie, derogation ? 'avec' : 'sans');
    try {
      execFileSync(process.execPath, [cli, fixture, '--json', '--sortie', dossier], {
        env: { ...process.env, GWAUDIT_CHROMIUM_SANS_SANDBOX: derogation ? '1' : '' },
        stdio: 'pipe', timeout: 180_000,
      });
    } catch (e) {
      if (e.status === undefined || e.status > 2) throw e; // 1 et 2 sont des verdicts, pas des pannes
    }
    return JSON.parse(fs.readFileSync(path.join(dossier, 'rapport.json'), 'utf8'));
  };

  const avec = lancer(true);
  if (avec.axesNonExecutes.includes('D')) {
    const raison = avec.axes.D.constats.find((c) => c.regle === 'D-INDISPONIBLE')?.constat;
    if (process.env.GWAUDIT_SUITE_SANS_CHROMIUM === '1') { t.skip(`Axe D non exécutable (GWAUDIT_SUITE_SANS_CHROMIUM=1) : ${raison}`); return; }
    assert.fail(`Axe D non exécuté avec la dérogation : ${raison}`);
  }
  const marqueur = avec.axes.D.constats.find((c) => c.regle === 'D-INDISPONIBLE-BAC-A-SABLE');
  assert.ok(marqueur, "le marqueur doit figurer dans l'axe D du JSON");
  assert.equal(marqueur.severite, 'info');
  assert.equal(marqueur.bloquant, false);
  const html = fs.readFileSync(path.join(sortie, 'avec', 'rapport.html'), 'utf8');
  assert.match(html, /sans le bac à sable de Chromium/, 'le HTML doit le dire aussi');

  // Le verdict ne dépend pas du marqueur : la vraie notation rend le même
  // verdict, le même score global et les mêmes axes avec et sans lui.
  const dyn = await auditAvec({ GWAUDIT_CHROMIUM_SANS_SANDBOX: '1' });
  assert.ok(dyn.constats.some((c) => c.regle === 'D-INDISPONIBLE-BAC-A-SABLE'));
  const sans = dyn.constats.filter((c) => c.regle !== 'D-INDISPONIBLE-BAC-A-SABLE');
  const n1 = noter(dyn.constats, new Set());
  const n2 = noter(sans, new Set());
  assert.equal(n1.verdict, n2.verdict);
  // noter() rend `global` (pas `scoreGlobal`) : comparer une clé absente compare undefined à undefined et ne prouve rien.
  assert.ok(Number.isInteger(n1.global) && Number.isInteger(n2.global), `score global illisible : ${n1.global} / ${n2.global}`);
  assert.equal(n1.global, n2.global);
  assert.deepEqual(n1.bloquants.map((b) => b.regle), n2.bloquants.map((b) => b.regle));
  assert.equal(n1.parAxe.D.score, n2.parAxe.D.score);
  assert.equal(avec.bloquants.length, 0);
});

// Ce que Chromium dit quand il ne peut pas installer son bac à sable, sous chacune des formes que gwaudit reconnaît
// (`MOTIF_CAUSE_BAC_A_SABLE`) : chaque ligne ne contient QUE le signe qu'elle éprouve, pour que retirer ce signe seul
// de la reconnaissance fasse échouer son test — sans quoi un signe voisin le rattraperait. Chacune doit être nommée
// comme CETTE cause, avec ses deux issues, et non retomber dans l'échec générique : le conseil de déroger n'irait
// alors nulle part. (Le refus root, sous sa forme complète, est le test 1.)
const CAUSES_BAC_A_SABLE = [
  ['No usable sandbox', 'No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro that has disabled unprivileged user namespaces, update your setup', 'No usable sandbox'],
  ['Failed to move to new namespace', 'FATAL:namespace.cc(207)] Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted', 'Failed to move to new namespace'],
  ['sys_chroot', 'FATAL:credentials.cc(141)] Check failed: sys_chroot(): Operation not permitted (1)', 'sys_chroot'],
  ['Running as root without --no-sandbox', 'Running as root without --no-sandbox is not supported.', 'Running as root without --no-sandbox'],
  ['sandbox_host_linux', 'FATAL:sandbox_host_linux.cc(41)] Check failed: fd.is_valid()', 'sandbox_host_linux'],
  ['zygote_host_impl_linux', 'FATAL:zygote_host_impl_linux.cc(207)] Check failed: . : Invalid argument (22)', 'zygote_host_impl_linux'],
  ['setuid sandbox', 'The setuid sandbox is not running as root. Common causes: running in a container', 'setuid sandbox'],
  ['creating a user namespace', 'Failed creating a user namespace (Operation not permitted)', 'creating a user namespace'],
  ['CLONE_NEWUSER', 'clone(CLONE_NEWUSER) failed: Operation not permitted', 'CLONE_NEWUSER'],
  ['message générique de Playwright', 'Chromium sandboxing failed!', 'Chromium sandboxing failed'],
];
for (const [nom, ligne, extrait] of CAUSES_BAC_A_SABLE) {
  test(`un refus du bac à sable sous la forme « ${nom} » est nommé avec ses deux issues, pas rangé dans l'échec générique`, { skip: SOUS_WINDOWS && 'faux Chromium en script shell' }, async (t) => {
    const faux = fauxChromium(t, ligne);
    const { constats, nonExecute } = await auditAvec({ GWAUDIT_CHROMIUM_PATH: faux.exe, GWAUDIT_CHROMIUM_SANS_SANDBOX: undefined });
    assert.ok(faux.arguments(), 'le binaire doit avoir été lancé');
    assert.equal(nonExecute, true);
    const c = constats.find((x) => x.regle === 'D-INDISPONIBLE');
    assert.match(c.titre, /bac à sable/, `cette ligne n'a pas été reconnue comme un refus du bac à sable : ${c.titre} — ${c.constat}`);
    assert.ok(c.constat.includes(extrait), `la cause doit être citée : ${c.constat}`);
    assert.match(c.remediation, /\(2\)[^]*GWAUDIT_CHROMIUM_SANS_SANDBOX=1/);
  });
}

// La dérogation est EXPLICITE : la valeur 1 et rien d'autre. Toute autre valeur (0, true, oui…) ne doit pas
// suspendre le bac à sable — « non vide » ne veut pas dire « demandé ».
for (const valeur of ['0', 'true', 'oui', ' 1', '11']) {
  test(`GWAUDIT_CHROMIUM_SANS_SANDBOX=${JSON.stringify(valeur)} ne déroge pas : Chromium garde son bac à sable`, { skip: SOUS_WINDOWS && 'faux Chromium en script shell' }, async (t) => {
    const faux = fauxChromium(t, REFUS_ROOT);
    await auditAvec({ GWAUDIT_CHROMIUM_PATH: faux.exe, GWAUDIT_CHROMIUM_SANS_SANDBOX: valeur });
    const args = faux.arguments();
    assert.ok(args, 'le binaire doit avoir été lancé');
    assert.equal(args.includes('--no-sandbox'), false, `la valeur ${JSON.stringify(valeur)} n'est pas la dérogation : ${args.join(' ')}`);
  });
}

test("dérogation + échec de l'axe D APRÈS le lancement : le marqueur reste, le navigateur a bien tourné sans bac à sable", async () => {
  // `colonnes: null` fait échouer documentDeTest() une fois Chromium démarré : c'est la branche d'erreur générique
  // qui rend alors la main, et elle ne doit pas laisser tomber le marqueur posé au lancement.
  const { constats, nonExecute } = await auditAvec({ GWAUDIT_CHROMIUM_SANS_SANDBOX: '1' }, { scenario: { colonnes: null } });
  const echec = constats.find((c) => c.regle === 'D-INDISPONIBLE');
  assert.equal(nonExecute, true);
  assert.ok(echec, "l'axe D devait échouer");
  assert.match(echec.constat, /Cannot convert undefined or null to object/, `l'échec doit venir du scénario, après le lancement (sinon Chromium n'a pas démarré et ce test ne prouve rien) : ${echec.constat}`);
  assert.ok(constats.some((c) => c.regle === 'D-INDISPONIBLE-BAC-A-SABLE'), 'le marqueur de dérogation doit rester quand Chromium a démarré sans bac à sable, quelle que soit l\'issue');
});

test("sous dérogation, un échec de lancement n'est pas rangé parmi les refus du bac à sable : le conseil de déroger n'a pas de sens", { skip: SOUS_WINDOWS && 'faux Chromium en script shell' }, async (t) => {
  const faux = fauxChromium(t, REFUS_ROOT);
  const { constats, nonExecute } = await auditAvec({ GWAUDIT_CHROMIUM_PATH: faux.exe, GWAUDIT_CHROMIUM_SANS_SANDBOX: '1' });
  assert.ok(faux.arguments()?.includes('--no-sandbox'), 'la dérogation doit être en vigueur');
  assert.equal(nonExecute, true);
  const c = constats.find((x) => x.regle === 'D-INDISPONIBLE');
  assert.doesNotMatch(c.titre, /bac à sable/, "la dérogation est déjà posée : dire « Chromium ne peut pas démarrer avec son bac à sable » et conseiller de déroger serait faux");
  assert.doesNotMatch(c.remediation, /\(2\)[^]*Ou déroger explicitement/);
});

// ------------------------------------------------ vrai Chromium, bac à sable actif (sans dérogation)

/**
 * Un processus enfant sans dérogation. Sous root, Chromium ne démarre pas avec son bac à sable : l'enfant tourne alors
 * sous un utilisateur sans privilège (nobody) — ce que fait un vrai déploiement. Là où le bac à sable ne peut pas
 * démarrer du tout (espaces de noms utilisateur interdits), l'essai ne prouve rien : hors root il ÉCHOUE et le dit (c'est là que le bac à
 * sable doit démarrer, sur le poste d'un contributeur et dans la construction de l'image), sous root (un conteneur, qui interdit ces espaces de
 * noms plus souvent qu'il ne les laisse) il SAUTE en nommant la cause, et GWAUDIT_SUITE_SANS_CHROMIUM=1 le saute partout (saut explicite,
 * comme les autres essais qui lancent Chromium).
 */
function enfantAvecBacASable(t, args) {
  const travail = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-bas-'));
  t.after(() => fs.rmSync(travail, { recursive: true, force: true }));
  const env = { ...process.env, GWAUDIT_CHROMIUM_SANS_SANDBOX: '', GWAUDIT_CHROMIUM_SANDBOX: '', TMPDIR: travail, HOME: travail };
  delete env.NODE_EXTRA_CA_CERTS;
  const options = { encoding: 'utf8', timeout: 180_000, env, cwd: path.join(import.meta.dirname, '..') };
  if (process.getuid?.() === 0) { fs.chmodSync(travail, 0o777); options.uid = 65534; options.gid = 65534; }
  return { travail, r: spawnSync(process.execPath, typeof args === 'function' ? args(travail) : args, options) };
}

function bacASableImpossible(t, detail) {
  if (process.env.GWAUDIT_SUITE_SANS_CHROMIUM === '1') { t.skip(`Chromium ne démarre pas avec son bac à sable ici (GWAUDIT_SUITE_SANS_CHROMIUM=1) : ${detail}`); return true; }
  if (process.getuid?.() === 0) { t.skip(`Chromium ne démarre pas avec son bac à sable ici (exécution en root : un conteneur interdit souvent les espaces de noms utilisateur, même à un utilisateur sans privilège) : ${detail} — cet essai ne prouve rien sans lui ; hors root il échoue`); return true; }
  assert.fail(`Chromium ne démarre pas avec son bac à sable sur cette machine : ${detail} — ce test ne prouve rien sans lui. GWAUDIT_SUITE_SANS_CHROMIUM=1 le saute explicitement.`);
}

test("par défaut, avec un vrai Chromium et son bac à sable : l'axe D tourne et aucun marqueur de dérogation n'est posé", { skip: SOUS_WINDOWS && 'le job windows du workflow le vérifie (verifier-windows.mjs)' }, (t) => {
  const cli = path.join(import.meta.dirname, '..', 'bin', 'gwaudit.js');
  const fixture = path.join(import.meta.dirname, '..', 'fixtures', 'widget-exemple');
  const sortie = 'sortie';
  const { travail, r } = enfantAvecBacASable(t, (dossier) => [cli, fixture, '--json', '--sortie', path.join(dossier, sortie)]);
  const fichier = path.join(travail, sortie, 'rapport.json');
  assert.ok(r.status !== null && r.status <= 2 && fs.existsSync(fichier), `gwaudit a échoué (code ${r.status}) : ${(r.stderr ?? '').slice(-500)}`);
  const rapport = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  if (rapport.axesNonExecutes.includes('D')) return bacASableImpossible(t, rapport.axes.D.constats.find((c) => c.regle === 'D-INDISPONIBLE')?.constat ?? '(cause inconnue)');
  assert.equal(rapport.axes.D.constats.some((c) => c.regle === 'D-INDISPONIBLE-BAC-A-SABLE'), false, "aucune dérogation n'est posée : le rapport ne doit pas dire que le bac à sable a été retiré");
  const html = fs.readFileSync(path.join(travail, sortie, 'rapport.html'), 'utf8');
  assert.doesNotMatch(html, /sans le bac à sable de Chromium/);
});

test("par défaut, un échec de l'axe D APRÈS le lancement ne pose aucun marqueur de dérogation", { skip: SOUS_WINDOWS && 'le job windows du workflow le vérifie (verifier-windows.mjs)' }, (t) => {
  const { r } = enfantAvecBacASable(t, [path.join(import.meta.dirname, 'aide-audit-sans-derogation.mjs')]);
  assert.equal(r.status, 0, `le processus d'essai a échoué (code ${r.status}) : ${(r.stderr ?? '').slice(-500)}`);
  const { constats, nonExecute } = JSON.parse(r.stdout.trim().split('\n').pop());
  const echec = constats.find((c) => c.regle === 'D-INDISPONIBLE');
  assert.ok(nonExecute && echec, "l'axe D devait échouer");
  if (!/Cannot convert undefined or null to object/.test(echec.constat)) return bacASableImpossible(t, echec.constat);
  assert.equal(constats.some((c) => c.regle === 'D-INDISPONIBLE-BAC-A-SABLE'), false, "Chromium a démarré AVEC son bac à sable : aucun marqueur de dérogation ne doit être posé, même quand l'axe échoue ensuite");
});
