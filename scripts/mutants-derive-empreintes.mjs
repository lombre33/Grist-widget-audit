#!/usr/bin/env node
/**
 * Rejoue les mutants du contrôle de dérive des empreintes
 * (`docker/ci/derive-empreintes.mjs`, `docker/ci/lib-images.mjs`) : chaque façon
 * de taire une dérive, d'en inventer une ou de dire « à jour » d'un registre qui
 * n'a rien dit est gardée par `tests/derive-empreintes.test.mjs` (méthode :
 * `scripts/lib/rejouer-mutants.mjs`). Pas de Chromium requis, pas de réseau : le
 * faux registre des tests est local.
 *
 * Non couvert, dit tel quel : le plafond de 30 s de chaque demande (`--max-time`),
 * qu'un test ne pourrait éprouver qu'en attendant 30 s un registre muet.
 *
 * Usage : node scripts/mutants-derive-empreintes.mjs [expression régulière sur le libellé]
 */
import { lireArguments, rejouerMutants, DOSSIERS_COPIES } from './lib/rejouer-mutants.mjs';

const D = 'docker/ci/derive-empreintes.mjs';
const L = 'docker/ci/lib-images.mjs';
const TESTS = ['tests/derive-empreintes.test.mjs', 'tests/images-epinglees.test.mjs'];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // Ce qui est dit d'une image
  [D, 'const memes = courante === ref.empreinte;', 'const memes = true;', 'une dérive n\'est jamais vue (toujours « à jour »)'],
  [D, 'const memes = courante === ref.empreinte;', 'const memes = false;', 'une dérive est inventée (jamais « à jour »)'],
  [D, "etat: memes ? 'a-jour' : 'derive'", "etat: memes ? 'derive' : 'a-jour'", 'états inversés'],
  [D, 'empreinteEpinglee: ref.empreinte, empreinteActuelle: courante,', 'empreinteEpinglee: courante, empreinteActuelle: ref.empreinte,', 'les deux empreintes échangées'],
  [D, 'imageActuelleConstruiteLe: await dateDeConstruction(fournisseur, ref.depot, courante)', 'imageActuelleConstruiteLe: null', 'la date de construction n\'est plus cherchée'],
  [D, "if (annotees.length) return annotees.at(-1);", "if (annotees.length) return annotees[0];", 'date : la plus ancienne au lieu de la plus récente'],
  // Ce qu'un registre muet ne doit jamais devenir
  [D, "if (statut !== 200 || !/^sha256:[0-9a-f]{64}$/.test(courante ?? '')) throw", 'if (false) throw', 'réponse inexploitable acceptée'],
  [D, "!/^sha256:[0-9a-f]{64}$/.test(courante ?? '')", '!(courante ?? \'\').startsWith(\'sha256:\')', 'empreinte mal formée acceptée'],
  [D, "resultats.push({ ...base, etat: 'erreur', erreur: String(e?.message ?? e)", "resultats.push({ ...base, etat: 'a-jour', erreur: String(e?.message ?? e)", 'une erreur devient « à jour »'],
  [D, "if (!ref?.etiquette) { resultats.push({ ...base, etat: 'erreur',", "if (!ref?.etiquette) { resultats.push({ ...base, etat: 'a-jour',", 'référence sans étiquette dite « à jour »'],
  [D, 'if (!ref?.etiquette) {', 'if (false) {', 'référence sans étiquette non détectée'],
  [D, "if (rapport.resultats.some((r) => r.etat === 'erreur')) return 2;", "if (rapport.resultats.some((r) => r.etat === 'erreur')) return 0;", 'code de sortie : erreur → 0'],
  [D, "return rapport.resultats.some((r) => r.etat === 'derive') ? 1 : 0;", "return rapport.resultats.some((r) => r.etat === 'derive') ? 0 : 0;", 'code de sortie : dérive → 0'],
  [D, "  if (rapport.resultats.some((r) => r.etat === 'erreur')) return 2;\n  return rapport.resultats.some((r) => r.etat === 'derive') ? 1 : 0;", "  if (rapport.resultats.some((r) => r.etat === 'derive')) return 1;\n  return rapport.resultats.some((r) => r.etat === 'erreur') ? 2 : 0;", 'code de sortie : la dérive l\'emporte sur l\'erreur'],
  [D, 'process.exitCode = codeDeSortie(rapport);', 'process.exitCode = 0;', 'la ligne de commande ne rend plus le code'],
  // Authentification, reprises
  [D, 'if (sonde.statut === 401) {', 'if (false) {', 'jamais de jeton Bearer'],
  [D, '...(jeton ? [\'-H\', `Authorization: Bearer ${jeton}`] : [])', '...[]', 'le jeton obtenu n\'est pas envoyé'],
  [D, "if (!/^Bearer/i.test(defi) || !royaume) throw", "if (false) throw", 'défi d\'authentification inconnu accepté'],
  [D, 'for (const delai of delais) {', 'for (const delai of []) {', 'aucune reprise'],
  [D, 'const STATUTS_TRANSITOIRES = new Set([429, 500, 502, 503, 504]);', 'const STATUTS_TRANSITOIRES = new Set([500, 502, 503, 504]);', '429 non repris'],
  [D, 'const STATUTS_TRANSITOIRES = new Set([429, 500, 502, 503, 504]);', 'const STATUTS_TRANSITOIRES = new Set([429, 500]);', '502, 503, 504 non repris'],
  [D, 'if (!STATUTS_TRANSITOIRES.has(reponse.statut)) break;', 'if (false) break;', 'reprises même sur une réponse définitive (404 rejoué)'],
  // Ce que curl dit quand il échoue (le jeton d'accès ne doit jamais sortir)
  [D, "throw new Error(ligne ? `curl a échoué : ${ligne}` : `curl a échoué (${e?.code ?? e?.signal ?? 'sans code'})`);", 'throw e;', 'panne de curl : l\'erreur brute (commande et jeton) est rendue'],
  [D, "throw new Error(ligne ? `curl a échoué : ${ligne}` : `curl a échoué (${e?.code ?? e?.signal ?? 'sans code'})`);", 'throw new Error(`curl a échoué : ${e.message}`);', 'panne de curl : la commande complète est ajoutée au message'],
  [D, "throw new Error(ligne ? `curl a échoué : ${ligne}` : `curl a échoué (${e?.code ?? e?.signal ?? 'sans code'})`);", "throw new Error('curl a échoué');", 'panne de curl : la cause n\'est plus dite'],
  // Lecture des en-têtes et des Dockerfile
  [D, 'const dernier = blocs.at(-1) ?? \'\';', 'const dernier = blocs[0] ?? \'\';', 'en-têtes : premier bloc (celui du proxy) au lieu du dernier'],
  [D, 'export const DOCKERFILES = [\'docker/execution/Dockerfile\', \'docker/egress-proxy/Dockerfile\'];', 'export const DOCKERFILES = [\'docker/execution/Dockerfile\'];', 'un Dockerfile n\'est plus contrôlé'],
  [D, "for (const { resolue } of imagesDeBase(source)) {", "for (const { resolue } of imagesDeBase(source).slice(0, 0)) {", 'aucune image lue'],
  [L, "if (registre === 'docker.io' && !depot.includes('/')) depot = `library/${depot}`;", "if (registre === 'docker.io') depot = `library/${depot}`;", 'lib : library/ ajouté à tout dépôt Docker Hub'],
  [L, "if (registre === 'docker.io' && !depot.includes('/')) depot = `library/${depot}`;", '', 'lib : library/ jamais ajouté'],
  [L, "registre: registre === 'docker.io' ? 'registry-1.docker.io' : registre,", 'registre,', 'lib : docker.io non traduit en registry-1.docker.io'],
  [L, "premier.includes('.') || premier.includes(':') || premier === 'localhost'", "premier.includes('.') || premier === 'localhost'", 'lib : registre avec port non reconnu'],
  [L, "premier.includes('.') || premier.includes(':') || premier === 'localhost'", "premier.includes(':') || premier === 'localhost'", 'lib : registre à point non reconnu'],
  [L, "premier.includes('.') || premier.includes(':') || premier === 'localhost'", "premier.includes('.') || premier.includes(':')", 'lib : localhost non reconnu'],
  [L, 'empreinte: m.groups.empreinte,', "empreinte: m.groups.empreinte.slice(0, 40),", 'lib : empreinte tronquée'],
  [L, 'etiquette: m.groups.etiquette ?? null,', "etiquette: m.groups.etiquette ?? 'latest',", 'lib : étiquette absente remplacée par latest'],
];
const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants[0] ? new RegExp(restants[0]) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').slice(-1)[0]}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests dérive', fichiers: TESTS }],
  exigerChromium: false,
  dossiers: [...DOSSIERS_COPIES, 'docker'],
  partie,
});
