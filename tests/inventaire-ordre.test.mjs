import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { avecWidget, page } from './aide-surface.mjs';

/**
 * L'ordre de l'inventaire ne dépend pas du système de fichiers : `readdirSync` rend les entrées d'un dossier dans l'ordre de la machine (ext4, NTFS, overlayfs), et un
 * inventaire qui le suivrait donnerait deux rapports pour le même dépôt : le premier fichier d'une liste, celui que le plafond de fichiers, d'octets lus ou d'entrées
 * listées laisse de côté, et la page d'entrée quand plusieurs se valent, changeraient d'une machine à l'autre. Chaque essai rejoue le même dépôt sous plusieurs ordres de dossier.
 */

const ordre = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const tourner = (liste, k) => [...liste.slice(k), ...liste.slice(0, k)];
/** Les ordres qu'un système de fichiers peut rendre : l'ordre des noms, son contraire, et des rotations. */
const ORDRES = {
  'croissant': (noms) => [...noms].sort(ordre),
  'décroissant': (noms) => [...noms].sort(ordre).reverse(),
  'tourné d\'un cran': (noms) => tourner([...noms].sort(ordre), 1),
  'tourné de deux crans': (noms) => tourner([...noms].sort(ordre), 2),
  'à l\'envers, tourné': (noms) => tourner([...noms].sort(ordre).reverse(), 1),
};

/** Joue `suite` pendant que `readdirSync` rend ses entrées dans l'ordre que `rangement` donne à leurs noms. */
function sousOrdre(rangement, suite) {
  const reel = fs.readdirSync;
  fs.readdirSync = (...arguments_) => {
    const lues = reel(...arguments_);
    const noms = lues.map((e) => e.name);
    const rangees = rangement(noms);
    return rangees.map((nom) => lues.find((e) => e.name === nom));
  };
  try { return suite(); } finally { fs.readdirSync = reel; }
}
/** Le résultat de `mesure(racine)` sous chaque ordre, et ce qu'il est sous l'ordre des noms ; chacun doit être le même. */
function souschaqueOrdre(racine, mesure) {
  const attendu = sousOrdre(ORDRES.croissant, () => mesure(racine));
  for (const [nom, rangement] of Object.entries(ORDRES)) {
    assert.deepEqual(sousOrdre(rangement, () => mesure(racine)), attendu, `sous l'ordre « ${nom} »`);
  }
  return attendu;
}

const WIDGET = {
  'index.html': page('<script src="app.js"></script>'), 'app.js': 'var a = 1;\n', 'a.js': 'var b = 2;\n', 'b.js': 'var c = 3;\n', 'README.md': '# w\n',
  'sub/z.js': 'var d = 4;\n', 'sub/a.js': 'var e = 5;\n', 'sub2/x.js': 'var f = 6;\n',
};

test('les fichiers de l\'inventaire se suivent dans l\'ordre des noms, dossier après dossier, quel que soit l\'ordre du système de fichiers', async () => {
  await avecWidget(WIDGET, {}, (racine) => {
    const chemins = souschaqueOrdre(racine, (r) => construireContexte(r).fichiers.map((f) => f.chemin));
    assert.deepEqual(chemins, ['README.md', 'a.js', 'app.js', 'b.js', 'index.html', 'sub/a.js', 'sub/z.js', 'sub2/x.js']);
  });
});

test('le plafond de fichiers laisse de côté les derniers dans l\'ordre des noms, quel que soit l\'ordre du système de fichiers', async () => {
  await avecWidget(WIDGET, {}, (racine) => {
    const vu = souschaqueOrdre(racine, (r) => {
      const ctx = construireContexte(r, { maxFichiers: 3 });
      return { chemins: ctx.fichiers.map((f) => f.chemin), tronque: ctx.tronque?.fichiers };
    });
    assert.deepEqual(vu, { chemins: ['README.md', 'a.js', 'app.js'], tronque: true });
  });
});

test('le plafond d\'octets lus laisse non lus les derniers dans l\'ordre des noms, quel que soit l\'ordre du système de fichiers', async () => {
  await avecWidget({ 'c.txt': 'cccccccccc', 'a.txt': 'aaaaaaaaaa', 'b.txt': 'bbbbbbbbbb' }, {}, (racine) => {
    const vu = souschaqueOrdre(racine, (r) => {
      const ctx = construireContexte(r, { maxOctetsCumules: 20 });
      return { lus: ctx.fichiers.filter((f) => typeof f.contenu === 'string').map((f) => f.chemin), tronque: ctx.tronque?.octets };
    });
    assert.deepEqual(vu, { lus: ['a.txt', 'b.txt'], tronque: true });
  });
});

test('le plafond d\'entrées listées d\'un dossier exclu laisse de côté les dernières dans l\'ordre des noms, quel que soit l\'ordre du système de fichiers', async () => {
  const carte = JSON.stringify({ imports: { 'm/': './node_modules/' } });
  const widget = {
    'index.html': page(`<script type="importmap">${carte}</script><script type="module">import 'm/m0.js';</script>`),
    ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`node_modules/m${i}.js`, 'var a = 1;\n'])),
  };
  await avecWidget(widget, {}, (racine) => {
    const vu = souschaqueOrdre(racine, (r) => {
      const ctx = construireContexte(r, { maxEntreesListees: 5 });
      return { surface: [...ctx.surface].sort(ordre), tronque: ctx.tronque?.listage };
    });
    assert.deepEqual(vu, { surface: ['index.html', 'node_modules/m0.js', 'node_modules/m1.js', 'node_modules/m10.js', 'node_modules/m11.js', 'node_modules/m2.js'], tronque: true });
  });
});

test('le plafond d\'entrées listées, dans des dossiers imbriqués, laisse de côté les mêmes fichiers quel que soit l\'ordre du système de fichiers', async () => {
  const carte = JSON.stringify({ imports: { 'm/': './node_modules/' } });
  const widget = {
    'index.html': page(`<script type="importmap">${carte}</script><script type="module">import 'm/c.js';</script>`),
    'node_modules/a/x.js': 'var a = 1;\n', 'node_modules/a/y.js': 'var a = 2;\n', 'node_modules/b/x.js': 'var b = 1;\n', 'node_modules/b/y.js': 'var b = 2;\n', 'node_modules/c.js': 'var c = 1;\n',
  };
  await avecWidget(widget, {}, (racine) => {
    const vu = souschaqueOrdre(racine, (r) => {
      const ctx = construireContexte(r, { maxEntreesListees: 4 });
      return { surface: [...ctx.surface].sort(ordre), tronque: ctx.tronque?.listage };
    });
    // `a`, `b` et `c.js` se listent (3 entrées), puis le dossier `b`, le dernier empilé, se lit le premier : `b/x.js` est la quatrième entrée, `b/y.js` dépasse le plafond, `a` n'est jamais lu.
    assert.deepEqual(vu, { surface: ['index.html', 'node_modules/b/x.js', 'node_modules/c.js'], tronque: true });
  });
});

test('sans index.html, la page d\'entrée est la première des plus courtes dans l\'ordre des noms, quel que soit l\'ordre du système de fichiers', async () => {
  await avecWidget({ 'b.html': page(''), 'c.html': page(''), 'a.html': page('') }, {}, (racine) => {
    assert.deepEqual(souschaqueOrdre(racine, (r) => construireContexte(r).entrees), ['a.html']);
  });
});
