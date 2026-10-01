/**
 * Budgets de temps de l'analyse d'accessibilité statique (src/regles/f-conformite.js), déplacés de
 * `tests/accessibilite-statique.test.mjs` : chaque page ci-dessous est un piège de un mégaoctet que
 * l'analyse a déjà rendu quadratique (ou a failli). Voir scripts/lib/budgets.mjs.
 */
import { analyserAccessibiliteStatique } from '../../src/regles/f-conformite.js';

function fichier(contenu) {
  return { chemin: 'index.html', contenu, lignes: contenu.split('\n'), ext: '.html', binaire: false, executee: true, vendorise: false };
}

const MIO = 1024 * 1024;
const PIEGES = {
  'boutons non fermés': '<button>'.repeat(MIO / 8),
  'boutons et icônes non fermés': '<button><i>'.repeat(MIO / 11),
  'div imbriqués puis </p> sans p ouvert': '<div>'.repeat(MIO / 10) + '</p>'.repeat(MIO / 8),
  'formatage non fermé puis </p>': '<b><i><u><s>'.repeat(MIO / 24) + '</p>'.repeat(MIO / 8),
  'div imbriqués puis <p>': '<div>'.repeat(MIO / 10) + '<p>'.repeat(MIO / 6),
  'une balise à des dizaines de milliers d\'attributs distincts': `<button ${Array.from({ length: MIO / 8 }, (_, i) => `a${i.toString(36)}`).join(' ')}>`,
  'images, champs, labels et html sans >': '<img <input <label <html '.repeat(MIO / 26),
  'svg et sorties vers le HTML': '<svg><g><div>'.repeat(MIO / 13),
};


export const cas = Object.entries(PIEGES).map(([nom, contenu]) => ({
  nom: `page piégée : ${nom} (environ 1 Mio)`,
  budgetMs: 2000,
  executer() { analyserAccessibiliteStatique({ fichiers: [fichier(contenu)], entrees: ['index.html'] }); },
}));
