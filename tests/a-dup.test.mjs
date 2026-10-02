import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_EMPLACEMENTS } from '../src/moteur/modele.js';
import { separateur } from './aide-clones.mjs';
import { constatsDe, copie, dup, fichier, fonctionsDistinctes, separateurA, separateurB } from './aide-a-dup.mjs';

/**
 * A-DUP-01 : un seul constat pour tout le dépôt, qui dit les plus gros clones (fonctions, blocs et suites d'instructions copiés, aux noms et aux
 * valeurs près), les compte dans son titre et les range dans sa preuve. Ces essais lisent les constats que la règle rend sur des fichiers de test ; le moteur
 * (`src/moteur/clones.js`) a les siens, et ce que la règle ne compare pas (A-DUP-00) est dans `tests/a-dup-ecarte.test.mjs`.
 */

test('deux fichiers qui portent la même fonction : un constat A-DUP-01, mineur, probable, qui nomme le clone', () => {
  const [c, ...autres] = constatsDe([fichier('js/a.js', copie('f')), fichier('js/b.js', `var z = 1;\n${copie('g')}`)]);
  assert.equal(autres.length, 0);
  assert.equal(c.regle, 'A-DUP-01');
  assert.equal(c.axe, 'A');
  assert.equal(c.severite, 'mineur');
  assert.equal(c.confiance, 'probable');
  assert.equal(c.bloquant, false);
  assert.equal(c.titre, '1 bloc(s) de code dupliqué(s), dont 1 entre fichiers différents');
  assert.equal(c.fichier, 'js/a.js');
  assert.equal(c.ligne, 1);
  assert.match(c.constat, /^Des fonctions, des blocs ou des suites d'instructions se répètent à l'identique, ou aux noms et aux valeurs près : environ 11 lignes sont la copie d'un autre endroit\./);
  assert.match(c.constat, /Les plus gros : `js\/a\.js` lignes 1 à 11 et `js\/b\.js` lignes 2 à 12, 11 lignes\.$/);
  assert.match(c.impact, /un défaut corrigé à un endroit restera silencieusement présent dans les autres/);
  assert.match(c.remediation, /^Extraire la logique partagée dans une fonction ou un module commun/);
  assert.deepEqual(c.referentiels, ['Guide de contribution Grist.Gouv — « Duplicated code is harder to review and creates maintenance debt »']);
});

test('la preuve range chaque clone : sa forme, son type, sa taille et ses exemplaires', () => {
  const [c] = dup([fichier('a.js', copie('f')), fichier('b.js', copie('g', 'enabled'))]);
  assert.deepEqual(c.preuve, {
    groupes: [{ forme: 'fonction', type: 'renomme', lignes: 11, masse: 59, instances: [{ fichier: 'a.js', ligne: 1, ligneFin: 11 }, { fichier: 'b.js', ligne: 1, ligneFin: 11 }] }],
  });
  const [i] = dup([fichier('a.js', copie('f')), fichier('b.js', copie('f'))]);
  assert.equal(i.preuve.groupes[0].type, 'identique');
});

test('deux copies dans un même fichier : le titre ne dit pas « entre fichiers différents »', () => {
  const [c] = dup([fichier('a.js', `${copie('f')}var z = 1;\n${copie('g')}`)]);
  assert.equal(c.titre, '1 bloc(s) de code dupliqué(s)');
  assert.equal(c.severite, 'mineur');
});

test('le titre dit le total des clones, puis ceux qui sont entre fichiers différents', () => {
  const [c] = dup([
    fichier('a.js', copie('f')), fichier('b.js', copie('g')),
    fichier('seul.js', `${fonctionsDistinctes(1, separateurA)}${fonctionsDistinctes(1, separateurB)}`),
  ]);
  assert.equal(c.titre, '2 bloc(s) de code dupliqué(s), dont 1 entre fichiers différents');
});

test('le constat se place sur le plus gros clone, et dit ses lignes : celles de son premier exemplaire', () => {
  // trois fonctions de tailles croissantes (8, 9 puis 10 lignes, séparées d'une ligne) : la plus grosse commence ligne 20
  const [c] = dup([fichier('a.js', fonctionsDistinctes(3, separateurA)), fichier('b.js', fonctionsDistinctes(3, separateurB))]);
  assert.equal(c.fichier, 'a.js');
  assert.equal(c.ligne, 20);
  assert.match(c.constat, /Les plus gros : `a\.js` lignes 20 à 29 et `b\.js` lignes 20 à 29, 10 lignes ; /);
});

test('les lignes copiées sont la somme de celles de chaque clone, un exemplaire de moins que de copies', () => {
  const [c] = dup([fichier('a.js', fonctionsDistinctes(3, separateurA)), fichier('b.js', fonctionsDistinctes(3, separateurB))]);
  assert.match(c.constat, /environ 27 lignes sont la copie d'un autre endroit/, 'trois clones de 8, 9 et 10 lignes, deux exemplaires chacun');
});

test('aucun clone : aucun constat', () => {
  assert.deepEqual(constatsDe([fichier('a.js', copie('f')), fichier('b.js', 'var z = 1;\n')]), []);
  assert.deepEqual(constatsDe([]), []);
});

test('le texte dit au plus les trois plus gros clones', () => {
  const [c] = dup([fichier('a.js', fonctionsDistinctes(5, separateurA)), fichier('b.js', fonctionsDistinctes(5, separateurB))]);
  assert.match(c.titre, /^5 bloc\(s\)/);
  const dits = c.constat.slice(c.constat.indexOf('Les plus gros : ') + 'Les plus gros : '.length).split(' ; ');
  assert.equal(dits.length, 3, c.constat);
  const lignes = dits.map((d) => Number(/, (\d+) lignes\.?$/.exec(d)[1]));
  assert.deepEqual(lignes, [...lignes].sort((x, y) => y - x), 'du plus gros au plus petit');
});

test('les exemplaires au-delà du deuxième sont comptés : « et 1 autre », « et 2 autres »', () => {
  const trois = dup(['a', 'b', 'c'].map((n) => fichier(`${n}.js`, copie('f'))))[0];
  assert.match(trois.constat, /`a\.js` lignes 1 à 11 et `b\.js` lignes 1 à 11 \(et 1 autre\), 11 lignes\.$/);
  const quatre = dup(['a', 'b', 'c', 'd'].map((n) => fichier(`${n}.js`, copie('f'))))[0];
  assert.match(quatre.constat, /\(et 2 autres\), 11 lignes\.$/);
  assert.equal(quatre.preuve.groupes[0].instances.length, 4);
  assert.match(quatre.constat, /environ 33 lignes sont la copie/, 'trois copies de onze lignes : le total des lignes copiées compte chaque exemplaire au-delà du premier');
});

// ---------------------------------------------------------------------------------------------------------------------
// La sévérité

test('jusqu\'à cinq clones entre fichiers : mineur ; à six : majeur', () => {
  const entre = (n) => dup([fichier('a.js', fonctionsDistinctes(n, separateurA)), fichier('b.js', fonctionsDistinctes(n, separateurB))])[0];
  assert.equal(entre(5).titre, '5 bloc(s) de code dupliqué(s), dont 5 entre fichiers différents');
  assert.equal(entre(5).severite, 'mineur');
  assert.equal(entre(6).titre, '6 bloc(s) de code dupliqué(s), dont 6 entre fichiers différents');
  assert.equal(entre(6).severite, 'majeur');
});

test('seuls les clones entre fichiers pèsent sur la sévérité : dix clones dans un même fichier restent mineurs', () => {
  const dans = (n) => dup([fichier('a.js', `${fonctionsDistinctes(n, separateurA)}${fonctionsDistinctes(n, separateurB)}`)])[0];
  assert.equal(dans(10).titre, '10 bloc(s) de code dupliqué(s)');
  assert.equal(dans(10).severite, 'mineur');
});

test('un clone répété plus de `exemplairesMajeur` fois est majeur à lui seul, qu\'il soit dans un fichier ou entre fichiers', () => {
  const fichiers = (n) => Array.from({ length: n }, (_, i) => fichier(`u${i}.js`, copie(`f${i}`)));
  assert.equal(dup(fichiers(3), { exemplairesMajeur: 3 })[0].severite, 'mineur', 'trois exemplaires, au plus trois : rien de massif');
  const [c] = dup(fichiers(4), { exemplairesMajeur: 3 });
  assert.equal(c.severite, 'majeur');
  assert.match(c.constat, / 1 bloc\(s\) sont répétés plus de 3 fois : une duplication massive\.$/);
  const dans = fichier('seul.js', Array.from({ length: 4 }, (_, i) => `${separateur(i + 1)}\n${copie(`f${i}`)}`).join(''));      // chaque copie après une instruction de forme à elle : aucune série ne les prolonge
  assert.equal(dup([dans], { exemplairesMajeur: 3 })[0].severite, 'majeur', 'dans un seul fichier aussi');
  assert.doesNotMatch(dup(fichiers(3), { exemplairesMajeur: 3 })[0].constat, /duplication massive/);
});

test('le texte compte les blocs répétés plus de `exemplairesMajeur` fois, non tous les blocs trouvés', () => {
  const fichiers = [
    ...Array.from({ length: 4 }, (_, i) => fichier(`u${i}.js`, copie('f'))),                                         // quatre exemplaires : plus de trois
    fichier('p.js', fonctionsDistinctes(1, separateurA)), fichier('q.js', fonctionsDistinctes(1, separateurB)),      // une autre forme, deux exemplaires : rien de massif
  ];
  const [c] = dup(fichiers, { exemplairesMajeur: 3 });
  assert.equal(c.titre, '2 bloc(s) de code dupliqué(s), dont 2 entre fichiers différents');
  assert.match(c.constat, / 1 bloc\(s\) sont répétés plus de 3 fois : une duplication massive\.$/);
});

test('sans seuil donné, la duplication massive commence à plus de 5 000 exemplaires', () => {
  const fichiers = (n) => Array.from({ length: n }, (_, i) => fichier(`u${i}.js`, copie('f')));
  assert.equal(dup(fichiers(5000))[0].severite, 'mineur');
  const [c] = dup(fichiers(5001));
  assert.equal(c.severite, 'majeur');
  assert.match(c.constat, /plus de 5000 fois : une duplication massive\.$/);
  assert.equal(c.preuve.groupes[0].instances.length, 20, 'la preuve garde vingt exemplaires, et dit les autres');
  assert.equal(c.preuve.groupes[0].instancesOmises, 4981);
});

test('la part des clones entièrement dans des fichiers de test est dite ; un clone entre un test et le code ne l\'est pas', () => {
  const sans = dup([fichier('src/a.js', copie('f')), fichier('src/b.js', copie('g'))])[0];
  assert.doesNotMatch(sans.constat, /fichiers de test/);
  const [c] = dup([fichier('test/a.js', copie('f')), fichier('tests/unit/b.js', copie('g')), fichier('src/c.js', fonctionsDistinctes(1, separateurA)), fichier('src/d.js', fonctionsDistinctes(1, separateurB))]);
  assert.match(c.constat, / 1 de ces blocs sont entièrement dans des fichiers de test\.$/);
  const [mixte] = dup([fichier('test/a.js', copie('f')), fichier('src/b.js', copie('g'))]);
  assert.doesNotMatch(mixte.constat, /fichiers de test/, 'une copie dans le code n\'est pas un clone de tests');
});

test('un fichier de test se reconnaît à son dossier ou à son nom, avec les séparateurs de Windows aussi', () => {
  for (const chemin of ['test/a.js', 'tests/a.js', 'dev-tests\\a.js', 'src/a.test.js', 'src/a.spec.mjs', 'src\\a.test.mjs']) {
    const [c] = dup([fichier(chemin, copie('f')), fichier(chemin.replace('a', 'b'), copie('g'))]);
    assert.match(c.constat, /fichiers de test/, chemin);
  }
  for (const chemin of ['src/latest.js', 'src/contest/a.js', 'src/attestation.js']) {
    const [c] = dup([fichier(chemin, copie('f')), fichier(chemin.replace('.js', '2.js'), copie('g'))]);
    assert.doesNotMatch(c.constat, /fichiers de test/, chemin);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Ce qui est comparé

test('les scripts d\'une page sont comparés, aux lignes de la page', () => {
  const page = (script) => `<!doctype html>\n<title>x</title>\n<script>\n${script}</script>\n`;
  const [c] = dup([fichier('a.html', page(copie('f'))), fichier('b.html', page(copie('g')))]);
  assert.equal(c.fichier, 'a.html');
  assert.equal(c.ligne, 4);
  assert.deepEqual(c.preuve.groupes[0].instances, [{ fichier: 'a.html', ligne: 4, ligneFin: 14 }, { fichier: 'b.html', ligne: 4, ligneFin: 14 }]);
});

test('deux scripts d\'une même page sont comparés entre eux', () => {
  const [c] = dup([fichier('index.html', `<script>\n${copie('f')}</script>\n<script>\n${copie('g')}</script>\n`)]);
  assert.equal(c.titre, '1 bloc(s) de code dupliqué(s)');
  assert.deepEqual(c.preuve.groupes[0].instances, [{ fichier: 'index.html', ligne: 2, ligneFin: 12 }, { fichier: 'index.html', ligne: 15, ligneFin: 25 }]);
});

for (const ext of ['.js', '.mjs', '.cjs']) {
  test(`un fichier ${ext} est comparé`, () => {
    assert.equal(dup([fichier(`a${ext}`, copie('f')), fichier(`b${ext}`, copie('g'))]).length, 1);
  });
}

test('un fichier que l\'analyse ne lit pas ne fait ni échouer la règle, ni disparaître les autres', () => {
  const fichiers = [fichier('casse.js', 'function ( {{{'), fichier('a.js', copie('f')), fichier('b.js', copie('g')), { chemin: 'image.png', ext: '.png', binaire: true, executee: false, vendorise: false }];
  const [c] = dup(fichiers);
  assert.equal(c.titre, '1 bloc(s) de code dupliqué(s), dont 1 entre fichiers différents');
});

// ---------------------------------------------------------------------------------------------------------------------
// Des textes du widget dans un constat

test('le chemin d\'un fichier de plus de 120 caractères n\'est cité que par sa fin : le constat ne grossit pas avec le chemin', () => {
  const dossier = `${'a'.repeat(60)}/`.repeat(5);                                    // 305 caractères de dossiers, avant `b.js` dans l'ordre des chemins
  const [c] = dup([fichier(`${dossier}a.js`, copie('f')), fichier('b.js', copie('g'))]);
  const fin = (n) => `${dossier}a.js`.slice(-n);
  assert.match(c.constat, new RegExp(`\`…${fin(120)}\` lignes 1 à 11 et \`b\\.js\` lignes 1 à 11`), 'les 120 derniers caractères, après un point de suspension');
  assert.ok(!c.constat.includes(fin(121)), 'pas un caractère de plus');
  assert.ok(c.constat.length < 900, `un constat de ${c.constat.length} caractères`);
  assert.equal(c.fichier, `${dossier}a.js`, 'l\'emplacement du constat, lui, est le chemin entier');
  assert.equal(c.preuve.groupes[0].instances[0].fichier, `${dossier}a.js`, 'et la preuve aussi');
  const juste = 'x'.repeat(118) + '.js';                                           // 121 caractères : un de trop
  const [d] = dup([fichier(juste, copie('f')), fichier('b.js', copie('g'))]);
  assert.ok(d.constat.includes(`\`…${juste.slice(-120)}\``), '121 caractères : borné');
  const [e] = dup([fichier(juste.slice(1), copie('f')), fichier('b.js', copie('g'))]);
  assert.ok(e.constat.includes(`\`${juste.slice(1)}\``) && !e.constat.includes('…'), '120 caractères : tel quel');
});

test('un chemin coupé entre les deux moitiés d\'un caractère hors du plan de base reste un texte bien formé', () => {
  const chemin = `${'a'.repeat(10)}😀${'b'.repeat(116)}.js`;                      // 131 unités : les 120 dernières commencent par la moitié basse du caractère
  const [c] = dup([fichier(chemin, copie('f')), fichier('z.js', copie('g'))]);
  assert.ok(c.constat.isWellFormed());
  assert.ok(c.constat.includes(`\`…\uFFFD${'b'.repeat(116)}.js\``));
});

test('un chemin de fichier que le Markdown lirait comme autre chose est cité, un chemin ordinaire est dit tel quel dans un extrait de code', () => {
  const [c] = dup([fichier('src/[id]/a`b.js', copie('f')), fichier('src/b.js', copie('g'))]);
  assert.match(c.constat, /``src\/\[id\]\/a`b\.js`` lignes 1 à 11 et `src\/b\.js` lignes 1 à 11/);
});

test('un caractère invisible d\'un chemin se lit écrit : aucun caractère de contrôle ne part dans un constat', () => {
  const [c] = dup([fichier('src/a\u001b[31m.js', copie('f')), fichier('src/b‮.js', copie('g'))]);
  assert.doesNotMatch(c.constat, /[\u001b‮]/);
  assert.match(c.constat, /\\u001b/);
  assert.match(c.constat, /\\u202e/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Une preuve bornée

test('la preuve garde les cent plus gros clones et dit combien elle en omet ; le titre dit le total', () => {
  const [c] = dup([fichier('a.js', fonctionsDistinctes(103, separateurA)), fichier('b.js', fonctionsDistinctes(103, separateurB))]);
  assert.match(c.titre, /^103 bloc\(s\)/);
  assert.equal(c.preuve.groupes.length, 100);
  assert.equal(c.preuve.groupesOmis, 3);
  const masses = c.preuve.groupes.map((g) => g.masse);
  assert.deepEqual(masses, [...masses].sort((x, y) => y - x), 'du plus gros au plus petit');
});

test('cent clones et vingt exemplaires par clone tiennent dans la preuve : rien n\'est omis ; un de plus, et le dit', () => {
  const cent = dup([fichier('a.js', fonctionsDistinctes(100, separateurA)), fichier('b.js', fonctionsDistinctes(100, separateurB))])[0];
  assert.equal(cent.preuve.groupes.length, 100);
  assert.equal('groupesOmis' in cent.preuve, false);
  const cent1 = dup([fichier('a.js', fonctionsDistinctes(101, separateurA)), fichier('b.js', fonctionsDistinctes(101, separateurB))])[0];
  assert.equal(cent1.preuve.groupes.length, 100);
  assert.equal(cent1.preuve.groupesOmis, 1);
  const copies = (n) => dup(Array.from({ length: n }, (_, i) => fichier(`copie${String(i).padStart(2, '0')}.js`, copie(`f${i}`))))[0].preuve.groupes[0];
  assert.equal(copies(20).instances.length, 20);
  assert.equal('instancesOmises' in copies(20), false);
  assert.equal(copies(21).instances.length, 20);
  assert.equal(copies(21).instancesOmises, 1);
});

test('une preuve sans omission ne porte pas de compte d\'omis', () => {
  const [c] = dup([fichier('a.js', copie('f')), fichier('b.js', copie('g'))]);
  assert.equal('groupesOmis' in c.preuve, false);
  assert.equal('instancesOmises' in c.preuve.groupes[0], false);
});

test('la preuve garde vingt exemplaires par clone et dit combien elle en omet', () => {
  const fichiers = Array.from({ length: 25 }, (_, i) => fichier(`copie${String(i).padStart(2, '0')}.js`, copie(`f${i}`)));
  const [c] = dup(fichiers);
  assert.equal(c.preuve.groupes[0].instances.length, 20);
  assert.equal(c.preuve.groupes[0].instancesOmises, 5);
  assert.equal(c.preuve.groupes[0].instances[0].fichier, 'copie00.js');
  assert.match(c.constat, /\(et 23 autres\), 11 lignes\.$/);
});

test('la preuve se compte par groupes, comme celle des autres règles agrégées (`scripts/simuler-conversion-occurrences.mjs`)', () => {
  const [c] = dup([fichier('a.js', copie('f')), fichier('b.js', copie('g'))]);
  assert.equal(Array.isArray(c.preuve.groupes), true);
  assert.ok(MAX_EMPLACEMENTS >= 100, 'les groupes de la preuve ne sont pas coupés par la borne des emplacements');
});
