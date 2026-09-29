#!/usr/bin/env node
/**
 * Rejoue les mutants des textes de `<link>` (`tests/liens-raisons.test.mjs`) :
 * la raison de la sévérité (ressource d'affichage, connexion, de quoi la page
 * peut exécuter, feuille de style), l'article du libellé, la sévérité de
 * chaque usage, et le fait que les autres chargements n'en reçoivent aucune.
 * Chaque mutant pose, sur la ligne qui porte le choix, le défaut plausible :
 * le test doit alors échouer (méthode : `scripts/lib/rejouer-mutants.mjs`).
 * Aucun navigateur n'est requis.
 *
 * Usage : node scripts/mutants-liens-raisons.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import fs from 'node:fs';
import path from 'node:path';
import { lireArguments, rejouerMutants, RACINE } from './lib/rejouer-mutants.mjs';

const S = 'src/regles/c-securite.js';
const TESTS = ['tests/liens-raisons.test.mjs'];

const lire = (fichier) => fs.readFileSync(path.join(RACINE, fichier), 'utf8');
/** La ligne entière du fichier qui contient `motif`, si une seule le contient. */
function ligne(fichier, motif) {
  const trouvees = lire(fichier).split('\n').filter((l) => l.includes(motif));
  if (trouvees.length !== 1) throw new Error(`${fichier} : « ${motif} » se trouve sur ${trouvees.length} lignes, il en faut une`);
  return trouvees[0];
}
/** Un mutant qui remplace, dans la ligne unique contenant `motif`, `de` par `par`. */
function dansLigne(fichier, motif, de, par, libelle) {
  const l = ligne(fichier, motif);
  if (!l.includes(de)) throw new Error(`${fichier} : « ${de} » ne figure pas dans la ligne de « ${motif} »`);
  return [fichier, l, l.replace(de, par), libelle];
}

const RAISON = 'const raisonDeLien = ';
const AFF = 'const RAISON_LIEN_AFFICHAGE = ';
const CON = 'const RAISON_LIEN_CONNEXION = ';
const EXE = 'const RAISON_LIEN_EXECUTABLE = ';
const FEU = 'const RAISON_LIEN_FEUILLE = ';
const PUSH_LIEN = 'for (const url of u.urls) sortie.push({ url, type, article, severite,';
const NOTE = '${e.note ?? \'\'}';

const MUTANTS = [
  // Le choix de la raison
  dansLigne(S, RAISON, "usage.genre === 'feuille'", 'false', 'F : une feuille de style prend la raison des autres liens'),
  dansLigne(S, RAISON, "usage.genre === 'feuille'", 'true', 'F : tout lien prend la raison de la feuille de style'),
  dansLigne(S, RAISON, "usage.genre === 'connexion'", 'false', 'F : une connexion anticipée prend la raison des ressources d\'affichage'),
  dansLigne(S, RAISON, "usage.genre === 'connexion'", 'true', 'F : tout lien non feuille prend la raison de la connexion'),
  dansLigne(S, RAISON, "severite === 'mineur'", "severite !== 'mineur'", 'F : les raisons « affichage » et « exécutable » permutées'),
  dansLigne(S, RAISON, "severite === 'mineur'", 'true', 'F : tout lien prend la raison de la ressource d\'affichage'),
  dansLigne(S, RAISON, "severite === 'mineur'", 'false', 'F : tout lien prend la raison « de quoi la page peut exécuter »'),
  dansLigne(S, RAISON, 'RAISON_LIEN_FEUILLE : ', 'RAISON_LIEN_EXECUTABLE : ', 'F : la feuille de style dit la raison des préchargements'),
  dansLigne(S, RAISON, 'RAISON_LIEN_CONNEXION : ', 'RAISON_LIEN_AFFICHAGE : ', 'F : la connexion dit la raison des ressources d\'affichage'),

  // Le contenu de chaque raison
  dansLigne(S, AFF, "ne l'exécute ni ne l'applique jamais", "ne l'exécute jamais", 'F : la raison d\'affichage oublie qu\'il ne l\'applique pas'),
  dansLigne(S, AFF, "l'adresse IP et l'heure de chaque affichage", "l'adresse IP", 'F : la raison d\'affichage oublie l\'heure'),
  dansLigne(S, AFF, "qu'une ressource d'affichage", "qu'une ressource", 'F : la raison d\'affichage ne dit plus ce qu\'est la ressource'),
  dansLigne(S, CON, "n'exécute ni n'applique jamais rien de ce lien", "n'exécute rien de ce lien", 'F : la raison de connexion oublie qu\'il n\'applique rien'),
  dansLigne(S, CON, "(avec `preconnect`)", '(avec `dns-prefetch`)', 'F : la raison de connexion attribue l\'adresse IP au mauvais lien'),
  dansLigne(S, CON, "et l'heure de chaque affichage", '', 'F : la raison de connexion oublie l\'heure'),
  dansLigne(S, EXE, 'exécuter, appliquer ou lire', 'exécuter', 'F : la raison « exécutable » oublie appliquer et lire'),
  dansLigne(S, EXE, "(un `onload` qui passe `rel` à `stylesheet`, un chargeur calculé)", '', 'F : la raison « exécutable » ne donne plus d\'exemple'),
  dansLigne(S, EXE, "faute de garantie, la sévérité n'est pas abaissée", 'la sévérité est abaissée', 'F : la raison « exécutable » dit l\'inverse de ce que fait l\'audit'),
  dansLigne(S, FEU, "s'applique à la page", 'ne s\'applique pas à la page', 'F : la raison de la feuille dit qu\'elle ne s\'applique pas'),
  dansLigne(S, FEU, 'peuvent faire charger d\'autres ressources', 'ne chargent rien d\'autre', 'F : la raison de la feuille oublie qu\'elle charge d\'autres ressources'),
  dansLigne(S, FEU, 'par leurs sélecteurs, des valeurs présentes dans la page', 'des valeurs', 'F : la raison de la feuille oublie la lecture par sélecteurs'),

  // La sévérité de chaque usage
  dansLigne(S, "feuille: ['feuille de style', 'majeur', 'une']", "'majeur'", "'mineur'", 'F : une feuille de style tierce devient mineure'),
  dansLigne(S, "icone: ['icône', 'mineur', 'une']", "'mineur'", "'majeur'", 'F : une icône devient majeure'),
  dansLigne(S, "modulepreload: ['préchargement de module', 'majeur', 'un']", "'majeur'", "'mineur'", 'F : un modulepreload devient mineur'),
  dansLigne(S, "prefetch: ['préchargement (prefetch)', 'majeur', 'un']", "'majeur'", "'mineur'", 'F : un prefetch devient mineur'),
  dansLigne(S, "prerender: ['préchargement (prerender)', 'majeur', 'un']", "'majeur'", "'mineur'", 'F : un prerender devient mineur'),
  dansLigne(S, "connexion: ['connexion anticipée', 'mineur', 'une']", "'mineur'", "'majeur'", 'F : une connexion anticipée devient majeure'),
  dansLigne(S, 'const PRECHARGE_PAR_AS = ', "script: 'majeur'", "script: 'mineur'", 'F : un préchargement de script devient mineur'),
  dansLigne(S, 'const PRECHARGE_PAR_AS = ', "style: 'majeur'", "style: 'mineur'", 'F : un préchargement de feuille devient mineur'),
  dansLigne(S, 'const PRECHARGE_PAR_AS = ', "fetch: 'majeur'", "fetch: 'mineur'", 'F : un préchargement de requête devient mineur'),
  dansLigne(S, 'const PRECHARGE_PAR_AS = ', "track: 'majeur'", "track: 'mineur'", 'F : un préchargement de piste devient mineur'),
  dansLigne(S, 'const PRECHARGE_PAR_AS = ', "font: 'mineur'", "font: 'majeur'", 'F : un préchargement de police devient majeur'),
  dansLigne(S, 'const PRECHARGE_PAR_AS = ', "image: 'mineur'", "image: 'majeur'", 'F : un préchargement d\'image devient majeur'),

  // L'article du libellé
  dansLigne(S, "feuille: ['feuille de style', 'majeur', 'une']", "'une'", "'un'", 'F : « un feuille de style »'),
  dansLigne(S, "icone: ['icône', 'mineur', 'une']", "'une'", "'un'", 'F : « un icône »'),
  dansLigne(S, "modulepreload: ['préchargement de module', 'majeur', 'un']", "'un'", "'une'", 'F : « une préchargement de module »'),
  dansLigne(S, "prefetch: ['préchargement (prefetch)', 'majeur', 'un']", "'un'", "'une'", 'F : « une préchargement (prefetch) »'),
  dansLigne(S, "prerender: ['préchargement (prerender)', 'majeur', 'un']", "'un'", "'une'", 'F : « une préchargement (prerender) »'),
  dansLigne(S, "const [type, severite, article] = u.genre === 'precharge'", "PRECHARGE_PAR_AS[u.as], 'un']", "PRECHARGE_PAR_AS[u.as], 'une']", 'F : « une préchargement de script »'),
  dansLigne(S, PUSH_LIEN, 'type, article, severite,', "type, article: 'une', severite,", 'F : l\'article du libellé d\'un lien est toujours « une »'),

  // Ce que porte chaque constat : la raison est la note du chargement, dite après la phrase du constat
  dansLigne(S, PUSH_LIEN, 'note: ` ${raisonDeLien(u, severite)}`,', 'note: null,', 'F : le lien ne porte aucune raison'),
  dansLigne(S, PUSH_LIEN, 'note: ` ${raisonDeLien(u, severite)}`,', "note: ` ${raisonDeLien(u, 'mineur')}`,", 'F : la raison ignore la sévérité du lien'),
  dansLigne(S, PUSH_LIEN, 'note: ` ${raisonDeLien(u, severite)}`,', 'note: raisonDeLien(u, severite),', 'F : la raison colle à la phrase du constat, sans blanc'),
  dansLigne(S, "Aucune ressource n'est demandée.", NOTE, '', 'F : le constat d\'une connexion n\'affiche pas la raison'),
  dansLigne(S, 'Le widget charge ${e.article ?? \'une\'} ${e.type}', NOTE, '', 'F : le constat d\'une ressource n\'affiche pas la raison'),
  dansLigne(S, 'Le widget charge ${e.article ?? \'une\'} ${e.type}', "}`, e.mention),", "}`, e.note ? null : e.mention),", 'F : la réserve de gabarit disparaît quand il y a une raison'),
  dansLigne(S, "severite: c.execute ? 'critique' : 'majeur', code: c.execute,", 'code: c.execute,', 'code: c.execute, note: ` ${RAISON_LIEN_EXECUTABLE}`,', 'F : un script prend une raison de lien'),
  dansLigne(S, 'if (url != null && !urlVide(url)) sortie.push({ url, type: meta.type', 'severite: meta.severite,', 'severite: meta.severite, note: ` ${RAISON_LIEN_AFFICHAGE}`,', 'F : une image ou une iframe prend une raison de lien'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests des textes de lien', fichiers: TESTS }],
  exigerChromium: false,
  partie,
});
