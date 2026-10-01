/**
 * Un mutant posé « sur la ligne qui porte un motif » (`dansLigne`) et la vérification d'avance d'un lot
 * (`--valider`). Un motif que le code a laissé derrière lui ne fait plus mourir un lot d'une exception au
 * chargement, sans rien dire des autres : le moteur le refuse en le nommant (avec le fichier), tous d'un
 * coup, code 2. Chaque comportement a son mutant : `scripts/mutants-rejouer.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MotifRefuse, dansLigne, lireArguments } from '../scripts/lib/rejouer-mutants.mjs';
import { F_JS, MODULE_MOTEUR, MUTANTS, nettoyer, nettoyerDossier, pidMort, prive, rejouer } from './aide-moteur-mutants.mjs';

const L_JS = ['const a = 1; // ancre', 'const b = 2; // ancre bis', 'const c = a + b;', 'const d = c + 1;', 'const e = c + 2;', ''].join('\n');

/** Un petit projet où `dansLigne` lit (sa racine est rendue) : `src/l.js` a une ligne par valeur, `src/f.js` est celui des essais du moteur. */
function projetDeLignes(t) {
  const dossier = prive();
  t.after(() => nettoyerDossier(dossier));
  fs.mkdirSync(path.join(dossier, 'src'));
  fs.writeFileSync(path.join(dossier, 'src/l.js'), L_JS);
  fs.writeFileSync(path.join(dossier, 'src/f.js'), F_JS);
  return dossier;
}

// --- dansLigne : le mutant posé -------------------------------------------------------------------------------

test('dansLigne : un motif qui ne désigne qu\'une ligne donne le mutant de cette ligne, chaîne d\'origine et chaîne mutée', (t) => {
  const racine = projetDeLignes(t);
  assert.deepEqual(dansLigne('src/l.js', 'const b =', '2', '3', 'deux devient trois', null, racine), ['src/l.js', 'const b = 2; // ancre bis', 'const b = 3; // ancre bis', 'deux devient trois']);
});

test('dansLigne : la chaîne mutée est posée telle quelle, « $& » et « $\' » n\'insèrent rien', (t) => {
  const racine = projetDeLignes(t);
  const [, ancien, nouveau] = dansLigne('src/l.js', 'const b =', '2', "$&$'$$", 'motifs de remplacement', null, racine);
  assert.equal(ancien, 'const b = 2; // ancre bis');
  assert.equal(nouveau, "const b = $&$'$$; // ancre bis");
});

test('dansLigne : `sans` écarte les lignes qui le portent, un motif qui en désigne deux devient unique', (t) => {
  const racine = projetDeLignes(t);
  const ambigu = dansLigne('src/l.js', '// ancre', '1', '9', 'deux lignes portent le motif', null, racine);
  assert.ok(ambigu[1] instanceof MotifRefuse, 'sans `sans`, « // ancre » est sur deux lignes : refusé');
  assert.deepEqual(dansLigne('src/l.js', '// ancre', '1', '9', 'la seconde est écartée', 'bis', racine), ['src/l.js', 'const a = 1; // ancre', 'const a = 9; // ancre', 'la seconde est écartée']);
});

test('dansLigne : chaque cause de refus est une raison qui nomme le fichier et le motif, rien n\'est levé', (t) => {
  const racine = projetDeLignes(t);
  const refus = (...args) => {
    const r = dansLigne(...args, racine);
    assert.equal(r.length, 4);
    assert.ok(r[1] instanceof MotifRefuse, `un refus attendu : ${JSON.stringify(r)}`);
    assert.equal(r[0], args[0], 'le fichier');
    assert.equal(r[2], '', 'aucune chaîne mutée');
    assert.equal(r[3], args[4], 'le libellé');
    return r[1].raison;
  };
  assert.equal(refus('src/l.js', 'const z =', 'z', 'y', 'aucune ligne', null), 'src/l.js : « const z = » se trouve sur 0 lignes, il en faut une');
  assert.equal(refus('src/l.js', 'const', 'a', 'b', 'toutes les lignes', null), 'src/l.js : « const » se trouve sur 5 lignes, il en faut une');
  assert.equal(refus('src/l.js', 'const c', 'a', 'b', 'sans qui ne laisse rien', 'c'), 'src/l.js : « const c » sans « c » se trouve sur 0 lignes, il en faut une');
  assert.equal(refus('src/l.js', 'const b =', 'zzz', 'y', 'de absent', null), 'src/l.js : « zzz » ne figure pas dans la ligne de « const b = »');
  assert.equal(refus('src/absent.js', 'const b =', '2', '3', 'fichier absent', null), "src/absent.js : le fichier n'existe pas, « const b = » n'y est pas cherché");
});

/** Un mutant sous la forme que les lots donnent au moteur (`[fichier, chaîne d'origine, chaîne mutée, libellé]` devient un objet). */
const enMutant = ([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau });

// --- le moteur refuse ce que dansLigne refuse ------------------------------------------------------------------

test('moteur : les motifs périmés d\'un lot sont refusés tous d\'un coup avec leur raison (code 2), avec la chaîne d\'origine absente qui les accompagne, sans lancer aucun essai', (t) => {
  const racine = projetDeLignes(t);
  const r = rejouer([
    MUTANTS.test,
    enMutant(dansLigne('src/f.js', 'export const g', '1', '2', 'motif périmé', null, racine)),
    { libelle: 'chaîne périmée', fichier: 'src/f.js', ancien: 'n\'existe plus', nouveau: 'x' },
    enMutant(dansLigne('src/f.js', 'export const f', 'zzz', '2', 'de périmé', null, racine)),
  ]);
  try {
    assert.equal(r.code, 2);
    const e = r.erreurs.join('\n');
    assert.match(e, /^3 mutant\(s\) à corriger avant de rien conclure/);
    assert.match(e, /mutant 2 \(motif périmé\) : src\/f\.js : « export const g » se trouve sur 0 lignes, il en faut une/);
    assert.match(e, /mutant 3 \(chaîne périmée\) : « n'existe plus » trouvé 0 fois dans src\/f\.js, exactement une attendue/);
    assert.match(e, /mutant 4 \(de périmé\) : src\/f\.js : « zzz » ne figure pas dans la ligne de « export const f »/);
    assert.doesNotMatch(e, /mutant 1 /);
    assert.equal(r.lignes.length, 0, 'aucun essai lancé');
    assert.deepEqual(r.copiesRestantes, []);
  } finally {
    nettoyer(r);
  }
});

// --- --valider -------------------------------------------------------------------------------------------------

test('moteur --valider : la vérification d\'avance seule, aucune suite n\'est lancée (une suite rouge ne change rien), code 0, une ligne qui le dit', () => {
  const groupes = [{ nom: 'rouge', fichiers: ['tests/rouge.test.mjs', 'tests/vert.test.mjs'] }];
  const complet = rejouer(['test'], { groupes });
  try {
    assert.equal(complet.code, 2, 'contrôle : sans --valider, la suite rouge sur le code non muté ne conclut rien');
    assert.match(complet.erreurs.join('\n'), /n'est pas verte et complète/);
    assert.match(complet.erreurs.join('\n'), /verdict : test, en échec : déjà rouge, sautés : 0, lancés : 2\)/, 'la suite rouge nomme le test qui échoue (une machine chargée qui en fait échouer un le dit)');
  } finally {
    nettoyer(complet);
  }
  const r = rejouer(['test', 'survivant'], { groupes, valider: true });
  try {
    assert.equal(r.code, 0, r.erreurs.join('\n'));
    assert.deepEqual(r.erreurs, []);
    assert.deepEqual(r.lignes, ["Vérification d'avance : 2 mutants (chaîne d'origine unique, code muté qui compile), 2 fichier(s) de test présent(s), aucun problème ; aucune suite lancée."]);
    assert.equal(r.bilan, null, 'aucun essai : pas de bilan');
    assert.deepEqual(r.copiesRestantes, [], 'sa propre copie est retirée');
  } finally {
    nettoyer(r);
  }
});

test('moteur --valider : les problèmes d\'un mutant sont dits comme au rejeu (code 2), le fichier de test absent aussi', () => {
  const r = rejouer([
    { libelle: 'js cassé', fichier: 'src/f.js', ancien: F_JS, nouveau: 'export const f = () => ;\n' },
    { libelle: 'chaîne absente', fichier: 'src/f.js', ancien: 'n\'existe pas', nouveau: 'x' },
  ], { valider: true, groupes: [{ nom: 'absent', fichiers: ['tests/absent.test.mjs'] }] });
  try {
    assert.equal(r.code, 2);
    const e = r.erreurs.join('\n');
    assert.match(e, /^3 mutant\(s\) à corriger avant de rien conclure/);
    assert.match(e, /groupe « absent » : le fichier de test tests\/absent\.test\.mjs n'existe pas/);
    assert.match(e, /mutant 1 \(js cassé\) : le code muté ne compile pas/);
    assert.match(e, /mutant 2 \(chaîne absente\) : « n'existe pas » trouvé 0 fois/);
    assert.deepEqual(r.lignes, []);
  } finally {
    nettoyer(r);
  }
});

test('moteur --valider : Chromium n\'est pas exigé (rien n\'est lancé), le rejeu complet l\'exige toujours', () => {
  const ancienne = process.env.GWAUDIT_CHROMIUM_PATH;
  delete process.env.GWAUDIT_CHROMIUM_PATH;
  try {
    const r = rejouer(['test'], { exigerChromium: true, valider: true });
    try {
      assert.equal(r.code, 0, r.erreurs.join('\n'));
    } finally {
      nettoyer(r);
    }
    const complet = rejouer(['test'], { exigerChromium: true, valider: false });
    try {
      assert.equal(complet.code, 2);
      assert.match(complet.erreurs.join('\n'), /GWAUDIT_CHROMIUM_PATH est requis/);
    } finally {
      nettoyer(complet);
    }
  } finally {
    if (ancienne === undefined) delete process.env.GWAUDIT_CHROMIUM_PATH; else process.env.GWAUDIT_CHROMIUM_PATH = ancienne;
  }
});

test('moteur --valider : ne retire la copie d\'aucun autre lot (il ne fait que lire), le rejeu, lui, la retire', async () => {
  const pid = await pidMort();
  const abandonnee = `gwaudit-mutants-${pid}-x`;
  const poser = ({ copies }) => fs.mkdirSync(path.join(copies, abandonnee));
  const r = rejouer(['test'], { valider: true }, { avant: poser });
  try {
    assert.equal(r.code, 0, r.erreurs.join('\n'));
    assert.deepEqual(r.copiesRestantes, [abandonnee], 'la copie abandonnée est intacte');
    assert.deepEqual(r.erreurs, []);
  } finally {
    nettoyer(r);
  }
  const complet = rejouer(['test'], {}, { avant: poser });
  try {
    assert.equal(complet.code, 0, complet.erreurs.join('\n'));
    assert.deepEqual(complet.copiesRestantes, [], 'contrôle : le rejeu retire la copie abandonnée');
  } finally {
    nettoyer(complet);
  }
});

test('moteur --valider : l\'option explicite l\'emporte sur la ligne de commande, la ligne de commande décide sinon', () => {
  const groupes = [{ nom: 'rouge', fichiers: ['tests/rouge.test.mjs'] }];
  const parLaLigne = rejouer(['test'], { groupes, argv: ['--valider'] });
  try {
    assert.equal(parLaLigne.code, 0, 'la suite rouge n\'est pas lancée : --valider est lu dans argv');
  } finally {
    nettoyer(parLaLigne);
  }
  const explicite = rejouer(['test'], { groupes, argv: ['--valider'], valider: false });
  try {
    assert.equal(explicite.code, 2, 'valider: false l\'emporte : la suite rouge est lancée et ne conclut rien');
  } finally {
    nettoyer(explicite);
  }
  const autre = rejouer(['test'], { groupes, argv: ['--autre', 'valider'] });
  try {
    assert.equal(autre.code, 2, 'ni « --autre » ni « valider » ne sont --valider');
  } finally {
    nettoyer(autre);
  }
});

test('un lot lancé avec --valider en ligne de commande ne fait que vérifier (le moteur lit process.argv de lui-même)', (t) => {
  const dossier = prive();
  t.after(() => nettoyerDossier(dossier));
  const projet = path.join(dossier, 'projet');
  fs.mkdirSync(path.join(projet, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projet, 'tests'));
  fs.writeFileSync(path.join(projet, 'src/f.js'), F_JS);
  fs.writeFileSync(path.join(projet, 'tests/rouge.test.mjs'), "import test from 'node:test';\ntest('déjà rouge', () => { throw new Error('rouge'); });\n");
  const lot = path.join(dossier, 'lot.mjs');
  fs.writeFileSync(lot, [
    `import { rejouerMutants } from ${JSON.stringify(MODULE_MOTEUR)};`,
    'process.exitCode = rejouerMutants({',
    `  mutants: [{ libelle: 'renvoie 2', fichier: 'src/f.js', ancien: ${JSON.stringify(F_JS)}, nouveau: 'export const f = () => 2;\\n' }],`,
    "  groupes: [{ nom: 'rouge', fichiers: ['tests/rouge.test.mjs'] }], exigerChromium: true, dossiers: ['src', 'tests'],",
    `  racine: ${JSON.stringify(projet)},`,
    '});',
  ].join('\n'));
  const env = { ...process.env, TMPDIR: dossier };
  delete env.GWAUDIT_CHROMIUM_PATH;
  delete env.NODE_TEST_CONTEXT;
  const valider = spawnSync(process.execPath, [lot, '--valider'], { encoding: 'utf8', env });
  assert.equal(valider.status, 0, `${valider.stdout}${valider.stderr}`);
  assert.match(valider.stdout, /^Vérification d'avance : 1 mutants/);
  const complet = spawnSync(process.execPath, [lot], { encoding: 'utf8', env });
  assert.equal(complet.status, 2, `${complet.stdout}${complet.stderr}`);
  assert.match(complet.stderr, /GWAUDIT_CHROMIUM_PATH est requis/, 'sans --valider, le rejeu exige Chromium');
});

test('lireArguments : --valider est lu où qu\'il soit et n\'est jamais un filtre de libellés, les autres arguments gardent leur ordre', () => {
  assert.deepEqual(lireArguments([]), { partie: null, valider: false, restants: [] });
  assert.deepEqual(lireArguments(['--valider']), { partie: null, valider: true, restants: [] });
  assert.deepEqual(lireArguments(['a', '--valider', '--part=2/3', 'b']), { partie: { i: 2, n: 3 }, valider: true, restants: ['a', 'b'] });
  assert.deepEqual(lireArguments(['--valider=1', '--valid', 'valider']), { partie: null, valider: false, restants: ['--valider=1', '--valid', 'valider'] });
});

// --- --part : un lot qui ne la transmet pas est refusé ---------------------------------------------------------

test('moteur : une ligne de commande qui demande --part=i/n sans que le lot transmette la même `partie` est refusée avant tout (code 2), la vérification seule aussi', () => {
  const cas = [
    ['partie absente', { argv: ['--part=1/3'] }, /--part=1\/3.*`partie` absente/s],
    ['partie absente, vérification seule', { argv: ['--valider', '--part=1/3'] }, /--part=1\/3.*`partie` absente/s],
    ['autre paquet', { argv: ['--part=1/3'], partie: { i: 2, n: 3 } }, /--part=1\/3.*reçue : 2\/3/s],
    ['autre nombre de paquets', { argv: ['--part=1/3'], partie: { i: 1, n: 2 } }, /--part=1\/3.*reçue : 1\/2/s],
    ['paquet hors de 1..n', { argv: ['--part=4/3'] }, /--part=4\/3 : i doit être entre 1 et n/],
  ];
  for (const [nom, options, message] of cas) {
    const r = rejouer(['test'], options);
    try {
      assert.equal(r.code, 2, `${nom} : ${r.erreurs.join('\n')}`);
      assert.equal(r.erreurs.length, 1, `${nom} : une seule ligne d'erreur`);
      assert.match(r.erreurs[0], message, nom);
      if (!/hors de/.test(nom)) assert.match(r.erreurs[0], /chaque paquet rejouerait le lot entier/, nom);
      assert.deepEqual(r.lignes, [], `${nom} : rien n'est lancé ni dit`);
      assert.deepEqual(r.copiesRestantes, [], `${nom} : aucune copie n'a été faite`);
      assert.equal(r.bilan, null, nom);
    } finally {
      nettoyer(r);
    }
  }
});

test('moteur : la `partie` transmise telle que la ligne la demande passe, et sans --part dans la ligne le lot fait comme il veut', () => {
  const transmise = rejouer(['test', 'survivant'], { argv: ['--valider', '--part=2/2'], partie: { i: 2, n: 2 } });
  try {
    assert.equal(transmise.code, 0, transmise.erreurs.join('\n'));
  } finally {
    nettoyer(transmise);
  }
  const rejeu = rejouer(['test', 'survivant'], { argv: ['--part=2/2'], partie: { i: 2, n: 2 } });
  try {
    assert.deepEqual(rejeu.bilan.mutants.map((m) => m.libelle), ['équivalent'], 'le paquet 2 sur 2 : seul le deuxième mutant est rejoué');
    assert.ok(rejeu.lignes.includes('Paquet 2/2 : 1 mutants sur 2.\n'));
  } finally {
    nettoyer(rejeu);
  }
  const sansLigne = rejouer(['test', 'survivant'], { argv: [], partie: { i: 1, n: 2 }, valider: true });
  try {
    assert.equal(sansLigne.code, 0, 'pas de --part dans la ligne : rien à comparer, la partie donnée par le lot est la sienne');
  } finally {
    nettoyer(sansLigne);
  }
});
