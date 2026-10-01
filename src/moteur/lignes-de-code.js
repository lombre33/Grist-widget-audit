/**
 * Les lignes d'un fichier JavaScript comptées sur ce qu'elles portent : du code, un commentaire seul, ou rien.
 *
 * L'inventaire (`locSignificatives`) juge une ligne à son premier caractère, avant toute lecture du code : une ligne qui commence par `//`, `/*`,
 * `*`, `#` ou `<!--` est un commentaire, toute autre ligne non vide est du code. Cela se trompe des deux côtés. Les lignes d'un commentaire de bloc
 * qui n'ont pas d'étoile en tête comptent pour du code ; une ligne de code qui commence par `*` (la suite d'une multiplication), par `#` (un champ
 * privé), ou le contenu d'un gabarit de plusieurs lignes qui commence par `//` comptent pour des commentaires ; `/* x *\/ f();` est une ligne de
 * code qu'on compte pour un commentaire. Les règles de taille (A-TAILLE-01, B-VERB-01) et de densité de commentaires (B-COM-01) mesurent ce
 * que le relecteur lira : elles comptent ici, sur les commentaires que lit acorn, et rien n'y est deviné d'un premier caractère.
 *
 * Une ligne est du code dès qu'un caractère qui n'est pas un blanc est hors de tout commentaire (une chaîne, un gabarit, une expression
 * régulière sont du code), un commentaire quand elle n'a que des blancs et des caractères de commentaire, vide quand elle n'a que des blancs
 * (un blanc dans un commentaire de bloc ne fait pas d'une ligne un commentaire). Les fins de ligne sont celles d'acorn : `\n`, `\r\n`, `\r`,
 * U+2028 et U+2029, donc les mêmes que celles des numéros de ligne des constats ; un fichier dont les lignes ne sont séparées que par `\r` n'est
 * pas une seule ligne. Un seul parcours du texte, sans mémoire de plus que la liste des commentaires que l'arbre porte déjà.
 */
import { unitesJs, lireUnite } from './analyse-js.js';

const NL = 10, CR = 13, LS = 0x2028, PS = 0x2029;

/** Les blancs que `String.prototype.trim` retire, fins de ligne exclues (celles-ci ferment la ligne, elles n'y sont pas). */
function estBlanc(c) {
  return c === 32 || (c >= 9 && c <= 12) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/**
 * Compte les lignes d'un texte JavaScript.
 * @param {string} source
 * @param {Array<{debut: number, fin: number}>} commentaires les commentaires de `source` dans l'ordre du texte, en décalages de caractères (`fin` exclu), tels qu'acorn les donne
 * @returns {{code: number, commentaire: number, vide: number}} une ligne n'est comptée qu'une fois ; ce qui suit la dernière fin de ligne n'est une ligne que s'il y a quelque chose
 */
export function compterLignes(source, commentaires) {
  let code = 0, commentaire = 0, vide = 0;
  let porteDuCode = false, porteUnCommentaire = false, ligneOuverte = false;
  let suivant = 0, debutCourant = 0, finCourant = 0;                     // le commentaire courant : vide au départ, le premier caractère qui compte le remplace
  const n = source.length;
  const fermer = () => {
    if (porteDuCode) code++;
    else if (porteUnCommentaire) commentaire++;
    else vide++;
    porteDuCode = porteUnCommentaire = ligneOuverte = false;
  };
  for (let i = 0; i < n; i++) {
    const c = source.charCodeAt(i);
    if (c === NL || c === CR || c === LS || c === PS) {
      if (c === CR && source.charCodeAt(i + 1) === NL) i++;
      fermer();
      continue;
    }
    ligneOuverte = true;
    if (estBlanc(c)) continue;
    while (i >= finCourant && suivant < commentaires.length) {
      debutCourant = commentaires[suivant].debut;
      finCourant = commentaires[suivant].fin;
      suivant++;
    }
    if (i >= debutCourant && i < finCourant) porteUnCommentaire = true;
    else porteDuCode = true;
  }
  if (ligneOuverte) fermer();
  return { code, commentaire, vide };
}

/** Les lignes que `locSignificatives` ne rangeait pas dans le code et que B-COM-01 comptait pour des commentaires : le repli quand le fichier n'est pas lu par acorn. */
const DEBUT_DE_COMMENTAIRE = /^\s*(\/\/|\/\*|\*)/;

/** Ce qu'un constat ajoute à un nombre de lignes que la lecture du code n'a pas confirmé (`exacte` faux) : il le dit, il ne le laisse pas passer pour exact. */
export const NOTE_LIGNES_APPROCHEES = " Les lignes sont comptées d'après leur premier caractère : acorn ne lit pas ce fichier.";

const memoire = new WeakMap();

/**
 * Les lignes d'un fichier JavaScript de l'inventaire : `code`, `commentaire`, `vide`, et `exacte` (vrai quand elles sont comptées sur les
 * commentaires qu'acorn lit). Un fichier qu'acorn ne lit pas (JSX, TypeScript, erreur de syntaxe) n'a pas de commentaires à relever : ses lignes
 * se jugent alors au premier caractère comme l'inventaire le fait (`exacte` est faux, et le constat qui cite ce nombre le dit). Le résultat se
 * garde par fichier, et l'arbre n'est pas gardé : un fichier se lit une fois de plus ici, pas une fois par règle qui compte ses lignes.
 * @returns {{code: number, commentaire: number, vide: number, exacte: boolean}}
 */
export function mesurerLignes(f) {
  let mesure = memoire.get(f);
  if (!mesure) {
    const unite = unitesJs(f).find((u) => !u.inline);
    const { ast } = unite ? lireUnite(f, unite) : { ast: null };
    mesure = ast
      ? { ...compterLignes(f.contenu, ast.commentaires), exacte: true }
      : {
        code: f.locSignificatives ?? 0,
        commentaire: (f.lignes ?? []).filter((l) => DEBUT_DE_COMMENTAIRE.test(l)).length,
        vide: 0,
        exacte: false,
      };
    memoire.set(f, mesure);
  }
  return mesure;
}
