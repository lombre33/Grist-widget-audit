import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/**
 * Le contrôle « aucun Chromium orphelin » de docker/ci/verifier.sh (fonction
 * `aucun_chromium_orphelin`) est un `pgrep -f` : il ne vaut que s'il
 *  1. ne se reconnaît pas lui-même — un motif écrit en clair figure dans la ligne
 *     de commande de `bash -c` (ou de `ssh`) qui le lance, et pgrep le trouverait
 *     toujours : le contrôle échouerait à tort, ou, pire, on apprendrait à
 *     ignorer son échec ;
 *  2. voit un vrai orphelin — sinon son silence ne prouverait rien.
 * La CI, qui lance le script depuis un fichier, ne rencontre pas le premier cas ;
 * sur un VPS, par `ssh hôte 'bash docker/ci/verifier.sh …'` ou `bash -c`, si.
 *
 * La fonction est extraite de verifier.sh tel quel (pas recopiée) : ce que ce test
 * éprouve est le code qui tourne.
 */
const RACINE = path.resolve(import.meta.dirname, '..');
const SOUS_WINDOWS = process.platform === 'win32';
const RAISON = SOUS_WINDOWS && 'bash et pgrep (procps) : contrôle propre à Linux, là où tourne le conteneur';

const source = fs.readFileSync(path.join(RACINE, 'docker', 'ci', 'verifier.sh'), 'utf8');
const brute = /^aucun_chromium_orphelin\(\) \{[\s\S]*?^\}/m.exec(source)?.[0];

// Le répertoire du motif est remplacé par un nom propre à cette exécution : un vrai Chromium de Playwright qui tournerait
// sur la machine (~/.cache/ms-playwright/chromium-…, ou un autre fichier de test lancé en parallèle) ne doit ni fausser
// ces cas ni les faire dépendre de l'état de la machine. La structure éprouvée — motif à crochets, pgrep -f, appel par
// `bash -c` — reste celle de verifier.sh ; test 5 lit verifier.sh lui-même.
const REPERTOIRE = `gwaudit-test-${process.pid}-${Date.now()}`;
const fonction = brute?.replaceAll('ms-playwright', REPERTOIRE);

function controle(corps = fonction) {
  const script = `echec() { echo "ÉCHEC : $*" >&2; exit 1; }\n${corps}\naucun_chromium_orphelin "test"\n`;
  // `bash -c` : le script, motif compris, est dans la ligne de commande de ce processus — le cas qui piégeait l'ancien motif.
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
}

test("la fonction de contrôle est bien extraite de verifier.sh", { skip: RAISON }, () => {
  assert.ok(brute, "aucun_chromium_orphelin() introuvable dans docker/ci/verifier.sh : le test ne saurait plus quoi éprouver");
  assert.match(brute, /pgrep -f '\[\/\]ms-playwright\/chromium-'/, 'le motif à crochets de verifier.sh a changé : relire ce test');
  assert.ok(fonction.includes(REPERTOIRE) && !fonction.includes('ms-playwright'), 'le répertoire du motif doit être remplacé partout');
});

test("sans orphelin, le contrôle passe même appelé par « bash -c » : il ne se reconnaît pas lui-même", { skip: RAISON }, () => {
  const r = controle();
  assert.equal(r.status, 0, `le contrôle s'est reconnu lui-même (ou a échoué) : ${r.stdout}${r.stderr}`);
});

test("témoin : l'ancien motif, écrit sans crochets, se reconnaît lui-même sous « bash -c »", { skip: RAISON }, () => {
  assert.ok(fonction);
  const ancien = fonction.replaceAll(`[/]${REPERTOIRE}`, `/${REPERTOIRE}`);
  assert.notEqual(ancien, fonction, "le motif à crochets est introuvable dans la fonction : le témoin ne prouve rien");
  const r = controle(ancien);
  assert.equal(r.status, 1, "l'ancien motif devait se reconnaître lui-même : sans cela ce test ne distingue pas les deux motifs");
  assert.match(r.stderr, /un Chromium survit/);
});

test("un vrai orphelin (processus dont la ligne de commande vient du répertoire des Chromium) est vu et fait échouer le contrôle", { skip: RAISON }, async (t) => {
  // `; true` : sans lui bash exécute `sleep` en place et la ligne de commande perd le chemin.
  const faux = spawn('bash', ['-c', 'sleep 300; true', `/tmp/faux/${REPERTOIRE}/chromium-9999/chrome-linux/chrome`], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-faux.pid, 'SIGKILL'); } catch { /* déjà parti */ } });
  await new Promise((r) => setTimeout(r, 300));
  const r = controle();
  assert.equal(r.status, 1, `l'orphelin n'a pas été vu : ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /un Chromium survit test/);
  assert.ok(r.stdout.includes(`${REPERTOIRE}/chromium-9999`), 'le processus fautif doit être listé');
});

test("le contrôle de cmd_plafond passe par la même fonction (plus de motif recopié à la main)", { skip: RAISON }, () => {
  const motifs = [...source.matchAll(/pgrep[^\n]*ms-playwright/g)].map((m) => m[0]);
  assert.ok(motifs.length > 0);
  assert.ok(motifs.every((m) => m.includes('[/]ms-playwright')), `un pgrep garde l'ancien motif, qui se reconnaît lui-même sous « bash -c » : ${motifs.join(' | ')}`);
});
