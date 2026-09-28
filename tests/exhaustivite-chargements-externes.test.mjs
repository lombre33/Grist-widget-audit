import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extraireImportMaps } from '../src/moteur/analyse-js.js';
import { analyserRessourcesExternes, analyserWorkerExterne, analyserSortiesReseau } from '../src/regles/c-securite.js';
import { analyserDependancesDistantes } from '../src/regles/e-dependances.js';

/**
 * Demande d'Antoine (2026-09-28, relayée depuis le fil du prompt d'audit
 * LLM) : se mettre dans la peau de qui veut déployer un widget malveillant
 * et vérifier toutes les balises, pas seulement `<script src>`. Trou trouvé
 * en lisant `publipostageGrist` : ses dépendances (TipTap/ProseMirror) sont
 * déclarées par `<script type="importmap">` puis importées par spécificateur
 * nu — invisible à E-DEP-01 (qui ne lisait que `<script src>`) comme à
 * C-EXFIL-03 (même limite) et à toute règle basée sur l'AST JS (le JSON d'une
 * import map n'est jamais un `unitesJs`). Ajouté aussi : `<object>`/`<embed>`
 * (mineur, même traitement que `<img>`), et une règle dédiée C-EXFIL-07 pour
 * `Worker`/`SharedWorker` chargés depuis un service externe, qui n'ont — à
 * la différence d'un `<script>` — aucun mécanisme d'intégrité natif.
 */

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
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
// C-EXFIL-07 : Worker / SharedWorker externe
// ---------------------------------------------------------------------------

test('C-EXFIL-07 : new Worker(url externe littéral) est critique et bloquant', () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker('https://exemple.tiers/worker.js');")] };
  const c = analyserWorkerExterne(ctx).find((x) => x.regle === 'C-EXFIL-07');
  assert.ok(c);
  assert.equal(c.severite, 'critique');
  assert.equal(c.bloquant, true);
  assert.equal(c.confiance, 'certain');
});

test('C-EXFIL-07 : new SharedWorker(url externe littéral) est également détecté', () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new SharedWorker('https://exemple.tiers/worker.js');")] };
  const c = analyserWorkerExterne(ctx).find((x) => x.regle === 'C-EXFIL-07');
  assert.ok(c);
  assert.equal(c.severite, 'critique');
});

test('C-EXFIL-07 : new Worker(chemin local) ne déclenche rien', () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker('./worker.js');")] };
  assert.equal(analyserWorkerExterne(ctx).filter((x) => x.regle === 'C-EXFIL-07').length, 0);
});

test('C-EXFIL-07 : new Worker(url calculée à l\'exécution) est majeur, non bloquant, à vérifier', () => {
  const ctx = { fichiers: [fichier('app.js', 'const w = new Worker(source);')] };
  const c = analyserWorkerExterne(ctx).find((x) => x.regle === 'C-EXFIL-07');
  assert.ok(c);
  assert.equal(c.severite, 'majeur');
  assert.equal(c.bloquant, false);
  assert.equal(c.confiance, 'a_verifier');
});

test('C-EXFIL-07 : aucun mécanisme d\'intégrité n\'existe pour Worker — pas de branche "protégé" dans la remédiation', () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker('https://exemple.tiers/worker.js');")] };
  const c = analyserWorkerExterne(ctx).find((x) => x.regle === 'C-EXFIL-07');
  assert.ok(!/int[ée]grit[ée]\s*=|attribut.*int[ée]grit[ée].*d[ée]j[àa]/i.test(c.remediation), 'la remédiation ne doit jamais suggérer un attribut integrity, qui n\'existe pas pour ce constructeur');
});

test('Worker/SharedWorker externe n\'est pas doublement compté par C-EXFIL-01/02 (analyserSortiesReseau)', () => {
  const ctx = { fichiers: [fichier('app.js', "const w = new Worker('https://exemple.tiers/worker.js');")] };
  const constats = analyserSortiesReseau(ctx);
  assert.equal(constats.length, 0, 'analyserSortiesReseau ne connaît pas Worker/SharedWorker : pas de double comptage avec C-EXFIL-07');
});
