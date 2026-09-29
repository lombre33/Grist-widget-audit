import test from 'node:test';
import assert from 'node:assert/strict';
import { comparerRapports, resumeNotes } from '../scripts/lib/comparer-rapports.mjs';

/**
 * `comparerRapports` sert à mesurer un changement partagé avant/après : ce qu'il
 * ne voit pas serait une différence passée sous silence. Chaque test change UNE
 * chose et exige que la comparaison la voie ; le premier exige qu'elle ne voie
 * rien là où rien n'a changé (un faux écart ferait douter de tous les autres).
 */

let compteur = 0;
const constat = (extra = {}) => ({
  uid: `C-EXFIL-03#${++compteur}`, regle: 'C-EXFIL-03', titre: 'Ressource externe chargée depuis e.example (feuille de style)',
  severite: 'majeur', bloquant: false, constat: 'La page charge une feuille externe.', impact: 'Fuite d\'adresse IP.',
  remediation: 'Héberger la feuille.', fichier: 'index.html', ligne: 4, extrait: '<link rel=stylesheet href="https://e.example/a.css">',
  confiance: 'certain', preuve: null, mesurePartielle: false, ...extra,
});
const rapport = (constatsParAxe = {}, extra = {}) => ({
  verdict: 'CONFORME', scoreGlobal: 90, bloquants: [],
  axes: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((code) => [code, { score: 90, constats: constatsParAxe[code] ?? [] }])),
  ...extra,
});

test('deux rapports identiques (uid et preuve différents, ordre différent) : aucune différence', () => {
  const avant = rapport({ C: [constat({ ligne: 4 }), constat({ ligne: 8 })] });
  const apres = rapport({ C: [constat({ ligne: 8, preuve: { trace: 'autre' } }), constat({ ligne: 4 })] });
  const r = comparerRapports(avant, apres);
  assert.equal(r.identique, true);
  assert.deepEqual([r.retires, r.ajoutes, r.textes], [[], [], []]);
  assert.equal(r.notesIdentiques, true);
  assert.deepEqual([r.constatsAvant, r.constatsApres], [2, 2]);
});

test('un constat retiré et un autre ajouté se compensent dans les notes, pas dans la comparaison', () => {
  const avant = rapport({ C: [constat({ ligne: 4 })] });
  const apres = rapport({ C: [constat({ ligne: 9 })] });
  const r = comparerRapports(avant, apres);
  assert.equal(r.notesIdentiques, true, 'mêmes notes');
  assert.equal(r.identique, false);
  assert.deepEqual(r.retires.map((d) => d.cle.split('|')[3]), ['4']);
  assert.deepEqual(r.ajoutes.map((d) => d.cle.split('|')[3]), ['9']);
});

for (const [libelle, changement] of [
  ['la sévérité', { severite: 'mineur' }],
  ['le caractère bloquant', { bloquant: true }],
  ['le titre', { titre: 'Ressource externe chargée depuis e.example (préchargement)' }],
  ['la ligne', { ligne: 5 }],
  ['le fichier', { fichier: 'autre.html' }],
  ['la règle', { regle: 'C-EXFIL-04' }],
]) {
  test(`${libelle} d'un constat est une différence (un retiré, un ajouté)`, () => {
    const r = comparerRapports(rapport({ C: [constat()] }), rapport({ C: [constat(changement)] }));
    assert.equal(r.identique, false);
    assert.equal(r.retires.length, 1);
    assert.equal(r.ajoutes.length, 1);
  });
}

test("l'axe d'un constat compte : le même constat sous un autre axe est une différence", () => {
  const r = comparerRapports(rapport({ C: [constat()] }), rapport({ E: [constat()] }));
  assert.equal(r.retires.length, 1);
  assert.equal(r.ajoutes.length, 1);
});

test('la multiplicité compte : deux constats de même clé qui deviennent un seul, et inversement', () => {
  const deux = rapport({ C: [constat(), constat()] });
  const un = rapport({ C: [constat()] });
  const r1 = comparerRapports(deux, un);
  assert.deepEqual(r1.retires.map((d) => d.n), [1]);
  assert.deepEqual([r1.ajoutes, r1.textes], [[], []]);
  const r2 = comparerRapports(un, deux);
  assert.deepEqual(r2.ajoutes.map((d) => d.n), [1]);
  assert.deepEqual([r2.retires, r2.textes], [[], []]);
  const trois = comparerRapports(rapport({ C: [constat(), constat(), constat(), constat()] }), un);
  assert.deepEqual(trois.retires.map((d) => d.n), [3]);
});

for (const champ of ['constat', 'impact', 'remediation', 'extrait', 'confiance', 'mesurePartielle']) {
  test(`même clé, ${champ} modifié : différence de texte, ni retirée ni ajoutée`, () => {
    const avant = rapport({ C: [constat()] });
    const modifie = { constat: 'autre', impact: 'autre', remediation: 'autre', extrait: 'autre', confiance: 'probable', mesurePartielle: true }[champ];
    const r = comparerRapports(avant, rapport({ C: [constat({ [champ]: modifie })] }));
    assert.equal(r.identique, false);
    assert.deepEqual([r.retires, r.ajoutes], [[], []]);
    assert.deepEqual(r.textes.map((d) => d.champs), [[champ]]);
  });
}

test('une différence de texte sur une seule occurrence d\'un groupe de même clé est vue', () => {
  const avant = rapport({ C: [constat({ extrait: 'a' }), constat({ extrait: 'b' })] });
  const apres = rapport({ C: [constat({ extrait: 'a' }), constat({ extrait: 'c' })] });
  const r = comparerRapports(avant, apres);
  assert.deepEqual(r.textes.map((d) => d.champs), [['extrait']]);
  // et le même groupe dans un autre ordre n'est pas une différence
  assert.equal(comparerRapports(avant, rapport({ C: [constat({ extrait: 'b' }), constat({ extrait: 'a' })] })).identique, true);
});

test("l'identité d'un constat n'est pas une concaténation : un | dans un chemin ne fait pas de faux doublon", () => {
  const r = comparerRapports(rapport({ C: [constat({ fichier: 'x|y', ligne: 5 })] }), rapport({ C: [constat({ fichier: 'x', ligne: 'y|5' })] }));
  assert.equal(r.retires.length, 1);
  assert.equal(r.ajoutes.length, 1);
});

test('un bloquant absent et un bloquant faux, un fichier ou une ligne absents et nuls : le même constat', () => {
  const sans = constat({ fichier: undefined, ligne: undefined });
  delete sans.bloquant;
  assert.equal(comparerRapports(rapport({ C: [sans] }), rapport({ C: [constat({ bloquant: false, fichier: null, ligne: null })] })).identique, true);
});

test('un champ absent et un champ null sont le même constat', () => {
  const sans = constat();
  delete sans.remediation;
  assert.equal(comparerRapports(rapport({ C: [sans] }), rapport({ C: [constat({ remediation: null })] })).identique, true);
});

for (const [libelle, extra] of [
  ['le verdict', { verdict: 'NON CONFORME' }],
  ['le score global', { scoreGlobal: 89 }],
  ['le nombre de bloquants', { bloquants: [{ regle: 'X' }] }],
]) {
  test(`${libelle} différent : les notes sont dites différentes, les constats non`, () => {
    const r = comparerRapports(rapport({ C: [constat()] }), rapport({ C: [constat()] }, extra));
    assert.equal(r.notesIdentiques, false);
    assert.equal(r.identique, false);
    assert.deepEqual([r.retires, r.ajoutes, r.textes], [[], [], []]);
  });
}

for (const code of ['A', 'B', 'C', 'D', 'E', 'F']) {
  test(`le score de l'axe ${code} seul différent : notes différentes`, () => {
    const apres = rapport({ C: [constat()] });
    apres.axes[code].score = 88;
    assert.equal(comparerRapports(rapport({ C: [constat()] }), apres).notesIdentiques, false);
  });
}

test("un axe non exécuté s'écrit — (pas null) et n'est pas un score de 0", () => {
  const sansD = rapport();
  sansD.axes.D.score = null;
  assert.match(resumeNotes(sansD), /D=— /);
  assert.equal(comparerRapports(sansD, rapport()).notesIdentiques, false);
  const zero = rapport();
  zero.axes.D.score = 0;
  assert.equal(comparerRapports(sansD, zero).notesIdentiques, false);
});

test('un axe sans liste de constats (mesure non faite) ne casse pas la comparaison', () => {
  const avant = rapport();
  delete avant.axes.D.constats;
  assert.equal(comparerRapports(avant, rapport()).identique, true);
});
