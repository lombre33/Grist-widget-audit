/** Export JSON — pour intégration outillée (V2, CI, tableau de bord). */
export function genererJson({ ctx, notation, meta }) {
  const axes = {};
  for (const [code, a] of Object.entries(notation.parAxe)) {
    axes[code] = { titre: a.titre, score: a.score, nonExecute: a.nonExecute, repartition: a.repartition, constats: a.constats };
  }
  return JSON.stringify({
    outil: 'gwaudit', version: meta.version, genereLe: new Date().toISOString(),
    depot: meta.nomDepot, cible: meta.cible ?? null, commit: meta.commit ?? null,
    contexte: {
      fichiers: ctx.fichiers.length, surfaceExecutee: ctx.surface.size,
      entrees: ctx.entrees, niveauxAccesDetectes: [...new Set((ctx.usagesGrist?.acces ?? []).map((a) => a.niveau))],
      tronque: meta.tronque ?? null,
    },
    verdict: notation.verdict, motif: notation.motif, scoreGlobal: notation.global,
    bloquants: notation.bloquants.map((c) => c.uid),
    axesNonExecutes: notation.axesNonExecutes,
    axes,
  }, null, 2);
}
