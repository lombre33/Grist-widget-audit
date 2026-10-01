/**
 * La ligne de commande devant une analyse qui ne finit pas (bin/gwaudit.js, src/isolement) : le rapport de
 * repli sort, avec le verdict NON CONFORME et le code de sortie 2 (jamais 3), et seule une panne de l'outil
 * lui-même (le processus d'analyse qui ne démarre pas) donne 3.
 *
 * La mort est provoquée par un tas d'enfant de 64 Mio (GWAUDIT_MEMOIRE_ANALYSE_MO) et 1,1 Mio de code
 * synthétique : quelle que soit la machine, l'inventaire de ce code dépasse ce tas (mesuré : 0,5 Mio passe, 0,65
 * Mio ne passe pas). La mort en cours de règles, et l'axe D joué sur un contexte sorti avant la fin, sont
 * éprouvés à part (tests/isolement-axe-d.test.mjs) : aucune charge ne permet ici de les provoquer sans
 * dépendre de la vitesse de la machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codeSynthetique } from '../scripts/lib/code-synthetique.mjs';

const RACINE = path.resolve(import.meta.dirname, '..');
const CLI = path.join(RACINE, 'bin', 'gwaudit.js');
const EXEMPLE = path.join(RACINE, 'fixtures', 'widget-exemple');
const LIGNE_DE_COMMANDE = ['--sans-reseau', '--json'];

function widgetLourd(t) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-cli-isolement-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const d = path.join(dossier, 'widget');
  fs.cpSync(EXEMPLE, d, { recursive: true });
  fs.writeFileSync(path.join(d, 'gros.js'), codeSynthetique(1_100_000, 7));
  const page = path.join(d, 'index.html');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('</body>', '<script src="gros.js"></script></body>'));
  return { d, sortie: path.join(dossier, 'sortie') };
}

/** Les constats d'un rapport JSON : ils sont rangés par axe. */
const constatsDe = (json) => Object.values(json.axes).flatMap((a) => a.constats);

function auditer(cible, sortie, options, env = {}) {
  const r = spawnSync(process.execPath, [CLI, cible, ...options, '--sortie', sortie], {
    encoding: 'utf8', timeout: 240_000, env: { ...process.env, ...env },
  });
  const json = fs.existsSync(path.join(sortie, 'rapport.json')) ? JSON.parse(fs.readFileSync(path.join(sortie, 'rapport.json'), 'utf8')) : null;
  return { ...r, json, md: fs.existsSync(path.join(sortie, 'rapport.md')) ? fs.readFileSync(path.join(sortie, 'rapport.md'), 'utf8') : null };
}

test('un tas d\'enfant épuisé pendant l\'inventaire : rapport de repli, NON CONFORME, code 2, axes A B C E F à 0, jamais 3', { timeout: 300_000 }, (t) => {
  const { d, sortie } = widgetLourd(t);
  const r = auditer(d, sortie, [...LIGNE_DE_COMMANDE, '--sans-dynamique'], { GWAUDIT_MEMOIRE_ANALYSE_MO: '64' });
  assert.equal(r.status, 2, `code de sortie ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /L'analyse du code s'est interrompue : mémoire épuisée.*64 Mio/);
  assert.equal(r.json.verdict, 'NON CONFORME');
  const c = constatsDe(r.json).filter((x) => x.regle === 'C-SURFACE-03');
  assert.equal(c.length, 1);
  assert.equal(c[0].bloquant, true);
  assert.equal(c[0].severite, 'critique');
  assert.equal(c[0].preuve.cause, 'interruption');
  assert.equal(c[0].preuve.genre, 'tas');
  assert.equal(c[0].preuve.etape, 'inventaire');
  assert.deepEqual(c[0].axesEmpeches, ['A', 'B', 'C', 'E', 'F']);
  for (const axe of ['A', 'B', 'C', 'E', 'F']) {
    assert.equal(r.json.axes[axe].score, 0, `axe ${axe}`);
    assert.equal(r.json.axes[axe].empeche, true, `axe ${axe}`);
  }
  assert.match(r.md, /s'est interrompue avant la fin/);
});

test('sans l\'option --sans-dynamique : l\'inventaire n\'a pas eu lieu, l\'axe D dit pourquoi il n\'a rien ouvert (D-INDISPONIBLE), hors du calcul', { timeout: 300_000 }, (t) => {
  const { d, sortie } = widgetLourd(t);
  const r = auditer(d, sortie, LIGNE_DE_COMMANDE, { GWAUDIT_MEMOIRE_ANALYSE_MO: '64' });
  assert.equal(r.status, 2, r.stderr);
  const dispo = constatsDe(r.json).filter((x) => x.regle === 'D-INDISPONIBLE');
  assert.equal(dispo.length, 1);
  assert.match(dispo[0].constat, /avant la fin de l'inventaire/);
  assert.equal(r.json.axes.D.nonExecute, true);
  assert.equal(r.json.axes.D.score, null);
});

test('le même widget avec le tas par défaut de Node n\'est pas interrompu : c\'est la limite, pas le widget, qui a coupé', { timeout: 300_000 }, (t) => {
  const { d, sortie } = widgetLourd(t);
  const r = auditer(d, sortie, [...LIGNE_DE_COMMANDE, '--sans-dynamique']);
  assert.notEqual(r.status, 3, r.stderr);
  assert.equal(constatsDe(r.json).filter((x) => x.regle === 'C-SURFACE-03' && x.preuve?.cause === 'interruption').length, 0);
  for (const axe of ['A', 'B', 'C', 'E', 'F']) assert.notEqual(r.json.axes[axe].empeche, true, `axe ${axe}`);
});

test('le processus d\'analyse qui ne peut pas démarrer (pile demandée impossible) : sortie 3, message d\'erreur de l\'outil, aucun rapport de repli', { skip: process.platform === 'win32' && 'la pile demandée ne fait pas échouer le démarrage partout', timeout: 120_000 }, (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-cli-isolement-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const r = auditer(EXEMPLE, path.join(dossier, 'sortie'), [...LIGNE_DE_COMMANDE, '--sans-dynamique'], { GWAUDIT_PILE_ANALYSE_MO: '99999999' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /Erreur : le processus d'analyse s'est arrêté avant de commencer/);
  assert.equal(r.json, null, 'aucun rapport : ce n\'est pas le widget');
});

test('une variable de limite invalide est dite et l\'audit se fait comme sans elle', { timeout: 120_000 }, (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-cli-isolement-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const r = auditer(EXEMPLE, path.join(dossier, 'sortie'), [...LIGNE_DE_COMMANDE, '--sans-dynamique'], { GWAUDIT_MEMOIRE_ANALYSE_MO: 'beaucoup', GWAUDIT_DELAI_ANALYSE_S: '0' });
  assert.match(r.stderr, /GWAUDIT_MEMOIRE_ANALYSE_MO="beaucoup" ignorée/);
  assert.match(r.stderr, /GWAUDIT_DELAI_ANALYSE_S="0" ignorée/);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.axes.A.empeche, undefined);
});

// Le piège relevé par la coordination (Règles) sur 0c741ce : un app.js fait de « x=>{ » répété puis d'autant de « } » sortait en 134 avec
// « FATAL ERROR: RegExpCompiler Allocation failed - process out of memory », sans rapport (2,4 Ko à 440 niveaux) : le rattrapage de pile d'acorn
// compilait une expression régulière au bord de la pile, et V8 n'avait plus la place de le faire. Avec L2 seul, l'enfant contenait cet abandon (rapport
// de repli, cause « pile » : 12 fois sur 12 sur la page minimale de cet essai, mesuré avant b3d12ba). b3d12ba (Règles) le ferme à la source : la lecture
// rattrape le dépassement de pile sans expression régulière (`LecteurAcorn`, src/moteur/analyse-js.js), le code est dit trop imbriqué (C-SURFACE-03,
// cause « profondeur », critique bloquant) et V8 n'abandonne plus. Cet essai garde, dans le régime de l'enfant (un Worker à pile de 4 Mio), que le
// piège ne tue plus l'audit : trois lancements, chacun dans un processus neuf, aucun abandon, aucun repli, le même constat. Le classement de l'abandon de V8
// en cause « pile », pour le jour où V8 abandonnerait ainsi ailleurs, est éprouvé par un enfant factice : tests/isolement-enfant.test.mjs.
// 20 000 niveaux : le nombre que Règles a mesuré dans le Worker (7 abandons sur 10 avant b3d12ba, 0 sur 10 après).
const NIVEAUX_DU_PIEGE = 20_000;
const LANCEMENTS_DU_PIEGE = 3;

test(`le piège des « x=>{ » imbriqués (${NIVEAUX_DU_PIEGE} niveaux) : l'enfant lit la pile qui déborde et la dit, V8 n'abandonne plus, code 2, cause « profondeur »`, { timeout: 300_000, skip: process.platform !== 'linux' && 'la pile du Worker et les codes de signal sont ceux de Linux' }, (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-cli-piege-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const d = path.join(dossier, 'widget');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Pile pleine</title></head><body><main><h1>Pile pleine</h1></main><script src="piege.js"></script></body></html>\n');
  fs.writeFileSync(path.join(d, 'piege.js'), 'x=>{'.repeat(NIVEAUX_DU_PIEGE) + '}'.repeat(NIVEAUX_DU_PIEGE));
  for (let essai = 1; essai <= LANCEMENTS_DU_PIEGE; essai++) {
    const r = auditer(d, path.join(dossier, `sortie-${essai}`), [...LIGNE_DE_COMMANDE, '--sans-dynamique']);
    const ou = `lancement ${essai}/${LANCEMENTS_DU_PIEGE} : code ${r.status}, signal ${r.signal}\n${r.stderr.slice(-800)}`;
    assert.doesNotMatch(r.stderr, /FATAL ERROR/, `V8 a abandonné : la lecture ne rattrape plus le dépassement de pile sans expression régulière (${ou})`);
    assert.doesNotMatch(r.stderr, /L'analyse du code s'est interrompue/, `l'enfant n'a pas rendu son résultat : un repli, non la profondeur dite par l'audit (${ou})`);
    assert.equal(r.status, 2, ou);
    assert.ok(r.json, `aucun rapport JSON (${ou})`);
    assert.equal(r.json.verdict, 'NON CONFORME', ou);
    const c = constatsDe(r.json).filter((x) => x.regle === 'C-SURFACE-03');
    assert.equal(c.length, 1, ou);
    assert.equal(c[0].bloquant, true);
    assert.equal(c[0].severite, 'critique');
    assert.equal(c[0].preuve.cause, 'profondeur', `la pile qui déborde est dite telle quelle : ${JSON.stringify(c[0].preuve)}`);
  }
});
