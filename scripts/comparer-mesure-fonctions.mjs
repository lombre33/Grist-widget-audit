#!/usr/bin/env node
/**
 * Compare la mesure d'une fonction (`src/moteur/fonctions.js`) à celle qu'elle a remplacée, sur chaque fonction du code audité de dossiers
 * de widgets : la mesure qu'un changement de la façon de compter doit fournir avant d'être annoncé (le avant/après de
 * `scripts/comparer-avant-apres.mjs` dit ce que les notes en font, celui-ci dit ce que la mesure fait de chaque fonction).
 *
 * L'ancienne mesure (le dernier état de `mesurer` avant `fonctions.js`) est recopiée ici : la complexité comptait tout le sous-arbre de la
 * fonction, fonctions imbriquées comprises, et l'imbrication aussi, chaque branche d'un `else if` ouvrant un niveau. Ce qui doit tenir :
 *   - une fonction qui ne contient aucune autre fonction a la même complexité qu'avant, et la même imbrication une fois les `else if` mis
 *     à plat dans l'ancien calcul ;
 *   - aucune fonction n'est plus grande qu'avant, ni en complexité, ni en imbrication ;
 *   - l'étendue (de la première à la dernière ligne) est celle de la fonction.
 * Code de sortie 1 si l'une de ces trois choses ne tient pas pour une fonction, 0 sinon ; le détail des premières exceptions est écrit.
 *
 * Usage : node scripts/comparer-mesure-fonctions.mjs <dossier de widget>…
 */
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { pourChaqueUniteJs } from '../src/moteur/analyse-js.js';
import { mesurerFonction } from '../src/moteur/fonctions.js';

const OUVRENT_UN_NIVEAU = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement']);

/** L'ancienne mesure : tout le sous-arbre, fonctions imbriquées comprises. `elseIfAPlat` : la chaîne d'un `else if` ne descend pas d'un niveau par branche. */
function ancienneMesure(fonction, walk, elseIfAPlat) {
  let complexite = 1;
  walk.simple(fonction, {
    IfStatement() { complexite++; },
    ForStatement() { complexite++; },
    ForInStatement() { complexite++; },
    ForOfStatement() { complexite++; },
    WhileStatement() { complexite++; },
    DoWhileStatement() { complexite++; },
    SwitchCase(n) { if (n.test) complexite++; },
    CatchClause() { complexite++; },
    ConditionalExpression() { complexite++; },
    LogicalExpression(n) { if (n.operator === '&&' || n.operator === '||' || n.operator === '??') complexite++; },
  });
  let imbrication = 0;
  const pile = [[fonction.body, 0]];
  while (pile.length) {
    const [noeud, niveau] = pile.pop();
    if (!noeud || typeof noeud !== 'object') continue;
    const dedans = OUVRENT_UN_NIVEAU.has(noeud.type) ? niveau + 1 : niveau;
    if (dedans > imbrication) imbrication = dedans;
    for (const cle of Object.keys(noeud)) {
      if (cle === 'loc') continue;
      const v = noeud[cle];
      const suite = elseIfAPlat && noeud.type === 'IfStatement' && cle === 'alternate' && v?.type === 'IfStatement';
      if (Array.isArray(v)) { for (const x of v) pile.push([x, dedans]); }
      else if (v && typeof v.type === 'string') pile.push([v, suite ? niveau : dedans]);
    }
  }
  return { complexite, imbrication };
}

const dossiers = process.argv.slice(2);
if (!dossiers.length) {
  console.error('Usage : node scripts/comparer-mesure-fonctions.mjs <dossier de widget>…');
  process.exit(2);
}

const bilan = { fonctions: 0, sansInterne: 0, avecInterne: 0, complexiteIdentique: 0, imbricationIdentique: 0, imbricationPlusBasse: 0, elseIfAPlatIdentique: 0 };
const exceptions = [];
const noter = (nature, dossier, unite, noeud, ancien, neuf) => exceptions.push({ nature, dossier: path.basename(dossier), fichier: unite.chemin, ligne: noeud.loc.start.line, ancien, neuf });

for (const dossier of dossiers) {
  const contexte = construireContexte(dossier);
  pourChaqueUniteJs(contexte, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, unite, walk }) => {
    const visiter = (fonction) => {
      bilan.fonctions++;
      const neuf = mesurerFonction(fonction);
      const ancien = ancienneMesure(fonction, walk, false);
      let contientUneFonction = false;
      for (const dedans of [fonction.body, ...fonction.params]) {
        walk.simple(dedans, { FunctionDeclaration() { contientUneFonction = true; }, FunctionExpression() { contientUneFonction = true; }, ArrowFunctionExpression() { contientUneFonction = true; } });
      }
      if (neuf.etendue !== fonction.loc.end.line - fonction.loc.start.line + 1) noter('étendue', dossier, unite, fonction, null, neuf);
      if (neuf.complexite > ancien.complexite || neuf.imbrication > ancien.imbrication) noter('plus grande qu\'avant', dossier, unite, fonction, ancien, neuf);
      if (contientUneFonction) { bilan.avecInterne++; return; }
      bilan.sansInterne++;
      if (neuf.complexite === ancien.complexite) bilan.complexiteIdentique++; else noter('complexité différente', dossier, unite, fonction, ancien, neuf);
      if (neuf.imbrication === ancien.imbrication) bilan.imbricationIdentique++; else if (neuf.imbrication < ancien.imbrication) bilan.imbricationPlusBasse++;
      const plat = ancienneMesure(fonction, walk, true);
      if (plat.imbrication === neuf.imbrication) bilan.elseIfAPlatIdentique++; else noter('imbrication différente, else if à plat', dossier, unite, fonction, plat, neuf);
    };
    walk.simple(ast, { FunctionDeclaration: visiter, FunctionExpression: visiter, ArrowFunctionExpression: visiter });
  });
}

console.log(`${bilan.fonctions} fonctions, dont ${bilan.sansInterne} qui n'en contiennent aucune autre et ${bilan.avecInterne} qui en contiennent.`);
console.log(`Sans fonction interne : complexité identique pour ${bilan.complexiteIdentique} sur ${bilan.sansInterne} ; imbrication identique pour ${bilan.imbricationIdentique}, plus basse pour ${bilan.imbricationPlusBasse} (chaînes de \`else if\`) ; identique pour ${bilan.elseIfAPlatIdentique} sur ${bilan.sansInterne} quand l'ancien calcul met les \`else if\` à plat.`);
console.log(`Exceptions : ${exceptions.length}.`);
for (const e of exceptions.slice(0, 20)) console.log(`  ${e.nature} : ${e.dossier}/${e.fichier}:${e.ligne} ancien ${JSON.stringify(e.ancien)} neuf ${JSON.stringify(e.neuf)}`);
process.exit(exceptions.length ? 1 : 0);
