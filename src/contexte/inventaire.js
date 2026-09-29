/**
 * Construction du contexte d'audit : ce que le dépôt contient, et ce qui,
 * dedans, constitue réellement le widget livré au navigateur.
 *
 * La distinction est structurante. Un dépôt de widget contient souvent des
 * scripts de développement, des prototypes, des notes de conception. Ils
 * comptent pour la lisibilité et la maintenabilité, mais ils ne sont pas
 * chargés dans le navigateur de l'agent : les remonter comme du risque de
 * sécurité noierait les vrais points durs. On sépare donc :
 *   - la SURFACE EXÉCUTÉE : fichiers atteignables depuis les points d'entrée
 *     HTML (transitivement, via <script src>, import ES, new Worker()/
 *     new SharedWorker() à source locale, et importScripts()) ;
 *   - le RESTE du dépôt.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as walk from 'acorn-walk';
import { lirePage, urlDe, cheminLocal } from '../moteur/page-html.js';
import { parser, chaineLitterale } from '../moteur/analyse-js.js';
import { lireFeuille, nouveauBudgetCss } from '../moteur/css.js';

const EXCLUS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', '__pycache__']);

const BINAIRES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.zip', '.gz', '.mp4', '.webm', '.mp3', '.wasm']);

/**
 * Plafonds sur l'inventaire, indépendants de la confiance qu'on peut avoir
 * dans le dépôt audité : `gwaudit` est justement conçu pour tourner sur du
 * code qu'on ne connaît pas encore. Sans ça, un dépôt hostile (des dizaines
 * de milliers de petits fichiers, ou quelques gros fichiers texte juste sous
 * le seuil « binaire ») peut geler ou épuiser la mémoire de la machine qui
 * audite — bien avant que la moindre règle statique ne tourne.
 */
const MAX_FICHIERS = 20_000;
const MAX_OCTETS_LUS_CUMULES = 200 * 1024 * 1024;

/** Extensions considérées comme du code exécuté côté navigateur. */
const CODE_WEB = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.html', '.htm', '.css']);

/**
 * @param {string} racine chemin absolu du dépôt audité
 * @returns {{racine:string, fichiers:Array, entrees:Array, surface:Set<string>, paquet:object|null, manifestes:Array}}
 */
export function construireContexte(racine) {
  const fichiers = [];
  const etat = { octetsLus: 0, tronqueFichiers: false, tronqueOctets: false };
  parcourir(racine, racine, fichiers, etat);

  const paquet = lireJson(path.join(racine, 'package.json'));
  const manifestes = fichiers
    .filter((f) => path.basename(f.chemin) === 'manifest.json')
    .map((f) => ({ chemin: f.chemin, contenu: lireJson(path.join(racine, f.chemin)) }))
    .filter((m) => m.contenu);

  const entrees = trouverPointsDEntree(racine, fichiers, manifestes);
  const surface = calculerSurface(racine, fichiers, entrees);

  for (const f of fichiers) {
    f.executee = surface.has(f.chemin);
    f.vendorise = estVendorise(f);
  }

  const tronque = (etat.tronqueFichiers || etat.tronqueOctets)
    ? { fichiers: etat.tronqueFichiers, octets: etat.tronqueOctets, maxFichiers: MAX_FICHIERS, maxOctets: MAX_OCTETS_LUS_CUMULES }
    : null;

  // Figé ICI, avant qu'aucune règle ne tourne : `preparerCodeExecuteEnChaine`
  // (axe C) ajoute ensuite à `fichiers` un fichier synthétique par contenu
  // littéral exécuté en chaîne (eval/Function/setTimeout/Worker), pour que
  // chaque règle qui lit `ctx.fichiers` l'audite sans code spécial. Ce
  // compte-ci reste celui du DÉPÔT tel qu'il existe sur disque, pour que
  // l'inventaire affiché au lecteur ne varie pas selon qu'un widget cache ou
  // non du code dans une chaîne.
  const fichiersReels = fichiers.length;

  return { racine, fichiers, entrees, surface, paquet, manifestes, tronque, fichiersReels };
}

function parcourir(racine, dossier, acc, etat) {
  if (etat.tronqueFichiers) return;
  let entrees;
  try { entrees = fs.readdirSync(dossier, { withFileTypes: true }); } catch { return; }
  for (const e of entrees) {
    if (etat.tronqueFichiers) return;
    if (EXCLUS.has(e.name)) continue;
    const abs = path.join(dossier, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { parcourir(racine, abs, acc, etat); continue; }
    if (!e.isFile()) continue;
    if (acc.length >= MAX_FICHIERS) { etat.tronqueFichiers = true; return; }
    // Normalisé en '/' une fois pour toutes, quelle que soit la plateforme :
    // `path.relative()` rend le séparateur natif (`\` sous Windows), et
    // laisser passer cette variation obligerait chaque règle à connaître le
    // détail (déjà vu deux fois : `estVendorise` ci-dessous, et le motif de
    // détection des tests dans a-qualite.js). Un seul point de vérité ici
    // évite d'en rater une troisième en silence.
    const rel = path.relative(racine, abs).split(path.sep).join('/');
    const ext = path.extname(e.name).toLowerCase();
    let taille = 0;
    try { taille = fs.statSync(abs).size; } catch { continue; }
    const binaire = BINAIRES.has(ext) || taille > 4 * 1024 * 1024;
    const f = { chemin: rel, ext, taille, binaire, code: CODE_WEB.has(ext), executee: false };
    if (!binaire) {
      if (etat.octetsLus + taille > MAX_OCTETS_LUS_CUMULES) {
        // Plafond cumulé atteint : on garde l'entrée (taille, extension) pour
        // l'inventaire et les axes qui n'ont pas besoin du contenu, mais on
        // n'en lit pas le texte en mémoire — au même titre qu'un fichier
        // binaire pour le reste de l'outil (voir `f.binaire`).
        etat.tronqueOctets = true;
        f.binaire = true;
        f.contenuTronque = true;
      } else {
        try {
          f.contenu = fs.readFileSync(abs, 'utf8');
          etat.octetsLus += taille;
          f.lignes = f.contenu.split('\n');
          // Ligne « significative » : ni vide, ni commentaire seul.
          f.locSignificatives = f.lignes.filter((l) => {
            const t = l.trim();
            return t && !/^(\/\/|\/\*|\*|#|<!--)/.test(t);
          }).length;
        } catch { f.binaire = true; }
      }
    }
    acc.push(f);
  }
}

/** Points d'entrée : index.html, les HTML référencés par un manifest.json, sinon tout HTML racine. */
function trouverPointsDEntree(racine, fichiers, manifestes) {
  const html = fichiers.filter((f) => f.ext === '.html' || f.ext === '.htm');
  const entrees = new Set();

  for (const f of html) {
    // `f.chemin` est normalisé en '/' (voir parcourir()) : le compte de
    // segments doit rester cohérent avec cette convention sur toute
    // plateforme, jamais avec le séparateur natif de celle qui exécute
    // l'audit.
    const profondeur = f.chemin.split('/').length - 1;
    const nom = path.basename(f.chemin).toLowerCase();
    if (nom === 'index.html' && profondeur <= 1) entrees.add(f.chemin);
  }
  for (const m of manifestes) {
    const liste = Array.isArray(m.contenu) ? m.contenu : (m.contenu.widgets ?? []);
    for (const w of liste) {
      if (typeof w?.url !== 'string') continue;
      if (/^https?:/i.test(w.url)) continue; // widget hébergé ailleurs : hors surface locale
      // `path.posix.*`, pas `path.join`/`path.normalize` natifs : ceux-ci
      // rendent `\` sous Windows même à partir d'entrées en '/', ce qui
      // romprait la comparaison avec `f.chemin` (normalisé en '/').
      const cible = path.posix.normalize(path.posix.join(path.posix.dirname(m.chemin), w.url)).replace(/^(\.\.\/)+/, '');
      if (fichiers.some((f) => f.chemin === cible)) entrees.add(cible);
    }
  }
  if (!entrees.size && html.length) entrees.add(html.sort((a, b) => a.chemin.length - b.chemin.length)[0].chemin);
  return [...entrees];
}

/**
 * Fermeture transitive des fichiers atteignables depuis les points d'entrée.
 * Volontairement tolérante : en cas de doute on inclut, un faux positif sur
 * la surface coûte moins cher qu'un angle mort de sécurité.
 */
function calculerSurface(racine, fichiers, entrees) {
  const parChemin = new Map(fichiers.map((f) => [f.chemin, f]));
  const surface = new Set();
  const file = [...entrees];

  while (file.length) {
    const rel = file.shift();
    if (surface.has(rel)) continue;
    const f = parChemin.get(rel);
    if (!f || f.binaire) continue;
    surface.add(rel);

    for (const ref of referencesSortantes(f)) {
      let cible;
      if (typeof ref === 'object') cible = ref.chemin;              // déjà résolue depuis la racine du widget (page HTML, `<base>` comprise)
      else {
        if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('blob:')) continue;
        // `path.posix.*` ici aussi, même raison que dans trouverPointsDEntree().
        cible = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref.split(/[?#]/)[0]));
      }
      for (const candidat of [cible, `${cible}.js`, `${cible}.mjs`, path.posix.join(cible, 'index.js')]) {
        if (parChemin.has(candidat) && !surface.has(candidat)) file.push(candidat);
      }
    }
  }
  return surface;
}

/**
 * Références vers un worker ou un sous-script de worker, à source locale
 * résolvable statiquement. Un fichier de worker n'est référencé par aucun
 * <script> ni import ES, mais il est pleinement exécuté dans le navigateur
 * de l'agent dès que le constructeur tourne : sans ceci, son contenu (un
 * `importScripts()` vers un domaine externe, par exemple — voir
 * C-EXFIL-01/02) n'entre jamais dans `surface`, quel que soit l'appel qu'il
 * contient. Couvre la forme directe (`new Worker('./w.js')`), celle que
 * produisent les empaqueteurs (`new Worker(new URL('./w.js', <base
 * quelconque>))`, Vite/Webpack 5 — la base n'est pas vérifiée : c'est le
 * premier argument, littéral ici par construction, qui reste local ou
 * devient une URL absolue morte, jamais autre chose, quelle qu'elle soit),
 * et un gabarit statique sans interpolation (`` new Worker(`./w.js`) ``) —
 * jamais une expression calculée, qu'aucune de ces formes syntaxiques ne
 * couvre. Un alias global de tête (`window.Worker`, `self.SharedWorker`,
 * `globalThis.URL`) est reconnu au même titre que la forme nue. Une URL
 * absolue (http(s):, data:, blob:) est déjà écartée plus bas par le même
 * filtre que pour les autres références ; `importScripts()` peut prendre
 * plusieurs arguments (tous chargés), on les suit tous, pas seulement le
 * premier.
 */
function referencesWorker(contenu) {
  const ALIAS = '(?:(?:window|self|globalThis)\\.)?';
  const refs = [];
  for (const m of contenu.matchAll(new RegExp(`\\bnew\\s+${ALIAS}(?:Worker|SharedWorker)\\s*\\(\\s*(?:["']([^"']+)["']|\`([^\`$]+)\`)`, 'g'))) {
    refs.push(m[1] ?? m[2]);
  }
  for (const m of contenu.matchAll(new RegExp(`\\bnew\\s+${ALIAS}(?:Worker|SharedWorker)\\s*\\(\\s*new\\s+${ALIAS}URL\\s*\\(\\s*(?:["']([^"']+)["']|\`([^\`$]+)\`)\\s*[,)]`, 'g'))) {
    refs.push(m[1] ?? m[2]);
  }
  for (const m of contenu.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/["']([^"']+)["']/g)) refs.push(s[1]);
  }
  return refs;
}

/**
 * Références qu'un code JavaScript suit : `import` (avec ou sans liaison,
 * `import './app.js'` compris), `export … from`, `import()` à argument
 * littéral (chaîne ou gabarit sans interpolation), lus dans l'AST, jamais dans
 * un commentaire ni dans une chaîne ; plus les workers (voir `referencesWorker`).
 * Un code qu'acorn ne lit pas (TypeScript, JSX) se lit par expressions
 * régulières : le doute inclut, une entrée de trop dans la surface coûte moins
 * qu'un angle mort.
 */
function referencesDeCode(source) {
  const ast = parser(source);
  const refs = [];
  if (ast) {
    walk.full(ast, (n) => {
      if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || (n.type === 'ExportNamedDeclaration' && n.source)) {
        if (typeof n.source.value === 'string') refs.push(n.source.value);
      } else if (n.type === 'ImportExpression') {
        const valeur = chaineLitterale(n.source);
        if (valeur !== null) refs.push(valeur);
      }
    });
  } else {
    for (const m of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) refs.push(m[1]);
    for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) refs.push(m[1]);
    for (const m of source.matchAll(/\bimport\s+["']([^"']+)["']/g)) refs.push(m[1]);
  }
  refs.push(...referencesWorker(source));
  return refs;
}

/** URL que la lecture d'une feuille de style demande (`@import`, `url()`, préchargement), sans les bornes. */
function urlsDeFeuille(entrees) {
  return entrees.filter((e) => e.sorte !== 'borne' && e.url !== '').map((e) => e.url);
}

/**
 * Références locales sortantes d'un fichier (script src, link href, import,
 * url(), worker). Une page HTML les donne déjà résolues depuis la racine du
 * widget (`{chemin}`), `<base>` comprise : un chargement qui sort du widget
 * n'y figure pas, le fichier local du même nom n'est jamais lu à sa place.
 */
function referencesSortantes(f) {
  const refs = [];
  const c = f.contenu ?? '';
  if (f.ext === '.html' || f.ext === '.htm') {
    const { scripts, ressources, feuilles } = lirePage(c);
    const local = (valeur, baseBrute) => {
      const chemin = cheminLocal(urlDe(valeur, baseBrute, f.chemin));
      if (chemin !== null) refs.push({ chemin });
    };
    for (const s of scripts) {
      for (const ch of s.chargements) if (ch.execute) local(ch.valeur, s.baseBrute);
      if (s.unite) for (const ref of referencesDeCode(s.texte)) local(ref, s.baseBrute);   // un worker écrit en commentaire ou en gabarit n'y figure pas
    }
    for (const r of ressources) if (r.nom === 'link') { const href = r.attributs.get('href'); if (href != null) local(href, r.baseBrute); }
    // Le CSS écrit dans la page (`<style>`, attributs `style`, feuille `data:`) est lu comme le navigateur le lit, ses URL relatives résolues contre la base de la page.
    const budget = nouveauBudgetCss();
    for (const feuille of feuilles) for (const url of urlsDeFeuille(lireFeuille(feuille, budget))) local(url, feuille.baseBrute);
  }
  if (f.ext === '.css') refs.push(...urlsDeFeuille(lireFeuille({ sorte: 'style', applique: true, precharge: false, modele: false, texte: c, mimeLibre: true, baseBrute: null })));
  if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(f.ext)) refs.push(...referencesDeCode(c));
  return refs;
}

/**
 * Signature des utilitaires que les empaqueteurs (esbuild, webpack, rollup…)
 * injectent en tête de bundle pour polyfiller `Object.defineProperty` et le
 * système de modules. Un contributeur n'écrit jamais `__defProp` ou
 * `__commonJS` à la main : leur présence identifie un fichier généré par un
 * outil de build, quels que soient sa mise en forme et son emplacement —
 * contrairement à la longueur de ligne, qui ne détecte que la minification
 * et manque un bundle simplement compilé (indenté, non minifié).
 */
const SIGNATURE_BUNDLEUR = /\b(__defProp|__getOwnPropNames|__getOwnPropDesc|__getProtoOf|__commonJS|__esModule|__toESM|__webpack_require__|webpackBootstrap)\b/;

/**
 * Fichier qui présente les caractéristiques d'une bibliothèque tierce
 * recopiée dans le dépôt (bundlée ou minifiée), au sens de la règle E-DEP-02 :
 * chemin `vendor/`, `libs/`, `third-party/`, suffixe `.min.js`, ligne
 * moyenne très longue (minification), ou signature d'empaqueteur.
 *
 * Point de vérité unique : les axes A et B s'appuient sur `f.vendorise`
 * pour ne pas juger la qualité et la lisibilité d'un code que le
 * contributeur n'a pas écrit — les axes C, D et E continuent de l'évaluer
 * pleinement, la surface de sécurité et le risque de dépendance restant
 * entiers quelle que soit l'origine du fichier.
 */
export function estVendorise(f) {
  if (f.binaire || !f.contenu || !['.js', '.mjs'].includes(f.ext)) return false;
  return /(^|\/)(vendor|libs?|third[-_]party|assets\/js\/lib)\//i.test(f.chemin) ||
    /\.min\.js$/.test(f.chemin) ||
    ((f.locSignificatives ?? 0) > 300 && (f.taille / Math.max(1, f.lignes.length)) > 200) ||
    ((f.locSignificatives ?? 0) > 300 && SIGNATURE_BUNDLEUR.test(f.contenu.slice(0, 5000)));
}

function lireJson(abs) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

/** Numéro de ligne (1-based) d'un décalage caractère. */
export function ligneDe(contenu, index) {
  return contenu.slice(0, index).split('\n').length;
}
