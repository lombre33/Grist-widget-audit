/**
 * Le numéro de la ligne qui porte un caractère d'un contenu : la question qu'une règle pose à
 * chaque occurrence d'un motif (une référence, un marqueur de travail, un hôte).
 *
 * `contenu.slice(0, index).split('\n').length` recopie tout le début du contenu à chaque réponse :
 * posé pour chaque occurrence d'un fichier de plusieurs Mio, il rend la règle quadratique (un dépôt
 * hostile n'a qu'à répéter le motif). Les sauts de ligne d'un contenu se relèvent une fois ; chaque
 * réponse est ensuite une recherche par dichotomie.
 */

// Les huit derniers contenus interrogés gardent leurs sauts de ligne : une règle qui parcourt les
// fichiers l'un après l'autre n'en a besoin que d'un à la fois, une qui alterne entre deux ou trois ne
// les recalcule pas, et la mémoire retenue reste bornée quel que soit le nombre de fichiers.
const SAUTS_DE_LIGNE = new Map();
const TAILLE_SAUTS = 8;

/** Le numéro (à partir de 1) de la ligne qui porte le caractère `index` de `contenu`. */
export function numeroLigne(contenu, index) {
  let sauts = SAUTS_DE_LIGNE.get(contenu);
  if (!sauts) {
    sauts = [];
    for (let i = contenu.indexOf('\n'); i !== -1; i = contenu.indexOf('\n', i + 1)) sauts.push(i);
    if (SAUTS_DE_LIGNE.size >= TAILLE_SAUTS) SAUTS_DE_LIGNE.clear();
    SAUTS_DE_LIGNE.set(contenu, sauts);
  }
  let a = 0;
  let b = sauts.length;
  while (a < b) {
    const milieu = (a + b) >> 1;
    if (sauts[milieu] < index) a = milieu + 1;
    else b = milieu;
  }
  return a + 1;
}
