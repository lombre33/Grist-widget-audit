#!/usr/bin/env node
/**
 * Rejoue les mutants du correctif de l'étape 1 de la passe HTML (voir
 * `scripts/lib/rejouer-mutants.mjs` pour la méthode : copie temporaire,
 * chaînes vérifiées d'avance, suite verte et complète sur le code non muté).
 *
 * Usage : GWAUDIT_CHROMIUM_PATH=/chemin/vers/chromium node scripts/mutants-passe-html.mjs [point…] [--part=i/n]
 */
import { lireArguments, rejouerMutants } from './lib/rejouer-mutants.mjs';

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

const { partie, restants: points } = lireArguments(process.argv.slice(2));
const mutants = MUTANTS
  .filter(([point]) => !points.length || points.includes(String(point)))
  .map(([point, fichier, ancien, nouveau]) => ({ libelle: `point ${point}  ${fichier}  ${ancien.slice(0, 60).replace(/\n/g, ' ')}`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({
  mutants,
  groupes: [{ nom: 'tests ciblés', fichiers: RAPIDES }, { nom: 'différentiel Chromium', fichiers: [DIFFERENTIEL] }],
  partie,
});
