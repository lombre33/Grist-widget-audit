#!/usr/bin/env node
/**
 * Rejoue les mutants des plafonds qui deviennent des constats bloquants : le fichier que l'outil n'a pas
 * lu (trop gros, plafond cumulé atteint, lecture refusée, extension de binaire chargée comme du code), chaque
 * plafond d'inventaire (fichiers, octets, dossiers exclus listés, résolutions, arêtes de document), l'imbrication
 * de code littéral au-delà de la profondeur lue, les axes que chacun empêche et l'ordre dans lequel l'outil le
 * dit. Chaque mutant pose, sur la ligne qui porte le choix, le défaut plausible : un des essais doit alors échouer
 * (méthode : `scripts/lib/rejouer-mutants.mjs`). Aucun navigateur n'est requis.
 *
 * Usage : node scripts/mutants-plafonds.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import fs from 'node:fs';
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const I = 'src/contexte/inventaire.js';
const S = 'src/regles/c-surface.js';
const C = 'src/regles/c-securite.js';
const T = 'src/moteur/statique.js';
const TESTS = ['tests/plafonds-surface.test.mjs'];
/** Les essais de la lecture du CSS, où la borne des feuilles `data:` a les siens (une vingtaine de secondes : après les autres). */
const TESTS_CSS = ['tests/passe-html-css.test.mjs'];

// Le déplacement de l'appel, du dernier rang au premier : une seule chaîne, lue dans le code pour que le lot suive les commentaires qui changent.
const DEBUT_STATIQUE = '  const constats = [];\n';
const APPEL_SURFACE = '  constats.push(...analyserSurface(ctx));\n';
const source = fs.readFileSync(new URL('../src/moteur/statique.js', import.meta.url), 'utf8');
const debutRegion = source.indexOf(DEBUT_STATIQUE, source.indexOf('export async function analyseStatique'));
const finRegion = source.indexOf(APPEL_SURFACE, debutRegion) + APPEL_SURFACE.length;
const STATIQUE_AVANT = debutRegion >= 0 && finRegion > debutRegion ? source.slice(debutRegion, finRegion) : 'introuvable';
const STATIQUE_APRES = STATIQUE_AVANT === 'introuvable' ? 'introuvable' : `${DEBUT_STATIQUE}${APPEL_SURFACE}${STATIQUE_AVANT.slice(DEBUT_STATIQUE.length, -APPEL_SURFACE.length)}`;

const MUTANTS = [
  // --- un fichier que l'outil ne lit pas parce qu'il est trop gros
  dansLigne(I, 'const binaire = BINAIRES.has(ext) ||', 'taille > maxFichier', 'taille >= maxFichier', 'fichier : un fichier de la taille exacte du plafond n\'est pas lu'),
  dansLigne(I, 'const binaire = BINAIRES.has(ext) ||', 'taille > maxFichier', 'false', 'fichier : plus rien n\'est trop gros pour être lu'),
  dansLigne(I, 'const maxFichier = etat.maxOctetsFichier', 'etat.maxOctetsFichier ?? ', '', 'fichier : le plafond par fichier demandé n\'est pas pris'),
  dansLigne(I, 'if (taille > maxFichier && !BINAIRES.has(ext))', 'taille > maxFichier', 'taille >= maxFichier', 'fichier : un fichier de la taille exacte du plafond est dit non lu alors qu\'il est lu'),
  dansLigne(I, 'if (taille > maxFichier && !BINAIRES.has(ext))', ' && !BINAIRES.has(ext)', '', 'fichier : une image trop grosse est dite un fichier de texte non lu'),
  dansLigne(I, 'if (taille > maxFichier && !BINAIRES.has(ext))', '{ cause: \'taille\' }', '{ cause: \'cumul\' }', 'fichier : la cause d\'un fichier trop gros est fausse'),
  dansLigne(I, 'if (taille > maxFichier && !BINAIRES.has(ext))', 'f.nonLu = { cause: \'taille\' };', '', 'fichier : un fichier trop gros n\'est pas dit non lu'),

  // --- le plafond d'octets cumulés : le fichier qui n'a pas pu être lu
  dansLigne(I, 'if (etat.octetsLus + taille >', 'taille >', 'taille >=', 'cumul : un fichier qui tient exactement dans le plafond n\'est pas lu'),
  dansLigne(I, 'if (etat.octetsLus + taille >', 'etat.maxOctetsCumules ?? ', '', 'cumul : le plafond cumulé demandé n\'est pas pris'),
  dansLigne(I, "f.nonLu = { cause: 'cumul' };", "f.nonLu = { cause: 'cumul' };", '', 'cumul : le fichier qui dépasse le plafond cumulé n\'est pas dit non lu'),
  dansLigne(I, "f.nonLu = { cause: 'lecture' }", "f.nonLu = { cause: 'lecture' };", '', 'lecture : un fichier dont la lecture échoue n\'est pas dit non lu'),
  dansLigne(I, 'if (BINAIRES.has(ext)) return null;', 'BINAIRES.has(ext)', 'false', 'lecture : une image dont la taille ne se lit pas est dite non lue'),
  dansLigne(I, "return { chemin: rel, ext, taille: 0, binaire: true, code: CODE_WEB.has(ext)", "nonLu: { cause: 'lecture' }", 'nonLu: undefined', 'lecture : un fichier dont la taille ne se lit pas est tu'),

  // --- le plafond du nombre de fichiers, à la marche et à l'ouverture hors de l'inventaire
  dansLigne(I, 'if (acc.length >= (etat.maxFichiers', 'acc.length >= ', 'acc.length > ', 'fichiers : un fichier de plus que le plafond est inventorié'),
  dansLigne(I, 'if (acc.length >= (etat.maxFichiers', 'etat.maxFichiers ?? ', '', 'fichiers : le plafond de fichiers demandé n\'est pas pris'),
  dansLigne(I, 'if (fichiers.length >= (etat.maxFichiers', 'fichiers.length >= ', 'fichiers.length > ', 'fichiers : un fichier de plus que le plafond est ouvert hors de l\'inventaire'),
  dansLigne(I, 'if (fichiers.length >= (etat.maxFichiers', 'etat.maxFichiers ?? ', '', 'fichiers : le plafond de fichiers demandé n\'est pas pris hors de l\'inventaire'),
  dansLigne(I, 'if (fichiers.length >= (etat.maxFichiers', '{ etat.tronqueFichiers = true; return null; }', 'return null;', 'fichiers : l\'ouverture refusée au plafond ne se dit pas'),
  dansLigne(I, '  } catch { return null; }', 'catch { return null; }', 'catch { etat.tronqueFichiers ||= fichiers.length >= (etat.maxFichiers ?? MAX_FICHIERS); return null; }', 'fichiers : une adresse qui ne mène à aucun fichier lève le plafond'),
  dansLigne(I, 'if (!statut.isFile()) return null;', 'return null;', '{ etat.tronqueFichiers ||= fichiers.length >= (etat.maxFichiers ?? MAX_FICHIERS); return null; }', 'fichiers : une adresse qui mène à un dossier lève le plafond'),

  // --- la fiche que l'inventaire garde du fichier non lu
  dansLigne(I, 'const commeCode = nonLusParCode.has(f.chemin);', 'nonLusParCode.has(f.chemin)', 'false', 'non lus : un fichier chargé comme du code n\'est pas reconnu'),
  dansLigne(I, 'if (f.nonLu) nonLus.push(', 'code: f.code || commeCode', 'code: f.code', 'non lus : un fichier de données chargé comme du code reste une donnée'),
  dansLigne(I, 'if (f.nonLu) nonLus.push(', 'code: f.code || commeCode', 'code: commeCode', 'non lus : un fichier de code que rien ne charge est une donnée'),
  dansLigne(I, 'if (f.nonLu) nonLus.push(', 'code: f.code || commeCode', 'code: true', 'non lus : tout fichier non lu est du code'),
  dansLigne(I, 'if (f.nonLu) nonLus.push(', 'cause: f.nonLu.cause', "cause: 'taille'", 'non lus : la cause dite est toujours la taille'),
  dansLigne(I, 'if (f.nonLu) nonLus.push(', 'dossierExclu: Boolean(f.dossierExclu)', 'dossierExclu: false', 'non lus : un fichier d\'un dossier exclu n\'est pas dit tel'),
  dansLigne(I, 'else if (commeCode) nonLus.push(', 'else if (commeCode)', 'else if (false)', 'non lus : une extension de binaire chargée comme du code n\'est pas dite'),
  dansLigne(I, 'else if (commeCode) nonLus.push(', "cause: 'extension'", "cause: 'taille'", 'non lus : la cause d\'une extension de binaire est fausse'),
  dansLigne(I, 'else if (commeCode) nonLus.push(', 'code: true', 'code: false', 'non lus : une extension de binaire chargée comme du code est une donnée'),
  dansLigne(I, 'else if (commeCode) nonLus.push(', 'dossierExclu: Boolean(f.dossierExclu)', 'dossierExclu: false', 'non lus : un binaire chargé d\'un dossier exclu n\'est pas dit tel'),
  dansLigne(I, 'const plafonds = { octets: maxOctetsCumules', 'octetsFichier: maxOctetsFichier', 'octetsFichier: MAX_OCTETS_FICHIER', 'plafonds : le plafond par fichier dit n\'est pas celui qui s\'applique'),
  dansLigne(I, 'const plafonds = { octets: maxOctetsCumules', 'octets: maxOctetsCumules', 'octets: MAX_OCTETS_LUS_CUMULES', 'plafonds : le plafond cumulé dit n\'est pas celui qui s\'applique'),

  // --- ce qui se charge comme du code (et non comme une image, une police ou une feuille de style)
  dansLigne(I, "const commeCode = objet && Boolean(ref.commeCode);", 'Boolean(ref.commeCode)', 'true', 'code chargé : tout lien est un chargement de code'),
  dansLigne(I, "const commeCode = objet && Boolean(ref.commeCode);", 'Boolean(ref.commeCode)', 'false', 'code chargé : aucun lien n\'est un chargement de code'),
  dansLigne(I, 'if (trouver(candidat)) liste.push(', 'position, commeCode', 'position', 'code chargé : l\'arête ne dit pas qu\'elle charge du code'),
  dansLigne(I, 'const code = new Set(file);', 'new Set(file)', 'new Set()', 'code chargé : une page d\'entrée n\'est pas chargée comme une page'),
  dansLigne(I, 'if (commeCode) code.add(chemin);', 'if (commeCode) ', '', 'code chargé : tout fichier atteint est chargé comme du code'),
  dansLigne(I, 'mettre(arete.cible, arete.commeCode)', 'arete.commeCode', 'false', 'code chargé : la balise script ne charge pas du code'),
  dansLigne(I, 'for (const chemin of lister(arete.dossier)) mettre(chemin, true);', 'mettre(chemin, true)', 'mettre(chemin, false)', 'code chargé : un module d\'un préfixe d\'import map n\'est pas chargé comme du code'),
  dansLigne(I, 'if (code.has(rel)) nonLus.parCode.add(rel);', 'if (code.has(rel)) ', '', 'code chargé : une image atteinte par un lien est dite chargée comme du code'),
  dansLigne(I, 'if (f.binaire) { if (nonLus) binaires.push(rel); continue; }', 'if (f.binaire) { if (nonLus) binaires.push(rel); continue; }', 'if (nonLus) binaires.push(rel); if (f.binaire) continue;', 'code chargé : tout fichier lu est dit non lu'),
  dansLigne(I, 'if (code.has(rel)) nonLus.parCode.add(rel);', 'nonLus.parCode.add(rel)', 'void 0', 'code chargé : le fichier non lu n\'est pas noté'),
  dansLigne(I, 'const surface = atteints(null, entrees, relevesNonLus);', ', relevesNonLus', '', 'code chargé : la surface de la page ne relève pas les fichiers non lus'),
  dansLigne(I, 'nonLus.atteints.add(rel);', 'nonLus.atteints.add(rel);', '', 'atteint : un fichier non lu que la page charge n\'est pas dit atteint'),
  dansLigne(I, 'const atteint = nonLusAtteints.has(f.chemin);', 'nonLusAtteints.has(f.chemin)', 'true', 'atteint : un fichier non lu que aucune page ne charge est dit atteint'),
  dansLigne(I, 'const atteint = nonLusAtteints.has(f.chemin);', 'nonLusAtteints.has(f.chemin)', 'false', 'atteint : un fichier non lu que la page charge est dit non atteint'),
  dansLigne(I, 'if (f.nonLu) nonLus.push(', 'commeCode, atteint,', 'commeCode, atteint: true,', 'atteint : tout fichier non lu, même celui que rien ne charge, est dit atteint'),
  dansLigne(I, 'if (f.nonLu) nonLus.push(', 'commeCode, atteint,', 'commeCode, atteint: false,', 'atteint : aucun fichier non lu n\'est dit atteint'),
  dansLigne(I, 'else if (commeCode) nonLus.push(', 'commeCode, atteint,', 'commeCode, atteint: false,', 'atteint : une extension de binaire chargée comme du code est dite non atteinte'),
  dansLigne(I, 'for (const ch of s.chargements) if (ch.execute) local(', 'commeCode: true', 'commeCode: false', 'code chargé : une balise script ne charge pas du code'),
  dansLigne(I, 'const reserves = { dansTemplate: s.dansTemplate, seulementStandard: s.seulementStandard, position: s.debut, commeCode: true };', 'commeCode: true', 'commeCode: false', 'code chargé : un script de la page ne charge pas du code'),
  dansLigne(I, 'const reserves = { dansTemplate: e.dansTemplate', 'commeCode: true', 'commeCode: false', 'code chargé : une import map ne charge pas du code'),
  dansLigne(I, "typeof ref === 'string' ? { relatif: ref, commeCode: true }", '{ relatif: ref, commeCode: true }', '{ relatif: ref }', 'code chargé : un import d\'un fichier de code ne charge pas du code'),
  dansLigne(I, "typeof ref === 'string' ? { relatif: ref, commeCode: true }", '{ ...ref, commeCode: true }', '{ ...ref }', 'code chargé : un worker d\'un fichier de code ne charge pas du code'),

  // --- le budget des arêtes de document et ce que le contexte en dit
  dansLigne(I, 'const calculerTronque = () =>', '|| documentsEpuises())', ')', 'tronque : le budget d\'arêtes de document épuisé ne tronque rien'),
  dansLigne(I, 'documents: documentsEpuises()', 'documents: documentsEpuises()', 'documents: false', 'tronque : le budget d\'arêtes de document épuisé ne se dit pas'),
  dansLigne(I, 'get tronque() { return calculerTronque(); }', 'get tronque() { return calculerTronque(); }', 'tronque: calculerTronque()', 'tronque : dit une fois pour toutes à la construction, avant que l\'axe E ait demandé les graphes'),
  dansLigne(I, 'documentsEpuises: () => budgetDocuments.restant < 0', 'restant < 0', 'restant <= 0', 'tronque : un budget d\'arêtes dépensé exactement est dit épuisé'),

  // --- le constat de chaque plafond
  dansLigne(S, 'if (!t[p.drapeau]) continue;', 'if (!t[p.drapeau]) continue;', '', 'plafond : tous les plafonds sont dits dès qu\'un est atteint'),
  dansLigne(S, 'if (!t[p.drapeau]) continue;', 'if (!t[p.drapeau])', 'if (t[p.drapeau])', 'plafond : seuls les plafonds non atteints sont dits'),
  dansLigne(S, '  if (t) {', 'if (t)', 'if (false)', 'plafond : aucun plafond atteint n\'est dit'),
  dansLigne(S, "regle: 'C-SURFACE-01', axe: 'C'", "severite: 'critique'", "severite: 'majeur'", 'plafond : un plafond atteint n\'est que majeur'),
  dansLigne(S, "regle: 'C-SURFACE-01', axe: 'C'", "confiance: 'certain'", "confiance: 'probable'", 'plafond : un plafond atteint n\'est que probable'),
  dansLigne(S, "regle: 'C-SURFACE-01', axe: 'C'", "axe: 'C'", "axe: 'E'", 'plafond : un plafond atteint est rangé dans l\'axe E'),
  dansLigne(S, 'axesEmpeches: TOUS_LES_AXES_STATIQUES,', 'TOUS_LES_AXES_STATIQUES', 'AXES_DU_CODE_EXECUTE', 'plafond : un plafond atteint n\'empêche ni A ni B'),
  dansLigne(S, 'axesEmpeches: TOUS_LES_AXES_STATIQUES,', 'TOUS_LES_AXES_STATIQUES', '[]', 'plafond : un plafond atteint n\'empêche aucun axe'),
  dansLigne(S, 'preuve: { plafond: p.drapeau }', 'plafond: p.drapeau', '', 'plafond : le plafond atteint n\'est pas nommé dans la preuve'),
  dansLigne(S, 'titre: (t) => `Plus de ${nombre(t.maxFichiers)} fichiers', 't.maxFichiers', 't.maxOctets', 'plafond : le titre des fichiers dit le plafond des octets'),
  dansLigne(S, 'titre: (t) => `Plus de ${Math.round(t.maxOctets', 't.maxOctets / 1024 / 1024', 't.maxOctets', 'plafond : le titre des octets ne les dit pas en Mio'),
  dansLigne(S, 'titre: (t) => `Plus de ${nombre(t.maxEntreesListees)}', 't.maxEntreesListees', 't.maxFichiers', 'plafond : le titre du listage dit le plafond des fichiers'),
  dansLigne(S, "titre: (t) => `Plus de ${nombre(t.maxResolutions)}", 't.maxResolutions', 't.maxPasDocuments', 'plafond : le titre des résolutions dit le plafond des arêtes'),
  dansLigne(S, "titre: (t) => `Plus de ${nombre(t.maxPasDocuments)}", 't.maxPasDocuments', 't.maxResolutions', 'plafond : le titre des arêtes dit le plafond des résolutions'),
  dansLigne(S, 'constat: (t) => `Le dépôt compte plus de ${nombre(t.maxFichiers)}', 't.maxFichiers', 't.maxOctets', 'plafond : le constat des fichiers dit le plafond des octets'),
  dansLigne(S, "constat: (t) => `L'outil a lu ${Math.round(t.maxOctets", 't.maxOctets / 1024 / 1024', 't.maxOctets', 'plafond : le constat des octets ne les dit pas en Mio'),
  dansLigne(S, "s'est arrêté à ${nombre(t.maxEntreesListees)} entrées", 't.maxEntreesListees', 't.maxFichiers', 'plafond : le constat du listage dit le plafond des fichiers'),
  dansLigne(S, "L'outil a fait ${nombre(t.maxResolutions)} résolutions", 't.maxResolutions', 't.maxPasDocuments', 'plafond : le constat des résolutions dit le plafond des arêtes'),
  dansLigne(S, "L'outil a parcouru ${nombre(t.maxPasDocuments)} arêtes", 't.maxPasDocuments', 't.maxResolutions', 'plafond : le constat des arêtes dit le plafond des résolutions'),
  dansLigne(S, "const nombre = (n) =>", "' ')", "',')", 'plafond : les nombres se lisent avec une virgule'),
  dansLigne(S, "const nombre = (n) =>", '\\B(?=(\\d{3})+(?!\\d))', '\\B(?=(\\d{2})+(?!\\d))', 'plafond : les nombres se groupent par deux chiffres'),

  // --- les tailles, à l'unité qui les rend lisibles
  dansLigne(S, 'if (octets >= 1024 * 1024) return', 'octets >= 1024 * 1024', 'octets > 1024 * 1024', 'taille : un Mio exact se dit en Kio'),
  dansLigne(S, 'if (octets >= 1024 * 1024) return', "(octets / 1024 / 1024).toFixed(1)", '(octets / 1024 / 1024).toFixed(0)', 'taille : les Mio n\'ont pas de décimale'),
  dansLigne(S, 'if (octets >= 1024 * 1024) return', ".replace('.', ',')", '', 'taille : les Mio s\'écrivent avec un point'),
  dansLigne(S, 'if (octets >= 1024) return', 'octets >= 1024', 'octets > 1024', 'taille : un Kio exact se dit en octets'),
  dansLigne(S, 'if (octets >= 1024) return', '(octets / 1024).toFixed(1)', '(octets / 1024).toFixed(0)', 'taille : les Kio n\'ont pas de décimale'),
  dansLigne(S, 'if (octets >= 1024) return', ".replace('.', ',')", '', 'taille : les Kio s\'écrivent avec un point'),

  dansLigne(I, 'if (tronque.documents) raisons.push', 'tronque.documents', 'false', 'raisons : le budget d\'arêtes de document épuisé n\'est pas dit'),
  dansLigne(I, 'if (tronque.documents) raisons.push', 'tronque.maxPasDocuments', 'tronque.maxResolutions', 'raisons : le budget d\'arêtes de document dit le plafond des résolutions'),

  // --- les fichiers non lus : lesquels, dans quel ordre, avec quels axes
  dansLigne(S, 'const nonLus = [...(ctx.nonLus ?? [])].sort(', 'b.taille - a.taille', 'a.taille - b.taille', 'fichiers non lus : les plus petits sont dits en premier'),
  dansLigne(S, 'const nonLus = [...(ctx.nonLus ?? [])].sort(', '(a.chemin < b.chemin ? -1 : 1)', '(a.chemin < b.chemin ? 1 : -1)', 'fichiers non lus : à taille égale, l\'ordre des noms est inversé'),
  dansLigne(S, 'const code = nonLus.filter(', '(n) => n.code', '(n) => !n.code', 'fichiers non lus : les données sont prises pour du code'),
  dansLigne(S, 'const code = nonLus.filter(', 'n.code && n.atteint', 'n.code', 'fichiers non lus : un fichier de code que aucune page n\'atteint est dit bloquant'),
  dansLigne(S, 'const code = nonLus.filter(', 'n.code && n.atteint', 'n.atteint', 'fichiers non lus : un fichier de données que la page atteint est pris pour du code'),
  dansLigne(S, 'const code = nonLus.filter(', 'n.code && n.atteint', 'n.code || n.atteint', 'fichiers non lus : tout fichier de code ou de données que la page atteint est dit bloquant'),
  dansLigne(S, 'const hors = nonLus.filter(', '!(n.code && n.atteint)', '!n.code', 'fichiers non lus : un fichier de code que aucune page n\'atteint n\'est dit nulle part'),
  dansLigne(S, 'const hors = nonLus.filter(', '!(n.code && n.atteint)', 'n.code', 'fichiers non lus : les données non lues ne sont dites nulle part'),
  dansLigne(S, 'const hors = nonLus.filter(', '!(n.code && n.atteint)', '!n.atteint', 'fichiers non lus : les données que la page atteint ne sont dites nulle part'),
  dansLigne(S, 'for (const n of code.slice(0, MAX_FICHIERS_DITS))', 'MAX_FICHIERS_DITS', 'MAX_FICHIERS_DITS - 1', 'fichiers non lus : le cinquantième n\'est pas dit un à un'),
  dansLigne(S, 'for (const n of code.slice(0, MAX_FICHIERS_DITS))', 'MAX_FICHIERS_DITS', 'MAX_FICHIERS_DITS + 1', 'fichiers non lus : le cinquante et unième est dit un à un'),
  dansLigne(S, 'if (code.length > MAX_FICHIERS_DITS) {', '>', '>=', 'fichiers non lus : cinquante fichiers sont regroupés comme s\'il y en avait plus'),
  dansLigne(S, 'const reste = code.slice(MAX_FICHIERS_DITS);', 'MAX_FICHIERS_DITS', 'MAX_FICHIERS_DITS + 1', 'fichiers non lus : le cinquante et unième n\'est ni dit seul ni regroupé'),
  dansLigne(S, 'constat: (n, p) => `Ce fichier fait', 'p.octetsFichier', 'p.octets', 'fichiers non lus : le plafond par fichier dit est celui du cumul'),
  dansLigne(S, "regle: 'C-SURFACE-02', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain', titre: n.taille ?", "severite: 'critique'", "severite: 'majeur'", 'fichiers non lus : un fichier de code non lu n\'est que majeur'),
  dansLigne(S, "regle: 'C-SURFACE-02', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain', titre: n.taille ?", "confiance: 'certain'", "confiance: 'probable'", 'fichiers non lus : un fichier de code non lu n\'est que probable'),
  dansLigne(S, "regle: 'C-SURFACE-02', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain', titre: n.taille ?", 'n.taille ?', 'true ?', 'fichiers non lus : un fichier de taille inconnue est dit de 0 octet'),
  dansLigne(S, 'axesEmpeches: axesDUnFichierNonLu(n),', 'axesDUnFichierNonLu(n)', 'TOUS_LES_AXES_STATIQUES', 'fichiers non lus : un fichier de bibliothèque empêche A et B'),
  dansLigne(S, 'axesEmpeches: axesDUnFichierNonLu(n),', 'axesDUnFichierNonLu(n)', '[]', 'fichiers non lus : un fichier non lu n\'empêche aucun axe'),
  dansLigne(S, 'preuve: { cause: n.cause, taille: n.taille, commeCode: n.commeCode }', 'commeCode: n.commeCode', '', 'fichiers non lus : la preuve ne dit pas si la page le charge comme du code'),
  dansLigne(S, 'fichier: n.chemin,', 'fichier: n.chemin,', '', 'fichiers non lus : le constat ne nomme pas le fichier', 'emplacements'),
  dansLigne(S, 'return !n.dossierExclu && !cheminVendorise(n.chemin) ?', '!n.dossierExclu && ', '', 'axes d\'un fichier non lu : un dossier de sortie de construction empêche A et B'),
  dansLigne(S, 'return !n.dossierExclu && !cheminVendorise(n.chemin) ?', '!cheminVendorise(n.chemin)', 'true', 'axes d\'un fichier non lu : une bibliothèque tierce empêche A et B'),
  dansLigne(S, 'return !n.dossierExclu && !cheminVendorise(n.chemin) ?', ': AXES_DU_CODE_EXECUTE', ': TOUS_LES_AXES_STATIQUES', 'axes d\'un fichier non lu : rien n\'exempte A et B'),
  dansLigne(S, "const AXES_DU_CODE_EXECUTE = ['B', 'C', 'E', 'F'];", "['B', 'C', 'E', 'F']", "['B', 'C', 'E']", 'axes d\'un fichier non lu : F n\'est pas empêché'),
  dansLigne(S, "const AXES_DU_CODE_EXECUTE = ['B', 'C', 'E', 'F'];", "['B', 'C', 'E', 'F']", "['B', 'C', 'F']", 'axes d\'un fichier non lu : E n\'est pas empêché'),
  dansLigne(S, "const AXES_DU_CODE_EXECUTE = ['B', 'C', 'E', 'F'];", "['B', 'C', 'E', 'F']", "['B', 'E', 'F']", 'axes d\'un fichier non lu : C n\'est pas empêché'),
  dansLigne(S, "const AXES_DU_CODE_EXECUTE = ['B', 'C', 'E', 'F'];", "['B', 'C', 'E', 'F']", "['C', 'E', 'F']", 'axes d\'un fichier non lu : B n\'est pas empêché'),
  dansLigne(S, "const TOUS_LES_AXES_STATIQUES = ['A', 'B', 'C', 'E', 'F'];", "['A', 'B', 'C', 'E', 'F']", "['A', 'B', 'C', 'E']", 'axes empêchés : F n\'est pas empêché par un plafond'),
  dansLigne(S, "const TOUS_LES_AXES_STATIQUES = ['A', 'B', 'C', 'E', 'F'];", "['A', 'B', 'C', 'E', 'F']", "['A', 'B', 'C', 'F']", 'axes empêchés : E n\'est pas empêché par un plafond'),
  dansLigne(S, 'const axes = [\'A\', \'B\', \'C\', \'E\', \'F\'].filter(', 'reste.some((n) => axesDUnFichierNonLu(n).includes(a))', 'true', 'fichiers non lus : le groupe empêche A et B même s\'il ne contient que des bibliothèques'),
  dansLigne(S, 'const axes = [\'A\', \'B\', \'C\', \'E\', \'F\'].filter(', 'reste.some(', 'reste.every(', 'fichiers non lus : le groupe n\'empêche A et B que si tous ses fichiers sont du contributeur'),
  dansLigne(S, 'axesEmpeches: axes,', ': axes,', ': [],', 'fichiers non lus : le groupe n\'empêche aucun axe'),
  dansLigne(S, "regle: 'C-SURFACE-02', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain', titre: reste.length", "severite: 'critique'", "severite: 'majeur'", 'fichiers non lus : le groupe n\'est que majeur'),
  dansLigne(S, "regle: 'C-SURFACE-02', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain', titre: reste.length", 'reste.length === 1', 'false', 'fichiers non lus : un seul fichier regroupé se dit au pluriel'),
  dansLigne(S, "preuve: { emplacements: reste.map(", 'cause: n.cause, ', '', 'fichiers non lus : la liste du groupe ne dit pas la cause de chacun'),
  dansLigne(S, 'if (hors.length) {', 'hors.length', 'true', 'fichiers hors surface : un constat est dit même sans fichier non lu hors surface'),
  dansLigne(S, "regle: 'C-SURFACE-02', axe: 'C', severite: 'info'", "severite: 'info'", "severite: 'mineur'", 'fichiers hors surface : un fichier non lu que la page n\'exécute pas pèse dans la note'),
  dansLigne(S, 'hors.slice(0, 5).map(', 'slice(0, 5)', 'slice(0, 6)', 'fichiers hors surface : six fichiers sont nommés'),
  dansLigne(S, "hors.length > 5 ? '…' : ''", '> 5', '>= 5', 'fichiers hors surface : cinq fichiers sont dits abrégés'),
  dansLigne(S, "hors.length > 5 ? '…' : ''", "'…'", "''", 'fichiers hors surface : la liste abrégée ne le dit pas'),
  dansLigne(S, 'preuve: { emplacements: hors.map(', 'hors.map(', 'hors.slice(0, 5).map(', 'fichiers hors surface : la preuve ne liste que cinq fichiers'),
  dansLigne(S, 'titre: `${nombre(hors.length)} fichier(s) non lus', '${nombre(hors.length)}', '${nombre(code.length)}', 'fichiers hors surface : le titre compte les fichiers de code bloquants'),

  // --- l'imbrication de code littéral
  dansLigne(C, "titre: 'Imbrication de code littéral trop profonde pour être auditée'", "severite: 'critique'", "severite: 'majeur'", 'imbrication : le code lu au-delà de la profondeur n\'est que majeur'),
  dansLigne(C, "titre: 'Imbrication de code littéral trop profonde pour être auditée'", "confiance: 'certain'", "confiance: 'a_verifier'", 'imbrication : le code non lu au-delà de la profondeur est à vérifier'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'E', 'F'],", "['B', 'C', 'E', 'F']", "['C']", 'imbrication : l\'imbrication n\'empêche que C'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'E', 'F'],", "['B', 'C', 'E', 'F']", "['B', 'C', 'F']", 'imbrication : l\'imbrication n\'empêche pas E'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'E', 'F'],", "['B', 'C', 'E', 'F']", "['B', 'C', 'E']", 'imbrication : l\'imbrication n\'empêche pas F'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'E', 'F'],", "['B', 'C', 'E', 'F']", "['C', 'E', 'F']", 'imbrication : l\'imbrication n\'empêche pas B'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'E', 'F'],", "['B', 'C', 'E', 'F']", "['B', 'E', 'F']", 'imbrication : l\'imbrication n\'empêche pas C'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'E', 'F'],", "['B', 'C', 'E', 'F']", '[]', 'imbrication : l\'imbrication n\'empêche aucun axe'),
  dansLigne(C, 'if (profondeur >= MAX_PROFONDEUR_CODE_IMBRIQUE) {', '>=', '>', 'imbrication : un niveau de plus que la profondeur est lu sans rien dire'),
  dansLigne(C, 'while (frontiere.length && profondeur <= MAX_PROFONDEUR_CODE_IMBRIQUE)', '<=', '<', 'imbrication : le dernier niveau n\'est pas relu pour dire qu\'il est trop profond'),
  dansLigne(C, 'const MAX_PROFONDEUR_CODE_IMBRIQUE = 5;', '5', '6', 'imbrication : la profondeur lue est de six niveaux'),
  dansLigne(C, 'const MAX_PROFONDEUR_CODE_IMBRIQUE = 5;', '5', '4', 'imbrication : la profondeur lue est de quatre niveaux'),

  // --- les feuilles de style `data:` imbriquées au-delà de ce que l'outil lit
  dansLigne(C, "regle: 'C-EXFIL-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',", "severite: 'critique'", "severite: 'info'", 'feuilles data: la borne atteinte n\'est qu\'une information'),
  dansLigne(C, "regle: 'C-EXFIL-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',", "severite: 'critique'", "severite: 'majeur'", 'feuilles data: la borne atteinte n\'est que majeure'),
  dansLigne(C, "regle: 'C-EXFIL-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',", "confiance: 'certain'", "confiance: 'probable'", 'feuilles data: la borne atteinte n\'est que probable'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'F'],", "['B', 'C', 'F']", "['C', 'F']", 'feuilles data: la borne atteinte n\'empêche pas B'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'F'],", "['B', 'C', 'F']", "['B', 'F']", 'feuilles data: la borne atteinte n\'empêche pas C'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'F'],", "['B', 'C', 'F']", "['B', 'C']", 'feuilles data: la borne atteinte n\'empêche pas F'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'F'],", "['B', 'C', 'F']", "['A', 'B', 'C', 'E', 'F']", 'feuilles data: la borne atteinte empêche A et E, que la feuille ne nourrit pas'),
  dansLigne(C, "axesEmpeches: ['B', 'C', 'F'],", "['B', 'C', 'F']", '[]', 'feuilles data: la borne atteinte n\'empêche aucun axe'),

  // --- l'ordre où l'outil dit ce qu'il n'a pas lu
  dansLigne(T, 'constats.push(...analyserSurface(ctx));', 'constats.push(...analyserSurface(ctx));', '', 'statique : ce que l\'outil n\'a pas lu ne se dit pas'),
  [T, STATIQUE_AVANT, STATIQUE_APRES, 'statique : ce que l\'outil n\'a pas lu se dit avant toute règle, donc avant que le budget d\'arêtes de document ait été demandé'],
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests des plafonds', fichiers: TESTS }, { nom: 'tests de la lecture du CSS', fichiers: TESTS_CSS }],
  exigerChromium: false,
  partie,
});
