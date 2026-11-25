// Essai 21 : une bibliothèque modifiée à la source, servie à la même adresse. Le fichier n'est modifié que par un marqueur inoffensif (une ligne
// qui consigne un identifiant dans une variable globale) : l'essai dit si le navigateur l'exécute ou le refuse (empreinte `integrity`).
// Le test de bout en bout, qui lance un vrai Grist Desktop, est joué à la demande : GWAUDIT_GRIST_REEL_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import './aide-chromium.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { resoudreBibliotheques, alterer } from '../src/runtime/grist-reel/bibliotheques.js';
import { evaluerEssais } from '../src/runtime/grist-reel/essais.js';
import { verdictEssai } from '../src/rapport/grist-reel.js';

const URL_LIB = 'https://bibliotheque.exemple.test/lib.js';
const CODE_LIB = 'window.__lib_chargee = true;\n';

test("alterer : une ligne de plus à la fin des fichiers servis, qui ne fait que se signaler ; les redirections et les refus ne sont pas touchés", () => {
  const origine = new Map([
    [URL_LIB, { status: 200, type: 'text/javascript', corps: Buffer.from(CODE_LIB) }],
    ['https://bibliotheque.exemple.test/ancien.js', { status: 302, location: URL_LIB }],
  ]);
  const { servies, marqueurs } = alterer(origine);
  const texte = servies.get(URL_LIB).corps.toString();
  assert.ok(texte.startsWith(CODE_LIB), 'le fichier commence comme avant');
  assert.match(texte.slice(CODE_LIB.length), /^\n;\(globalThis\.__gw_altere\|\|\(globalThis\.__gw_altere=\[\]\)\)\.push\("[0-9a-f]{8}"\);\s*$/, "la seule ligne ajoutée consigne un identifiant");
  assert.ok(!/fetch|XMLHttpRequest|sendBeacon|WebSocket|grist|document|cookie/i.test(texte.slice(CODE_LIB.length)), "la ligne ajoutée ne lit ni n'envoie rien");
  assert.equal([...marqueurs.values()][0], URL_LIB);
  assert.deepEqual(servies.get('https://bibliotheque.exemple.test/ancien.js'), origine.get('https://bibliotheque.exemple.test/ancien.js'));
  assert.equal(origine.get(URL_LIB).corps.toString(), CODE_LIB, "l'original n'est pas modifié");
});

const jeu = { prefixe: 'GWC-x-', valeursCherchees: [] };
const obs = (extra = {}) => ({ charge: true, canariRecu: true, appelsRpc: [{}], configure: null, texteDuCadre: '', xss: { executions: 0 }, requetesExternes: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], consoles: [], erreursPage: [], dependancesNonResolues: [], kit: null, alteration: null, erreur: null, ...extra });
const alteration = (obsAltere, protegee = false) => ({ niveau: 'read table', marqueurs: new Map([['aaaa1111', URL_LIB]]), fichiers: [{ url: URL_LIB, sha256: 'b'.repeat(64), taille: 30, protegee }], obs: obsAltere });
const jouer = (alt) => evaluerEssais({ none: obs({ canariRecu: false }), demande: { niveau: 'read table', obs: obs() }, ...(alt ? { alteration: alt } : {}) }, jeu);
const e21 = (r) => r.essais.find((e) => e.id === 21);
const refusIntegrite = { type: 'error', texte: `Failed to find a valid digest in the 'integrity' attribute for resource '${URL_LIB}' with computed SHA-256 integrity 'x'. The resource has been blocked.` };

test("essai 21 : exécuté sans empreinte = information (confirme E-DEP-01) ; exécuté malgré une empreinte déclarée = critique bloquant ; refusé = bloqué ; sans bibliothèque, l'essai n'existe pas", () => {
  assert.equal(e21(jouer(null)), undefined, "pas de bibliothèque déclarée : pas d'essai");

  const sans = jouer(alteration(obs({ alteration: { executees: ['aaaa1111'] } })));
  assert.equal(e21(sans).resultat, 'reussi');
  assert.equal(e21(sans).severite, 'info');
  const c = sans.constats.find((x) => x.regle === 'D-REEL-21');
  assert.equal(c.severite, 'info'); assert.equal(c.bloquant, false);
  assert.match(verdictEssai(e21(sans)).precision, /confirme E-DEP-01/);

  const faux = jouer(alteration(obs({ alteration: { executees: ['aaaa1111'] } }), true));
  assert.equal(e21(faux).severite, 'critique');
  const g = faux.constats.find((x) => x.regle === 'D-REEL-21');
  assert.equal(g.severite, 'critique'); assert.equal(g.bloquant, true);
  assert.equal(verdictEssai(e21(faux)).cle, 'pas_bien');

  const bon = jouer(alteration(obs({ alteration: { executees: [] }, consoles: [refusIntegrite] }), true));
  assert.equal(e21(bon).resultat, 'bloque');
  assert.match(e21(bon).barriere, /integrity/);
  assert.equal(bon.constats.filter((x) => x.regle === 'D-REEL-21').length, 0);
  assert.equal(verdictEssai(e21(bon)).cle, 'bien');
});

test("essai 21 : jamais « bien » à tort : bibliothèque non demandée, empreinte qui refuse déjà le fichier non modifié, page non chargée, téléchargement impossible = « non testé »", () => {
  const nonDemandee = jouer(alteration(obs({ alteration: { executees: [] } })));
  assert.equal(e21(nonDemandee).resultat, 'non_teste');

  const dejaRefusee = evaluerEssais({ none: obs({ canariRecu: false, consoles: [refusIntegrite] }), demande: { niveau: 'read table', obs: obs({ consoles: [refusIntegrite] }) }, alteration: alteration(obs({ alteration: { executees: [] }, consoles: [refusIntegrite] }), true) }, jeu);
  assert.equal(e21(dejaRefusee).resultat, 'non_teste', "un refus qui existait déjà sans modification ne prouve rien");
  assert.match(e21(dejaRefusee).detail, /ne correspond pas/);

  assert.equal(e21(jouer(alteration(obs({ charge: false, erreur: 'pas de cadre' })))).resultat, 'non_teste');
  assert.equal(e21(jouer({ indisponible: "aucune des bibliothèques déclarées n'a pu être téléchargée" })).resultat, 'non_teste');
});

// --- Bout en bout : un vrai Grist Desktop, un vrai Chromium. Joué à la demande. ---
function widgetAvecBibliotheque(t, attributs) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-alteration-'));
  fs.writeFileSync(path.join(racine, 'index.html'), `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget</title><script src="https://docs.getgrist.com/grist-plugin-api.js"></script><script src="${URL_LIB}"${attributs}></script></head><body><h1>Contacts</h1><script>grist.ready({ requiredAccess: 'read table', columns: ['Nom'] }); grist.onRecords(function () {});</script></body></html>`);
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  return racine;
}
const internet = { fetch: async () => new Response(CODE_LIB, { status: 200, headers: { 'content-type': 'text/javascript' } }), lookup: async () => [{ address: '93.184.216.34' }] };
const resolveur = (ctx, o) => resoudreBibliotheques(ctx, { ...o, deps: internet });

test("bout en bout : une bibliothèque sans empreinte, modifiée, est exécutée ; avec une empreinte correcte, le navigateur la refuse", { skip: process.env.GWAUDIT_GRIST_REEL_E2E !== '1' && 'GWAUDIT_GRIST_REEL_E2E=1 pour jouer ce test (lance un vrai Grist Desktop)', timeout: 480_000 }, async (t) => {
  const { auditGristReel } = await import('../src/runtime/grist-reel/index.js');
  const empreinte = `sha384-${crypto.createHash('sha384').update(CODE_LIB).digest('base64')}`;

  const sans = await auditGristReel(construireContexte(widgetAvecBibliotheque(t, '')), { resoudreBibliotheques: resolveur });
  assert.equal(sans.nonExecute, undefined, sans.resume.cause);
  assert.equal(sans.resume.essais.find((e) => e.id === 21).resultat, 'reussi', JSON.stringify(sans.resume.essais.find((e) => e.id === 21)));
  assert.equal(sans.resume.essais.find((e) => e.id === 21).severite, 'info');
  assert.equal(sans.resume.essais.find((e) => e.id === 13).resultat, 'rien_observe', 'les autres essais jouent avec la bibliothèque non modifiée');

  const avec = await auditGristReel(construireContexte(widgetAvecBibliotheque(t, ` integrity="${empreinte}" crossorigin="anonymous"`)), { resoudreBibliotheques: resolveur });
  assert.equal(avec.nonExecute, undefined, avec.resume.cause);
  const e = avec.resume.essais.find((x) => x.id === 21);
  assert.equal(e.resultat, 'bloque', JSON.stringify(e));
  assert.equal(avec.constats.filter((c) => c.regle === 'D-REEL-21').length, 0);
});
