import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const BIN = path.join(import.meta.dirname, '../bin/gwaudit.js');

/**
 * Régression pour un contournement SSRF réel de validerHoteClone (trouvé
 * par revue adversariale du 2026-09-20, reproduit avec un vrai `git
 * ls-remote` avant correctif) : `new URL()` normalise un `\` littéral en
 * `/` pour un schéma spécial comme https, avant de chercher la limite
 * d'autorité — mais git/libcurl, qui clone juste après cette validation,
 * suit RFC 3986 et ne fait rien de tel. Pour
 * `https://hote-public.example\@CIBLE/x`, l'ancien code validait
 * "hote-public.example" (externe, accepté) alors que git se connectait
 * réellement à CIBLE. On le prouve ici en écoutant vraiment sur un port
 * local et en vérifiant qu'aucune connexion n'y arrive — pas seulement que
 * le message d'erreur attendu s'affiche.
 */
test("validerHoteClone rejette une URL avec '\\' avant qu'aucune connexion ne soit tentée vers la cible réelle", async () => {
  let connexionsRecues = 0;
  const serveur = net.createServer((socket) => { connexionsRecues++; socket.destroy(); });
  await new Promise((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  const port = serveur.address().port;

  const cibleMalveillante = `https://hote-public.example\\@127.0.0.1:${port}/x.git`;
  await assert.rejects(
    execFileAsync(process.execPath, [BIN, cibleMalveillante, '--sans-dynamique', '--sans-reseau'], { timeout: 15_000 })
  );

  await new Promise((resolve) => setTimeout(resolve, 300)); // laisse le temps à une éventuelle connexion d'arriver
  await new Promise((resolve) => serveur.close(resolve));
  assert.equal(connexionsRecues, 0, "aucune connexion ne doit atteindre la cible interne cachée derrière le '\\'");
});

test('validerHoteClone rejette aussi un userinfo explicite (user@hôte), même sans backslash', async () => {
  try {
    await execFileAsync(process.execPath, [BIN, 'https://un-identifiant@github.com/lombre33/x', '--sans-dynamique', '--sans-reseau'], { timeout: 15_000 });
    assert.fail('aurait dû être rejeté');
  } catch (e) {
    assert.match(String(e.stderr ?? e.message), /userinfo|identifiants/);
  }
});

/**
 * Zone d'exécution V2 (docker/docker-compose.v2-execution.yml) : le
 * conteneur n'a aucune résolution DNS externe, c'est le proxy de sortie qui
 * résout et refuse les adresses internes. GWAUDIT_RESOLUTION_PAR_PROXY=1 ne
 * suspend donc la résolution locale que lorsqu'un proxy est réellement
 * configuré — et jamais le reste de la validation.
 */
async function proxyEspion() {
  const connect = [];
  const serveur = net.createServer((socket) => {
    socket.once('data', (d) => {
      connect.push(String(d).split('\r\n')[0]);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise((resolve) => serveur.listen(0, '127.0.0.1', resolve));
  return { connect, port: serveur.address().port, fermer: () => new Promise((resolve) => serveur.close(resolve)) };
}

async function lancer(cible, env) {
  try {
    await execFileAsync(process.execPath, [BIN, cible, '--sans-dynamique', '--sans-reseau'], {
      timeout: 30_000,
      env: { ...process.env, HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: '', GWAUDIT_RESOLUTION_PAR_PROXY: '', ...env },
    });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.code, stderr: String(e.stderr ?? e.message) };
  }
}

test('mode proxy : le nom n\'est pas résolu localement, la connexion part vers le proxy', async () => {
  const proxy = await proxyEspion();
  try {
    const r = await lancer('https://nom-qui-ne-resout-nulle-part.invalid/x.git', {
      GWAUDIT_RESOLUTION_PAR_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}`,
    });
    assert.doesNotMatch(r.stderr, /Résolution DNS impossible/, 'la résolution locale aurait dû être laissée au proxy');
    assert.ok(proxy.connect.some((l) => /^CONNECT nom-qui-ne-resout-nulle-part\.invalid:443 /.test(l)), `git doit demander le tunnel au proxy : ${JSON.stringify(proxy.connect)}`);
    assert.notEqual(r.code, 0, 'le proxy a refusé : le clonage doit échouer');
  } finally {
    await proxy.fermer();
  }
});

test('sans proxy configuré, GWAUDIT_RESOLUTION_PAR_PROXY seule ne suspend rien : la résolution locale reste exigée', async () => {
  const r = await lancer('https://nom-qui-ne-resout-nulle-part.invalid/x.git', { GWAUDIT_RESOLUTION_PAR_PROXY: '1' });
  assert.match(r.stderr, /Résolution DNS impossible/);
});

test('sans la variable, un proxy configuré ne suspend rien non plus (usage V1 inchangé)', async () => {
  const proxy = await proxyEspion();
  try {
    const r = await lancer('https://nom-qui-ne-resout-nulle-part.invalid/x.git', { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}` });
    assert.match(r.stderr, /Résolution DNS impossible/);
    assert.equal(proxy.connect.length, 0);
  } finally {
    await proxy.fermer();
  }
});

test('mode proxy : une adresse IP littérale interne reste refusée ici, sans connexion', async () => {
  const proxy = await proxyEspion();
  try {
    const r = await lancer('https://127.0.0.1:1/x.git', { GWAUDIT_RESOLUTION_PAR_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}` });
    assert.match(r.stderr, /adresse interne/);
    assert.equal(proxy.connect.length, 0);
  } finally {
    await proxy.fermer();
  }
});

test('mode proxy : une URL SSH (git@) est refusée nettement, pas tentée', async () => {
  const proxy = await proxyEspion();
  try {
    const r = await lancer('git@github.com:lombre33/x.git', { GWAUDIT_RESOLUTION_PAR_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}` });
    assert.match(r.stderr, /SSH/);
    assert.equal(proxy.connect.length, 0);
  } finally {
    await proxy.fermer();
  }
});

test('mode proxy : userinfo et backslash restent refusés avant toute connexion', async () => {
  const proxy = await proxyEspion();
  try {
    const env = { GWAUDIT_RESOLUTION_PAR_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}` };
    const a = await lancer('https://un-identifiant@github.com/lombre33/x', env);
    assert.match(a.stderr, /userinfo|identifiants/);
    const b = await lancer('https://hote-public.example\\@127.0.0.1:1/x.git', env);
    assert.match(b.stderr, /Clonage refusé/);
    assert.equal(proxy.connect.length, 0);
  } finally {
    await proxy.fermer();
  }
});

// ---------------------------------------------------------------------------
// Trois défauts de GWAUDIT_RESOLUTION_PAR_PROXY relevés à la revue (2026-09-29).

const ENV_PROXY = (proxy) => ({ GWAUDIT_RESOLUTION_PAR_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}` });
const SANS_PILE = /\n\s+at \S/;

test('mode proxy : NO_PROXY fait joindre l\'hôte sans proxy — la résolution locale redevient exigée, git ne contourne jamais un contrôle sauté', async () => {
  const proxy = await proxyEspion();
  try {
    const nom = 'nom-qui-ne-resout-nulle-part.invalid';
    // Ce qui doit compter comme « contourné », en majuscules comme en minuscules.
    for (const [cle, valeur] of [['NO_PROXY', nom], ['no_proxy', nom], ['NO_PROXY', 'invalid'], ['NO_PROXY', '.invalid'], ['NO_PROXY', `autre.example, ${nom}:443`], ['NO_PROXY', '*']]) {
      const r = await lancer(`https://${nom}/x.git`, { ...ENV_PROXY(proxy), [cle]: valeur });
      assert.match(r.stderr, /Résolution DNS impossible/, `${cle}=${valeur} : la résolution locale doit être exigée`);
      assert.equal(proxy.connect.length, 0, `${cle}=${valeur} : aucune connexion ne doit partir`);
    }
    // Un NO_PROXY qui ne le désigne pas ne change rien : la résolution reste au proxy.
    const r = await lancer(`https://${nom}/x.git`, { ...ENV_PROXY(proxy), NO_PROXY: 'autre.example,10.0.0.0/8,localhost' });
    assert.doesNotMatch(r.stderr, /Résolution DNS impossible/);
    assert.ok(proxy.connect.some((l) => l.startsWith(`CONNECT ${nom}:443 `)), JSON.stringify(proxy.connect));
  } finally {
    await proxy.fermer();
  }
});

const INTERNES_IPV6 = ['[::1]', '[::]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:c0a8:1]', '[::ffff:a9fe:a9fe]', '[fd00::1]', '[fc00::1]', '[fe80::1]', '[febf::1]', '[0:0:0:0:0:ffff:7f00:1]'];

test('un littéral IPv6 interne est refusé, avec ou sans proxy, sans qu\'aucune connexion parte (les crochets ne le rendent pas invisible)', async () => {
  const proxy = await proxyEspion();
  try {
    for (const hote of INTERNES_IPV6) {
      for (const [mode, env] of [['proxy', ENV_PROXY(proxy)], ['sans proxy', {}]]) {
        const r = await lancer(`https://${hote}:1/x.git`, env);
        assert.match(r.stderr, /Clonage refusé : l'hôte [^\n]*adresse interne/, `${hote} (${mode}) doit être refusé ICI comme adresse interne (et non par le proxy) : ${r.stderr.slice(0, 200)}`);
        assert.equal(r.code, 4, `${hote} (${mode}) : code de sortie`);
      }
    }
    assert.equal(proxy.connect.length, 0, `aucune connexion ne doit partir : ${JSON.stringify(proxy.connect)}`);
  } finally {
    await proxy.fermer();
  }
});

test("un littéral IPv6 public n'est pas pris pour une adresse interne : la demande part vers le proxy", async () => {
  const proxy = await proxyEspion();
  try {
    for (const hote of ['[2606:4700:4700::1111]', '[2001:4860:4860::8888]']) {
      const r = await lancer(`https://${hote}/x.git`, ENV_PROXY(proxy));
      assert.doesNotMatch(r.stderr, /Clonage refusé/, `${hote} : à tort refusé comme interne par la validation locale`);
    }
    assert.equal(proxy.connect.length, 2, JSON.stringify(proxy.connect));
    assert.ok(proxy.connect.every((l) => /^CONNECT \[[0-9a-f:]+\]:443 /.test(l)), JSON.stringify(proxy.connect));
  } finally {
    await proxy.fermer();
  }
});

test('un refus du proxy de sortie est dit en clair, sans pile, avec le code 4 — pas une erreur interne (3)', async () => {
  const proxy = await proxyEspion(); // répond 403 à tout CONNECT
  try {
    const r = await lancer('https://hote-hors-liste.example/x.git', ENV_PROXY(proxy));
    assert.equal(r.code, 4, r.stderr.slice(0, 300));
    assert.match(r.stderr, /Cible refusée ou inaccessible : le proxy de sortie a refusé la connexion \(403\)/);
    assert.match(r.stderr, /hote-hors-liste\.example/);
    assert.doesNotMatch(r.stderr, SANS_PILE, 'aucune pile de Node ne doit sortir pour une cible refusée');
    assert.doesNotMatch(r.stderr, /Erreur :/);
  } finally {
    await proxy.fermer();
  }
});

test('un refus de validation ou un chemin introuvable : code 4 et message net, jamais la pile', async () => {
  for (const cible of ['https://un-identifiant@github.com/lombre33/x', 'http://github.com/lombre33/x', path.join(import.meta.dirname, 'aucun-dossier-ici')]) {
    const r = await lancer(cible, {});
    assert.equal(r.code, 4, `${cible} : ${r.stderr.slice(0, 200)}`);
    assert.match(r.stderr, /^Cible refusée ou inaccessible : /m, cible);
    assert.doesNotMatch(r.stderr, SANS_PILE, cible);
  }
});
