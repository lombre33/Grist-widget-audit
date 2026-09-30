/**
 * Le moteur de mutants (`scripts/lib/rejouer-mutants.mjs`) : ce qu'il compte
 * comme un mutant tué. Un mutant tué par un délai ou par un plantage n'est pas
 * un mutant tué par un test, et le moteur le disait pourtant tué : `node --test`
 * intercepte SIGTERM et sort en 1, si bien que `status === null` ne reconnaît
 * jamais le délai (Node 22.22.2 : code 1, signal null, `error.code`
 * ETIMEDOUT, aucun résumé imprimé).
 *
 * Ce fichier : `classerLancement` sur des résultats de `spawnSync` écrits à la
 * main (chaque branche), et la lecture des arguments. Les autres fichiers
 * `rejouer-mutants-*.test.mjs` éprouvent les processus et le moteur entier ;
 * chaque comportement a son mutant : `scripts/mutants-rejouer.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DELAI_MS, RACINE, classerLancement, lireArguments } from '../scripts/lib/rejouer-mutants.mjs';
import { tap } from './aide-moteur-mutants.mjs';

const FICHIERS = ['tests/f.test.mjs'];
const classe = (r, fichiers = FICHIERS) => classerLancement({ signal: null, error: null, ...r }, fichiers);

test('classerLancement : code 0 et résumé lu, la suite passe', () => {
  const b = classe({ status: 0, stdout: tap({ ok: ['a', 'b', 'c'] }) });
  assert.equal(b.verdict, 'passe');
  assert.deepEqual([b.lances, b.echecs, b.saute], [3, 0, 0]);
});

test('classerLancement : le compte des tests sautés est lu (la suite non mutée doit en avoir 0)', () => {
  assert.equal(classe({ status: 0, stdout: tap({ ok: ['a'], sautes: 2 }) }).saute, 2);
});

test('classerLancement : les comptes de plus d\'un chiffre sont lus en entier', () => {
  const b = classe({ status: 1, stdout: tap({ ok: Array.from({ length: 12 }, (_, i) => `t${i}`), pasOk: Array.from({ length: 11 }, (_, i) => `e${i}`), sautes: 10 }) });
  assert.deepEqual([b.lances, b.echecs, b.saute], [23, 11, 10]);
});

test('classerLancement : un test nommé en échec, code 1 et résumé lu, tue par un test', () => {
  const b = classe({ status: 1, stdout: tap({ ok: ['a'], pasOk: ['b échoue', 'c échoue'] }) });
  assert.equal(b.verdict, 'test');
  assert.deepEqual(b.tueurs, ['b échoue', 'c échoue']);
  assert.equal(b.echecs, 2);
  assert.deepEqual(b.fichiersEnEchec, []);
});

test('classerLancement : un sous-test en échec (ligne indentée) est un test nommé, avec le parent qui échoue à sa suite', () => {
  const b = classe({ status: 1, stdout: tap({ sousTests: ['le sous-test'], pasOk: ['le parent'] }) });
  assert.equal(b.verdict, 'test');
  assert.deepEqual(b.tueurs, ['le sous-test', 'le parent']);
});

test('classerLancement : le même test nommé deux fois est compté une fois dans ses noms', () => {
  assert.deepEqual(classe({ status: 1, stdout: tap({ pasOk: ['b', 'b'] }) }).tueurs, ['b']);
});

test('classerLancement : un fichier de test entier en échec, sans test nommé, est un plantage', () => {
  const b = classe({ status: 1, stdout: tap({ pasOk: ['tests/f.test.mjs'] }) });
  assert.equal(b.verdict, 'plantage');
  assert.match(b.raison, /seuls des fichiers de test entiers échouent \(tests\/f\.test\.mjs\), aucun test nommé/);
  assert.deepEqual(b.tueurs, []);
});

test('classerLancement : plusieurs fichiers entiers en échec sont tous dits, séparés par une virgule', () => {
  const b = classe({ status: 1, stdout: tap({ pasOk: ['tests/f.test.mjs', 'tests/g.test.mjs'] }) }, ['tests/f.test.mjs', 'tests/g.test.mjs']);
  assert.equal(b.verdict, 'plantage');
  assert.match(b.raison, /\(tests\/f\.test\.mjs, tests\/g\.test\.mjs\)/);
});

test('classerLancement : une sortie aux fins de ligne Windows (\\r\\n) se lit de même : les noms n\'ont pas de \\r, les fichiers sont reconnus', () => {
  const b = classe({ status: 1, stdout: tap({ pasOk: ['un test', 'tests/f.test.mjs'] }).replace(/\n/g, '\r\n') });
  assert.equal(b.verdict, 'test');
  assert.deepEqual(b.tueurs, ['un test']);
  assert.deepEqual(b.fichiersEnEchec, ['tests/f.test.mjs']);
  assert.deepEqual([b.lances, b.echecs], [2, 2]);
});

test('classerLancement : un fichier reconnu par le chemin qui le finit (chemin absolu) n\'est pas un test nommé', () => {
  const b = classe({ status: 1, stdout: tap({ pasOk: ['/tmp/gwaudit-mutants-x/tests/f.test.mjs'] }) });
  assert.equal(b.verdict, 'plantage');
  assert.deepEqual(b.fichiersEnEchec, ['/tmp/gwaudit-mutants-x/tests/f.test.mjs']);
});

test('classerLancement : un test nommé qui n\'a que la fin du nom d\'un fichier n\'est pas ce fichier', () => {
  const b = classe({ status: 1, stdout: tap({ pasOk: ['reste tests/f.test.mjs'] }) });
  assert.equal(b.verdict, 'test');
  assert.deepEqual(b.tueurs, ['reste tests/f.test.mjs']);
});

test('classerLancement : un test nommé ET son fichier en échec tue par un test, le fichier est dit à part', () => {
  const b = classe({ status: 1, stdout: tap({ pasOk: ['un test', 'tests/f.test.mjs'] }) });
  assert.equal(b.verdict, 'test');
  assert.deepEqual(b.tueurs, ['un test']);
  assert.deepEqual(b.fichiersEnEchec, ['tests/f.test.mjs']);
});

test('classerLancement : le délai (ETIMEDOUT), avec le code 1 que node --test rend quand il intercepte SIGTERM, est un délai', () => {
  const b = classe({ status: 1, error: { code: 'ETIMEDOUT' }, stdout: 'TAP version 13\n' });
  assert.equal(b.verdict, 'delai');
  assert.ok(Number.isNaN(b.echecs), 'aucun résumé imprimé : ce n\'est pas un échec de test');
});

test('classerLancement : le délai l\'emporte sur ce que la sortie contient (un test déjà en échec avant le délai ne tue pas)', () => {
  const b = classe({ status: 1, error: { code: 'ETIMEDOUT' }, stdout: tap({ pasOk: ['un test'] }) });
  assert.equal(b.verdict, 'delai');
});

test('classerLancement : un lanceur tué par un signal autre que le délai est un plantage, avec le signal', () => {
  const b = classe({ status: null, signal: 'SIGKILL', stdout: '' });
  assert.equal(b.verdict, 'plantage');
  assert.match(b.raison, /tué par SIGKILL/);
});

test('classerLancement : un code de sortie autre que 0 et 1 est un plantage, avec le code', () => {
  for (const status of [2, 3, 134, 137]) {
    const b = classe({ status, stdout: tap({ pasOk: ['un test'] }) });
    assert.equal(b.verdict, 'plantage', `code ${status}`);
    assert.match(b.raison, new RegExp(`sorti avec le code ${status}`));
  }
});

test('classerLancement : le code 1 sans résumé imprimé est un plantage', () => {
  const b = classe({ status: 1, stdout: tap({ pasOk: ['un test'], sansResume: true }) });
  assert.equal(b.verdict, 'plantage');
  assert.match(b.raison, /pas imprimé son résumé/);
});

test('classerLancement : le code 1 sans aucun test en échec est un plantage', () => {
  const b = classe({ status: 1, stdout: tap({ ok: ['a'] }) });
  assert.equal(b.verdict, 'plantage');
  assert.match(b.raison, /aucun test en échec/);
});

test('classerLancement : une erreur de lancement (ENOBUFS, ENOENT) est un plantage, avec son code', () => {
  for (const code of ['ENOBUFS', 'ENOENT']) {
    const b = classe({ status: null, error: { code, message: `spawnSync node ${code}` }, stdout: '' });
    assert.equal(b.verdict, 'plantage', code);
    assert.match(b.raison, new RegExp(`le lancement a échoué : ${code}`));
  }
});

test('classerLancement : une erreur de lancement sans code est dite par son message', () => {
  const b = classe({ status: null, error: { message: 'spawn cassé' }, stdout: '' });
  assert.match(b.raison, /le lancement a échoué : spawn cassé/);
});

test('classerLancement : une sortie absente (null) se lit comme vide', () => {
  assert.equal(classe({ status: 1, stdout: null }).verdict, 'plantage');
});

// La lecture des arguments ------------------------------------------------------------------------------------------

test('lireArguments : --part=i/n est lu, les autres arguments sont rendus tels quels et dans l\'ordre', () => {
  assert.deepEqual(lireArguments(['a', '--part=2/3', 'b c']), { partie: { i: 2, n: 3 }, valider: false, restants: ['a', 'b c'] });
  assert.deepEqual(lireArguments([]), { partie: null, valider: false, restants: [] });
  assert.deepEqual(lireArguments(['--part=1/1']), { partie: { i: 1, n: 1 }, valider: false, restants: [] });
  assert.deepEqual(lireArguments(['--part=12/34']).partie, { i: 12, n: 34 }, 'plusieurs chiffres');
});

test('lireArguments : i hors de 1 à n est refusé, les bornes sont permises', () => {
  for (const argument of ['--part=0/3', '--part=4/3', '--part=2/1']) assert.throws(() => lireArguments([argument]), /doit être entre 1 et n/, argument);
  assert.equal(lireArguments(['--part=3/3']).partie.i, 3);
});

test('lireArguments : ce qui ne ressemble pas à --part=i/n est un argument comme un autre', () => {
  for (const argument of ['--part=a/3', '--part=1/', '--part=1-3', '--partie=1/3', 'x--part=1/3', '--part=1/3x']) {
    const r = lireArguments([argument]);
    assert.equal(r.partie, null, argument);
    assert.deepEqual(r.restants, [argument]);
  }
});

// Les constantes que les lots supposent --------------------------------------------------------------------------------

test('le délai par défaut d\'une suite est de dix minutes', () => {
  assert.equal(DELAI_MS, 10 * 60 * 1000);
});

test('RACINE est la racine du dépôt (celle qui contient ce moteur)', () => {
  assert.ok(fs.existsSync(path.join(RACINE, 'scripts', 'lib', 'rejouer-mutants.mjs')));
  assert.ok(fs.existsSync(path.join(RACINE, 'package.json')));
});
