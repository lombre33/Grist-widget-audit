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
 *     HTML (transitivement, via <script src> et import ES) ;
 *   - le RESTE du dépôt.
 */
import fs from 'node:fs';
import path from 'node:path';

const EXCLUS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', '__pycache__']);

const BINAIRES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.zip', '.gz', '.mp4', '.webm', '.mp3', '.wasm']);

/** Extensions considérées comme du code exécuté côté navigateur. */
const CODE_WEB = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.html', '.htm', '.css']);

/**
 * @param {string} racine chemin absolu du dépôt audité
 * @returns {{racine:string, fichiers:Array, entrees:Array, surface:Set<string>, paquet:object|null, manifestes:Array}}
 */
export function construireContexte(racine) {
  const fichiers = [];
  parcourir(racine, racine, fichiers);

  const paquet = lireJson(path.join(racine, 'package.json'));
  const manifestes = fichiers
    .filter((f) => path.basename(f.chemin) === 'manifest.json')
    .map((f) => ({ chemin: f.chemin, contenu: lireJson(path.join(racine, f.chemin)) }))
    .filter((m) => m.contenu);

  const entrees = trouverPointsDEntree(racine, fichiers, manifestes);
  const surface = calculerSurface(racine, fichiers, entrees);

  for (const f of fichiers) f.executee = surface.has(f.chemin);

  return { racine, fichiers, entrees, surface, paquet, manifestes };
}

function parcourir(racine, dossier, acc) {
  let entrees;
  try { entrees = fs.readdirSync(dossier, { withFileTypes: true }); } catch { return; }
  for (const e of entrees) {
    if (EXCLUS.has(e.name)) continue;
    const abs = path.join(dossier, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { parcourir(racine, abs, acc); continue; }
    if (!e.isFile()) continue;
    const rel = path.relative(racine, abs);
    const ext = path.extname(e.name).toLowerCase();
    let taille = 0;
    try { taille = fs.statSync(abs).size; } catch { continue; }
    const binaire = BINAIRES.has(ext) || taille > 4 * 1024 * 1024;
    const f = { chemin: rel, ext, taille, binaire, code: CODE_WEB.has(ext), executee: false };
    if (!binaire) {
      try {
        f.contenu = fs.readFileSync(abs, 'utf8');
        f.lignes = f.contenu.split('\n');
        // Ligne « significative » : ni vide, ni commentaire seul.
        f.locSignificatives = f.lignes.filter((l) => {
          const t = l.trim();
          return t && !/^(\/\/|\/\*|\*|#|<!--)/.test(t);
        }).length;
      } catch { f.binaire = true; }
    }
    acc.push(f);
  }
}

/** Points d'entrée : index.html, les HTML référencés par un manifest.json, sinon tout HTML racine. */
function trouverPointsDEntree(racine, fichiers, manifestes) {
  const html = fichiers.filter((f) => f.ext === '.html' || f.ext === '.htm');
  const entrees = new Set();

  for (const f of html) {
    const profondeur = f.chemin.split(path.sep).length - 1;
    const nom = path.basename(f.chemin).toLowerCase();
    if (nom === 'index.html' && profondeur <= 1) entrees.add(f.chemin);
  }
  for (const m of manifestes) {
    const liste = Array.isArray(m.contenu) ? m.contenu : (m.contenu.widgets ?? []);
    for (const w of liste) {
      if (typeof w?.url !== 'string') continue;
      if (/^https?:/i.test(w.url)) continue; // widget hébergé ailleurs : hors surface locale
      const cible = path.normalize(path.join(path.dirname(m.chemin), w.url)).replace(/^(\.\.[/\\])+/, '');
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
      if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:')) continue;
      const cible = path.normalize(path.join(path.dirname(rel), ref.split(/[?#]/)[0]));
      for (const candidat of [cible, `${cible}.js`, `${cible}.mjs`, path.join(cible, 'index.js')]) {
        if (parChemin.has(candidat) && !surface.has(candidat)) file.push(candidat);
      }
    }
  }
  return surface;
}

/** Références locales sortantes d'un fichier (script src, link href, import, url()). */
function referencesSortantes(f) {
  const refs = [];
  const c = f.contenu ?? '';
  if (f.ext === '.html' || f.ext === '.htm') {
    for (const m of c.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
    for (const m of c.matchAll(/<link[^>]+href\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  }
  if (f.ext === '.css') for (const m of c.matchAll(/url\(\s*["']?([^"')]+)/gi)) refs.push(m[1]);
  if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(f.ext)) {
    for (const m of c.matchAll(/\bfrom\s+["']([^"']+)["']/g)) refs.push(m[1]);
    for (const m of c.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) refs.push(m[1]);
  }
  return refs;
}

function lireJson(abs) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

/** Numéro de ligne (1-based) d'un décalage caractère. */
export function ligneDe(contenu, index) {
  return contenu.slice(0, index).split('\n').length;
}
