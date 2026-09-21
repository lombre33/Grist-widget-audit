import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parser, aCommentaireDansPortee } from '../src/moteur/analyse-js.js';
import { analyserGestionErreurs } from '../src/regles/a-qualite.js';
import { analyserStockage } from '../src/regles/c-securite.js';

/**
 * Deux faux positifs trouvés en lisant le vrai code des dépôts de référence,
 * approuvés par la coordination le 2026-09-21 : A-ERR-01 ne voyait pas les
 * commentaires (acorn ne les rattache à aucun nœud sans `onComment`), et
 * C-STOCK-01 ignorait sa propre remédiation (« préférence d'affichage,
 * acceptable si documentée ») en sanctionnant en `majeur` même quand le
 * README documente déjà le mécanisme.
 */

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
}

test('aCommentaireDansPortee : vrai seulement si le commentaire tombe DANS la portée du nœud', () => {
  const ast = parser('function f() { /* dans */ } /* dehors */');
  const fn = ast.body[0];
  assert.equal(aCommentaireDansPortee(ast, fn.body), true, 'le commentaire est entre les accolades de la fonction');
  const astSansCommentaireInterne = parser('/* avant */ function f() { }');
  const fn2 = astSansCommentaireInterne.body[0];
  assert.equal(aCommentaireDansPortee(astSansCommentaireInterne, fn2.body), false, 'le commentaire est avant la fonction, pas dedans');
});

test('A-ERR-01 : un catch vide SANS commentaire est toujours signalé', () => {
  const ctx = { fichiers: [fichier('app.js', 'try { risque(); } catch (e) {}')] };
  const constats = analyserGestionErreurs(ctx);
  assert.equal(constats.filter((c) => c.regle === 'A-ERR-01').length, 1);
});

test('A-ERR-01 : un catch vide avec un commentaire explicatif n\'est plus signalé', () => {
  const ctx = { fichiers: [fichier('app.js', "try { localStorage.setItem('k', v); } catch (e) { /* repli best-effort, sans conséquence */ }")] };
  const constats = analyserGestionErreurs(ctx);
  assert.equal(constats.filter((c) => c.regle === 'A-ERR-01').length, 0);
});

test('A-ERR-01 : parmi plusieurs catch vides, seul celui sans commentaire est signalé', () => {
  const contenu = [
    'try { a(); } catch (e) { /* voulu */ }',
    'try { b(); } catch (e) {}',
    'try { c(); } catch (e) { /* voulu aussi */ }',
  ].join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserGestionErreurs(ctx).filter((c) => c.regle === 'A-ERR-01');
  assert.equal(constats.length, 1);
  assert.equal(constats[0].ligne, 2);
});

test('A-ERR-01 : un catch avec une vraie instruction reste inchangé (comportement existant)', () => {
  const ctx = { fichiers: [fichier('app.js', 'try { a(); } catch (e) { console.error(e); }')] };
  assert.equal(analyserGestionErreurs(ctx).filter((c) => c.regle === 'A-ERR-01').length, 0);
});

test('C-STOCK-01 : sans README, reste majeur (comportement existant)', () => {
  const ctx = { fichiers: [fichier('app.js', "localStorage.setItem('theme', v);")] };
  const c = analyserStockage(ctx).find((x) => x.regle === 'C-STOCK-01');
  assert.equal(c.severite, 'majeur');
  assert.equal(c.preuve.documente, false);
});

test('C-STOCK-01 : README présent mais ne mentionnant pas le mécanisme, reste majeur', () => {
  const ctx = {
    fichiers: [
      fichier('app.js', "localStorage.setItem('theme', v);"),
      fichier('README.md', 'Ce widget affiche des tableaux.'),
    ],
  };
  const c = analyserStockage(ctx).find((x) => x.regle === 'C-STOCK-01');
  assert.equal(c.severite, 'majeur');
});

test('C-STOCK-01 : mécanisme mentionné dans le README, passe en mineur', () => {
  const ctx = {
    fichiers: [
      fichier('app.js', "localStorage.setItem('theme', v);"),
      fichier('README.md', 'Le thème choisi est mémorisé en localStorage, préférence d\'affichage uniquement.'),
    ],
  };
  const c = analyserStockage(ctx).find((x) => x.regle === 'C-STOCK-01');
  assert.equal(c.severite, 'mineur');
  assert.equal(c.preuve.documente, true);
  assert.ok(c.remediation.length > 10, 'la remédiation reste renseignée même en mineur');
});

test('C-STOCK-01 : le README doit être à la racine, un README dans un sous-dossier ne compte pas', () => {
  const ctx = {
    fichiers: [
      fichier('app.js', "localStorage.setItem('theme', v);"),
      fichier('docs/README.md', 'localStorage : préférence d\'affichage.'),
    ],
  };
  const c = analyserStockage(ctx).find((x) => x.regle === 'C-STOCK-01');
  assert.equal(c.severite, 'majeur', 'un README hors racine ne documente pas le widget aux yeux de la règle B-DOC (même convention)');
});
