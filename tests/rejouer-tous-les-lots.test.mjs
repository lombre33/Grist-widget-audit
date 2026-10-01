/**
 * `scripts/rejouer-tous-les-lots.mjs` : rejouer tous les lots de mutants et additionner ce que chacun a imprimé, sans rien laisser passer :
 * un lot qui ne se vérifie pas, un paquet qui ne dit rien, un lot qui rejouerait tout dans chaque paquet, un survivant, un plantage, un mutant non
 * jugé. Les lots ici sont de faux lots (un petit script qui imprime le bilan que le vrai moteur imprimerait) : ce qu'on éprouve est l'addition et
 * ses refus, pas les mutants.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lireBilan, paquetsPour, rejouerTousLesLots } from '../scripts/rejouer-tous-les-lots.mjs';

const PILOTE = fileURLToPath(new URL('../scripts/rejouer-tous-les-lots.mjs', import.meta.url));

/**
 * Un faux lot. `n` mutants ; les issues qui ne sont pas « tué par un test » sont toutes dans le paquet 1 ; `ignorePart` : chaque paquet rejoue le lot entier ;
 * `planter` : sort en 1 sans rien imprimer ; `valider` : le code de sa vérification d'avance ; `rendezVous` : attend (jusqu'à 5 s) d'avoir
 * `rendezVous` lots vivants à la fois, et note combien il en a vus dans `vus.log` ; `marque` : un fichier posé quand le lot se lance pour de vrai.
 */
function fauxLot(dossier, nom, { n, delai = 0, plantages = 0, survivants = 0, nonJuges = 0, ignorePart = false, planter = false, valider = 0, rendezVous = 0, lignes = [] }) {
  const fichier = path.join(dossier, nom);
  fs.writeFileSync(fichier, `
import fs from 'node:fs';
import path from 'node:path';
const dossier = ${JSON.stringify(dossier)};
const argv = process.argv.slice(2);
if (process.env.NODE_TEST_CONTEXT) process.exit(97);   // un lot lancé par un essai ne doit pas croire qu'il en est un
if (argv.includes('--valider')) { console.log("Vérification d'avance : ${n} mutants (chaîne d'origine unique, code muté qui compile), aucune suite lancée."); process.exit(${valider}); }
fs.writeFileSync(path.join(dossier, ${JSON.stringify(nom + '.lance')}), argv.join(' '));
const verrou = path.join(dossier, 'vivant-' + process.pid);
fs.writeFileSync(verrou, '');
const vivants = () => fs.readdirSync(dossier).filter((f) => f.startsWith('vivant-')).length;
if (${rendezVous}) { const fin = Date.now() + 5000; while (vivants() < ${rendezVous} && Date.now() < fin) await new Promise((r) => setTimeout(r, 20)); }
fs.appendFileSync(path.join(dossier, 'vus.log'), ${JSON.stringify(nom)} + ' ' + vivants() + '\\n');
await new Promise((r) => setTimeout(r, 60));
fs.rmSync(verrou);
if (${planter}) process.exit(1);
const m = /--part=(\\d+)\\/(\\d+)/.exec(argv.join(' '));
const [i, k] = m ? [Number(m[1]), Number(m[2])] : [1, 1];
let retenus = 0;
for (let j = 0; j < ${n}; j++) if (${ignorePart} || j % k === i - 1) retenus++;
const speciaux = i === 1 ? { delai: ${delai}, plantages: ${plantages}, survivants: ${survivants}, nonJuges: ${nonJuges} } : { delai: 0, plantages: 0, survivants: 0, nonJuges: 0 };
const test = retenus - speciaux.delai - speciaux.plantages - speciaux.survivants - speciaux.nonJuges;
if (i === 1) for (const l of ${JSON.stringify(lignes)}) console.log(l);
const s = (x) => (x > 1 ? 's' : '');
console.log('\\n' + (test + speciaux.delai) + '/' + retenus + ' mutants tués : ' + test + ' par un test, ' + speciaux.delai + ' par un délai ; ' + speciaux.plantages + ' plantage' + s(speciaux.plantages) + ' ; ' + speciaux.survivants + ' survivant' + s(speciaux.survivants) + (speciaux.nonJuges ? ' ; ' + speciaux.nonJuges + ' non jugé' + s(speciaux.nonJuges) : ''));
process.exit(speciaux.plantages || speciaux.survivants || speciaux.nonJuges ? 1 : 0);
`);
}

function essai(lots, options = {}) {
  const dossier = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-tous-lots-')));
  for (const [nom, cfg] of Object.entries(lots)) fauxLot(dossier, nom, cfg);
  const lignes = [];
  const erreurs = [];
  return {
    dossier, lignes, erreurs,
    rejouer: async (opts = {}) => {
      const code = await rejouerTousLesLots({ dossier, sortie: (l) => lignes.push(l), erreur: (l) => erreurs.push(l), travailleurs: 2, parPaquet: 60, ...options, ...opts });
      return code;
    },
    lance: (nom) => fs.existsSync(path.join(dossier, `${nom}.lance`)) ? fs.readFileSync(path.join(dossier, `${nom}.lance`), 'utf8') : null,
    vus: () => (fs.existsSync(path.join(dossier, 'vus.log')) ? fs.readFileSync(path.join(dossier, 'vus.log'), 'utf8').trim().split('\n').map((l) => l.split(' ')) : []),
    nettoyer: () => fs.rmSync(dossier, { recursive: true, force: true }),
  };
}
const ligne = (e, debut) => e.lignes.find((l) => l.includes(debut));

test('lireBilan : la ligne du moteur, au singulier et au pluriel, avec ou sans « non jugés », et les mutants à lire à part', () => {
  assert.deepEqual(lireBilan('x\n12/12 mutants tués : 10 par un test, 2 par un délai ; 0 plantage ; 0 survivant\n').bilan, { tues: 12, retenus: 12, test: 10, delai: 2, plantages: 0, survivants: 0, nonJuges: 0 });
  assert.deepEqual(lireBilan('0/9 mutants tués : 0 par un test, 0 par un délai ; 2 plantages ; 3 survivants ; 4 non jugés').bilan, { tues: 0, retenus: 9, test: 0, delai: 0, plantages: 2, survivants: 3, nonJuges: 4 });
  assert.equal(lireBilan('0/1 mutants tués : 0 par un test, 0 par un délai ; 0 plantage ; 0 survivant ; 1 non jugé').bilan.nonJuges, 1);
  assert.equal(lireBilan('rien').bilan, null);
  assert.deepEqual(lireBilan('TUÉ       a\nTUÉ délai a2  (x)\nPLANTAGE  b\nSURVIT    c\nSURVIT').aPart, ['TUÉ délai a2  (x)', 'PLANTAGE  b', 'SURVIT    c']);
});

test('paquetsPour : au moins un, un de plus dès que le lot dépasse la part, un par mutant au plus', () => {
  assert.equal(paquetsPour(1, 60), 1);
  assert.equal(paquetsPour(60, 60), 1);
  assert.equal(paquetsPour(61, 60), 2);
  assert.equal(paquetsPour(269, 60), 5);
  assert.equal(paquetsPour(3, 1), 3);
  assert.equal(paquetsPour(2, 1), 2);
});

test('tous les lots tués : code 0, les comptes de chaque lot additionnés entre ses paquets, le total, le tout écrit par le lot et non à la main', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 130, delai: 2 }, 'mutants-b.mjs': { n: 7 } });
  try {
    assert.equal(await e.rejouer(), 0, e.lignes.join('\n'));
    assert.match(ligne(e, '  a'), /^\s+a\s+130\s+128\s+2\s+0\s+0\s+0\s+\d+ s$/, ligne(e, '  a'));
    assert.match(ligne(e, '  b'), /^\s+b\s+7\s+7\s+0\s+0\s+0\s+0/);
    assert.match(ligne(e, 'total'), /^total\s+137\s+135\s+2\s+0\s+0\s+0$/);
    assert.match(e.lignes.at(-1), /^Tous les mutants sont tués : 135 par un test, 2 par un délai ; 0 plantage\(s\), 0 survivant\(s\), 0 non jugé\(s\)\.$/);
    assert.equal(e.lance('mutants-b.mjs'), '', 'un lot d\'un seul paquet est lancé sans --part');
  } finally { e.nettoyer(); }
});

test('un lot de 130 mutants à 60 par paquet est coupé en 3 paquets --part=i/3, chacun dans son processus', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 130 } });
  try {
    const journaux = path.join(e.dossier, 'journaux');
    assert.equal(await e.rejouer({ journaux }), 0);
    assert.deepEqual(fs.readdirSync(journaux).sort(), ['mutants-a.1sur3.log', 'mutants-a.2sur3.log', 'mutants-a.3sur3.log']);
    assert.match(fs.readFileSync(path.join(journaux, 'mutants-a.1sur3.log'), 'utf8'), /44\/44 mutants tués/);
    assert.match(fs.readFileSync(path.join(journaux, 'mutants-a.3sur3.log'), 'utf8'), /43\/43 mutants tués/);
    assert.equal(e.vus().length, 3);
  } finally { e.nettoyer(); }
});

test('un survivant fait échouer (code 1), son lot est marqué, sa ligne est reprise sous « À lire »', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 5, survivants: 1, lignes: ['SURVIT    un mutant équivalent  [x.js]  [1.2 s]'] }, 'mutants-b.mjs': { n: 4 } });
  try {
    assert.equal(await e.rejouer(), 1);
    assert.match(ligne(e, 'a  '), /^✗ a\s+5\s+4\s+0\s+0\s+1\s+0/);
    assert.match(ligne(e, 'b  '), /^  b\s+4\s+4/);
    assert.ok(e.lignes.some((l) => /^\s+mutants-a : SURVIT\s+un mutant équivalent/.test(l)), e.lignes.join('\n'));
    assert.match(e.lignes.at(-1), /^ÉCHEC : 8 par un test, 0 par un délai ; 0 plantage\(s\), 1 survivant\(s\), 0 non jugé\(s\)\.$/, '4 tués dans le lot du survivant, 4 dans l\'autre : les deux sont comptés');
  } finally { e.nettoyer(); }
});

test('un plantage ou un mutant non jugé fait échouer aussi (code 1)', async () => {
  for (const cfg of [{ n: 4, plantages: 1 }, { n: 4, nonJuges: 2 }]) {
    const e = essai({ 'mutants-a.mjs': cfg });
    try {
      assert.equal(await e.rejouer(), 1, JSON.stringify(cfg));
      assert.match(ligne(e, 'a  '), /^✗/);
    } finally { e.nettoyer(); }
  }
});

test('un mutant tué par un délai est compté et dit à part (colonne « délai », et sa ligne sous « À lire »), sans faire échouer', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 6, delai: 2, lignes: ['TUÉ délai boucle sans fin  [x.js]  [240 s]'] } });
  try {
    assert.equal(await e.rejouer(), 0);
    assert.match(ligne(e, '  a'), /^\s+a\s+6\s+4\s+2\s+0\s+0\s+0/);
    assert.ok(e.lignes.some((l) => /mutants-a : TUÉ délai boucle sans fin/.test(l)));
  } finally { e.nettoyer(); }
});

test('un lot qui ignore --part (chaque paquet rejoue tout) est refusé : le total jugé n\'est pas celui du lot', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 100, ignorePart: true } });
  try {
    assert.equal(await e.rejouer({ parPaquet: 30 }), 1);
    assert.ok(e.lignes.some((l) => /! 400 mutants jugés pour 100 annoncés/.test(l)), e.lignes.join('\n'));
    assert.match(ligne(e, 'a  '), /^✗/);
  } finally { e.nettoyer(); }
});

test('un paquet qui finit sans avoir imprimé son bilan (plantage de l\'outil) fait échouer, et le dit', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 10, planter: true } });
  try {
    assert.equal(await e.rejouer(), 1);
    assert.ok(e.lignes.some((l) => /! mutants-a : aucun bilan imprimé \(code 1\)/.test(l)), e.lignes.join('\n'));
    assert.ok(e.lignes.some((l) => /! 0 mutants jugés pour 10 annoncés/.test(l)));
  } finally { e.nettoyer(); }
});

test('un lot qui ne se vérifie pas d\'avance (code 2) : rien n\'est rejoué, code 2, la raison est dite', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 5, valider: 2 }, 'mutants-b.mjs': { n: 5 } });
  try {
    assert.equal(await e.rejouer(), 2);
    assert.match(e.erreurs.join('\n'), /mutants-a\.mjs : ne se vérifie pas d'avance \(code 2\)/);
    assert.match(e.erreurs.join('\n'), /1 lot\(s\) à corriger avant de rien rejouer\./);
    assert.equal(e.lance('mutants-b.mjs'), null, 'même le lot sain n\'est pas lancé');
  } finally { e.nettoyer(); }
});

test('un lot qui annonce zéro mutant se vérifie mal : refusé (code 2), pas rejoué pour rien', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 0 } });
  try {
    assert.equal(await e.rejouer(), 2);
    assert.match(e.erreurs.join('\n'), /mutants-a\.mjs : ne se vérifie pas d'avance/);
    assert.equal(e.lance('mutants-a.mjs'), null);
  } finally { e.nettoyer(); }
});

test('--valider : chaque lot est vérifié, aucun n\'est rejoué', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 5 }, 'mutants-b.mjs': { n: 3 } });
  try {
    assert.equal(await e.rejouer({ valider: true }), 0);
    assert.deepEqual(e.lignes, ['2 lots, 8 mutants, vérifiés d\'avance.']);
    assert.equal(e.lance('mutants-a.mjs'), null);
  } finally { e.nettoyer(); }
});

test('l\'expression sur le nom du lot ne rejoue que ceux-là, et aucun qui corresponde est une erreur (code 2)', async () => {
  const e = essai({ 'mutants-css.mjs': { n: 3 }, 'mutants-isolement.mjs': { n: 3 } });
  try {
    assert.equal(await e.rejouer({ filtre: /isol/ }), 0);
    assert.equal(e.lance('mutants-css.mjs'), null);
    assert.equal(e.lance('mutants-isolement.mjs'), '');
    assert.equal(await e.rejouer({ filtre: /rien/ }), 2);
    assert.match(e.erreurs.join('\n'), /Aucun lot ne correspond\./);
  } finally { e.nettoyer(); }
});

test('au plus `travailleurs` paquets à la fois, et autant quand il y en a assez (rendez-vous : chacun attend d\'en voir deux vivants)', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 4, rendezVous: 2 }, 'mutants-b.mjs': { n: 4, rendezVous: 2 }, 'mutants-c.mjs': { n: 4, rendezVous: 1 }, 'mutants-d.mjs': { n: 4, rendezVous: 1 } });
  try {
    assert.equal(await e.rejouer({ travailleurs: 2 }), 0);
    const vus = e.vus().map((l) => Number(l[1]));
    assert.equal(vus.length, 4);
    assert.equal(Math.max(...vus), 2, 'deux à la fois, jamais plus : ' + vus);
  } finally { e.nettoyer(); }
});

test('les plus gros paquets d\'abord : avec un seul travailleur, le lot le plus lourd passe avant le plus léger', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 4 }, 'mutants-b.mjs': { n: 50 }, 'mutants-c.mjs': { n: 20 } });
  try {
    assert.equal(await e.rejouer({ travailleurs: 1 }), 0);
    assert.deepEqual(e.vus().map((l) => l[0]), ['mutants-b.mjs', 'mutants-c.mjs', 'mutants-a.mjs']);
  } finally { e.nettoyer(); }
});

test('un lot « seul » (les budgets, où chaque mutant meurt par l\'horloge) se rejoue après tous les autres, sans personne d\'autre', async () => {
  const e = essai({ 'mutants-a.mjs': { n: 4, rendezVous: 2 }, 'mutants-b.mjs': { n: 4, rendezVous: 2 }, 'mutants-budgets.mjs': { n: 70 } });   // 70 > 60 par paquet : coupé en deux s'il n'était pas « seul »
  try {
    assert.equal(await e.rejouer({ travailleurs: 2 }), 0);
    const vus = e.vus();
    assert.deepEqual(vus.at(-1), ['mutants-budgets.mjs', '1'], 'le dernier, et il est seul : ' + vus.join(' | '));
    assert.equal(vus.filter((l) => l[0] === 'mutants-budgets.mjs').length, 1);
  } finally { e.nettoyer(); }
});

test('deux lots « seuls » se rejouent l\'un après l\'autre, jamais ensemble', async () => {
  const e = essai({ 'mutants-x.mjs': { n: 3, rendezVous: 1 }, 'mutants-y.mjs': { n: 3, rendezVous: 1 } });
  try {
    assert.equal(await e.rejouer({ seuls: ['mutants-x.mjs', 'mutants-y.mjs'] }), 0);
    assert.deepEqual(e.vus().map((l) => l[1]), ['1', '1']);
  } finally { e.nettoyer(); }
});

test('en ligne de commande : une option inconnue ou nulle est un usage faux (code 2), dit par son message seul : rien n\'est vérifié ni lancé', () => {
  // Le pilote est copié seul dans un dossier sans lot. Un usage faux que la ligne de commande laisserait passer irait chercher des lots (et le dirait :
  // « Aucun lot ne correspond. ») ; dans l'arbre du projet, il irait vérifier, puis rejouer, les vrais lots, des heures durant. Le code 2 et un message
  // qui ne serait pas celui de l'usage ne suffisent pas : un lot qui ne se vérifie pas d'avance sort aussi en 2, et cite parfois les mêmes mots.
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'pilote-ligne-'));
  const copie = path.join(dossier, 'rejouer-tous-les-lots.mjs');
  fs.copyFileSync(PILOTE, copie);
  const lancer = (...argv) => spawnSync(process.execPath, [copie, ...argv], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 60000 });
  try {
    for (const [argv, message] of [
      [['--nope'], 'option inconnue : --nope'],
      [['--travailleurs=0'], '--travailleurs et --par-paquet valent au moins 1'],
      [['--par-paquet=0'], '--travailleurs et --par-paquet valent au moins 1'],
      [['a', 'b'], 'une seule expression régulière sur le nom du lot'],
    ]) {
      const r = lancer(...argv);
      assert.equal(r.status, 2, `${argv.join(' ')} : code (${r.error?.message ?? r.signal ?? 'rien à signaler'})`);
      assert.equal(r.stderr.trim(), message, argv.join(' '));
      assert.equal(r.stdout, '', `${argv.join(' ')} : rien n'est écrit sur la sortie standard`);
    }
    const temoin = lancer();
    assert.equal(temoin.status, 2, 'le témoin : sans usage faux, la même copie va chercher des lots');
    assert.equal(temoin.stderr.trim(), 'Aucun lot ne correspond.', 'et n\'en trouve aucun : les refus ci-dessus sont donc bien ceux de la ligne de commande');
  } finally { fs.rmSync(dossier, { recursive: true, force: true }); }
});
