import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `new URL(import.meta.url).pathname` a cassé en usage réel sur Windows :
// `file:///D:/Dev%20Grist/...` donne un pathname `/D:/Dev%20Grist/...`
// (barre oblique de tête que Windows ne reconnaît pas comme partie de la
// lettre de lecteur, doublée ensuite par `path.resolve()` en `D:\D:\...`),
// et ne décode jamais le pourcentage-encodage — un espace dans le chemin du
// dépôt devient littéralement `%20`. `fileURLToPath()` gère les deux
// correctement ; ce test verrouille que cette conversion produit bien un
// chemin Windows propre, et que plus aucun fichier du dépôt ne reproduise
// l'ancien motif buggé.

const URL_STYLE_WINDOWS = 'file:///D:/Dev%20Grist/grist-widget-audit/src/runtime/dynamique.js';

test("fileURLToPath décode l'espace et ne double pas la lettre de lecteur (chemin Windows)", (t) => {
  if (typeof fileURLToPath('file:///C:/a', { windows: true }) !== 'string') {
    t.skip("cette version de Node n'accepte pas l'option { windows } de fileURLToPath");
    return;
  }
  const resultat = fileURLToPath(URL_STYLE_WINDOWS, { windows: true });
  assert.equal(resultat, 'D:\\Dev Grist\\grist-widget-audit\\src\\runtime\\dynamique.js');
  assert.ok(!resultat.includes('%20'), "l'espace doit être décodé, pas laissé en pourcentage-encodage");
  assert.ok(!resultat.includes('D:\\D:'), 'la lettre de lecteur ne doit apparaître qu\'une fois');
});

test("l'ancien motif (new URL(...).pathname) est bien celui qui cassait — non-régression du diagnostic", () => {
  // Ce test documente le bug lui-même (constaté avec Antoine) : il doit
  // continuer à échouer de cette façon précise si jamais quelqu'un
  // réintroduit ce motif ailleurs, pour qu'on comprenne vite pourquoi.
  const pathnameBrut = new URL(URL_STYLE_WINDOWS).pathname;
  assert.ok(pathnameBrut.includes('%20'), 'new URL(...).pathname ne décode pas — comportement attendu, donc dangereux');
});

/** Retire les commentaires `//` (ligne par ligne) pour ne pas confondre une mention en prose du motif interdit — utile pour l'expliquer, comme ci-dessus — avec un vrai usage en code. Grossier (ignore un `//` à l'intérieur d'une chaîne) mais suffisant pour ce garde-fou ciblé. */
function sansCommentairesDeLigne(code) {
  return code.split('\n').map((ligne) => ligne.replace(/\/\/.*$/, '')).join('\n');
}

test('aucun fichier de code du dépôt ne dérive un chemin depuis import.meta.url autrement que via fileURLToPath', () => {
  const racine = path.resolve(import.meta.dirname, '..');
  const motifInterdit = /new URL\(\s*import\.meta\.url\s*\)\.pathname|import\.meta\.url\s*\.replace\(\s*['"]file:\/\//;
  const dossiersAIgnorer = new Set(['node_modules', '.git', 'rapports', 'docker']);
  // Ce fichier de test mentionne volontairement le motif interdit, en prose
  // et dans un test qui le reproduit exprès (voir plus haut) : il n'a rien
  // à faire dans son propre garde-fou.
  const cheminDeCeTest = path.resolve(import.meta.dirname, 'chemin-fichier-url.test.mjs');

  const fichiersJs = [];
  (function parcourir(dossier) {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      if (dossiersAIgnorer.has(entree.name)) continue;
      const chemin = path.join(dossier, entree.name);
      if (entree.isDirectory()) parcourir(chemin);
      else if (/\.(m?js)$/.test(entree.name) && chemin !== cheminDeCeTest) fichiersJs.push(chemin);
    }
  })(racine);

  assert.ok(fichiersJs.length > 5, 'le parcours doit trouver les fichiers du dépôt (sanity check)');

  const fautifs = fichiersJs.filter((f) => motifInterdit.test(sansCommentairesDeLigne(fs.readFileSync(f, 'utf8'))));
  assert.deepEqual(fautifs.map((f) => path.relative(racine, f)), [], 'utiliser fileURLToPath(import.meta.url), pas new URL(...).pathname ni un .replace("file://", "")');
});
