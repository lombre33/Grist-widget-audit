/**
 * Les limites de l'analyse isolée (src/isolement/limites.js) : la mémoire du tas de l'enfant suit celle du
 * conteneur en lui laissant de quoi faire vivre le parent, une variable d'environnement la fixe, une valeur
 * invalide est dite et ignorée (jamais lue de travers), et sans conteneur ni variable il n'y a aucune limite
 * de temps (V1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RESERVE_HORS_TAS_MO, TAS_MINIMUM_MO, limiteMemoireDuConteneurMo, limitesDeLAnalyse } from '../src/isolement/limites.js';

const MIO = 1048576;
/** Un système de fichiers cgroup simulé : chemin → contenu ; un chemin absent se lit comme une erreur. */
const cgroup = (fichiers) => (chemin) => {
  if (!(chemin in fichiers)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return fichiers[chemin];
};
const V2 = '/sys/fs/cgroup/memory.max';
const V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

test('limite du conteneur : cgroup v2, en Mio', () => {
  assert.equal(limiteMemoireDuConteneurMo(cgroup({ [V2]: `${768 * MIO}\n` })), 768);
});

test('limite du conteneur : « max » (cgroup v2 sans limite) n\'est pas une limite', () => {
  assert.equal(limiteMemoireDuConteneurMo(cgroup({ [V2]: 'max\n' })), null);
});

test('limite du conteneur : cgroup v1 quand le v2 n\'existe pas', () => {
  assert.equal(limiteMemoireDuConteneurMo(cgroup({ [V1]: `${512 * MIO}\n` })), 512);
});

test('limite du conteneur : le « illimité » du cgroup v1 (un nombre énorme) n\'est pas une limite', () => {
  assert.equal(limiteMemoireDuConteneurMo(cgroup({ [V1]: '9223372036854771712\n' })), null);
});

test('limite du conteneur : contenu illisible ou nul, aucune limite inventée', () => {
  assert.equal(limiteMemoireDuConteneurMo(cgroup({ [V2]: 'n\'importe quoi' })), null);
  assert.equal(limiteMemoireDuConteneurMo(cgroup({ [V2]: '0\n' })), null);
  assert.equal(limiteMemoireDuConteneurMo(cgroup({})), null);
});

test('limite du conteneur : un v2 « max » n\'empêche pas de lire un v1 limité', () => {
  assert.equal(limiteMemoireDuConteneurMo(cgroup({ [V2]: 'max\n', [V1]: `${256 * MIO}\n` })), 256);
});

const sansAvertissement = { avertir: () => assert.fail('aucun avertissement attendu') };

test('sous un conteneur de 768 Mio, le tas de l\'enfant laisse la réserve du parent et de ce qui n\'est pas le tas', () => {
  const l = limitesDeLAnalyse({ env: {}, memoireConteneurMo: 768, ...sansAvertissement });
  assert.equal(l.limiteMo, 768 - RESERVE_HORS_TAS_MO);
  assert.equal(l.pileMo, null);
  assert.equal(l.delaiMs, null, 'sans variable, aucune limite de temps');
});

test('un conteneur trop petit ne descend pas sous le tas minimum', () => {
  assert.equal(limitesDeLAnalyse({ env: {}, memoireConteneurMo: 200, ...sansAvertissement }).limiteMo, TAS_MINIMUM_MO);
});

test('hors conteneur et sans variable : la limite de Node, aucune limite de temps (V1)', () => {
  assert.deepEqual(limitesDeLAnalyse({ env: {}, memoireConteneurMo: null, ...sansAvertissement }), { limiteMo: null, pileMo: null, delaiMs: null });
});

test('les variables d\'environnement fixent mémoire, pile et durée', () => {
  const l = limitesDeLAnalyse({ env: { GWAUDIT_MEMOIRE_ANALYSE_MO: '400', GWAUDIT_PILE_ANALYSE_MO: '64', GWAUDIT_DELAI_ANALYSE_S: '240' }, memoireConteneurMo: 768, ...sansAvertissement });
  assert.deepEqual(l, { limiteMo: 400, pileMo: 64, delaiMs: 240_000 });
});

for (const [nom, valeur] of [
  ['GWAUDIT_MEMOIRE_ANALYSE_MO', '63'], ['GWAUDIT_MEMOIRE_ANALYSE_MO', 'beaucoup'], ['GWAUDIT_MEMOIRE_ANALYSE_MO', '-5'], ['GWAUDIT_MEMOIRE_ANALYSE_MO', '400.5'],
  ['GWAUDIT_PILE_ANALYSE_MO', '0'], ['GWAUDIT_PILE_ANALYSE_MO', 'x'],
  ['GWAUDIT_DELAI_ANALYSE_S', '0'], ['GWAUDIT_DELAI_ANALYSE_S', '1e3'], ['GWAUDIT_DELAI_ANALYSE_S', '10 s'],
]) {
  test(`${nom}=${valeur} : ignorée avec un avertissement, la valeur par défaut s'applique`, () => {
    const avertissements = [];
    const l = limitesDeLAnalyse({ env: { [nom]: valeur }, memoireConteneurMo: 768, avertir: (m) => avertissements.push(m) });
    assert.equal(avertissements.length, 1);
    assert.match(avertissements[0], new RegExp(nom));
    assert.equal(l.limiteMo, 768 - RESERVE_HORS_TAS_MO);
    assert.equal(l.pileMo, null);
    assert.equal(l.delaiMs, null);
  });
}

test('une variable vide vaut une variable absente, sans avertissement', () => {
  assert.deepEqual(limitesDeLAnalyse({ env: { GWAUDIT_MEMOIRE_ANALYSE_MO: '', GWAUDIT_DELAI_ANALYSE_S: '' }, memoireConteneurMo: null, ...sansAvertissement }), { limiteMo: null, pileMo: null, delaiMs: null });
});

test('valeurs mesurées : 768 Mio de conteneur donnent 558 Mio de tas, jamais moins de 128 (les changer, c\'est remesurer : docs/ARCHITECTURE-V2.md)', () => {
  assert.equal(RESERVE_HORS_TAS_MO, 210);
  assert.equal(TAS_MINIMUM_MO, 128);
  assert.equal(limitesDeLAnalyse({ env: {}, memoireConteneurMo: 768, ...sansAvertissement }).limiteMo, 558);
  assert.equal(limitesDeLAnalyse({ env: {}, memoireConteneurMo: 300, ...sansAvertissement }).limiteMo, 128);
});

test('les minimums sont acceptés tels quels : 64 Mio de tas, 1 Mio de pile, 1 s', () => {
  const l = limitesDeLAnalyse({ env: { GWAUDIT_MEMOIRE_ANALYSE_MO: '64', GWAUDIT_PILE_ANALYSE_MO: '1', GWAUDIT_DELAI_ANALYSE_S: '1' }, memoireConteneurMo: 768, ...sansAvertissement });
  assert.deepEqual(l, { limiteMo: 64, pileMo: 1, delaiMs: 1000 });
});

test('la variable de mémoire l\'emporte sur la limite du conteneur, même plus haute', () => {
  assert.equal(limitesDeLAnalyse({ env: { GWAUDIT_MEMOIRE_ANALYSE_MO: '2000' }, memoireConteneurMo: 768, ...sansAvertissement }).limiteMo, 2000);
});
