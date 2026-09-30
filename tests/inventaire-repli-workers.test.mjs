import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referencesDeCode } from '../src/contexte/inventaire.js';

/**
 * Le repli par expressions régulières de l'inventaire (un code qu'acorn ne lit pas : TypeScript, JSX, une erreur de syntaxe)
 * cherche les `importScripts(…)` et les `serviceWorker.register(…)` / `….addModule(…)` d'un worker. Deux de ses expressions
 * relisaient le reste du texte à chaque occurrence : `importScripts\s*\(([^)]*)\)` quand aucune parenthèse ne ferme, et le
 * préfixe `(?:\w+\.)*` de la forme des worklets, sur une chaîne `a.a.a.…` (quadratique : un fichier de 200 Kio en faisait plus de
 * trente secondes). Elles sont réécrites en temps linéaire, sans changer ce qu'elles trouvent : ces essais comparent le repli
 * aux deux expressions d'origine, recopiées ici comme modèle, sur des cas nommés puis sur des milliers de textes tirés au hasard.
 * Le temps, lui, ne se compare pas ici (aucun budget en temps réel dans la suite) : `scripts/chronometrer-pieges.mjs` le mesure.
 */

const refsDe = (texte) => [...referencesDeCode(
  { chemin: 'a.ts', ext: '.ts', contenu: texte, binaire: false, executee: true },
  { source: texte, inline: false, debut: null },
  { ast: null, erreur: null },
)].map((r) => (typeof r === 'string' ? r : r.documentRelatif ?? r.relatif));

/** Le modèle : les deux expressions d'origine, dans l'ordre où le repli les lisait (les `importScripts`, puis les worklets). */
function modele(texte) {
  const refs = [];
  for (const m of texte.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
    for (const t of m[1].matchAll(/["']([^"']+)["']/g)) refs.push(t[1]);
  }
  for (const m of texte.matchAll(/(?:^|[^\w$])(?:\w+\.)*(?:serviceWorker\.register|\w*[Ww]orklet\.addModule)\s*\(\s*["']([^"']+)["']/g)) refs.push(m[1]);
  return refs;
}

test('importScripts : chaque argument littéral du premier appel jusqu\'à sa parenthèse fermante, et la recherche reprend après elle', () => {
  assert.deepEqual(refsDe("importScripts('a.js', \"b.js\");"), ['a.js', 'b.js']);
  assert.deepEqual(refsDe("importScripts ( 'a.js' )"), ['a.js'], 'des blancs avant la parenthèse ouvrante et autour des arguments');
  assert.deepEqual(refsDe("importScripts('a.js')importScripts('b.js')"), ['a.js', 'b.js'], 'deux appels collés');
  assert.deepEqual(refsDe("importScripts('a.js');\nfoo('x.js');\nimportScripts('b.js');"), ['a.js', 'b.js'], 'ce qui suit la parenthèse fermante n\'est pas un argument');
  assert.deepEqual(refsDe("x() importScripts('a.js')"), ['a.js'], 'une parenthèse fermante qui précède l\'appel n\'en est pas la fin');
  assert.deepEqual(refsDe("importScripts('a.js', importScripts('b.js'))"), ['a.js', 'b.js'], 'un appel dans les arguments d\'un autre : lu une fois, non deux');
  assert.deepEqual(refsDe("importScripts()"), []);
  assert.deepEqual(refsDe("myimportScripts('a.js')"), [], 'le mot entier');
  assert.deepEqual(refsDe("importScripts('a.js'"), [], 'sans parenthèse fermante, aucun argument n\'est lu');
  assert.deepEqual(refsDe("importScripts('a.js', 'b.js'\nimportScripts('c.js')"), ['a.js', 'b.js', 'c.js'], 'un appel qui ne se ferme pas se ferme à la première parenthèse fermante, celle d\'un autre appel : ses arguments sont lus jusque-là');
});

test('worklets et service workers : la frontière avant le nom décide, non la chaîne qui le précède', () => {
  assert.deepEqual(refsDe("navigator.serviceWorker.register('sw.js')"), ['sw.js']);
  assert.deepEqual(refsDe("a.b.c.serviceWorker.register(\"sw.js\")"), ['sw.js']);
  assert.deepEqual(refsDe("serviceWorker.register('sw.js')"), ['sw.js'], 'au début du texte');
  assert.deepEqual(refsDe("$x.serviceWorker.register('sw.js')"), ['sw.js'], 'un point est une frontière, même derrière un `$`');
  assert.deepEqual(refsDe("xserviceWorker.register('sw.js')"), [], 'collé à un mot : ce n\'est pas ce nom');
  assert.deepEqual(refsDe("$serviceWorker.register('sw.js')"), [], 'collé à un `$` : ce n\'est pas ce nom');
  assert.deepEqual(refsDe("ctx.audioWorklet.addModule('m.js')"), ['m.js']);
  assert.deepEqual(refsDe("xWorklet.addModule('m.js')"), ['m.js'], '`\\w*` devant Worklet : tout nom qui finit par Worklet');
  assert.deepEqual(refsDe("CSS.paintWorklet.addModule(\"p.js\")"), ['p.js']);
  assert.deepEqual(refsDe("$Worklet.addModule('m.js')"), [], 'un `$` devant : ni frontière ni mot');
  assert.deepEqual(refsDe("a.serviceWorker.register('a.js');b.serviceWorker.register('b.js')"), ['a.js', 'b.js']);
  assert.deepEqual(refsDe("a.serviceWorker.register('a.js'.serviceWorker.register('b.js')"), ['a.js', 'b.js'], 'un nom qui suit la fin du précédent, par un point');
  assert.deepEqual(refsDe("x.serviceWorker.register(sw)"), [], 'un argument qui n\'est pas une chaîne littérale n\'est pas un fichier');
});

test('les `importScripts` se lisent avant les worklets, comme avant la réécriture', () => {
  assert.deepEqual(refsDe("navigator.serviceWorker.register('sw.js'); importScripts('a.js');"), ['a.js', 'sw.js']);
});

test('une longue suite qui ne mène à rien ne fait rien manquer de ce qui la suit', () => {
  assert.deepEqual(refsDe(`${'a.'.repeat(20000)}serviceWorker.register('sw.js')`), ['sw.js'], 'une chaîne a.a.a.… devant le nom');
  assert.deepEqual(refsDe(`${'a.'.repeat(20000)}b`), [], 'la même chaîne sans nom : rien');
  assert.deepEqual(refsDe(`${'importScripts('.repeat(5000)}'x.js')`), ['x.js'], 'des milliers d\'en-têtes qu\'une seule parenthèse ferme : les arguments de la première, une fois');
  assert.deepEqual(refsDe(`${"importScripts('y.js'".repeat(5000)}`), [], 'des milliers d\'en-têtes sans parenthèse fermante');
  assert.deepEqual(refsDe(`${"importScripts('y.js')".repeat(3000)}`), Array(3000).fill('y.js'), 'des milliers d\'appels fermés : chacun une fois');
});

test('le repli donne ce que donnaient les deux expressions d\'origine, sur des textes tirés au hasard', () => {
  const JETONS = ['a', 'b', '.', '$', '_', ' ', '\n', '(', ')', "'", '"', ',', ';', 'é', '0',
    'importScripts', 'importScripts(', "importScripts('a.js'", "importScripts('a.js', \"b.js\")", 'importScripts()', "'c.js'", '"d.js"',
    'serviceWorker.register', "serviceWorker.register('sw.js')", 'serviceWorker', '.register', 'navigator.', 'window.', 'x.', '$x.', '1.',
    'audioWorklet.addModule', "Worklet.addModule('m.js')", 'xWorklet.addModule', 'worklet.addModule', "('w.js')", '("m.js")', "('a'", '("b"'];
  let x = 4242;
  const hasard = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  let avecReferences = 0, avecPlusieurs = 0;
  for (let i = 0; i < 30000; i++) {
    let texte = '';
    for (let j = 1 + Math.floor(hasard() * 14); j > 0; j--) texte += JETONS[Math.floor(hasard() * JETONS.length)] + (hasard() < 0.3 ? ' ' : '');
    const attendu = modele(texte);
    if (attendu.length) avecReferences++;
    if (attendu.length > 1) avecPlusieurs++;
    assert.deepEqual(refsDe(texte), attendu, JSON.stringify(texte));
  }
  assert.ok(avecReferences > 5000 && avecPlusieurs > 500, `la comparaison porte sur des textes qui ont des références (${avecReferences}, dont ${avecPlusieurs} à plusieurs) : sinon elle ne prouve rien`);
});
