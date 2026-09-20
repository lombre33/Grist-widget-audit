/**
 * Comparaison de deux rapports gwaudit (`rapport.json`, produit avec
 * `--json`) du même widget à deux instants différents — typiquement avant/
 * après un correctif, ou entre deux exécutions CI.
 *
 * Un `uid` de constat inclut un compteur propre à l'exécution qui l'a
 * produit : il n'est donc pas comparable d'un rapport à l'autre. L'identité
 * utilisée ici est (axe, règle, fichier, ligne), stable tant que le code
 * incriminé ne change pas de place.
 */
function cle(c) {
  return `${c.axe}|${c.regle}|${c.fichier ?? ''}|${c.ligne ?? ''}`;
}

function indexerConstats(rapport) {
  const m = new Map();
  for (const axe of Object.values(rapport.axes ?? {})) {
    for (const c of axe.constats ?? []) m.set(cle(c), c);
  }
  return m;
}

export function comparerRapports(ancien, nouveau) {
  const avant = indexerConstats(ancien);
  const apres = indexerConstats(nouveau);

  const corriges = [...avant.entries()].filter(([k]) => !apres.has(k)).map(([, c]) => c);
  const nouveaux = [...apres.entries()].filter(([k]) => !avant.has(k)).map(([, c]) => c);
  const persistants = [...apres.entries()].filter(([k]) => avant.has(k)).map(([, c]) => c);

  const deltaParAxe = {};
  const codesAxes = new Set([...Object.keys(ancien.axes ?? {}), ...Object.keys(nouveau.axes ?? {})]);
  for (const code of codesAxes) {
    const sa = ancien.axes?.[code]?.score ?? null;
    const sn = nouveau.axes?.[code]?.score ?? null;
    deltaParAxe[code] = { avant: sa, apres: sn, delta: sa !== null && sn !== null ? sn - sa : null };
  }

  return {
    verdictAvant: ancien.verdict ?? null,
    verdictApres: nouveau.verdict ?? null,
    scoreAvant: ancien.scoreGlobal ?? null,
    scoreApres: nouveau.scoreGlobal ?? null,
    deltaScore: (nouveau.scoreGlobal ?? 0) - (ancien.scoreGlobal ?? 0),
    deltaParAxe,
    corriges,
    nouveaux,
    persistants,
  };
}

function signe(n) {
  return n > 0 ? '+' : '';
}

function ligneConstat(c) {
  const loc = c.fichier ? ` — \`${c.fichier}${c.ligne ? ':' + c.ligne : ''}\`` : '';
  return `- **${c.regle}** (axe ${c.axe}, ${c.severite}) — ${c.titre}${loc}`;
}

export function genererDiffMarkdown(diff, { ancienChemin, nouveauChemin } = {}) {
  const l = [];
  l.push('# Comparaison de deux audits gwaudit');
  if (ancienChemin && nouveauChemin) l.push(`\n\`${ancienChemin}\` → \`${nouveauChemin}\``);
  l.push(`\nVerdict : **${diff.verdictAvant}** → **${diff.verdictApres}**`);
  l.push(`Score global : **${diff.scoreAvant}/100** → **${diff.scoreApres}/100** (${signe(diff.deltaScore)}${diff.deltaScore})`);

  l.push('\n## Score par axe\n');
  l.push('| Axe | Avant | Après | Δ |');
  l.push('|---|---|---|---|');
  for (const [code, d] of Object.entries(diff.deltaParAxe)) {
    l.push(`| ${code} | ${d.avant ?? '—'} | ${d.apres ?? '—'} | ${d.delta === null ? '—' : `${signe(d.delta)}${d.delta}`} |`);
  }

  l.push(`\n## Constats corrigés (${diff.corriges.length})\n`);
  l.push(diff.corriges.length ? diff.corriges.map(ligneConstat).join('\n') : '_Aucun._');
  l.push(`\n## Nouveaux constats (${diff.nouveaux.length})\n`);
  l.push(diff.nouveaux.length ? diff.nouveaux.map(ligneConstat).join('\n') : '_Aucun._');
  l.push(`\n## Constats persistants (${diff.persistants.length})\n`);
  l.push(diff.persistants.length ? diff.persistants.map(ligneConstat).join('\n') : '_Aucun._');

  return l.join('\n') + '\n';
}
