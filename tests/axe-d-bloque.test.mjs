import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { axeDNonExecute } from './aide-chromium.mjs';
import { resumerCauseErreur } from '../src/runtime/dynamique.js';

/**
 * Un axe D qui ne peut pas dire ce qu'il a mesuré, ou qu'un widget empêche de
 * mesurer, ne doit jamais faire mieux noter le widget que si l'axe avait tourné.
 *
 * Trois choses gardées ici :
 *  1. la CAUSE d'un axe non exécuté est dite (JSON, Markdown, HTML), pour toute
 *     cause — l'option, Chromium introuvable, un lancement qui échoue — et pas
 *     seulement la première ligne du message de Playwright ;
 *  2. un widget qui bloque le navigateur (au chargement, ou après) donne
 *     D-TIMEOUT-01, bloquant, au lieu de faire passer l'axe pour « non exécuté »
 *     — c'est le cas où bloquer la mesure rapportait plus que la laisser
 *     tourner ;
 *  3. ce qui avait été observé avant le blocage reste au rapport, et l'absence
 *     de constat n'est jamais écrite comme une mesure qui n'a pas eu lieu.
 *
 * Les délais sont raccourcis (GWAUDIT_DELAI_AXE_D_MS) : le délai de chargement
 * en est déduit (moins 15 s), soit 5 s ici contre 30 s par défaut.
 */
const RACINE = path.resolve(import.meta.dirname, '..');
const CLI = path.join(RACINE, 'bin', 'gwaudit.js');
const EXEMPLE = path.join(RACINE, 'fixtures', 'widget-exemple');
const SOUS_WINDOWS = process.platform === 'win32';
const RANG = { 'CONFORME': 0, 'CONFORME SOUS RÉSERVE': 1, 'NON CONFORME': 2 };

function dossierTemporaire(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-axe-d-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Un widget d'un seul fichier index.html. */
function widgetHtml(t, html) {
  const d = path.join(dossierTemporaire(t), 'widget');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'index.html'), html);
  return d;
}

/**
 * widget-exemple, avec un script de même origine ajouté en fin de page : sa CSP
 * (`default-src 'self'`) refuserait un script en ligne, qui ne s'exécuterait
 * jamais — le test ne prouverait rien.
 */
function exempleAvecScript(t, script) {
  const d = path.join(dossierTemporaire(t), 'widget');
  fs.cpSync(EXEMPLE, d, { recursive: true });
  fs.writeFileSync(path.join(d, 'ajout.js'), script);
  const fichier = path.join(d, 'index.html');
  const html = fs.readFileSync(fichier, 'utf8');
  assert.ok(html.includes('</body>'), "widget-exemple n'a plus de </body> : le test ne saurait où ajouter le script");
  fs.writeFileSync(fichier, html.replace('</body>', '<script src="ajout.js"></script></body>'));
  return d;
}

function auditer(t, widget, { args = [], env = {}, delaiAxeD = '20000' } = {}) {
  const sortie = path.join(dossierTemporaire(t), 'sortie');
  const debut = Date.now();
  const r = spawnSync(process.execPath, [CLI, widget, '--json', '--sortie', sortie, ...args], {
    encoding: 'utf8', timeout: 240_000,
    env: { ...process.env, GWAUDIT_DELAI_AXE_D_MS: delaiAxeD, ...env },
  });
  const duree = Date.now() - debut;
  assert.ok(r.status !== null && r.status <= 2, `gwaudit a échoué (code ${r.status}) : ${(r.stderr ?? '').slice(-600)}`);
  // Le code 1 est aussi celui d'un plantage de Node : sans rapport, ce n'est pas un verdict.
  assert.ok(fs.existsSync(path.join(sortie, 'rapport.json')), `aucun rapport écrit (code ${r.status}) : ${(r.stderr ?? '').slice(-600)}`);
  const lire = (nom) => fs.readFileSync(path.join(sortie, nom), 'utf8');
  return { rapport: JSON.parse(lire('rapport.json')), md: lire('rapport.md'), html: lire('rapport.html'), stderr: r.stderr, duree };
}

const constatsD = (rapport, regle) => rapport.axes.D.constats.filter((c) => c.regle === regle);

// ---------------------------------------------------------------- 1. la cause

test('resumerCauseErreur : la cause du navigateur, pas le message générique de Playwright ni la ligne de commande', () => {
  // Le format réel de Playwright (relevé sur un lancement qui échoue).
  const erreur = new Error([
    'browserType.launch: Target page, context or browser has been closed',
    'Browser logs:', '',
    '<launching> /opt/x/chrome --disable-foo --un-argument-tres-long',
    '<launched> pid=1234',
    '[1234:1234:0929/191000.1:FATAL:zygote_host_impl_linux.cc(132)] No usable sandbox! Update your kernel',
    '[pid=1234][err] error while loading shared libraries: libnss3.so: cannot open shared object file',
    'Call log:',
    '\u001b[2m  - <launching> /opt/x/chrome --disable-foo --un-argument-tres-long\u001b[22m',
    '\u001b[2m  - [pid=1234][err] error while loading shared libraries: libnss3.so: cannot open shared object file\u001b[22m',
    '\u001b[2m  - [pid=1234] <process did exit: exitCode=127, signal=null>\u001b[22m',
  ].join('\n'));
  const cause = resumerCauseErreur(erreur);
  assert.match(cause, /No usable sandbox/);
  assert.match(cause, /libnss3\.so/);
  assert.match(cause, /exitCode=127/);
  assert.doesNotMatch(cause, /un-argument-tres-long/, 'la ligne de commande ne dit rien de la cause');
  assert.doesNotMatch(cause, /\[1234:|\[pid=/, 'les préfixes de journal sont retirés');
  assert.equal(cause.split('libnss3.so').length - 1, 1, 'la même ligne, vue dans deux journaux, n\'est dite qu\'une fois');
});

test("resumerCauseErreur : Chromium absent garde le chemin et la consigne, sans le cadre", () => {
  const cause = resumerCauseErreur(new Error("browserType.launch: Executable doesn't exist at /x/chrome\n╔════╗\n║ Please run: npx playwright install ║\n╚════╝"));
  assert.match(cause, /Executable doesn't exist at \/x\/chrome/);
  assert.match(cause, /npx playwright install/);
  assert.doesNotMatch(cause, /[╔║╚═]/);
  assert.equal(resumerCauseErreur(new Error('')), 'erreur sans message');
});

test("--sans-dynamique : les trois rapports disent pourquoi l'axe D n'a pas tourné", (t) => {
  const { rapport, md, html } = auditer(t, EXEMPLE, { args: ['--sans-dynamique'] });
  assert.equal(rapport.axes.D.nonExecute, true);
  const c = constatsD(rapport, 'D-INDISPONIBLE-OPTION');
  assert.equal(c.length, 1, "le JSON doit porter la raison de l'axe non exécuté");
  assert.equal(c[0].severite, 'info');
  assert.equal(c[0].bloquant, false);
  assert.match(md, /voici pourquoi/);
  assert.match(md, /D-INDISPONIBLE-OPTION/);
  assert.match(html, /voici pourquoi/);
  assert.match(html, /D-INDISPONIBLE-OPTION/);
});

test("Chromium introuvable : la cause précise (le chemin) est dans le JSON, le Markdown et le HTML", (t) => {
  const absent = path.join(dossierTemporaire(t), 'aucun-chromium-ici', SOUS_WINDOWS ? 'chrome.exe' : 'chrome');
  const { rapport, md, html } = auditer(t, EXEMPLE, { env: { GWAUDIT_CHROMIUM_PATH: absent } });
  assert.equal(rapport.axes.D.nonExecute, true);
  const c = constatsD(rapport, 'D-INDISPONIBLE');
  assert.equal(c.length, 1);
  assert.match(c[0].constat, /aucun-chromium-ici/);
  for (const [nom, texte] of [['Markdown', md], ['HTML', html]]) {
    assert.match(texte, /voici pourquoi/, `${nom} : un axe non exécuté doit dire pourquoi`);
    assert.match(texte, /aucun-chromium-ici/, `${nom} : la cause doit y être`);
  }
});

function fauxChromium(t, sortieErreur) {
  const d = dossierTemporaire(t);
  const exe = path.join(d, 'faux-chromium');
  fs.writeFileSync(exe, `#!/bin/sh\necho '${sortieErreur}' >&2\nexit 127\n`, { mode: 0o755 });
  return exe;
}

test("un lancement de Chromium qui échoue : sa cause est dite partout, et l'avertissement de relance la cite", { skip: SOUS_WINDOWS && 'faux Chromium en script shell : sous Windows, le cas est couvert par « Chromium introuvable » ci-dessus' }, (t) => {
  const exe = fauxChromium(t, 'error while loading shared libraries: libnss3.so: cannot open shared object file');
  const { rapport, md, html, stderr } = auditer(t, EXEMPLE, { env: { GWAUDIT_CHROMIUM_PATH: exe } });
  const c = constatsD(rapport, 'D-INDISPONIBLE');
  assert.equal(c.length, 1);
  assert.match(c[0].constat, /libnss3\.so/, 'la cause réelle doit être citée, pas seulement « Target page, context or browser has been closed »');
  assert.doesNotMatch(c[0].remediation, /SANS_SANDBOX/, 'le conseil de dérogation est réservé à un refus du bac à sable');
  assert.match(md, /libnss3\.so/);
  assert.match(html, /libnss3\.so/);
  assert.match(stderr, /nouvel essai[^\n]*libnss3\.so/, "l'avertissement de relance doit citer la cause");
});

test("un refus du bac à sable (root) : la cause et les deux issues sont dans le JSON, le Markdown et le HTML — pas seulement « Axe non exécuté »", { skip: SOUS_WINDOWS && 'faux Chromium en script shell' }, (t) => {
  const exe = fauxChromium(t, 'Running as root without --no-sandbox is not supported. See https://crbug.com/638180.');
  // aide-chromium pose la dérogation pour toute la suite : ici c'est justement son absence qui est éprouvée.
  const { rapport, md, html } = auditer(t, EXEMPLE, { env: { GWAUDIT_CHROMIUM_PATH: exe, GWAUDIT_CHROMIUM_SANS_SANDBOX: '' } });
  assert.equal(rapport.axes.D.nonExecute, true);
  const c = constatsD(rapport, 'D-INDISPONIBLE');
  assert.equal(c.length, 1);
  assert.match(c[0].titre, /bac à sable/);
  for (const [nom, texte] of [['JSON', JSON.stringify(rapport)], ['Markdown', md], ['HTML', html]]) {
    assert.match(texte, /Running as root without --no-sandbox/, `${nom} : la cause doit y être`);
    assert.match(texte, /Deux issues/, `${nom} : les deux issues doivent y être`);
    assert.match(texte, /GWAUDIT_CHROMIUM_SANS_SANDBOX=1/, `${nom} : la dérogation explicite doit y être nommée`);
  }
});

// ------------------------------------------------ 2 et 3. le widget qui bloque

const BOUCLE = '<!doctype html><html lang="fr"><head><title>t</title></head><body><script>for(;;){}</script></body></html>\n';
const TEMOIN = '<!doctype html><html lang="fr"><head><title>t</title></head><body><script></script></body></html>\n';

test("widget qui boucle au chargement : D-TIMEOUT-01 bloquant, axe D partiel, jamais mieux noté que le même widget sans la boucle", (t) => {
  const temoin = auditer(t, widgetHtml(t, TEMOIN));
  if (temoin.rapport.axesNonExecutes.includes('D')) return axeDNonExecute(t, temoin.rapport.axes.D.constats);
  const boucle = auditer(t, widgetHtml(t, BOUCLE));

  assert.equal(boucle.rapport.axes.D.nonExecute, false, "le blocage n'est pas une panne de l'outil : l'axe D a tourné et a conclu");
  const [c] = constatsD(boucle.rapport, 'D-TIMEOUT-01');
  assert.ok(c, 'D-TIMEOUT-01 doit être émis (il ne l\'était jamais : le délai de chargement tombait avant le délai global)');
  assert.equal(c.bloquant, true);
  assert.equal(c.severite, 'critique');
  assert.equal(c.mesurePartielle, true);
  assert.equal(c.preuve.phase, 'chargement', "c'est le délai de chargement qui tombe, avant le délai global");
  assert.equal(c.preuve.delaiMs, 5000, 'le délai de chargement se déduit de GWAUDIT_DELAI_AXE_D_MS (20 s − 15 s)');
  assert.deepEqual(boucle.rapport.axesNonExecutes, []);
  assert.ok(boucle.rapport.axesPartiels.includes('D'));
  assert.equal(constatsD(boucle.rapport, 'D-INDISPONIBLE').length, 0, "pas de « D-INDISPONIBLE » : la mesure a été tentée et empêchée par le widget");

  // L'invariant : empêcher la mesure ne rapporte rien.
  assert.ok(RANG[boucle.rapport.verdict] >= RANG[temoin.rapport.verdict], `verdict : ${boucle.rapport.verdict} contre ${temoin.rapport.verdict} pour le même widget sans la boucle`);
  assert.ok(boucle.rapport.scoreGlobal <= temoin.rapport.scoreGlobal, `score : ${boucle.rapport.scoreGlobal} contre ${temoin.rapport.scoreGlobal} pour le même widget sans la boucle`);

  // Une mesure qui n'a pas eu lieu ne s'écrit pas comme une absence de constat.
  assert.equal(constatsD(boucle.rapport, 'D-RESEAU-00').length, 0, "« aucune requête observée pendant le scénario joué » est faux : le scénario n'a pas été joué");
  assert.ok(boucle.rapport.axes.F.constats.some((x) => x.regle === 'D-RGAA-INDISPONIBLE'), "l'accessibilité rendue n'a pas été mesurée : le rapport doit le dire");
  assert.ok(boucle.rapport.axesPartiels.includes('F'));
  assert.match(boucle.html, /D-TIMEOUT-01/);
  assert.match(boucle.md, /D-TIMEOUT-01/);
  assert.ok(boucle.duree < 90_000, `l'audit doit conclure de lui-même (${boucle.duree} ms)`);
});

test("widget conforme + une boucle : de CONFORME à NON CONFORME, jamais l'inverse", (t) => {
  const sain = auditer(t, EXEMPLE);
  if (sain.rapport.axesNonExecutes.includes('D')) return axeDNonExecute(t, sain.rapport.axes.D.constats);
  const bloque = auditer(t, exempleAvecScript(t, 'for(;;){}'));
  assert.ok(RANG[bloque.rapport.verdict] >= RANG[sain.rapport.verdict], `${bloque.rapport.verdict} contre ${sain.rapport.verdict}`);
  assert.equal(bloque.rapport.verdict, 'NON CONFORME');
  assert.ok(bloque.rapport.scoreGlobal <= sain.rapport.scoreGlobal);
  assert.ok(constatsD(bloque.rapport, 'D-TIMEOUT-01')[0]?.bloquant);
});

test('ce qui a été observé avant le blocage reste au rapport', (t) => {
  // Sans CSP : la requête doit réellement partir (celle de widget-exemple l'interdirait).
  // La boucle ne démarre qu'après 300 ms : une requête émise dans la même tâche
  // que la boucle n'est jamais vue de Playwright (il attend, pour la rejouer à
  // l'audit, un événement du moteur de rendu, que la boucle empêche) — ce cas-là
  // n'est rattrapé que par D-TIMEOUT-01 lui-même, bloquant, et le test suivant.
  const widget = widgetHtml(t, '<!doctype html><html lang="fr"><head><title>t</title></head><body><script>fetch("https://collecte.exemple.invalid/x");setTimeout(()=>{for(;;){}},300)</script></body></html>\n');
  const { rapport, md } = auditer(t, widget);
  if (rapport.axesNonExecutes.includes('D')) return axeDNonExecute(t, rapport.axes.D.constats);
  assert.equal(constatsD(rapport, 'D-TIMEOUT-01').length, 1, 'le blocage est dit');
  const reseau = constatsD(rapport, 'D-RESEAU-01');
  assert.ok(reseau.length >= 1, 'la requête émise avant la boucle doit rester dans le rapport (D-RESEAU-01)');
  assert.match(reseau[0].constat, /collecte\.exemple\.invalid/);
  assert.ok(constatsD(rapport, 'D-TIMEOUT-01')[0].preuve.observeAvantBlocage.requetesTierces >= 1);
  assert.match(md, /collecte\.exemple\.invalid/);
});

test('une requête émise dans la même tâche que la boucle échappe à la mesure : seul le blocage la rattrape, et il rend NON CONFORME', (t) => {
  const { rapport } = auditer(t, widgetHtml(t, '<!doctype html><html lang="fr"><head><title>t</title></head><body><script>fetch("https://collecte.exemple.invalid/x");for(;;){}</script></body></html>\n'));
  if (rapport.axesNonExecutes.includes('D')) return axeDNonExecute(t, rapport.axes.D.constats);
  assert.equal(constatsD(rapport, 'D-RESEAU-01').length, 0, "si un jour la requête est vue, ce test doit changer : c'est une amélioration, pas une régression");
  assert.equal(rapport.verdict, 'NON CONFORME');
  assert.ok(constatsD(rapport, 'D-TIMEOUT-01')[0]?.bloquant);
});

test("widget qui se bloque après le chargement : même constat, par le délai global", (t) => {
  const widget = widgetHtml(t, '<!doctype html><html lang="fr"><head><title>t</title></head><body><script>addEventListener("load",()=>setTimeout(()=>{for(;;){}},500))</script></body></html>\n');
  const { rapport } = auditer(t, widget);
  if (rapport.axesNonExecutes.includes('D')) return axeDNonExecute(t, rapport.axes.D.constats);
  const [c] = constatsD(rapport, 'D-TIMEOUT-01');
  assert.ok(c, 'D-TIMEOUT-01 doit être émis aussi pour un blocage après le chargement');
  assert.equal(c.bloquant, true);
  assert.equal(c.preuve.phase, 'scenario');
});
