import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { calculerSurface } from '../src/contexte/inventaire.js';
import { page } from './aide-surface.mjs';

/**
 * La file de la fermeture de la surface (`calculerSurface`) : un fichier n'y entre qu'une fois, quel que soit le nombre de fois qu'on le cite, cycle d'imports
 * compris. Le widget de ces essais est en mémoire et la recherche d'un fichier y est BORNÉE : au-delà de `PLAFOND` recherches elle lève une erreur qui dit que
 * la fermeture ne s'arrête pas. Une file qui remet dans la file un fichier qui y est déjà, ou qui ne le note pas, tourne sans fin sur un cycle ; sans cette
 * borne, l'essai ne finirait que par une erreur de V8 sur la taille du tableau (« Invalid array length », après une longue boucle et beaucoup de mémoire) ou par
 * le délai du lanceur, selon la vitesse de la machine, jamais par une assertion. La borne compte des recherches de fichier, non des secondes : aucun essai ne
 * mesure un temps. Les mutants de ces essais sont dans `scripts/mutants-surface-code.mjs` (libellés « fermeture : »), dont ils forment le premier groupe.
 */

const PLAFOND = 1000;

/** Un widget en mémoire : `trouver` compte ses appels (`de(chemin)` : ceux qui demandent ce chemin) et lève au `PLAFOND + 1`-ième. */
function mondeBorne(definitions) {
  const parChemin = new Map(Object.entries(definitions).map(([c, t]) => [c, { chemin: c, ext: path.extname(c), contenu: t, binaire: false }]));
  const appels = [];
  return {
    appels,
    trouver: (chemin) => {
      if (appels.push(chemin) > PLAFOND) throw new Error(`la fermeture ne s'arrête pas : plus de ${PLAFOND} recherches de fichier (la dernière : ${chemin})`);
      return parChemin.get(chemin) ?? null;
    },
    de: (chemin) => appels.filter((c) => c === chemin).length,
  };
}

test('fermeture : un cycle d\'imports et un module qui s\'importe lui-même s\'arrêtent, chaque fichier entre une fois dans la file de chaque parcours', () => {
  const m = mondeBorne({
    'index.html': page('<script type="module" src="a.js"></script>'),
    'a.js': "import './b.js';\nimport './a.js';\n", 'b.js': "import './a.js';\nimport './b.js';\n",
  });
  const { surface, partiel } = calculerSurface(['index.html'], m.trouver, () => []);
  assert.deepEqual([...surface].sort(), ['a.js', 'b.js', 'index.html']);
  assert.equal(partiel, false);
  // Une recherche de candidat par arête qui mène au fichier, une lecture de ses propres références (mémoïsée entre les parcours) et une sortie de file par
  // parcours (un pour tout, un sans gabarit, un sans standard : 3).
  assert.equal(m.de('index.html'), 1 + 3, 'la page : aucune arête n\'y mène');
  assert.equal(m.de('a.js'), 3 + 1 + 3, 'a.js : trois arêtes y mènent (la page, b.js, lui-même)');
  assert.equal(m.de('b.js'), 2 + 1 + 3, 'b.js : deux arêtes y mènent (a.js, lui-même)');
});

test('fermeture : le plafond de recherches du widget de ces essais se lève à la recherche qui le dépasse, et pas avant', () => {
  const m = mondeBorne({ 'a.js': 'var a = 1;\n' });
  for (let i = 0; i < PLAFOND; i++) m.trouver('a.js');
  assert.equal(m.de('a.js'), PLAFOND);
  assert.throws(() => m.trouver('a.js'), new Error(`la fermeture ne s'arrête pas : plus de ${PLAFOND} recherches de fichier (la dernière : a.js)`));
});
