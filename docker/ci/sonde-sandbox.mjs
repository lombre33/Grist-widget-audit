// Sonde du bac à sable de Chromium, à lancer DANS le conteneur d'exécution :
// démarre Chromium avec son bac à sable (chromiumSandbox: true — Playwright
// ajoute sinon --no-sandbox de lui-même), ouvre chrome://sandbox et affiche
// SANDBOX-OK si Chromium y déclare « adequately sandboxed » avec la couche 1
// « Namespace » ; SANDBOX-ABSENT (avec la cause) sinon. Utilisée deux fois par
// docker/ci/verifier.sh : sous la configuration voulue (doit être OK) et sous
// le profil seccomp par défaut de Docker (doit échouer : témoin, sans lequel un
// OK ne prouverait pas que la sonde sait échouer).
import { createRequire } from 'node:module';

const require = createRequire('/app/package.json');
const { chromium } = require('playwright');

let navigateur;
try {
  navigateur = await chromium.launch({
    executablePath: process.env.GWAUDIT_CHROMIUM_PATH,
    chromiumSandbox: true,
    args: ['--disable-gpu'],
    timeout: 20000,
  });
  const page = await navigateur.newPage();
  await page.goto('chrome://sandbox', { timeout: 10000 });
  const texte = await page.evaluate(() => document.body.innerText);
  const ok = /adequately sandboxed/i.test(texte) && /Layer 1 Sandbox\s+Namespace/i.test(texte) && /Seccomp-BPF sandbox\s+Yes/i.test(texte);
  console.log(ok ? 'SANDBOX-OK' : `SANDBOX-ABSENT:${texte.replace(/\s+/g, ' ').slice(0, 300)}`);
} catch (e) {
  const cause = String(e.message).split('\n').find((l) => /No usable sandbox|sandbox|Check failed|namespace/i.test(l)) ?? String(e.message).split('\n')[0];
  console.log(`SANDBOX-ABSENT:${cause.replace(/^\[pid=\d+\]\[err\]\s*/, '').slice(0, 300)}`);
} finally {
  await navigateur?.close().catch(() => {});
}
