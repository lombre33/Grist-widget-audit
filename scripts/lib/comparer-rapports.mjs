/**
 * Comparaison de deux rapports `rapport.json` d'une même cible, produits par
 * deux versions de l'outil (voir `scripts/comparer-avant-apres.mjs`).
 *
 * Un score identique ne prouve pas que les constats le sont : un constat en
 * moins et un autre en plus se compensent, et une sévérité qui change sous le
 * plafond d'un axe ne bouge aucune note. On compare donc les notes (verdict,
 * score global, bloquants, score de chaque axe) ET les constats un à un.
 *
 * Un constat est identifié par son axe, sa règle, son fichier, sa ligne, sa
 * sévérité, son caractère bloquant et son titre, avec sa multiplicité (deux
 * constats de même clé qui deviennent un seul sont une différence). Pour une
 * même clé en même nombre, on compare aussi les champs qu'un lecteur voit
 * (texte, extrait, confiance, mesure partielle). `uid` (un compteur) et
 * `preuve` (une trace brute) ne sont jamais comparés.
 */

export const CHAMPS_LUS = ['constat', 'impact', 'remediation', 'extrait', 'confiance', 'mesurePartielle'];

export function resumeNotes(rapport) {
  const axes = Object.entries(rapport.axes).map(([code, a]) => `${code}=${a.score === null ? '—' : a.score}`).join(' ');
  return `${rapport.verdict} ${rapport.scoreGlobal} (${rapport.bloquants.length} bloq.) ${axes}`;
}

const constatsDe = (rapport) => Object.entries(rapport.axes).flatMap(([axe, a]) => (a.constats ?? []).map((c) => ({ ...c, axe })));

// L'identité est un JSON (jamais une simple concaténation : un `|` dans un titre ou un chemin ne fait pas de faux doublon) ;
// un fichier ou une ligne absents (undefined) et nuls (null) sont le même constat.
const tuple = (c) => [c.axe, c.regle, c.fichier, c.ligne, c.severite, Boolean(c.bloquant), c.titre];
const identite = (c) => JSON.stringify(tuple(c));
const libelle = (c) => tuple(c).map((x) => x ?? '').join('|');

function grouper(constats) {
  const groupes = new Map();
  for (const c of constats) {
    const k = identite(c);
    if (groupes.has(k)) groupes.get(k).constats.push(c);
    else groupes.set(k, { libelle: libelle(c), constats: [c] });
  }
  return groupes;
}

/**
 * @returns {{
 *   notesAvant: string, notesApres: string, notesIdentiques: boolean,
 *   constatsAvant: number, constatsApres: number,
 *   retires: Array<{ cle: string, n: number }>, ajoutes: Array<{ cle: string, n: number }>,
 *   textes: Array<{ cle: string, champs: string[] }>, identique: boolean,
 * }}
 */
export function comparerRapports(avant, apres) {
  const listeAvant = constatsDe(avant);
  const listeApres = constatsDe(apres);
  const groupesAvant = grouper(listeAvant);
  const groupesApres = grouper(listeApres);

  const retires = [];
  const ajoutes = [];
  const textes = [];
  for (const [k, { libelle: cle, constats: v }] of groupesAvant) {
    const w = groupesApres.get(k)?.constats ?? [];
    if (v.length > w.length) retires.push({ cle, n: v.length - w.length });
    else if (v.length === w.length) {
      const champs = CHAMPS_LUS.filter((champ) => {
        const lire = (l) => l.map((c) => JSON.stringify(c[champ] ?? null)).sort().join('\n');
        return lire(v) !== lire(w);
      });
      if (champs.length) textes.push({ cle, champs });
    }
  }
  for (const [k, { libelle: cle, constats: w }] of groupesApres) {
    const v = groupesAvant.get(k)?.constats ?? [];
    if (w.length > v.length) ajoutes.push({ cle, n: w.length - v.length });
  }

  const notesAvant = resumeNotes(avant);
  const notesApres = resumeNotes(apres);
  return {
    notesAvant, notesApres, notesIdentiques: notesAvant === notesApres,
    constatsAvant: listeAvant.length, constatsApres: listeApres.length,
    retires, ajoutes, textes,
    identique: notesAvant === notesApres && !retires.length && !ajoutes.length && !textes.length,
  };
}
