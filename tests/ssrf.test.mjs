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
