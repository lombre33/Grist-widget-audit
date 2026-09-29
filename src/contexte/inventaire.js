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
import { lirePage, urlDe, urlDeCarte, cheminLocal, mentionDe } from '../moteur/page-html.js';
import { parser, chaineLitterale, nomPointe, extraireImportMaps } from '../moteur/analyse-js.js';
import { lireFeuille, nouveauBudgetCss } from '../moteur/css.js';

/**
 * Dossiers que l'inventaire ne parcourt pas : du code généré ou tiers, ou de
 * l'outillage, qu'on ne lit pas en entier. Ce que la page en charge n'en est
 * pas moins du widget (jupyterlite charge son code applicatif depuis `build/`,
 * un widget malveillant range son code dans `dist/`) : `ouvrirHorsInventaire`
 * le fait entrer, marqué `dossierExclu`, quand une référence y mène. Seul
 * `.git` n'est jamais servi, donc jamais suivi.
 */
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
 * @param {{ maxEntreesListees?: number, maxResolutions?: number }} [plafonds] `maxEntreesListees` : les entrées de dossier que la lecture d'un préfixe d'import map peut parcourir (`MAX_ENTREES_LISTEES` par défaut) ; `maxResolutions` : les résolutions d'adresse de worker sous une page d'entrée que la fermeture peut faire (`MAX_RESOLUTIONS`). Seuls les essais les changent.
 * @returns {{racine:string, fichiers:Array, entrees:Array, surface:Set<string>, paquet:object|null, manifestes:Array}}
 */
export function construireContexte(racine, { maxEntreesListees = MAX_ENTREES_LISTEES, maxResolutions = MAX_RESOLUTIONS } = {}) {
  const fichiers = [];
  const etat = { octetsLus: 0, tronqueFichiers: false, tronqueOctets: false, tronqueListage: false, exclus: [] };
  parcourir(racine, racine, fichiers, etat);

  const paquet = lireJson(path.join(racine, 'package.json'));
  const manifestes = fichiers
    .filter((f) => path.basename(f.chemin) === 'manifest.json')
    .map((f) => ({ chemin: f.chemin, contenu: lireJson(path.join(racine, f.chemin)) }))
    .filter((m) => m.contenu);

  const parChemin = new Map(fichiers.map((f) => [f.chemin, f]));
  const trouver = (chemin) => parChemin.get(chemin) ?? ouvrirHorsInventaire(racine, chemin, fichiers, parChemin, etat);
  const entrees = trouverPointsDEntree(fichiers, manifestes, trouver);
  const { surface, mentions, partiel } = calculerSurface(entrees, trouver, nouveauListeur(racine, fichiers, etat, maxEntreesListees), { maxResolutions });

  for (const f of fichiers) {
    f.executee = surface.has(f.chemin);
    f.mention = mentions.get(f.chemin) ?? null;
    f.vendorise = estVendorise(f);
  }

  const tronque = (etat.tronqueFichiers || etat.tronqueOctets || etat.tronqueListage || partiel)
    ? { fichiers: etat.tronqueFichiers, octets: etat.tronqueOctets, listage: etat.tronqueListage, surface: partiel, maxFichiers: MAX_FICHIERS, maxOctets: MAX_OCTETS_LUS_CUMULES, maxEntreesListees, maxResolutions }
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
    const abs = path.join(dossier, e.name);
    if (EXCLUS.has(e.name)) {
      // Noté, pour que `nouveauListeur` sache où lister ce que l'inventaire ne lit pas.
      if (e.isDirectory() && e.name !== '.git') etat.exclus.push(path.relative(racine, abs).split(path.sep).join('/'));
      continue;
    }
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { parcourir(racine, abs, acc, etat); continue; }
    if (!e.isFile()) continue;
    if (acc.length >= MAX_FICHIERS) { etat.tronqueFichiers = true; return; }
    const f = fiche(racine, abs, etat);
    if (f) acc.push(f);
  }
}

/** Fiche d'un fichier du dépôt : taille, extension, contenu lu sauf plafond ; null s'il n'a pas de taille lisible. */
function fiche(racine, abs, etat) {
  // Normalisé en '/' une fois pour toutes, quelle que soit la plateforme :
  // `path.relative()` rend le séparateur natif (`\` sous Windows), et
  // laisser passer cette variation obligerait chaque règle à connaître le
  // détail (déjà vu deux fois : `estVendorise` ci-dessous, et le motif de
  // détection des tests dans a-qualite.js). Un seul point de vérité ici
  // évite d'en rater une troisième en silence.
  const rel = path.relative(racine, abs).split(path.sep).join('/');
  const ext = path.extname(abs).toLowerCase();
  let taille = 0;
  try { taille = fs.statSync(abs).size; } catch { return null; }
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
  return f;
}

/**
 * Un fichier que la page charge et que l'inventaire n'a pas parcouru parce
 * qu'un dossier de son chemin est exclu (voir `EXCLUS`) : lu à la demande,
 * dans les mêmes plafonds, et rendu `dossierExclu` (code généré ou tiers :
 * exempt des axes A et B, audité pour tout le reste). Aucun élément de son
 * chemin ne doit être un lien : l'inventaire n'en suit aucun, et un lien
 * vers l'extérieur ferait entrer dans le rapport un fichier du poste qui
 * audite. Null si le chemin n'est pas dans un dossier exclu, s'il sort du
 * dépôt, ou s'il ne désigne pas un fichier ordinaire. Un chemin qui n'est pas
 * sous sa forme normale (segment vide, `.`, `..`) n'ouvre rien, même si les
 * appelants le normalisent : un fichier ne s'enregistre jamais sous deux noms.
 */
export function ouvrirHorsInventaire(racine, rel, fichiers, parChemin, etat) {
  const segments = rel.split('/');
  if (!segments.some((s) => EXCLUS.has(s)) || segments.includes('.git')) return null;
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (fichiers.length >= MAX_FICHIERS) { etat.tronqueFichiers = true; return null; }
  let abs = racine;
  let statut;
  try {
    for (const segment of segments) {
      abs = path.join(abs, segment);
      statut = fs.lstatSync(abs);
      if (statut.isSymbolicLink()) return null;
    }
  } catch { return null; }
  if (!statut.isFile()) return null;
  const f = fiche(racine, abs, etat);
  if (!f) return null;
  f.dossierExclu = true;
  fichiers.push(f);
  parChemin.set(rel, f);
  return f;
}

/** Un module JavaScript que le navigateur peut charger par une adresse d'import map. */
const MODULE_JS = /\.(?:m?js|cjs)$/i;

/** Entrées de dossier que le listeur lit au plus, dossiers exclus compris : au-delà, l'inventaire se dit tronqué. */
const MAX_ENTREES_LISTEES = 100_000;

/**
 * Résolutions d'adresse de worker (une adresse, sous une page d'entrée) qu'une
 * fermeture fait au plus : au-delà, la surface se dit tronquée. Le coût est
 * celui des adresses distinctes par les pages d'entrée de dossiers distincts,
 * un produit qu'un dépôt hostile rend énorme (10 000 pages, 100 000 adresses) ;
 * ce plafond en fait quelques secondes, une seule fois par audit.
 */
const MAX_RESOLUTIONS = 2_000_000;

/**
 * Ce qui a tronqué l'inventaire, une phrase par plafond atteint : le rapport
 * (Markdown, ligne de commande) les dit tels quels.
 * @param {{fichiers:boolean, octets:boolean, listage:boolean, surface:boolean, maxFichiers:number, maxOctets:number, maxEntreesListees:number, maxResolutions:number}} tronque
 * @returns {string[]}
 */
export function raisonsDeTroncature(tronque) {
  const raisons = [];
  if (tronque.fichiers) raisons.push(`plus de ${tronque.maxFichiers} fichiers`);
  if (tronque.octets) raisons.push(`plus de ${Math.round(tronque.maxOctets / 1024 / 1024)} Mio de contenu lu`);
  if (tronque.listage) raisons.push(`plus de ${tronque.maxEntreesListees} entrées lues dans les dossiers exclus pour suivre une adresse d'import map ou un import() à début fixe`);
  if (tronque.surface) raisons.push(`plus de ${tronque.maxResolutions} résolutions d'adresses de worker sous les pages d'entrée : la surface n'est pas complète`);
  return raisons;
}

/**
 * Le listeur de modules : `(prefixe) => chemins`, pour une adresse d'import map
 * qui finit par `/` (`"lib/": "./libs/"` fait de `import 'lib/x.js'` le
 * fichier `libs/x.js`, sans qu'aucune page ni aucun import ne le nomme). Il
 * rend les modules JavaScript de l'inventaire et ceux des dossiers exclus, par
 * leur chemin seul : un fichier ne s'ouvre que si la fermeture le atteint
 * (`trouver`). Les dossiers exclus se lisent une fois, au premier appel, dans
 * un budget de `maxEntrees` entrées ; au-delà, l'inventaire se dit tronqué (`etat.tronqueListage`).
 * Aucun lien n'est suivi, comme dans l'inventaire.
 * @returns {(prefixe: string) => string[]} les modules dont le chemin commence par `prefixe`, triés : `''` (tout le widget) ou un dossier qui finit par `/`
 */
export function nouveauListeur(racine, fichiers, etat, maxEntrees) {
  let modules = null;
  const construire = () => {
    const chemins = fichiers.filter((f) => !f.dossierExclu && MODULE_JS.test(f.chemin)).map((f) => f.chemin);
    let restant = maxEntrees;
    for (const exclu of etat.exclus) {
      const pile = [exclu];
      while (pile.length) {
        const rel = pile.pop();
        let lus;
        try { lus = fs.readdirSync(path.join(racine, rel), { withFileTypes: true }); } catch { continue; }
        for (const e of lus) {
          if (e.name === '.git') continue;
          if (--restant < 0) { etat.tronqueListage = true; return chemins.sort(); }
          // `Dirent` ne suit pas les liens : un lien n'est ni un dossier ni un fichier ici, il n'est ni lu ni suivi.
          if (e.isDirectory()) pile.push(`${rel}/${e.name}`);
          else if (e.isFile() && MODULE_JS.test(e.name)) chemins.push(`${rel}/${e.name}`);
        }
      }
    }
    return chemins.sort();
  };
  return (prefixe) => {
    modules ??= construire();
    // Les chemins qui commencent par `prefixe` forment une plage contiguë du tableau trié : deux recherches
    // dichotomiques la bornent, et la copier ne compare aucune chaîne. Les parcourir un à un avec `startsWith`
    // coûterait la longueur du préfixe par module, soit, pour des préfixes emboîtés (800 dossiers, 14 400 modules,
    // chemins de 2 400 caractères), 42 s au lieu de 2 s.
    let bas = 0;
    let haut = modules.length;
    while (bas < haut) {                                         // premier chemin qui n'est pas avant `prefixe`
      const milieu = (bas + haut) >> 1;
      if (modules[milieu] < prefixe) bas = milieu + 1; else haut = milieu;
    }
    let fin = modules.length;
    let debut = bas;
    while (debut < fin) {                                        // premier chemin, à partir de là, qui ne commence plus par `prefixe`
      const milieu = (debut + fin) >> 1;
      if (modules[milieu].startsWith(prefixe)) debut = milieu + 1; else fin = milieu;
    }
    return modules.slice(bas, fin);
  };
}

/** Points d'entrée : index.html, les HTML référencés par un manifest.json, sinon tout HTML racine. */
function trouverPointsDEntree(fichiers, manifestes, trouver) {
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
      if (trouver(cible)) entrees.add(cible);                    // un manifest peut désigner une page rangée dans un dossier exclu (`dist/`)
    }
  }
  if (!entrees.size && html.length) entrees.add(html.sort((a, b) => a.chemin.length - b.chemin.length)[0].chemin);
  return [...entrees];
}

/**
 * Le dossier qu'un `import()` à début fixe (`./locales/`) peut viser depuis le
 * fichier `rel` : `''` pour la racine du widget. Un dossier hors du widget
 * (`../x/`) ne préfixe aucun chemin de l'inventaire : rien n'en sort.
 */
function dossiersDepuis(rel, relatif) {
  return ecrituresDeChemin(relatif).map((ecrit) => {
    const dossier = path.posix.normalize(ecrit.startsWith('/') ? ecrit.slice(1) : path.posix.join(path.posix.dirname(rel), ecrit));
    return dossier === './' || dossier === '.' ? '' : dossier;
  });
}

/**
 * Un chemin de fichier tel qu'il est écrit, puis décodé (`%61pp.js` → `app.js`,
 * `a%20b.js` → `a b.js`) quand il se décode et que cela change quelque chose :
 * le serveur décode avant de chercher le fichier, et un chemin écrit pour que
 * l'audit ne le trouve pas est du code exécuté que personne n'a lu. Les deux
 * s'essaient, car dans le doute on inclut (un nom de fichier qui contient
 * vraiment `%61` n'est atteint par aucun des deux qu'à cette condition).
 */
function ecrituresDeChemin(chemin) {
  try {
    const decode = decodeURIComponent(chemin);
    return decode === chemin ? [chemin] : [chemin, decode];
  } catch {
    return [chemin];                                             // ne se décode pas : le serveur ne sert que ce qui est écrit
  }
}

/**
 * Les contextes sous lesquels un fichier peut s'exécuter : chaque page d'entrée,
 * avec la `<base>` que voit son code (`baseFinale` pour ce qui tourne une fois la
 * page lue, `baseBrute` d'un script pour celui qui la précède). Une référence qui
 * s'adresse au document (`new Worker('w.js')`) s'y résout. Une adresse relative ne
 * dépend que du dossier de la page et de sa `<base>` : deux pages du même dossier
 * ne font qu'un contexte, le coût d'une référence suit les contextes, non les pages.
 * @returns {Array<{ entree: string, baseBrute: ?string }>}
 */
export function contextesDeDocument(entrees, trouver) {
  const contextes = [];
  const vus = new Set();
  for (const entree of entrees) {
    const bases = new Set([null]);                               // sans contenu lisible : la page elle-même
    const page = trouver(entree);
    if (page?.contenu) {
      const lue = lirePage(page.contenu);
      bases.clear();
      bases.add(lue.baseFinale);                                 // ce que voit le code qui tourne une fois la page lue
      for (const s of lue.scripts) bases.add(s.baseBrute);       // et ce que voit un script placé avant la `<base>`
    }
    for (const baseBrute of bases) {
      const cle = JSON.stringify([path.posix.dirname(entree), baseBrute]);
      if (!vus.has(cle)) { vus.add(cle); contextes.push({ entree, baseBrute }); }
    }
  }
  return contextes;
}

/**
 * `(adresse relative) => Set<chemin>` : les chemins du widget qu'une adresse
 * relative désigne sous chaque contexte (voir `contextesDeDocument`). Le résultat
 * d'une adresse se calcule une fois (le même `Set` est rendu ensuite) : un code
 * qui répète la même adresse ne coûte pas un parcours des contextes à chaque fois.
 * `budget` (`restant`, `epuise`) borne le nombre total de résolutions : une fois
 * épuisé, `epuise` est vrai et plus rien ne se résout.
 */
export function resolveurDeDocument(contextes, budget = { restant: Infinity, epuise: false }) {
  const connus = new Map();
  return (relative) => {
    let chemins = connus.get(relative);
    if (chemins) return chemins;
    chemins = new Set();
    for (const { entree, baseBrute } of contextes) {
      if (--budget.restant < 0) { budget.epuise = true; break; }   // au-delà, les adresses suivantes ne se résolvent plus : la surface se dit tronquée
      const chemin = cheminLocal(urlDe(relative, baseBrute, entree));
      if (chemin !== null) chemins.add(chemin);
    }
    connus.set(relative, chemins);
    return chemins;
  };
}

/**
 * Fermeture transitive des fichiers atteignables depuis les points d'entrée.
 * Volontairement tolérante : en cas de doute on inclut, un faux positif sur
 * la surface coûte moins cher qu'un angle mort de sécurité.
 *
 * Elle dit aussi ce qu'un constat sur un fichier doit préciser (`mentions`) :
 * un fichier que seuls des scripts d'un `<template>` chargent ne s'exécute
 * qu'une fois le gabarit cloné puis inséré, et un fichier que seul un
 * module lu par le standard charge n'est exécuté que par un navigateur qui le
 * suit. Un fichier atteint aussi par un chemin sans cette réserve n'en porte
 * aucune : ce qu'il contient s'exécute alors tout de suite.
 * @param {string[]} entrees
 * @param {(chemin: string) => object|null|undefined} trouver le fichier de l'inventaire à ce chemin (lu à la demande hors d'un dossier exclu)
 * @param {(prefixe: string) => string[]} lister les modules JavaScript sous un dossier (voir `nouveauListeur`), pour une adresse d'import map qui finit par `/` ou un `import()` à début fixe
 * @param {{ maxResolutions?: number }} [plafonds] le budget de résolutions d'adresse de worker (voir `MAX_RESOLUTIONS`)
 * @returns {{ surface: Set<string>, mentions: Map<string, string>, partiel: boolean }} `partiel` : le budget de résolutions est épuisé, la surface n'est pas complète
 */
export function calculerSurface(entrees, trouver, lister, { maxResolutions = MAX_RESOLUTIONS } = {}) {
  const budget = { restant: maxResolutions, epuise: false };
  let resoudreDocument = null;
  const cheminsDuDocument = (relative) => (resoudreDocument ??= resolveurDeDocument(contextesDeDocument(entrees, trouver), budget))(relative);
  /** Les chemins qu'une référence de fichier peut désigner, depuis le fichier `rel` ; rien pour une adresse qui sort du widget. */
  const ciblesDe = (ref, rel) => {
    const objet = typeof ref === 'object';
    const cibles = new Set();
    if (objet && ref.chemin !== undefined) cibles.add(ref.chemin);   // déjà résolue depuis la racine du widget (page HTML, `<base>` comprise)
    const relative = objet ? ref.documentRelatif : ref;
    if (relative === undefined || /^(https?:)?\/\//i.test(relative) || relative.startsWith('data:') || relative.startsWith('blob:')) return cibles;
    // `path.posix.*` ici aussi, même raison que dans trouverPointsDEntree().
    // Une adresse qui commence par `/` part de la racine du widget (comme dans une page), non du dossier du fichier.
    for (const chemin of ecrituresDeChemin(relative.split(/[?#]/)[0])) {
      cibles.add(path.posix.normalize(chemin.startsWith('/') ? chemin.slice(1) : path.posix.join(path.posix.dirname(rel), chemin)));
    }
    // Une référence qui s'adresse au document (`new Worker('w.js')`) se résout aussi contre la page qui charge le script.
    if (objet) for (const cheminDuDocument of cheminsDuDocument(relative)) cibles.add(cheminDuDocument);
    return cibles;
  };
  const aretesDe = new Map();                                    // chemin → [{ cible | dossier, gabarit, standard }], lues une fois
  const aretes = (rel) => {
    let liste = aretesDe.get(rel);
    if (liste) return liste;
    liste = [];
    for (const ref of referencesSortantes(trouver(rel))) {
      const objet = typeof ref === 'object';
      const gabarit = objet && Boolean(ref.dansTemplate);
      const standard = objet && Boolean(ref.seulementStandard);
      if (objet && ref.dossier !== undefined) liste.push({ dossier: ref.dossier, gabarit, standard });
      else if (objet && ref.dossierRelatif !== undefined) for (const dossier of dossiersDepuis(rel, ref.dossierRelatif)) liste.push({ dossier, gabarit, standard });
      else {
        for (const cible of ciblesDe(ref, rel)) {
          for (const candidat of [cible, `${cible}.js`, `${cible}.mjs`, path.posix.join(cible, 'index.js')]) {
            if (trouver(candidat)) liste.push({ cible: candidat, gabarit, standard });
          }
        }
      }
    }
    aretesDe.set(rel, liste);
    return liste;
  };
  /** Fichiers atteints depuis les entrées, sans emprunter les arêtes qui portent la réserve `evite` (`gabarit`, `standard`). Chaque chemin entre une fois dans la file et chaque dossier se lit une fois : la fermeture est linéaire en arêtes, quel que soit le nombre de fois qu'un même fichier ou un même dossier est nommé. */
  const atteints = (evite) => {
    const vus = new Set();
    const dossiersVus = new Set();
    const file = [...entrees];
    const mis = new Set(file);
    const mettre = (chemin) => { if (!mis.has(chemin)) { mis.add(chemin); file.push(chemin); } };
    for (let i = 0; i < file.length; i++) {
      const rel = file[i];
      const f = trouver(rel);
      if (!f || f.binaire) continue;
      vus.add(rel);
      for (const arete of aretes(rel)) {
        if (evite && arete[evite]) continue;
        if (arete.dossier === undefined) { mettre(arete.cible); continue; }
        if (dossiersVus.has(arete.dossier)) continue;            // un dossier ne se relit pas : ses modules sont déjà dans la file
        dossiersVus.add(arete.dossier);
        for (const chemin of lister(arete.dossier)) mettre(chemin);
      }
    }
    return vus;
  };
  const surface = atteints(null);
  const sansGabarit = atteints('gabarit');
  const sansStandard = atteints('standard');
  const mentions = new Map();
  for (const rel of surface) {
    const mention = mentionDe({ dansTemplate: !sansGabarit.has(rel), seulementStandard: !sansStandard.has(rel) });
    if (mention) mentions.set(rel, mention);
  }
  return { surface, mentions, partiel: budget.epuise };
}

const ALIAS_GLOBAL = '(?:(?:window|self|globalThis)\\.)?';
const NOM_WORKER = new RegExp(`^${ALIAS_GLOBAL}(?:Worker|SharedWorker)$`);
const NOM_URL = new RegExp(`^${ALIAS_GLOBAL}URL$`);
const NOM_ENREGISTREMENT = /(^|\.)serviceWorker\.register$/;
const NOM_MODULE_DE_WORKLET = /(^|\.)\w*[Ww]orklet\.addModule$/;

/**
 * Une référence de code qui s'adresse au document, non au fichier qui l'écrit :
 * `new Worker('w.js')`, `navigator.serviceWorker.register('sw.js')` et
 * `audioWorklet.addModule('m.js')` se résolvent contre l'adresse de base de la
 * page qui charge le script (sa `<base>` comprise), pas contre le dossier du
 * fichier où elles figurent. Le fichier peut être chargé par n'importe quelle
 * page : la fermeture essaie le dossier du fichier (un worker lancé depuis un
 * worker, `new URL('./w.js', import.meta.url)` d'un empaqueteur) et la base de
 * chaque page d'entrée.
 */
const relatifAuDocument = (valeur) => ({ documentRelatif: valeur });

/**
 * Références vers un worker, un service worker, un module de worklet ou un
 * sous-script de worker, à source locale résolvable statiquement, lues dans
 * l'AST. Un fichier de worker n'est référencé par aucun <script> ni import ES,
 * mais il est pleinement exécuté dans le navigateur de l'agent dès que le
 * constructeur tourne : sans ceci, son contenu (un `importScripts()` vers un
 * domaine externe, par exemple — voir C-EXFIL-01/02) n'entre jamais dans
 * `surface`. Couvre la forme directe (`new Worker('./w.js')`), celle que
 * produisent les empaqueteurs (`new Worker(new URL('./w.js', <base
 * quelconque>))`, Vite/Webpack 5 — la base n'est pas vérifiée : c'est le
 * premier argument, littéral ici par construction, qui reste local ou
 * devient une URL absolue morte, jamais autre chose, quelle qu'elle soit), et
 * un gabarit statique sans interpolation — jamais une expression calculée,
 * qu'aucune de ces formes syntaxiques ne couvre. Un alias global de tête
 * (`window.Worker`, `self.SharedWorker`, `globalThis.URL`) est reconnu au même
 * titre que la forme nue. `importScripts()` se résout contre l'adresse du
 * worker (le fichier même) et peut prendre plusieurs arguments (tous
 * chargés) : on les suit tous. Une URL absolue est écartée plus bas par le
 * même filtre que pour les autres références.
 */
const estImportMetaUrl = (n) => n?.type === 'MemberExpression' && !n.computed && n.property.name === 'url' && n.object.type === 'MetaProperty';

function referencesWorkerDansAst(n) {
  if (n.type === 'NewExpression' && NOM_WORKER.test(nomPointe(n.callee) ?? '')) {
    const arg = n.arguments[0];
    const direct = chaineLitterale(arg);
    if (direct !== null) return [relatifAuDocument(direct)];
    if (arg?.type === 'NewExpression' && NOM_URL.test(nomPointe(arg.callee) ?? '')) {
      const emballe = chaineLitterale(arg.arguments[0]);
      // `new URL('./w.js', import.meta.url)` : relative au module, exactement ; toute autre base (`document.baseURI`, aucune…), dans le doute, aussi au document.
      if (emballe !== null) return [estImportMetaUrl(arg.arguments[1]) ? emballe : relatifAuDocument(emballe)];
    }
  } else if (n.type === 'CallExpression') {
    const nom = nomPointe(n.callee) ?? '';
    if (/(^|\.)importScripts$/.test(nom)) return n.arguments.map((a) => chaineLitterale(a)).filter((v) => v !== null);
    if (NOM_ENREGISTREMENT.test(nom) || NOM_MODULE_DE_WORKLET.test(nom)) {
      const valeur = chaineLitterale(n.arguments[0]);
      if (valeur !== null) return [relatifAuDocument(valeur)];
    }
  }
  return [];
}

/**
 * Le même repérage par expressions régulières, pour le seul code qu'acorn ne
 * lit pas (TypeScript, JSX) : le doute inclut. Sur un code lu, un worker écrit
 * dans un commentaire ou dans une chaîne n'en est pas un, et le fichier qu'il
 * nomme n'est pas exécuté.
 */
function referencesWorkerParRegex(contenu) {
  const refs = [];
  for (const m of contenu.matchAll(new RegExp(`\\bnew\\s+${ALIAS_GLOBAL}(?:Worker|SharedWorker)\\s*\\(\\s*(?:["']([^"']+)["']|\`([^\`$]+)\`)`, 'g'))) refs.push(relatifAuDocument(m[1] ?? m[2]));
  for (const m of contenu.matchAll(new RegExp(`\\bnew\\s+${ALIAS_GLOBAL}(?:Worker|SharedWorker)\\s*\\(\\s*new\\s+${ALIAS_GLOBAL}URL\\s*\\(\\s*(?:["']([^"']+)["']|\`([^\`$]+)\`)\\s*[,)]`, 'g'))) refs.push(relatifAuDocument(m[1] ?? m[2]));
  for (const m of contenu.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
    for (const t of m[1].matchAll(/["']([^"']+)["']/g)) refs.push(t[1]);
  }
  for (const m of contenu.matchAll(/(?:^|[^\w$])(?:\w+\.)*(?:serviceWorker\.register|\w*[Ww]orklet\.addModule)\s*\(\s*["']([^"']+)["']/g)) refs.push(relatifAuDocument(m[1]));
  return refs;
}

/**
 * Le début fixe de la source d'un `import()` calculé : `./locales/` pour
 * `` `./locales/${l}.js` `` comme pour `'./locales/' + l + '.js'`.
 */
function debutFixeDeSource(n) {
  if (n?.type === 'TemplateLiteral') return n.quasis[0]?.value.cooked ?? '';
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'BinaryExpression' && n.operator === '+') return debutFixeDeSource(n.left);
  return '';
}

/**
 * Le dossier que désigne le début fixe d'un `import()` calculé (`./locales/`
 * pour `./locales/fr`), ou null quand ce début n'a pas la forme d'une adresse.
 * Seul le nom de fichier varie, comme dans le découpage de code des
 * empaqueteurs : tout module de ce dossier peut être celui qu'on charge, donc
 * tout module du dossier est audité (C-EXFIL-06 ne dit rien d'un tel
 * `import()` : il est local par construction).
 */
function dossierDeSourceCalculee(n) {
  return dossierDeDebut(debutFixeDeSource(n));
}

/** Le dossier d'un début fixe d'adresse (`./locales/fr` → `./locales/`), null quand ce début n'est pas une adresse (nom nu, ni `./`, ni `../`, ni `/`) ou ne nomme aucun dossier. */
function dossierDeDebut(debut) {
  const i = debut.lastIndexOf('/');
  return i >= 0 && /^(?:\.{1,2}\/|\/)/.test(debut) ? debut.slice(0, i + 1) : null;
}

/**
 * Références qu'un code JavaScript suit : `import` (avec ou sans liaison,
 * `import './app.js'` compris), `export … from`, `import()` à argument
 * littéral (chaîne ou gabarit sans interpolation) et workers, lus dans l'AST,
 * jamais dans un commentaire ni dans une chaîne. Un code qu'acorn ne lit pas
 * (TypeScript, JSX) se lit par expressions régulières : le doute inclut, une
 * entrée de trop dans la surface coûte moins qu'un angle mort.
 */
function referencesDeCode(source) {
  const ast = parser(source);
  const refs = [];
  const module = (valeur) => { if (estAdresseDeModule(valeur)) refs.push(valeur); };
  if (ast) {
    walk.full(ast, (n) => {
      if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || (n.type === 'ExportNamedDeclaration' && n.source)) {
        if (typeof n.source.value === 'string') module(n.source.value);
      } else if (n.type === 'ImportExpression') {
        const valeur = chaineLitterale(n.source);
        if (valeur !== null) module(valeur);
        else {
          const dossier = dossierDeSourceCalculee(n.source);
          if (dossier !== null) refs.push({ dossierRelatif: dossier });
        }
      } else {
        refs.push(...referencesWorkerDansAst(n));
      }
    });
  } else {
    for (const m of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) module(m[1]);
    for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) module(m[1]);
    for (const m of source.matchAll(/\bimport\s+["']([^"']+)["']/g)) module(m[1]);
    for (const m of source.matchAll(/\bimport\s*\(\s*(?:["']([^"']*)["']\s*\+|`([^`$]*)\$\{)/g)) {   // `import('./locales/' + l)` et son gabarit
      const dossier = dossierDeDebut(m[1] ?? m[2]);
      if (dossier !== null) refs.push({ dossierRelatif: dossier });
    }
    refs.push(...referencesWorkerParRegex(source));
  }
  return refs;
}

/**
 * Un spécificateur de module qui est une adresse : `./`, `../`, `/` ou une URL
 * absolue. Un nom nu (`import 'lodash'`) n'en est pas une : seule une import
 * map le résout (lue à part, `referencesSortantes`), et le fichier local du
 * même nom n'est jamais chargé à sa place.
 */
const estAdresseDeModule = (valeur) => urlDeCarte(valeur, null, '') !== null;

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
    // `reserves` : ce qu'un constat sur le fichier atteint doit préciser (voir `calculerSurface`).
    const local = (valeur, baseBrute, reserves = {}) => {
      const chemin = cheminLocal(urlDe(valeur, baseBrute, f.chemin));
      if (chemin !== null) refs.push({ chemin, ...reserves });
    };
    // Un dossier dont tout module peut être chargé (voir `dossierDeSourceCalculee`).
    const dossier = (valeur, baseBrute, reserves) => {
      const chemin = cheminLocal(urlDe(valeur, baseBrute, f.chemin));
      if (chemin !== null) refs.push({ dossier: chemin, ...reserves });
    };
    for (const s of scripts) {
      for (const ch of s.chargements) if (ch.execute) local(ch.valeur, s.baseBrute, { dansTemplate: s.dansTemplate, seulementStandard: ch.seulementStandard });
      if (s.unite) {
        // Un worker écrit en commentaire ou en gabarit n'y figure pas ; dans la page, tout se résout contre la base du document.
        const reserves = { dansTemplate: s.dansTemplate, seulementStandard: s.seulementStandard };
        for (const ref of referencesDeCode(s.texte)) {
          if (typeof ref === 'string') local(ref, s.baseBrute, reserves);
          else if (ref.dossierRelatif !== undefined) dossier(ref.dossierRelatif, s.baseBrute, reserves);
          else local(ref.documentRelatif, s.baseBrute, reserves);
        }
      }
    }
    for (const r of ressources) if (r.nom === 'link') { const href = r.attributs.get('href'); if (href != null) local(href, r.baseBrute, { dansTemplate: r.dansTemplate }); }
    // Une import map dit où se trouve chaque module que la page importe par un nom : ce qu'elle désigne en local est du code que le navigateur charge (un import nu n'a pas d'autre chemin), sans qu'aucun `<script src>` ni `import` de chemin le nomme.
    for (const e of extraireImportMaps(c)) {
      const chemin = cheminLocal(urlDeCarte(e.url, e.baseBrute, f.chemin));
      if (chemin === null) continue;
      const reserves = { dansTemplate: e.dansTemplate, seulementStandard: e.seulementStandard };
      // Une adresse qui finit par `/` est un préfixe (`"lib/": "./libs/"` : `import 'lib/x.js'` charge `libs/x.js`) : tout module du dossier peut être chargé.
      refs.push(chemin === '' || chemin.endsWith('/') ? { dossier: chemin, ...reserves } : { chemin, ...reserves });
    }
    // Le CSS écrit dans la page (`<style>`, attributs `style`, feuille `data:`) est lu comme le navigateur le lit, ses URL relatives résolues contre la base de la page.
    const budget = nouveauBudgetCss();
    for (const feuille of feuilles) for (const url of urlsDeFeuille(lireFeuille(feuille, budget))) local(url, feuille.baseBrute, { dansTemplate: feuille.modele });
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
  return /(^|\/)(vendor|libs?|third[-_]party|node_modules|assets\/js\/lib)\//i.test(f.chemin) ||
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
