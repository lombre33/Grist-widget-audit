/**
 * La mesure des marges de chaque plafond (`scripts/lib/marges-plafonds.mjs`, `scripts/mesurer-marges-plafonds.mjs`) : le nombre qu'un
 * commit cite pour dire qu'aucune cible honnête ne bute sur un plafond doit être celui que l'outil consomme, au plus près. Chaque essai
 * a son mutant dans `scripts/mutants-marges.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { avecWidget, page } from './aide-surface.mjs';
import { construireContexte, PLAFONDS } from '../src/contexte/inventaire.js';
import { MAX_PROFONDEUR_CODE_IMBRIQUE } from '../src/regles/c-securite.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { dire, marges, mesurerRacine, plusPetitPlafond, PLAFONDS_MESURES } from '../scripts/lib/marges-plafonds.mjs';

const CLI = fileURLToPath(new URL('../scripts/mesurer-marges-plafonds.mjs', import.meta.url));
const MIO = 1024 * 1024;
const modules = (noms) => Object.fromEntries(noms.map((n) => [n, 'var a = 1;\n']));
const carte = (imports) => `<script type="importmap">${JSON.stringify({ imports })}</script>`;

/** Neuf résolutions d'adresse de worker : trois pages d'entrée, trois adresses chacune (le même dépôt que l'essai du plafond des résolutions). */
const NEUF_RESOLUTIONS = () => {
  const dossiers = ['a', 'b', 'c'];
  return {
    ...Object.fromEntries(dossiers.map((d) => [`${d}/index.html`, page('<script src="../js/app.js"></script>')])),
    'js/app.js': "new Worker('w1.js');\nnew Worker('w2.js');\nnew Worker('w3.js');\n",
    ...modules(dossiers.flatMap((d) => ['w1', 'w2', 'w3'].map((w) => `${d}/${w}.js`))),
  };
};
/** `n` entrées listées dans un dossier exclu, pour suivre un préfixe d'import map (douze : le dépôt de l'essai du plafond des entrées listées). */
const ENTREES = (n = 12) => ({
  'index.html': page(`${carte({ 'm/': './node_modules/' })}<script type="module">import 'm/m0.js';</script>`),
  ...modules(Array.from({ length: n }, (_, i) => `node_modules/m${i}.js`)),
});
/** Des arêtes de document : une page, une carte d'import avec empreinte, un module qui en importe un autre qui importe une adresse distante (le dépôt de l'essai du plafond des arêtes). */
const ARETES_DE_DOCUMENT = () => {
  const U = 'https://esm.sh/foo@1.2.3';
  return {
    'index.html': page(`${JSON.stringify({ imports: {}, integrity: { [U]: `sha384-${'A'.repeat(64)}` } }).replace(/^/, '<script type="importmap">').concat('</script>')}<script type="module" src="app.js"></script>`),
    'app.js': 'import "./c.js";\n',
    'c.js': `import "${U}";\n`,
  };
};
const imbriques = (niveaux) => {
  let code = 'var z = 1;';
  for (let i = 0; i < niveaux; i++) code = `eval(${JSON.stringify(code)});`;
  return `${code}\n`;
};

test('les plafonds par défaut sont ceux de la décision, et chacun est lu à un seul endroit', () => {
  assert.deepEqual({ ...PLAFONDS }, { fichiers: 20_000, octets: 200 * MIO, octetsFichier: 16 * MIO, entreesListees: 100_000, resolutions: 2_000_000, pasDocuments: 2_000_000 });
  assert.equal(MAX_PROFONDEUR_CODE_IMBRIQUE, 5);
  assert.deepEqual(PLAFONDS_MESURES.map((p) => [p.cle, p.plafond]), [
    ['fichiers', 20_000], ['octets', 200 * MIO], ['octetsFichier', 16 * MIO], ['entreesListees', 100_000], ['resolutions', 2_000_000], ['pasDocuments', 2_000_000], ['profondeur', 5],
  ], 'la mesure dit les plafonds que l\'outil applique, dans cet ordre');
  assert.throws(() => { PLAFONDS.fichiers = 1; }, TypeError, 'les plafonds ne se modifient pas en route');
});

test('le plafond d\'une option se mesure par la plus petite valeur qui ne tronque pas le dépôt : une de moins le tronque', async () => {
  await avecWidget(NEUF_RESOLUTIONS(), {}, (racine) => {
    const v = plusPetitPlafond(racine, 'maxResolutions', 'surface');
    assert.equal(v, 9);
    assert.equal(construireContexte(racine, { maxResolutions: v }).tronque, null);
    assert.equal(construireContexte(racine, { maxResolutions: v - 1 }).tronque.surface, true);
  });
  await avecWidget(ENTREES(), {}, (racine) => {
    const v = plusPetitPlafond(racine, 'maxEntreesListees', 'listage');
    assert.equal(v, 12);
    assert.equal(construireContexte(racine, { maxEntreesListees: v }).tronque, null);
    assert.equal(construireContexte(racine, { maxEntreesListees: v - 1 }).tronque.listage, true);
  });
});

test('un dépôt qui consomme une seule unité d\'un plafond le mesure à 1', async () => {
  await avecWidget({ 'index.html': page('<script src="app.js"></script>'), 'app.js': "new Worker('w.js');\n", 'w.js': 'var a = 1;\n' }, {}, (racine) => {
    assert.equal(plusPetitPlafond(racine, 'maxResolutions', 'surface'), 1);
  });
  await avecWidget({ 'index.html': page(`${carte({ 'm/': './node_modules/' })}<script type="module">import 'm/m0.js';</script>`), 'node_modules/m0.js': 'var a = 1;\n' }, {}, (racine) => {
    assert.equal(plusPetitPlafond(racine, 'maxEntreesListees', 'listage'), 1);
  });
});

test('un dépôt qui ne consomme pas un plafond le mesure à 0 ; une borne trop basse rend null, jamais une valeur fausse', async () => {
  await avecWidget({ 'index.html': page('<script src="app.js"></script>'), 'app.js': 'var a = 1;\n' }, {}, (racine) => {
    assert.equal(plusPetitPlafond(racine, 'maxResolutions', 'surface'), 0);
    assert.equal(plusPetitPlafond(racine, 'maxEntreesListees', 'listage'), 0);
  });
  await avecWidget(NEUF_RESOLUTIONS(), {}, (racine) => {
    assert.equal(plusPetitPlafond(racine, 'maxResolutions', 'surface', { borne: 4 }), null, 'neuf résolutions ne tiennent pas dans une borne de quatre');
    assert.equal(plusPetitPlafond(racine, 'maxResolutions', 'surface', { borne: 16 }), 9, 'une borne qui suffit ne change pas la valeur');
  });
});

test('mesurerRacine : fichiers, octets lus, plus gros fichier, niveaux de code emboîté, pas de document', async () => {
  const fichiers = { 'index.html': page('<script src="app.js"></script>'), 'app.js': imbriques(2), 'gros.json': `{"a":"${'x'.repeat(5000)}"}\n`, 'logo.png': 'x'.repeat(9000) };
  await avecWidget(fichiers, {}, async (racine) => {
    const m = await mesurerRacine(racine);
    assert.equal(m.racine, racine);
    assert.equal(m.fichiers, 4, 'les quatre fichiers du dépôt, pas les fichiers synthétiques du code littéral');
    const texte = ['index.html', 'app.js', 'gros.json'].map((n) => Buffer.byteLength(fichiers[n]));
    assert.equal(m.octets, texte.reduce((a, b) => a + b, 0), 'une image n\'est pas du texte lu');
    assert.equal(m.octetsFichier, Math.max(...texte));
    assert.equal(m.profondeur, 2);
    assert.equal(m.entreesListees, 0);
    assert.equal(m.resolutions, 0);
    assert.ok(m.pasDocuments >= 0 && Number.isInteger(m.pasDocuments));
  });
});

test('mesurerRacine : les entrées listées, les résolutions et les pas de document se mesurent chacun sur son plafond', async () => {
  await avecWidget({ ...NEUF_RESOLUTIONS(), ...ENTREES(15) }, {}, async (racine) => {
    const m = await mesurerRacine(racine);
    assert.equal(m.resolutions, 12, 'quatre pages d\'entrée, trois adresses de worker : le produit, non la somme des pages qui les chargent');
    assert.equal(m.entreesListees, 15);
  });
  await avecWidget(ARETES_DE_DOCUMENT(), {}, async (racine) => {
    const m = await mesurerRacine(racine);
    assert.ok(m.pasDocuments > 0, 'cette page a des arêtes de document à parcourir');
    const tronque = async (plafond) => {
      const ctx = construireContexte(racine, { maxPasDocuments: plafond });
      await analyseStatique(ctx, { reseau: false });
      return ctx.tronque?.documents === true;
    };
    assert.equal(await tronque(m.pasDocuments), false, 'le nombre mesuré suffit exactement');
    assert.equal(await tronque(m.pasDocuments - 1), true, 'un pas de moins ne suffit plus');
  });
});

test('mesurerRacine lit un dépôt en entier : ni le plafond par fichier ni le plafond cumulé ne coupent la mesure', async () => {
  const gros = `/*${'x'.repeat(PLAFONDS.octetsFichier + 10)}*/\n`;
  await avecWidget({ 'index.html': page('<script src="gros.js"></script>'), 'gros.js': gros }, {}, async (racine) => {
    assert.equal(construireContexte(racine).nonLus.length, 1, 'l\'outil, lui, ne lit pas ce fichier');
    const m = await mesurerRacine(racine);
    assert.equal(m.octetsFichier, Buffer.byteLength(gros), 'la mesure le lit et dit ce qu\'il coûte');
    assert.equal(m.fichiers, 2);
  });
});

test('mesurerRacine lève les trois plafonds de lecture (fichiers, octets cumulés, octets par fichier) pour lire le dépôt en entier, et aucun autre', async () => {
  const appels = [];
  await avecWidget({ 'index.html': page('') }, {}, async (racine) => {
    await mesurerRacine(racine, { construire: (r, options) => { appels.push(options); return construireContexte(r, options); } });
  });
  assert.equal(appels.length, 1);
  assert.deepEqual(Object.keys(appels[0]).sort(), ['maxFichiers', 'maxOctetsCumules', 'maxOctetsFichier']);
  for (const v of Object.values(appels[0])) assert.ok(v > 1e12 && Number.isFinite(v), 'levé : bien au-delà de ce qu\'un dépôt peut peser');
});

test('marges : le plus gros de chaque valeur, le dépôt qui le porte (le premier quand deux dépôts égalent le maximum), le rapport au plafond ; une valeur nulle partout n\'a pas de marge', () => {
  const base = { fichiers: 10, octets: 100, octetsFichier: 50, entreesListees: 0, resolutions: 5, pasDocuments: 7, profondeur: 1 };
  const lignes = marges([{ racine: '/a', ...base }, { racine: '/b', ...base, fichiers: 2000, resolutions: 3 }]);
  const par = Object.fromEntries(lignes.map((l) => [l.cle, l]));
  assert.deepEqual(lignes.map((l) => l.cle), PLAFONDS_MESURES.map((p) => p.cle));
  assert.equal(par.fichiers.maximum, 2000);
  assert.equal(par.fichiers.depot, '/b');
  assert.equal(par.fichiers.plafond, PLAFONDS.fichiers);
  assert.equal(par.fichiers.marge, PLAFONDS.fichiers / 2000);
  assert.equal(par.resolutions.maximum, 5);
  assert.equal(par.resolutions.depot, '/a');
  assert.equal(par.octets.depot, '/a', 'à égalité, le premier dépôt porte le maximum');
  assert.equal(par.profondeur.marge, MAX_PROFONDEUR_CODE_IMBRIQUE / 1);
  assert.deepEqual([par.entreesListees.maximum, par.entreesListees.depot, par.entreesListees.marge], [0, null, null]);
});

test('marges : une valeur que la mesure n\'a pas pu borner (null) est infinie, sans marge, et nomme son dépôt', () => {
  const base = { fichiers: 1, octets: 1, octetsFichier: 1, entreesListees: 0, resolutions: 0, pasDocuments: 0, profondeur: 0 };
  const par = Object.fromEntries(marges([{ racine: '/a', ...base }, { racine: '/b', ...base, resolutions: null }]).map((l) => [l.cle, l]));
  assert.equal(par.resolutions.maximum, Infinity);
  assert.equal(par.resolutions.marge, 0);
  assert.equal(par.resolutions.depot, '/b');
});

test('dire : le plus gros et son dépôt, le plafond, la marge ; des octets en Mio, une valeur non bornée, un plafond que rien ne consomme', () => {
  const base = { fichiers: 2, octets: MIO, octetsFichier: 1.5 * MIO, entreesListees: 0, resolutions: 1000, pasDocuments: 20_000, profondeur: 2 };
  const texte = dire(marges([{ racine: '/depots/chart', ...base }, { racine: '/depots/autre', ...base, resolutions: null, octets: null }]), 2);
  const rubriques = texte.split('\n');
  assert.equal(rubriques[0], '2 dépôt(s) mesuré(s)');
  assert.equal(rubriques[1], '');
  const de = (libelle) => rubriques.slice(rubriques.indexOf(libelle) + 1, rubriques.indexOf(libelle) + 4);
  assert.deepEqual(de('fichiers inventoriés'), ['  plus gros : 2 (chart)', '  plafond   : 20 000', '  marge     : ×10000']);
  assert.deepEqual(de('octets de texte lus en tout'), ['  plus gros : non borné (autre)', '  plafond   : 209 715 200 octets (200,00 Mio)', '  marge     : aucune marge']);
  assert.deepEqual(de('octets du plus gros fichier de texte'), ['  plus gros : 1 572 864 octets (1,50 Mio) (chart)', '  plafond   : 16 777 216 octets (16,00 Mio)', '  marge     : ×10,7']);
  assert.deepEqual(de('entrées listées dans les dossiers exclus'), ['  plus gros : 0', '  plafond   : 100 000', '  marge     : aucune cible ne le consomme']);
  assert.deepEqual(de('résolutions d\'adresses de worker'), ['  plus gros : non borné (autre)', '  plafond   : 2 000 000', '  marge     : aucune marge']);
  assert.deepEqual(de('pas d\'analyse de document'), ['  plus gros : 20 000 (chart)', '  plafond   : 2 000 000', '  marge     : ×100']);
  assert.deepEqual(de('niveaux de code littéral emboîté'), ['  plus gros : 2 (chart)', '  plafond   : 5', '  marge     : ×2,5']);
});

test('la ligne de commande : code 0 et JSON complet sur un dépôt, code 2 sans dépôt ou avec un dépôt introuvable', async () => {
  await avecWidget({ 'index.html': page('<script src="app.js"></script>'), 'app.js': 'var a = 1;\n' }, {}, (racine) => {
    const ok = spawnSync(process.execPath, [CLI, '--json', racine], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const sortie = JSON.parse(ok.stdout);
    assert.equal(sortie.mesures.length, 1);
    assert.equal(sortie.mesures[0].fichiers, 2);
    assert.deepEqual(sortie.marges.map((l) => l.cle), PLAFONDS_MESURES.map((p) => p.cle));
    const texte = spawnSync(process.execPath, [CLI, racine], { encoding: 'utf8' });
    assert.equal(texte.status, 0, texte.stderr);
    assert.match(texte.stdout, /1 dépôt\(s\) mesuré\(s\)/);
    assert.match(texte.stdout, /plafond {3}: 16 777 216 octets \(16,00 Mio\)/);
    assert.match(texte.stdout, /aucune cible ne le consomme/);
    assert.match(texte.stdout, /fichiers inventoriés\n {2}plus gros : 2 \(/);
    assert.match(texte.stdout, /marge {5}: ×10000\n/, 'vingt mille fichiers de plafond pour deux fichiers');
    assert.match(texte.stdout, /octets du plus gros fichier de texte\n {2}plus gros : 110 octets \(0,00 Mio\) \(widget\)\n/);
    const unFichier = spawnSync(process.execPath, [CLI, CLI], { encoding: 'utf8' });
    assert.equal(unFichier.status, 2, 'un fichier n\'est pas un dépôt');
    const deux = spawnSync(process.execPath, [CLI, racine, '/introuvable/depot'], { encoding: 'utf8' });
    assert.equal(deux.status, 2);
    assert.match(deux.stderr, /Dépôt introuvable : \/introuvable\/depot/);
    assert.equal(deux.stdout, '', 'rien n\'est mesuré à moitié');
  });
  const sans = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(sans.status, 2);
  assert.match(sans.stderr, /Usage/);
});
