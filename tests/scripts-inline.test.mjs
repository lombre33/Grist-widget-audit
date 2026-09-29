import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitesJs } from '../src/moteur/analyse-js.js';

/**
 * Quels `<script>` écrits dans la page sont lus comme du JavaScript, et
 * lesquels comme des modules. Chaque ligne a été exécutée dans Chromium 141
 * (sonde du 2026-09-28) ; les deux écarts assumés sont marqués. Avant, un
 * `data-src`, un `data-type`, un `type=""`, un `text/ecmascript` ou une
 * référence de caractère (`type="&#109;odule"`) cachait à toute l'analyse
 * statique un code que le navigateur exécute.
 */

function genre(balise) {
  const unites = unitesJs({ chemin: 'index.html', ext: '.html', binaire: false, contenu: `${balise}vus.push(1)</script>` });
  assert.ok(unites.length <= 1);
  if (!unites.length) return 'ignoré';
  assert.equal(unites[0].source, 'vus.push(1)');
  return unites[0].module ? 'module' : 'classique';
}

const CAS = [
  ['<script>', 'classique'],
  ['<script type="">', 'classique'],
  ['<script type="module">', 'module'],
  ['<script TYPE="MODULE">', 'module'],
  ['<script type=module>', 'module'],
  ['<script type="text/plain" type="module">', 'ignoré'],
  ['<script type="module" type="text/plain">', 'module'],
  ['<script type=" text/javascript ">', 'classique'],
  ['<script type="\ttext/javascript">', 'classique'],
  ['<script type="TEXT/JAVASCRIPT">', 'classique'],
  ['<script type="text/ecmascript">', 'classique'],
  ['<script type="application/x-javascript">', 'classique'],
  ['<script type="text/javascript1.5">', 'classique'],
  ['<script type="text/jscript">', 'classique'],
  ['<script type="text/livescript">', 'classique'],
  ['<script type="text/javascriptx">', 'ignoré'],
  ['<script type="modulex">', 'ignoré'],
  ['<script type="  ">', 'ignoré'],
  ['<script type="text/plain">', 'ignoré'],
  ['<script type="importmap">', 'ignoré'],
  ['<script type="application/ld+json">', 'ignoré'],
  ['<script language="javascript">', 'classique'],
  ['<script language="JavaScript1.2">', 'classique'],
  ['<script language="">', 'classique'],
  ['<script language="vbscript">', 'ignoré'],
  ['<script language=" javascript">', 'ignoré'],
  ['<script language="module">', 'ignoré'],
  ['<script type="" language="vbscript">', 'classique'],
  ['<script type="text/plain" language="javascript">', 'ignoré'],
  ['<script data-src="x.js">', 'classique'],
  ['<script src>', 'ignoré'],
  ['<script src="">', 'ignoré'],
  ['<script data-type="text/plain">', 'classique'],
  ['<script data-x=\'type="text/plain"\'>', 'classique'],
  ['<script type="&#109;odule">', 'module'],
  ['<script type="&#x6D;odule">', 'module'],
  ['<script type="text/&#106;avascript">', 'classique'],
  ['<script type="text/javascript1&period;5">', 'classique'],
  ['<script type="&#116;ext/plain">', 'ignoré'],
  ['<script sr&#99;="x.js">', 'classique'],
  ['<script src="&#x78;.js">', 'ignoré'],
  ['<script/type=text/plain>', 'ignoré'],
  ['<script/type=module>', 'module'],
  ['<script-x>', 'ignoré'],
];

for (const [balise, attendu] of CAS) {
  test(`script de la page : ${balise} → ${attendu}, comme dans Chromium`, () => {
    assert.equal(genre(balise), attendu);
  });
}

test('script de la page : un type JavaScript suivi de paramètres n\'est pas exécuté, comme dans Chromium (sonde du 2026-09-29)', () => {
  assert.equal(genre('<script type="text/javascript; charset=utf-8">'), 'ignoré');
  assert.equal(genre('<script type="text/javascript ;charset=utf-8">'), 'ignoré');
});

test('script de la page, écart assumé : `type=" module "` est un module (le standard retire les blancs de bord ; Chromium ne l\'exécute pas du tout)', () => {
  assert.equal(genre('<script type=" \tmodule\n ">'), 'module');
});

test('script de la page : une valeur entre guillemets jamais refermée engloutit la fin du document, la balise ne se referme pas et rien ne s\'exécute (vérifié dans Chromium)', () => {
  assert.equal(genre('<script type="module>'), 'ignoré');
});
