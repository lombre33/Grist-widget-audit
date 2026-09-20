import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { demarrerInterface } from '../src/interface/serveur.js';

let base, serveur;

before(async () => {
  ({ serveur, port: globalThis.__port } = await demarrerInterface({ port: 0 }));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

after(async () => {
  await new Promise((resolve) => serveur.close(resolve));
  fs.rmSync('./rapport-interface', { recursive: true, force: true });
});

test("GET / sert le formulaire d'accueil", async () => {
  const rep = await fetch(`${base}/`);
  assert.equal(rep.status, 200);
  const corps = await rep.text();
  assert.ok(corps.includes('<form'));
  assert.ok(corps.includes('Lancer l\'audit'));
});

test('POST /audits refuse un chemin local (pas une URL) sans lancer de sous-processus', async () => {
  const rep = await fetch(`${base}/audits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cible: '/etc/passwd' }),
  });
  assert.equal(rep.status, 400);
  const corps = await rep.json();
  assert.match(corps.erreur, /URL/);
});

test('POST /audits refuse un corps vide ou une cible absente', async () => {
  const rep = await fetch(`${base}/audits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(rep.status, 400);
});

test('GET /audits/<id inconnu> et /audits/<id inconnu>/rapport renvoient 404', async () => {
  const idBidon = '00000000-0000-0000-0000-000000000000';
  const rep1 = await fetch(`${base}/audits/${idBidon}`);
  assert.equal(rep1.status, 404);
  const rep2 = await fetch(`${base}/audits/${idBidon}/rapport`);
  assert.equal(rep2.status, 404);
});

test("un audit réellement lancé (rejeté par la validation SSRF de la CLI) se termine en échec, avec un journal en direct via SSE", async () => {
  // https://localhost/... passe le filtre "ressemble à une URL" de
  // l'interface, mais bin/gwaudit.js le rejette lui-même (hôte interne,
  // voir validerHoteClone) : ceci exerce un vrai sous-processus, une vraie
  // lecture stdout/stderr, un vrai flux SSE — pas un simulacre — tout en
  // restant rapide (aucun accès réseau réel, aucun Chromium lancé).
  const repPost = await fetch(`${base}/audits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cible: 'https://localhost/nonexistent-repo.git' }),
  });
  assert.equal(repPost.status, 200);
  const { id } = await repPost.json();
  assert.match(id, /^[0-9a-f-]{36}$/);

  const repPage = await fetch(`${base}/audits/${id}`);
  assert.equal(repPage.status, 200);
  assert.ok((await repPage.text()).includes('localhost/nonexistent-repo.git'));

  const repSse = await fetch(`${base}/audits/${id}/evenements`);
  assert.equal(repSse.status, 200);
  const lecteur = repSse.body.getReader();
  const decodeur = new TextDecoder();
  let brut = '';
  let statutFinal = null;
  const limite = Date.now() + 15_000;
  while (statutFinal === null && Date.now() < limite) {
    const { value, done } = await lecteur.read();
    if (done) break;
    brut += decodeur.decode(value, { stream: true });
    const m = brut.match(/event: fin\ndata: (.+)\n\n/);
    if (m) statutFinal = JSON.parse(m[1]).statut;
  }
  assert.equal(statutFinal, 'echec', "un hôte interne refusé par la CLI doit aboutir à l'état 'echec'");
  assert.ok(brut.includes('event: ligne'), 'au moins une ligne de journal doit avoir été diffusée');

  const repRapport = await fetch(`${base}/audits/${id}/rapport`);
  assert.equal(repRapport.status, 404, "aucun rapport n'existe pour un audit qui a échoué avant de produire quoi que ce soit");
});

test('un deuxième audit refusé (409) tant que le premier tourne encore', async () => {
  const p1 = fetch(`${base}/audits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cible: 'https://localhost/autre-nonexistent.git' }),
  });
  // Émis dans la foulée, avant que le sous-processus du premier audit (qui
  // démarre node, résout un DNS, etc.) n'ait eu le temps de se terminer.
  const rep2 = await fetch(`${base}/audits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cible: 'https://localhost/encore-un-autre.git' }),
  });
  assert.equal(rep2.status, 409);
  await p1; // laisse le premier se terminer avant que le hook after() ne ferme le serveur
});
