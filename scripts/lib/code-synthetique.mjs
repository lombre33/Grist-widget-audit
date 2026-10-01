/**
 * Du code JavaScript synthétique, déterministe pour une graine donnée, de la taille demandée : un dialecte de
 * code minifié (fonctions courtes, conditions en cascade, tableaux et objets littéraux) dont chaque construction
 * est une entrée de l'arbre d'analyse. Sert à faire porter à l'analyse statique une charge de mémoire et de
 * temps qui ne dépend d'aucun fichier extérieur : `scripts/mesurer-seuil-memoire.mjs` (le seuil mesuré) et les
 * essais qui provoquent une interruption par manque de mémoire.
 */

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function graine(g) {
  return () => { g |= 0; g = (g + 0x6D2B79F5) | 0; let t = Math.imul(g ^ (g >>> 15), 1 | g); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Du code minifié plausible : des fonctions courtes, des conditions en cascade, des tableaux et des objets littéraux. */
export function codeSynthetique(octets, g = 1) {
  const alea = graine(g);
  const nom = () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(alea() * 26)] + (alea() < 0.3 ? Math.floor(alea() * 10) : '');
  const expr = (p) => {
    if (p <= 0) return alea() < 0.5 ? nom() : String(Math.floor(alea() * 1000));
    switch (Math.floor(alea() * 7)) {
      case 0: return `${nom()}?${expr(p - 1)}:${expr(p - 1)}`;
      case 1: return `${nom()}(${expr(p - 1)},${expr(p - 1)})`;
      case 2: return `[${expr(p - 1)},${expr(p - 1)},${expr(p - 1)}]`;
      case 3: return `{${nom()}:${expr(p - 1)},${nom()}:${expr(p - 1)}}`;
      case 4: return `${nom()}.${nom()}[${expr(p - 1)}]`;
      case 5: return `"${nom()}${Math.floor(alea() * 100000)}"+${expr(p - 1)}`;
      default: return `(${expr(p - 1)}||${expr(p - 1)})&&${expr(p - 1)}`;
    }
  };
  const morceaux = [];
  let n = 0;
  for (let i = 0; n < octets; i++) {
    const m = `function f${i}(${nom()},${nom()},${nom()}){var ${nom()}=${expr(3)},${nom()}=${expr(2)};return ${expr(3)}}`;
    morceaux.push(m);
    n += m.length + 1;
  }
  return morceaux.join('\n');
}
