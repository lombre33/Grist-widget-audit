import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserSignauxGeneration } from '../src/regles/b-lisibilite.js';
import { analyserPaquetNpm } from '../src/regles/e-dependances.js';
import { analyserAccessibiliteStatique, analyserConformiteGuide } from '../src/regles/f-conformite.js';

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
}

test('B-IA-01 localise la première occurrence, pas seulement le fichier', () => {
  const contenu = [
    'const x = 1;',
    '// Step 1: init',
    '// Step 2: load',
    '// Step 3: transform',
    '// Step 4: render',
    '// Voici le code qui suit',
    "// Here's the implementation",
    '// Added the feature',
    '// Check if the result',
  ].join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserSignauxGeneration(ctx);
  const c = constats.find((x) => x.regle === 'B-IA-01');
  assert.ok(c, 'la règle doit se déclencher (4 familles, 8 occurrences)');
  assert.equal(c.ligne, 2, 'doit pointer la ligne du premier marqueur (`// Step 1: init`), pas seulement le fichier');
});

test("E-DEP-05 pointe la ligne de la dépendance à version flottante dans package.json", async () => {
  const pkgTexte = ['{', '  "dependencies": {', '    "left-pad": "^1.2.3"', '  }', '}'].join('\n');
  const ctx = {
    fichiers: [fichier('package.json', pkgTexte), { chemin: 'package-lock.json', contenu: '{}', lignes: ['{}'] }],
    paquet: { dependencies: { 'left-pad': '^1.2.3' } },
  };
  const constats = await analyserPaquetNpm(ctx, { reseau: false });
  const c = constats.find((x) => x.regle === 'E-DEP-05');
  assert.ok(c);
  assert.equal(c.ligne, 3, 'la déclaration `"left-pad": "^1.2.3"` est en ligne 3');
  assert.deepEqual(c.preuve.emplacements.map((e) => e.nom), ['left-pad']);
});

test("F-RGAA-01 localise la balise <html> sans attribut lang", () => {
  const html = ['<!doctype html>', '<html>', '<head></head>', '<body></body>', '</html>'].join('\n');
  const ctx = { fichiers: [fichier('index.html', html)], entrees: ['index.html'] };
  const constats = analyserAccessibiliteStatique(ctx);
  const c = constats.find((x) => x.regle === 'F-RGAA-01');
  assert.ok(c);
  assert.equal(c.ligne, 2, 'la balise <html> est en ligne 2');
});

test('F-RGAA-05 : bouton avec seulement une icône (span/svg/i), sans texte ni aria-label, est détecté', () => {
  const html = ['<!doctype html>', '<html><body>', '<button><svg></svg></button>', '</body></html>'].join('\n');
  const ctx = { fichiers: [fichier('index.html', html)], entrees: ['index.html'] };
  const c = analyserAccessibiliteStatique(ctx).find((x) => x.regle === 'F-RGAA-05');
  assert.ok(c);
});

test('F-RGAA-05 : un bouton avec du texte, ou avec aria-label, ne déclenche rien', () => {
  const html = ['<!doctype html>', '<html><body>', '<button><i></i>Fermer</button>', '<button aria-label="Fermer"><i></i></button>', '</body></html>'].join('\n');
  const ctx = { fichiers: [fichier('index.html', html)], entrees: ['index.html'] };
  assert.equal(analyserAccessibiliteStatique(ctx).filter((x) => x.regle === 'F-RGAA-05').length, 0);
});

test("F-RGAA-05 : du HTML sans </button> qui referme la construction ne doit jamais faire exploser le temps d'analyse (retour arrière catastrophique relevé par la coordination le 2026-09-28 sur flashcards/index.html, un widget officiel de Grist qui dépassait le délai de 240 s de l'audit entier)", () => {
  const piege = '<button>' + '<i> '.repeat(2000) + 'X'; // jamais de </button>
  const html = ['<!doctype html>', '<html><body>', piege, '</body></html>'].join('\n');
  const ctx = { fichiers: [fichier('index.html', html)], entrees: ['index.html'] };
  const debut = Date.now();
  analyserAccessibiliteStatique(ctx);
  const duree = Date.now() - debut;
  assert.ok(duree < 1000, `doit rester linéaire (${duree} ms) — l'ancienne regex à quantificateurs imbriqués aurait explosé bien avant ce volume`);
});

test('F-GUIDE-03/04 localisent l\'entrée fautive dans le manifest.json brut', () => {
  const manifesteTexte = [
    '[',
    '  { "name": "Mon widget" }',
    ']',
  ].join('\n');
  const ctx = {
    racine: '/tmp/grist-widget-test',
    fichiers: [fichier('manifest.json', manifesteTexte)],
    manifestes: [{ chemin: 'manifest.json', contenu: [{ name: 'Mon widget' }] }],
    usagesGrist: { acces: [{ niveau: 'full' }] },
  };
  const constats = analyserConformiteGuide(ctx);
  const c03 = constats.find((x) => x.regle === 'F-GUIDE-03');
  const c04 = constats.find((x) => x.regle === 'F-GUIDE-04');
  assert.ok(c03 && c04);
  assert.equal(c03.ligne, 2);
  assert.equal(c04.ligne, 2);
});

test('C-XSS-02 (document.write) donne une remédiation concrète, pas générique', async () => {
  const { analyserInjections } = await import('../src/regles/c-securite.js');
  const ctx = { fichiers: [fichier('app.js', 'document.write("<p>" + x + "</p>");')] };
  const constats = analyserInjections(ctx);
  const c = constats.find((x) => x.regle === 'C-XSS-02');
  assert.ok(c);
  assert.notEqual(c.remediation.trim(), 'Remplacer par une manipulation du DOM.');
  assert.match(c.remediation, /createElement|textContent/);
});
