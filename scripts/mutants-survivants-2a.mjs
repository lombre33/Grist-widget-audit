#!/usr/bin/env node
/**
 * Rejoue les mutants des points que le rejeu indépendant de la coordination
 * (sur 9b1ba86) a montrés non gardés après l'étape 2a : C03b, C05g, C09, C11g,
 * C11i, C12a, X14 (méthode : `scripts/lib/rejouer-mutants.mjs`). Ce script
 * pose, sur chaque ligne citée, les défauts plausibles : le test qui devait
 * la garder doit alors échouer. Aucun navigateur n'est requis ; les mêmes
 * formes sont aussi rejouées dans Chromium par `tests/passe-html-chromium.test.mjs`.
 *
 * Usage : node scripts/mutants-survivants-2a.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import fs from 'node:fs';
import path from 'node:path';
import { lireArguments, rejouerMutants, RACINE } from './lib/rejouer-mutants.mjs';

const S = 'src/regles/c-securite.js';
const E = 'src/regles/e-dependances.js';
const P = 'src/moteur/page-html.js';
const J = 'src/moteur/analyse-js.js';
const TESTS = ['tests/survivants-2a.test.mjs', 'tests/resolution-portee.test.mjs'];

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

const MUTANTS = [
  // C03b : ce qui est local n'est jamais une ressource tierce
  dansLigne(S, 'if (estLocal(h)) return constats;', 'estLocal(h)', 'false', 'C03b : une ressource locale est signalée comme tierce'),
  dansLigne(S, 'const estLocal = (h) =>', '!h || ', '', 'C03b : une URL illisible est une destination'),
  dansLigne(S, 'const estLocal = (h) =>', " || h === 'widget.local'", '', 'C03b : une ressource relative est une destination'),
  dansLigne(S, 'const estLocal = (h) =>', " || h === 'localhost'", '', 'C03b : localhost est une destination'),
  dansLigne(S, 'const estLocal = (h) =>', " || h === '127.0.0.1'", '', 'C03b : 127.0.0.1 est une destination'),
  dansLigne(S, 'if (estLocal(h) && !dynamique) return;', 'estLocal(h) && !dynamique', 'false', 'C03b : une requête sur soi-même est signalée'),

  // C05g : l'integrity d'une ressource se dit quand elle protège
  dansLigne(S, "const protege = integriteProtege(r.attributs.get('integrity'));", "integriteProtege(r.attributs.get('integrity'))", 'false', 'C05g : l\'integrity d\'une ressource ne protège jamais'),
  dansLigne(S, "const protege = integriteProtege(r.attributs.get('integrity'));", "integriteProtege(r.attributs.get('integrity'))", 'true', 'C05g : une ressource est toujours protégée'),
  dansLigne(S, "protege: integriteProtege(s.attributs.get('integrity')), baseBrute: s.baseBrute", "integriteProtege(s.attributs.get('integrity'))", 'false', 'C05g : l\'integrity d\'un script ne protège jamais'),
  dansLigne(S, "protege: integriteProtege(s.attributs.get('integrity')), baseBrute: s.baseBrute", "integriteProtege(s.attributs.get('integrity'))", 'true', 'C05g : un script est toujours protégé'),
  dansLigne(S, 'const sri = e.protege;', 'e.protege', 'false', 'C05g : le constat ignore la protection'),
  dansLigne(S, 'const sri = e.protege;', 'e.protege', 'true', 'C05g : le constat croit toujours à la protection'),
  dansLigne(S, 'const bloquant = Boolean(e.code) && !sri;', ' && !sri', '', 'C05g : un script protégé bloque'),
  dansLigne(S, '${sri ? \' (avec attribut', 'sri ?', '!sri ?', 'C05g : « avec » et « sans » permutés'),

  // C09 : la ligne et la colonne d'un code écrit dans une page
  dansLigne(P, 'entree.positionDe = (decalage) => positionDe(entree.fin + decalage);', 'entree.fin + decalage', 'decalage', 'C09 : la position ignore le début du script'),
  dansLigne(P, 'entree.positionDe = (decalage) => positionDe(entree.fin + decalage);', 'entree.fin + decalage', 'entree.fin - decalage', 'C09 : la position remonte au lieu d\'avancer'),
  dansLigne(P, 'entree.positionDe = (decalage) => positionDe(entree.fin + decalage);', 'entree.fin + decalage', 'entree.fin', 'C09 : la position est celle du début du script'),
  dansLigne(P, 'entree.positionDe = (decalage) => positionDe(entree.fin + decalage);', 'entree.fin + decalage', 'entree.fin + decalage + 1', 'C09 : la position est décalée d\'un caractère'),
  dansLigne(P, 'entree.texte = contenu.slice(entree.fin, finContenu);', 'entree.fin, finContenu', 'entree.fin + 1, finContenu', 'C09 : le texte du script perd son premier caractère'),
  dansLigne(J, ').colonne + 1;', '.colonne + 1;', '.colonne;', 'C09 : la colonne d\'un script de page compte depuis 0'),
  dansLigne(J, ').colonne + 1;', '.colonne + 1;', '.colonne + 2;', 'C09 : la colonne d\'un script de page est décalée d\'un cran'),
  dansLigne(J, ').colonne + 1;', 'noeud.start : 0).colonne', 'noeud.end : 0).colonne', 'C09 : la colonne d\'un script de page est celle de la fin du nœud'),
  dansLigne(J, ').colonne + 1;', ': 0).colonne', ': 1).colonne', 'C09 : un nœud sans position part du deuxième caractère (colonne)'),
  dansLigne(J, 'return (noeud?.loc?.start?.column ?? 0) + 1;', ' + 1;', ';', 'C09 : la colonne d\'un fichier compte depuis 0'),
  dansLigne(J, 'return unite.positionDe(typeof noeud?.start === \'number\' ? noeud.start : 0).ligne;', 'noeud.start : 0).ligne', 'noeud.end : 0).ligne', 'C09 : la ligne d\'un script de page est celle de la fin du nœud'),
  dansLigne(J, 'return unite.positionDe(typeof noeud?.start === \'number\' ? noeud.start : 0).ligne;', '.ligne;', '.ligne + 1;', 'C09 : la ligne d\'un script de page est décalée d\'une'),

  // C11g : un élément HTML dans du SVG ou du MathML en sort ; une balise de fin aussi
  dansLigne(P, 'if (decoupeur.inForeignNode && foreignContent.causesExit(balise))', 'foreignContent.causesExit(balise)', 'false', 'C11g : aucun élément ne fait sortir du contenu étranger'),
  dansLigne(P, 'if (decoupeur.inForeignNode && foreignContent.causesExit(balise))', 'foreignContent.causesExit(balise)', 'true', 'C11g : tout élément fait sortir du contenu étranger'),
  dansLigne(P, 'if (decoupeur.inForeignNode && foreignContent.causesExit(balise))', 'decoupeur.inForeignNode && foreignContent.causesExit(balise)', 'false', 'C11g : la sortie n\'est jamais tentée'),
  dansLigne(P, "if (decoupeur.inForeignNode && (nom === 'br' || nom === 'p')) sortirDeLEtranger(startOffset);", "(nom === 'br' || nom === 'p')", "(nom === 'p')", 'C11g : </br> ne fait plus sortir du contenu étranger'),
  dansLigne(P, "if (decoupeur.inForeignNode && (nom === 'br' || nom === 'p')) sortirDeLEtranger(startOffset);", "(nom === 'br' || nom === 'p')", "(nom === 'br')", 'C11g : </p> ne fait plus sortir du contenu étranger'),
  dansLigne(P, "if (decoupeur.inForeignNode && (nom === 'br' || nom === 'p')) sortirDeLEtranger(startOffset);", "(nom === 'br' || nom === 'p')", "(nom === 'br' || nom === 'p' || nom === 'b')", 'C11g : </b> fait sortir du contenu étranger'),

  // C11i : ce que la passe lit dans SVG et MathML n'est pas ce qu'elle lit dans HTML
  dansLigne(P, 'const estLu = (nom, ns) =>', 'ns === \'svg\' ? LUS_SVG : LUS_MATHML', 'ns === \'svg\' ? LUS_SVG : LUS_HTML', 'C11i : MathML lit ce que lit HTML'),
  dansLigne(P, 'const estLu = (nom, ns) =>', 'ns === \'svg\' ? LUS_SVG : LUS_MATHML', 'ns === \'svg\' ? LUS_MATHML : LUS_SVG', 'C11i : SVG et MathML permutés'),
  dansLigne(P, 'const estLu = (nom, ns) =>', 'ns === \'svg\' ? LUS_SVG', 'ns === \'svg\' ? LUS_HTML', 'C11i : SVG lit ce que lit HTML'),
  dansLigne(P, 'const estLu = (nom, ns) =>', "ns === 'html' ? LUS_HTML : ns === 'svg' ? LUS_SVG : LUS_MATHML", 'LUS_HTML', 'C11i : tous les espaces de noms lisent ce que lit HTML'),
  dansLigne(P, 'const estLu = (nom, ns) =>', "ns === 'html' ? LUS_HTML : ns === 'svg' ? LUS_SVG : LUS_MATHML", "ns === 'html' ? LUS_SVG : ns === 'svg' ? LUS_HTML : LUS_MATHML", 'C11i : HTML et SVG permutés'),
  dansLigne(P, "const LUS_SVG = new Set(['script', 'a']);", "['script', 'a']", "['script']", 'C11i : SVG ne lit plus ses liens'),
  dansLigne(P, "const LUS_SVG = new Set(['script', 'a']);", "['script', 'a']", "['a']", 'C11i : SVG ne lit plus ses scripts'),
  dansLigne(P, "const LUS_SVG = new Set(['script', 'a']);", "['script', 'a']", "['script', 'a', 'iframe']", 'C11i : SVG lit ses iframe'),
  dansLigne(P, "const LUS_MATHML = new Set(['script']);", "['script']", "['script', 'a']", 'C11i : MathML lit ses liens'),
  dansLigne(P, "const LUS_MATHML = new Set(['script']);", "['script']", '[]', 'C11i : MathML ne lit plus ses scripts'),

  // C12a : l'integrity d'une import map
  dansLigne(J, 'entrees.push({ spec, url, sri:', "integriteProtege(Object.prototype.hasOwnProperty.call(integrites, url) ? integrites[url] : undefined)", 'Object.prototype.hasOwnProperty.call(integrites, url)', 'C12a : une clé integrity suffit, quelle que soit sa valeur'),
  dansLigne(J, 'entrees.push({ spec, url, sri:', "integriteProtege(Object.prototype.hasOwnProperty.call(integrites, url) ? integrites[url] : undefined)", 'true', 'C12a : toute entrée est protégée'),
  dansLigne(J, 'entrees.push({ spec, url, sri:', "integriteProtege(Object.prototype.hasOwnProperty.call(integrites, url) ? integrites[url] : undefined)", 'false', 'C12a : aucune entrée n\'est protégée'),
  dansLigne(J, 'entrees.push({ spec, url, sri:', "integriteProtege(Object.prototype.hasOwnProperty.call(integrites, url) ? integrites[url] : undefined)", 'integriteProtege(Object.values(integrites)[0])', 'C12a : l\'empreinte d\'une autre URL protège celle-ci'),
  dansLigne(J, 'const integrites = carte &&', ' && carte.integrity ? carte.integrity : {}', ' ? carte.integrity : {}', 'C12a : un integrity nul plante la lecture'),
  dansLigne(J, 'ajouter(carte?.imports);', 'ajouter(carte?.imports);', 'void 0;', 'C12a : les imports ne sont plus lus'),
  dansLigne(J, 'for (const portee of Object.values(carte?.scopes ?? {})) ajouter(portee);', 'ajouter(portee)', 'void portee', 'C12a : les scopes ne sont plus lus'),
  dansLigne(S, "severite: e.sri ? 'majeur' : 'critique', bloquant: !e.sri,", "e.sri ? 'majeur' : 'critique'", "'critique'", 'C12a : une import map protégée reste critique (C-EXFIL-03)'),
  dansLigne(S, "severite: e.sri ? 'majeur' : 'critique', bloquant: !e.sri,", 'bloquant: !e.sri', 'bloquant: false', 'C12a : une import map non protégée ne bloque pas (C-EXFIL-03)'),
  dansLigne(S, "sans empreinte `integrity` valide dans l\\'import map", 'e.sri ?', '!e.sri ?', 'C12a : « couverte » et « sans empreinte » permutés (C-EXFIL-03)'),
  dansLigne(E, "severite: !d.sri ? 'critique' : 'majeur', bloquant: !d.sri,", "!d.sri ? 'critique' : 'majeur'", "'critique'", 'C12a : une dépendance protégée reste critique (E-DEP-01)'),
  dansLigne(E, "severite: !d.sri ? 'critique' : 'majeur', bloquant: !d.sri,", 'bloquant: !d.sri', 'bloquant: false', 'C12a : une dépendance non protégée ne bloque pas (E-DEP-01)'),

  // X14 : une iframe ou un lien de gabarit le disent
  dansLigne(S, "constat: precise('Le widget insère une iframe sans restreindre ses capacités.', mention(r)),", 'mention(r)', 'null', 'X14 : une iframe de gabarit ne le dit pas'),
  dansLigne(S, "constat: precise('Un lien `target=\"_blank\"` ne porte pas", 'mention(a)', 'null', 'X14 : un lien de gabarit ne le dit pas'),
  dansLigne(S, 'const mention = (e) => (e.dansTemplate ? MENTION_GABARIT_RESSOURCE : null);', 'e.dansTemplate ? MENTION_GABARIT_RESSOURCE : null', 'null', 'X14 : la mention de gabarit n\'est jamais posée'),
  dansLigne(S, 'const mention = (e) => (e.dansTemplate ? MENTION_GABARIT_RESSOURCE : null);', 'e.dansTemplate ?', 'true ?', 'X14 : la mention de gabarit est posée partout'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests des points non gardés de 2a', fichiers: TESTS }],
  exigerChromium: false,
  partie,
});
