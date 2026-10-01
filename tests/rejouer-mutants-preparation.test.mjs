/**
 * Le moteur de mutants avant le premier essai : ce qu'il vérifie sur les
 * mutants (et dit d'un coup), la copie qu'il prépare, ce qu'il exige et ce
 * qu'il fait sans qu'on le lui demande. Voir aussi `rejouer-mutants-issues.test.mjs`
 * (les issues d'un mutant) ; chaque comportement a son mutant :
 * `scripts/mutants-rejouer.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { preconditionTraversable } from '../scripts/lib/rejouer-mutants.mjs';
import { F_JS, MODULE_MOTEUR, MUTANTS, attendreLaMort, creerProjet, nettoyer, nettoyerDossier, prive, rejouer } from './aide-moteur-mutants.mjs';

const FICHIERS_DIVERS = { 'src/g.sh': 'echo ok\n', 'src/h.mjs': 'export const h = 1;\n', 'src/i.cjs': 'module.exports = 1;\n', 'src/donnees.txt': 'a\n' };

test('moteur : chaque problème d\'un mutant est dit avant tout essai, tous d\'un coup (code 2), et un mutant valide n\'en est pas un', () => {
  const r = rejouer([
    { libelle: 'fichier absent', fichier: 'src/absent.js', ancien: 'a', nouveau: 'b' },
    { libelle: 'identique', fichier: 'src/f.js', ancien: F_JS, nouveau: F_JS },
    { libelle: 'js cassé', fichier: 'src/f.js', ancien: F_JS, nouveau: 'export const f = () => ;\n' },
    { libelle: 'mjs cassé', fichier: 'src/h.mjs', ancien: 'export const h = 1;\n', nouveau: 'export const h = ;\n' },
    { libelle: 'cjs cassé', fichier: 'src/i.cjs', ancien: 'module.exports = 1;\n', nouveau: 'module.exports = ;\n' },
    { libelle: 'sh cassé', fichier: 'src/g.sh', ancien: 'echo ok\n', nouveau: 'if true; then\n' },
    MUTANTS.test,
    { libelle: 'chaîne absente', fichier: 'src/f.js', ancien: 'n\'existe pas', nouveau: 'x' },
    { libelle: 'chaîne en double', fichier: 'src/f.js', ancien: 'o', nouveau: 'x' },
  ], {}, { fichiers: FICHIERS_DIVERS });
  try {
    assert.equal(r.code, 2);
    const e = r.erreurs.join('\n');
    assert.match(e, /^8 mutant\(s\) à corriger avant de rien conclure/);
    assert.match(e, /mutant 1 \(fichier absent\) : src\/absent\.js n'existe pas/);
    assert.match(e, /mutant 2 \(identique\) : la chaîne mutée est identique à l'originale/);
    for (const [n, nom] of [[3, 'js cassé'], [4, 'mjs cassé'], [5, 'cjs cassé'], [6, 'sh cassé']]) assert.match(e, new RegExp(`mutant ${n} \\(${nom}\\) : le code muté ne compile pas`));
    assert.doesNotMatch(e, /mutant 7 /, 'le mutant valide, après un mutant cassé du même fichier, est jugé sur le fichier d\'origine');
    assert.match(e, /mutant 8 \(chaîne absente\) : « n'existe pas » trouvé 0 fois dans src\/f\.js, exactement une attendue/);
    assert.match(e, /mutant 9 \(chaîne en double\) : « o » trouvé 2 fois dans src\/f\.js, exactement une attendue/);
    assert.equal(r.lignes.length, 0, 'aucun essai n\'a été lancé');
    assert.deepEqual(r.copiesRestantes, []);
  } finally {
    nettoyer(r);
  }
});

test('moteur : un fichier d\'un autre type (texte, Dockerfile…) n\'a pas d\'analyse : le mutant se pose, et survit si aucun test ne le lit', () => {
  const r = rejouer([{ libelle: 'texte', fichier: 'src/donnees.txt', ancien: 'a\n', nouveau: 'b (( {\n' }], {}, { fichiers: FICHIERS_DIVERS });
  try {
    assert.equal(r.code, 1);
    assert.equal(r.bilan.mutants[0].issue, 'survit');
    assert.deepEqual(r.erreurs, []);
  } finally {
    nettoyer(r);
  }
});

test('moteur : la copie a la forme attendue (dossiers demandés, package.json, node_modules lié, lisible, chemin réel, dans TMPDIR) ; un dossier demandé qui n\'existe pas est ignoré', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'copie', fichiers: ['tests/f.test.mjs', 'tests/copie.test.mjs'] }], dossiers: ['src', 'tests', 'absent'] });
  try {
    assert.equal(r.code, 0, r.erreurs.join('\n'));
    assert.equal(r.bilan.tuesParUnTest, 1);
  } finally {
    nettoyer(r);
  }
});

test('moteur : les dossiers copiés par défaut sont ceux du dépôt (src, tests, fixtures, scripts)', () => {
  const r = rejouer(['test'], { groupes: [{ nom: 'copie', fichiers: ['tests/f.test.mjs', 'tests/copie-par-defaut.test.mjs'] }], dossiers: undefined });
  try {
    assert.equal(r.code, 0, r.erreurs.join('\n'));
    assert.equal(r.bilan.tuesParUnTest, 1);
  } finally {
    nettoyer(r);
  }
});

test('moteur : un TMPDIR qui passe par un lien symbolique ne change rien : l\'orphelin d\'un délai est tué quand même', async () => {
  const r = rejouer(['orphelin'], { delaiMs: 4500 }, { lienTmp: true });
  try {
    assert.equal(r.bilan.tuesParUnDelai, 1);
    assert.ok(await attendreLaMort(Number(fs.readFileSync(r.fichierPid, 'utf8'))), 'l\'orphelin est mort (son répertoire courant est le chemin réel de la copie)');
    assert.deepEqual(r.copiesRestantes, []);
  } finally {
    nettoyer(r);
  }
});

test('moteur : exigerChromium sans GWAUDIT_CHROMIUM_PATH ne lance rien (code 2) ; avec, la suite se lance', () => {
  const ancienne = process.env.GWAUDIT_CHROMIUM_PATH;
  try {
    delete process.env.GWAUDIT_CHROMIUM_PATH;
    const sans = rejouer(['test'], { exigerChromium: true });
    try {
      assert.equal(sans.code, 2);
      assert.match(sans.erreurs.join('\n'), /GWAUDIT_CHROMIUM_PATH est requis/);
      assert.equal(sans.lignes.length, 0);
      assert.deepEqual(sans.copiesRestantes, [], 'aucune copie n\'a été faite');
    } finally {
      nettoyer(sans);
    }
    process.env.GWAUDIT_CHROMIUM_PATH = '/quelque/part';
    const avec = rejouer(['test'], { exigerChromium: true, uid: 1000 });   // pas root : la traversée des dossiers n'est pas ce que cet essai éprouve
    try {
      assert.equal(avec.code, 0);
    } finally {
      nettoyer(avec);
    }
  } finally {
    if (ancienne === undefined) delete process.env.GWAUDIT_CHROMIUM_PATH; else process.env.GWAUDIT_CHROMIUM_PATH = ancienne;
  }
});

test('moteur : aucun mutant retenu, rien à rejouer (code 2)', () => {
  const r = rejouer([]);
  try {
    assert.equal(r.code, 2);
    assert.deepEqual(r.erreurs, ['Aucun mutant retenu : rien à rejouer.']);
    assert.equal(r.lignes.length, 0);
  } finally {
    nettoyer(r);
  }
});

test('moteur : sans options, les lignes vont sur la sortie standard et les erreurs sur l\'erreur standard, Chromium est exigé, les dossiers par défaut sont copiés', () => {
  const dossier = prive();
  const copies = path.join(dossier, 'tmp');
  fs.mkdirSync(copies);
  const projet = creerProjet(dossier);
  const script = path.join(dossier, 'lot.mjs');
  fs.writeFileSync(script, [
    `import { rejouerMutants } from ${JSON.stringify(MODULE_MOTEUR)};`,
    'const [racine, mode] = process.argv.slice(2);',
    `const mutant = ${JSON.stringify(MUTANTS.test)};`,
    "const groupes = [{ nom: 'essai', fichiers: ['tests/f.test.mjs', 'tests/copie-par-defaut.test.mjs'] }];",
    'const options = { vide: { mutants: [], exigerChromium: false }, chromium: { mutants: [mutant] }, ok: { mutants: [mutant], exigerChromium: false } }[mode];',
    'process.exitCode = rejouerMutants({ groupes, racine, ...options });',
  ].join('\n'));
  const sansChromium = { ...process.env, TMPDIR: copies };
  delete sansChromium.GWAUDIT_CHROMIUM_PATH;
  const lancer = (mode) => spawnSync(process.execPath, [script, projet, mode], { encoding: 'utf8', env: sansChromium });
  try {
    const ok = lancer('ok');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^Suite non mutée : 2 tests, 0 sauté, 1 mutants à rejouer\.\n/);
    assert.match(ok.stdout, /\n1\/1 mutants tués : 1 par un test, 0 par un délai ; 0 plantage ; 0 survivant\n$/);
    assert.equal(ok.stderr, '');

    const vide = lancer('vide');
    assert.equal(vide.status, 2);
    assert.equal(vide.stdout, '');
    assert.match(vide.stderr, /^Aucun mutant retenu : rien à rejouer\.\n$/);

    const chromium = lancer('chromium');
    assert.equal(chromium.status, 2);
    assert.equal(chromium.stdout, '');
    assert.match(chromium.stderr, /^GWAUDIT_CHROMIUM_PATH est requis/);
  } finally {
    nettoyerDossier(dossier);
  }
});

// --- le dossier temporaire des suites ------------------------------------------------------------------------------

const POSE_DANS_TMP = [
  "import test from 'node:test';",
  "import fs from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "import { f } from '../src/f.js';",
  "test('pose un dossier dans le dossier temporaire, puis appelle f', () => {",
  "  const laisse = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-laisse-par-un-essai-'));",
  "  fs.appendFileSync(process.env.ESSAI_MOTEUR_PID, `${laisse}\\n`);",
  '  f();',
  '});',
].join('\n');

test('moteur : ce qu\'un essai tué par le délai laisse dans le dossier temporaire part avec la copie (les suites ont leur TMPDIR, à côté de la copie)', () => {
  const groupes = [{ nom: 'essai', fichiers: ['tests/pose-dans-tmp.test.mjs'] }];
  const r = rejouer(['delai', 'survivant'], { groupes, delaiMs: 4000 }, { fichiers: { 'tests/pose-dans-tmp.test.mjs': POSE_DANS_TMP } });
  try {
    assert.equal(r.bilan.mutants[0].issue, 'delai', 'contrôle : le mutant est tué par le délai, l\'essai n\'a pas pu nettoyer');
    const posees = fs.readFileSync(r.fichierPid, 'utf8').trim().split('\n');
    assert.equal(posees.length, 3, 'la suite non mutée et chacun des deux mutants ont posé leur dossier');
    for (const d of posees) {
      assert.match(d, new RegExp(`^${r.copies.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/gwaudit-mutants-${process.pid}-[^/]+-tmp/gwaudit-laisse-par-un-essai-`), 'dans le dossier temporaire de la copie, pas dans celui du lot');
      assert.ok(!fs.existsSync(d), `${d} a disparu avec la copie`);
    }
    assert.deepEqual(r.copiesRestantes, [], 'ni la copie ni son dossier temporaire ne restent');
  } finally {
    nettoyer(r);
  }
});

test('moteur : le dossier temporaire des suites est retiré aussi quand la copie ne peut pas se faire jusqu\'au bout (mutant refusé), et un lot tué le laisse au lot suivant, qui le balaie avec la copie', () => {
  const r = rejouer([{ libelle: 'chaîne absente', fichier: 'src/f.js', ancien: 'n\'existe pas', nouveau: 'x' }]);
  try {
    assert.equal(r.code, 2);
    assert.deepEqual(r.copiesRestantes, [], 'refusé avant tout essai : la copie et son dossier temporaire sont retirés');
  } finally {
    nettoyer(r);
  }
});

// --- la précondition de traversée (o+x) -----------------------------------------------------------------------------

/** Un lot qui exige Chromium ne démarre pas sans sa variable ; rien n'est lancé de ce que la variable désigne (la suite des essais est `f.test.mjs`). */
function avecChromium(t) {
  const ancienne = process.env.GWAUDIT_CHROMIUM_PATH;
  process.env.GWAUDIT_CHROMIUM_PATH = '/nulle/part/chromium';
  t.after(() => { if (ancienne === undefined) delete process.env.GWAUDIT_CHROMIUM_PATH; else process.env.GWAUDIT_CHROMIUM_PATH = ancienne; });
}
const fermer = ({ dossier }) => fs.chmodSync(dossier, 0o700);

test('moteur : sous root, un lot qui exige Chromium refuse un dossier temporaire que les autres utilisateurs ne peuvent pas traverser (code 2, avant toute copie), et dit lequel', (t) => {
  avecChromium(t);
  const r = rejouer(['test'], { uid: 0, exigerChromium: true }, { avant: fermer });
  try {
    assert.equal(r.code, 2, r.erreurs.join('\n'));
    assert.equal(r.erreurs.length, 1);
    assert.ok(r.erreurs[0].startsWith(`${fs.realpathSync(r.dossier)} n'est pas traversable par les autres utilisateurs (o+x absent, mode 700)`), r.erreurs[0]);
    assert.match(r.erreurs[0], /TMPDIR=\/tmp/, 'et dit quoi faire');
    assert.deepEqual(r.lignes, []);
    assert.deepEqual(r.copiesRestantes, []);
  } finally {
    nettoyer(r);
  }
});

test('moteur : sous root, c\'est le chemin réel du dossier temporaire qui est jugé, pas celui du lien par lequel on y passe', (t) => {
  avecChromium(t);
  const autre = prive();
  t.after(() => nettoyerDossier(autre));
  fs.chmodSync(autre, 0o755);
  const r = rejouer(['test'], { uid: 0, exigerChromium: true }, {
    avant: ({ copies, dossier }) => {
      fs.symlinkSync(copies, path.join(autre, 'lien'));
      process.env.TMPDIR = path.join(autre, 'lien');   // os.tmpdir() : c'est par ce lien, dont le dossier est ouvert, que le moteur va ; le dossier qu'il désigne est dans un dossier fermé
      fs.chmodSync(dossier, 0o700);
    },
  });
  try {
    assert.equal(r.code, 2, r.erreurs.join('\n'));
    assert.ok(r.erreurs[0].startsWith(`${fs.realpathSync(r.dossier)} n'est pas traversable`), r.erreurs[0]);
  } finally {
    nettoyer(r);
  }
});

test('moteur : sans `uid` donné, c\'est l\'utilisateur du processus qui décide de la précondition de traversée', (t) => {
  avecChromium(t);
  const r = rejouer(['test'], { exigerChromium: true }, { avant: fermer });
  try {
    assert.equal(r.code, process.getuid?.() === 0 ? 2 : 0, r.erreurs.join('\n'));
  } finally {
    nettoyer(r);
  }
});

test('moteur : la précondition de traversée ne s\'applique ni hors root, ni sans Chromium, ni à la vérification seule ; traversable, le lot se lance', (t) => {
  avecChromium(t);
  for (const [nom, options, avant] of [
    ['pas root', { uid: 1000, exigerChromium: true }, fermer],
    ['sans notion d\'utilisateur (Windows)', { uid: null, exigerChromium: true }, fermer],
    ['sans Chromium', { uid: 0, exigerChromium: false }, fermer],
    ['vérification seule', { uid: 0, exigerChromium: true, valider: true }, fermer],
    ['root, tout est traversable', { uid: 0, exigerChromium: true }, ({ dossier }) => fs.chmodSync(dossier, 0o755)],
  ]) {
    const r = rejouer(['test'], options, { avant });
    try {
      assert.equal(r.code, 0, `${nom} : ${r.erreurs.join('\n')}`);
      assert.doesNotMatch(r.erreurs.join('\n'), /traversable/, nom);
    } finally {
      nettoyer(r);
    }
  }
});

test('preconditionTraversable : chaque dossier de / à la copie doit avoir o+x ; le premier qui ne l\'a pas est nommé, avec son mode ; un dossier illisible est dit', () => {
  const modes = { '/': 0o755, '/tmp': 0o1777, '/tmp/a': 0o750, '/tmp/a/b': 0o700, '/tmp/c': 0o701 };
  const statut = (c) => { if (!(c in modes)) throw Object.assign(new Error('non'), { code: 'ENOENT' }); return { mode: 0o040000 | modes[c] }; };
  assert.equal(preconditionTraversable('/tmp', { uid: 0, statut }), null);
  assert.equal(preconditionTraversable('/tmp/c', { uid: 0, statut }), null, 'o+x seul suffit (701)');
  assert.match(preconditionTraversable('/tmp/a/b', { uid: 0, statut }), /^\/tmp\/a\/b n'est pas traversable .*mode 700\)/, 'du plus profond au plus haut : le plus profond d\'abord');
  assert.match(preconditionTraversable('/tmp/a', { uid: 0, statut }), /^\/tmp\/a n'est pas traversable .*mode 750\)/, 'o+x absent : 750 ne suffit pas');
  assert.equal(preconditionTraversable('/tmp/a/../c', { uid: 0, statut }), null, 'le chemin est résolu avant d\'être remonté');
  assert.match(preconditionTraversable('/tmp/absent', { uid: 0, statut }), /^\/tmp\/absent : illisible \(ENOENT\)/);
  const seulLaRacineFerme = (c) => ({ mode: 0o040000 | (c === '/' ? 0o700 : 0o755) });
  assert.match(preconditionTraversable('/tmp', { uid: 0, statut: seulLaRacineFerme }), /^\/ n'est pas traversable/, 'la racine aussi est vérifiée, et la remontée s\'y arrête');
  assert.equal(preconditionTraversable('/tmp/a/b', { uid: 1000, statut }), null, 'pas root : rien à vérifier');
  assert.equal(preconditionTraversable('/tmp/a/b', { uid: null, statut }), null, 'sans notion d\'utilisateur (Windows) : rien à vérifier');
  assert.equal(preconditionTraversable('/tmp/a/b', { uid: 0, exigerChromium: false, statut }), null, 'sans Chromium : rien à vérifier');
});
