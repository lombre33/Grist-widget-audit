import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserReadme } from '../src/regles/b-lisibilite.js';
import { PIEGES_README } from '../scripts/lib/pieges.mjs';

/**
 * La recherche d'un titre de rubrique lit des Mio de blancs, de marqueurs de titre et de fins de ligne en temps linéaire. L'essai ne juge pas le
 * temps (le chronomètre, `scripts/chronometrer-pieges.mjs`, le fait à part, sur la même table) : il lit chaque piège et vérifie ce qu'il donne.
 *
 * Il est seul dans son fichier : un mutant qui rend la lecture quadratique ne s'arrête plus, et le délai du rejeu le tue (le bilan le dit :
 * « par un délai ») ; mis avec les autres essais, il empêcherait un essai de dire qu'un mutant se voit à son résultat.
 */
for (const [nom, contenu] of PIEGES_README) {
  test(`B-DOC-02 : un README de 1 Mio ${nom} se lit d'un trait : les trois rubriques manquent`, () => {
    const fichiers = [{ chemin: 'README.md', contenu, lignes: contenu.split('\n'), ext: '.md', binaire: false, executee: false, vendorise: false }];
    const [c, ...autres] = analyserReadme({ fichiers });
    assert.equal(autres.length, 0);
    assert.equal(c.regle, 'B-DOC-02');
  });
}
