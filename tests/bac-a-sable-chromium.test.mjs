import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

async function auditAvec(env) {
  const avant = {};
  for (const [k, v] of Object.entries(env)) { avant[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    const ctx = construireContexte(path.join(import.meta.dirname, '..', 'fixtures', 'widget-exemple'));
    return await auditDynamique(ctx, {});
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
  assert.equal(n1.scoreGlobal, n2.scoreGlobal);
  assert.deepEqual(n1.bloquants.map((b) => b.regle), n2.bloquants.map((b) => b.regle));
  assert.equal(n1.parAxe.D.score, n2.parAxe.D.score);
  assert.equal(avec.bloquants.length, 0);
});
