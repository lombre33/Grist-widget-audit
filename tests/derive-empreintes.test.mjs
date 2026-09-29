import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { codeDeSortie, lireEntetes, verifierDerive } from '../docker/ci/derive-empreintes.mjs';
import { analyserReference, imagesDeBase } from '../docker/ci/lib-images.mjs';

/**
 * Le contrôle de dérive des empreintes (docker/ci/derive-empreintes.mjs) compare
 * l'empreinte épinglée de chaque FROM à ce que son étiquette désigne aujourd'hui
 * au registre. Éprouvé ici contre un faux registre local (jeton Bearer compris),
 * pour ce qui ne doit JAMAIS se tromper : signaler une dérive quand il y en a une,
 * ne pas en inventer, et ne jamais dire « à jour » d'un registre qui n'a pas répondu.
 */
const RACINE = path.resolve(import.meta.dirname, '..');
const CLI = path.join(RACINE, 'docker', 'ci', 'derive-empreintes.mjs');
const H = (c) => `sha256:${c.repeat(64)}`;
const [EPINGLEE_A, EPINGLEE_B] = [H('a'), H('b')];
const NOUVELLE = H('c');

/** Le faux registre vit dans CE processus : la ligne de commande se lance donc sans le bloquer (jamais spawnSync). */
function lancerCli(args) {
  return new Promise((resolve, reject) => {
    const enfant = spawn(process.execPath, [CLI, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    enfant.stdout.on('data', (c) => { stdout += c; });
    enfant.stderr.on('data', (c) => { stderr += c; });
    enfant.on('error', reject);
    enfant.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// curl ne doit pas passer par un proxy du poste pour joindre 127.0.0.1.
for (const cle of ['NO_PROXY', 'no_proxy']) process.env[cle] = '*';
for (const cle of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[cle];

function faussesSources(t, { execution = `ARG BASE_IMAGE=registre.exemple/playwright:v1-jammy@${EPINGLEE_A}\nFROM \${BASE_IMAGE}\n`, proxy = `FROM debian:bookworm-slim@${EPINGLEE_B}\n` } = {}) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-derive-'));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  for (const [dossier, contenu] of [['execution', execution], ['egress-proxy', proxy]]) {
    fs.mkdirSync(path.join(racine, 'docker', dossier), { recursive: true });
    fs.writeFileSync(path.join(racine, 'docker', dossier, 'Dockerfile'), contenu);
  }
  return racine;
}

/**
 * Faux registre. `etiquettes` : « depot:etiquette » → empreinte désignée. `panne` : { depot:etiquette → suite de statuts à rendre avant de répondre normalement }.
 * Exige un jeton Bearer (401 + WWW-Authenticate sinon), comme Docker Hub.
 */
async function fauxRegistre(t, { etiquettes, statuts = {}, sansEnteteEmpreinte = false, enteteEmpreinte = null, defi = null, datesDeConstruction = ['2026-09-20T00:00:00Z'], coupeApresJeton = false }) {
  const compteur = new Map();
  const journal = [];
  const serveur = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    journal.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/token') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ token: 'JETON' })); }
    if (req.headers.authorization !== 'Bearer JETON') {
      res.statusCode = 401;
      res.setHeader('www-authenticate', defi ?? `Bearer realm="http://127.0.0.1:${serveur.address().port}/token",service="faux",scope="repository:x:pull"`);
      return res.end();
    }
    if (coupeApresJeton) return req.socket.destroy(); // la connexion tombe une fois authentifié : une panne de curl, pas une réponse HTTP
    const m = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
    if (!m) { res.statusCode = 404; return res.end(); }
    const [, depot, reference] = m;
    if (reference.startsWith('sha256:')) { // le manifeste de l'image désignée : sa date de construction
      res.setHeader('content-type', 'application/vnd.oci.image.index.v1+json');
      return res.end(JSON.stringify({ manifests: datesDeConstruction.map((date) => ({ digest: H('d'), platform: { os: 'linux', architecture: 'amd64' }, annotations: { 'org.opencontainers.image.created': date } })) }));
    }
    const cle = `${depot}:${reference}`;
    const pannes = statuts[cle];
    if (pannes?.length) {
      const n = compteur.get(cle) ?? 0;
      if (n < pannes.length) { compteur.set(cle, n + 1); res.statusCode = pannes[n]; return res.end(); }
    }
    const empreinte = etiquettes[cle];
    if (!empreinte) { res.statusCode = 404; return res.end(); }
    if (!sansEnteteEmpreinte) res.setHeader('docker-content-digest', enteteEmpreinte ?? empreinte);
    res.setHeader('content-type', 'application/vnd.oci.image.index.v1+json');
    res.end('{}');
  });
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => serveur.close(r)));
  return { url: `http://127.0.0.1:${serveur.address().port}`, journal };
}

const ETIQUETTES_A_JOUR = { 'playwright:v1-jammy': EPINGLEE_A, 'library/debian:bookworm-slim': EPINGLEE_B };

test('aucune dérive : les deux étiquettes désignent encore l\'empreinte épinglée (code 0), avec le jeton Bearer que le registre réclame', async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.deepEqual(rapport.resultats.map((r) => r.etat), ['a-jour', 'a-jour']);
  assert.equal(codeDeSortie(rapport), 0);
  assert.ok(registre.journal.includes('GET /token'), "le jeton n'a jamais été demandé : le faux registre exige pourtant l'authentification");
  assert.equal(registre.journal.filter((l) => l === 'HEAD /v2/library/debian/manifests/bookworm-slim').length, 2, "une réponse définitive n'est pas rejouée : la sonde sans jeton puis la demande avec jeton, une fois chacune");
});

test("plusieurs images dans l'index : la date rendue est celle de la plus récente", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: { ...ETIQUETTES_A_JOUR, 'library/debian:bookworm-slim': NOUVELLE }, datesDeConstruction: ['2026-09-18T08:00:00Z', '2026-09-25T09:30:00Z', '2026-09-21T00:00:00Z'] });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.equal(rapport.resultats[1].imageActuelleConstruiteLe, '2026-09-25T09:30:00Z');
});

test("une authentification que le contrôle ne sait pas faire (Basic) est une ERREUR qui le dit", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR, defi: 'Basic realm="faux"' });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.deepEqual(rapport.resultats.map((r) => r.etat), ['erreur', 'erreur']);
  assert.match(rapport.resultats[0].erreur, /authentification/);
  const sansRoyaume = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR, defi: 'Bearer service="faux"' });
  const sans = await verifierDerive({ racine: faussesSources(t), registreDeTest: sansRoyaume.url, delais: [0, 0] });
  assert.match(sans.resultats[0].erreur, /authentification/);
});

test("une étiquette repointée est une dérive (code 1), avec les deux empreintes et la date de construction de l'image actuelle", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: { ...ETIQUETTES_A_JOUR, 'library/debian:bookworm-slim': NOUVELLE } });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.deepEqual(rapport.resultats.map((r) => r.etat), ['a-jour', 'derive']);
  const d = rapport.resultats[1];
  assert.equal(d.empreinteEpinglee, EPINGLEE_B);
  assert.equal(d.empreinteActuelle, NOUVELLE);
  assert.equal(d.imageActuelleConstruiteLe, '2026-09-20T00:00:00Z');
  assert.match(d.dockerfile, /egress-proxy/);
  assert.equal(codeDeSortie(rapport), 1);
});

test("les deux images à la fois en dérive : les deux sont dites", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: { 'playwright:v1-jammy': NOUVELLE, 'library/debian:bookworm-slim': NOUVELLE } });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.deepEqual(rapport.resultats.map((r) => r.etat), ['derive', 'derive']);
});

test("un registre qui répond 500 est une ERREUR (code 2), jamais « à jour »", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR, statuts: { 'library/debian:bookworm-slim': [500, 500, 500, 500, 500] } });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  const r = rapport.resultats[1];
  assert.equal(r.etat, 'erreur');
  assert.match(r.erreur, /500/);
  assert.equal(codeDeSortie(rapport), 2, 'une erreur l\'emporte sur le reste : rien n\'est établi pour cette image');
});

test("un registre injoignable est une ERREUR (code 2), qui dit la cause de curl", async (t) => {
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: 'http://127.0.0.1:1', delais: [0, 0] });
  assert.deepEqual(rapport.resultats.map((r) => r.etat), ['erreur', 'erreur']);
  assert.equal(codeDeSortie(rapport), 2);
  assert.match(rapport.resultats[0].erreur, /curl a échoué : curl: \(7\)/, 'la cause (connexion refusée) doit être dite, pas la commande');
});

test("une panne de curl après l'authentification ne laisse pas le jeton dans le rapport", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR, coupeApresJeton: true });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.deepEqual(rapport.resultats.map((r) => r.etat), ['erreur', 'erreur']);
  const dit = JSON.stringify(rapport);
  assert.ok(!/JETON|Bearer|Authorization/i.test(dit), `le jeton ou l'en-tête d'authentification fuit dans le rapport : ${dit.slice(0, 300)}`);
  assert.match(rapport.resultats[0].erreur, /curl a échoué/);
});

test("un 429 passager est repris et ne devient pas une erreur ; un 429 persistant en est une, qui dit le statut", async (t) => {
  const passager = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR, statuts: { 'library/debian:bookworm-slim': [429, 429] } });
  const ok = await verifierDerive({ racine: faussesSources(t), registreDeTest: passager.url, delais: [0, 0] });
  assert.deepEqual(ok.resultats.map((r) => r.etat), ['a-jour', 'a-jour'], 'deux 429 puis une réponse : la reprise doit aboutir');
  const panne = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR, statuts: { 'playwright:v1-jammy': [503], 'library/debian:bookworm-slim': [502, 504] } });
  const repris = await verifierDerive({ racine: faussesSources(t), registreDeTest: panne.url, delais: [0, 0] });
  assert.deepEqual(repris.resultats.map((r) => r.etat), ['a-jour', 'a-jour'], 'une panne passagère (502, 503, 504) se reprend aussi');
  const persistant = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR, statuts: { 'library/debian:bookworm-slim': Array(20).fill(429) } });
  const ko = await verifierDerive({ racine: faussesSources(t), registreDeTest: persistant.url, delais: [0, 0] });
  assert.equal(ko.resultats[1].etat, 'erreur');
  assert.match(ko.resultats[1].erreur, /429/);
});

test("une réponse 200 sans empreinte est une ERREUR : l'absence d'information n'est pas une dérive ni un « à jour »", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR, sansEnteteEmpreinte: true });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.deepEqual(rapport.resultats.map((r) => r.etat), ['erreur', 'erreur']);
  assert.match(rapport.resultats[0].erreur, /inexploitable/);
});

test("une étiquette que le registre ne connaît plus (404) est une ERREUR (code 2)", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: { 'playwright:v1-jammy': EPINGLEE_A } });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.equal(rapport.resultats[1].etat, 'erreur');
  assert.match(rapport.resultats[1].erreur, /404/);
  assert.equal(codeDeSortie(rapport), 2);
  assert.equal(registre.journal.filter((l) => l === 'HEAD /v2/library/debian/manifests/bookworm-slim').length, 2, "un 404 est définitif : il n'est pas rejoué");
});

test("une référence sans étiquette ne peut pas être comparée : erreur, pas « à jour »", async (t) => {
  const racine = faussesSources(t, { proxy: `FROM debian@${EPINGLEE_B}\n` });
  const rapport = await verifierDerive({ racine, registreDeTest: 'http://127.0.0.1:1', delais: [0, 0] });
  assert.equal(rapport.resultats[1].etat, 'erreur');
  assert.match(rapport.resultats[1].erreur, /sans étiquette/);
});

test("une empreinte mal formée dans la réponse est une ERREUR, pas une dérive : elle ne prouve rien", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: ETIQUETTES_A_JOUR, enteteEmpreinte: 'sha256:abc123' });
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.deepEqual(rapport.resultats.map((r) => r.etat), ['erreur', 'erreur']);
});

test("une dérive et une erreur ensemble : le code est 2, car rien n'est établi pour l'image en erreur", async (t) => {
  const registre = await fauxRegistre(t, { etiquettes: { 'playwright:v1-jammy': NOUVELLE } }); // le proxy : 404
  const rapport = await verifierDerive({ racine: faussesSources(t), registreDeTest: registre.url, delais: [0, 0] });
  assert.deepEqual(rapport.resultats.map((r) => r.etat), ['derive', 'erreur']);
  assert.equal(codeDeSortie(rapport), 2);
});

test('analyserReference : registre, dépôt, étiquette et empreinte pour chaque forme de référence', () => {
  const e = H('e');
  const cas = [
    [`debian:bookworm-slim@${e}`, { registre: 'registry-1.docker.io', depot: 'library/debian', etiquette: 'bookworm-slim' }],
    [`grist/grist:1.7@${e}`, { registre: 'registry-1.docker.io', depot: 'grist/grist', etiquette: '1.7' }],
    [`docker.io/library/node:22@${e}`, { registre: 'registry-1.docker.io', depot: 'library/node', etiquette: '22' }],
    [`mcr.microsoft.com/playwright:v1.63.0-jammy@${e}`, { registre: 'mcr.microsoft.com', depot: 'playwright', etiquette: 'v1.63.0-jammy' }],
    [`ghcr.io/lombre33/gwaudit-execution:v1@${e}`, { registre: 'ghcr.io', depot: 'lombre33/gwaudit-execution', etiquette: 'v1' }],
    [`registre.local:5000/equipe/outil:2@${e}`, { registre: 'registre.local:5000', depot: 'equipe/outil', etiquette: '2' }],
    [`localhost:5000/outil:2@${e}`, { registre: 'localhost:5000', depot: 'outil', etiquette: '2' }],
    [`localhost/outil:2@${e}`, { registre: 'localhost', depot: 'outil', etiquette: '2' }],
    [`debian@${e}`, { registre: 'registry-1.docker.io', depot: 'library/debian', etiquette: null }],
  ];
  for (const [reference, attendu] of cas) {
    const a = analyserReference(reference);
    assert.ok(a, reference);
    assert.deepEqual({ registre: a.registre, depot: a.depot, etiquette: a.etiquette, empreinte: a.empreinte }, { ...attendu, empreinte: e }, reference);
  }
  for (const refusee of ['debian:bookworm-slim', `debian@sha256:${'e'.repeat(63)}`, undefined, '']) assert.equal(analyserReference(refusee), null, String(refusee));
});

function imagesDuDepot() {
  return ['docker/execution/Dockerfile', 'docker/egress-proxy/Dockerfile']
    .flatMap((f) => imagesDeBase(fs.readFileSync(path.join(RACINE, f), 'utf8')).map((i) => analyserReference(i.resolue)));
}

test("la ligne de commande sur les vrais Dockerfile : 0 sans dérive, 1 avec une dérive (les deux empreintes dites), 2 si le registre ne sait rien", async (t) => {
  const reelles = imagesDuDepot();
  const etiquettes = Object.fromEntries(reelles.map((i) => [`${i.depot}:${i.etiquette}`, i.empreinte]));

  const aJour = await fauxRegistre(t, { etiquettes });
  const zero = await lancerCli(['--json', '--registre', aJour.url]);
  assert.equal(zero.status, 0, `code ${zero.status} : ${zero.stdout} ${zero.stderr}`);
  assert.deepEqual(JSON.parse(zero.stdout).resultats.map((r) => r.etat), ['a-jour', 'a-jour']);

  const [premiere] = reelles;
  const repointe = await fauxRegistre(t, { etiquettes: { ...etiquettes, [`${premiere.depot}:${premiere.etiquette}`]: NOUVELLE } });
  const un = await lancerCli(['--registre', repointe.url]);
  assert.equal(un.status, 1, `code ${un.status} : ${un.stdout} ${un.stderr}`);
  assert.match(un.stdout, /DÉRIVE/);
  assert.ok(un.stdout.includes(premiere.empreinte) && un.stdout.includes(NOUVELLE), 'la sortie doit nommer les deux empreintes');
  assert.match(un.stdout, /Des correctifs attendent/);

  const muet = await fauxRegistre(t, { etiquettes: {} });
  const deux = await lancerCli(['--json', '--registre', muet.url]);
  assert.equal(deux.status, 2, `code ${deux.status} : ${deux.stdout} ${deux.stderr}`);
  assert.ok(JSON.parse(deux.stdout).resultats.every((r) => r.etat === 'erreur'));
  const dit = await lancerCli(['--registre', muet.url]);
  assert.match(dit.stdout, /PAS « à jour »/);
});

test("les vrais Dockerfile : deux images, chacune avec registre, dépôt, étiquette et empreinte à comparer", () => {
  const images = imagesDuDepot();
  assert.equal(images.length, 2);
  for (const i of images) assert.ok(i?.registre && i.depot && i.etiquette && /^sha256:[0-9a-f]{64}$/.test(i.empreinte), JSON.stringify(i));
  assert.equal(images.find((i) => i.depot === 'library/debian').registre, 'registry-1.docker.io', 'une image officielle de Docker Hub est au dépôt library/…');
});

test("lireEntetes : derrière un proxy CONNECT, c'est le dernier bloc d'en-têtes qui compte", () => {
  const brut = 'HTTP/1.1 200 Connection Established\r\n\r\nHTTP/2 401 \r\nWWW-Authenticate: Bearer realm="https://x/token"\r\n\r\n';
  const { statut, entetes } = lireEntetes(brut);
  assert.equal(statut, 401);
  assert.match(entetes['www-authenticate'], /Bearer/);
  assert.equal(lireEntetes('').statut, NaN);
});
