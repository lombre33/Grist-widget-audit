import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compterLignes, mesurerLignes, NOTE_LIGNES_APPROCHEES } from '../src/moteur/lignes-de-code.js';
import { lire } from '../src/moteur/analyse-js.js';
import { analyserTailleFichiers } from '../src/regles/a-qualite.js';
import { analyserCommentaires, analyserVerbosite } from '../src/regles/b-lisibilite.js';

/**
 * Les lignes d'un fichier JavaScript se comptent sur ce qu'elles portent, avec les commentaires que lit acorn : du code, un commentaire seul,
 * ou rien (voir `src/moteur/lignes-de-code.js`). `locSignificatives`, que l'inventaire pose avant toute lecture, juge une ligne à son premier
 * caractère et se trompe des deux côtés : ces essais comparent les deux sur ce qu'elles ne voient pas, et comparent le compte à un autre
 * calcul, fait ligne par ligne, sur des fichiers tirés au hasard.
 */

const compte = (source) => {
  const { ast, erreur } = lire(source);
  assert.ok(ast, `la source doit se lire : ${erreur?.message}`);
  return compterLignes(source, ast.commentaires);
};

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
}

/** Ce que l'inventaire compte comme `locSignificatives` (reproduit ici : la comparaison dit ce que le compte exact change). */
const approche = (contenu) => contenu.split('\n').filter((l) => { const t = l.trim(); return t && !/^(\/\/|\/\*|\*|#|<!--)/.test(t); }).length;

const CAS = [
  ['un fichier vide', '', { code: 0, commentaire: 0, vide: 0 }],
  ['une ligne de code, saut de ligne final', 'a;\n', { code: 1, commentaire: 0, vide: 0 }],
  ['la dernière ligne sans saut de ligne compte', 'a;\nb;', { code: 2, commentaire: 0, vide: 0 }],
  ['des lignes vides', 'a;\n\n   \n\t\nb;\n', { code: 2, commentaire: 0, vide: 3 }],
  ['un commentaire de bloc dont les lignes n\'ont pas d\'étoile est un commentaire du début à la fin', '/*\n  un\n  deux\n*/\nf();\n', { code: 1, commentaire: 4, vide: 0 }],
  ['une ligne blanche dans un commentaire de bloc est vide, non un commentaire', '/*\n\n*/\n', { code: 0, commentaire: 2, vide: 1 }],
  ['un commentaire de bloc suivi de code sur la même ligne : une ligne de code', '/* x */ f();\n', { code: 1, commentaire: 0, vide: 0 }],
  ['du code suivi d\'un commentaire de ligne : une ligne de code', 'f(); // fin\n', { code: 1, commentaire: 0, vide: 0 }],
  ['du code qui suit la fin d\'un commentaire de bloc sur la même ligne', '/*\n un\n*/ f();\n', { code: 1, commentaire: 2, vide: 0 }],
  ['deux commentaires sur une ligne, séparés d\'un blanc : une ligne de commentaire', '/* a */ /* b */\nf();\n', { code: 1, commentaire: 1, vide: 0 }],
  ['la suite d\'une multiplication qui commence par une étoile est du code', 'const a = 2\n  * 3;\n', { code: 2, commentaire: 0, vide: 0 }],
  ['un champ privé de classe, qui commence par #, est du code', 'class A {\n  #x = 1;\n}\n', { code: 3, commentaire: 0, vide: 0 }],
  ['le contenu d\'un gabarit de plusieurs lignes est du code, même s\'il commence par //, * ou #', 'const t = `\n// pas un commentaire\n* non plus\n# ni cela\n`;\n', { code: 5, commentaire: 0, vide: 0 }],
  ['un // dans une chaîne ou une expression régulière ne fait pas un commentaire', 'const u = \'http://x\';\nconst r = /a\\/\\//;\n', { code: 2, commentaire: 0, vide: 0 }],
  ['des fins de ligne CRLF', 'a;\r\n// c\r\n\r\nb;\r\n', { code: 2, commentaire: 1, vide: 1 }],
  ['des lignes séparées par un seul \\r ne font pas une seule ligne', 'a;\r// c\rb;', { code: 2, commentaire: 1, vide: 0 }],
  ['U+2028 et U+2029 ferment une ligne (comme pour acorn, donc comme les numéros de ligne des constats)', 'a;\u2028// c\u2029b;', { code: 2, commentaire: 1, vide: 0 }],
  ['la marque d\'ordre des octets n\'est pas du code', '\ufeff// c\nf();\n', { code: 1, commentaire: 1, vide: 0 }],
  ['une ligne de blancs de toute sorte est vide', 'a;\n\u00a0\u3000\u2003\n', { code: 1, commentaire: 0, vide: 1 }],
  ['des blancs de tout type, aux bornes de leurs plages, sont du vide', 'a;\n\u1680\u2000\u200a\u202f\u205f\f\u000b\n', { code: 1, commentaire: 0, vide: 1 }],
  ['des commentaires collés sont une ligne de commentaire', '/*a*//*b*/\nf();\n', { code: 1, commentaire: 1, vide: 0 }],
  ['du code collé à la fin d\'un commentaire de bloc est du code', '/* x */f();\n', { code: 1, commentaire: 0, vide: 0 }],
  ['un seul caractère de code collé à la fin d\'un commentaire de bloc est du code', '/* x */;\n', { code: 1, commentaire: 0, vide: 0 }],
  ['un seul caractère de code, au début du texte', 'x', { code: 1, commentaire: 0, vide: 0 }],
  ['une dernière ligne de blancs, sans saut de ligne, est une ligne vide', 'a;\n   ', { code: 1, commentaire: 0, vide: 1 }],
  ['la ligne #! d\'un script est un commentaire', '#!/usr/bin/env node\nf();\n', { code: 1, commentaire: 1, vide: 0 }],
  ['<!-- ouvre un commentaire de ligne dans un script classique', '<!-- ancien\nf();\n', { code: 1, commentaire: 1, vide: 0 }],
];

for (const [nom, source, attendu] of CAS) {
  test(`lignes de code : ${nom}`, () => assert.deepEqual(compte(source), attendu));
}

test('lignes de code : sur un bloc de commentaire sans étoile, le compte exact et celui de l\'inventaire se séparent, dans les deux sens', () => {
  const bloc = ['/*', ...Array.from({ length: 300 }, (_, i) => `   texte ${i}`), '*/'].join('\n');
  const multiplications = Array.from({ length: 100 }, (_, i) => `const m${i} = 2\n  * ${i};`).join('\n');
  const source = `${bloc}\n${multiplications}\n`;
  assert.deepEqual(compte(source), { code: 200, commentaire: 302, vide: 0 });
  assert.equal(approche(source), 400, 'l\'inventaire compte les 300 lignes du bloc pour du code, et ne compte pas les 100 lignes qui commencent par une étoile');
});

/** Un générateur de nombres qui se rejoue : les mêmes fichiers à chaque lancement. */
function hasard(graine) {
  let etat = graine;
  return (n) => { etat = (etat * 1103515245 + 12345) & 0x7fffffff; return etat % n; };
}

const MORCEAUX = [
  'f();', 'a = 1 + 2;', '// un commentaire', '/* un bloc */', '/*\n un bloc\n sur trois lignes\n*/', '   ', '',
  'x = 1; // fin de ligne', '/* a */ y = 2;', 's = `\n// dans un gabarit\n* ici aussi\n`;', 'u = "http://hote/chemin";',
  'if (a) {\n  b(); // dedans\n}', 'v = 2\n  * 3;', 'g(/* au milieu */ 4);', '/** @param {number} n */', 'r = /\\/\\//; /* après */',
  '\ufeff// marque d\'ordre', 'k = `a\r\n// b`;',
];
const FINS = ['\n', '\r\n', '\n', '\n\n'];

/** Le même compte, fait autrement : un tableau de booléens par caractère, puis la coupe en lignes, puis un jugement par ligne. */
function compteALaPlainCoupe(source, commentaires) {
  const dansCommentaire = new Array(source.length).fill(false);
  for (const c of commentaires) for (let i = c.debut; i < c.fin; i++) dansCommentaire[i] = true;
  let code = 0, commentaire = 0, vide = 0;
  const classer = (a, b) => {
    let porteDuCode = false, porteUnCommentaire = false;
    for (let i = a; i < b; i++) {
      if (source[i].trim() === '') continue;
      if (dansCommentaire[i]) porteUnCommentaire = true; else porteDuCode = true;
    }
    if (porteDuCode) code++; else if (porteUnCommentaire) commentaire++; else vide++;
  };
  let debut = 0;
  for (const m of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    classer(debut, m.index);
    debut = m.index + m[0].length;
  }
  if (debut < source.length) classer(debut, source.length);       // ce qui suit la dernière fin de ligne n'est une ligne que s'il y a quelque chose
  return { code, commentaire, vide };
}

test('lignes de code : le compte d\'un fichier tiré au hasard est celui d\'un calcul fait autrement, ligne par ligne', () => {
  const tirer = hasard(20261001);
  let essais = 0;
  for (let k = 0; k < 400; k++) {
    const nombre = 1 + tirer(14);
    let source = '';
    for (let i = 0; i < nombre; i++) source += MORCEAUX[tirer(MORCEAUX.length)] + FINS[tirer(FINS.length)];
    if (tirer(4) === 0) source = source.replace(/\n$/, '');         // sans saut de ligne final, pour un tiers des fichiers
    const { ast } = lire(source);
    if (!ast) continue;                                             // un tirage qui ne se lit pas (accolade ouverte) n'a pas de commentaires à relever
    essais++;
    assert.deepEqual(compterLignes(source, ast.commentaires), compteALaPlainCoupe(source, ast.commentaires), JSON.stringify(source));
  }
  assert.ok(essais > 150, `assez de tirages se lisent pour que l'essai compte (${essais})`);
});

test('lignes de code : code + commentaire + vide est le nombre de lignes du fichier', () => {
  const tirer = hasard(7);
  for (let k = 0; k < 200; k++) {
    let source = '';
    for (let i = 0; i < 1 + tirer(10); i++) source += MORCEAUX[tirer(MORCEAUX.length)] + FINS[tirer(FINS.length)];
    const { ast } = lire(source);
    if (!ast) continue;
    const { code, commentaire, vide } = compterLignes(source, ast.commentaires);
    const lignes = source.split(/\r\n|[\n\r\u2028\u2029]/);
    if (lignes.at(-1) === '') lignes.pop();
    assert.equal(code + commentaire + vide, lignes.length, JSON.stringify(source));
  }
});

test('mesurerLignes : un fichier lu par acorn est compté sur ses commentaires, `exacte` vrai, et le résultat se garde par fichier', () => {
  const f = fichier('app.js', '/*\n un\n*/\nf();\n', { locSignificatives: 4 });
  const mesure = mesurerLignes(f);
  assert.deepEqual(mesure, { code: 1, commentaire: 3, vide: 0, exacte: true });
  assert.equal(mesurerLignes(f), mesure, 'le même objet : la lecture du fichier n\'est pas refaite pour chaque règle qui compte ses lignes');
});

test('mesurerLignes : un fichier que la mesure compte sans inventaire (aucune `locSignificatives`) est compté de même', () => {
  assert.equal(mesurerLignes(fichier('seul.js', 'a;\nb;\n')).code, 2);
});

test('NOTE_LIGNES_APPROCHEES : dit que les lignes sont comptées d\'après leur premier caractère, parce qu\'acorn ne lit pas le fichier', () => {
  assert.match(NOTE_LIGNES_APPROCHEES, /premier caractère/);
  assert.match(NOTE_LIGNES_APPROCHEES, /acorn ne lit pas ce fichier/);
});

test('mesurerLignes : un fichier qu\'acorn ne lit pas (JSX) est compté d\'après le premier caractère, et le dit (`exacte` faux)', () => {
  const contenu = '// en-tête\n/**\n * doc\n */\nconst a = <div>x</div>;\n/* b */\nconst b = 2;\n';
  const f = fichier('vue.js', contenu, { locSignificatives: approche(contenu) });
  assert.deepEqual(mesurerLignes(f), { code: 2, commentaire: 5, vide: 0, exacte: false });
});

test('mesurerLignes : un fichier de l\'inventaire dont le texte n\'a pas été lu garde le compte de l\'inventaire, ou zéro', () => {
  assert.deepEqual(mesurerLignes({ chemin: 'x.js', ext: '.js', binaire: true, locSignificatives: 7 }), { code: 7, commentaire: 0, vide: 0, exacte: false });
  assert.deepEqual(mesurerLignes({ chemin: 'y.js', ext: '.js', binaire: true }), { code: 0, commentaire: 0, vide: 0, exacte: false });
});

// ---------------------------------------------------------------------------------------------------------------------
// Les règles qui comptent des lignes

test('A-TAILLE-01 : un fichier dont 300 lignes sont un commentaire de bloc sans étoile n\'est pas long (l\'inventaire en comptait 750)', () => {
  const bloc = ['/*', ...Array.from({ length: 300 }, (_, i) => `   texte ${i}`), '*/'].join('\n');
  const code = Array.from({ length: 450 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const contenu = `${bloc}\n${code}\n`;
  assert.equal(approche(contenu), 750);
  assert.deepEqual(analyserTailleFichiers({ fichiers: [fichier('gros.js', contenu, { locSignificatives: approche(contenu) })] }), []);
});

test('A-TAILLE-01 : des lignes de code qui commencent par une étoile comptent pour du code (l\'inventaire n\'en comptait que 310 sur 620)', () => {
  const code = Array.from({ length: 310 }, (_, i) => `const v${i} = ${i}\n  * 2;`).join('\n');
  const f = fichier('gros.js', code, { locSignificatives: approche(code) });
  assert.equal(f.locSignificatives, 310);
  const [c, ...autres] = analyserTailleFichiers({ fichiers: [f] });
  assert.equal(autres.length, 0);
  assert.equal(c.regle, 'A-TAILLE-01');
  assert.equal(c.severite, 'mineur');
  assert.equal(c.titre, 'Fichier de 620 lignes de code : gros.js');
  assert.ok(!c.constat.includes(NOTE_LIGNES_APPROCHEES), 'le fichier est lu : le compte est exact, rien à dire');
});

test('A-TAILLE-01 : les seuils sont 600 lignes (mineur) et 1 200 lignes (majeur), au-delà et non à', () => {
  const fait = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n');
  const rendu = (n) => analyserTailleFichiers({ fichiers: [fichier('a.js', fait(n))] }).map((c) => c.severite);
  assert.deepEqual([rendu(600), rendu(601), rendu(1200), rendu(1201)], [[], ['mineur'], ['mineur'], ['majeur']]);
});

test('A-TAILLE-01 : les fichiers longs se rangent du plus long au plus court, par leurs lignes de code', () => {
  const fait = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n');
  const constats = analyserTailleFichiers({ fichiers: [fichier('a.js', fait(700)), fichier('b.js', fait(900)), fichier('c.js', fait(650))] });
  assert.deepEqual(constats.map((c) => c.fichier), ['b.js', 'a.js', 'c.js']);
});

test('A-TAILLE-01 : un fichier qu\'acorn ne lit pas est compté d\'après le premier caractère, et le constat le dit', () => {
  const contenu = `${Array.from({ length: 700 }, (_, i) => `const v${i} = <b>${i}</b>;`).join('\n')}\n`;
  const [c] = analyserTailleFichiers({ fichiers: [fichier('vue.js', contenu, { locSignificatives: approche(contenu) })] });
  assert.equal(c.titre, 'Fichier de 700 lignes de code : vue.js');
  assert.ok(c.constat.endsWith(NOTE_LIGNES_APPROCHEES));
});

test('A-TAILLE-01 : un fichier vendorisé, un fichier non exécuté et un fichier d\'une autre extension ne sont pas comptés', () => {
  const long = Array.from({ length: 700 }, (_, i) => `const v${i} = ${i};`).join('\n');
  assert.deepEqual(analyserTailleFichiers({ fichiers: [fichier('v.js', long, { vendorise: true }), fichier('n.js', long, { executee: false }), fichier('t.ts', long), fichier('e.js', long, { dossierExclu: true })] }), []);
});

test('B-COM-01 : 20 lignes de commentaire de bloc sans étoile pour 250 lignes de code ne sont pas « quasiment aucun commentaire »', () => {
  const contenu = `/*\n${Array.from({ length: 18 }, (_, i) => `  explication ${i}`).join('\n')}\n*/\n${Array.from({ length: 250 }, (_, i) => `const v${i} = ${i};`).join('\n')}\n`;
  assert.equal(analyserCommentaires({ fichiers: [fichier('app.js', contenu)] }).length, 0);
});

test('B-COM-01 : 100 lignes de code qui commencent par une étoile ne sont pas des lignes de commentaire', () => {
  const contenu = Array.from({ length: 250 }, (_, i) => (i % 5 === 0 ? `const a${i} = 2\n  * 3;` : `const v${i} = ${i};`)).join('\n');
  const [c] = analyserCommentaires({ fichiers: [fichier('app.js', contenu)] });
  assert.ok(c, 'aucun commentaire : le constat se déclenche');
  assert.equal(c.titre, 'Fichier de 300 lignes quasiment sans commentaire : app.js');
  assert.match(c.constat, /^0 ligne\(s\) de commentaire pour 300 lignes de code \(0 %\)\.$/);
});

test('B-COM-01 : sous 200 lignes de code, un fichier sans commentaire n\'est pas relevé ; à 200, il l\'est', () => {
  const fait = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n');
  assert.equal(analyserCommentaires({ fichiers: [fichier('a.js', fait(199))] }).length, 0);
  assert.equal(analyserCommentaires({ fichiers: [fichier('a.js', fait(200))] }).length, 1);
});

test('B-COM-01 : la densité de 4 % est le seuil (8 lignes de commentaire pour 200 de code ne sont pas relevées, 7 le sont)', () => {
  const fait = (commentaires) => `${Array.from({ length: commentaires }, (_, i) => `// ligne ${i}`).join('\n')}\n${Array.from({ length: 200 }, (_, i) => `const v${i} = ${i};`).join('\n')}\n`;
  assert.equal(analyserCommentaires({ fichiers: [fichier('a.js', fait(8))] }).length, 0);
  assert.equal(analyserCommentaires({ fichiers: [fichier('a.js', fait(7))] }).length, 1);
});

test('B-COM-01 : un fichier qu\'acorn ne lit pas est compté d\'après le premier caractère, et le constat le dit', () => {
  const contenu = `${Array.from({ length: 300 }, (_, i) => `const v${i} = <b>${i}</b>;`).join('\n')}\n`;
  const [c] = analyserCommentaires({ fichiers: [fichier('vue.js', contenu, { locSignificatives: approche(contenu) })] });
  assert.ok(c.constat.endsWith(NOTE_LIGNES_APPROCHEES));
});

test('B-VERB-01 : le volume est la somme des lignes de code des fichiers exécutés, plus les lignes de HTML', () => {
  const fait = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n');
  const commente = `/*\n${Array.from({ length: 2000 }, (_, i) => `  texte ${i}`).join('\n')}\n*/\n${fait(2000)}\n`;
  const html = `${Array.from({ length: 5 }, (_, i) => `<p>${i}</p>`).join('\n')}\n`;
  const rendu = (fichiers) => analyserVerbosite({ fichiers });
  assert.equal(rendu([fichier('a.js', commente), fichier('b.js', fait(2000))]).length, 0, '4 000 lignes de code, pas plus : sous le seuil (le bloc sans étoile n\'est pas du code)');
  const [c] = rendu([fichier('a.js', commente), fichier('b.js', fait(2001))]);
  assert.equal(c.severite, 'mineur');
  assert.equal(c.constat, '2 fichier(s) JavaScript pour 4001 lignes de code, plus 0 lignes de HTML.');
  const [avecHtml] = rendu([fichier('a.js', commente), fichier('b.js', fait(2000)), fichier('index.html', html, { locSignificatives: 5 })]);
  assert.equal(avecHtml.titre, '4005 lignes de code exécuté : le widget dépasse ce qu\'une revue bénévole absorbe');
});

test('B-VERB-01 : à plus de 12 000 lignes, le constat est majeur ; à 12 000, il est mineur', () => {
  const fait = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n');
  const gravite = (n) => analyserVerbosite({ fichiers: [fichier('a.js', fait(n / 2)), fichier('b.js', fait(n / 2))] }).map((c) => c.severite);
  assert.deepEqual([gravite(12000), gravite(12002)], [['mineur'], ['majeur']]);
});
