/**
 * Une pile qui déborde pendant la lecture d'acorn ne fait jamais abandonner le processus. `catchStackOverflow` d'acorn (8.18) enveloppe
 * chaque `parseExpression` et, sur une erreur, en teste le message par une expression régulière : quand la pile déborde, le cadre le
 * plus profond qui la rattrape la compile à cet instant, au bord de la pile, et V8 abandonne le processus (« RegExpCompiler Allocation
 * failed », code 134, aucun rapport, aucun `try` n'y peut rien). Deux Kio de `a[` répétés mille fois suffisaient, un widget hostile
 * tuait l'auditeur. `LecteurAcorn` rattrape la pile sans expression régulière et la dit comme acorn la dit quand il le peut : l'erreur de
 * syntaxe « Not enough stack space to parse input », que `lire` classe en `profondeur` (C-SURFACE-03, critique bloquant).
 *
 * Deux sortes d'essais. Dans le processus : ce que le rattrapage fait de chaque erreur (il ne prend pour une pile que le `RangeError` de V8
 * qui le dit, et laisse passer tout le reste tel quel), sans dépendre de la pile de la machine. Dans un processus neuf par lecture : le code
 * réellement trop profond, là où l'abandon avait lieu (ni compilateur JIT chauffé ni expression régulière déjà compilée : c'est l'état
 * où V8 abandonnait à coup sûr). Chaque essai a son mutant dans `scripts/mutants-lecture-qui-leve.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LecteurAcorn, estPileDeV8, depassementDePile } from '../src/moteur/analyse-js.js';
import { fichierProfond } from '../scripts/rejouer-fichier-profond.mjs';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.join(ICI, '..', 'src', 'moteur', 'analyse-js.js')).href;

test('estPileDeV8 : le RangeError que V8 lève quand la pile déborde, et rien d\'autre', () => {
  // Le vrai : une récursion sans fin dans ce processus, rattrapée ici, dit ce que V8 dit dans cette version de Node.
  const reel = (() => { const f = () => f() + 1; try { f(); } catch (e) { return e; } return null; })();
  assert.ok(reel instanceof RangeError, `V8 lève un RangeError (${reel})`);
  assert.equal(estPileDeV8(reel), true, `le message de V8 (« ${reel?.message} ») dit la pile`);
  assert.equal(depassementDePile(reel), true, 'et la classification de la lecture le dit aussi');
  assert.equal(estPileDeV8(new RangeError('Maximum call stack size exceeded')), true);
  for (const [nom, e] of [
    ['un autre RangeError', new RangeError('Invalid array length')],
    ['la même phrase dans une Error ordinaire', new Error('Maximum call stack size exceeded')],
    ['une erreur de syntaxe qui cite le texte du widget (le motif d\'une expression régulière invalide)', new SyntaxError('Invalid regular expression: /(call stack/: Unterminated group')],
    ['une chaîne', 'Maximum call stack size exceeded'],
    ['null', null],
    ['undefined', undefined],
  ]) assert.equal(estPileDeV8(e), false, nom);
});

const PILE = () => { throw new RangeError('Maximum call stack size exceeded'); };
const levee = (f) => { try { f(); } catch (e) { return e; } return null; };

test('le lecteur : un dépassement de pile devient l\'erreur de syntaxe « Not enough stack space to parse input », celle d\'acorn quand il la dit lui-même', () => {
  const lecteur = new LecteurAcorn({ ecmaVersion: 'latest', locations: true }, '\n\n  a + b');
  lecteur.nextToken();
  const erreur = levee(() => lecteur.catchStackOverflow(PILE));
  const celleDAcorn = levee(() => lecteur.raise(lecteur.start, 'Not enough stack space to parse input'));
  assert.ok(erreur instanceof SyntaxError, 'une erreur de syntaxe, comme celle d\'acorn');
  assert.equal(erreur.message, 'Not enough stack space to parse input (3:2)', 'avec la ligne et la colonne du jeton courant, comme acorn les dit');
  assert.equal(depassementDePile(erreur), true, 'que la lecture classe en profondeur');
  assert.equal(erreur.pos, 4, 'la position du jeton courant (deux retours à la ligne et deux espaces avant `a`)');
  assert.deepEqual({ ligne: erreur.loc.line, colonne: erreur.loc.column }, { ligne: 3, colonne: 2 });
  assert.equal(erreur.raisedAt, 5, 'et où la lecture en était (après `a`)');
  assert.ok(celleDAcorn instanceof SyntaxError, 'prémisse : acorn lève bien une erreur de syntaxe quand il la dit lui-même');
  assert.deepEqual(
    { message: erreur.message, pos: erreur.pos, loc: { ...erreur.loc }, raisedAt: erreur.raisedAt },
    { message: celleDAcorn.message, pos: celleDAcorn.pos, loc: { ...celleDAcorn.loc }, raisedAt: celleDAcorn.raisedAt },
    'la même erreur, champ pour champ, que celle que `raise` aurait levée',
  );
});

test('le lecteur : sans les positions demandées, le dépassement de pile est dit quand même, sans ligne ni colonne', () => {
  const lecteur = new LecteurAcorn({ ecmaVersion: 'latest' }, 'a + b');
  lecteur.nextToken();
  const erreur = levee(() => lecteur.catchStackOverflow(PILE));
  assert.ok(erreur instanceof SyntaxError, `une erreur de syntaxe, non ${erreur}`);
  assert.equal(erreur.message, 'Not enough stack space to parse input');
  assert.equal(erreur.loc, undefined);
  assert.equal(erreur.pos, 0);
  assert.equal(depassementDePile(erreur), true);
});

test('le lecteur : toute autre erreur passe telle quelle, et une fonction qui réussit rend sa valeur', () => {
  const lecteur = new LecteurAcorn({ ecmaVersion: 'latest', locations: true }, 'a + b');
  lecteur.nextToken();
  const dejaDite = levee(() => lecteur.catchStackOverflow(PILE));
  const autres = [
    ['une erreur de l\'outil', new TypeError('Cannot read properties of undefined (reading \'type\')')],
    ['un RangeError qui n\'est pas une pile', new RangeError('Invalid array length')],
    ['l\'erreur de syntaxe d\'acorn', levee(() => lecteur.raise(0, 'Unexpected token'))],
    ['l\'erreur de pile déjà dite par un cadre plus profond (les cadres plus hauts ne la disent pas une seconde fois, ailleurs)', dejaDite],
  ];
  for (const [nom, e] of autres) {
    const passee = levee(() => lecteur.catchStackOverflow(() => { throw e; }));
    assert.ok(passee === e, `${nom} : la même erreur, non une autre`);
  }
  assert.equal(lecteur.catchStackOverflow(() => 42), 42);
  assert.equal(autres[2][1].pos, 0, 'l\'erreur d\'acorn garde sa position');
  assert.equal(dejaDite.pos, 0, 'celle de la pile aussi : la position du cadre le plus profond');
});

/**
 * La lecture de `source` par `lire`, dans un processus neuf dont c'est la première lecture de la vie : la source arrive par l'entrée
 * standard, le processus dit ce que `lire` en a fait, puis lit un code de deux lignes pour montrer qu'il sert encore.
 */
function lireDansUnEnfant(source) {
  // Une seule ligne : un programme à plusieurs lignes en argument de `-e` n'est pas portable sous Windows.
  const programme = [
    "import fs from 'node:fs';",
    `import { lire } from ${JSON.stringify(MODULE)};`,
    "const r = lire(fs.readFileSync(0, 'utf8'));",
    "const apres = lire('var a = 1;\\nvar b = a + 1;');",
    'console.log(JSON.stringify({ ast: !!r.ast, erreur: r.erreur, encoreLisible: !!apres.ast }));',
  ].join(' ');
  return spawnSync(process.execPath, ['--input-type=module', '-e', programme], { input: source, encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 20 });
}

const FORMES = [
  ['a[ répété 1 000 fois (deux Kio)', 'a['.repeat(1000)],
  ['x=>{ répété 1 000 fois', 'x=>{'.repeat(1000)],
  ['le fichier du rejeu à 1 700 niveaux (x=>{ N fois, un témoin, } N fois)', fichierProfond(1700)],
];

for (const [nom, source] of FORMES) {
  test(`un code plus profond que la pile ne fait pas abandonner le processus, il est dit de profondeur, et le processus lit encore ensuite : ${nom}`, () => {
    const r = lireDansUnEnfant(source);
    assert.equal(r.signal, null, `le processus n'a pas été arrêté par un signal (${r.signal}) : ${String(r.stderr).slice(0, 200)}`);
    assert.equal(r.status, 0, `le processus a fini de lui-même (code ${r.status}) : ${String(r.stderr).slice(0, 200)}`);
    const dit = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(dit.ast, false, 'aucun arbre : le code n\'est pas lu');
    assert.equal(dit.erreur.cause, 'profondeur', `dit de profondeur, non ${dit.erreur.cause} (${dit.erreur.message})`);
    assert.equal(dit.erreur.message, 'la pile déborde');
    assert.ok(Number.isInteger(dit.erreur.ligne) && dit.erreur.ligne >= 1 && Number.isInteger(dit.erreur.colonne) && dit.erreur.colonne >= 1, 'avec la ligne et la colonne où la pile a débordé');
    assert.ok(Number.isInteger(dit.erreur.position) && dit.erreur.position > 0 && dit.erreur.position <= source.length, 'et sa position dans le texte');
    assert.equal(dit.encoreLisible, true, 'la lecture suivante d\'un code ordinaire réussit : le lecteur n\'est pas resté dans un état qui échoue');
  });
}
