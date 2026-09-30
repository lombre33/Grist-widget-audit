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
import { parser, chaineLitterale, nomPointe, extraireImportMaps, resolveurDeCartes, depassementDePile } from '../moteur/analyse-js.js';
import { lireFeuille, nouveauBudgetCss } from '../moteur/css.js';
import { numeroLigne } from '../moteur/lignes.js';

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
/**
 * Taille au-delà de laquelle un fichier de texte n'est pas lu : il est alors dit non lu (`nonLu`), jamais passé sous silence. Elle se
 * fixe à la mesure, non au jugé : lire un fichier coûte du temps et de la mémoire proportionnels à sa taille, et aucun paquet d'une cible
 * honnête ne doit buter sur elle. `scripts/mesurer-marges-plafonds.mjs` donne, pour des dépôts donnés, ce que chaque plafond leur coûte et
 * la marge qui reste.
 */
const MAX_OCTETS_FICHIER = 16 * 1024 * 1024;

/** Extensions considérées comme du code exécuté côté navigateur. */
const CODE_WEB = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.html', '.htm', '.css']);

/**
 * @param {string} racine chemin absolu du dépôt audité
 * @param {{ maxEntreesListees?: number, maxResolutions?: number, maxPasDocuments?: number, maxFichiers?: number, maxOctetsCumules?: number, maxOctetsFichier?: number }} [plafonds] `maxEntreesListees` : les entrées de dossier que la lecture d'un préfixe d'import map peut parcourir (`MAX_ENTREES_LISTEES` par défaut) ; `maxResolutions` : les résolutions d'adresse de worker sous une page d'entrée que la fermeture peut faire (`MAX_RESOLUTIONS`) ; `maxPasDocuments` : les arêtes de document (`MAX_PAS_DOCUMENTS`) ; `maxFichiers` : les fichiers inventoriés (`MAX_FICHIERS`) ; `maxOctetsCumules` : les octets de texte lus en tout (`MAX_OCTETS_LUS_CUMULES`) ; `maxOctetsFichier` : la taille au-delà de laquelle un fichier n'est pas lu (`MAX_OCTETS_FICHIER`). Seuls les essais les changent.
 * @returns {{racine:string, fichiers:Array, entrees:Array, surface:Set<string>, paquet:object|null, manifestes:Array, tronque:?object, nonLus:Array<{chemin:string, taille:number, cause:'taille'|'cumul'|'lecture'|'extension', code:boolean, commeCode:boolean, atteint:boolean, dossierExclu:boolean}>, plafonds:{octets:number, octetsFichier:number}}} `tronque` : ce qui a tronqué l'inventaire (null si rien), relu à chaque lecture parce que le budget des arêtes de document ne s'épuise qu'une fois les règles lancées ; `nonLus` : les fichiers que l'outil n'a pas lus, avec la cause (`code` : du code, ou chargé comme du code ; `commeCode` : une page le charge comme du code ; `atteint` : une page le charge, d'une façon ou d'une autre) ; `plafonds` : le plafond d'octets lus en tout et celui d'un fichier, que les constats des fichiers non lus disent.
 */
export function construireContexte(racine, { maxEntreesListees = MAX_ENTREES_LISTEES, maxResolutions = MAX_RESOLUTIONS, maxPasDocuments = MAX_PAS_DOCUMENTS, maxFichiers = MAX_FICHIERS, maxOctetsCumules = MAX_OCTETS_LUS_CUMULES, maxOctetsFichier = MAX_OCTETS_FICHIER } = {}) {
  const fichiers = [];
  const etat = { octetsLus: 0, tronqueFichiers: false, tronqueOctets: false, tronqueListage: false, exclus: [], maxFichiers, maxOctetsCumules, maxOctetsFichier };
  parcourir(racine, racine, fichiers, etat);

  const paquet = lireJson(path.join(racine, 'package.json'));
  const manifestes = fichiers
    .filter((f) => path.basename(f.chemin) === 'manifest.json')
    .map((f) => ({ chemin: f.chemin, contenu: lireJson(path.join(racine, f.chemin)) }))
    .filter((m) => m.contenu);

  const parChemin = new Map(fichiers.map((f) => [f.chemin, f]));
  const trouver = (chemin) => parChemin.get(chemin) ?? ouvrirHorsInventaire(racine, chemin, fichiers, parChemin, etat);
  const entrees = trouverPointsDEntree(fichiers, manifestes, trouver);
  const { surface, mentions, partiel, surfaceDuDocument, debutDeChargement, surfaceDesWorkers, pasDocuments, depenserPasDocuments, nonLusParCode, nonLusAtteints, designesCommeCode, documentsEpuises } = calculerSurface(entrees, trouver, nouveauListeur(racine, fichiers, etat, maxEntreesListees), { maxResolutions, maxPasDocuments });

  for (const f of fichiers) {
    f.executee = surface.has(f.chemin);
    const designe = designesCommeCode.get(f.chemin) ?? false;
    // Du JSON valide n'exécute rien, quelle que soit l'adresse qui le désigne : un objet ne se lit ni comme un module ni comme un script, une valeur seule n'a pas d'effet. Ce n'est pas du code que l'outil ne saurait pas lire.
    f.commeCode = designe && estJsonValide(f.contenu) ? false : designe;
    f.mention = mentions.get(f.chemin) ?? null;
    f.vendorise = estVendorise(f);
  }

  // Ce qui a tronqué l'inventaire, relu à chaque demande : le budget des résolutions d'adresse et celui des arêtes de document
  // peuvent s'épuiser après la construction (une règle qui évalue une page), et le rapport doit alors le dire.
  const calculerTronque = () => (etat.tronqueFichiers || etat.tronqueOctets || etat.tronqueListage || partiel || documentsEpuises())
    ? { fichiers: etat.tronqueFichiers, octets: etat.tronqueOctets, listage: etat.tronqueListage, surface: partiel, documents: documentsEpuises(), maxFichiers, maxOctets: maxOctetsCumules, maxEntreesListees, maxResolutions, maxPasDocuments }
    : null;

  // Les fichiers que l'outil n'a pas lus, avec la cause : un fichier trop gros, le plafond cumulé atteint, une lecture qui a
  // échoué, ou une extension de binaire qu'un chargement de code désigne. Dits par C-SURFACE-02, jamais passés sous silence.
  const nonLus = [];
  for (const f of fichiers) {
    const commeCode = nonLusParCode.has(f.chemin);
    const atteint = nonLusAtteints.has(f.chemin);
    if (f.nonLu) nonLus.push({ chemin: f.chemin, taille: f.taille, cause: f.nonLu.cause, code: f.code || commeCode, commeCode, atteint, dossierExclu: Boolean(f.dossierExclu) });
    else if (commeCode) nonLus.push({ chemin: f.chemin, taille: f.taille, cause: 'extension', code: true, commeCode, atteint, dossierExclu: Boolean(f.dossierExclu) });
  }

  // Figé ICI, avant qu'aucune règle ne tourne : `preparerCodeExecuteEnChaine`
  // (axe C) ajoute ensuite à `fichiers` un fichier synthétique par contenu
  // littéral exécuté en chaîne (eval/Function/setTimeout/Worker), pour que
  // chaque règle qui lit `ctx.fichiers` l'audite sans code spécial. Ce
  // compte-ci reste celui du DÉPÔT tel qu'il existe sur disque, pour que
  // l'inventaire affiché au lecteur ne varie pas selon qu'un widget cache ou
  // non du code dans une chaîne.
  const fichiersReels = fichiers.length;

  const plafonds = { octets: maxOctetsCumules, octetsFichier: maxOctetsFichier };
  return { racine, fichiers, entrees, surface, surfaceDuDocument, debutDeChargement, surfaceDesWorkers, pasDocuments, depenserPasDocuments, paquet, manifestes, get tronque() { return calculerTronque(); }, fichiersReels, nonLus, plafonds };
}

/** Vrai si le texte est du JSON valide (un objet, un tableau, une chaîne, un nombre, `true`, `false` ou `null`). */
function estJsonValide(texte) {
  try { JSON.parse(texte); return true; } catch { return false; }
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
    if (acc.length >= (etat.maxFichiers ?? MAX_FICHIERS)) { etat.tronqueFichiers = true; return; }
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
  try { taille = fs.statSync(abs).size; } catch {
    // Un fichier dont la taille ne se lit pas n'est ni lu ni tu : la fiche le dit non lu (`lecture`), sa taille est inconnue (0). Un binaire que rien ne lit n'a rien à dire.
    if (BINAIRES.has(ext)) return null;
    return { chemin: rel, ext, taille: 0, binaire: true, code: CODE_WEB.has(ext), executee: false, nonLu: { cause: 'lecture' } };
  }
  const maxFichier = etat.maxOctetsFichier ?? MAX_OCTETS_FICHIER;
  const binaire = BINAIRES.has(ext) || taille > maxFichier;
  const f = { chemin: rel, ext, taille, binaire, code: CODE_WEB.has(ext), executee: false };
  // Un fichier que l'outil ne lit pas alors que rien ne dit qu'il n'est pas du texte (une extension de binaire le dit) : `nonLu`
  // en donne la cause, et le rapport le nomme (C-SURFACE-02). `binaire` reste vrai pour le reste de l'outil : aucune règle ne le lit.
  if (taille > maxFichier && !BINAIRES.has(ext)) f.nonLu = { cause: 'taille' };
  if (!binaire) {
    if (etat.octetsLus + taille > (etat.maxOctetsCumules ?? MAX_OCTETS_LUS_CUMULES)) {
      // Plafond cumulé atteint : on garde l'entrée (taille, extension) pour
      // l'inventaire et les axes qui n'ont pas besoin du contenu, mais on
      // n'en lit pas le texte en mémoire — au même titre qu'un fichier
      // binaire pour le reste de l'outil (voir `f.binaire`).
      etat.tronqueOctets = true;
      f.binaire = true;
      f.contenuTronque = true;
      f.nonLu = { cause: 'cumul' };
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
      } catch { f.binaire = true; f.nonLu = { cause: 'lecture' }; }
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
  // Le plafond ne se dit atteint que pour un fichier qui existe et qu'il empêche d'ouvrir : l'inventaire pleine tête cherche aussi des
  // candidats qui n'existent pas (`x.js.mjs`), et n'en est pas tronqué.
  if (fichiers.length >= (etat.maxFichiers ?? MAX_FICHIERS)) { etat.tronqueFichiers = true; return null; }
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
 * Pas que l'analyse de document fait au plus, toutes pages confondues : les arêtes que les graphes de document (`surfaceDuDocument`) parcourent, et les pages qu'une règle évalue pour un chargement de code distant (`depenserPasDocuments`). Un dépôt hostile qui multiplie les pages par un graphe commun, ou par des milliers d'imports, ferait sinon un produit (pages × modules, sans borne). Le plafond en fait quelques secondes au pire (`scripts/chronometrer-pieges.mjs` le mesure : les entrées « pages d'entrée × un graphe partagé » et « modules qui importent chacun la même adresse distante »). Au-delà, le chargeur est inconnu : rien n'est dit protégé, et la raison le dit.
 */
const MAX_PAS_DOCUMENTS = 2_000_000;

/** Les plafonds par défaut de l'inventaire, tels que l'outil les applique : les essais et la mesure des marges les lisent ici plutôt que de les recopier. */
export const PLAFONDS = Object.freeze({
  fichiers: MAX_FICHIERS,
  octets: MAX_OCTETS_LUS_CUMULES,
  octetsFichier: MAX_OCTETS_FICHIER,
  entreesListees: MAX_ENTREES_LISTEES,
  resolutions: MAX_RESOLUTIONS,
  pasDocuments: MAX_PAS_DOCUMENTS,
});

/**
 * Ce qui a tronqué l'inventaire, une phrase par plafond atteint : le rapport
 * (Markdown, ligne de commande) les dit tels quels.
 * @param {{fichiers:boolean, octets:boolean, listage:boolean, surface:boolean, documents?:boolean, maxFichiers:number, maxOctets:number, maxEntreesListees:number, maxResolutions:number, maxPasDocuments?:number}} tronque
 * @returns {string[]}
 */
export function raisonsDeTroncature(tronque) {
  const raisons = [];
  if (tronque.fichiers) raisons.push(`plus de ${tronque.maxFichiers} fichiers`);
  if (tronque.octets) raisons.push(`plus de ${Math.round(tronque.maxOctets / 1024 / 1024)} Mio de contenu lu`);
  if (tronque.listage) raisons.push(`plus de ${tronque.maxEntreesListees} entrées lues dans les dossiers exclus pour suivre une adresse d'import map ou un import() à début fixe`);
  if (tronque.surface) raisons.push(`plus de ${tronque.maxResolutions} résolutions d'adresses de worker sous les pages d'entrée : la surface n'est pas complète`);
  if (tronque.documents) raisons.push(`plus de ${tronque.maxPasDocuments} pas d'analyse de document : ni l'ordre de chargement ni les noms que le code importe ne sont établis pour toutes les pages`);
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
 * @param {{ maxResolutions?: number, maxPasDocuments?: number }} [plafonds] le budget de résolutions d'adresse de worker (voir `MAX_RESOLUTIONS`) et celui des arêtes que les graphes de document parcourent (voir `MAX_PAS_DOCUMENTS`)
 * @returns {{ surface: Set<string>, mentions: Map<string, string>, partiel: boolean, surfaceDuDocument: (page: string) => ?Set<string>, debutDeChargement: (page: string, chemin: string) => ?number, surfaceDesWorkers: () => Set<string>, pasDocuments: () => number, depenserPasDocuments: (pas: number) => boolean }} `partiel` : le budget de résolutions est épuisé, la surface n'est pas complète ; `surfaceDuDocument(page)` : les fichiers que le document de cette page charge dans son propre contexte (null : budget d'arêtes épuisé) ; `debutDeChargement(page, chemin)` : le décalage, dans la page, de la première balise qui mène à ce fichier (`Infinity` : aucune balise ne le charge d'elle-même ; null : la page ne le charge pas, ou le budget d'arêtes est épuisé) ; `surfaceDesWorkers()` : ceux que des workers exécutent, avec ce qu'ils importent ; `pasDocuments()` : les pas que l'analyse de document a faits jusqu'ici, arêtes parcourues par les graphes et pages évaluées pour un chargement (à comparer à `maxPasDocuments`) ; `depenserPasDocuments(pas)` : en fait de nouveaux, faux quand le budget n'y suffit plus
 */
export function calculerSurface(entrees, trouver, lister, { maxResolutions = MAX_RESOLUTIONS, maxPasDocuments = MAX_PAS_DOCUMENTS } = {}) {
  const budget = { restant: maxResolutions, epuise: false };
  // Le budget des pas d'analyse de document : les arêtes que les graphes de document parcourent, et les noms qu'une carte d'import résout (`atteints`).
  const budgetDocuments = { restant: maxPasDocuments };
  // Un pas de plus que l'analyse de document veut faire (une page évaluée pour un chargement) : faux quand il n'en reste plus, et le budget reste épuisé.
  const depenserPasDocuments = (pas) => (budgetDocuments.restant -= pas) >= 0;
  let resoudreDocument = null;
  const cheminsDuDocument = (relative) => (resoudreDocument ??= resolveurDeDocument(contextesDeDocument(entrees, trouver), budget))(relative);
  /** Les chemins qu'une référence de fichier peut désigner, depuis le fichier `rel` ; rien pour une adresse qui sort du widget. */
  const ciblesDe = (ref, rel) => {
    const objet = typeof ref === 'object';
    const cibles = new Set();
    if (objet && ref.chemin !== undefined) cibles.add(ref.chemin);   // déjà résolue depuis la racine du widget (page HTML, `<base>` comprise)
    const relative = objet ? (ref.documentRelatif ?? ref.relatif) : ref;
    if (relative === undefined || /^(https?:)?\/\//i.test(relative) || relative.startsWith('data:') || relative.startsWith('blob:')) return cibles;
    // `path.posix.*` ici aussi, même raison que dans trouverPointsDEntree().
    // Une adresse qui commence par `/` part de la racine du widget (comme dans une page), non du dossier du fichier.
    for (const chemin of ecrituresDeChemin(relative.split(/[?#]/)[0])) {
      cibles.add(path.posix.normalize(chemin.startsWith('/') ? chemin.slice(1) : path.posix.join(path.posix.dirname(rel), chemin)));
    }
    // Une référence qui s'adresse au document (`new Worker('w.js')`) se résout aussi contre la page qui charge le script.
    if (objet && ref.documentRelatif !== undefined) for (const cheminDuDocument of cheminsDuDocument(relative)) cibles.add(cheminDuDocument);
    return cibles;
  };
  const aretesDe = new Map();                                    // chemin → [{ cible | dossier, gabarit, standard, worker, position }], lues une fois
  /** Les arêtes d'un fichier. `commeCode` : une adresse écrite le désigne comme du code (`true`), ou une carte d'import peut le faire (`'probable'`) : ses références se lisent alors comme celles d'un code, quelle que soit son extension. */
  const aretes = (rel, commeCode = false) => {
    const cle = commeCode ? `${rel}\0${commeCode}` : rel;
    let liste = aretesDe.get(cle);
    if (liste) return liste;
    liste = [];
    const refs = referencesSortantes(trouver(rel), commeCode);
    liste.specificateurs = refs.specificateurs;                  // ce que le code importe : une carte d'import le résout (voir `atteints`)
    for (const ref of refs) {
      const objet = typeof ref === 'object';
      const gabarit = objet && Boolean(ref.dansTemplate);
      const standard = objet && Boolean(ref.seulementStandard);
      const worker = objet && Boolean(ref.worker);
      const position = objet ? ref.position : undefined;
      const commeCodeArete = objet && Boolean(ref.commeCode);        // un chargement de code (script, import, worker, carte d'import), non un `<link>` ni une URL de feuille de style
      const ambigu = objet && Boolean(ref.ambigu);                   // une carte d'import : ce qu'elle désigne n'est du code que si un import sans type de données l'emploie
      if (objet && ref.dossier !== undefined) liste.push({ dossier: ref.dossier, gabarit, standard, worker, position });
      else if (objet && ref.dossierRelatif !== undefined) for (const dossier of dossiersDepuis(rel, ref.dossierRelatif)) liste.push({ dossier, gabarit, standard, worker, position });
      else {
        for (const cible of ciblesDe(ref, rel)) {
          for (const candidat of [cible, `${cible}.js`, `${cible}.mjs`, path.posix.join(cible, 'index.js')]) {
            if (trouver(candidat)) liste.push({ cible: candidat, gabarit, standard, worker, position, commeCode: commeCodeArete, ambigu });
          }
        }
      }
    }
    aretesDe.set(cle, liste);
    return liste;
  };
  const resolveursDePages = new Map();                           // page, sans quelle réserve → son résolveur de cartes d'import (null : aucune carte que Chromium applique)
  const resolveurDePage = (rel, f, evite) => {
    const cle = `${rel}\0${evite ?? ''}`;
    if (!resolveursDePages.has(cle)) resolveursDePages.set(cle, f.contenu ? resolveurDeCartes(f.contenu, rel, evite) : null);
    return resolveursDePages.get(cle);
  };
  /** Fichiers atteints depuis `departs` (les entrées par défaut), sans emprunter les arêtes qui portent la réserve `evite` (`gabarit`, `standard`). Chaque chemin entre une fois dans la file et chaque dossier se lit une fois : la fermeture est linéaire en arêtes, quel que soit le nombre de fois qu'un même fichier ou un même dossier est nommé. */
  const atteints = (evite, departs = entrees, nonLus = null) => {
    const vus = new Set();
    const dossiersVus = new Set();
    const file = [...departs];
    const mis = new Set(file);
    const code = new Set(file);                                  // atteints par un chargement de code : un point d'entrée est chargé comme une page
    // Désignés par leur adresse par un chargement de code (balise script, import, worker : `true` ; carte d'import : `'probable'`) :
    // le navigateur en exécute le texte quelle que soit l'extension, l'audit le lit comme du code (`unitesJs`). Un dossier listé pour
    // un import() à début fixe ne désigne aucun fichier en particulier : il n'en fait pas du code lisible, seulement du code atteint.
    const designes = new Map();
    const parcourusComme = new Map();                            // chemin → comment ses références ont été lues (`false`, `'probable'`, `true`)
    const rang = (designe) => (designe === true ? 2 : designe === 'probable' ? 1 : 0);
    const mettre = (chemin, commeCode, designe = false) => {
      if (commeCode) code.add(chemin);
      if (commeCode && designe && rang(designe) > rang(designes.get(chemin))) designes.set(chemin, designe);
      if (!mis.has(chemin)) { mis.add(chemin); file.push(chemin); }
      // Déjà parcouru avant qu'une adresse le désigne (ou le désigne plus sûrement) comme du code : ses références de code n'ont pas été lues, il repasse.
      else if (vus.has(chemin) && rang(designes.get(chemin)) > rang(parcourusComme.get(chemin))) file.push(chemin);
    };
    const binaires = [];                                         // ce que la file atteint et que l'outil ne lit pas
    // Un nom que du code lu importe (`import 'lib'`) mène, par la carte d'import d'une page, à un fichier : c'est du code pour le navigateur quelle que
    // soit son extension, sauf un import de données (`with { type: 'css' }`). Chaque couple (nom importé, carte) se résout une fois, quel que soit
    // l'ordre où la file rencontre la page et le code qui importe : l'un et l'autre s'ajoutent à ce que l'autre a déjà vu.
    const cartes = [];                                           // les pages atteintes dont une carte d'import résout des noms : { page, resolveur }
    const pagesAvecCarte = new Set();
    const noms = [];                                             // ce que le code atteint et lu importe (voir `referencesSortantes`)
    const nomsVus = new Set();
    const appliquer = (carte, nom) => {
      if (nom.donnees || (evite && nom[evite]) || (nom.page !== null && nom.page !== carte.page)) return;   // un script inline n'a que la carte de sa page
      if (!depenserPasDocuments(1 + carte.resolveur.taille)) return;      // plafond : C-SURFACE-01 le dit, le nom ne désigne rien
      for (const url of carte.resolveur.resoudre(nom.specificateur, nom)) {
        const chemin = cheminLocal(url);
        if (chemin === null) continue;
        for (const candidat of [chemin, `${chemin}.js`, `${chemin}.mjs`, path.posix.join(chemin, 'index.js')]) if (trouver(candidat)) mettre(candidat, true, true);
      }
    };
    for (let i = 0; i < file.length; i++) {
      const rel = file[i];
      const f = trouver(rel);
      if (!f) continue;
      if (f.binaire) { if (nonLus) binaires.push(rel); continue; }
      vus.add(rel);
      const comme = designes.get(rel) ?? false;
      parcourusComme.set(rel, comme);
      const liste = aretes(rel, comme);
      if (['.html', '.htm'].includes(f.ext) && !pagesAvecCarte.has(rel)) {
        const resolveur = resolveurDePage(rel, f, evite);
        if (resolveur) {
          pagesAvecCarte.add(rel);
          const carte = { page: rel, resolveur };
          cartes.push(carte);
          for (const nom of noms) appliquer(carte, nom);
        }
      }
      for (const nom of liste.specificateurs) {
        const cle = `${nom.chemin}\0${nom.page ?? ''}\0${nom.baseBrute ?? ''}\0${nom.donnees ? 1 : 0}\0${nom.specificateur}`;
        if (nomsVus.has(cle)) continue;
        nomsVus.add(cle);
        noms.push(nom);
        for (const carte of cartes) appliquer(carte, nom);
      }
      for (const arete of liste) {
        if (evite && arete[evite]) continue;
        if (arete.dossier === undefined) { mettre(arete.cible, arete.commeCode, arete.commeCode ? (arete.ambigu ? 'probable' : true) : false); continue; }
        if (dossiersVus.has(arete.dossier)) continue;            // un dossier ne se relit pas : ses modules sont déjà dans la file
        dossiersVus.add(arete.dossier);
        for (const chemin of lister(arete.dossier)) mettre(chemin, true);
      }
    }
    if (nonLus) nonLus.designes = designes;
    // Un fichier que l'outil ne lit pas (une extension de binaire, un fichier trop gros) et qu'une page atteint : `atteints` les
    // nomme tous, `parCode` ceux qu'un chargement de code désigne (le navigateur les charge comme du code, personne ne les a lus).
    // Relevé une fois la file vidée : un fichier peut être atteint par un chargement de code après avoir été écarté une première fois.
    for (const rel of binaires) {
      nonLus.atteints.add(rel);
      if (code.has(rel)) nonLus.parCode.add(rel);
    }
    return vus;
  };
  const relevesNonLus = { atteints: new Set(), parCode: new Set(), designes: new Map() };
  const surface = atteints(null, entrees, relevesNonLus);
  const sansGabarit = atteints('gabarit');
  const sansStandard = atteints('standard');
  // Ce que le document d'une page charge dans son propre contexte, pour une règle qui doit savoir de quelle import map un module dépend : ni ce que ses workers exécutent (Chromium 141 n'applique jamais l'import map de la page, ni la clé `integrity`, à un worker), ni ce que charge une autre page HTML. À la demande, une fois par page, dans un budget d'arêtes commun ; null quand il est épuisé (l'appelant compte alors la page comme chargeur, il ne blanchit rien).
  // Chaque fichier porte le décalage de la PREMIÈRE balise de la page qui mène à lui : une empreinte d'import map ne protège que les chargements qui commencent après la carte (mesuré dans Chromium 141 : un module placé avant la carte et lu avant elle, page livrée en deux morceaux, s'exécute malgré l'empreinte). Les balises se suivent dans l'ordre du document, chacune ne visite que ce que les précédentes n'ont pas atteint : la fermeture reste linéaire. Une arête sans position (`<link>`, feuille) mène au bout de la file (`Infinity`) : elle ne charge aucun module qu'une empreinte protège.
  const parcourirDocument = (page) => {
    const racine = trouver(page);
    const positions = new Map();
    if (!racine || racine.binaire) return positions;
    const vus = new Set([page]);
    const dossiersVus = new Set();
    if ((budgetDocuments.restant -= aretes(page).length + 1) < 0) return null;
    const departs = aretes(page).filter((arete) => !arete.worker).sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
    for (const depart of departs) {
      const position = depart.position ?? Infinity;
      const file = [];
      const mettre = (chemin) => {
        if (vus.has(chemin)) return;
        vus.add(chemin);
        const f = trouver(chemin);
        if (!f || f.binaire) return;
        positions.set(chemin, position);
        file.push(chemin);
      };
      const lireDossier = (dossier) => {
        if (dossiersVus.has(dossier)) return;                    // un dossier ne se relit pas : ses modules sont déjà dans la file
        dossiersVus.add(dossier);
        for (const chemin of lister(dossier)) mettre(chemin);
      };
      if (depart.dossier === undefined) mettre(depart.cible); else lireDossier(depart.dossier);
      for (let i = 0; i < file.length; i++) {
        const rel = file[i];
        if (['.html', '.htm'].includes(trouver(rel).ext)) continue;   // une autre page : son document, ses cartes, son graphe
        if ((budgetDocuments.restant -= aretes(rel).length + 1) < 0) return null;
        for (const arete of aretes(rel)) {
          if (arete.worker) continue;
          if (arete.dossier === undefined) mettre(arete.cible); else lireDossier(arete.dossier);
        }
      }
    }
    return positions;
  };
  const positionsDeDocument = new Map();
  const positionsDuDocument = (page) => {
    if (!positionsDeDocument.has(page)) positionsDeDocument.set(page, parcourirDocument(page));
    return positionsDeDocument.get(page);
  };
  const surfacesDeDocument = new Map();
  const surfaceDuDocument = (page) => {
    if (!surfacesDeDocument.has(page)) {
      const positions = positionsDuDocument(page);
      surfacesDeDocument.set(page, positions === null ? null : new Set([page, ...positions.keys()]));
    }
    return surfacesDeDocument.get(page);
  };
  const debutDeChargement = (page, chemin) => positionsDuDocument(page)?.get(chemin) ?? null;
  // Ce que les workers exécutent, avec tout ce qu'ils importent : des contextes hors de tout document. Un fichier qui y figure n'hérite jamais de l'empreinte d'une page, même si une page le charge aussi.
  let desWorkers = null;
  const surfaceDesWorkers = () => (desWorkers ??= atteints(null, [...surface].flatMap((rel) => aretes(rel).filter((arete) => arete.worker).map((arete) => arete.cible))));
  const mentions = new Map();
  for (const rel of surface) {
    const mention = mentionDe({ dansTemplate: !sansGabarit.has(rel), seulementStandard: !sansStandard.has(rel) });
    if (mention) mentions.set(rel, mention);
  }
  const pasDocuments = () => maxPasDocuments - budgetDocuments.restant;
  return { surface, mentions, partiel: budget.epuise, surfaceDuDocument, debutDeChargement, surfaceDesWorkers, pasDocuments, depenserPasDocuments, nonLusParCode: relevesNonLus.parCode, nonLusAtteints: relevesNonLus.atteints, designesCommeCode: relevesNonLus.designes, documentsEpuises: () => budgetDocuments.restant < 0 };
}

const ALIAS_GLOBAL = '(?:(?:window|self|globalThis)\\.)?';
const NOM_WORKER = new RegExp(`^${ALIAS_GLOBAL}(?:Worker|SharedWorker)$`);
const NOM_URL = new RegExp(`^${ALIAS_GLOBAL}URL$`);
export const NOM_ENREGISTREMENT = /(^|\.)serviceWorker\.register$/;
export const NOM_MODULE_DE_WORKLET = /(^|\.)\w*[Ww]orklet\.addModule$/;

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
 * Une référence vers un fichier qu'un worker, un service worker ou un module de worklet exécute (`worker`) : hors de tout document, où Chromium 141 n'applique ni l'import map de la page ni la clé `integrity` (voir `surfaceDesWorkers`). Une référence en chaîne est relative au fichier qui l'écrit (`relatif`).
 */
const duWorker = (ref) => (typeof ref === 'object' ? { ...ref, worker: true } : { relatif: ref, worker: true });

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
    if (direct !== null) return [duWorker(relatifAuDocument(direct))];
    if (arg?.type === 'NewExpression' && NOM_URL.test(nomPointe(arg.callee) ?? '')) {
      const emballe = chaineLitterale(arg.arguments[0]);
      // `new URL('./w.js', import.meta.url)` : relative au module, exactement ; toute autre base (`document.baseURI`, aucune…), dans le doute, aussi au document.
      if (emballe !== null) return [duWorker(estImportMetaUrl(arg.arguments[1]) ? emballe : relatifAuDocument(emballe))];
    }
  } else if (n.type === 'CallExpression') {
    const nom = nomPointe(n.callee) ?? '';
    if (/(^|\.)importScripts$/.test(nom)) return n.arguments.map((a) => chaineLitterale(a)).filter((v) => v !== null).map(duWorker);
    if (NOM_ENREGISTREMENT.test(nom) || NOM_MODULE_DE_WORKLET.test(nom)) {
      const valeur = chaineLitterale(n.arguments[0]);
      if (valeur !== null) return [duWorker(relatifAuDocument(valeur))];
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
  for (const m of contenu.matchAll(new RegExp(`\\bnew\\s+${ALIAS_GLOBAL}(?:Worker|SharedWorker)\\s*\\(\\s*(?:["']([^"']+)["']|\`([^\`$]+)\`)`, 'g'))) refs.push(duWorker(relatifAuDocument(m[1] ?? m[2])));
  for (const m of contenu.matchAll(new RegExp(`\\bnew\\s+${ALIAS_GLOBAL}(?:Worker|SharedWorker)\\s*\\(\\s*new\\s+${ALIAS_GLOBAL}URL\\s*\\(\\s*(?:["']([^"']+)["']|\`([^\`$]+)\`)\\s*[,)]`, 'g'))) refs.push(duWorker(relatifAuDocument(m[1] ?? m[2])));
  for (const m of contenu.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
    for (const t of m[1].matchAll(/["']([^"']+)["']/g)) refs.push(duWorker(t[1]));
  }
  for (const m of contenu.matchAll(/(?:^|[^\w$])(?:\w+\.)*(?:serviceWorker\.register|\w*[Ww]orklet\.addModule)\s*\(\s*["']([^"']+)["']/g)) refs.push(duWorker(relatifAuDocument(m[1])));
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

/** Les types d'un import avec attributs (`with { type: 'json' }`) que le navigateur ne lit pas comme du JavaScript : des données, une feuille de style. */
const TYPES_D_IMPORT_DE_DONNEES = new Set(['json', 'css', 'bytes', 'text']);
const nomDeCle = (n) => n?.key?.name ?? n?.key?.value;
const proprieteDe = (objet, nom) => (objet?.type === 'ObjectExpression' ? objet.properties.find((p) => p.type === 'Property' && !p.computed && nomDeCle(p) === nom) : undefined);

/**
 * Vrai pour les attributs d'un import (la liste d'un `import … with { type: 'json' }`, ou l'objet d'options d'un `import()`) qui disent
 * que le module est de ce type : le navigateur le charge, ne l'exécute pas, et il ne se lit pas comme du code.
 */
function importDeDonnees(attributs) {
  if (Array.isArray(attributs)) return attributs.some((a) => nomDeCle(a) === 'type' && TYPES_D_IMPORT_DE_DONNEES.has(a.value?.value));
  const avec = proprieteDe(attributs, 'with') ?? proprieteDe(attributs, 'assert');
  const type = proprieteDe(avec?.value, 'type');
  return type?.value?.type === 'Literal' && TYPES_D_IMPORT_DE_DONNEES.has(type.value.value);
}

/**
 * Références qu'un code JavaScript suit : `import` (avec ou sans liaison,
 * `import './app.js'` compris), `export … from`, `import()` à argument
 * littéral (chaîne ou gabarit sans interpolation) et workers, lus dans l'AST,
 * jamais dans un commentaire ni dans une chaîne. Un code qu'acorn ne lit pas
 * (TypeScript, JSX) ou dont l'arbre déborde la pile du parcours se lit par
 * expressions régulières : le doute inclut, une entrée de trop dans la surface
 * coûte moins qu'un angle mort. Un import de données (`with { type: 'json' }`)
 * est une référence qui n'est pas un chargement de code (`commeCode: false`).
 * Le tableau rendu porte aussi `specificateurs` : chaque spécificateur que l'arbre
 * importe (nom nu compris, sans rien de plus), avec `donnees` pour un import de
 * données. Une lecture par expressions régulières n'en ajoute aucun : un texte de
 * commentaire ou de chaîne n'y est pas distingué d'un import, et aucun nom n'en désigne
 * un fichier. Un arbre que le parcours ne porte pas garde ceux qu'il a rencontrés avant
 * de déborder : ce sont de vrais imports.
 */
function referencesDeCode(source) {
  const ast = parser(source);
  let refs = [];
  let specificateurs = [];                                         // les noms et adresses que l'arbre importe, `donnees` pour un import de données : ce qu'une carte d'import résout (`calculerSurface`)
  const nommes = new Set();
  const nom = (specificateur, deDonnees) => {
    const cle = `${deDonnees ? 1 : 0}${specificateur}`;
    if (!nommes.has(cle)) { nommes.add(cle); specificateurs.push({ specificateur, donnees: deDonnees }); }
  };
  const module = (valeur) => { if (estAdresseDeModule(valeur)) refs.push(valeur); };
  const donnees = (valeur) => { if (estAdresseDeModule(valeur)) refs.push({ relatif: valeur, commeCode: false }); };
  const parExpressionsRegulieres = () => {
    refs = [];                                                     // lus par expressions régulières, les noms peuvent être dans un commentaire ou une chaîne : aucun n'est ajouté
    for (const m of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) module(m[1]);
    for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) module(m[1]);
    for (const m of source.matchAll(/\bimport\s+["']([^"']+)["']/g)) module(m[1]);
    for (const m of source.matchAll(/\bimport\s*\(\s*(?:["']([^"']*)["']\s*\+|`([^`$]*)\$\{)/g)) {   // `import('./locales/' + l)` et son gabarit
      const dossier = dossierDeDebut(m[1] ?? m[2]);
      if (dossier !== null) refs.push({ dossierRelatif: dossier });
    }
    refs.push(...referencesWorkerParRegex(source));
  };
  if (ast) {
    try {
      walk.full(ast, (n) => {
        if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || (n.type === 'ExportNamedDeclaration' && n.source)) {
          if (typeof n.source.value === 'string') {
            const deDonnees = importDeDonnees(n.attributes);
            (deDonnees ? donnees : module)(n.source.value);
            nom(n.source.value, deDonnees);
          }
        } else if (n.type === 'ImportExpression') {
          const valeur = chaineLitterale(n.source);
          if (valeur !== null) {
            const deDonnees = importDeDonnees(n.options);
            (deDonnees ? donnees : module)(valeur);
            nom(valeur, deDonnees);
          } else {
            const dossier = dossierDeSourceCalculee(n.source);
            if (dossier !== null) refs.push({ dossierRelatif: dossier });
          }
        } else {
          refs.push(...referencesWorkerDansAst(n));
        }
      });
    } catch (e) {
      // Un arbre plus profond que la pile du parcours : le code est dit illisible quand les règles le parcourent (C-SURFACE-03) ; la surface, elle, se lit par expressions régulières.
      if (!depassementDePile(e)) throw e;
      parExpressionsRegulieres();
    }
  } else {
    parExpressionsRegulieres();
  }
  refs.specificateurs = specificateurs;
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
 * Le tableau rendu porte aussi `specificateurs` : ce que le code du fichier (ou de chaque script inline d'une page) importe, avec le référent
 * qui l'importe (`chemin`, `baseBrute`, `page` : la page dont c'est un script inline, null pour un fichier). Ce ne sont pas des arêtes :
 * une carte d'import les résout (`calculerSurface`).
 */
function referencesSortantes(f, commeCode = false) {
  const refs = [];
  const specificateurs = [];                                       // ce que le code de ce fichier importe, à résoudre par les cartes d'import (voir `referencesDeCode`)
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
    // `position` : le décalage, dans la page, de la balise qui mène au fichier (voir `debutDeChargement`).
    for (const s of scripts) {
      for (const ch of s.chargements) if (ch.execute) local(ch.valeur, s.baseBrute, { dansTemplate: s.dansTemplate, seulementStandard: ch.seulementStandard, position: s.debut, commeCode: true });
      if (s.unite) {
        // Un worker écrit en commentaire ou en gabarit n'y figure pas ; dans la page, tout se résout contre la base du document.
        const reserves = { dansTemplate: s.dansTemplate, seulementStandard: s.seulementStandard, position: s.debut, commeCode: true };
        const lues = referencesDeCode(s.texte);
        for (const specificateur of lues.specificateurs) specificateurs.push({ ...specificateur, chemin: f.chemin, baseBrute: s.baseBrute, page: f.chemin, gabarit: Boolean(s.dansTemplate), standard: Boolean(s.seulementStandard) });
        for (const ref of lues) {
          const propres = { ...reserves, ...(ref.worker ? { worker: true } : {}), ...(ref.commeCode === false ? { commeCode: false } : {}) };      // ce qu'un worker exécute est dit à la fermeture (`surfaceDesWorkers`) ; un import de données n'est pas un chargement de code
          if (typeof ref === 'string') local(ref, s.baseBrute, reserves);
          else if (ref.dossierRelatif !== undefined) dossier(ref.dossierRelatif, s.baseBrute, propres);
          else local(ref.documentRelatif ?? ref.relatif, s.baseBrute, propres);
        }
      }
    }
    for (const r of ressources) if (r.nom === 'link') { const href = r.attributs.get('href'); if (href != null) local(href, r.baseBrute, { dansTemplate: r.dansTemplate }); }
    // Une import map dit où se trouve chaque module que la page importe par un nom : ce qu'elle désigne en local est du code que le navigateur charge (un import nu n'a pas d'autre chemin), sans qu'aucun `<script src>` ni `import` de chemin le nomme.
    for (const e of extraireImportMaps(c, f.chemin)) {
      const chemin = cheminLocal(urlDeCarte(e.url, e.baseBrute, f.chemin));
      if (chemin === null) continue;
      const reserves = { dansTemplate: e.dansTemplate, seulementStandard: e.seulementStandard, position: e.index, commeCode: true, ambigu: true };   // la carte se lit avant tout import par un nom : ce qu'elle désigne ne se charge pas avant elle
      // Une adresse qui finit par `/` est un préfixe (`"lib/": "./libs/"` : `import 'lib/x.js'` charge `libs/x.js`) : tout module du dossier peut être chargé.
      refs.push(chemin === '' || chemin.endsWith('/') ? { dossier: chemin, ...reserves } : { chemin, ...reserves });
    }
    // Le CSS écrit dans la page (`<style>`, attributs `style`, feuille `data:`) est lu comme le navigateur le lit, ses URL relatives résolues contre la base de la page.
    const budget = nouveauBudgetCss();
    for (const feuille of feuilles) for (const url of urlsDeFeuille(lireFeuille(feuille, budget))) local(url, feuille.baseBrute, { dansTemplate: feuille.modele });
  }
  if (f.ext === '.css') refs.push(...urlsDeFeuille(lireFeuille({ sorte: 'style', applique: true, precharge: false, modele: false, texte: c, mimeLibre: true, baseBrute: null })));
  // Ce que le code d'un fichier charge (import, import(), worker, importScripts) est du code : le chargement le marque `commeCode`, sauf un import de données (`with { type: 'json' }`).
  // Un fichier qu'une adresse écrite désigne comme du code a les références d'un code quelle que soit son extension ; désigné par une carte d'import seulement (`'probable'`),
  // il ne les a que s'il se lit comme du JavaScript : ce qu'une carte désigne peut être un module JSON ou CSS.
  if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(f.ext) || commeCode === true || (commeCode === 'probable' && parser(c))) {
    const lues = referencesDeCode(c);
    for (const specificateur of lues.specificateurs) specificateurs.push({ ...specificateur, chemin: f.chemin, baseBrute: null, page: null, gabarit: false, standard: false });
    refs.push(...lues.map((ref) => (typeof ref === 'string' ? { relatif: ref, commeCode: true } : { ...ref, commeCode: ref.commeCode ?? true })));
  }
  refs.specificateurs = specificateurs;
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
  return cheminVendorise(f.chemin) ||
    ((f.locSignificatives ?? 0) > 300 && (f.taille / Math.max(1, f.lignes.length)) > 200) ||
    ((f.locSignificatives ?? 0) > 300 && SIGNATURE_BUNDLEUR.test(f.contenu.slice(0, 5000)));
}

/**
 * La part de `estVendorise` que le chemin seul dit : un dossier de bibliothèques tierces ou un suffixe `.min.js`. Un fichier
 * que l'outil n'a pas lu n'a que son chemin pour dire s'il est à exempter des axes A et B (C-SURFACE-02).
 */
export function cheminVendorise(chemin) {
  return /(^|\/)(vendor|libs?|third[-_]party|node_modules|assets\/js\/lib)\//i.test(chemin) || /\.min\.js$/.test(chemin);
}

function lireJson(abs) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

/** Numéro de ligne (1-based) d'un décalage caractère. */
export function ligneDe(contenu, index) {
  return numeroLigne(contenu, index);
}
