import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { extraireImportMaps } from '../src/moteur/analyse-js.js';
import { analyserRessourcesExternes, analyserSortiesReseau } from '../src/regles/c-securite.js';
import { analyserDependancesDistantes } from '../src/regles/e-dependances.js';
import { construireContexte } from '../src/contexte/inventaire.js';

/**
 * Demande d'Antoine (2026-09-28, relayée depuis le fil du prompt d'audit
 * LLM) : se mettre dans la peau de qui veut déployer un widget malveillant
 * et vérifier toutes les balises, pas seulement `<script src>`. Trou trouvé
 * en lisant `publipostageGrist` : ses dépendances (TipTap/ProseMirror) sont
 * déclarées par `<script type="importmap">` puis importées par spécificateur
 * nu — invisible à E-DEP-01 (qui ne lisait que `<script src>`) comme à
 * C-EXFIL-03 (même limite) et à toute règle basée sur l'AST JS (le JSON d'une
 * import map n'est jamais un `unitesJs`). Ajouté aussi : `<object>`/`<embed>`
 * (mineur, même traitement que `<img>`).
 *
 * Une piste explorée puis abandonnée après vérification par l'exécution (vraie
 * Chromium, voir la conversation) : une règle dédiée pour un
 * `Worker`/`SharedWorker` construit avec une URL externe. En réalité,
 * `new Worker(url-externe)` / `new SharedWorker(url-externe)` lève toujours
 * une `SecurityError` synchrone, y compris avec `type: 'module'` et des
 * en-têtes CORS permissifs — ce n'est pas un vecteur, c'est du code cassé.
 * Le vrai trou était ailleurs : `referencesSortantes()` (dans
 * `src/contexte/inventaire.js`) ne suivait jamais un
 * `new Worker('./local.js')`, donc le fichier du worker n'entrait jamais
 * dans la surface exécutée — son contenu (un `importScripts()` vers
 * l'extérieur, par exemple, qui lui s'exécute bien sans CORS) échappait
 * silencieusement à toutes les règles de l'axe C, quel que soit le domaine
 * visé. C'est ce trou-là qui est corrigé ci-dessous.
 */

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
}

function depotTemporaire(fichiers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-worker-surface-'));
  for (const [rel, contenu] of Object.entries(fichiers)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contenu);
  }
  return dir;
}

function importmap(objet) {
  return `<script type="importmap">\n${JSON.stringify(objet)}\n</script>`;
}

// ---------------------------------------------------------------------------
// extraireImportMaps (moteur partagé)
// ---------------------------------------------------------------------------

test('extraireImportMaps : lit imports et scopes, dédoublonne par URL cible', () => {
  const html = importmap({
    imports: { a: 'https://esm.sh/a@1.0.0', b: 'https://esm.sh/b@1.0.0' },
    scopes: { '/x/': { c: 'https://esm.sh/a@1.0.0' } }, // même URL que `a` : ne doit pas dupliquer
  });
  const entrees = extraireImportMaps(html);
  assert.equal(entrees.length, 2, 'deux URL cibles distinctes malgré 3 spécificateurs');
  assert.ok(entrees.some((e) => e.url === 'https://esm.sh/a@1.0.0'));
  assert.ok(entrees.some((e) => e.url === 'https://esm.sh/b@1.0.0'));
});

test('extraireImportMaps : marque sri=true seulement pour les URL couvertes par la clé integrity de premier niveau', () => {
  const html = importmap({
    imports: { a: 'https://esm.sh/a@1.0.0', b: 'https://esm.sh/b@1.0.0' },
    integrity: { 'https://esm.sh/a@1.0.0': 'sha384-xxx' },
  });
  const entrees = extraireImportMaps(html);
  assert.equal(entrees.find((e) => e.url.endsWith('/a@1.0.0')).sri, true);
  assert.equal(entrees.find((e) => e.url.endsWith('/b@1.0.0')).sri, false);
});

test('extraireImportMaps : JSON invalide est ignoré sans lever d\'exception', () => {
  const html = '<script type="importmap">{ ceci n\'est pas du JSON </script>';
  assert.doesNotThrow(() => extraireImportMaps(html));
  assert.deepEqual(extraireImportMaps(html), []);
});

// ---------------------------------------------------------------------------
// E-DEP-01 : import maps
// ---------------------------------------------------------------------------

test('E-DEP-01 : dépendance résolue par import map sans integrity, critique et bloquant', () => {
  const html = importmap({ imports: { 'prosemirror-model': 'https://esm.sh/prosemirror-model@1.25.11' } });
  const ctx = { fichiers: [fichier('index.html', html)] };
  const c = analyserDependancesDistantes(ctx).find((x) => x.regle === 'E-DEP-01');
  assert.ok(c, 'doit se déclencher : une import map n\'était vue par aucune règle avant ce correctif');
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test('E-DEP-01 : dépendance résolue par import map avec integrity, sévérité ramenée à majeur', () => {
  const html = importmap({
    imports: { 'prosemirror-model': 'https://esm.sh/prosemirror-model@1.25.11' },
    integrity: { 'https://esm.sh/prosemirror-model@1.25.11': 'sha384-xxx' },
  });
  const ctx = { fichiers: [fichier('index.html', html)] };
  const c = analyserDependancesDistantes(ctx).find((x) => x.regle === 'E-DEP-01');
  assert.ok(c);
  assert.equal(c.severite, 'majeur');
  assert.equal(c.bloquant, false);
});

test('E-DEP-01 : import map ne pointant que vers des chemins relatifs (vendoring fait dans les règles) ne déclenche rien', () => {
  const html = importmap({ imports: { 'mon-utilitaire': './vendor/mon-utilitaire.js' } });
  const ctx = { fichiers: [fichier('index.html', html)] };
  const constats = analyserDependancesDistantes(ctx).filter((x) => x.regle === 'E-DEP-01');
  assert.equal(constats.length, 0, 'un chemin local dans une import map est la mise en conformité recommandée, pas un défaut');
});

test('E-DEP-01 : import map avec du JSON invalide ne fait pas planter l\'analyse et ne produit aucun faux constat', () => {
  const html = '<script type="importmap">{ pas du json </script>';
  const ctx = { fichiers: [fichier('index.html', html)] };
  assert.doesNotThrow(() => analyserDependancesDistantes(ctx));
  assert.equal(analyserDependancesDistantes(ctx).filter((x) => x.regle === 'E-DEP-01').length, 0);
});

// ---------------------------------------------------------------------------
// C-EXFIL-03 : import maps, <object>, <embed>
// ---------------------------------------------------------------------------

test('C-EXFIL-03 : dépendance résolue par import map sans integrity, critique et bloquant (même règle qu\'un <script src>)', () => {
  const html = importmap({ imports: { 'prosemirror-model': 'https://esm.sh/prosemirror-model@1.25.11' } });
  const ctx = { fichiers: [fichier('index.html', html)] };
  const c = analyserRessourcesExternes(ctx).find((x) => x.regle === 'C-EXFIL-03' && /import map/i.test(x.titre));
  assert.ok(c);
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test('C-EXFIL-03 : import map avec integrity, sévérité ramenée à majeur', () => {
  const html = importmap({
    imports: { 'prosemirror-model': 'https://esm.sh/prosemirror-model@1.25.11' },
    integrity: { 'https://esm.sh/prosemirror-model@1.25.11': 'sha384-xxx' },
  });
  const ctx = { fichiers: [fichier('index.html', html)] };
  const c = analyserRessourcesExternes(ctx).find((x) => x.regle === 'C-EXFIL-03' && /import map/i.test(x.titre));
  assert.ok(c);
  assert.equal(c.severite, 'majeur');
  assert.equal(c.bloquant, false);
});

test('C-EXFIL-03 : import map ne pointant que vers des chemins relatifs ne déclenche rien', () => {
  const html = importmap({ imports: { 'mon-utilitaire': './vendor/mon-utilitaire.js' } });
  const ctx = { fichiers: [fichier('index.html', html)] };
  const constats = analyserRessourcesExternes(ctx).filter((x) => x.regle === 'C-EXFIL-03' && /import map/i.test(x.titre));
  assert.equal(constats.length, 0);
});

test('C-EXFIL-03 : import map pointant vers l\'API Grist elle-même ne déclenche rien (hors périmètre)', () => {
  const html = importmap({ imports: { grist: 'https://grist.numerique.gouv.fr/grist-plugin-api.js' } });
  const ctx = { fichiers: [fichier('index.html', html)] };
  const constats = analyserRessourcesExternes(ctx).filter((x) => x.regle === 'C-EXFIL-03' && /import map/i.test(x.titre));
  assert.equal(constats.length, 0);
});

test('C-EXFIL-03 : <object data> externe est signalé en mineur, comme <img>', () => {
  const html = '<object data="https://exemple.tiers/rapport.pdf"></object>';
  const ctx = { fichiers: [fichier('index.html', html)] };
  const c = analyserRessourcesExternes(ctx).find((x) => x.regle === 'C-EXFIL-03');
  assert.ok(c);
  assert.equal(c.severite, 'mineur');
});

test('C-EXFIL-03 : <embed src> externe est signalé en mineur, comme <img>', () => {
  const html = '<embed src="https://exemple.tiers/widget.svg">';
  const ctx = { fichiers: [fichier('index.html', html)] };
  const c = analyserRessourcesExternes(ctx).find((x) => x.regle === 'C-EXFIL-03');
  assert.ok(c);
  assert.equal(c.severite, 'mineur');
});

test('<object>/<embed> locaux ne déclenchent rien (comportement attendu, comme <img>)', () => {
  const html = '<object data="./rapport.pdf"></object><embed src="/widget.svg">';
  const ctx = { fichiers: [fichier('index.html', html)] };
  assert.equal(analyserRessourcesExternes(ctx).length, 0);
});

// ---------------------------------------------------------------------------
// Surface exécutée : new Worker('./local.js') / new SharedWorker(...)
// ---------------------------------------------------------------------------

test("un new Worker('./chemin/local.js') fait entrer le fichier du worker dans la surface exécutée", () => {
  const dir = depotTemporaire({
    'index.html': '<script src="app.js"></script>',
    'app.js': "const w = new Worker('./worker.js');",
    'worker.js': "importScripts('https://exemple.tiers/lib.js');",
  });
  try {
    const ctx = construireContexte(dir);
    assert.ok(ctx.surface.has('worker.js'), "avant ce correctif, worker.js n'entrait jamais dans la surface — son contenu était invisible à l'axe C");
    const worker = ctx.fichiers.find((f) => f.chemin === 'worker.js');
    assert.equal(worker.executee, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("un new SharedWorker('./chemin/local.js') fait aussi entrer le fichier dans la surface exécutée", () => {
  const dir = depotTemporaire({
    'index.html': '<script src="app.js"></script>',
    'app.js': "const w = new SharedWorker('./partage.js');",
    'partage.js': '',
  });
  try {
    const ctx = construireContexte(dir);
    assert.ok(ctx.surface.has('partage.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('une fois dans la surface, le contenu du worker est audité comme le reste : importScripts() externe déclenche C-EXFIL-01', () => {
  const dir = depotTemporaire({
    'index.html': '<script src="app.js"></script>',
    'app.js': "const w = new Worker('./worker.js');",
    'worker.js': "importScripts('https://exemple.tiers/lib.js');",
  });
  try {
    const ctx = construireContexte(dir);
    const constats = analyserSortiesReseau(ctx);
    const c = constats.find((x) => x.regle === 'C-EXFIL-01' && x.fichier === 'worker.js');
    assert.ok(c, "importScripts() vers un domaine externe, dans un fichier de worker atteint uniquement via new Worker(), doit maintenant être vu");
    assert.equal(c.severite, 'critique');
    assert.equal(c.bloquant, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new Worker(url http(s) absolue) ne fait entrer aucun fichier dans la surface (impossible à suivre, et sans objet : voir plus haut)", () => {
  const dir = depotTemporaire({
    'index.html': '<script src="app.js"></script>',
    'app.js': "const w = new Worker('https://exemple.tiers/worker.js');",
  });
  try {
    const ctx = construireContexte(dir);
    assert.equal(ctx.surface.size, 2, 'seuls index.html et app.js : aucune tentative de résoudre une URL absolue comme fichier local');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Angles morts trouvés par la coordination (2026-09-28, vérifiés par
// l'exécution de construireContexte() sur de vraies fixtures) : un new
// Worker écrit dans un <script> inline HTML, la forme que produisent les
// empaqueteurs (new URL(..., import.meta.url)), un gabarit statique, et un
// importScripts() local chaîné depuis un worker déjà dans la surface.
// ---------------------------------------------------------------------------

test("un new Worker('./local.js') écrit dans un <script> INLINE (pas un fichier .js séparé) fait aussi entrer le worker dans la surface", () => {
  const dir = depotTemporaire({
    'index.html': "<script>const w = new Worker('./worker.js');</script>",
    'worker.js': '',
  });
  try {
    const ctx = construireContexte(dir);
    assert.ok(ctx.surface.has('worker.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new Worker(new URL('./worker.js', import.meta.url)) — forme produite par les empaqueteurs (Vite, Webpack 5) — est suivie", () => {
  const dir = depotTemporaire({
    'index.html': '<script type="module" src="app.js"></script>',
    'app.js': "const w = new Worker(new URL('./worker.js', import.meta.url));",
    'worker.js': '',
  });
  try {
    const ctx = construireContexte(dir);
    assert.ok(ctx.surface.has('worker.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("un gabarit statique sans interpolation (\\`./worker.js\\`) est suivi comme un littéral", () => {
  const dir = depotTemporaire({
    'index.html': '<script src="app.js"></script>',
    'app.js': 'const w = new Worker(`./worker.js`);',
    'worker.js': '',
  });
  try {
    const ctx = construireContexte(dir);
    assert.ok(ctx.surface.has('worker.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('un gabarit AVEC interpolation reste traité comme une source calculée (pas de faux chemin résolu, pas de plantage)', () => {
  const dir = depotTemporaire({
    'index.html': '<script src="app.js"></script>',
    'app.js': 'const nom = "worker"; const w = new Worker(`./${nom}.js`);',
  });
  try {
    assert.doesNotThrow(() => construireContexte(dir));
    const ctx = construireContexte(dir);
    assert.equal(ctx.surface.size, 2, 'seuls index.html et app.js : une source interpolée ne doit résoudre aucun chemin inventé');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("un importScripts('./sous-script.js') À L'INTÉRIEUR d'un worker chaîne ce sous-script dans la surface", () => {
  const dir = depotTemporaire({
    'index.html': '<script src="app.js"></script>',
    'app.js': "const w = new Worker('./worker.js');",
    'worker.js': "importScripts('./sous-script.js');",
    'sous-script.js': "importScripts('https://exemple.tiers/lib.js');",
  });
  try {
    const ctx = construireContexte(dir);
    assert.ok(ctx.surface.has('worker.js'));
    assert.ok(ctx.surface.has('sous-script.js'), "avant ce correctif, importScripts() n'était jamais suivi pour la surface : sous-script.js restait invisible même une fois worker.js inclus");
    const constats = analyserSortiesReseau(ctx);
    assert.ok(constats.some((c) => c.regle === 'C-EXFIL-01' && c.fichier === 'sous-script.js'), "l'appel externe dans sous-script.js doit être vu une fois ce fichier dans la surface");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C-EXFIL-01/02 : importScripts() avec plusieurs arguments
// ---------------------------------------------------------------------------

test("importScripts('./local.js', 'https://exemple.tiers/lib.js') : l'argument externe est vu même en second, sans être masqué par le premier (dédoublonnage par argument, pas par ligne)", () => {
  const ctx = { fichiers: [fichier('app.js', "importScripts('./local.js', 'https://exemple.tiers/lib.js');")] };
  const constats = analyserSortiesReseau(ctx).filter((c) => c.regle === 'C-EXFIL-01' || c.regle === 'C-EXFIL-02');
  assert.equal(constats.length, 1, "un seul argument est externe ('./local.js' est local, donc écarté)");
  assert.ok(constats[0].constat.includes('exemple.tiers'));
});

test('importScripts() avec DEUX arguments externes distincts sur le même appel produit deux constats, pas un seul (régression du dédoublonnage par ligne)', () => {
  const ctx = { fichiers: [fichier('app.js', "importScripts('https://exemple-un.tiers/a.js', 'https://exemple-deux.tiers/b.js');")] };
  const constats = analyserSortiesReseau(ctx).filter((c) => c.regle === 'C-EXFIL-01');
  assert.equal(constats.length, 2, "avant ce correctif, la clé de dédoublonnage (fichier:ligne:canal) aurait fait disparaître le second argument, identique au premier sur ces trois critères");
  assert.ok(constats.some((c) => c.constat.includes('exemple-un.tiers')));
  assert.ok(constats.some((c) => c.constat.includes('exemple-deux.tiers')));
});
