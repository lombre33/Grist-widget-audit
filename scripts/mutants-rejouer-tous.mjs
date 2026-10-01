#!/usr/bin/env node
/**
 * Rejoue les mutants du pilote qui rejoue tous les lots (`scripts/rejouer-tous-les-lots.mjs`) : la coupe d'un lot en
 * paquets, ce qui est lancé seul, la somme des bilans et ses refus (un lot qui ignore `--part`, un paquet sans bilan,
 * un survivant, un plantage, un non jugé), les codes de sortie, la ligne de commande. Les lots que les essais lui
 * donnent sont de faux lots : c'est l'addition qu'on éprouve. Aucun navigateur n'est requis.
 *
 * Usage : node scripts/mutants-rejouer-tous.mjs [expression régulière sur le libellé] [--part=i/n]
 */
import { lireArguments, rejouerMutants } from './lib/rejouer-mutants.mjs';

const E = 'scripts/rejouer-tous-les-lots.mjs';

// [chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- la coupe en paquets
  ['Math.ceil(n / parPaquet);', 'Math.floor(n / parPaquet);', 'paquets : le reste d\'une division est perdu (floor)'],
  ['Math.ceil(n / parPaquet);', 'Math.round(n / parPaquet);', 'paquets : le reste est arrondi au plus proche'],
  ['Math.ceil(n / parPaquet);', 'Math.ceil(n / parPaquet) + 1;', 'paquets : un paquet de trop, sans mutants'],
  ['const k = lot.seul ? 1 : paquetsPour(lot.n, parPaquet);', 'const k = paquetsPour(lot.n, parPaquet);', 'paquets : un lot « seul » est coupé aussi'],
  ["const argv = k > 1 ? [`--part=${i}/${k}`] : [];", "const argv = [`--part=${i}/${k}`];", 'paquets : un lot d\'un seul paquet reçoit un --part=1/1'],
  ["const argv = k > 1 ? [`--part=${i}/${k}`] : [];", "const argv = k > 1 ? [`--part=${i}/${k + 1}`] : [];", 'paquets : le nombre de paquets annoncé au lot n\'est pas le bon'],
  ['for (let i = 1; i <= k; i++) {', 'for (let i = 1; i < k; i++) {', 'paquets : le dernier paquet n\'est jamais lancé'],

  // --- ce qui se lance, dans quel ordre, combien à la fois
  ['const communs = travaux.filter((t) => !t.lot.seul).sort((a, b) => b.lot.n / b.lot.paquets.length - a.lot.n / a.lot.paquets.length);', 'const communs = travaux.filter((t) => !t.lot.seul).sort((a, b) => a.lot.n / a.lot.paquets.length - b.lot.n / b.lot.paquets.length);', 'ordre : les plus petits paquets d\'abord'],
  ['const communs = travaux.filter((t) => !t.lot.seul).sort((a, b) => b.lot.n / b.lot.paquets.length - a.lot.n / a.lot.paquets.length);', 'const communs = travaux.filter((t) => !t.lot.seul);', 'ordre : l\'ordre des noms'],
  ['await Promise.all(Array.from({ length: Math.max(1, travailleurs) }', 'await Promise.all(Array.from({ length: 1 }', 'travailleurs : un seul à la fois'],
  ['await Promise.all(Array.from({ length: Math.max(1, travailleurs) }', 'await Promise.all(Array.from({ length: travailleurs + 1 }', 'travailleurs : un de plus que demandé'],
  ['for (const t of travaux.filter((x) => x.lot.seul)) await lancer(t, true);', 'await Promise.all(travaux.filter((x) => x.lot.seul).map((t) => lancer(t, true)));', 'seuls : lancés ensemble'],
  ['  for (const t of travaux.filter((x) => x.lot.seul)) await lancer(t, true);\n', '', 'seuls : jamais lancés'],
  ['const communs = travaux.filter((t) => !t.lot.seul)', 'const communs = travaux', 'seuls : lancés aussi avec les autres'],
  ['(!filtre || filtre.test(n))', 'true', 'filtre : ignoré'],
  ['env: environnementDeLot(env) });\n    const n =', 'env });\n    const n =', 'environnement : la vérification d\'avance garde le contexte de node --test'],
  ['{ env: environnementDeLot(env), stdio:', '{ env, stdio:', 'environnement : un lot garde le contexte de node --test'],

  // --- la vérification d'avance
  ['if (r.status !== 0 || !(n > 0)) {', 'if (!(n > 0)) {', 'avance : un lot qui sort en erreur est accepté s\'il a annoncé son nombre'],
  ['if (r.status !== 0 || !(n > 0)) {', 'if (r.status !== 0) {', 'avance : un lot qui n\'annonce aucun mutant est accepté'],
  ['if (refuses) { erreur(`${refuses} lot(s) à corriger avant de rien rejouer.`); return 2; }', 'if (refuses) { erreur(`${refuses} lot(s) à corriger avant de rien rejouer.`); }', 'avance : un lot refusé n\'arrête pas le rejeu'],
  ['if (refuses) { erreur(`${refuses} lot(s) à corriger avant de rien rejouer.`); return 2; }', 'if (refuses) { erreur(`${refuses} lot(s) à corriger avant de rien rejouer.`); return 1; }', 'avance : un lot refusé donne le code 1'],
  ['if (valider) return 0;', '', 'valider : les lots sont rejoués quand même'],
  ["if (!noms.length) { erreur('Aucun lot ne correspond.'); return 2; }", "if (!noms.length) { erreur('Aucun lot ne correspond.'); return 0; }", 'filtre : aucun lot est un succès'],

  // --- les comptes
  ['for (const cle of Object.keys(somme)) somme[cle] += bilan[cle];', 'for (const cle of Object.keys(somme)) somme[cle] = bilan[cle];', 'somme : seul le dernier paquet compte'],
  ['for (const cle of Object.keys(total)) total[cle] += somme[cle];', 'for (const cle of Object.keys(total)) total[cle] = somme[cle];', 'total : seul le dernier lot compte'],
  ['if (somme.retenus !== lot.n) remarques.push(', 'if (false) remarques.push(', 'somme : un lot qui ignore --part n\'est pas vu'],
  ['if (!bilan) { remarques.push(`${p.etiquette} : aucun bilan imprimé (code ${p.code ?? p.signal})`); continue; }', 'if (!bilan) continue;', 'somme : un paquet sans bilan ne dit rien'],
  ["const ok = !remarques.length && somme.plantages === 0 && somme.survivants === 0 && somme.nonJuges === 0;", "const ok = somme.plantages === 0 && somme.survivants === 0 && somme.nonJuges === 0;", 'échec : les remarques (bilan absent, compte faux) ne font pas échouer'],
  ["const ok = !remarques.length && somme.plantages === 0 && somme.survivants === 0 && somme.nonJuges === 0;", "const ok = !remarques.length && somme.survivants === 0 && somme.nonJuges === 0;", 'échec : un plantage ne fait pas échouer'],
  ["const ok = !remarques.length && somme.plantages === 0 && somme.survivants === 0 && somme.nonJuges === 0;", "const ok = !remarques.length && somme.plantages === 0 && somme.nonJuges === 0;", 'échec : un survivant ne fait pas échouer'],
  ["const ok = !remarques.length && somme.plantages === 0 && somme.survivants === 0 && somme.nonJuges === 0;", "const ok = !remarques.length && somme.plantages === 0 && somme.survivants === 0;", 'échec : un mutant non jugé ne fait pas échouer'],
  ['if (!ok) echec = true;', '', 'échec : jamais retenu'],
  ["return echec ? 1 : 0;", "return 0;", 'échec : le code de sortie reste 0'],
  ["return echec ? 1 : 0;", "return echec ? 2 : 0;", 'échec : le code de sortie est 2'],
  ["ok ? ' ' : '✗'", "' '", 'échec : le lot en échec n\'est pas marqué'],

  // --- ce qui est lu
  ['(\\d+) plantages? ;', '(\\d+) plantages ;', 'lecture : un seul plantage n\'est pas lu'],
  ['(\\d+) survivants?(?:', '(\\d+) survivants(?:', 'lecture : un seul survivant n\'est pas lu'],
  ['(?: ; (\\d+) non jugés?)?$/m', ' ; (\\d+) non jugés?$/m', 'lecture : un bilan sans non jugés n\'est pas lu'],
  ['(?: ; (\\d+) non jugés?)?$/m', '(?: ; (\\d+) non jugés)?$/m', 'lecture : un seul non jugé n\'est pas lu'],
  ['Number(nonJuges ?? 0)', 'Number(nonJuges)', 'lecture : les non jugés absents valent NaN'],
  ['/^(SURVIT|PLANTAGE|TUÉ délai)\\s/', '/^(SURVIT|PLANTAGE)\\s/', 'à lire : un mutant tué par un délai n\'est pas repris'],
  ['/^(SURVIT|PLANTAGE|TUÉ délai)\\s/', '/^(SURVIT|TUÉ délai)\\s/', 'à lire : un plantage n\'est pas repris'],
  ['/^(SURVIT|PLANTAGE|TUÉ délai)\\s/', '/^(PLANTAGE|TUÉ délai)\\s/', 'à lire : un survivant n\'est pas repris'],
  ['if (journaux) fs.appendFileSync(', 'if (false) fs.appendFileSync(', 'journaux : jamais écrits'],
  ["if (journaux) fs.mkdirSync(journaux, { recursive: true });", "", 'journaux : le dossier n\'est pas créé'],

  // --- la ligne de commande
  ["if (options.travailleurs === 0 || options.parPaquet === 0)", "if (false)", 'ligne : zéro travailleur ou zéro mutant par paquet accepté'],
  ["if (restants.length > 1) throw", "if (false) throw", 'ligne : plusieurs expressions acceptées'],
  ["else if (a.startsWith('--')) throw new Error(`option inconnue : ${a}`);", "", 'ligne : une option inconnue est prise pour une expression'],
  ["catch (e) { console.error(e.message); process.exit(2); }", "catch (e) { console.error(e.message); process.exit(1); }", 'ligne : un usage faux donne le code 1'],
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , libelle]) => !filtre || filtre.test(libelle))
  .map(([ancien, nouveau, libelle]) => ({ libelle, fichier: E, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'essais du pilote', fichiers: ['tests/rejouer-tous-les-lots.test.mjs'] }],
  exigerChromium: false,
  partie,
  // Un mutant qui ne lance jamais rien, ou un lot qui attend un rendez-vous qui n'arrive pas (5 s par lot), reste sous la minute : au-delà, c'est un délai, dit à part.
  delaiMs: 120000,
});
