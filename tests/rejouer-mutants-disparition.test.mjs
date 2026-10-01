/**
 * Un lancement qui n'a rien jugé ne tue rien : le moteur de mutants le dit plantage de l'outil, à part, et le lot échoue.
 * Deux cas : la suite ne lance aucun test (code 0), et l'essai a retiré ce sur quoi tout repose (la copie du lot, un de ses
 * fichiers de test, son dossier temporaire). Dans le second, tout ce qui échoue ensuite échoue pour cela : un mutant
 * « tué » par un test qui n'avait plus de dossier temporaire l'était par le vide, pas par son code (c'est ce qu'a fait, sans
 * rien dire, un rejeu du lot du moteur : 82 « tués par un test » sur 84 en 0,5 s au plus chacun, avec 58 essais en échec, le premier nommé étant
 * « RACINE est la racine du dépôt » ; la cause exacte n'a pas été établie, la piste est un mutant du balayage des copies abandonnées qui
 * retirait ce sur quoi les essais voisins reposaient).
 * Chaque comportement a son mutant : `scripts/mutants-rejouer.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classerLancement } from '../scripts/lib/rejouer-mutants.mjs';
import { nettoyer, rejouer, tap } from './aide-moteur-mutants.mjs';

const GROUPES_TMP = [{ nom: 'essai', fichiers: ['tests/tmp.test.mjs', 'tests/copie.test.mjs'] }];
const etiquettes = (r) => r.lignes.filter((l) => /^(TUÉ|PLANTAGE|SURVIT)/.test(l)).map((l) => l.slice(0, 9).trim());

test('classerLancement : un code 0 sans aucun test lancé, sans résumé ou avec des fichiers pour seuls « tests » est un plantage : aucun essai n\'a jugé', () => {
  const zero = classerLancement({ status: 0, stdout: tap({ ok: [] }) }, ['tests/x.test.mjs']);
  assert.equal(zero.verdict, 'plantage');
  assert.match(zero.raison, /aucun essai n'a tourné \(0 test lancé, code 0\)/);
  const sans = classerLancement({ status: 0, stdout: tap({ ok: ['a'], sansResume: true }) }, ['tests/x.test.mjs']);
  assert.equal(sans.verdict, 'plantage');
  assert.match(sans.raison, /aucun essai n'a tourné \(résumé absent, code 0\)/);
  const fichierSeul = classerLancement({ status: 0, stdout: tap({ ok: ['tests/x.test.mjs'] }) }, ['tests/x.test.mjs']);
  assert.equal(fichierSeul.verdict, 'plantage', 'Node compte un « test » pour un fichier qui n\'en déclare aucun : ce n\'est pas un essai');
  assert.match(fichierSeul.raison, /aucun essai n'a tourné \(aucun test nommé, seuls des fichiers sans test, code 0\)/);
  assert.equal(classerLancement({ status: 0, stdout: tap({ ok: ['tests/x.test.mjs', 'un vrai test'] }) }, ['tests/x.test.mjs']).verdict, 'passe', 'un test nommé lancé et vert : la suite passe, même avec un fichier vide à côté');
  assert.equal(classerLancement({ status: 0, stdout: tap({ ok: ['a'] }) }, ['tests/x.test.mjs']).verdict, 'passe', 'un test lancé et vert : la suite passe');
});

test('moteur : un mutant après lequel la suite ne lance plus aucun test n\'est pas un survivant : plantage, avec sa raison', () => {
  const r = rejouer(['plusAucunTest', 'test']);
  try {
    assert.equal(r.code, 1);
    assert.deepEqual(etiquettes(r), ['PLANTAGE', 'TUÉ']);
    assert.match(r.lignes.find((l) => l.startsWith('PLANTAGE')), /aucun essai n'a tourné \(aucun test nommé, seuls des fichiers sans test, code 0\)/);
    assert.equal(r.bilan.plantages, 1);
    assert.equal(r.bilan.survivants, 0);
    assert.equal(r.bilan.tuesParUnTest, 1);
  } finally { nettoyer(r); }
});

test('moteur : un essai qui retire le dossier temporaire du lot ne tue rien (plantage, dit) ; il est reposé avec ses droits et le mutant suivant se juge normalement', () => {
  const r = rejouer(['efaceLeTemporaire', 'survivant', 'test'], { groupes: GROUPES_TMP });
  try {
    assert.deepEqual(etiquettes(r), ['PLANTAGE', 'SURVIT', 'TUÉ'], 'le suivant, équivalent, survit : le dossier est revenu, avec ses droits (la suite le vérifie), il n\'est pas « tué » par son absence');
    assert.match(r.lignes.find((l) => l.startsWith('PLANTAGE')), /le dossier temporaire du lot a disparu pendant l'essai : ce qui a échoué ne juge pas le mutant/);
    assert.equal(r.bilan.tuesParUnTest, 1);
    assert.equal(r.bilan.plantages, 1);
    assert.equal(r.bilan.survivants, 1);
    assert.equal(r.bilan.nonJuges, 0);
    assert.equal(r.code, 1);
    assert.deepEqual(r.erreurs, [], 'un dossier temporaire reposé n\'arrête pas le lot');
  } finally { nettoyer(r); }
});

test('moteur : un essai qui retire la copie du lot (ou un de ses fichiers de test) arrête le lot : ce qui reste est non jugé, dit, jamais tué ni survivant, code 1, sans plantage du moteur', () => {
  for (const nom of ['efaceLaCopie', 'efaceUnFichierDeTest']) {
    const r = rejouer([nom, 'test', 'survivant'], { groupes: GROUPES_TMP });
    try {
      assert.equal(r.code, 1, nom);
      assert.deepEqual(etiquettes(r), ['PLANTAGE'], `${nom} : les deux suivants ne sont pas jugés`);
      assert.match(r.lignes.find((l) => l.startsWith('PLANTAGE')), nom === 'efaceLaCopie' ? /la copie du lot a disparu pendant l'essai/ : /tests\/tmp\.test\.mjs a disparu de la copie pendant l'essai/, nom);
      assert.equal(r.bilan.plantages, 1, nom);
      assert.equal(r.bilan.nonJuges, 2, nom);
      assert.equal(r.bilan.tuesParUnTest + r.bilan.tuesParUnDelai + r.bilan.survivants, 0, nom);
      assert.ok(r.lignes.some((l) => /1 plantage ; 0 survivant ; 2 non jugés$/.test(l)), `${nom} : ${r.lignes.join(' / ')}`);
      assert.match(r.erreurs.join('\n'), /Le lot a perdu son terrain \(.*\) : 2 mutant\(s\) n'ont pas été rejoués, le rejeu est à refaire\./, nom);
      assert.deepEqual(r.copiesRestantes, [], `${nom} : le lot ne laisse rien derrière lui`);
    } finally { nettoyer(r); }
  }
});

test('moteur : un seul mutant non jugé se dit au singulier', () => {
  const r = rejouer(['efaceLaCopie', 'test'], { groupes: GROUPES_TMP });
  try {
    assert.equal(r.bilan.nonJuges, 1);
    assert.ok(r.lignes.some((l) => /1 plantage ; 0 survivant ; 1 non jugé$/.test(l)), r.lignes.join(' / '));
    assert.match(r.erreurs.join('\n'), /: 1 mutant\(s\) n'ont pas été rejoués, le rejeu est à refaire\./);
  } finally { nettoyer(r); }
});

test('moteur : le dernier mutant qui retire la copie est un plantage et rien de plus (aucun non jugé, et le lot le dit quand même)', () => {
  const r = rejouer(['test', 'efaceLaCopie'], { groupes: GROUPES_TMP });
  try {
    assert.equal(r.code, 1);
    assert.deepEqual(etiquettes(r), ['TUÉ', 'PLANTAGE']);
    assert.equal(r.bilan.nonJuges, 0);
    assert.ok(r.lignes.some((l) => /1 plantage ; 0 survivant$/.test(l)), 'sans « non jugé » quand il n\'y en a aucun');
    assert.match(r.erreurs.join('\n'), /Le lot a perdu son terrain \(la copie du lot a disparu pendant l'essai\), le rejeu est à refaire\./);
  } finally { nettoyer(r); }
});

test('moteur : un lot qui ne perd rien ne dit ni « non jugé » ni « perdu son terrain » (le dossier existe, rien ne manque)', () => {
  const r = rejouer(['test', 'survivant'], { groupes: GROUPES_TMP });
  try {
    assert.deepEqual(etiquettes(r), ['TUÉ', 'SURVIT']);
    assert.equal(r.bilan.nonJuges, 0);
    assert.ok(!r.lignes.some((l) => /non jugé/.test(l)));
    assert.deepEqual(r.erreurs, []);
    assert.ok(fs.existsSync(path.join(r.projet, 'tests', 'tmp.test.mjs')), 'le projet de départ n\'est jamais touché : seuls la copie et son dossier temporaire le sont');
  } finally { nettoyer(r); }
});
