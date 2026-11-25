import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { demarrerInterface, nomFichierSuggere, argumentsAudit } from '../src/interface/serveur.js';

test('nomFichierSuggere dérive un nom de fichier lisible et sûr depuis une URL de dépôt', () => {
  assert.equal(nomFichierSuggere('https://github.com/lombre33/mon-widget.git', 'md'), 'gwaudit-mon-widget.md');
  assert.equal(nomFichierSuggere('https://github.com/lombre33/mon-widget', 'json'), 'gwaudit-mon-widget.json');
  assert.equal(nomFichierSuggere('git@github.com:lombre33/mon-widget.git', 'md'), 'gwaudit-mon-widget.md');
  // Caractères hors [a-zA-Z0-9_-] neutralisés : un nom de dépôt piégé ne doit
  // pas se retrouver tel quel dans un en-tête Content-Disposition.
  assert.equal(nomFichierSuggere('https://github.com/x/widget"; injection', 'md'), 'gwaudit-widget---injection.md');
});

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

test('GET /audits/<id inconnu> et ses sous-routes de rapport renvoient toutes 404', async () => {
  const idBidon = '00000000-0000-0000-0000-000000000000';
  const rep1 = await fetch(`${base}/audits/${idBidon}`);
  assert.equal(rep1.status, 404);
  for (const suffixe of ['rapport', 'rapport-brut', 'rapport.md', 'rapport.json', 'roadmap']) {
    const rep = await fetch(`${base}/audits/${idBidon}/${suffixe}`);
    assert.equal(rep.status, 404, `/${suffixe} devrait renvoyer 404 pour un audit inconnu`);
  }
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
  const pageTexte = await repPage.text();
  assert.ok(pageTexte.includes('localhost/nonexistent-repo.git'));
  assert.ok(pageTexte.includes('Nouvel audit'), 'la page de suivi doit permettre de revenir en arrière sans attendre la fin');

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
  for (const suffixe of ['rapport-brut', 'rapport.md', 'rapport.json', 'roadmap']) {
    const rep = await fetch(`${base}/audits/${id}/${suffixe}`);
    assert.equal(rep.status, 404, `/${suffixe} ne doit rien servir pour un audit qui a échoué avant tout rapport`);
  }
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

// --- Case « Ajouter les essais contre un Grist réel » ---

test("le formulaire propose la case « Grist réel », décochée par défaut, et l'envoie avec la cible", async () => {
  const corps = await (await fetch(`${base}/`)).text();
  const case_ = corps.match(/<input type="checkbox" id="grist-reel"[^>]*>/);
  assert.ok(case_, 'la case est dans le formulaire');
  assert.ok(!/checked/.test(case_[0]), 'décochée par défaut : un audit classique reste un audit classique');
  assert.ok(corps.includes("gristReel: document.getElementById('grist-reel').checked"), 'la case est envoyée avec la cible');
});

test("argumentsAudit : --grist-reel seulement si la case est cochée (booléen vrai), jamais pour un texte ou un nombre", () => {
  assert.deepEqual(argumentsAudit('https://x.invalid/w', '/s'), ['https://x.invalid/w', '--json', '--sortie', '/s']);
  assert.deepEqual(argumentsAudit('https://x.invalid/w', '/s', { gristReel: true }), ['https://x.invalid/w', '--json', '--sortie', '/s', '--grist-reel']);
  for (const faux of [false, undefined, 'true', 1, 'on', null]) {
    assert.ok(!argumentsAudit('https://x.invalid/w', '/s', { gristReel: faux }).includes('--grist-reel'), `gristReel=${JSON.stringify(faux)}`);
  }
});

async function lancerEtAttendreLaFin(corps) {
  // Un audit lancé par un test précédent peut tourner encore (un seul à la fois, 409) : on attend son tour.
  let rep; const attente = Date.now() + 20_000;
  do {
    rep = await fetch(`${base}/audits`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
    if (rep.status === 409) await new Promise((r) => setTimeout(r, 300));
  } while (rep.status === 409 && Date.now() < attente);
  assert.equal(rep.status, 200);
  const { id } = await rep.json();
  const page = await (await fetch(`${base}/audits/${id}`)).text();
  const sse = await fetch(`${base}/audits/${id}/evenements`);
  const lecteur = sse.body.getReader(); const decodeur = new TextDecoder();
  let brut = ''; const limite = Date.now() + 15_000;
  while (!/event: fin/.test(brut) && Date.now() < limite) { const { value, done } = await lecteur.read(); if (done) break; brut += decodeur.decode(value, { stream: true }); }
  return { page, brut };
}

test("la page de suivi dit que les essais « Grist réel » sont inclus, seulement quand la case était cochée", async () => {
  const avec = await lancerEtAttendreLaFin({ cible: 'https://localhost/avec-grist-reel.git', gristReel: true });
  assert.ok(avec.page.includes('Avec les essais contre un Grist réel'));
  const sans = await lancerEtAttendreLaFin({ cible: 'https://localhost/sans-grist-reel.git', gristReel: 'true' });
  assert.ok(!sans.page.includes('Avec les essais contre un Grist réel'), "un texte « true » n'est pas la case cochée");
  assert.match(sans.brut, /event: fin/);
});
