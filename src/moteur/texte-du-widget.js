/**
 * Un texte que le widget choisit (l'émetteur d'un jeton, le nom d'une affectation) et qu'une règle cite dans le texte d'un constat.
 *
 * Ce texte part dans des sorties qui ne s'en protègent pas de la même façon : la page HTML l'échappe, le Markdown n'échappe aucun texte de constat
 * (une balise, un titre, une barre verticale ou des guillemets inversés du widget s'y liraient comme du Markdown), le JSON et le SARIF le portent comme
 * une donnée, et une console l'affiche tel quel (un caractère d'échappement y change le titre du terminal ou recouvre ce qui précède). Une règle qui
 * le cite le passe donc par `citer` : chaque caractère qu'on ne voit pas (un contrôle, un séparateur de ligne, un caractère de format ou de sens
 * d'écriture) est remplacé par son écriture visible (`\u001b`), puis le texte est mis dans un extrait de code du Markdown, où rien n'a plus de sens :
 * ni balise, ni titre, ni liste, ni lien, ni barre. Les autres sorties le montrent tel quel, guillemets inversés compris, sans aucun caractère de
 * contrôle.
 *
 * Limite, dite pour que personne ne la croie levée : seuls les textes qu'une règle passe par `citer` ont cette garantie. Les autres textes du
 * widget qu'un constat recopie (un chemin de fichier, un extrait de code, un nom qu'une autre règle cite) sont rendus tels quels par le Markdown.
 */

/** Ce qu'on ne voit pas : les contrôles (dont les retours à la ligne, le caractère d'échappement et les contrôles C1, dont CSI), les séparateurs de ligne et de paragraphe, les caractères de format (sens d'écriture, espaces de largeur nulle, trait d'union conditionnel, marque d'ordre des octets, étiquettes). */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `\u001b` pour un caractère du plan de base, `\u{e0067}` au-delà : l'écriture d'un littéral JavaScript, que tout lecteur de code reconnaît. */
function ecritureVisible(caractere) {
  const hexa = caractere.codePointAt(0).toString(16);
  return hexa.length <= 4 ? `\\u${hexa.padStart(4, '0')}` : `\\u{${hexa}}`;
}

/** Le texte rendu bien formé (une moitié de paire de substitution devient U+FFFD), sans aucun caractère invisible : chacun s'écrit en clair. */
export function neutraliser(texte) {
  return texte.toWellFormed().replace(INVISIBLE, ecritureVisible);
}

/**
 * Le texte neutralisé, mis dans un extrait de code du Markdown (un texte non vide ; chaque caractère invisible s'y écrit en six). La barre
 * d'ouverture est plus longue que toute suite de guillemets inversés du texte, donc rien du texte ne la ferme ; un texte qui commence ou finit
 * par un guillemet inversé ou par une espace est calé d'une espace de chaque côté, que le Markdown retire à la lecture (sauf pour un texte fait
 * d'espaces, qu'il garde tel quel).
 */
export function citer(texte) {
  const t = neutraliser(texte);
  let plusLongue = 0;
  for (const suite of t.matchAll(/`+/g)) if (suite[0].length > plusLongue) plusLongue = suite[0].length;
  const barre = '`'.repeat(plusLongue + 1);
  const cale = !/^ *$/.test(t) && /^[ `]|[ `]$/.test(t) ? ' ' : '';
  return `${barre}${cale}${t}${cale}${barre}`;
}

/** Un caractère qu'une sortie lit comme autre chose que lui-même : Markdown (code, balise, entité, emphase, lien, image, table, titre, barré, formule, mention d'un compte), ou un invisible. */
const FRAGILE = /[`<>&|*[\]\\~#!(){}$@]|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Le texte tel quel quand aucun caractère n'y a de sens pour une sortie (le nom d'une affectation honnête : `api_key`, `db.password`, `x-api-key`), cité sinon.
 * Le texte d'un constat sur du code honnête ne change donc pas.
 */
export function citerSiBesoin(texte) {
  return FRAGILE.test(texte) ? citer(texte) : texte;
}
