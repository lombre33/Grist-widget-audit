#!/usr/bin/env node
/**
 * Rejoue les mutants du correctif « surface et chargements » (méthode :
 * `scripts/lib/rejouer-mutants.mjs`). Chaque mutant réintroduit UN défaut :
 *   - la surface : dossiers exclus suivis quand la page y mène, gardes
 *     d'ouverture (`.git`, `..`, segments vides, liens, non-fichiers),
 *     fiche unique, réserves de gabarit et de standard propagées aux fichiers
 *     atteints, adresses de modules (nom nu, `/` racine), workers lus dans
 *     l'AST puis par expressions régulières quand le code ne se parse pas ;
 *   - l'exemption de code vendorisé, qui ne vaut que pour A et B ;
 *   - les chargements de code (import statique, `export … from`, `import()`),
 *     leurs textes ; C-XSS-04 typé par la propriété de `location` ; la CSP en
 *     balise que Chromium n'applique pas.
 * Aucun navigateur n'est requis.
 *
 * Usage : node scripts/mutants-surface-code.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const I = 'src/contexte/inventaire.js';
const J = 'src/moteur/analyse-js.js';
const P = 'src/moteur/page-html.js';
const S = 'src/regles/c-securite.js';
const QA = 'src/regles/a-qualite.js';
const QB = 'src/regles/b-lisibilite.js';
const H = 'src/rapport/html.js';
const M = 'src/rapport/markdown.js';
const TESTS = ['tests/surface-code-charge.test.mjs', 'tests/surface-references.test.mjs', 'tests/inventaire-repli-workers.test.mjs'];
// Les essais de la file de la fermeture, dont la recherche d'un fichier est bornée par un nombre d'appels : un mutant qui fait boucler la file y est tué par une assertion, en quelques secondes.
const TESTS_BORNES = ['tests/surface-fermeture.test.mjs'];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [];

// --- les dossiers exclus et la manière de les ouvrir -------------------------------------------------------------
const EXCLUS = ['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', '__pycache__'];
const enTexte = (noms) => noms.map((n) => `'${n}'`).join(', ');
for (const nom of EXCLUS) {
  MUTANTS.push(dansLigne(I, 'const EXCLUS = new Set(', enTexte(EXCLUS), enTexte(EXCLUS.filter((n) => n !== nom)), `EXCLUS : ${nom} n'est plus un dossier exclu (l'inventaire le parcourt, la page ne l'ouvre plus à la demande)`));
}
MUTANTS.push(
  dansLigne(I, "segments.includes('.git')) return null;", " || segments.includes('.git')", '', 'ouverture : .git est suivi quand la page le nomme'),
  dansLigne(I, "s === '' || s === '.' || s === '..'", "s === '' || ", '', 'ouverture : un segment vide ouvre un fichier sous deux noms'),
  dansLigne(I, "s === '' || s === '.' || s === '..'", "s === '.' || ", '', 'ouverture : un segment « . » ouvre un fichier sous deux noms'),
  dansLigne(I, "s === '' || s === '.' || s === '..'", " || s === '..'", '', 'ouverture : un segment « .. » sort du dépôt'),
  dansLigne(I, "s === '' || s === '.' || s === '..'", "s === '' || s === '.' || s === '..'", "s === '' || s === '.'", 'ouverture : « .. » ouvre un fichier hors du widget'),
  dansLigne(I, 'if (statut.isSymbolicLink()) return null;', 'statut.isSymbolicLink()', 'false', 'ouverture : un lien symbolique est suivi'),
  dansLigne(I, 'if (!statut.isFile()) return null;', '!statut.isFile()', 'false', 'ouverture : un dossier est pris pour un fichier'),
  dansLigne(I, 'f.dossierExclu = true;', 'true', 'false', 'ouverture : le fichier n\'est plus marqué dossierExclu'),
  [I, '  fichiers.push(f);\n  parChemin.set(rel, f);', '  parChemin.set(rel, f);', 'ouverture : le fichier n\'entre pas dans l\'inventaire'],
  [I, '  fichiers.push(f);\n  parChemin.set(rel, f);', '  fichiers.push(f);', 'ouverture : le fichier est rouvert à chaque demande (doublons)'],
  dansLigne(I, 'const trouver = (chemin) =>', '?? ouvrirHorsInventaire(racine, chemin, fichiers, parChemin, etat)', '?? null', 'surface : rien n\'est ouvert hors de l\'inventaire'),
  dansLigne(I, 'if (trouver(cible)) entrees.add(cible);', 'trouver(cible)', 'fichiers.some((f) => f.chemin === cible)', 'manifest : une page rangée dans dist/ n\'est plus un point d\'entrée'),
);

// --- ce que la page dit d'un fichier qu'elle mène à charger ------------------------------------------------------
MUTANTS.push(
  dansLigne(I, 'f.mention = mentions.get(f.chemin)', 'mentions.get(f.chemin) ?? null', 'null', 'mention : jamais posée sur le fichier'),
  dansLigne(I, 'const gabarit = objet && Boolean(ref.dansTemplate);', 'Boolean(ref.dansTemplate)', 'false', 'mention : la réserve de gabarit d\'une arête est perdue'),
  dansLigne(I, 'const standard = objet && Boolean(ref.seulementStandard);', 'Boolean(ref.seulementStandard)', 'false', 'mention : la réserve de standard d\'une arête est perdue'),
  dansLigne(I, "const sansGabarit = atteints('gabarit');", "atteints('gabarit')", 'atteints(null)', 'mention : le parcours sans gabarit emprunte les arêtes de gabarit'),
  dansLigne(I, "const sansStandard = atteints('standard');", "atteints('standard')", 'atteints(null)', 'mention : le parcours sans standard emprunte les arêtes de standard'),
  dansLigne(I, 'if (evite && arete[evite]) continue;', 'evite && arete[evite]', 'false', 'mention : une arête à réserve est toujours empruntée'),
  dansLigne(I, 'const mention = mentionDe({ dansTemplate: !sansGabarit.has(rel)', '!sansGabarit.has(rel)', 'false', 'mention : le gabarit n\'est jamais dit'),
  dansLigne(I, 'const mention = mentionDe({ dansTemplate: !sansGabarit.has(rel)', '!sansStandard.has(rel)', 'false', 'mention : le standard seul n\'est jamais dit'),
  dansLigne(J, "return () => fichier.mention ?? null;", 'fichier.mention ?? null', 'null', 'mention : un fichier .js atteint par un gabarit ne le dit pas'),
  dansLigne(J, 'entrees.push({ spec, url, sri:', 'dansTemplate: s.dansTemplate', 'dansTemplate: false', 'import map : la réserve de gabarit de la carte est perdue'),
  dansLigne(J, 'entrees.push({ spec, url, sri:', 'seulementStandard: s.seulementStandard', 'seulementStandard: false', 'import map : la réserve de standard de la carte est perdue'),
  dansLigne(I, 'for (const ch of s.chargements) if (ch.execute)', 'dansTemplate: s.dansTemplate, ', '', 'script src : la réserve de gabarit est perdue'),
  dansLigne(I, 'for (const ch of s.chargements) if (ch.execute)', ', seulementStandard: ch.seulementStandard', '', 'script src : la réserve de standard est perdue'),
  dansLigne(I, 'const reserves = { dansTemplate: s.dansTemplate,', 'dansTemplate: s.dansTemplate', 'dansTemplate: false', 'module de la page : la réserve de gabarit est perdue'),
  dansLigne(I, 'const reserves = { dansTemplate: s.dansTemplate,', 'seulementStandard: s.seulementStandard', 'seulementStandard: false', 'module de la page : la réserve de standard est perdue'),
  dansLigne(I, "if (typeof ref === 'string') local(ref, s.baseBrute, reserves);", 's.baseBrute', 'null', 'module de la page : la <base> de la page est ignorée pour un chemin'),
  dansLigne(I, 'else if (ref.dossierRelatif !== undefined) dossier(ref.dossierRelatif, s.baseBrute, propres);', 's.baseBrute', 'null', 'page : la <base> est ignorée pour le dossier d\'un import() calculé'),
  dansLigne(I, 'else local(ref.documentRelatif ?? ref.relatif, s.baseBrute, propres);', 's.baseBrute', 'null', 'page : la <base> est ignorée pour un worker écrit dans la page'),
  dansLigne(I, 'else if (ref.dossierRelatif !== undefined) dossier(ref.dossierRelatif, s.baseBrute, propres);', 'ref.dossierRelatif !== undefined', 'false', 'page : le dossier d\'un import() calculé n\'est pas suivi'),
  dansLigne(I, "if (typeof ref === 'string') local(ref, s.baseBrute, reserves);", "typeof ref === 'string'", 'false', 'page : un chemin d\'import n\'est pas suivi'),
  dansLigne(I, "if (r.nom === 'link') {", '{ dansTemplate: r.dansTemplate }', '{}', 'link : la réserve de gabarit est perdue'),
  dansLigne(I, 'local(url, feuille.baseBrute,', '{ dansTemplate: feuille.modele }', '{}', 'style de gabarit : la réserve est perdue pour les feuilles qu\'il importe'),
  dansLigne(I, 'const chemin = cheminLocal(urlDeCarte(e.url, e.baseBrute, f.chemin));', 'urlDeCarte(', 'urlDe(', 'import map : un nom nu est pris pour une adresse'),
  // Le chemin écrit autrement que le fichier : décodé, normalisé, écrit et décodé essayés.
  dansLigne(P, 'try { return path.posix.normalize(decodeURIComponent(url.pathname))', 'path.posix.normalize(decodeURIComponent(url.pathname))', 'decodeURIComponent(url.pathname)', 'cheminLocal : le chemin n\'est pas normalisé (//, /./, /../)'),
  dansLigne(P, 'try { return path.posix.normalize(decodeURIComponent(url.pathname))', 'decodeURIComponent(url.pathname)', 'url.pathname', 'cheminLocal : le chemin n\'est pas décodé (%61, %2F)'),
  dansLigne(P, 'try { return path.posix.normalize(decodeURIComponent(url.pathname))', '.slice(1)', '.slice(0)', 'cheminLocal : la barre de tête reste'),
  dansLigne(I, 'return decode === chemin ? [chemin] : [chemin, decode];', '[chemin, decode]', '[chemin]', 'chemin écrit : le chemin décodé n\'est pas essayé'),
  dansLigne(I, 'return decode === chemin ? [chemin] : [chemin, decode];', '[chemin, decode]', '[decode]', 'chemin écrit : le chemin tel qu\'il est écrit n\'est plus essayé'),
  dansLigne(I, 'return [chemin];                                             // ne se décode pas', 'return [chemin];', 'return [];', 'chemin écrit : un chemin qui ne se décode pas n\'est plus essayé'),
  dansLigne(I, 'for (const chemin of ecrituresDeChemin(relative.split', 'ecrituresDeChemin(relative.split(/[?#]/)[0])', '[relative.split(/[?#]/)[0]]', 'référence de fichier : le chemin décodé n\'est pas essayé'),
  dansLigne(I, 'return ecrituresDeChemin(relatif).map(', 'ecrituresDeChemin(relatif)', '[relatif]', 'import() à début fixe : le début décodé n\'est pas essayé'),
  dansLigne(I, 'for (const dossier of dossiersDepuis(rel, ref.dossierRelatif))', 'dossiersDepuis(rel, ref.dossierRelatif)', 'dossiersDepuis(rel, ref.dossierRelatif).slice(0, 1)', 'import() à début fixe : seul le premier dossier est retenu'),
  // Les deux assistants de `referencesSortantes` écrivent la même ligne ; chacun se mute avec sa ligne d'ouverture.
  [I, 'const local = (valeur, baseBrute, reserves = {}) => {\n      const chemin = cheminLocal(urlDe(valeur, baseBrute, f.chemin));', "const local = (valeur, baseBrute, reserves = {}) => {\n      const chemin = cheminLocal(urlDe(valeur, baseBrute, ''));", 'page : le dossier de la page est ignoré pour une référence locale'],
  [I, 'const dossier = (valeur, baseBrute, reserves) => {\n      const chemin = cheminLocal(urlDe(valeur, baseBrute, f.chemin));', "const dossier = (valeur, baseBrute, reserves) => {\n      const chemin = cheminLocal(urlDe(valeur, baseBrute, ''));", 'page : le dossier de la page est ignoré pour le dossier d\'un import() calculé'],
  [I, 'const dossier = (valeur, baseBrute, reserves) => {\n      const chemin = cheminLocal(urlDe(valeur, baseBrute, f.chemin));', 'const dossier = (valeur, baseBrute, reserves) => {\n      const chemin = cheminLocal(urlDe(valeur, null, f.chemin));', 'page : la <base> est ignorée par l\'assistant de dossier'],
  dansLigne(I, 'const reserves = { dansTemplate: e.dansTemplate,', 'dansTemplate: e.dansTemplate', 'dansTemplate: false', 'import map : la réserve de gabarit n\'est pas portée aux modules'),
  dansLigne(I, 'const reserves = { dansTemplate: e.dansTemplate,', 'seulementStandard: e.seulementStandard', 'seulementStandard: false', 'import map : la réserve de standard n\'est pas portée aux modules'),
);

// --- les adresses de modules -------------------------------------------------------------------------------------
MUTANTS.push(
  dansLigne(I, 'const module = (valeur) =>', 'if (estAdresseDeModule(valeur)) refs.push(valeur);', 'refs.push(valeur);', 'module : un nom nu est suivi comme un chemin relatif'),
  dansLigne(I, 'const estAdresseDeModule = ', 'urlDeCarte(valeur, null, \'\') !== null', 'true', 'module : toute chaîne est une adresse'),
  dansLigne(I, "cibles.add(path.posix.normalize(chemin.startsWith('/')", "chemin.startsWith('/') ? chemin.slice(1) : path.posix.join(path.posix.dirname(rel), chemin)", 'path.posix.join(path.posix.dirname(rel), chemin)', 'module : « / » part du dossier du fichier'),
  dansLigne(I, "cibles.add(path.posix.normalize(chemin.startsWith('/')", 'chemin.slice(1)', 'chemin', 'module : « / » garde sa barre de tête'),
  dansLigne(I, "return /(^|\\/)(vendor|libs?|third[-_]party|node_modules|assets\\/js\\/lib)\\//i.test(chemin)", 'node_modules|', '', 'vendorisé : node_modules n\'est plus du code tiers recopié'),
);

// --- les workers, lus dans l'AST puis, si le code ne se parse pas, par expressions régulières -------------------------
const ALIAS = String.raw`'(?:(?:window|self|globalThis)\\.)?'`;
for (const [nom, de, par] of [['window', 'window|', ''], ['self', 'self|', ''], ['globalThis', '|globalThis', '']]) {
  MUTANTS.push(dansLigne(I, 'const ALIAS_GLOBAL = ', de, par, `worker : l'alias ${nom}. n'est plus reconnu`));
}
MUTANTS.push(
  dansLigne(I, 'const NOM_WORKER = new RegExp(', '(?:Worker|SharedWorker)', '(?:Worker)', 'worker : SharedWorker n\'est plus reconnu'),
  dansLigne(I, "if (arg?.type === 'NewExpression' && NOM_URL.test(", "arg?.type === 'NewExpression' && NOM_URL.test(nomPointe(arg.callee) ?? '')", 'false', 'worker : la forme new URL(…) n\'est plus reconnue'),
  dansLigne(I, 'if (direct !== null) return [duWorker(relatifAuDocument(direct))];', 'direct !== null', 'false', 'worker : la forme directe n\'est plus reconnue'),
  dansLigne(I, 'if (/(^|\\.)importScripts$/.test(nom))', '/(^|\\.)importScripts$/', '/^importScripts$/', 'worker : self.importScripts() n\'est plus reconnu'),
  dansLigne(I, 'return n.arguments.map((a) => chaineLitterale(a))', 'n.arguments.map((a) => chaineLitterale(a)).filter((v) => v !== null)', '[chaineLitterale(n.arguments[0])].filter((v) => v !== null)', 'worker : importScripts() ne suit que son premier argument'),
  dansLigne(I, 'refs.push(...referencesWorkerParRegex(source));', 'refs.push(...referencesWorkerParRegex(source));', 'void 0;', 'illisible : les workers ne sont plus cherchés'),
  dansLigne(I, "source.matchAll(/\\bfrom\\s+", 'module(m[1]);', 'void m;', 'illisible : « from » n\'est plus suivi'),
  dansLigne(I, "source.matchAll(/\\bimport\\s*\\(", 'module(m[1]);', 'void m;', 'illisible : import() n\'est plus suivi', '(?:'),
  dansLigne(I, 'source.matchAll(/\\bimport\\s+["\']', 'module(m[1]);', 'void m;', 'illisible : import sans liaison n\'est plus suivi'),
  dansLigne(I, 'contenu.matchAll(new RegExp(', 'refs.push(duWorker(relatifAuDocument(m[1] ?? m[2])));', 'void m;', "illisible : new Worker('…') n'est plus suivi", 'URL'),
  dansLigne(I, String.raw`URL\\s*\\(`, 'refs.push(duWorker(relatifAuDocument(m[1] ?? m[2])));', 'void m;', "illisible : new Worker(new URL('…')) n'est plus suivi"),
  dansLigne(I, 'for (const t of contenu.slice(entete.lastIndex, fin).matchAll(', 'refs.push(duWorker(t[1]));', 'void t;', 'illisible : importScripts(…) n\'est plus suivi'),
  dansLigne(I, 'for (const t of contenu.slice(entete.lastIndex, fin).matchAll(', 'contenu.slice(entete.lastIndex, fin)', 'contenu.slice(entete.lastIndex)', 'illisible : les arguments d\'importScripts( vont jusqu\'à la fin du texte'),
  dansLigne(I, 'const fin = contenu.indexOf(', "contenu.indexOf(')', entete.lastIndex)", "contenu.indexOf(')')", 'illisible : la parenthèse qui ferme importScripts( est cherchée depuis le début du texte'),
  dansLigne(I, 'if (fin < 0) break;', 'if (fin < 0) break;', '', 'illisible : importScripts( sans parenthèse fermante lit quand même ses arguments'),
  dansLigne(I, 'entete.lastIndex = fin + 1;', 'entete.lastIndex = fin + 1;', '', 'illisible : un importScripts( dans les arguments d\'un autre est lu deux fois'),
  dansLigne(I, 'const entete = ', String.raw`\s*\(`, String.raw`\s*`, 'illisible : importScripts sans parenthèse est lu comme un appel'),
  dansLigne(I, 'const entete = ', String.raw`/\bimportScripts`, String.raw`/importScripts`, 'illisible : monimportScripts( est lu comme importScripts('),
);

// --- l'exemption du code vendorisé et des dossiers exclus ne vaut que pour A et B -------------------------------------
MUTANTS.push(
  dansLigne(J, 'if (ignorerVendorise && (f.vendorise || f.dossierExclu)) continue;', ' || f.dossierExclu', '', 'A/B : les fonctions et noms d\'un dossier exclu sont jugés'),
  dansLigne(QA, '.filter((f) => f.executee && !f.vendorise && !f.dossierExclu', ' && !f.dossierExclu', '', 'A-TAILLE-01 : un fichier de dist/ est jugé'),
  dansLigne(QA, 'if (!f.contenu || f.binaire || f.vendorise || f.dossierExclu || estCarteDeSources(f)) continue;', ' || f.dossierExclu', '', 'A-DEV-03 : les marqueurs d\'un fichier de dist/ sont comptés'),
  dansLigne(QA, "if (fichier.vendorise || fichier.dossierExclu) return 'tierce';", ' || fichier.dossierExclu', '', 'A-DUP-01 : les blocs d\'un fichier de dist/ sont comparés'),
  [QB, "    if (!f.executee || f.vendorise || f.dossierExclu || !['.js', '.mjs'].includes(f.ext) || !f.contenu) continue;\n    const { code, commentaire, exacte } = mesurerLignes(f);", "    if (!f.executee || f.vendorise || !['.js', '.mjs'].includes(f.ext) || !f.contenu) continue;\n    const { code, commentaire, exacte } = mesurerLignes(f);", 'B-COM-01 : un fichier de dist/ est jugé'],
  dansLigne(QB, "if (!f.contenu || f.binaire || f.vendorise || f.dossierExclu || !['.js', '.mjs', '.html'].includes(f.ext)) continue;", ' || f.dossierExclu', '', 'B-IA-01 : les marqueurs d\'un fichier de dist/ sont comptés'),
  dansLigne(QB, 'const surface = ctx.fichiers.filter((f) => f.executee && !f.vendorise && !f.dossierExclu', ' && !f.dossierExclu', '', 'B-VERB-01 : les lignes de dist/ sont comptées'),
  [QB, "    if (!f.executee || f.vendorise || f.dossierExclu || !['.js', '.mjs'].includes(f.ext) || !f.contenu) continue;\n    for (const l of f.lignes) {", "    if (!f.executee || f.vendorise || !['.js', '.mjs'].includes(f.ext) || !f.contenu) continue;\n    for (const l of f.lignes) {", 'B-LANG-01 : les commentaires de dist/ sont comptés'],
);

// --- les chargements de code par import -----------------------------------------------------------------------------
MUTANTS.push(
  dansLigne(J, "if (canal !== 'import() distant' && unite.inline && !unite.module) return;", "canal !== 'import() distant' && unite.inline && !unite.module", 'false', 'import : un import statique d\'un script classique est signalé'),
  dansLigne(J, "if (canal !== 'import() distant' && unite.inline && !unite.module) return;", "canal !== 'import() distant' && ", '', 'import : un import() d\'un script classique est ignoré'),
  dansLigne(J, "if (canal !== 'import() distant' && unite.inline && !unite.module) return;", ' unite.inline &&', '', 'import : les imports d\'un fichier .js sont ignorés'),
  dansLigne(J, "import { lirePage, integriteProtege, urlDe, urlDeCarte, baseDe } from './page-html.js';", 'urlDe, urlDeCarte, baseDe }', 'urlDe, urlDe as urlDeCarte, baseDe }', 'import : un nom nu est résolu contre la <base>'),
  dansLigne(J, 'const url = urlDeCarte(valeur, unite.inline', 'unite.inline ? unite.baseBrute : null', 'null', 'import : la <base> de la page est ignorée'),
  dansLigne(S, 'const chargeDuCode = CANAUX_DE_CODE.has(canal);', 'CANAUX_DE_CODE.has(canal)', 'false', 'import : dit comme une requête de données'),
  dansLigne(S, "const CANAUX_DE_CODE = new Set(", "'import() distant', ", '', 'import : import() dit comme une requête de données'),
  dansLigne(S, "const CANAUX_DE_CODE = new Set(", "'import statique', ", '', 'import : import statique dit comme une requête de données'),
  dansLigne(S, "const CANAUX_DE_CODE = new Set(", ", 'export … from'", '', 'import : export … from dit comme une requête de données'),
  dansLigne(J, "ImportExpression(n) { importer(n, n.source, 'import() distant'); },", "importer(n, n.source, 'import() distant');", '', 'import : import() n\'est plus visité'),
  dansLigne(J, "ImportDeclaration(n) { importer(n, n.source, 'import statique'); },", "importer(n, n.source, 'import statique');", '', 'import : import statique n\'est plus visité'),
  dansLigne(J, "ExportAllDeclaration(n) { importer(n, n.source, 'export … from'); },", "importer(n, n.source, 'export … from');", '', 'import : export * from n\'est plus visité'),
  dansLigne(J, "ExportNamedDeclaration(n) { if (n.source) importer(n, n.source, 'export … from'); },", "importer(n, n.source, 'export … from');", 'void 0;', 'import : export { … } from n\'est plus visité'),
  dansLigne(S, 'if (estGrist(h)) return;                               // API Grist', 'estGrist(h)', 'false', 'import : l\'hôte de Grist est signalé'),
);

// --- C-XSS-04 suit ce qu'est la valeur passée -------------------------------------------------------------------------
const PROPRIETES = ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
for (const p of PROPRIETES) {
  MUTANTS.push(dansLigne(S, "$/.test(nom)) return 'chaine';", PROPRIETES.join('|'), PROPRIETES.filter((x) => x !== p).join('|'), `location.${p} n'est plus une chaîne`));
}
MUTANTS.push(
  dansLigne(S, "return 'nombre';", "return 'nombre';", 'return null;', 'location.<propriété>.length n\'est plus un nombre'),
  dansLigne(S, "return 'fonction';", "return 'fonction';", 'return null;', 'location.reload… n\'est plus une fonction'),
);
for (const m of ['assign', 'replace', 'reload', 'toString']) {
  MUTANTS.push(dansLigne(S, "return 'fonction';", ['assign', 'replace', 'reload', 'toString'].join('|'), ['assign', 'replace', 'reload', 'toString'].filter((x) => x !== m).join('|'), `location.${m} n'est plus une fonction`));
}
MUTANTS.push(
  dansLigne(S, "if (['fonction', 'nombre'].includes(typeAccesLocation(arg))) return [];", "['fonction', 'nombre']", "['fonction']", 'minuteur : un nombre de location est traité comme du code'),
  dansLigne(S, "if (['fonction', 'nombre'].includes(typeAccesLocation(arg))) return [];", "['fonction', 'nombre']", "['nombre']", 'minuteur : une fonction de location est traitée comme du code'),
  dansLigne(S, "if (['fonction', 'nombre'].includes(typeAccesLocation(arg))) return [];", "['fonction', 'nombre'].includes(typeAccesLocation(arg))", 'false', 'minuteur : le type de location n\'est plus regardé'),
  dansLigne(S, "return typeAccesLocation(noeud) === 'chaine';", "=== 'chaine'", '!== null', 'location : une fonction passe pour une donnée de la page'),
);

// --- la CSP en balise que Chromium n'applique pas ---------------------------------------------------------------------
MUTANTS.push(
  dansLigne(S, 'const aUneDirective = ', "partie.trim() !== ''", 'true', 'CSP : une balise sans directive compte'),
  dansLigne(S, 'const aUneDirective = ', "partie.trim() !== ''", "partie !== ''", 'CSP : un contenu d\'espaces compte'),
  dansLigne(S, 'const aUneDirective = ', "?? ''", "?? 'x'", 'CSP : une balise sans content compte'),
  dansLigne(S, "if (b.dansTemplate) return 'elle est dans un", 'b.dansTemplate', 'false', 'CSP : la raison « gabarit » n\'est plus dite'),
  dansLigne(S, "if (!b.dansTete) return \"elle n'est plus dans", '!b.dansTete', 'false', 'CSP : la raison « hors de head » n\'est plus dite'),
  dansLigne(S, "return b.attributs.has('content') ?", "b.attributs.has('content')", "!b.attributs.has('content')", 'CSP : les raisons « sans content » et « content vide » sont permutées'),
  dansLigne(S, 'if (metas.some((m) => m.dansTete', 'm.dansTete && ', '', 'CSP : une balise hors de head compte'),
  dansLigne(P, 'dansTete: phase !== ', ' && templatesOuverts === 0', '', 'CSP : une balise de gabarit placée dans head compte (dansTete ne dit plus le gabarit)'),
  dansLigne(S, 'if (metas.some((m) => m.dansTete', ' && aUneDirective(m)', '', 'CSP : une balise sans directive compte pour C-CSP-01'),
  dansLigne(S, 'const meta = lirePage(f.contenu).balises.find((b) => estMetaCsp(b)', ' && aUneDirective(b)', '', 'C-CSP-02 : une balise inerte devant une CSP permissive la masque'),
  dansLigne(S, 'const meta = lirePage(f.contenu).balises.find((b) => estMetaCsp(b)', 'b.dansTete && ', '', 'C-CSP-02 : une CSP hors de head est jugée'),
);

// --- la feuille que seul un gabarit charge -------------------------------------------------------------------------------
MUTANTS.push(
  dansLigne(S, 'const mention = f.mention === mentionDe({ dansTemplate: true })', 'const mention = f.mention === mentionDe({ dansTemplate: true }) ? MENTION_GABARIT_RESSOURCE : f.mention;', 'const mention = null;', 'feuille : la réserve de gabarit n\'est pas dite sur ce qu\'elle charge'),
  dansLigne(S, 'const mention = f.mention === mentionDe({ dansTemplate: true })', '===', '!==', 'feuille : la réserve est dite avec les mots du code'),
  dansLigne(S, 'sortie.push(e.borne || !mention ? e : { ...e, mention })', 'e.borne || !mention ? e : { ...e, mention }', 'e', 'feuille : la réserve n\'est jamais portée par les constats'),
);

// --- une adresse d'import map qui finit par « / » est un préfixe : le listeur de modules ---------------------------------
MUTANTS.push(
  dansLigne(I, "refs.push(chemin === '' || chemin.endsWith('/') ?", "chemin === '' || chemin.endsWith('/')", 'false', 'préfixe : une adresse en « / » n\'est plus un préfixe'),
  dansLigne(I, "refs.push(chemin === '' || chemin.endsWith('/') ?", "chemin === '' || ", '', 'préfixe : la racine du widget (« ./ ») n\'est plus un préfixe'),
  dansLigne(I, "refs.push(chemin === '' || chemin.endsWith('/') ?", "chemin.endsWith('/')", 'true', 'préfixe : toute adresse est un préfixe'),
  dansLigne(I, "refs.push(chemin === '' || chemin.endsWith('/') ?", '? { dossier: chemin, ...reserves } : { chemin, ...reserves }', '? { chemin, ...reserves } : { dossier: chemin, ...reserves }', 'préfixe : dossier et chemin permutés'),
  dansLigne(I, 'const MODULE_JS = ', 'm?js|cjs', 'js|cjs', 'listeur : .mjs n\'est plus un module'),
  dansLigne(I, 'const MODULE_JS = ', '|cjs', '', 'listeur : .cjs n\'est plus un module'),
  dansLigne(I, 'const MODULE_JS = ', '$/i', '/i', 'listeur : le nom n\'est plus lu jusqu\'au bout (a.js.map est un module)'),
  dansLigne(I, 'const MODULE_JS = ', '$/i', '$/', 'listeur : la casse compte (D.JS n\'est plus un module)'),
  dansLigne(I, 'const MODULE_JS = ', '\\.(?:', '(?:', 'listeur : un nom sans point (js) est un module'),
  dansLigne(I, 'const MAX_ENTREES_LISTEES = ', '100_000', '0', 'listeur : aucune entrée ne peut être lue par défaut'),
  dansLigne(I, 'documentsEpuises } = calculerSurface(', 'nouveauListeur(racine, fichiers, etat, maxEntreesListees)', 'nouveauListeur(racine, fichiers, etat)', 'listeur : le budget demandé n\'est pas transmis'),
  dansLigne(I, "if (e.isDirectory() && e.name !== '.git') etat.exclus.push(", "e.name !== '.git'", 'true', 'listeur : .git est noté comme dossier exclu'),
  dansLigne(I, "if (e.isDirectory() && e.name !== '.git') etat.exclus.push(", "etat.exclus.push(path.relative(racine, abs).split(path.sep).join('/'))", 'void 0', 'listeur : aucun dossier exclu n\'est noté'),
  dansLigne(I, 'const chemins = fichiers.filter(', '!f.dossierExclu && ', '', 'listeur : un fichier de dossier exclu déjà ouvert est rendu deux fois'),
  dansLigne(I, 'const chemins = fichiers.filter(', 'MODULE_JS.test(f.chemin)', 'true', 'listeur : tout fichier de l\'inventaire est un module'),
  dansLigne(I, 'let restant = maxEntrees;', 'maxEntrees', 'maxEntrees + 1', 'listeur : le budget compte une entrée de trop'),
  dansLigne(I, 'let restant = maxEntrees;', 'maxEntrees', 'maxEntrees - 1', 'listeur : le budget compte une entrée de moins'),
  dansLigne(I, "if (e.name === '.git') continue;", "e.name === '.git'", 'false', 'listeur : le .git d\'un dossier exclu est lu'),
  dansLigne(I, 'if (--restant < 0)', '--restant < 0', '--restant <= 0', 'listeur : le budget coupe une entrée trop tôt'),
  dansLigne(I, 'if (--restant < 0)', '--restant < 0', '--restant < -1', 'listeur : le budget coupe une entrée trop tard'),
  dansLigne(I, 'if (--restant < 0)', 'etat.tronqueListage = true;', 'void 0;', 'listeur : le dépassement du budget ne se dit pas'),
  dansLigne(I, 'if (--restant < 0)', 'return chemins.sort();', 'return chemins;', 'listeur : une liste coupée n\'est plus triée'),
  dansLigne(I, 'return chemins.sort();', 'return chemins.sort();', 'return chemins;', 'listeur : la liste n\'est plus triée', '--restant'),
  dansLigne(I, 'if (e.isDirectory()) pile.push(', 'e.isDirectory()', 'false', 'listeur : les sous-dossiers ne sont pas lus'),
  dansLigne(I, 'if (e.isDirectory()) pile.push(', '${rel}/${e.name}', '${e.name}', 'listeur : le chemin d\'un sous-dossier perd son dossier'),
  dansLigne(I, 'else if (e.isFile() && MODULE_JS.test(e.name))', 'e.isFile() && ', '', 'listeur : un lien nommé comme un module est rendu'),
  dansLigne(I, 'else if (e.isFile() && MODULE_JS.test(e.name))', 'MODULE_JS.test(e.name)', 'true', 'listeur : tout fichier d\'un dossier exclu est un module'),
  dansLigne(I, 'else if (e.isFile() && MODULE_JS.test(e.name))', '${rel}/${e.name}', '${e.name}', 'listeur : le chemin d\'un module perd son dossier'),
  dansLigne(I, 'try { lus = entreesDuDossier(', 'catch { continue; }', 'catch (erreur) { throw erreur; }', 'listeur : un dossier absent fait échouer'),
  dansLigne(I, 'modules ??= construire();', '??=', '=', 'listeur : les dossiers exclus sont relus à chaque appel'),
  // Équivalent, donc absent : `let haut = modules.length - 1` — la première recherche s'arrête alors sur le dernier indice au plus tôt, et la seconde relit cet élément (`startsWith`, faux puisqu'il précède le préfixe) : mêmes résultats pour tout préfixe.
  dansLigne(I, 'let bas = 0;', '0', '1', 'listeur : le premier module n\'est jamais rendu'),
  dansLigne(I, 'if (modules[milieu] < prefixe)', 'modules[milieu] < prefixe', 'modules[milieu] <= prefixe', 'listeur : un chemin égal au préfixe n\'est pas rendu'),
  dansLigne(I, 'if (modules[milieu] < prefixe)', 'bas = milieu + 1', 'bas = milieu + 2', 'listeur : la recherche saute un module'),
  dansLigne(I, 'if (modules[milieu].startsWith(prefixe))', 'modules[milieu].startsWith(prefixe)', 'true', 'listeur : tout ce qui suit le préfixe est rendu'),
  dansLigne(I, 'if (modules[milieu].startsWith(prefixe))', 'debut = milieu + 1', 'debut = milieu + 2', 'listeur : la seconde recherche saute un module'),
  dansLigne(I, 'let fin = modules.length;', 'modules.length', 'modules.length - 1', 'listeur : le dernier module n\'est jamais rendu'),
  dansLigne(I, 'let debut = bas;', 'bas', '0', 'listeur : la seconde recherche part du premier module'),
  dansLigne(I, 'return modules.slice(bas, fin);', 'fin', 'fin + 1', 'listeur : un module de trop est rendu'),
  dansLigne(I, 'return modules.slice(bas, fin);', 'bas', 'bas + 1', 'listeur : le premier module du préfixe n\'est pas rendu'),
  [I, `    let fin = modules.length;
    let debut = bas;
    while (debut < fin) {                                        // premier chemin, à partir de là, qui ne commence plus par \`prefixe\`
      const milieu = (debut + fin) >> 1;
      if (modules[milieu].startsWith(prefixe)) debut = milieu + 1; else fin = milieu;
    }
    return modules.slice(bas, fin);`, `    let fin = bas;
    while (fin < modules.length && modules[fin].startsWith(prefixe)) fin++;
    return modules.slice(bas, fin);`, 'listeur : la plage se borne module par module (coût : la longueur du préfixe par module)'],
);

// --- la fermeture : un fichier, un dossier ne se lisent qu'une fois --------------------------------------------------
MUTANTS.push(
  dansLigne(I, 'if (!mis.has(chemin)) { mis.add(chemin)', '!mis.has(chemin)', 'true', 'fermeture : un fichier déjà dans la file y est remis'),
  dansLigne(I, 'if (!mis.has(chemin)) { mis.add(chemin)', 'mis.add(chemin); ', '', 'fermeture : un fichier mis dans la file n\'est pas noté'),
  dansLigne(I, 'const mis = new Set(file);', 'new Set(file)', 'new Set()', 'fermeture : un point d\'entrée cité par un fichier est remis dans la file'),
  dansLigne(I, 'if (dossiersVus.has(arete.dossier)) continue;', 'dossiersVus.has(arete.dossier)', 'false', 'fermeture : un dossier nommé plusieurs fois est relu'),
  dansLigne(I, 'dossiersVus.add(arete.dossier);', 'dossiersVus.add(arete.dossier);', 'void 0;', 'fermeture : un dossier lu n\'est pas noté'),
  dansLigne(I, 'for (const chemin of lister(arete.dossier)) mettre(chemin', 'mettre(chemin, true)', 'void chemin', 'fermeture : les modules d\'un dossier ne sont pas suivis'),
  dansLigne(I, 'if (arete.dossier === undefined) { mettre(arete.cible', "mettre(arete.cible, arete.commeCode, arete.commeCode ? (arete.ambigu ? 'probable' : true) : false);", 'void 0;', 'fermeture : un fichier désigné n\'est pas suivi'),
);

// --- ce qui s'adresse au document : les contextes de page et la résolution --------------------------------------------
MUTANTS.push(
  dansLigne(I, 'const bases = new Set([null]);', '[null]', '[]', 'contextes : une page sans contenu lisible n\'est plus un contexte'),
  dansLigne(I, 'if (page?.contenu) {', 'page?.contenu', 'page', 'contextes : une page trouvée sans texte est lue'),
  dansLigne(I, 'bases.clear();', 'bases.clear();', 'void 0;', 'contextes : la page sans <base> reste un contexte de celle qui en déclare une'),
  dansLigne(I, 'bases.add(lue.baseFinale);', 'bases.add(lue.baseFinale);', 'void 0;', 'contextes : la base que voit le code d\'après la page est ignorée'),
  dansLigne(I, 'for (const s of lue.scripts) bases.add(s.baseBrute);', 'bases.add(s.baseBrute)', 'void s', 'contextes : la page vue par un script placé avant la <base> est ignorée'),
  dansLigne(I, 'const cle = JSON.stringify([', 'path.posix.dirname(entree)', 'entree', 'contextes : deux pages d\'un même dossier font deux contextes'),
  dansLigne(I, 'const cle = JSON.stringify([', ', baseBrute]', ']', 'contextes : deux bases ne font plus deux contextes'),
  dansLigne(I, 'if (!vus.has(cle)) {', '!vus.has(cle)', 'true', 'contextes : un contexte déjà vu est ajouté encore'),
  dansLigne(P, 'baseFinale: baseBrute', 'baseFinale: baseBrute', 'baseFinale: null', 'contextes : lirePage ne dit pas la base finale'),
  dansLigne(I, 'if (chemins) return chemins;', 'if (chemins) return chemins;', 'void 0;', 'résolution : une adresse est recalculée à chaque appel'),
  dansLigne(I, 'connus.set(relative, chemins);', 'connus.set(relative, chemins);', 'void 0;', 'résolution : le résultat d\'une adresse n\'est jamais gardé'),
  dansLigne(I, 'if (chemin !== null) chemins.add(chemin);', 'chemin !== null', 'true', 'résolution : une adresse hors du widget entre dans les chemins'),
  dansLigne(I, 'const chemin = cheminLocal(urlDe(relative, baseBrute, entree));', 'baseBrute', 'null', 'résolution : la base du contexte est ignorée'),
  dansLigne(I, 'const chemin = cheminLocal(urlDe(relative, baseBrute, entree));', ', entree)', ", '')", 'résolution : le dossier de la page du contexte est ignoré'),
  dansLigne(I, 'const cheminsDuDocument = (relative) =>', '??=', '=', 'surface : les contextes de page sont recalculés à chaque adresse'),
  dansLigne(I, 'if (objet && ref.documentRelatif !== undefined) for (const cheminDuDocument of', 'objet && ref.documentRelatif !== undefined', 'false', 'surface : une adresse de document ne se résout plus contre la page'),
  dansLigne(I, 'if (objet && ref.documentRelatif !== undefined) for (const cheminDuDocument of', 'ref.documentRelatif !== undefined', 'true', 'surface : l\'adresse d\'un fichier de worker (importScripts) se résout aussi contre la page'),
  dansLigne(I, 'if (objet && ref.chemin !== undefined) cibles.add(ref.chemin);', 'objet && ref.chemin !== undefined', 'false', 'surface : une référence déjà résolue par la page est perdue'),
  dansLigne(I, 'for (const chemin of ecrituresDeChemin(relative.split', '[?#]', '[#]', 'surface : la requête d\'une adresse fait partie du chemin'),
  dansLigne(I, 'for (const chemin of ecrituresDeChemin(relative.split', '[?#]', '[?]', 'surface : le fragment d\'une adresse fait partie du chemin'),
  dansLigne(I, 'if (objet && ref.dossier !== undefined) liste.push(', 'objet && ref.dossier !== undefined', 'false', 'surface : un préfixe déjà résolu par la page est perdu'),
  dansLigne(I, 'else if (objet && ref.dossierRelatif !== undefined) for', 'objet && ref.dossierRelatif !== undefined', 'false', 'surface : le dossier d\'un import() à début fixe est perdu'),
  dansLigne(I, 'else if (objet && ref.dossierRelatif !== undefined) for', 'dossiersDepuis(rel, ref.dossierRelatif)', '[ref.dossierRelatif]', 'surface : le dossier d\'un import() à début fixe n\'est pas résolu depuis le fichier'),
  dansLigne(I, "const dossier = path.posix.normalize(ecrit.startsWith('/')", "ecrit.startsWith('/')", 'false', 'import() à début fixe : « / » part du dossier du fichier'),
  dansLigne(I, "const dossier = path.posix.normalize(ecrit.startsWith('/')", 'ecrit.slice(1)', 'ecrit', 'import() à début fixe : « / » garde sa barre de tête'),
  dansLigne(I, "return dossier === './' || dossier === '.' ? '' : dossier;", "dossier === './' || ", '', 'import() à début fixe : le dossier du fichier, à la racine, n\'est plus la racine'),
  dansLigne(I, "return dossier === './' || dossier === '.' ? '' : dossier;", " || dossier === '.'", '', 'import() à début fixe : « / » n\'est plus la racine'),
);

// --- les workers, le service worker et les modules de worklet s'adressent au document ---------------------------------
MUTANTS.push(
  dansLigne(I, 'if (direct !== null) return [duWorker(relatifAuDocument(direct))];', 'relatifAuDocument(direct)', 'direct', 'worker : `new Worker(\'w.js\')` se résout contre le fichier, non contre la page'),
  dansLigne(I, 'if (emballe !== null) return [', 'estImportMetaUrl(arg.arguments[1])', 'false', 'worker : `new URL(…, import.meta.url)` se résout contre la page'),
  dansLigne(I, 'if (emballe !== null) return [', 'estImportMetaUrl(arg.arguments[1])', 'true', 'worker : `new URL(…, document.baseURI)` se résout contre le module'),
  dansLigne(I, 'const estImportMetaUrl = ', "n.property.name === 'url'", "n.property.name === 'href'", 'worker : `import.meta.url` n\'est plus reconnu'),
  dansLigne(I, 'const estImportMetaUrl = ', "n.object.type === 'MetaProperty'", 'true', 'worker : n\'importe quel `.url` est pris pour `import.meta.url`'),
  dansLigne(I, 'const NOM_ENREGISTREMENT = ', '(^|\\.)', '', 'service worker : `monserviceWorker.register` est suivi'),
  dansLigne(I, 'const NOM_ENREGISTREMENT = ', 'serviceWorker\\.', '', 'service worker : n\'importe quel `.register` est suivi'),
  dansLigne(I, 'const NOM_MODULE_DE_WORKLET = ', '(^|\\.)', '', 'worklet : `moi$Worklet.addModule` est suivi'),
  dansLigne(I, 'const NOM_MODULE_DE_WORKLET = ', '\\w*', '', 'worklet : `audioWorklet.addModule` n\'est plus suivi'),
  dansLigne(I, 'const NOM_MODULE_DE_WORKLET = ', '[Ww]', 'W', 'worklet : `worklet.addModule` n\'est plus suivi'),
  dansLigne(I, 'if (NOM_ENREGISTREMENT.test(nom) || NOM_MODULE_DE_WORKLET.test(nom)) {', 'NOM_ENREGISTREMENT.test(nom) || ', '', 'service worker : `serviceWorker.register` n\'est plus suivi'),
  dansLigne(I, 'if (NOM_ENREGISTREMENT.test(nom) || NOM_MODULE_DE_WORKLET.test(nom)) {', ' || NOM_MODULE_DE_WORKLET.test(nom)', '', 'worklet : `addModule` n\'est plus suivi'),
  dansLigne(I, 'if (valeur !== null) return [duWorker(relatifAuDocument(valeur))];', 'relatifAuDocument(valeur)', 'valeur', 'service worker et worklet : se résolvent contre le fichier, non contre la page'),
  dansLigne(I, 'for (const m of contenu.matchAll(/(?:^|[^\\w$])', 'refs.push(duWorker(relatifAuDocument(m[1])))', 'refs.push(duWorker(m[1]))', 'illisible : service worker et worklet se résolvent contre le fichier'),
  dansLigne(I, 'for (const m of contenu.matchAll(/(?:^|[^\\w$])', '(?:^|[^\\w$])', '', 'illisible : `monserviceWorker.register` est suivi'),
  dansLigne(I, 'for (const m of contenu.matchAll(/(?:^|[^\\w$])', 'serviceWorker\\.register|', '', 'illisible : `serviceWorker.register` n\'est plus suivi'),
  dansLigne(I, 'for (const m of contenu.matchAll(/(?:^|[^\\w$])', '|\\w*[Ww]orklet\\.addModule', '', 'illisible : `addModule` n\'est plus suivi'),
  dansLigne(I, 'for (const m of contenu.matchAll(/(?:^|[^\\w$])', '[Ww]', 'W', 'illisible : `worklet.addModule` n\'est plus suivi'),
);


// --- `import()` dont le début de l'adresse est fixe -----------------------------------------------------------------------
MUTANTS.push(
  dansLigne(I, "if (n?.type === 'TemplateLiteral') return n.quasis[0]", "n?.type === 'TemplateLiteral'", 'false', 'import() calculé : le début d\'un gabarit n\'est plus lu'),
  dansLigne(I, "if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;", "n?.type === 'Literal' && typeof n.value === 'string'", 'false', 'import() calculé : le début d\'une concaténation n\'est plus lu'),
  dansLigne(I, "if (n?.type === 'BinaryExpression' && n.operator === '+') return debutFixeDeSource(n.left);", "n?.type === 'BinaryExpression' && n.operator === '+'", 'false', 'import() calculé : une concaténation n\'est plus lue'),
  dansLigne(I, "if (n?.type === 'BinaryExpression' && n.operator === '+') return debutFixeDeSource(n.left);", "n.operator === '+'", 'true', 'import() calculé : n\'importe quel opérateur concatène'),
  dansLigne(I, "if (n?.type === 'BinaryExpression' && n.operator === '+') return debutFixeDeSource(n.left);", 'n.left', 'n.right', 'import() calculé : la fin de la concaténation est prise pour son début'),
  dansLigne(I, 'return i >= 0 && ', 'i >= 0', 'i > 0', 'import() calculé : « / » seul ne nomme plus la racine'),
  dansLigne(I, 'return i >= 0 && ', '{1,2}', '{1}', 'import() calculé : « ../ » n\'est plus une adresse'),
  dansLigne(I, 'return i >= 0 && ', '|\\/)', ')', 'import() calculé : « / » n\'est plus une adresse'),
  dansLigne(I, 'return i >= 0 && ', '/^(?:', '/(?:', 'import() calculé : un nom nu qui contient « / » est une adresse'),
  dansLigne(I, 'return i >= 0 && ', 'debut.slice(0, i + 1)', 'debut.slice(0, i)', 'import() calculé : le dossier perd sa barre finale (locales2/ est sous locales)'),
  [I, "            const dossier = dossierDeSourceCalculee(n.source);\n            if (dossier !== null) refs.push({ dossierRelatif: dossier });", "            const dossier = dossierDeSourceCalculee(n.source);\n            if (true) refs.push({ dossierRelatif: dossier });", 'import() calculé : un début qui n\'est pas une adresse est suivi'],
  [I, "dossierDeDebut(m[1] ?? m[2]);\n      if (dossier !== null) refs.push({ dossierRelatif: dossier });", "dossierDeDebut(m[1] ?? m[2]);\n      if (true) refs.push({ dossierRelatif: dossier });", 'illisible : un début qui n\'est pas une adresse est suivi'],
  [I, "            const dossier = dossierDeSourceCalculee(n.source);\n            if (dossier !== null) refs.push({ dossierRelatif: dossier });", "            const dossier = dossierDeSourceCalculee(n.source);\n            void dossier;", 'import() calculé : son dossier n\'est jamais suivi'],
  [I, "dossierDeDebut(m[1] ?? m[2]);\n      if (dossier !== null) refs.push({ dossierRelatif: dossier });", "dossierDeDebut(m[1] ?? m[2]);\n      void dossier;", 'illisible : le début fixe d\'un import() n\'est plus suivi'],
  dansLigne(I, 'const dossier = dossierDeDebut(m[1] ?? m[2]);', 'm[1] ?? m[2]', 'm[1]', 'illisible : le début fixe d\'un gabarit n\'est plus lu'),
);

// --- ce qui dépasse un plafond se dit --------------------------------------------------------------------------------
MUTANTS.push(
  dansLigne(I, 'export function construireContexte(', 'maxResolutions = MAX_RESOLUTIONS', 'maxResolutions = 0', 'budget : aucune résolution par défaut'),
  dansLigne(I, 'const MAX_RESOLUTIONS = ', '2_000_000', '0', 'budget : le plafond de résolutions est nul'),
  dansLigne(I, 'documentsEpuises } = calculerSurface(', ', { maxResolutions, maxPasDocuments })', ', { maxPasDocuments })', 'budget : le plafond demandé n\'est pas transmis à la fermeture'),
  dansLigne(I, 'export function calculerSurface(', 'maxResolutions = MAX_RESOLUTIONS', 'maxResolutions = 0', 'budget : la fermeture n\'a par défaut aucune résolution'),
  dansLigne(I, 'const budget = { restant: maxResolutions, epuise: false };', 'epuise: false', 'epuise: true', 'budget : la fermeture démarre épuisée'),
  dansLigne(I, 'return { surface, mentions, partiel: budget.epuise, surfaceDuDocument, debutDeChargement, surfaceDesWorkers, pasDocuments, depenserPasDocuments,', 'budget.epuise', 'false', 'budget : la fermeture ne dit pas qu\'elle est partielle'),
  dansLigne(I, 'export function resolveurDeDocument(', 'restant: Infinity', 'restant: 0', 'budget : le résolveur seul n\'a aucune résolution'),
  dansLigne(I, 'if (--budget.restant < 0)', '--budget.restant < 0', '--budget.restant <= 0', 'budget : une résolution de moins que le plafond'),
  dansLigne(I, 'if (--budget.restant < 0)', '--budget.restant < 0', '--budget.restant < -1', 'budget : une résolution de plus que le plafond'),
  dansLigne(I, 'if (--budget.restant < 0)', 'budget.epuise = true;', 'void 0;', 'budget : l\'épuisement ne se dit pas'),
  dansLigne(I, 'if (--budget.restant < 0)', ' break;', '', 'budget : la résolution continue au-delà du plafond'),
  dansLigne(I, 'const calculerTronque = () => (etat.tronqueFichiers', '|| partiel ||', '||', 'tronque : la surface partielle ne tronque rien'),
  dansLigne(I, 'const calculerTronque = () => (etat.tronqueFichiers', '|| etat.tronqueListage', '', 'tronque : la lecture coupée des dossiers exclus ne tronque rien'),
  dansLigne(I, 'listage: etat.tronqueListage', 'listage: etat.tronqueListage', 'listage: false', 'tronque : le listage coupé ne se dit pas'),
  dansLigne(I, 'listage: etat.tronqueListage', 'surface: partiel', 'surface: false', 'tronque : la surface partielle ne se dit pas'),
  dansLigne(I, 'listage: etat.tronqueListage', 'maxEntreesListees, maxResolutions', 'maxResolutions', 'tronque : le plafond de lecture n\'est pas dit'),
  dansLigne(I, 'listage: etat.tronqueListage', 'maxEntreesListees, maxResolutions', 'maxEntreesListees', 'tronque : le plafond de résolutions n\'est pas dit'),
  dansLigne(I, 'if (tronque.fichiers) raisons.push', 'tronque.fichiers', 'false', 'raisons : les fichiers en trop ne sont pas dits'),
  dansLigne(I, 'if (tronque.octets) raisons.push', 'tronque.octets', 'false', 'raisons : les octets en trop ne sont pas dits'),
  dansLigne(I, 'if (tronque.octets) raisons.push', 'tronque.maxOctets / 1024 / 1024', 'tronque.maxOctets', 'raisons : le plafond d\'octets n\'est pas en Mio'),
  dansLigne(I, 'if (tronque.listage) raisons.push', 'tronque.listage', 'false', 'raisons : la lecture coupée n\'est pas dite'),
  dansLigne(I, 'if (tronque.surface) raisons.push', 'tronque.surface', 'false', 'raisons : la surface partielle n\'est pas dite'),
  dansLigne(M, 'raisonsDeTroncature(meta.tronque).join', ".join(', ')", ".join(' et ')", 'Markdown : les raisons de troncature ne sont plus séparées par des virgules'),
  dansLigne(M, 'if (meta.tronque) {', 'meta.tronque', 'false', 'Markdown : la troncature n\'est pas dite'),
  dansLigne(H, 'if (!meta.tronque) return', '!meta.tronque', 'false', 'HTML : la page dit une troncature qui n\'a pas eu lieu'),
  dansLigne(H, 'if (!meta.tronque) return', "return ''", 'return \'<p></p>\'', 'HTML : une page sans troncature porte un bloc vide'),
  dansLigne(H, 'return `<p class="motif-verdict motif-partiel">', 'motif-verdict motif-partiel', 'avertissement', 'HTML : la troncature n\'a plus le poids d\'un audit partiel'),
  dansLigne(H, 'return `<p class="motif-verdict motif-partiel">', "echapper(raisonsDeTroncature(meta.tronque).join(', '))", "raisonsDeTroncature(meta.tronque).join(', ')", 'HTML : les raisons de troncature ne sont pas échappées'),
  [H, '  ${blocMotif(notation)}\n\n  ${blocTroncature(meta)}\n', '  ${blocMotif(notation)}\n\n', 'HTML : la troncature n\'est pas affichée'],
);

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [
    { nom: 'essais bornés de la file de la fermeture', fichiers: TESTS_BORNES },     // d'abord : une file sans garde contre les cycles boucle sans fin, et la suite qui suit ne finirait que par une erreur de V8 ou par le délai
    { nom: 'tests de la surface et des chargements de code', fichiers: TESTS },
  ],
  exigerChromium: false,
  partie,
  delaiMs: 90_000,                                                // un mutant qui ferait boucler autre chose que la file y serait tué par le délai, dit comme tel
});
