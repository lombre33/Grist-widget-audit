/**
 * Le moteur de mutants entier (`rejouerMutants`) sur un petit projet : un mutant
 * est tué par un test, tué par un délai, fait planter la suite ou survit ; le
 * bilan compte chaque issue à part et le code de sortie suit. Le vrai
 * `node --test` est le seul juge de ce qu'il imprime. Voir aussi
 * `rejouer-mutants-preparation.test.mjs` (ce que le moteur vérifie avant le
 * premier essai) ; chaque comportement a son mutant : `scripts/mutants-rejouer.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { F_JS, NOM_LONG, attendreLaMort, attendre, dormeur, nettoyer, pidMort, rejouer, vivant } from './aide-moteur-mutants.mjs';

test('moteur : chaque issue a son compte et son étiquette, un délai est dit délai, un plantage échoue le lot, rien ne reste', async () => {
  const r = rejouer(['test', 'delai', 'orphelin', 'plantage', 'survivant'], { delaiMs: 4500 });
  try {
    assert.equal(r.code, 1, 'un survivant et un plantage font échouer le lot');
    assert.deepEqual(
      { tuesParUnTest: r.bilan.tuesParUnTest, tuesParUnDelai: r.bilan.tuesParUnDelai, plantages: r.bilan.plantages, survivants: r.bilan.survivants, retenus: r.bilan.retenus },
      { tuesParUnTest: 1, tuesParUnDelai: 2, plantages: 1, survivants: 1, retenus: 5 },
    );
    assert.deepEqual(r.bilan.mutants.map((m) => `${m.libelle} : ${m.issue}`), [
      'renvoie 2 : test', 'boucle de 20 s : delai', 'boucle de 20 s et laisse un orphelin : delai', 'quitte au chargement : plantage', 'équivalent : survit',
    ]);
    assert.equal(r.lignes.length, 8, 'la suite non mutée, cinq mutants, une ligne vide, le bilan : pas de ligne de paquet sans paquet');
    const ligne = (libelle) => r.lignes.find((l) => l.includes(libelle));
    assert.match(ligne('renvoie 2'), /^TUÉ {7}renvoie 2 {2}\(essai, 1 en échec : f vaut 1\)$/);
    assert.match(ligne('boucle de 20 s  '), /^TUÉ délai boucle de 20 s {2}\(essai, délai de 4\.5 s dépassé, aucun test n'a jugé le mutant\)$/);
    assert.match(ligne('quitte au chargement'), /^PLANTAGE {2}quitte au chargement {2}\(essai, seuls des fichiers de test entiers échouent \(.*f\.test\.mjs\), aucun test nommé\)$/);
    assert.match(ligne('équivalent'), /^SURVIT {4}équivalent$/);
    assert.equal(r.lignes.at(-1), '3/5 mutants tués : 1 par un test, 2 par un délai ; 1 plantage ; 1 survivant');
    assert.equal(r.lignes.at(-2), '', 'une ligne vide avant le bilan');
    assert.equal(r.lignes[0], 'Suite non mutée : 1 tests, 0 sauté, 5 mutants à rejouer.\n');
    assert.deepEqual(r.copiesRestantes, [], 'la copie du moteur est retirée');
    const orphelin = Number(fs.readFileSync(r.fichierPid, 'utf8'));
    assert.ok(await attendreLaMort(orphelin), 'l\'orphelin d\'un mutant tué par le délai est tué avec lui (son répertoire courant est la copie)');
  } finally {
    nettoyer(r);
  }
});

test('moteur : le plantage aussi tue ses orphelins', async () => {
  const r = rejouer(['plantageEtOrphelin']);
  try {
    assert.equal(r.bilan.plantages, 1);
    assert.ok(await attendreLaMort(Number(fs.readFileSync(r.fichierPid, 'utf8'))), 'l\'orphelin du plantage est mort (son répertoire courant est la copie)');
  } finally {
    nettoyer(r);
  }
});

test('moteur : le détail d\'un mutant tué par un test montre au plus deux noms (au-delà de 70 caractères, un nom est coupé) et dit quel fichier entier échoue aussi', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'essai', fichiers: ['tests/echecs.test.mjs', 'tests/plante-si-mute-1.test.mjs'] }] });
  try {
    assert.equal(r.code, 0, r.erreurs.join('\n'));
    assert.equal(NOM_LONG.length, 71);
    assert.equal(r.bilan.mutants[0].detail, `essai, 4 en échec : ${NOM_LONG.slice(0, 67)}... | deuxième ; le fichier tests/plante-si-mute-1.test.mjs échoue aussi`);
  } finally {
    nettoyer(r);
  }
});

test('moteur : deux fichiers entiers en échec en plus sont dits au pluriel', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'essai', fichiers: ['tests/echecs.test.mjs', 'tests/plante-si-mute-1.test.mjs', 'tests/plante-si-mute-2.test.mjs'] }] });
  try {
    assert.equal(r.code, 0, r.erreurs.join('\n'));
    assert.match(r.bilan.mutants[0].detail, /^essai, 5 en échec : .* \| deuxième ; les fichiers tests\/plante-si-mute-(1\.test\.mjs, tests\/plante-si-mute-2|2\.test\.mjs, tests\/plante-si-mute-1)\.test\.mjs échouent aussi$/);
  } finally {
    nettoyer(r);
  }
});

test('moteur : un nom de test qui a exactement 70 caractères n\'est pas coupé', () => {
  const nom70 = 'x'.repeat(70);
  const r = rejouer(['test'], { groupes: [{ nom: 'essai', fichiers: ['tests/soixante-dix.test.mjs'] }] }, {
    fichiers: { 'tests/soixante-dix.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f } from '../src/f.js';\ntest('${nom70}', () => assert.equal(f(), 1));\n` },
  });
  try {
    assert.equal(r.bilan.mutants[0].detail, `essai, 1 en échec : ${nom70}`);
  } finally {
    nettoyer(r);
  }
});

test('moteur : tous tués par un test, code 0, comptes à zéro pour le reste (le pluriel suit le nombre)', () => {
  const r = rejouer(['test']);
  try {
    assert.equal(r.code, 0);
    assert.equal(r.lignes.at(-1), '1/1 mutants tués : 1 par un test, 0 par un délai ; 0 plantage ; 0 survivant');
    assert.deepEqual(r.copiesRestantes, []);
  } finally {
    nettoyer(r);
  }
});

test('moteur : un plantage seul fait échouer le lot (code 1) et n\'est pas compté comme tué ; sans `rapporter`, rien ne plante', () => {
  const r = rejouer(['plantage'], { rapporter: null });
  try {
    assert.equal(r.code, 1);
    assert.equal(r.lignes.at(-1), '0/1 mutants tués : 0 par un test, 0 par un délai ; 1 plantage ; 0 survivant');
    assert.equal(r.bilan, null, 'personne n\'a reçu le bilan');
  } finally {
    nettoyer(r);
  }
});

test('moteur : un survivant seul fait échouer le lot (code 1)', () => {
  const r = rejouer(['survivant']);
  try {
    assert.equal(r.code, 1);
    assert.equal(r.lignes.at(-1), '0/1 mutants tués : 0 par un test, 0 par un délai ; 0 plantage ; 1 survivant');
  } finally {
    nettoyer(r);
  }
});

test('moteur : le pluriel de plantages et de survivants suit leur nombre', () => {
  const r = rejouer(['plantage', 'plantage', 'survivant', 'survivant', 'test']);
  try {
    assert.equal(r.lignes.at(-1), '1/5 mutants tués : 1 par un test, 0 par un délai ; 2 plantages ; 2 survivants');
  } finally {
    nettoyer(r);
  }
});

test('moteur : un paquet i/n ne rejoue que le i-ième des n', () => {
  const r = rejouer(['test', 'survivant', 'delai', 'test'], { partie: { i: 2, n: 2 } });
  try {
    assert.deepEqual(r.bilan.mutants.map((m) => m.libelle), ['équivalent', 'renvoie 2']);
    assert.match(r.lignes[1], /^Paquet 2\/2 : 2 mutants sur 4\.\n$/);
  } finally {
    nettoyer(r);
  }
});

test('moteur : une suite déjà en échec sur le code non muté ne conclut rien (code 2) et le dit avec son verdict', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'essai', fichiers: ['tests/f.test.mjs', 'tests/rouge.test.mjs'] }] });
  try {
    assert.equal(r.code, 2);
    assert.match(r.erreurs.join('\n'), /pas verte et complète sur le code non muté \(verdict : test, sautés : 0, lancés : 2\)/);
    assert.equal(r.bilan, null, 'rien n\'est rapporté quand rien n\'a été jugé');
    assert.equal(r.lignes.length, 0);
    assert.deepEqual(r.copiesRestantes, []);
  } finally {
    nettoyer(r);
  }
});

test('moteur : la suite non mutée est jugée en entier : un groupe rouge, même le deuxième, ne conclut rien (code 2)', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'un', fichiers: ['tests/f.test.mjs'] }, { nom: 'deux', fichiers: ['tests/rouge.test.mjs'] }] });
  try {
    assert.equal(r.code, 2);
    assert.match(r.erreurs.join('\n'), /verdict : test, sautés : 0, lancés : 2\)/);
  } finally {
    nettoyer(r);
  }
});

test('moteur : un test sauté sur le code non muté ne conclut rien non plus (code 2)', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'essai', fichiers: ['tests/f.test.mjs', 'tests/saute.test.mjs'] }] });
  try {
    assert.equal(r.code, 2);
    assert.match(r.erreurs.join('\n'), /verdict : passe, sautés : 1, lancés : 3\)/);
    assert.equal(r.bilan, null);
  } finally {
    nettoyer(r);
  }
});

test('moteur : une suite qui ne lance aucun test ne prouve rien (code 2), même verte', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'essai', fichiers: ['tests/sans-test.test.mjs'] }] });
  try {
    assert.equal(r.code, 2);
    assert.match(r.erreurs.join('\n'), /verdict : passe, sautés : 0, lancés : 0\)/);
  } finally {
    nettoyer(r);
  }
});

test('moteur : une suite qui plante sur le code non muté ne conclut rien (code 2) et dit pourquoi', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'essai', fichiers: ['tests/f.test.mjs', 'tests/plante.test.mjs'] }] });
  try {
    assert.equal(r.code, 2);
    assert.match(r.erreurs.join('\n'), /verdict : plantage, seuls des fichiers de test entiers échouent/);
  } finally {
    nettoyer(r);
  }
});

test('moteur : les groupes se lancent dans l\'ordre ; un plantage attend la suite des groupes et ne dit son mot que si rien ne tue', () => {
  const groupe = (nom, ...fichiers) => ({ nom, fichiers: fichiers.map((f) => `tests/${f}.test.mjs`) });
  const jugement = (groupes) => {
    const r = rejouer(['test'], { groupes });
    try {
      assert.equal(r.bilan.mutants.length, 1);
      return r.bilan.mutants[0];
    } finally {
      nettoyer(r);
    }
  };

  const vertPuisF = jugement([groupe('un', 'vert'), groupe('deux', 'f')]);
  assert.equal(vertPuisF.issue, 'test', 'le premier groupe passe, le deuxième tue');
  assert.match(vertPuisF.detail, /^deux, 1 en échec : f vaut 1/);

  const plantePuisF = jugement([groupe('un', 'plante-si-mute-1'), groupe('deux', 'f')]);
  assert.equal(plantePuisF.issue, 'test', 'le premier groupe plante, le deuxième tue : un test a jugé');
  assert.match(plantePuisF.detail, /^deux, 1 en échec/);

  const deuxPlantagesPuisVert = jugement([groupe('un', 'plante-si-mute-1'), groupe('deux', 'plante-si-mute-2'), groupe('trois', 'vert')]);
  assert.equal(deuxPlantagesPuisVert.issue, 'plantage', 'rien ne tue : le plantage est dit');
  assert.match(deuxPlantagesPuisVert.detail, /^un, seuls des fichiers de test entiers échouent \(.*plante-si-mute-1\.test\.mjs\)/, 'le premier plantage, pas le dernier');
});

test('moteur : la chaîne mutée est posée telle quelle, sans que les motifs de remplacement (« $& », « $\' ») y insèrent quoi que ce soit', () => {
  const r = rejouer([{ libelle: 'dollar', fichier: 'src/f.js', ancien: F_JS, nouveau: 'export const f = () => 2; export const dollar = "$& $\' $$ $`";\n' }]);
  try {
    assert.equal(r.bilan.mutants[0].issue, 'test', 'le code muté est celui qu\'on a écrit : il s\'analyse et le test le tue');
    assert.equal(r.code, 0);
  } finally {
    nettoyer(r);
  }
});

test('moteur : au départ, la copie abandonnée d\'un lot tué est retirée avec ses processus, et le dit', async () => {
  const mort = await pidMort();
  let orphelin = null;
  let abandonnee = null;
  const r = rejouer(['test'], {}, {
    avant: ({ copies }) => {
      abandonnee = path.join(copies, `gwaudit-mutants-${mort}-abc123`);
      fs.mkdirSync(path.join(abandonnee, 'src'), { recursive: true });
      orphelin = dormeur(path.join(abandonnee, 'src'));
    },
  });
  try {
    await attendre(50);
    assert.equal(r.code, 0);
    assert.deepEqual(r.copiesRestantes, [], 'la copie abandonnée est partie, la sienne aussi');
    assert.ok(!vivant(orphelin.pid), 'le processus qu\'elle avait laissé est mort');
    assert.equal(r.erreurs.length, 1);
    assert.equal(r.erreurs[0], `1 copie(s) laissée(s) par un lot interrompu retirée(s), avec leurs processus : ${abandonnee}`);
  } finally {
    orphelin?.kill('SIGKILL');
    nettoyer(r);
  }
});

test('moteur : un fichier de test qui n\'existe pas est dit avant tout essai (node --test l\'ignorerait sans rien dire)', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'essai', fichiers: ['tests/f.test.mjs', 'tests/absent.test.mjs'] }] });
  try {
    assert.equal(r.code, 2);
    assert.match(r.erreurs.join('\n'), /groupe « essai » : le fichier de test tests\/absent\.test\.mjs n'existe pas/);
    assert.equal(r.lignes.length, 0, 'aucun essai n\'a été lancé');
  } finally {
    nettoyer(r);
  }
});
