#!/usr/bin/env node
/**
 * Rejoue les mutants du verdict « protégé » des chargements de code distant (méthode :
 * `scripts/lib/rejouer-mutants.mjs`). Chaque mutant réintroduit UN défaut :
 *   - les cartes d'import : quelle valeur s'applique quand deux clés ou deux cartes nomment
 *     l'adresse (la dernière clé, la première carte), ce qui compte comme empreinte, la
 *     position de la carte, les entrées qu'une carte antérieure protège ;
 *   - les `<link rel="modulepreload">` : ce qu'ils brisent (lus avant la carte, attribut
 *     `integrity` vide ou mal formé), ce qu'ils ne brisent pas ;
 *   - le verdict partagé (`contexte/imports-distants.js`) : l'état de chaque page (absente,
 *     tardive, garantie), les raisons, les workers et leur adresse inconnue, le chargeur
 *     d'un littéral passé à `eval`, les pages qui chargent un fichier ;
 *   - E-DEP-01 et C-EXFIL-01/03 : ce qu'ils disent et la sévérité qu'ils en tirent ;
 *   - le graphe du document (`contexte/inventaire.js`) : l'ordre des balises, ce qu'une autre
 *     page ou un worker n'apporte pas, le budget d'arêtes.
 * Aucun navigateur n'est requis ; le différentiel Chromium
 * (`tests/e-dep-imports-chromium.test.mjs`) fait dire les mêmes faits au navigateur, il se joue à part.
 *
 * Mutants équivalents, laissés de côté parce que aucun test ne peut les distinguer :
 *   - `carte <= s.debut` → `carte < s.debut` dans `protectionDeLaBalise` (la carte et la balise sont deux balises, leurs décalages diffèrent) ;
 *   - `carteDeLEmpreinte !== undefined &&` (`undefined <= n` est faux) et le `undefined` de `lienQuiBriseLEmpreinte` (sans carte, `sri` est faux) ;
 *   - les gardes de `raisonsEntreeNonProtegee` (`e.sri`, `e.carte === undefined` : la liste est vide de toute façon) ;
 *   - les mémoïsations (`protegeesParPage`, `liensParPage`, `positionsDeDocument`, `protection ??=`) : elles n'ont d'effet que sur le temps ;
 *   - `pagesHtml.length === 1` : pour une seule page, chaque fichier atteint est dans son document (ou son graphe est inconnu, et `?? true` compte alors la page).
 *   - `cle !== null &&` devant `etatsParAdresse.has(cle)` : aucune entrée n'a la clé `null` (l'écriture est gardée de même), `Map.has(null)` est faux ;
 *   - `i < a.length &&` dans le choix de `fusionnerLesPages` : `a[i]` vaut `undefined` quand la liste est épuisée, `undefined < n` est faux, et la branche prise est la même ;
 *   - le `break` qui suit un budget épuisé dans `etatDesPages` : chaque page suivante refuse de même son pas et rend le même état, seul le temps change.
 *   - la lecture de l'adresse d'un lien par ses usages (`usage.urls[0]` vaut `attributs.get('href')` pour un modulepreload) ;
 *   - `Number.isFinite(unite.debut)` et `Number.isFinite(couvrante.debut)` quand le fichier est une page : ses unités sont des scripts écrits dedans, tous ont un décalage (la garde protège d'un décalage absent, qui vaudrait « avant la carte ») ;
 *   - la garde de tête de `raisonsEntreeNonProtegee`, qui rend la liste vide d'une entrée sans carte ou protégée : les deux lignes suivantes la rendent vide de toute façon.
 *
 * Usage : node scripts/mutants-e-dep-imports.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import fs from 'node:fs';
import path from 'node:path';
import { lireArguments, rejouerMutants, RACINE } from './lib/rejouer-mutants.mjs';

const J = 'src/moteur/analyse-js.js';
const P = 'src/moteur/page-html.js';
const D = 'src/contexte/imports-distants.js';
const E = 'src/regles/e-dependances.js';
const S = 'src/regles/c-securite.js';
const I = 'src/contexte/inventaire.js';
const TESTS = ['tests/e-dep-imports.test.mjs', 'tests/e-dep-imports-contextes.test.mjs', 'tests/e-dep-imports-ordre.test.mjs'];

const lire = (fichier) => fs.readFileSync(path.join(RACINE, fichier), 'utf8');
/** La ligne entière du fichier qui contient `motif`, si une seule le contient (sinon le script s'arrête : un mutant ne se pose pas au hasard). */
function ligne(fichier, motif, sans = null) {
  const trouvees = lire(fichier).split('\n').filter((l) => l.includes(motif) && !(sans && l.includes(sans)));
  if (trouvees.length !== 1) throw new Error(`${fichier} : « ${motif} »${sans ? ` sans « ${sans} »` : ''} se trouve sur ${trouvees.length} lignes, il en faut une`);
  return trouvees[0];
}
/** Un mutant qui remplace, dans la ligne unique contenant `motif` (et pas `sans`), `de` par `par`. */
function dansLigne(fichier, motif, de, par, libelle, sans = null) {
  const l = ligne(fichier, motif, sans);
  if (!l.includes(de)) throw new Error(`${fichier} : « ${de} » ne figure pas dans la ligne de « ${motif} »`);
  return [fichier, l, l.replace(de, par), libelle];
}

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [];

// --- les cartes d'import : ce qui s'applique, ce qui protège -----------------------------------------------------
MUTANTS.push(
  dansLigne(J, 'for (const [href, valeur] of propres) if (!valeurs.has(href))', 'if (!valeurs.has(href)) ', '', 'cartes : la dernière carte qui nomme l\'adresse s\'applique (la première doit)'),
  dansLigne(J, "if (url && typeof valeur === 'string') propres.set(url.href, valeur);", 'propres.set(url.href, valeur)', 'propres.has(url.href) || propres.set(url.href, valeur)', 'clés : la première clé qui se résout à l\'adresse s\'applique (la dernière doit)'),
  dansLigne(J, "if (url && typeof valeur === 'string') propres.set(url.href, valeur);", "url && typeof valeur === 'string'", 'url', 'clés : une valeur qui n\'est pas une chaîne nomme l\'adresse'),
  dansLigne(J, "if (url && typeof valeur === 'string') propres.set(url.href, valeur);", "url && typeof valeur === 'string'", "typeof valeur === 'string'", 'clés : une clé qui n\'est pas une adresse est prise pour une adresse'),
  dansLigne(J, "const integrites = carte && typeof carte.integrity === 'object' && carte.integrity ? carte.integrity : {};", " && carte.integrity ? carte.integrity", ' ? carte.integrity', 'clés : integrity: null casse la lecture'),
  dansLigne(J, "const integrites = carte && typeof carte.integrity === 'object' && carte.integrity ? carte.integrity : {};", 'carte && typeof', 'typeof', 'clés : une carte qui n\'est pas un objet casse la lecture'),
  dansLigne(J, 'return new Map([...valeurs].filter(', '([, { valeur }]) => integriteProtege(valeur)', '() => true', 'valeur : une empreinte mal formée protège'),
  dansLigne(J, 'valeurs.set(href, { valeur, position: s.debut })', 'position: s.debut', 'position: 0', 'position : la carte est toujours lue au début de la page'),
  dansLigne(J, 'const carteDeLEmpreinte = resolue === null ? undefined : protegees.get(resolue.href);', 'resolue === null ? undefined : ', '', 'entrée : une adresse qui ne se résout pas casse la lecture'),
  dansLigne(J, 'entrees.push({ spec, url, sri: carteDeLEmpreinte !== undefined', ' && carteDeLEmpreinte <= s.debut', '', 'entrée : une carte lue après l\'entrée la protège'),
  dansLigne(J, 'entrees.push({ spec, url, sri: carteDeLEmpreinte !== undefined', 'carteDeLEmpreinte <= s.debut', 'carteDeLEmpreinte < s.debut', 'entrée : l\'empreinte de la carte qui déclare l\'entrée ne la protège pas'),
  dansLigne(J, 'entrees.push({ spec, url, sri: carteDeLEmpreinte !== undefined', ' && !lien,', ',', 'entrée : un lien modulepreload de l\'adresse ne brise pas l\'empreinte'),
  dansLigne(J, 'entrees.push({ spec, url, sri: carteDeLEmpreinte !== undefined', 'carte: carteDeLEmpreinte, lien,', 'carte: undefined, lien,', 'entrée : la carte qui porte l\'empreinte n\'est pas dite'),
  dansLigne(J, 'entrees.push({ spec, url, sri: carteDeLEmpreinte !== undefined', 'carte: carteDeLEmpreinte, lien,', 'carte: carteDeLEmpreinte, lien: undefined,', 'entrée : le lien qui brise l\'empreinte n\'est pas dit'),
  dansLigne(J, 'entrees.push({ spec, url, sri: carteDeLEmpreinte !== undefined', 'index: s.debut,', 'index: 0,', 'entrée : le décalage de la carte n\'est plus celui de la carte'),
  dansLigne(J, "inline: true, module: s.genre === 'module'", 'debut: s.debut', 'debut: null', 'unité : un script écrit dans la page perd son décalage'),
  dansLigne(P, 'entree.positionDe = (decalage) => positionDe(entree.fin + decalage);', 'positionDe(entree.fin + decalage);', '{ const p = positionDe(entree.fin + decalage); return { ligne: p.ligne - (positionDe(entree.fin).ligne - entree.ligne), colonne: p.colonne }; };', 'unité : la ligne d\'un import en ligne est décalée du nombre de lignes de la balise <script qui s\'étend sur plusieurs lignes'),
);

// --- les liens modulepreload --------------------------------------------------------------------------------------
MUTANTS.push(
  dansLigne(J, "if (r.nom !== 'link' || r.dansTemplate) continue;", " || r.dansTemplate", '', 'modulepreload : un lien dans un <template> compte'),
  dansLigne(J, "if (r.nom !== 'link' || r.dansTemplate) continue;", "r.nom !== 'link' || ", '', 'modulepreload : une image ou une iframe est prise pour un lien'),
  dansLigne(J, "if (usage.genre !== 'modulepreload') continue;", "usage.genre !== 'modulepreload'", 'false', 'modulepreload : un preload ou un prefetch brise l\'empreinte'),
  dansLigne(J, "if (usage.genre !== 'modulepreload') continue;", "usage.genre !== 'modulepreload'", "usage.genre === 'modulepreload'", 'modulepreload : seul ce qui n\'est pas un modulepreload compte'),
  dansLigne(J, 'const url = urlDe(usage.urls[0], r.baseBrute, cheminPage);', 'r.baseBrute', 'null', 'modulepreload : la <base> qui précède le lien est ignorée'),
  dansLigne(J, 'if (!url) continue;', 'if (!url) continue;', '', 'modulepreload : une adresse illisible casse la lecture', 'if (!url) continue;\n'),
  dansLigne(J, 'const vus = parAdresse.get(url.href) ??', 'parAdresse.get(url.href) ?? ', '', 'modulepreload : seul le dernier lien d\'une adresse est gardé comme premier'),
  dansLigne(J, 'const lien = { debut: r.debut,', 'debut: r.debut', 'debut: 0', 'modulepreload : un lien est toujours lu avant la carte'),
  dansLigne(J, 'const lien = { debut: r.debut,', 'ligne: r.ligne', 'ligne: 0', 'modulepreload : la ligne du lien n\'est pas dite'),
  dansLigne(J, 'const lien = { debut: r.debut,', "attribut: r.attributs.has('integrity')", 'attribut: false', 'modulepreload : un attribut integrity vide ou mal formé n\'est pas vu'),
  dansLigne(J, "if (integriteProtege(r.attributs.get('integrity'))) continue;", "integriteProtege(r.attributs.get('integrity'))", 'false', 'modulepreload : un lien à empreinte bien formée brise l\'empreinte de la carte'),
  dansLigne(J, 'if (lien.attribut) vus.attributMal ??= lien;', 'if (lien.attribut) ', '', 'modulepreload : un lien lu sans attribut passe pour un attribut mal formé'),
  dansLigne(J, 'if (lien.attribut) vus.attributMal ??= lien;', 'vus.attributMal ??= lien', 'vus.attributMal = lien', 'modulepreload : c\'est le dernier attribut mal formé qui est dit, non le premier'),
  dansLigne(J, 'if (liens.premier.attribut || liens.premier.debut < carte) return liens.premier;', 'liens.premier.debut < carte', 'liens.premier.debut > carte', 'modulepreload : seul un lien lu après la carte la brise'),
  dansLigne(J, 'return liens.attributMal ?? undefined;', 'liens.attributMal ?? undefined', 'undefined', 'modulepreload : un attribut vide ou mal formé n\'emporte pas sur la carte lue avant lui'),
  dansLigne(J, 'if (!liens) return undefined;', 'if (!liens) return undefined;', '', 'modulepreload : une adresse sans lien casse la lecture'),
);

// --- le verdict partagé ----------------------------------------------------------------------------------------------
MUTANTS.push(
  dansLigne(D, 'const cle = racine && !estPage(racine) ?', 'racine && !estPage(racine) ?', 'false ?', 'états : une adresse importée deux fois par un même fichier est évaluée deux fois'),
  dansLigne(D, 'const cle = racine && !estPage(racine) ?', '!estPage(racine)', 'estPage(racine)', 'états : l\'état d\'un import écrit dans une page est partagé, celui d\'un fichier ne l\'est pas'),
  dansLigne(D, 'const cle = racine && !estPage(racine) ?', 'racine.chemin}\\0${url.href}', 'racine.chemin}\\0', 'états : toutes les adresses d\'un même fichier partagent le premier état calculé'),
  dansLigne(D, 'const cle = racine && !estPage(racine) ?', 'racine.chemin}\\0${url.href}', 'url.href}', 'états : toutes les racines partagent l\'état d\'une adresse'),
  dansLigne(D, 'if (ctx.depenserPasDocuments && !ctx.depenserPasDocuments(1))', 'ctx.depenserPasDocuments && ', '', 'budget : un contexte sans budget casse la lecture'),
  dansLigne(D, 'if (ctx.depenserPasDocuments && !ctx.depenserPasDocuments(1))', '!ctx.depenserPasDocuments(1)', 'false', 'budget : une page évaluée ne coûte rien'),
  dansLigne(D, 'if (ctx.depenserPasDocuments && !ctx.depenserPasDocuments(1))', 'depenserPasDocuments(1)', 'depenserPasDocuments(0)', 'budget : une page évaluée coûte 0'),
  dansLigne(D, 'if (ctx.depenserPasDocuments && !ctx.depenserPasDocuments(1))', 'epuise: true', 'epuise: false', 'budget : le budget épuisé n\'est pas dit'),
  dansLigne(D, 'etat.vues++;', 'etat.vues++;', '', 'pages : les pages évaluées ne sont pas comptées'),
  dansLigne(D, 'if (chargement.url.origin === ORIGINE_LOCALE) return;', 'chargement.url.origin === ORIGINE_LOCALE', 'false', 'lecteur : un import d\'un fichier du widget est retenu (un objet gardé par import)'),
  dansLigne(D, 'if (chargement.url.origin === ORIGINE_LOCALE) return;', '=== ORIGINE_LOCALE', '!== ORIGINE_LOCALE', 'lecteur : seul un import du widget est retenu, les autres sont écartés'),
  dansLigne(D, 'let etat = { vues: 0, absente: false, tardive: null, epuise: false };', 'absente: false', 'absente: true', 'états : un fichier est d\'abord dit sans empreinte'),
  dansLigne(D, 'if (vu && vu.longueur === ctx.fichiers.length) return vu.resultat;', 'vu.longueur === ctx.fichiers.length', 'true', 'verdict : un fichier ajouté à l\'inventaire n\'est pas relu'),
  dansLigne(D, 'if (vu && vu.longueur === ctx.fichiers.length) return vu.resultat;', 'vu && vu.longueur === ctx.fichiers.length', 'false', 'verdict : le résultat est recalculé à chaque appel'),
  dansLigne(D, 'const pagesHtml = ctx.fichiers.filter(', 'f.executee && ', '', 'pages : une page que personne n\'ouvre est un chargeur'),
  dansLigne(D, 'const desWorkers = ctx.surfaceDesWorkers ?', 'ctx.surfaceDesWorkers ? ctx.surfaceDesWorkers() : new Set()', 'new Set()', 'workers : la surface des workers n\'est pas lue'),
  dansLigne(D, 'while (racine?.litteralImbrique && racine.origineReelle && !vus.has(racine.chemin)) {', ' && !vus.has(racine.chemin)', '', 'eval : un littéral qui tourne en rond boucle sans fin'),
  dansLigne(D, 'while (racine?.litteralImbrique && racine.origineReelle && !vus.has(racine.chemin)) {', 'racine?.litteralImbrique && ', '', 'eval : un fichier réel est pris pour un littéral'),
  dansLigne(D, 'if (racine.executeParUnWorker) worker = true;', 'worker = true', 'worker = worker', 'eval : le code d\'un littéral passé à un worker n\'est pas dit exécuté par un worker'),
  dansLigne(D, 'ligneOrigine = racine.origineReelle.ligne;', 'racine.origineReelle.ligne', 'null', 'eval : la ligne de l\'appel d\'origine est perdue'),
  dansLigne(D, 'return { racine, worker: worker || (racine ?', 'worker || (racine ? desWorkers.has(racine.chemin) : false)', 'worker', 'workers : un fichier que la page charge et qu\'un worker exécute n\'est pas dit exécuté par un worker'),
  dansLigne(D, 'return { racine, worker: worker || (racine ?', 'racine ? desWorkers.has(racine.chemin) : false', 'desWorkers.has(racine.chemin)', 'workers : un littéral d\'origine perdue casse la lecture'),
  dansLigne(D, 'if (!estPage(racine)) {', '!estPage(racine)', 'estPage(racine)', 'chargeur : un fichier et une page s\'échangent'),
  dansLigne(D, 'return Number.isFinite(debut) ? debut : null;', 'Number.isFinite(debut) ? debut : null', 'debut', 'chargeur : un fichier que seul un lien mène (sans position) a une position'),
  dansLigne(D, 'const debut = ctx.debutDeChargement?.(page.chemin, racine.chemin);', '?.(', '(', 'chargeur : un contexte sans graphe de document casse la lecture'),
  dansLigne(D, 'if (fichier === racine) return Number.isFinite(unite.debut) ? unite.debut : null;', 'fichier === racine', 'true', 'chargeur : un littéral prend le décalage de son propre fichier'),
  dansLigne(D, 'if (unites[milieu].finLigne < ligne) bas = milieu + 1;', 'finLigne < ligne', 'finLigne <= ligne', 'chargeur : un appel sur la dernière ligne d\'un script n\'est pas couvert par lui'),
  dansLigne(D, 'if (unites[milieu].finLigne < ligne) bas = milieu + 1;', 'bas = milieu + 1', 'bas = milieu', 'chargeur : la recherche du script couvrant ne finit pas (un appel après le premier script)'),
  dansLigne(D, 'return unite && unite.debutLigne <= ligne ? unite : undefined;', 'unite.debutLigne <= ligne', 'unite.debutLigne < ligne', 'chargeur : un appel sur la première ligne d\'un script n\'est pas couvert par lui'),
  dansLigne(D, 'return unite && unite.debutLigne <= ligne ? unite : undefined;', 'unite && unite.debutLigne <= ligne', 'unite', 'chargeur : un appel avant le script suivant est attribué à ce script'),
  dansLigne(D, 'if (!racine) return [];', 'if (!racine) return [];', '', 'pages : un fichier d\'origine perdue casse la lecture'),
  dansLigne(D, 'if (estPage(racine)) return [racine];', 'if (estPage(racine)) return [racine];', '', 'pages : une page qui en lit une autre est le document de ses scripts'),
  dansLigne(D, 'if (!document) { inconnues.push(rang); return; }', 'inconnues.push(rang); ', '', 'pages : un graphe de document inconnu n\'a pas de page chargeuse'),
  dansLigne(D, 'if (!document) { inconnues.push(rang); return; }', '!document', 'document === undefined', 'pages : un graphe de document inconnu (null) est lu comme un document'),
  dansLigne(D, 'if (pagesHtml.length === 1 || !ctx.surfaceDuDocument) return pagesHtml;', ' || !ctx.surfaceDuDocument', '', 'pages : un contexte sans graphe de document casse la lecture'),
  dansLigne(D, 'return fusionnerLesPages(pagesHtml,', 'indexDesPages.connues.get(racine.chemin) ?? []', '[]', 'pages : les pages dont le document atteint le fichier ne sont pas des chargeurs'),
  dansLigne(D, 'return fusionnerLesPages(pagesHtml,', 'indexDesPages.inconnues', '[]', 'pages : les pages de graphe inconnu ne sont pas des chargeurs'),
  dansLigne(D, 'if (rangs) rangs.push(rang); else connues.set(chemin, [rang]);', 'rangs.push(rang)', 'connues.set(chemin, [rang])', 'pages : une page prend la place de celles qui atteignent déjà le fichier'),
  dansLigne(D, 'if (rangs) rangs.push(rang); else connues.set(chemin, [rang]);', 'if (rangs) ', 'if (false) ', 'pages : chaque fichier n\'a que la dernière page qui l\'atteint'),
  dansLigne(D, 'while (i < a.length || j < b.length) yield pages[', 'i < a.length || j < b.length', 'i < a.length && j < b.length', 'pages : la liste s\'arrête quand l\'une des deux est finie'),
  dansLigne(D, 'while (i < a.length || j < b.length) yield pages[', 'a[i] < b[j]', 'a[i] > b[j]', 'pages : les pages de graphe inconnu passent avant celles qui atteignent le fichier'),
  dansLigne(D, 'while (i < a.length || j < b.length) yield pages[', 'j >= b.length || ', '', 'pages : la liste lit une page inconnue qui n\'existe pas'),
  dansLigne(D, 'const resolu = categorie === ', "categorie === 'chemin-local' || ", '', 'workers : une adresse locale écrite en littéral n\'est pas résolue'),
  dansLigne(D, 'const resolu = categorie === ', "categorie === 'url-absolue' || ", '', 'workers : une adresse absolue écrite en littéral n\'est pas résolue'),
  dansLigne(D, 'const resolu = categorie === ', "(categorie === 'code-en-chaine' && extraireCodeLitteralWorker(argument) !== null)", "categorie === 'code-en-chaine'", 'workers : un code en chaîne dont on ne sait rien est pris pour résolu'),
  dansLigne(D, 'const resolu = categorie === ', "(categorie === 'code-en-chaine' && extraireCodeLitteralWorker(argument) !== null)", 'false', 'workers : un code en chaîne lu est pris pour non résolu'),
  dansLigne(D, 'NewExpression(n) {', '(Worker|SharedWorker)', '(Worker)', 'workers : un SharedWorker à adresse inconnue n\'est pas vu'),
  dansLigne(D, 'NewExpression(n) {', '(Worker|SharedWorker)', '(SharedWorker)', 'workers : un Worker à adresse inconnue n\'est pas vu'),
  dansLigne(D, 'NewExpression(n) {', 'n.arguments[0]', 'n.arguments[1]', 'workers : l\'adresse d\'un worker est lue sur le mauvais argument'),
  dansLigne(D, 'if (NOM_ENREGISTREMENT.test(nom) || NOM_MODULE_DE_WORKLET.test(nom))', 'NOM_ENREGISTREMENT.test(nom) || ', '', 'workers : un service worker à adresse inconnue n\'est pas vu'),
  dansLigne(D, 'if (NOM_ENREGISTREMENT.test(nom) || NOM_MODULE_DE_WORKLET.test(nom))', ' || NOM_MODULE_DE_WORKLET.test(nom)', '', 'workers : un worklet à adresse inconnue n\'est pas vu'),
  dansLigne(D, 'if (NOM_ENREGISTREMENT.test(nom) || NOM_MODULE_DE_WORKLET.test(nom))', 'noterWorker(fichier, ligneDe(n), n.arguments[0])', 'noterWorker(fichier, ligneDe(n), n.arguments[1])', 'workers : l\'adresse d\'un service worker ou d\'un worklet est lue sur le mauvais argument', 'NewExpression'),
  dansLigne(D, 'const lieuDuWorker = workersNonResolus.length ?', 'workersNonResolus[0].fichier}, ligne ${workersNonResolus[0].ligne}', 'workersNonResolus[workersNonResolus.length - 1].fichier}, ligne ${workersNonResolus[workersNonResolus.length - 1].ligne}', 'workers : le worker cité est le dernier et non le premier'),
  dansLigne(D, 'if (carte === undefined) { etat.absente = true; break; }', 'etat.absente = true', 'etat.absente = false', 'états : une page sans empreinte n\'est pas dite sans empreinte'),
  dansLigne(D, 'if (carte === undefined) { etat.absente = true; break; }', 'break;', 'continue;', 'états : la première page sans empreinte n\'arrête pas l\'évaluation'),
  dansLigne(D, 'if (carte === undefined) { etat.absente = true; break; }', 'if (carte === undefined)', 'if (carte === null)', 'états : une page sans empreinte casse la lecture de la balise'),
  dansLigne(D, 'const carteAvantChargeur = chargeur !== null && carte <= chargeur;', 'chargeur !== null && ', '', 'états : un chargeur inconnu est lu comme le début de la page'),
  dansLigne(D, 'const carteAvantChargeur = chargeur !== null && carte <= chargeur;', 'carte <= chargeur', 'carte < chargeur', 'états : la carte qui est aussi le chargeur ne précède pas'),
  dansLigne(D, 'if (!carteAvantChargeur || lien) etat.tardive ??=', ' || lien', '', 'états : un lien modulepreload de l\'adresse ne brise pas l\'empreinte'),
  dansLigne(D, 'if (!carteAvantChargeur || lien) etat.tardive ??=', '!carteAvantChargeur || ', '', 'états : une carte lue après le chargeur ne brise pas l\'empreinte'),
  dansLigne(D, 'if (!carteAvantChargeur || lien) etat.tardive ??=', '??=', '=', 'états : la dernière page où l\'empreinte ne s\'applique pas est dite, non la première'),
  dansLigne(D, 'if (!carteAvantChargeur || lien) etat.tardive ??=', 'etat.tardive ??=', 'etat.tardive ??= etat.tardive &&', 'états : une page où l\'empreinte ne s\'applique pas n\'est pas retenue'),
  dansLigne(D, 'const parLaPage = !etat.epuise && etat.vues > 0 && !etat.absente && !etat.tardive;', '!etat.epuise && ', '', 'pages : un budget épuisé après des pages protégées suffit à protéger'),
  dansLigne(D, 'const parLaPage = !etat.epuise && etat.vues > 0 && !etat.absente && !etat.tardive;', 'etat.vues > 0 && ', '', 'pages : un fichier qu\'aucune page ne charge est protégé'),
  dansLigne(D, 'const parLaPage = !etat.epuise && etat.vues > 0 && !etat.absente && !etat.tardive;', '!etat.absente && ', '', 'pages : une page sans empreinte à côté de pages protégées ne retire rien'),
  dansLigne(D, 'const parLaPage = !etat.epuise && etat.vues > 0 && !etat.absente && !etat.tardive;', ' && !etat.tardive', '', 'pages : une empreinte qui ne s\'applique pas suffit à protéger'),
  dansLigne(D, 'if (!tardive || etat.absente) return [RAISON_SANS_EMPREINTE];', ' || etat.absente', '', 'raisons : une page sans empreinte à côté d\'une page tardive n\'est pas dite'),
  dansLigne(D, 'if (etat.epuise) return [RAISON_BUDGET_EPUISE];', 'if (etat.epuise) return [RAISON_BUDGET_EPUISE];', '', 'raisons : un budget épuisé n\'est pas dit'),
  dansLigne(D, 'if (!tardive || etat.absente) return [RAISON_SANS_EMPREINTE];', '!tardive || ', '', 'raisons : une page sans empreinte casse la lecture'),
  dansLigne(D, '...(tardive.carteAvantChargeur ? [] :', 'tardive.carteAvantChargeur ? [] :', 'false ? [] :', 'raisons : la carte lue avant le chargeur est dite tardive'),
  dansLigne(D, '...(tardive.carteAvantChargeur ? [] :', 'tardive.chargeur === null ? RAISON_CHARGEUR_INCONNU : ', '', 'raisons : un chargeur inconnu n\'est pas dit'),
  dansLigne(D, '...(tardive.carteAvantChargeur ? [] :', 'tardive.chargeur === null ? RAISON_CHARGEUR_INCONNU : ', 'false ? RAISON_CHARGEUR_INCONNU : ', 'raisons : un chargeur inconnu casse la lecture des lignes'),
  dansLigne(D, '...(tardive.lien ? [raisonLienDePrechargement(', 'tardive.lien ? [', 'false ? [', 'raisons : le lien modulepreload qui brise l\'empreinte n\'est pas dit'),
  dansLigne(D, "if (worker) return { sri: false, raisons: [RAISON_WORKER], obstacle: 'worker' };", 'if (worker)', 'if (false)', 'obstacle : un fichier exécuté par un worker n\'est pas dit tel'),
  dansLigne(D, "if (worker) return { sri: false, raisons: [RAISON_WORKER], obstacle: 'worker' };", 'sri: false', 'sri: true', 'worker : un fichier exécuté par un worker est dit protégé'),
  dansLigne(D, "if (worker) return { sri: false, raisons: [RAISON_WORKER], obstacle: 'worker' };", 'raisons: [RAISON_WORKER]', 'raisons: []', 'raisons : un fichier exécuté par un worker ne dit pas pourquoi l\'empreinte ne le protège pas'),
  dansLigne(D, "if (worker) return { sri: false, raisons: [RAISON_WORKER], obstacle: 'worker' };", "obstacle: 'worker'", 'obstacle: null', 'obstacle : le worker n\'est pas dit obstacle'),
  dansLigne(D, "const obstacle = workersNonResolus.length ? 'worker-non-resolu' : null;", "workersNonResolus.length ? 'worker-non-resolu' : null", 'null', 'obstacle : un worker d\'adresse inconnue n\'est pas un obstacle'),
  dansLigne(D, '...(parLaPage ? [] : raisonsNonProtegee()),', 'parLaPage ? [] : raisonsNonProtegee()', 'raisonsNonProtegee()', 'raisons : un chargement protégé dit qu\'il ne l\'est pas'),
  dansLigne(D, '...(parLaPage ? [] : raisonsNonProtegee()),', 'parLaPage ? [] : raisonsNonProtegee()', '[]', 'raisons : un chargement non protégé ne dit pas pourquoi'),
  dansLigne(D, '...(obstacle ? [raisonWorkerNonResolu(lieuDuWorker)] : []),', 'obstacle ? [raisonWorkerNonResolu(lieuDuWorker)] : []', '[]', 'raisons : un worker d\'adresse inconnue n\'est pas dit'),
  dansLigne(D, 'return { sri: parLaPage && !obstacle, raisons, obstacle };', ' && !obstacle', '', 'sri : un worker d\'adresse inconnue n\'ôte pas la protection'),
  dansLigne(D, 'return { sri: parLaPage && !obstacle, raisons, obstacle };', 'raisons, obstacle', 'raisons, obstacle: null', 'sri : l\'obstacle n\'est pas dit'),
  dansLigne(D, '...(e.carte > e.index ?', 'e.carte > e.index', 'e.carte >= e.index', 'entrée : la carte qui déclare l\'entrée est dite lue après elle'),
  dansLigne(D, '...(e.carte > e.index ?', 'e.carte > e.index ? [raisonEntreeCarteTardive(lue.positionDe(e.carte).ligne)] : []', '[]', 'entrée : une carte lue après l\'entrée n\'est pas dite'),
  dansLigne(D, '...(e.lien ? [raisonLienDePrechargement(', 'e.lien ? [', 'false ? [', 'entrée : le lien qui brise l\'empreinte n\'est pas dit'),
  dansLigne(D, "export const raisonLienDePrechargement = (ligneCarte, lien) => lien.attribut", 'lien.attribut', '!lien.attribut', 'raison du lien : les deux cas (lu avant la carte, attribut vide) s\'échangent'),
  dansLigne(D, 'lienQuiBrise: (page, href, carte) =>', 'liensDe(page).get(href), carte', 'liensDe(page).get(href), 0', 'lienQuiBrise : la carte est lue au début de la page'),
);

// --- E-DEP-01 ---------------------------------------------------------------------------------------------------------
MUTANTS.push(
  dansLigne(E, "if (integriteProtege(s.attributs.get('integrity'))) return { sri: true, raisons: [] };", "integriteProtege(s.attributs.get('integrity'))", 'false', 'balise : un attribut integrity bien formé ne protège pas'),
  dansLigne(E, "if (s.genre !== 'module' || c.seulementStandard || s.attributs.has('integrity')) return sansEmpreinte;", "s.genre !== 'module' || ", '', 'balise : la carte couvre un script classique'),
  dansLigne(E, "if (s.genre !== 'module' || c.seulementStandard || s.attributs.has('integrity')) return sansEmpreinte;", 'c.seulementStandard || ', '', 'balise : la carte couvre une balise que Chromium n\'exécute pas'),
  dansLigne(E, "if (s.genre !== 'module' || c.seulementStandard || s.attributs.has('integrity')) return sansEmpreinte;", " || s.attributs.has('integrity')", '', 'balise : la carte est consultée quand un attribut integrity vide est présent'),
  dansLigne(E, 'if (carte === undefined) return sansEmpreinte;', 'if (carte === undefined) return sansEmpreinte;', '', 'balise : une balise sans carte casse la lecture'),
  dansLigne(E, '...(carte <= s.debut ? [] :', 'carte <= s.debut ? [] : [raisonCarteTardiveBalise(lue.positionDe(carte).ligne, s.ligne)]', '[]', 'balise : une carte lue après la balise n\'est pas dite'),
  dansLigne(E, '...(carte <= s.debut ? [] :', 'carte <= s.debut ? [] :', 'false ? [] :', 'balise : une carte lue avant la balise est dite tardive'),
  dansLigne(E, '...(lien ? [raisonLienDePrechargement(', 'lien ? [', 'false ? [', 'balise : le lien modulepreload qui brise l\'empreinte n\'est pas dit'),
  dansLigne(E, 'if (!causes.length) return', 'return { sri: true, raisons: [], parLaCarte: true }', 'return { sri: true, raisons: [] }', 'balise : l\'empreinte portée par la carte n\'est pas dite'),
  dansLigne(E, 'return { sri: false, raisons: [`${RAISON_SANS_INTEGRITE} sur la balise, et ${causes.join', "causes.join(', et ')", 'causes[0]', 'balise : seule la première cause est dite'),
  dansLigne(E, 'ligne: lue.positionDe(e.index).ligne,', 'lue.positionDe(e.index).ligne', '1', 'entrée : le constat d\'une entrée d\'import map dit toujours la première ligne'),
  dansLigne(E, 'ligne: lue.positionDe(e.index).ligne,', 'lue.positionDe(e.index).ligne', 'lue.positionDe(e.index).ligne + 1', 'entrée : le constat d\'une entrée d\'import map dit la ligne suivante'),
  dansLigne(E, 'ligne: lue.positionDe(e.index).ligne,', 'e.index', 'e.debut', 'entrée : la ligne d\'une entrée est lue au début de la carte, pas à l\'entrée'),
  dansLigne(E, 'raisons: e.sri ? [] : e.carte === undefined ?', '[RAISON_SANS_INTEGRITE]', '[]', 'entrée : une entrée sans empreinte ne dit pas pourquoi'),
  dansLigne(E, 'raisons: e.sri ? [] : e.carte === undefined ?', 'raisonsEntreeNonProtegee(e, lue)', '[]', 'entrée : une empreinte qui ne s\'applique pas ne dit pas pourquoi'),
  dansLigne(E, 'for (const { noeud, canal, valeur, url, unite, fichier, ligne, protection } of importsDistants(ctx).imports) {', 'importsDistants(ctx).imports', '[]', 'import : les imports par adresse ne sont pas lus'),
  dansLigne(E, 'if (estLocalHote(url.hostname) || /grist-plugin-api\\.js/.test(valeur)) continue;', 'estLocalHote(url.hostname) || ', '', 'import : un import d\'une adresse locale est une dépendance distante'),
  dansLigne(E, 'if (estLocalHote(url.hostname) || /grist-plugin-api\\.js/.test(valeur)) continue;', " || /grist-plugin-api\\.js/.test(valeur)", '', 'import : le script de Grist est une dépendance à figer'),
  dansLigne(E, 'const { sri, raisons, obstacle } = protection();', 'protection()', '{ sri: false, raisons: [], obstacle: null }', 'import : la protection n\'est pas lue'),
  dansLigne(E, 'severite: !d.sri ?', "!d.sri ? 'critique' : 'majeur'", "'critique'", 'sévérité : un chargement protégé reste critique'),
  dansLigne(E, 'severite: !d.sri ?', 'bloquant: !d.sri', 'bloquant: true', 'sévérité : un chargement protégé reste bloquant'),
  dansLigne(E, 'if (!d.sri) problemes.push(...d.raisons);', 'if (!d.sri) problemes.push(...d.raisons);', '', 'constat : les raisons ne sont pas dites'),
  dansLigne(E, 'constat: `Le widget charge', "d.canal ? ` par ${CANAL_DE_CODE[d.canal]}` : ''", "''", 'constat : le canal du chargement n\'est pas dit'),
  dansLigne(E, 'constat: `Le widget charge', "problemes.length ? ` — ${problemes.join(', ')}` : ''", "''", 'constat : les problèmes ne sont pas dits'),
  dansLigne(E, 'constat: `Le widget charge', "d.parLaCarte ? \" Son empreinte est portée par la clé `integrity` d'une import map de la page, lue avant cette balise.\" : ''", "''", 'constat : l\'empreinte portée par la carte n\'est pas dite'),
  dansLigne(E, 'remediation: !d.canal', '!d.canal', 'false', 'remédiation : un script à balise se corrige comme un import'),
  dansLigne(E, ': d.obstacle === \'worker\'', "d.obstacle === 'worker'", 'false', 'remédiation : un worker se corrige comme un module de la page'),
  dansLigne(E, '${d.obstacle === \'worker-non-resolu\' ?', "d.obstacle === 'worker-non-resolu'", 'false', 'remédiation : l\'adresse du worker n\'est pas à écrire en littéral'),
  dansLigne(E, 'const protection = protectionDeLaBalise(', 'lienQuiBrise });', '});', 'balise : les liens modulepreload ne sont pas passés à la lecture', 'function'),
);

// --- C-EXFIL-01 et C-EXFIL-03 -------------------------------------------------------------------------------------
MUTANTS.push(
  dansLigne(S, 'const { sri, raisons, obstacle } = chargeDuCode && protection ? protection()', 'chargeDuCode && protection', 'false', 'C-EXFIL-01 : la protection n\'est pas lue'),
  dansLigne(S, 'const bloquant = !dynamique && !sri;', ' && !sri', '', 'C-EXFIL-01 : un chargement protégé reste bloquant'),
  dansLigne(S, 'severite: dynamique || sri ?', 'dynamique || sri', 'dynamique', 'C-EXFIL-01 : un chargement protégé reste critique'),
  dansLigne(S, '? `Le widget charge et exécute du code depuis', "raisons.length ? ` — non protégé : ${raisons.join(', ')}.` : '.'", "'.'", 'C-EXFIL-01 : les raisons ne sont pas dites'),
  dansLigne(S, '? `Le widget charge et exécute du code depuis', "${sri ? \" ; l'empreinte de la clé `integrity` d'une import map de la page fige ce code, un remplacement est refusé par le navigateur.\" :", '${sri ? "" :', 'C-EXFIL-01 : l\'empreinte qui fige le code n\'est pas dite'),
  dansLigne(S, "? obstacle === 'worker'", "obstacle === 'worker'", 'false', 'C-EXFIL-01 : un worker se corrige comme un module de la page'),
  dansLigne(S, 'constat: precise(`L\'import map fait résoudre', 'e.carte === undefined ?', 'false ?', 'C-EXFIL-03 : une entrée dont l\'empreinte est brisée dit qu\'il n\'y en a pas'),
  dansLigne(S, 'constat: precise(`L\'import map fait résoudre', 'raisonsEntreeNonProtegee(e, lirePage(f.contenu)).join(\', \')', "''", 'C-EXFIL-03 : les raisons de l\'empreinte brisée ne sont pas dites'),
  dansLigne(S, 'constat: precise(`L\'import map fait résoudre', 'e.sri ? " (couverte par la clé `integrity` de l\'import map)"', "e.sri ? ''", 'C-EXFIL-03 : l\'empreinte qui couvre l\'entrée n\'est pas dite'),
  dansLigne(S, "severite: e.sri ? 'majeur' : 'critique', bloquant: !e.sri,", "bloquant: !e.sri", 'bloquant: true', 'C-EXFIL-03 : une entrée protégée reste bloquante'),
);

// --- le graphe du document -----------------------------------------------------------------------------------------
MUTANTS.push(
  dansLigne(I, 'const { surface, mentions, partiel, surfaceDuDocument, debutDeChargement, surfaceDesWorkers, pasDocuments, depenserPasDocuments } = calculerSurface(', ', { maxResolutions, maxPasDocuments })', ', { maxResolutions })', 'budget : le plafond des arêtes de document demandé n\'est pas transmis à la fermeture'),
  dansLigne(I, 'export function calculerSurface(', 'maxPasDocuments = MAX_PAS_DOCUMENTS', 'maxPasDocuments = 0', 'budget : la fermeture n\'a par défaut aucune arête de document'),
  dansLigne(I, 'export function construireContexte(racine, {', 'maxPasDocuments = MAX_PAS_DOCUMENTS', 'maxPasDocuments = 0', 'budget : un contexte n\'a par défaut aucune arête de document'),
  dansLigne(I, 'const budgetDocuments = { restant: maxPasDocuments };', 'restant: maxPasDocuments', 'restant: 0', 'budget : le budget des arêtes de document est vide au départ'),
  dansLigne(I, 'const pasDocuments = () => maxPasDocuments - budgetDocuments.restant;', 'maxPasDocuments - budgetDocuments.restant', 'budgetDocuments.restant', 'budget : les arêtes parcourues sont comptées à l\'envers'),
  dansLigne(I, 'const depenserPasDocuments = (pas) => (budgetDocuments.restant -= pas) >= 0;', '>= 0', '> 0', 'budget : un pas qui épuise juste le budget est refusé'),
  dansLigne(I, 'const depenserPasDocuments = (pas) => (budgetDocuments.restant -= pas) >= 0;', 'restant -= pas', 'restant -= 0', 'budget : une page évaluée ne consomme pas le budget'),
  dansLigne(I, 'const depenserPasDocuments = (pas) => (budgetDocuments.restant -= pas) >= 0;', '>= 0', '>= -Infinity', 'budget : un pas est toujours accordé'),
  dansLigne(I, 'return { surface, mentions, partiel: budget.epuise, surfaceDuDocument,', 'pasDocuments, depenserPasDocuments }', 'pasDocuments }', 'budget : le budget des pages évaluées n\'est pas rendu par la surface'),
  dansLigne(I, 'return { racine, fichiers, entrees, surface, surfaceDuDocument,', 'pasDocuments, depenserPasDocuments, paquet', 'pasDocuments, paquet', 'budget : le contexte n\'offre pas le budget des pages évaluées'),
  dansLigne(I, 'if (!racine || racine.binaire) return positions;', '!racine || ', '', 'document : une page absente casse la lecture'),
  dansLigne(I, 'if ((budgetDocuments.restant -= aretes(page).length + 1) < 0) return null;', '< 0', '<= 0', 'budget : une page qui épuise juste le budget est refusée'),
  dansLigne(I, 'if ((budgetDocuments.restant -= aretes(page).length + 1) < 0) return null;', ' + 1', ' + 0', 'budget : le fichier lui-même ne coûte rien (page)'),
  dansLigne(I, 'if ((budgetDocuments.restant -= aretes(page).length + 1) < 0) return null;', 'restant -=', 'restant +=', 'budget : la page ne consomme pas le budget'),
  dansLigne(I, 'if ((budgetDocuments.restant -= aretes(rel).length + 1) < 0) return null;', '< 0', '<= 0', 'budget : un fichier qui épuise juste le budget est refusé'),
  dansLigne(I, 'if ((budgetDocuments.restant -= aretes(rel).length + 1) < 0) return null;', ' + 1', ' + 0', 'budget : le fichier lui-même ne coûte rien (fichier)'),
  dansLigne(I, 'if ((budgetDocuments.restant -= aretes(rel).length + 1) < 0) return null;', 'restant -=', 'restant +=', 'budget : un fichier ne consomme pas le budget'),
  dansLigne(I, 'const departs = aretes(page).filter((arete) => !arete.worker).sort(', '.filter((arete) => !arete.worker)', '', 'document : un worker créé par la page est dans son document'),
  dansLigne(I, 'const departs = aretes(page).filter((arete) => !arete.worker).sort(', '.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))', '', 'document : les balises sont visitées dans l\'ordre de leur liste, pas du document'),
  dansLigne(I, 'const departs = aretes(page).filter((arete) => !arete.worker).sort(', '(a.position ?? Infinity) - (b.position ?? Infinity)', '(b.position ?? Infinity) - (a.position ?? Infinity)', 'document : les balises sont visitées de la dernière à la première'),
  dansLigne(I, 'const departs = aretes(page).filter((arete) => !arete.worker).sort(', '(a.position ?? Infinity)', '(a.position ?? 0)', 'document : une arête sans position passe avant les balises'),
  dansLigne(I, 'const position = depart.position ?? Infinity;', '?? Infinity', '?? 0', 'document : un lien sans position est une balise lue au début de la page'),
  dansLigne(I, 'if (!f || f.binaire) return;', 'if (!f || f.binaire) return;', 'if (!f) return;', 'document : un fichier binaire est un module'),
  dansLigne(I, 'positions.set(chemin, position);', 'position)', '0)', 'document : chaque fichier prend la position du début de la page'),
  dansLigne(I, 'if (vus.has(chemin)) return;', 'if (vus.has(chemin)) return;', '', 'document : un fichier déjà vu est relu (un cycle boucle sans fin)'),
  dansLigne(I, "if (['.html', '.htm'].includes(trouver(rel).ext)) continue;", "['.html', '.htm'].includes(trouver(rel).ext)", 'false', 'document : une autre page est lue dans le document de la première'),
  dansLigne(I, 'if (arete.worker) continue;', 'arete.worker', 'false', 'document : un worker créé par un module est dans le document', 'const'),
  dansLigne(I, 'if (arete.dossier === undefined) mettre(arete.cible); else lireDossier(arete.dossier);', 'else lireDossier(arete.dossier);', '', 'document : un dossier que charge un module n\'est pas lu'),
  dansLigne(I, 'if (depart.dossier === undefined) mettre(depart.cible); else lireDossier(depart.dossier);', 'else lireDossier(depart.dossier);', '', 'document : un dossier que charge la page n\'est pas lu'),
  dansLigne(I, 'surfacesDeDocument.set(page, positions === null ?', 'new Set([page, ...positions.keys()])', 'new Set([...positions.keys()])', 'document : la page n\'est pas dans son propre document'),
  dansLigne(I, 'surfacesDeDocument.set(page, positions === null ?', 'positions === null ? null :', 'false ? null :', 'document : un budget épuisé donne un document vide'),
  dansLigne(I, 'const debutDeChargement = (page, chemin) =>', '?? null', '?? 0', 'document : un fichier hors du document a une position (le début de la page)'),
  dansLigne(I, 'const debutDeChargement = (page, chemin) =>', 'positionsDuDocument(page)?.get', 'positionsDuDocument(page).get', 'document : un budget épuisé casse la lecture de la position'),
  dansLigne(I, 'for (const ch of s.chargements) if (ch.execute) local(ch.valeur, s.baseBrute,', 'position: s.debut', 'position: 0', 'arête : une balise qui charge un fichier n\'a pas son décalage'),
  dansLigne(I, 'const reserves = { dansTemplate: s.dansTemplate, seulementStandard: s.seulementStandard, position: s.debut };', 'position: s.debut', 'position: 0', 'arête : un fichier qu\'un script écrit dans la page charge n\'a pas le décalage de ce script'),
  dansLigne(I, 'const reserves = { dansTemplate: e.dansTemplate, seulementStandard: e.seulementStandard, position: e.index };', 'position: e.index', 'position: 0', 'arête : un fichier qu\'une entrée d\'import map désigne n\'a pas le décalage de la carte'),
  dansLigne(I, 'const propres = ref.worker ?', 'ref.worker ? { ...reserves, worker: true } : reserves', 'reserves', 'arête : un worker créé dans la page n\'est pas dit worker'),
  dansLigne(I, 'if (trouver(candidat)) liste.push({ cible: candidat, gabarit, standard, worker, position });', 'gabarit, standard, worker, position', 'gabarit, standard, position', 'arête : le fait qu\'un fichier soit chargé par un worker est perdu'),
  dansLigne(I, 'if (trouver(candidat)) liste.push({ cible: candidat, gabarit, standard, worker, position });', 'gabarit, standard, worker, position', 'gabarit, standard, worker', 'arête : la position de la balise est perdue'),
);

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests des imports distants (verdict, ordre, contextes)', fichiers: TESTS }],
  exigerChromium: false,
  partie,
  delaiMs: 90_000,                                                // un cycle sans garde boucle sans fin : ces mutants sont tués par le délai, dit comme tel
});
