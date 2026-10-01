/**
 * Ce que le contexte de l'analyse statique laisse derrière lui quand l'analyse tourne dans
 * un processus enfant (src/isolement) : les rapports et l'axe D ne lisent qu'une petite
 * partie de `ctx`, et le reste (le contenu de tous les fichiers, leurs arbres) reste dans
 * l'enfant, qui s'arrête.
 *
 * Consommateurs, et ce qu'ils lisent — un champ qui manque ici se voit à
 * `tests/resume-contexte.test.mjs`, qui compare chaque rapport rendu avec le contexte
 * entier et avec son résumé :
 *   src/rapport/*       fichiersReels (ou fichiers.length), surface.size, entrees, usagesGrist.acces[].niveau ;
 *                       SARIF : ctx.fichiers pour remonter d'un code littéral au fichier réel
 *   src/runtime/dynamique.js   racine, entrees[0]
 *   src/regles/d-perimetre.js  le README à la racine (contenu), usagesGrist.acces[0].niveau
 *   bin/gwaudit.js      tronque
 *
 * Écrit en deux temps : juste après la construction du contexte (`usagesGrist` n'existe
 * pas encore : c'est l'axe C qui le renseigne), puis à la fin des règles. Si l'enfant meurt
 * entre les deux, le premier suffit à jouer l'axe D.
 */
import path from 'node:path';

const README = /^readme(\.md|\.txt)?$/i;

export function resumerContexte(ctx) {
  const fichiers = ctx.fichiers;
  // Un fichier synthétique (code littéral exécuté en chaîne) renvoie au fichier d'où il vient : SARIF suit la chaîne jusqu'à un vrai fichier.
  const utiles = new Map();
  const ajouter = (f, champs) => { if (f && !utiles.has(f.chemin)) utiles.set(f.chemin, { chemin: f.chemin, ...champs(f) }); };
  const parChemin = new Map(fichiers.map((f) => [f.chemin, f]));
  for (const f of fichiers) {
    if (README.test(path.basename(f.chemin)) && !f.chemin.includes('/')) ajouter(f, (x) => ({ contenu: x.contenu ?? null }));
    if (f.litteralImbrique && f.origineReelle) {
      ajouter(f, (x) => ({ litteralImbrique: true, origineReelle: x.origineReelle }));
      const vus = new Set([f.chemin]);
      for (let cible = f; cible?.litteralImbrique && cible.origineReelle && !vus.has(cible.origineReelle.chemin); ) {
        const suivant = parChemin.get(cible.origineReelle.chemin);
        vus.add(cible.origineReelle.chemin);
        ajouter(suivant, (x) => (x.litteralImbrique && x.origineReelle ? { litteralImbrique: true, origineReelle: x.origineReelle } : {}));
        cible = suivant;
      }
    }
  }
  let plusGros = null;
  for (const f of fichiers) if (f.code && (!plusGros || f.taille > plusGros.taille)) plusGros = { chemin: f.chemin, taille: f.taille };

  return {
    racine: ctx.racine,
    entrees: [...ctx.entrees],
    fichiersReels: ctx.fichiersReels ?? fichiers.length,
    tailleSurface: ctx.surface.size,
    tronque: ctx.tronque ?? null,
    plusGrosFichierDeCode: plusGros,
    fichiers: [...utiles.values()],
    ...(ctx.usagesGrist ? { usagesGrist: { acces: (ctx.usagesGrist.acces ?? []).map((a) => ({ niveau: a.niveau })) } } : {}),
  };
}

/** Un contexte qui répond aux consommateurs ci-dessus à partir du résumé ; `usagesGrist` y est absent tant que l'axe C n'a pas tourné. */
export function contexteDepuisResume(resume) {
  return {
    racine: resume.racine,
    entrees: resume.entrees,
    fichiersReels: resume.fichiersReels,
    surface: { size: resume.tailleSurface },
    tronque: resume.tronque,
    fichiers: resume.fichiers,
    ...(resume.usagesGrist ? { usagesGrist: resume.usagesGrist } : {}),
  };
}
