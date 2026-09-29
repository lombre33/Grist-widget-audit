import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lirePage, integriteProtege, genreDeScript } from '../src/moteur/page-html.js';
import { analyserRessourcesExternes } from '../src/regles/c-securite.js';
import { analyserDependancesDistantes } from '../src/regles/e-dependances.js';

/**
 * Étape 1 de la passe unique du découpeur : tout ce qui lisait la page par
 * expression régulière (scripts, ressources, import maps, surface) passe par
 * `lirePage`, comme le navigateur. Chaque cas a été exécuté dans Chromium 141
 * (sondes du 2026-09-28) : un `>` dans un attribut, un `src`/`type` sans
 * guillemets, un `<!--<script>` qui neutralise le `</script>` suivant, un
 * `<script>` en commentaire, un `data-src`, une URL `//cdn`, une `<base>`
 * externe et une valeur d'`integrity` vide ou bidon trompaient l'ancienne
 * lecture — soit en cachant un chargement tiers, soit en inventant un faux.
 */

function fichier(chemin, contenu) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false };
}
const exfil = (html) => analyserRessourcesExternes({ fichiers: [fichier('index.html', html)] }).filter((c) => c.regle === 'C-EXFIL-03');
const edep = (html) => analyserDependancesDistantes({ fichiers: [fichier('index.html', html)] }).filter((c) => c.regle === 'E-DEP-01');

// integriteProtege ----------------------------------------------------------

test('integriteProtege : une empreinte bien formée protège, une valeur vide ou bidon non (vérifié dans Chromium)', () => {
  const bon = `sha384-${'A'.repeat(64)}`;
  assert.equal(integriteProtege(bon), true);
  assert.equal(integriteProtege(`sha256-${'A'.repeat(43)}=`), true, 'rembourrage base64 accepté');
  assert.equal(integriteProtege(`sha512-${'_-'.repeat(43)}`), true, 'base64url accepté');
  assert.equal(integriteProtege(`${bon}?ce-que-tu-veux`), true, 'options après ? ignorées');
  assert.equal(integriteProtege(`md5-x ${bon}`), true, 'un seul jeton valide suffit à côté d\'un invalide');
  for (const mauvais of ['', '   ', 'x', 'sha384-', 'sha384-!!!', 'md5-abcdef', 'sha1-abcdef', `SHA384-${'A'.repeat(64)}`]) {
    assert.equal(integriteProtege(mauvais), false, `${JSON.stringify(mauvais)} ne protège pas : le navigateur charge n'importe quoi`);
  }
  assert.equal(integriteProtege(undefined), false);
});

// lirePage : ce que le navigateur exécute vraiment ---------------------------

test('lirePage : un <script src> en commentaire HTML n\'est pas un script (rien à charger)', () => {
  const { scripts } = lirePage('<!-- <script src="https://cdn.tiers/evil.js"></script> -->');
  assert.equal(scripts.length, 0);
});

test('lirePage : data-src n\'est pas src — le contenu s\'exécute en ligne, aucun chargement externe', () => {
  const [s] = lirePage('<script data-src="https://cdn.tiers/x.js">reel()</script>').scripts;
  assert.equal(s.src, null);
  assert.equal(s.texte, 'reel()');
});

test('lirePage : un <!--<script> neutralise le </script> suivant, qui devient du texte du premier script (le <script src> masqué n\'est pas un chargement)', () => {
  // Vérifié dans Chromium : rien ne s'exécute et apres.js n'est pas chargé,
  // car le </script> est avalé par l'état « script data double escaped ».
  const { scripts } = lirePage('<script>a=1;/*<!--<script>*/b()</script><script src="https://cdn.tiers/apres.js"></script>');
  assert.equal(scripts.length, 1, 'un seul script : le second est avalé dans le texte du premier');
  assert.equal(scripts[0].src, null);
  assert.match(scripts[0].texte, /apres\.js/, 'le <script src> masqué est du texte, pas un élément');
});

test('lirePage : la première <base href> décide de la base, une base en commentaire est ignorée', () => {
  assert.equal(lirePage('<base href="https://cdn.tiers/"><script src="app.js"></script>').scripts[0].base, 'https://cdn.tiers/');
  assert.equal(lirePage('<base target="_blank"><base href="https://un.tiers/"><base href="https://deux.tiers/"><script src="a.js"></script>').scripts[0].base, 'https://un.tiers/', 'première base AVEC href');
  assert.equal(lirePage('<!-- <base href="https://evil.tiers/"> --><script src="a.js"></script>').scripts[0].base, 'https://widget.local/', 'base en commentaire ignorée');
});

test('lirePage : un <script> SVG charge par href ou xlink:href, et exécute un module comme un module', () => {
  assert.equal(lirePage('<svg><script href="data:text/javascript,alert(1)"></script></svg>').scripts[0].src, 'data:text/javascript,alert(1)');
  assert.equal(lirePage('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><script xlink:href="x.js"></script></svg>').scripts[0].src, 'x.js');
  assert.equal(lirePage('<svg><script type="module">a()</script></svg>').scripts[0].genre, 'module');
  assert.equal(lirePage('<svg><script type="importmap">{}</script></svg>').scripts[0].genre, null, 'pas d\'import map en SVG');
});

test('genreDeScript : nomodule sur un script classique le rend non exécuté, importmap est reconnu', () => {
  assert.equal(genreDeScript(new Map([['nomodule', '']])), null);
  assert.equal(genreDeScript(new Map([['type', 'importmap']])), 'importmap');
  assert.equal(genreDeScript(new Map([['type', 'module'], ['nomodule', '']])), 'module', 'nomodule n\'a pas de sens sur un module');
});

// C-EXFIL-03 : chargements que l'ancienne lecture ratait ou inventait --------

test('C-EXFIL-03 : un > dans un attribut avant src ne cache plus le chargement tiers', () => {
  const [c] = exfil('<script data-note="a>b" src="https://cdn.tiers/x.js"></script>');
  assert.ok(c, 'l\'ancien motif [^>]* s\'arrêtait au > de l\'attribut et ratait src');
  assert.equal(c.bloquant, true);
});

test('C-EXFIL-03 : un src sans guillemets est lu comme par le navigateur', () => {
  const [c] = exfil('<script src=https://cdn.tiers/y.js></script>');
  assert.ok(c);
  assert.equal(c.bloquant, true);
});

test('C-EXFIL-03 : une URL relative au protocole (//cdn) est un chargement tiers', () => {
  const [c] = exfil('<script src="//cdn.tiers/z.js"></script>');
  assert.ok(c);
  assert.equal(c.titre, 'Ressource externe chargée depuis cdn.tiers (script)');
});

test('C-EXFIL-03 : une <base> externe fait charger un src relatif chez un tiers', () => {
  const [c] = exfil('<base href="https://cdn.tiers/"><script src="app.js"></script>');
  assert.ok(c, 'sans suivre la base, ce script « local » échappait à la règle');
  assert.equal(c.titre, 'Ressource externe chargée depuis cdn.tiers (script)');
});

test('C-EXFIL-03 : integrity vide ou bidon ne déclasse pas (le navigateur charge n\'importe quoi)', () => {
  for (const mauvais of ['', 'x', 'sha384-!!!']) {
    const [c] = exfil(`<script src="https://cdn.tiers/i.js" integrity="${mauvais}"></script>`);
    assert.equal(c.bloquant, true, `integrity="${mauvais}" ne protège pas`);
    assert.match(c.constat, /sans contrôle d'intégrité/);
  }
});

test('C-EXFIL-03 : une integrity bien formée déclasse (script non bloquant, avec integrity)', () => {
  const [c] = exfil(`<script src="https://cdn.tiers/i.js" integrity="sha384-${'A'.repeat(64)}"></script>`);
  assert.equal(c.bloquant, false);
  assert.match(c.constat, /avec attribut `integrity`/);
});

test('C-EXFIL-03 : un <script> en commentaire ou un data-src ne produit aucun faux constat', () => {
  assert.equal(exfil('<!-- <script src="https://cdn.tiers/evil.js"></script> -->').length, 0);
  assert.equal(exfil('<script data-src="https://cdn.tiers/x.js">reel()</script>').length, 0);
});

// E-DEP-01 : mêmes corrections côté dépendances -----------------------------

test('E-DEP-01 : une URL //cdn est désormais vue comme une dépendance distante', () => {
  const [c] = edep('<script src="//cdn.jsdelivr.net/npm/x@1.0.0/x.js"></script>');
  assert.ok(c, 'l\'ancien motif exigeait https:// explicite et ratait //cdn');
  assert.equal(c.severite, 'critique');
});

test('E-DEP-01 : integrity vide reste critique, une integrity bien formée passe à majeur', () => {
  assert.equal(edep('<script src="https://esm.sh/x@1.0.0" integrity=""></script>')[0].severite, 'critique');
  assert.equal(edep(`<script src="https://esm.sh/x@1.0.0" integrity="sha384-${'A'.repeat(64)}"></script>`)[0].severite, 'majeur');
});

test('E-DEP-01 : un data-src ou un script commenté ne produit aucune fausse dépendance', () => {
  assert.equal(edep('<script data-src="https://esm.sh/x@1.0.0">a()</script>').length, 0);
  assert.equal(edep('<!-- <script src="https://esm.sh/x@1.0.0"></script> -->').length, 0);
});
