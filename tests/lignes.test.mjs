import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numeroLigne } from '../src/moteur/lignes.js';
import { ligneDe } from '../src/contexte/inventaire.js';

/**
 * Le numéro de ligne d'un décalage se lit dans un index des sauts de ligne du contenu, fait une fois :
 * `contenu.slice(0, index).split('\n').length` recopiait tout le début du contenu à chaque occurrence
 * d'un motif, et rendait quadratique toute règle qui en pose la question pour chacune.
 * Aucun de ces essais ne mesure un temps : ils comparent à la coupe naïve, et comptent le travail.
 */

/** Le nombre d'appels à `String.prototype.indexOf` que fait `travail` (le remplacement est retiré même si `travail` échoue). */
function appelsAIndexOf(travail) {
  const original = String.prototype.indexOf;
  let appels = 0;
  String.prototype.indexOf = function espion(...arguments_) {
    appels += 1;
    return original.apply(this, arguments_);
  };
  try { travail(); } finally { String.prototype.indexOf = original; }
  return appels;
}

test('numeroLigne : le numéro (à partir de 1) de la ligne qui porte le caractère, identique à la coupe naïve sur toutes les entrées', () => {
  const c = 'a\nbb\n\nccc';
  assert.deepEqual([0, 1, 2, 4, 5, 6, 8].map((i) => numeroLigne(c, i)), [1, 1, 2, 2, 3, 4, 4]);
  assert.equal(numeroLigne('', 0), 1);
  assert.equal(numeroLigne('a\r\nb', 3), 2);
  let graine = 7;
  const hasard = () => { graine = (graine * 1103515245 + 12345) & 0x7fffffff; return graine; };
  for (let essai = 0; essai < 300; essai++) {
    const texte = Array.from({ length: hasard() % 12 }, () => 'a\n\r'[hasard() % 3]).join('');
    for (let i = 0; i <= texte.length; i++) assert.equal(numeroLigne(texte, i), texte.slice(0, i).split('\n').length, `${JSON.stringify(texte)} en ${i}`);
  }
});

test('numeroLigne : les sauts de ligne d\'un contenu ne se relèvent qu\'une fois, quel que soit le nombre de questions posées', () => {
  const contenu = `${Array.from({ length: 100 }, (_, i) => `ligne ${i}`).join('\n')}\n// essai des sauts relevés une fois`;
  const questions = 2000;
  let derniere = 0;
  const appels = appelsAIndexOf(() => {
    for (let i = 0; i < questions; i++) derniere = numeroLigne(contenu, (i * 37) % contenu.length);
  });
  assert.equal(appels, 101, 'un `indexOf` par saut (100), plus celui qui dit qu\'il n\'y en a plus : la relève d\'un contenu, une fois pour toutes');
  assert.equal(derniere, contenu.slice(0, (questions - 1) * 37 % contenu.length).split('\n').length, 'et les réponses restent celles de la coupe naïve');
});

test('numeroLigne : plus de contenus alternés que la mémoire n\'en garde donnent encore la ligne juste, sans que la mémoire retenue croisse', () => {
  const contenus = Array.from({ length: 20 }, (_, k) => `${'x\n'.repeat(k + 1)}fin ${k}`);
  for (let tour = 0; tour < 3; tour++) {
    for (const [k, contenu] of contenus.entries()) {
      assert.equal(numeroLigne(contenu, contenu.length - 1), k + 2, `contenu ${k}, tour ${tour}`);
      assert.equal(numeroLigne(contenu, 0), 1);
    }
  }
  // Quatre contenus alternés tiennent dans la mémoire : chacun n'est relevé qu'une fois pour tous les tours.
  const groupe = contenus.slice(0, 4);
  const appels = appelsAIndexOf(() => {
    for (let tour = 0; tour < 50; tour++) for (const contenu of groupe) numeroLigne(contenu, contenu.length - 1);
  });
  assert.equal(appels, groupe.reduce((s, contenu) => s + contenu.split('\n').length, 0), 'un `indexOf` par saut de chaque contenu, plus un par contenu : relevés au plus une fois chacun');
});

test('ligneDe (inventaire) : la même réponse que numeroLigne, sans recopier le début du contenu', () => {
  const contenu = 'a\nbb\n\nccc';
  assert.deepEqual([0, 1, 2, 4, 5, 6, 8].map((i) => ligneDe(contenu, i)), [1, 1, 2, 2, 3, 4, 4]);
  const contenuUnique = `${'y\n'.repeat(50)}fin de l'essai de ligneDe`;
  const appels = appelsAIndexOf(() => { for (let i = 0; i < 500; i++) ligneDe(contenuUnique, i % contenuUnique.length); });
  assert.equal(appels, 51, 'un `indexOf` par saut (50), plus celui qui dit qu\'il n\'y en a plus : relevés une fois');
});
