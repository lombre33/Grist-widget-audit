import assert from 'node:assert/strict';
import { analyserDuplication } from '../src/regles/a-qualite.js';
import { lire } from '../src/moteur/analyse-js.js';
import { noeudsDe } from '../src/moteur/clones.js';

/**
 * Ce que les essais de la règle de duplication (`a-dup`, `a-dup-ecarte`) partagent : des fichiers tels que l'inventaire les donne, et des fonctions de forme et de masse connues.
 */

/** Une fonction de masse 59 et de logique 9 (voir `tests/clones.test.mjs`). */
export const copie = (nom, actif = 'actif') => `function ${nom}(liste, transformer) {
  const resultat = [];
  for (let i = 0; i < liste.length; i++) {
    if (liste[i].${actif} && liste[i].valeur > 0) {
      resultat.push(transformer(liste[i]));
    } else {
      console.log('ignoré', liste[i]);
    }
  }
  return resultat;
}
`;

export function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, dossierExclu: false, ...extra };
}
export const constatsDe = (fichiers, options) => analyserDuplication({ fichiers }, options);
export const dup = (fichiers, options) => constatsDe(fichiers, options).filter((c) => c.regle === 'A-DUP-01');
/** Ce que la recherche dit ne pas avoir comparé (A-DUP-00), ou undefined. */
export const ecart = (fichiers, options) => constatsDe(fichiers, options).find((c) => c.regle === 'A-DUP-00');

/** `n` fonctions de structures toutes différentes, chacune assez grosse, séparées de lignes qui ne sont pas les mêmes d'un fichier à l'autre : autant de clones entre deux fichiers. */
export function fonctionsDistinctes(n, separateur) {
  return Array.from({ length: n }, (_, i) => `function f${i}(a) {\n${Array.from({ length: i + 6 }, () => '  if (a.x) { h(a); }').join('\n')}\n}\n${separateur(i)}\n`).join('');
}
export const separateurA = (i) => `var separateur${i} = ${i};`;
export const separateurB = (i) => `console.log(separateur, ${i});`;

/** Le nombre de nœuds d'une source : le plafond de la recherche se fixe au plus juste avec. */
export const noeudsDeSource = (source) => noeudsDe(lire(source).ast).length;

/** `source` suivie d'un commentaire qui la porte à `taille` caractères et `lignes` lignes exactement : de quoi poser un fichier juste de part et d'autre d'un seuil de longueur. */
export function rempli(source, taille, lignes) {
  const retours = lignes - 1 - (source.split('\n').length - 1);
  const x = taille - source.length - 4 - retours;
  assert.ok(retours >= 0 && x >= 0, `${lignes} lignes et ${taille} caractères ne tiennent pas autour de la source`);
  const texte = `${source}/*${'\n'.repeat(retours)}${'x'.repeat(x)}*/`;
  assert.equal(texte.length, taille);
  assert.equal(texte.split('\n').length, lignes);
  return texte;
}
/** `copie` écrite sur une seule ligne. */
export const copieSurUneLigne = (nom) => copie(nom).replace(/\n\s*/g, ' ');
