/**
 * Le résumé du contexte (src/contexte/resume.js) sur des contextes construits à la main : chaque champ que les
 * rapports et l'axe D lisent est gardé, ce qui n'en fait pas partie n'est pas emporté (le contenu de tous les
 * fichiers reste dans l'enfant), et le plus gros fichier de code est celui qu'on nomme. L'équivalence des rapports
 * sur de vrais widgets est dans tests/isolement-equivalence.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contexteDepuisResume, resumerContexte } from '../src/contexte/resume.js';

const fichier = (chemin, o = {}) => ({ chemin, taille: 10, code: false, contenu: `contenu de ${chemin}`, arbre: { gros: 'arbre' }, ...o });

const CTX = {
  racine: '/depot',
  entrees: ['index.html'],
  fichiersReels: 5,
  tronque: null,
  surface: { size: 3, has: () => true },
  fichiers: [
    fichier('index.html'),
    fichier('README.md', { contenu: 'Accès demandé : lecture.' }),
    fichier('docs/README.md', { contenu: 'un README qui n\'est pas à la racine' }),
    fichier('app.js', { code: true, taille: 500 }),
    fichier('gros.js', { code: true, taille: 9000 }),
    fichier('style.css', { taille: 90_000 }),
  ],
  usagesGrist: { acces: [{ niveau: 'full', fichier: 'app.js', ligne: 1 }, { niveau: 'read table' }] },
};

test('le résumé garde ce que les rapports et l\'axe D lisent', () => {
  const r = resumerContexte(CTX);
  assert.equal(r.racine, '/depot');
  assert.deepEqual(r.entrees, ['index.html']);
  assert.equal(r.fichiersReels, 5);
  assert.equal(r.tailleSurface, 3);
  assert.equal(r.tronque, null);
  assert.deepEqual(r.usagesGrist, { acces: [{ niveau: 'full' }, { niveau: 'read table' }] });
});

test('le README de la racine garde son contenu, celui d\'un sous-dossier n\'est pas emporté', () => {
  const r = resumerContexte(CTX);
  assert.deepEqual(r.fichiers.find((f) => f.chemin === 'README.md'), { chemin: 'README.md', contenu: 'Accès demandé : lecture.' });
  assert.equal(r.fichiers.some((f) => f.chemin === 'docs/README.md'), false);
});

test('le contenu et l\'arbre des autres fichiers restent dans l\'enfant', () => {
  const r = JSON.stringify(resumerContexte(CTX));
  assert.doesNotMatch(r, /contenu de app\.js|arbre/);
  assert.equal(resumerContexte(CTX).fichiers.length, 1);
});

test('le plus gros fichier de CODE est nommé, pas le plus gros fichier', () => {
  assert.deepEqual(resumerContexte(CTX).plusGrosFichierDeCode, { chemin: 'gros.js', taille: 9000 });
});

test('sans fichier de code : pas de plus gros fichier', () => {
  assert.equal(resumerContexte({ ...CTX, fichiers: [fichier('index.html'), fichier('style.css', { taille: 5 })] }).plusGrosFichierDeCode, null);
});

test('le nombre de fichiers vient de l\'inventaire réel, à défaut du nombre de fichiers du contexte', () => {
  assert.equal(resumerContexte({ ...CTX, fichiersReels: undefined }).fichiersReels, CTX.fichiers.length);
});

test('un fichier issu d\'un code exécuté depuis une chaîne garde son origine, et la chaîne entière jusqu\'au fichier réel, quel que soit l\'ordre des fichiers', () => {
  const chaine = [
    fichier('app.js', { code: true }),
    fichier('app.js#eval@2', { code: true, litteralImbrique: true, origineReelle: { chemin: 'app.js', ligne: 2 } }),
    fichier('app.js#eval@2#eval@1', { code: true, litteralImbrique: true, origineReelle: { chemin: 'app.js#eval@2', ligne: 1 } }),
  ];
  // Le maillon d'origine peut venir avant ou après celui qui le nomme : la chaîne se suit dans les deux cas.
  for (const [nom, fichiers] of [['dans l\'ordre', chaine], ['à l\'envers', [...chaine].reverse()]]) {
    const r = resumerContexte({ ...CTX, fichiers });
    const parChemin = new Map(r.fichiers.map((f) => [f.chemin, f]));
    assert.deepEqual(parChemin.get('app.js#eval@2#eval@1').origineReelle, { chemin: 'app.js#eval@2', ligne: 1 }, nom);
    assert.deepEqual(parChemin.get('app.js#eval@2').origineReelle, { chemin: 'app.js', ligne: 2 }, nom);
    assert.equal(parChemin.get('app.js#eval@2').litteralImbrique, true, nom);
    assert.ok(parChemin.has('app.js'), `${nom} : le fichier réel où la chaîne prend sa source est là`);
    assert.equal(parChemin.get('app.js').litteralImbrique, undefined, nom);
  }
});

test('une chaîne d\'origines qui boucle ne fait pas boucler le résumé', () => {
  const ctx = {
    ...CTX,
    fichiers: [
      fichier('a', { litteralImbrique: true, origineReelle: { chemin: 'b', ligne: 1 } }),
      fichier('b', { litteralImbrique: true, origineReelle: { chemin: 'a', ligne: 1 } }),
    ],
  };
  const r = resumerContexte(ctx);
  assert.deepEqual(r.fichiers.map((f) => f.chemin).sort(), ['a', 'b']);
});

test('sans usagesGrist (l\'axe C n\'a pas tourné) : le résumé n\'en invente pas', () => {
  const { usagesGrist, ...sans } = CTX;
  const r = resumerContexte(sans);
  assert.equal('usagesGrist' in r, false);
  assert.equal('usagesGrist' in contexteDepuisResume(r), false);
});

test('contexteDepuisResume répond aux lecteurs : taille de surface, fichiers, niveaux d\'accès', () => {
  const c = contexteDepuisResume(resumerContexte(CTX));
  assert.equal(c.surface.size, 3);
  assert.equal(c.fichiersReels, 5);
  assert.deepEqual(c.entrees, ['index.html']);
  assert.deepEqual(c.usagesGrist.acces.map((a) => a.niveau), ['full', 'read table']);
  assert.ok(c.fichiers.some((f) => f.chemin === 'README.md'));
});

test('une inventaire tronqué (dépôt anormalement volumineux) reste dit après le résumé', () => {
  const tronque = { fichiers: true, octets: false };
  const r = resumerContexte({ ...CTX, tronque });
  assert.deepEqual(r.tronque, tronque);
  assert.deepEqual(contexteDepuisResume(r).tronque, tronque);
});
