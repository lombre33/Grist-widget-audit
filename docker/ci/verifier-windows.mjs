// Preuve, sous Windows (poste d'Antoine, où rien ne se vérifie depuis le cloud),
// que l'axe D par défaut lance Chromium AVEC son bac à sable : pendant un vrai
// audit de fixtures/widget-exemple, relève ligne de commande et niveau
// d'intégrité du jeton de chaque processus chrome.exe (integrite-chrome.ps1).
// Puis rejoue la même chose avec la dérogation explicite (témoin : la sonde doit
// y voir des processus de rendu de niveau moyen et --no-sandbox, sinon elle ne
// saurait pas distinguer). Relève aussi le score de widget-exemple, pour
// comparer avec Linux.
// Enfin, un widget qui boucle sans fin (bac à sable actif) : l'audit conclut de
// lui-même par D-TIMEOUT-01 (bloquant) et ne laisse aucun chrome.exe derrière lui
// — la sonde, qui vient de voir les processus pendant l'audit, sait les voir.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(ICI, '..', '..');
const PS1 = path.join(ICI, 'integrite-chrome.ps1');
const MOYEN = 8192;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function echantillon() {
  const sortie = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1], { encoding: 'utf8', timeout: 60_000 });
  return sortie.split(/\r?\n/).filter((l) => /^\d+\|/.test(l)).map((l) => {
    const [pid, type, niveau, sans] = l.split('|');
    return { pid: Number(pid), type, niveau: Number(niveau), sansBacASable: sans === 'True' };
  });
}

async function auditer(dossier, env, cible = 'fixtures/widget-exemple') {
  const debut = Date.now();
  const enfant = spawn(process.execPath, ['bin/gwaudit.js', cible, '--json', '--sortie', dossier], {
    cwd: RACINE, env: { ...process.env, GWAUDIT_CHROMIUM_SANS_SANDBOX: '', ...env }, stdio: ['ignore', 'inherit', 'inherit'],
  });
  let fini = false;
  const fin = new Promise((r) => enfant.on('exit', (code) => { fini = true; r(code); }));
  const vus = [];
  while (!fini) {
    try { vus.push(...echantillon()); } catch (e) { console.error(`échantillon impossible : ${e.message.split('\n')[0]}`); }
    await Promise.race([fin, pause(100)]);
  }
  const code = await fin;
  const rapport = JSON.parse(fs.readFileSync(path.join(dossier, 'rapport.json'), 'utf8'));
  return { code, vus, rapport, duree: Date.now() - debut };
}

function resume(nom, { code, vus, rapport }) {
  const rendus = vus.filter((v) => v.type === 'renderer' && v.niveau >= 0);
  const niveaux = [...new Set(rendus.map((v) => v.niveau))].sort((a, b) => a - b);
  const navigateurs = vus.filter((v) => v.type === 'browser');
  console.log(`[${nom}] code ${code}, verdict ${rapport.verdict}, score ${rapport.scoreGlobal}, axes non exécutés ${JSON.stringify(rapport.axesNonExecutes)}, ` +
    `${vus.length} relevés (${navigateurs.length} navigateur, ${rendus.length} rendu), niveaux d'intégrité des rendus ${JSON.stringify(niveaux)}, ` +
    `--no-sandbox vu : ${vus.some((v) => v.sansBacASable)}, marqueur de dérogation dans le rapport : ${rapport.axes.D.constats.some((c) => c.regle === 'D-INDISPONIBLE-BAC-A-SABLE')}`);
  return { rendus, niveaux, navigateurs };
}

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-windows-'));
const echecs = [];

const avec = await auditer(path.join(dossier, 'avec'), {});
const a = resume('par défaut', avec);
if (avec.code > 2) echecs.push(`gwaudit a rendu le code ${avec.code} (erreur interne)`);
if (avec.rapport.axesNonExecutes.length || avec.rapport.axes.D.nonExecute !== false) echecs.push(`l'axe D n'a pas tourné par défaut : ${JSON.stringify(avec.rapport.axesNonExecutes)}`);
if (avec.rapport.axes.D.constats.some((c) => c.regle === 'D-INDISPONIBLE-BAC-A-SABLE')) echecs.push('le rapport annonce une dérogation au bac à sable alors qu\'aucune n\'a été posée');
if (avec.vus.some((v) => v.sansBacASable)) echecs.push('un processus Chromium a tourné avec --no-sandbox par défaut');
if (!a.navigateurs.length) echecs.push('aucun processus navigateur observé pendant l\'audit : preuve impossible');
if (!a.rendus.length) echecs.push('aucun processus de rendu de niveau lisible observé pendant l\'audit : preuve impossible');
if (a.rendus.some((v) => v.niveau >= MOYEN)) echecs.push(`un processus de rendu tourne au niveau d'intégrité moyen ou plus (${a.niveaux}) : pas de bac à sable`);

const sans = await auditer(path.join(dossier, 'sans'), { GWAUDIT_CHROMIUM_SANS_SANDBOX: '1' });
const s = resume('dérogation (témoin)', sans);
if (!sans.vus.some((v) => v.sansBacASable)) echecs.push('témoin : --no-sandbox introuvable sous la dérogation, la sonde ne sait pas le voir');
if (!s.rendus.length || !s.rendus.every((v) => v.niveau >= MOYEN)) echecs.push(`témoin : les rendus sans bac à sable devraient tous être de niveau moyen, vus : ${JSON.stringify(s.niveaux)}`);
if (!sans.rapport.axes.D.constats.some((c) => c.regle === 'D-INDISPONIBLE-BAC-A-SABLE')) echecs.push('témoin : le rapport ne dit pas que l\'axe D a tourné sans bac à sable');

// Le widget qui boucle. Délai global raccourci : le délai de chargement s'en déduit (moins 15 s).
const boucle = path.join(dossier, 'widget-boucle');
fs.mkdirSync(boucle);
fs.writeFileSync(path.join(boucle, 'index.html'), '<!doctype html><html lang="fr"><head><title>t</title></head><body><script>for(;;){}</script></body></html>\n');
const bloque = await auditer(path.join(dossier, 'boucle'), { GWAUDIT_DELAI_AXE_D_MS: '20000' }, boucle);
const b = resume('widget qui boucle', bloque);
const timeout = bloque.rapport.axes.D.constats.find((c) => c.regle === 'D-TIMEOUT-01');
console.log(`[widget qui boucle] audit conclu en ${Math.round(bloque.duree / 1000)} s, D-TIMEOUT-01 : ${timeout ? `${timeout.severite}${timeout.bloquant ? ', bloquant' : ''}, phase ${timeout.preuve?.phase}` : 'absent'}`);
if (bloque.code !== 2) echecs.push(`widget qui boucle : code ${bloque.code} au lieu de 2 (bloquant)`);
if (!timeout || !timeout.bloquant) echecs.push('widget qui boucle : D-TIMEOUT-01 bloquant absent');
if (bloque.rapport.verdict !== 'NON CONFORME') echecs.push(`widget qui boucle : verdict ${bloque.rapport.verdict}, NON CONFORME attendu`);
if (bloque.rapport.axes.D.nonExecute !== false) echecs.push("widget qui boucle : l'axe D est déclaré non exécuté, or il a tenté la mesure et le widget l'a empêchée");
if (bloque.duree > 90_000) echecs.push(`widget qui boucle : l'audit a mis ${Math.round(bloque.duree / 1000)} s à conclure`);
if (!b.navigateurs.length) echecs.push("widget qui boucle : aucun processus navigateur vu pendant l'audit, l'absence d'orphelin ne prouverait rien");
if (bloque.vus.some((v) => v.sansBacASable)) echecs.push('widget qui boucle : un processus Chromium a tourné avec --no-sandbox');
let orphelins = echantillon();
for (let essai = 0; orphelins.length && essai < 25; essai += 1) { await pause(200); orphelins = echantillon(); }
console.log(`[widget qui boucle] chrome.exe restants après l'audit : ${orphelins.length}`);
if (orphelins.length) echecs.push(`widget qui boucle : ${orphelins.length} processus chrome.exe restent après la fin de l'audit`);

fs.rmSync(dossier, { recursive: true, force: true });
if (echecs.length) {
  for (const e of echecs) console.error(`ÉCHEC : ${e}`);
  process.exit(1);
}
console.log('OK : sous Windows, l\'axe D par défaut lance Chromium avec son bac à sable (rendus au niveau d\'intégrité faible ou non fiable, jamais --no-sandbox), la même sonde voit la différence sous la dérogation, et un widget qui boucle est conclu en NON CONFORME (D-TIMEOUT-01) sans chrome.exe orphelin.');
