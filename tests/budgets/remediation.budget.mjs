/**
 * Budget de temps de F-RGAA-05 (src/regles/f-conformite.js), déplacé de `tests/remediation-precise.test.mjs` :
 * un retour arrière catastrophique relevé par la coordination le 2026-09-28 sur flashcards/index.html, un widget
 * officiel de Grist, dépassait le délai de 240 s de l'audit entier. Voir scripts/lib/budgets.mjs.
 */
import { analyserAccessibiliteStatique } from '../../src/regles/f-conformite.js';

const fichier = (chemin, contenu) => ({ chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false });

export const cas = [{
  nom: "F-RGAA-05 : du HTML sans </button> qui referme la construction reste linéaire (l'ancienne regex à quantificateurs imbriqués aurait explosé bien avant ce volume)",
  budgetMs: 1000,
  executer() {
    const piege = '<button>' + '<i> '.repeat(2000) + 'X'; // jamais de </button>
    const html = ['<!doctype html>', '<html><body>', piege, '</body></html>'].join('\n');
    analyserAccessibiliteStatique({ fichiers: [fichier('index.html', html)], entrees: ['index.html'] });
  },
}];
