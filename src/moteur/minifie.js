/**
 * Le code minifié : ce qu'aucun relecteur ne lit. Un seul test, pour tous ceux qui en ont besoin (l'exemption des axes A et B, le constat B-MIN-01).
 *
 * Le test se fait en deux temps. La forme du texte d'abord, qui ne coûte qu'un passage : des lignes de plus de 200 caractères en moyenne, sur plus de 1 Kio.
 * Rien sur le nombre de lignes, qu'un code minifié n'a pas : une seule ligne de 20 Kio l'est. Mais la forme ne suffit pas : des lignes de commentaire très longues,
 * une image en base64 ou un tableau de données la remplissent aussi, et le fichier est alors lisible. Elle est donc confirmée par le code que lit acorn :
 * beaucoup de jetons par ligne (une chaîne, un gabarit ou une expression régulière n'en font qu'un, un commentaire aucun), dont une part de noms et de mots-clés
 * (un tableau de nombres n'en a aucun).
 */
import { tokenizer, tokTypes } from 'acorn';

const LIGNE_MOYENNE = 200;
const TAILLE_MIN = 1024;
/** Le début du texte que la confirmation lit : un dépôt hostile n'allonge pas l'audit d'un fichier de plusieurs Mio. */
const ECHANTILLON = 200_000;
const JETONS_PAR_LIGNE = 25;
const PART_DE_MOTS = 0.25;

function nombreDeLignes(texte) {
  let lignes = 1;
  for (let i = texte.indexOf('\n'); i !== -1; i = texte.indexOf('\n', i + 1)) lignes++;
  return lignes;
}

/** Les jetons de code d'un texte JavaScript et, parmi eux, les noms et mots-clés ; ce qu'acorn n'a pas pu lire (une fin coupée, une syntaxe qu'il ne connaît pas) arrête le compte, sans le défaire. */
function compterJetons(texte) {
  let jetons = 0, mots = 0;
  try {
    for (const jeton of tokenizer(texte, { ecmaVersion: 'latest', allowHashBang: true })) {
      jetons++;
      if (jeton.type === tokTypes.name || jeton.type.keyword) mots++;
    }
  } catch { /* on garde ce qui a été compté */ }
  return { jetons, mots };
}

/** Le texte d'un fichier JavaScript est-il du code minifié ? */
export function estMinifie(texte) {
  if (texte.length <= TAILLE_MIN || texte.length / nombreDeLignes(texte) <= LIGNE_MOYENNE) return false;
  const debut = texte.slice(0, ECHANTILLON);
  const { jetons, mots } = compterJetons(debut);
  return jetons / nombreDeLignes(debut) >= JETONS_PAR_LIGNE && mots / jetons >= PART_DE_MOTS;
}

/**
 * L'en-tête d'un fichier dit-il ce qu'il est : un numéro de version et une licence dans ses 2 000 premiers caractères ? C'est ce qui fait d'un fichier minifié une
 * bibliothèque tierce que l'axe E suit (E-DEP-02, en information), non un code que personne ne peut relire.
 */
export function enTeteIdentifiee(texte) {
  const debut = texte.slice(0, 2000);
  return /v?\d+\.\d+\.\d+/.test(debut) && /@license|MIT License|Apache License|BSD|\(c\)\s*\d{4}/i.test(debut);
}
