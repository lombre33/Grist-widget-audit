/**
 * Ce que les essais de la recherche de clones partagent (`clones-idiomes`, `clones-series`, `clones-candidats`) : des unités lues, une recherche en une ligne,
 * les endroits d'un clone, et des briques de code de forme et de masse connues, pour écrire à la main ce que la recherche doit trouver.
 */
import assert from 'node:assert/strict';
import { lire } from '../src/moteur/analyse-js.js';
import { creerTables, detecterClones, noeudsDe, numeroter } from '../src/moteur/clones.js';

/** Une unité à comparer : le chemin qu'elle dit et les lignes de ses nœuds (`decalage` : une ligne de départ dans le fichier réel). */
export const unite = (chemin, source, decalage = 0) => {
  const { ast, erreur } = lire(source);
  assert.ok(ast, `la source doit se lire : ${erreur?.message}`);
  return { chemin, ast, ligneDe: (n) => n.loc.start.line + decalage, ligneFinDe: (n) => n.loc.end.line + decalage };
};
/** Les unités d'un objet `{ chemin: source }`, dans son ordre. */
export const unitesDe = (sources) => Object.entries(sources).map(([chemin, source]) => unite(chemin, source));
/** La recherche entière : `{ clones, limites }`. */
export const chercher = (sources, seuils) => detecterClones(unitesDe(sources), seuils);
export const clonesDe = (sources, seuils) => chercher(sources, seuils).clones;
/** `chemin:ligne-ligneFin` de chaque exemplaire d'un clone, dans l'ordre où il les dit. */
export const endroits = (clone) => clone.instances.map((i) => `${i.chemin}:${i.ligne}-${i.ligneFin}`);

/** La masse et la logique (le premier nœud de la liste de ses instructions) d'une source, pour fixer les seuils au plus juste. */
export const mesureDe = (source, chemin = (ast) => ast.body[0]) => {
  const { ast, erreur } = lire(source);
  assert.ok(ast, `la source doit se lire : ${erreur?.message}`);
  numeroter(noeudsDe(ast), creerTables());
  const noeud = chemin(ast);
  return { masse: noeud.__m, logique: noeud.__l };
};

/**
 * Trois instructions de même masse (6) et de même logique (2), de trois formes : `if`, `while`, `for`. Deux d'entre elles, l'une après l'autre, font une série
 * de masse 12 et de logique 4 ; l'ordre dit la forme de la série (`SI_TANT` et `TANT_SI` sont deux séries de même masse et de formes différentes).
 */
export const SI = (a = 'a', b = 'b') => `if (${a}) { ${b}(); }`;
export const TANT = (a = 'c', b = 'd') => `while (${a}) { ${b}(); }`;
export const POUR = (a = 'e', b = 'f') => `for (; ${a}; ) { ${b}(); }`;
/** Une instruction à part, d'autant de nœuds que `profondeur` en demande : `s0.s1…;`. Deux profondeurs différentes donnent deux formes différentes : un séparateur qui ne se prolonge ni ne se confond avec rien. */
export const separateur = (profondeur) => `${Array.from({ length: profondeur + 1 }, (_, i) => `s${i}`).join('.')};`;
/** Les lignes d'un programme, une instruction par ligne. */
export const lignes = (...instructions) => `${instructions.join('\n')}\n`;

/** Une fonction qui a exactement cette masse et cette logique (`g(1, …); g(); …` : trois nœuds par appel, un de logique chacun, la fonction elle-même en porte un). Deux logiques différentes font deux formes différentes. */
export function fonctionDe(nom, masse, logique) {
  const appels = logique - 1;
  const remplissage = masse - 3 - 3 * appels;
  assert.ok(appels >= 1 && remplissage >= 0, `masse ${masse} et logique ${logique} : impossible`);
  return `function ${nom}() { g(${Array(remplissage).fill('1').join(', ')}); ${'g(); '.repeat(appels - 1)}}\n`;
}
