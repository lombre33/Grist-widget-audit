#!/usr/bin/env node
/**
 * Rejoue les mutants que le différentiel de la surface contre Chromium (`tests/surface-chromium.test.mjs`) doit tuer À LUI SEUL, sans l'aide d'un
 * essai écrit à la main : les formes du cas inverse de la carte d'import, où la clé est une adresse que la page charge (`./a.js` → `./b.js`,
 * `/w/a.js` → `/w/b.js`). Chromium n'applique la carte qu'aux imports de la page et de ses modules : il charge tantôt la cible, tantôt l'origine, et la
 * surface garde les deux. Deux chemins portent la cible (l'entrée de la carte, et le nom que le code importe) : un défaut d'un seul ne fait aucun
 * angle mort et ne change que l'excès (premier mutant) ; un défaut à la source des deux en fait un (deuxième mutant, trois formes où Chromium charge la
 * cible et que la surface n'a plus). Chaque mutant pose, sur la ligne qui porte le choix, le défaut plausible : le différentiel doit alors échouer
 * (méthode : `scripts/lib/rejouer-mutants.mjs`). Un navigateur est requis (`GWAUDIT_CHROMIUM_PATH`, et `GWAUDIT_CHROMIUM_SANS_SANDBOX=1` sous root) : le
 * différentiel se juge contre Chromium, pas contre ce qu'on croit de lui.
 *
 * Usage : node scripts/mutants-surface-chromium.mjs [expression régulière sur le libellé] [--part=i/n] [--valider]
 */
import { lireArguments, rejouerMutants, dansLigne } from './lib/rejouer-mutants.mjs';

const AJ = 'src/moteur/analyse-js.js';
const TESTS = ['tests/surface-chromium.test.mjs'];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  dansLigne(AJ, 'parUrl.set(url, spec);', "if (typeof url === 'string')", "if (typeof url === 'string' && !/^[./]/.test(spec))", 'carte inverse : la cible d\'une clé d\'adresse n\'est plus une entrée de la carte (Chromium charge l\'origine, la surface perd la cible)'),
  dansLigne(AJ, 'try { cartes.push({ carte: JSON.parse(s.texte), s });', 'cartes.push({ carte: JSON.parse(s.texte), s });', "{ const carte = JSON.parse(s.texte); if (carte?.imports && typeof carte.imports === 'object') for (const cle of Object.keys(carte.imports)) if (/^[./]/.test(cle)) delete carte.imports[cle]; cartes.push({ carte, s }); }", 'carte inverse : la carte se lit sans ses clés d\'adresse (ni l\'entrée ni le nom importé ne désignent plus la cible : Chromium la charge, la surface la perd)'),
];

const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants.length ? new RegExp(restants.join(' ')) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'différentiel de la surface contre Chromium', fichiers: TESTS }],
  exigerChromium: true,
  partie,
});
