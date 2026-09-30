#!/usr/bin/env node
/**
 * Jusqu'à quelle imbrication chacun lit, pour chaque construction du langage qui s'imbrique : le navigateur (Chromium, dont la balise
 * `<script>` DÉMARRE : sa première instruction pose un drapeau, que la mesure relit ; un script que Chromium ne compile pas ne démarre
 * pas), la lecture de l'audit (acorn, `lire`) et le parcours que les règles font de l'arbre (acorn-walk : `simple`, `ancestor` et `full`,
 * les trois que les règles emploient). Là où le navigateur démarre un script plus imbriqué que l'audit ne le lit, le code est exécuté
 * et l'audit le dit illisible (C-SURFACE-03) ; là où la lecture passe mais où le parcours déborde, une règle échoue sur ce code et
 * l'audit le dit de même (cause `profondeur`). Là où l'audit lit plus profond que le navigateur ne démarre (les blocs, les `if`), le
 * navigateur n'exécute pas ce que l'audit ne lit pas : rien n'est à dire.
 *
 * La table mesure la pile de la machine, de Node et de Chromium qui la font : elle se refait, elle ne s'écrit pas dans un document.
 * Chaque sonde de l'audit tourne dans un processus neuf (le compilateur à froid : la première lecture d'un audit) et la recherche par
 * dichotomie s'arrête à 2 % (`--precision=0.3` pour une mesure grossière et rapide). Le navigateur mesuré compile et exécute le script
 * pour de bon, non sous un `if (0)` : son générateur de code est récursif lui aussi, et va moins profond que son analyseur pour
 * certaines constructions (les membres `a.a.a` : des centaines de milliers lus sous `if (0)`, 1 344 démarrés).
 *
 * Usage : [GWAUDIT_CHROMIUM_PATH=…] [GWAUDIT_CHROMIUM_SANS_SANDBOX=1] node scripts/mesurer-profondeur.mjs [--sans-chromium] [--json] [--construction=<motif>] [--precision=<fraction>]
 * Code 0 : mesuré ; code 2 : option inconnue, ou aucune construction ne correspond au motif.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ICI = fileURLToPath(import.meta.url);
const RACINE = path.resolve(path.dirname(ICI), '..');
const MAX = 400_000;

const repete = (motif, n) => motif.repeat(n);
/** nom → le code à la profondeur d. Les noms de la table de `docs/METHODOLOGIE.md` n'y sont pas : ce sont ceux de la mesure. */
const CONSTRUCTIONS = {
  'parenthèses ((( 1 )))': (d) => `${repete('(', d)}1${repete(')', d)}`,
  'tableaux [[[ ]]]': (d) => `${repete('[', d)}${repete(']', d)}`,
  'blocs { { { } } }': (d) => `${repete('{', d)}${repete('}', d)}`,
  'fonctions déclarées function f(){ … }': (d) => `${repete('function f(){', d)}${repete('}', d)}`,
  'flèches à corps x=>{ x=>{ } }': (d) => `${repete('x=>{', d)}${repete('}', d)}`,
  'flèches à expression x=>x=>1': (d) => `${repete('x=>', d)}1`,
  'if (a) { if (a) { } }': (d) => `${repete('if(a){', d)}${repete('}', d)}`,
  'if (a) if (a) 1;': (d) => `${repete('if(a)', d)}1;`,
  'négations !!!a': (d) => `${repete('!', d)}a`,
  'moins - - - a': (d) => `${repete('- ', d)}a`,
  'typeof typeof a': (d) => `${repete('typeof ', d)}a`,
  'ternaires à droite a?a?1:1:1': (d) => `${repete('a?', d)}1${repete(':1', d)}`,
  'ternaires à gauche a?1:a?1:a': (d) => `a${repete('?1:a', d)}`,
  'affectations a=a=a=1': (d) => `${repete('a=', d)}1`,
  'appels imbriqués f(f(f(1)))': (d) => `${repete('f(', d)}1${repete(')', d)}`,
  'gabarits imbriqués `${`${1}`}`': (d) => `${repete('`${', d)}1${repete('}`', d)}`,
  'objets imbriqués ({a:({a:1})})': (d) => `${repete('({a:', d)}1${repete('})', d)}`,
  'membres a.a.a.a': (d) => `a${repete('.a', d)}`,
  'membres optionnels a?.a?.a': (d) => `a${repete('?.a', d)}`,
  'additions 1+1+1+1': (d) => `${repete('1+', d)}1`,
  'appels enchaînés a()()()': (d) => `a${repete('()', d)}`,
  'indices enchaînés a[0][0]': (d) => `a${repete('[0]', d)}`,
  'gabarits étiquetés a`x``x`': (d) => `a${repete('`x`', d)}`,
  'virgules a,a,a,a': (d) => `${repete('a,', d)}a`,
  'ou logiques a||a||a': (d) => `${repete('a||', d)}a`,
  'try imbriqués': (d) => `${repete('try{', d)}${repete('}catch(e){}', d)}`,
  'for imbriqués for(;0;) for(;0;)': (d) => `${repete('for(;0;)', d)}1;`,
  'héritages de classes class A extends (…)': (d) => `(${repete('class A extends (', d)}Object${repete(') {}', d)})`,   // une expression : une déclaration `class A` resterait dans la portée du script suivant et le ferait échouer (redéclaration)
  'groupes d\'expression régulière /(((a)))/': (d) => `/${repete('(', d)}a${repete(')', d)}/`,
  'décomptes de tableaux [...[...[]]]': (d) => `${repete('[...', d)}[]${repete(']', d)}`,
  'attentes await await a': (d) => `async function g(){ ${repete('await ', d)}a }`,
  'new new new a': (d) => `${repete('new ', d)}a`,
  'étiquettes a0: a1: a2: 1': (d) => `${Array.from({ length: d }, (_, i) => `a${i}:`).join('')}1;`,
};

/** Le script mesuré : un drapeau d'abord, puis la construction ; le navigateur qui ne compile pas le script ne pose pas le drapeau. */
const source = (nom, d) => `globalThis.__demarre=1;${CONSTRUCTIONS[nom](d)}`;

// ---------------------------------------------------------------------------
// Une sonde d'audit, dans un processus neuf : imprime `ok` ou `non`.
// ---------------------------------------------------------------------------
async function sonde(nom, mesure, d) {
  const { lire, depassementDePile } = await import(pathToFileURL(path.join(RACINE, 'src/moteur/analyse-js.js')).href);
  const walk = await import(pathToFileURL(path.join(RACINE, 'node_modules/acorn-walk/dist/walk.mjs')).href);
  const { ast } = lire(source(nom, d));
  if (!ast) return 'non';
  if (mesure === 'lecture') return 'ok';
  try {
    walk.full(ast, () => {});
    walk.simple(ast, {});
    walk.ancestor(ast, {});
    return 'ok';
  } catch (e) {
    if (depassementDePile(e)) return 'non';
    throw e;
  }
}

if (process.argv[2] === '--sonde') {
  const [, , , nom, mesure, d] = process.argv;
  process.stdout.write(await sonde(nom, mesure, Number(d)));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// La mesure.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const USAGE = 'Usage : node scripts/mesurer-profondeur.mjs [--sans-chromium] [--json] [--construction=<motif>] [--precision=<fraction>]';
const inconnues = args.filter((a) => !['--json', '--sans-chromium'].includes(a) && !a.startsWith('--construction=') && !a.startsWith('--precision='));
if (inconnues.length) {
  console.error(`Option inconnue : ${inconnues.join(' ')}\n${USAGE}`);
  process.exit(2);
}
const precisionDite = args.find((a) => a.startsWith('--precision='))?.slice('--precision='.length);
const PRECISION = precisionDite === undefined ? 0.02 : Number(precisionDite);
if (!(PRECISION > 0 && PRECISION < 1)) {
  console.error(`Précision invalide : « ${precisionDite} » (une fraction entre 0 et 1, exclue).\n${USAGE}`);
  process.exit(2);
}
const json = args.includes('--json');
const sansChromium = args.includes('--sans-chromium');
const motif = args.find((a) => a.startsWith('--construction='))?.slice('--construction='.length);
const noms = Object.keys(CONSTRUCTIONS).filter((n) => !motif || n.toLowerCase().includes(motif.toLowerCase()));
if (!noms.length) {
  console.error(`Aucune construction ne correspond à « ${motif} ».`);
  process.exit(2);
}

/** Le plus grand d pour lequel `tient(d)` est vrai, à `PRECISION` près (doublement puis dichotomie) ; `>d` si tout jusqu'à MAX tient ; 0 si même 1 ne tient pas. */
async function limite(tient) {
  if (!(await tient(1))) return 0;
  let bas = 1;
  let haut = 2;
  while (haut <= MAX && (await tient(haut))) { bas = haut; haut *= 2; }
  if (haut > MAX) return `>${bas}`;
  while (haut - bas > Math.max(1, Math.floor(bas * PRECISION))) {
    const milieu = Math.floor((bas + haut) / 2);
    if (await tient(milieu)) bas = milieu; else haut = milieu;
  }
  return bas;
}

/** Les sondes qu'un SIGABRT a tuées : V8 avorte quand le dépassement de pile tombe dans la compilation d'une expression régulière, ce qu'aucun `try` n'attrape. */
const avortements = new Map();
const tientAudit = (nom, mesure) => async (d) => {
  const r = spawnSync(process.execPath, [ICI, '--sonde', nom, mesure, String(d)], { encoding: 'utf8', timeout: 120_000 });
  if (r.signal === 'SIGABRT') { avortements.set(nom, (avortements.get(nom) ?? 0) + 1); return false; }   // le processus n'a pas lu ce code : pour la limite, c'est un refus, et il est compté
  if (r.signal) throw new Error(`la sonde ${nom}/${mesure}/${d} est tuée par ${r.signal}`);
  if (r.status !== 0) throw new Error(`la sonde ${nom}/${mesure}/${d} sort en code ${r.status} : ${(r.stderr ?? '').split('\n')[0]}`);
  return r.stdout === 'ok';
};

let navigateur = null;
let page = null;
if (!sansChromium) {
  const { chromium } = await import('playwright');
  const executable = process.env.GWAUDIT_CHROMIUM_PATH || undefined;
  navigateur = await chromium.launch({ ...(executable ? { executablePath: executable } : {}), args: process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  page = await (await navigateur.newContext()).newPage();
  await page.goto('about:blank');
}
const tientChromium = (nom) => async (d) => {
  // Une balise `<script>` insérée dans la page : le script démarre si Chromium le compile (le drapeau est posé) ; ce qui suit le drapeau peut échouer, sans importance.
  return page.evaluate((s) => {
    delete globalThis.__demarre;
    globalThis.a = function a() { return a; }; globalThis.f = (x) => x;    // des opérandes qui existent : le script ne s'arrête pas de lui-même avant le reste
    const balise = document.createElement('script');
    balise.textContent = s;
    try { document.documentElement.appendChild(balise); } catch { /* un dépassement de pile à la compilation remonte ici */ }
    balise.remove();
    return globalThis.__demarre === 1;
  }, source(nom, d));
};

const versionChromium = navigateur ? navigateur.version() : null;
const lignes = [];
try {
  for (const nom of noms) {
    const ligne = { construction: nom };
    if (page) ligne.navigateur = await limite(tientChromium(nom));
    ligne.lecture = await limite(tientAudit(nom, 'lecture'));
    ligne.parcours = await limite(tientAudit(nom, 'parcours'));
    if (avortements.get(nom)) ligne.avortements = avortements.get(nom);
    lignes.push(ligne);
  }
} finally {
  await navigateur?.close();
}

const en = (x) => (typeof x === 'number' ? String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : String(x).replace('>', 'plus de ').replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const nombre = (x) => Number(String(x).replace('>', '').replace(/ /g, ''));
const version = { node: process.version, chromium: versionChromium };
if (json) {
  console.log(JSON.stringify({ ...version, lignes }, null, 2));
} else {
  console.log(`Node ${version.node}${version.chromium ? `, Chromium ${version.chromium}` : ''} ; niveaux d'imbrication, sonde d'audit dans un processus neuf, précision ${PRECISION * 100} %`);
  const l = Math.max(...noms.map((n) => n.length));
  console.log(`${'construction'.padEnd(l)}  ${'navigateur'.padStart(16)}  ${'lecture'.padStart(16)}  ${'parcours'.padStart(16)}`);
  for (const ligne of lignes) {
    const ecart = page && nombre(ligne.navigateur) > nombre(ligne.lecture) ? '  Chromium exécute ce que l\'audit ne lit pas' : (page && nombre(ligne.navigateur) > nombre(ligne.parcours) ? '  Chromium exécute ce que le parcours ne tient pas' : (nombre(ligne.lecture) > nombre(ligne.parcours) ? '  la lecture passe, le parcours déborde' : ''));
    const avorte = ligne.avortements ? `  ${ligne.avortements} sonde(s) tuée(s) par SIGABRT (V8 avorte, rien ne l'attrape)` : '';
    console.log(`${ligne.construction.padEnd(l)}  ${page ? en(ligne.navigateur).padStart(16) : '—'.padStart(16)}  ${en(ligne.lecture).padStart(16)}  ${en(ligne.parcours).padStart(16)}${ecart}${avorte}`);
  }
}
