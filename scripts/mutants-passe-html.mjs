#!/usr/bin/env node
/**
 * Rejoue les mutants du correctif de l'étape 1 de la passe HTML.
 *
 * Un mutant réintroduit UN défaut dans une copie temporaire du code (le dépôt
 * n'est jamais modifié) : la suite ciblée doit alors échouer. Un mutant qui
 * survit veut dire que le test qui devait protéger ce point ne prouve rien.
 * Le script échoue bruyamment (code 2) si la chaîne à remplacer n'est pas
 * trouvée exactement une fois, ou si la suite n'est pas verte et complète
 * (aucun test sauté) sur le code non muté : un mutant « tué » par une suite
 * déjà cassée ne prouve rien. Code 1 si un mutant survit, 0 sinon.
 *
 * Usage : GWAUDIT_CHROMIUM_PATH=/chemin/vers/chromium node scripts/mutants-passe-html.mjs [point…]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAPIDES = ['tests/passe-html-correctif.test.mjs', 'tests/passe-html-lecteurs.test.mjs', 'tests/scripts-inline.test.mjs'];
const DIFFERENTIEL = 'tests/passe-html-chromium.test.mjs';

// [point du correctif, fichier, chaîne d'origine (une seule occurrence), chaîne mutée]
const MUTANTS = [
  [1, 'src/moteur/page-html.js', "entree.carteImport = texteLu && ferme && genre === 'importmap';", "entree.carteImport = texteLu && ferme && genre === 'importmap' && ns === 'html';"],
  [2, 'src/regles/e-dependances.js', 'urlDe(c.valeur, s.baseBrute, f.chemin)', 'urlDe(c.valeur, null, f.chemin)'],
  [2, 'src/regles/e-dependances.js', 'urlDeCarte(e.url, e.baseBrute, f.chemin)', 'urlDeCarte(e.url, null, f.chemin)'],
  [2, 'src/regles/c-securite.js', 'urlDeCarte(e.url, e.baseBrute, f.chemin)', 'urlDeCarte(e.url, null, f.chemin)'],
  [2, 'src/moteur/page-html.js', 'if (baseBrute === null && !element.dansTemplate && attributs.has(\'href\'))', 'if (baseBrute === null && attributs.has(\'href\'))'],
  [2, 'src/contexte/inventaire.js', 'cheminLocal(urlDe(valeur, baseBrute, f.chemin))', 'cheminLocal(urlDe(valeur, null, f.chemin))'],
  [3, 'src/moteur/page-html.js', 'entree.unite = texteLu && ferme && seCharge(genre)', 'entree.unite = texteLu && seCharge(genre)'],
  [4, 'src/moteur/page-html.js', 'sansBlancsDeType(type))))', 'sansBlancsDeType(type.split(\';\')[0]))))'],
  [4, 'src/moteur/page-html.js', "if (genre === 'classique' && ns === 'html' && attributs.has('nomodule')) genre = null;", "if (genre === 'classique' && ns === 'html' && attributs.has('nomodule') && false) genre = null;"],
  [4, 'src/moteur/page-html.js', "if (genre === 'classique' && ns === 'html' && attributs.has('nomodule')) genre = null;", "if (genre === 'classique' && attributs.has('nomodule')) genre = null;"],
  [4, 'src/moteur/page-html.js', 'entree.mention = mentionDe(entree);', 'entree.mention = null;'],
  [4, 'src/moteur/page-html.js', "ns === 'html' ? 'src-html' : 'src-sans-execution'", "'src-html'"],
  [4, 'src/moteur/page-html.js', "if (seCharge(chargement.genre)) ajouter(attributs.get('src')", "if (true) ajouter(attributs.get('src')"],
  [4, 'src/moteur/page-html.js', '0x205f, 0x3000]);', '0x205f]);'],
  [4, 'src/moteur/page-html.js', "if (mode === 'reference-svg') return ferme ? [{ valeur, execute: true, seulementStandard }] : [];", "if (mode === 'reference-svg') return [{ valeur, execute: true, seulementStandard }];"],
  [5, 'src/regles/c-securite.js', "for (const r of ressources) {\n      if (r.nom !== 'iframe' || r.attributs.has('sandbox')) continue;", "for (const r of [...f.contenu.matchAll(/<iframe\\b[^>]*>/gi)].map((m) => ({ nom: 'iframe', attributs: new Map(), ligne: 1, balise: m[0], dansTemplate: false }))) {\n      if (r.nom !== 'iframe' || r.attributs.has('sandbox')) continue;"],
  [5, 'src/regles/c-securite.js', 'const metas = balises.filter(estMetaCsp);', "const metas = balises.filter((b) => estMetaCsp(b) && /http-equiv\\s*=\\s*[\"']/i.test(b.balise));"],
  [5, 'src/regles/f-conformite.js', "if (entree && !/\\S/.test(lirePage(c).titre ?? '')) {", 'if (entree && !/<title>\\s*\\S/i.test(c)) {'],
  [5, 'src/contexte/inventaire.js', 'if (s.unite) for (const ref of referencesDeCode(s.texte)) local(ref, s.baseBrute);', 'for (const ref of referencesDeCode(c)) local(ref, s.baseBrute);'],
  [5, 'src/regles/c-securite.js', "if (rel.includes('noopener') || rel.includes('noreferrer')) continue;", 'if (false) continue;'],
  [5, 'src/regles/c-securite.js', 'estMetaCsp(b) && b.dansTete && !b.dansTemplate', 'estMetaCsp(b) && !b.dansTemplate'],
  [6, 'src/moteur/decoupeur-html.js', 'offset - (ch.length - 1)', 'offset - ch.length'],
  [6, 'src/moteur/decoupeur-html.js', 'this.origineEntite = this.preprocessor.droppedBufferSize + this.entityStartPos;', 'this.origineEntite = this.preprocessor.droppedBufferSize + this.entityStartPos + 1;'],
  [6, 'src/moteur/decoupeur-html.js', 'this.retard = cp === 0x5d ? 1 : 0;', 'this.retard = 0;'],
  [7, 'src/contexte/inventaire.js', "if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration'", "if (n.type === 'ExportAllDeclaration'"],
  [7, 'src/contexte/inventaire.js', "} else if (n.type === 'ImportExpression') {", "} else if (n.type === 'ImportExpressionX') {"],
  [8, 'src/regles/c-securite.js', 'if (estAccesLocation(arg)) return {', 'if (false) return {'],
  [8, 'src/regles/c-securite.js', 'texte: operandeChaine(arg)', 'texte: false'],
  ['mentions', 'src/moteur/statique.js', '  ajouterMentions(ctx, constats);\n', ''],
];

const points = process.argv.slice(2);
const retenus = MUTANTS.filter(([point]) => !points.length || points.includes(String(point)));
if (!process.env.GWAUDIT_CHROMIUM_PATH) {
  console.error('GWAUDIT_CHROMIUM_PATH est requis : le différentiel Chromium fait partie de la preuve, un test sauté ne tuerait rien.');
  process.exit(2);
}

const copie = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-mutants-'));
const lancer = (fichiers) => {
  const r = spawnSync('node', ['--test', ...fichiers], { cwd: copie, encoding: 'utf8', env: process.env });
  const saute = Number(/^# skipped (\d+)/m.exec(r.stdout)?.[1] ?? NaN);
  return { ok: r.status === 0, saute };
};

try {
  for (const dossier of ['src', 'tests', 'fixtures']) if (fs.existsSync(path.join(RACINE, dossier))) fs.cpSync(path.join(RACINE, dossier), path.join(copie, dossier), { recursive: true });
  fs.copyFileSync(path.join(RACINE, 'package.json'), path.join(copie, 'package.json'));
  fs.symlinkSync(path.join(RACINE, 'node_modules'), path.join(copie, 'node_modules'));

  const base = lancer([...RAPIDES, DIFFERENTIEL]);
  if (!base.ok || base.saute !== 0) {
    console.error(`La suite ciblée n'est pas verte et complète sur le code non muté (échec : ${!base.ok}, sautés : ${base.saute}) : rien à conclure.`);
    process.exit(2);
  }

  let survivants = 0;
  for (const [numero, [point, fichier, ancien, nouveau]] of retenus.entries()) {
    const chemin = path.join(copie, fichier);
    const original = fs.readFileSync(chemin, 'utf8');
    const occurrences = original.split(ancien).length - 1;
    if (occurrences !== 1) {
      console.error(`Mutant ${numero + 1} (point ${point}) : « ${ancien.slice(0, 70)} » trouvé ${occurrences} fois dans ${fichier}, exactement une attendue. Le code a changé : mettre à jour le mutant.`);
      process.exit(2);
    }
    fs.writeFileSync(chemin, original.replace(ancien, () => nouveau));
    let tue = !lancer(RAPIDES).ok;
    let par = 'tests ciblés';
    if (!tue) { tue = !lancer([DIFFERENTIEL]).ok; par = 'différentiel Chromium'; }
    fs.writeFileSync(chemin, original);
    if (!tue) survivants += 1;
    console.log(`${tue ? 'TUÉ    ' : 'SURVIT '} point ${point}  ${fichier}  ${ancien.slice(0, 60).replace(/\n/g, ' ')}${tue ? `  (par ${par})` : ''}`);
  }
  console.log(`\n${retenus.length - survivants}/${retenus.length} mutants tués`);
  process.exitCode = survivants ? 1 : 0;
} finally {
  fs.rmSync(copie, { recursive: true, force: true });
}
