/**
 * Valide la forme d'un scénario d'axe D personnalisé (--scenario) : un
 * objet JSON avec une clé "colonnes" (objet non vide de tableaux de
 * valeurs). Ne vérifie rien de plus sur le contenu des colonnes elles-mêmes
 * — voir documentDeTest() dans dynamique.js pour ce qui en est fait une
 * fois validé (notamment l'ajout systématique de la sonde XSS).
 */
export function validerScenario(brut) {
  if (typeof brut !== 'object' || brut === null || Array.isArray(brut)) {
    throw new Error("le scénario doit être un objet JSON (voir README § Personnaliser le scénario de l'axe D)");
  }
  if (!brut.colonnes || typeof brut.colonnes !== 'object' || Array.isArray(brut.colonnes) || !Object.keys(brut.colonnes).length) {
    throw new Error('le scénario doit définir "colonnes" : un objet non vide de tableaux de valeurs');
  }
  for (const [nom, valeurs] of Object.entries(brut.colonnes)) {
    if (!Array.isArray(valeurs)) throw new Error(`la colonne "${nom}" doit être un tableau de valeurs`);
  }
  return brut;
}
