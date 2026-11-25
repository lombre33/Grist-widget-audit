import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { resoudreBibliotheques, liensDuModule } from '../src/runtime/grist-reel/bibliotheques.js';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Les bibliothèques que le widget déclare sont téléchargées par l'outil avant les essais (jamais par le navigateur), à des conditions strictes ;
 * ce qui n'a pas pu l'être rend « rien observé » non concluant.
 */
function widget(t, tete, corps = '') {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-biblio-'));
  fs.writeFileSync(path.join(racine, 'index.html'), `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget</title>${tete}</head><body>${corps}</body></html>`);
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  return racine;
}

/** Un faux Internet : table adresse → réponse ; consigne chaque adresse demandée. */
function fauxInternet(table) {
  const demandees = [];
  const chercher = async (url) => {
    demandees.push(url);
    const r = table[url];
    if (!r) return new Response('absent', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (r.location) return new Response(null, { status: 302, headers: { location: r.location } });
    return new Response(r.corps, { status: 200, headers: { 'content-type': r.type ?? 'text/javascript; charset=utf-8' } });
  };
  return { demandees, deps: { fetch: chercher, lookup: async (h) => [{ address: h.startsWith('interne.') ? '10.0.0.7' : '93.184.216.34' }] } };
}

test("bibliothèques : seules les adresses déclarées sont téléchargées, avec leurs imports en clair chez le même hôte, redirections suivies, empreinte consignée", async (t) => {
  const racine = widget(t, '<script type="module" src="https://esm.sh/lib@1.2.3"></script><script src="https://cdn.example.org/classique.js"></script>');
  const lib = 'import { a } from "/dep@2.0.0/a.mjs"; import "https://ailleurs.example.net/x.js"; export * from "./b.mjs"; const calcule = "https://esm.sh/" + a; import(calcule);';
  const { demandees, deps } = fauxInternet({
    'https://esm.sh/lib@1.2.3': { location: 'https://esm.sh/lib@1.2.3/es2022/lib.mjs' },
    'https://esm.sh/lib@1.2.3/es2022/lib.mjs': { corps: lib },
    'https://esm.sh/dep@2.0.0/a.mjs': { corps: 'export const a = 1;' },
    'https://esm.sh/lib@1.2.3/es2022/b.mjs': { corps: 'export const b = 2;' },
    'https://cdn.example.org/classique.js': { corps: 'window.x = 1;' },
  });
  const { servies, resume } = await resoudreBibliotheques(construireContexte(racine), { deps });

  assert.deepEqual([...demandees].sort(), [
    'https://cdn.example.org/classique.js', 'https://esm.sh/dep@2.0.0/a.mjs', 'https://esm.sh/lib@1.2.3', 'https://esm.sh/lib@1.2.3/es2022/b.mjs', 'https://esm.sh/lib@1.2.3/es2022/lib.mjs',
  ], "ni l'hôte étranger de l'import, ni l'adresse calculée à l'exécution ne sont demandés");
  assert.equal(servies.get('https://esm.sh/lib@1.2.3').status, 302, 'la redirection est rendue telle quelle au navigateur');
  assert.equal(servies.get('https://esm.sh/lib@1.2.3/es2022/lib.mjs').status, 200);
  const dep = resume.chargees.find((f) => f.url.endsWith('/dep@2.0.0/a.mjs'));
  assert.equal(dep.sha256, crypto.createHash('sha256').update('export const a = 1;').digest('hex'));
  assert.equal(resume.chargees.length, 4);
});

test("bibliothèques : refus d'une adresse non https, IP, interne, avec port ou identifiants, d'un autre type que JavaScript, et plafonds", async (t) => {
  const racine = widget(t, [
    'http://esm.sh/clair.js', 'https://93.184.216.34/ip.js', 'https://interne.exemple.org/prive.js', 'https://esm.sh:8443/port.js',
    'https://nom:mdp@esm.sh/identifiants.js', 'https://esm.sh/page.html', 'https://esm.sh/gros.js', 'https://esm.sh/ok.js',
  ].map((u) => `<script type="module" src="${u}"></script>`).join(''));
  const { demandees, deps } = fauxInternet({
    'https://esm.sh/page.html': { corps: '<html></html>', type: 'text/html' },
    'https://esm.sh/gros.js': { corps: 'x'.repeat(2000) },
    'https://esm.sh/ok.js': { corps: 'export default 1;' },
  });
  const { resume } = await resoudreBibliotheques(construireContexte(racine), { deps, limites: { octetsParFichier: 1000 } });
  assert.deepEqual([...demandees].sort(), ['https://esm.sh/gros.js', 'https://esm.sh/ok.js', 'https://esm.sh/page.html'], 'rien vers http, une IP, un nom interne, un autre port, une adresse à identifiants');
  const raisons = Object.fromEntries(resume.refusees.map((r) => [r.url.replace(/^https?:\/\//, '').split('/')[0] + '/' + r.url.split('/').pop(), r.raison]));
  assert.match(raisons['esm.sh/page.html'], /seul du JavaScript/);
  assert.match(raisons['esm.sh/gros.js'], /plus de/);
  assert.deepEqual(resume.chargees.map((f) => f.url), ['https://esm.sh/ok.js']);
  assert.equal(resume.refusees.length, 7, 'chaque refus est dit');
});

test("modules : les imports en clair sont lus par l'AST, ni nom nu, ni adresse calculée, ni script classique", () => {
  const base = 'https://esm.sh/lib@1/mod.mjs';
  assert.deepEqual(liensDuModule('import a from "./a.mjs"; export * from "/x/b.mjs"; export { c } from "https://esm.sh/c.mjs"; import("./d.mjs"); import("https://esm.sh/" + n); import "react"; const t = "import \\"./faux.mjs\\"";', base).sort(),
    ['https://esm.sh/c.mjs', 'https://esm.sh/lib@1/a.mjs', 'https://esm.sh/lib@1/d.mjs', 'https://esm.sh/x/b.mjs']);
  assert.deepEqual(liensDuModule('(function(){ var x = 1; })()', base), []);
  assert.deepEqual(liensDuModule('ceci n est pas du javascript {{', base), []);
});

test("essais : une bibliothèque du widget non chargée rend « rien observé » non concluant ; un effet observé ou une barrière restent vrais", () => {
  const obs = (extra = {}) => ({ charge: true, canariRecu: true, appelsRpc: [{}], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], erreursPage: [], dependancesNonResolues: [], ...extra });
  const jeu = { prefixe: 'GWC-x-', valeursCherchees: [] };
  const manquante = [{ url: 'https://esm.sh/react@18', hote: 'esm.sh' }];
  const sans = evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs() } }, jeu).essais;
  assert.ok(sans.filter((e) => [1, 13, 15, 16].includes(e.id)).every((e) => e.resultat === 'rien_observe'), 'sans bibliothèque manquante, rien ne change');
  const avec = evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs({ dependancesNonResolues: manquante }) } }, jeu).essais;
  for (const id of [1, 13, 15, 16]) {
    const e = avec.find((x) => x.id === id);
    assert.equal(e.resultat, 'non_teste', `essai ${id}`);
    assert.match(e.detail, /esm\.sh/);
    assert.equal(e.bibliothequesManquantes, 1);
  }
  assert.equal(avec.find((x) => x.id === 7).resultat, 'bloque', "la barrière de Grist reste une barrière");
  const dialogue = evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs({ dependancesNonResolues: manquante, dialogues: [{ type: 'alert', message: 'x' }] }) } }, jeu);
  assert.equal(dialogue.essais.find((x) => x.id === 16).resultat, 'reussi', 'un effet observé reste vrai');
});

test("bibliothèques, réseau réel (GWAUDIT_RESEAU_REEL=1) : une bibliothèque épinglée sur esm.sh est téléchargée avec ses imports", { skip: process.env.GWAUDIT_RESEAU_REEL !== '1' && 'GWAUDIT_RESEAU_REEL=1 pour jouer ce test (accède à esm.sh)', timeout: 120_000 }, async (t) => {
  const racine = widget(t, '<script type="module" src="https://esm.sh/preact@10.19.3"></script>');
  const { servies, resume } = await resoudreBibliotheques(construireContexte(racine), {});
  assert.ok(resume.chargees.length >= 1, `rien téléchargé : ${JSON.stringify(resume.refusees)}`);
  assert.ok([...servies.values()].some((s) => s.status === 200 && s.corps.length > 1000));
  assert.ok(resume.chargees.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && new URL(f.url).hostname === 'esm.sh'));
});

// --- Bout en bout : le widget joue avec sa bibliothèque ; sans elle, « rien observé » devient « non testé ». Joué à la demande (vrai Grist Desktop). ---
test('bout en bout : bibliothèque servie par l\'outil, ou non téléchargée', { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async () => {
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const ctx = construireContexte(path.join(RACINE, 'tests/fixtures/widget-grist-reel-biblio'));
  const URL_LIB = 'https://bibliotheque.exemple.test/lib.mjs';
  const resume = { declarees: 1, chargees: [{ url: URL_LIB, sha256: 'a'.repeat(64), taille: 30 }], refusees: [], octets: 30, tronque: false };

  const avec = await auditGristReel(ctx, { resoudreBibliotheques: async () => ({ servies: new Map([[URL_LIB, { status: 200, type: 'text/javascript', corps: Buffer.from('export const etat = "chargée";') }]]), resume }) });
  assert.equal(avec.nonExecute, undefined, avec.resume.cause);
  assert.ok(avec.resume.phases.some((p) => p.bibliothequesServies > 0), 'la bibliothèque a été servie au widget');
  assert.ok(avec.resume.phases.every((p) => p.bibliothequesManquantes === 0));
  assert.equal(avec.resume.essais.find((e) => e.id === 13).resultat, 'rien_observe', 'joué en entier : rien observé, et c\'est concluant');

  const sans = await auditGristReel(ctx, { resoudreBibliotheques: async () => ({ servies: new Map(), resume: { ...resume, chargees: [], refusees: [{ url: URL_LIB, raison: 'hors ligne' }] } }) });
  assert.equal(sans.nonExecute, undefined, sans.resume.cause);
  const e13 = sans.resume.essais.find((e) => e.id === 13);
  assert.equal(e13.resultat, 'non_teste');
  assert.ok(e13.bibliothequesManquantes >= 1);
});
