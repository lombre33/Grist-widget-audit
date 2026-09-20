/**
 * Rendu du rapport d'audit en Markdown — format de lecture principal.
 *
 * Structure pensée pour un lecteur pressé : verdict et chiffres d'abord,
 * détail ensuite, axe par axe, bloquants et critiques toujours en tête de
 * chaque section. Chaque constat porte quatre champs fixes (constat, impact,
 * remédiation, référentiel) : c'est la forme d'un avis RSSI, pas d'un
 * listing d'outil.
 */
import { AXES, SEVERITES, CONFIANCES, trierConstats } from '../moteur/modele.js';

const ICONES = { critique: '🔴', majeur: '🟠', mineur: '🟡', info: 'ℹ️' };

export function genererMarkdown({ ctx, notation, meta }) {
  const l = [];
  const nomDepot = meta.nomDepot;
  const date = new Date().toISOString().slice(0, 10);

  l.push(`# Audit de widget Grist — ${nomDepot}`);
  l.push('');
  l.push(`*Généré le ${date} par gwaudit v${meta.version}. Rapport à valeur de première analyse : il éclaire une revue humaine, il ne la remplace pas.*`);
  l.push('');
  l.push('## Verdict');
  l.push('');
  l.push(`**${notation.verdict}** — score global **${notation.global}/100**`);
  l.push('');
  l.push(notation.motif);
  l.push('');

  if (notation.bloquants.length) {
    l.push(`### Points bloquants (${notation.bloquants.length})`);
    l.push('');
    l.push("Un hébergement sur instance officielle (DINUM, ANCT) est exclu tant que ces points ne sont pas corrigés — ils ne se compensent par aucun score par ailleurs élevé, à l'image d'un avis RSSI.");
    l.push('');
    for (const c of trierConstats(notation.bloquants)) {
      const loc = c.fichier ? ` — \`${c.fichier}${c.ligne ? ':' + c.ligne : ''}\`` : '';
      l.push(`- ${ICONES[c.severite]} **[${c.regle}]** ${c.titre}${loc}`);
    }
    l.push('');
  }

  l.push('## Notation par axe');
  l.push('');
  l.push('| Axe | Score | Critique | Majeur | Mineur |');
  l.push('|---|---:|---:|---:|---:|');
  for (const a of Object.values(notation.parAxe)) {
    l.push(`| ${a.code} — ${a.titre} | ${a.nonExecute ? 'non exécuté' : a.score + '/100'} | ${a.repartition.critique} | ${a.repartition.majeur} | ${a.repartition.mineur} |`);
  }
  l.push('');
  if (notation.axesNonExecutes.length) {
    l.push(`> Axes non exécutés lors de cet audit : ${notation.axesNonExecutes.join(', ')}. Leur absence de score ne vaut pas conformité — voir la méthodologie.`);
    l.push('');
  }

  l.push('## Contexte de l\'audit');
  l.push('');
  l.push(`- Dépôt : \`${nomDepot}\`${meta.cible ? ` (\`${meta.cible}\`)` : ''}`);
  l.push(`- Commit audité : \`${meta.commit ?? 'non déterminable (pas un dépôt git, ou dépôt local sans commit)'}\``);
  l.push(`- ⚠️ Ce verdict ne vaut que pour ce commit précis : si le dépôt évolue par la suite, il ne le couvre plus.`);
  l.push(`- Fichiers inventoriés : ${ctx.fichiers.length}, dont ${ctx.surface.size} dans la surface réellement exécutée par le navigateur`);
  if (meta.tronque) {
    l.push(`- ⚠️ Inventaire tronqué : dépôt anormalement volumineux (${meta.tronque.fichiers ? `plus de ${meta.tronque.maxFichiers} fichiers` : ''}${meta.tronque.fichiers && meta.tronque.octets ? ', ' : ''}${meta.tronque.octets ? `plus de ${Math.round(meta.tronque.maxOctets / 1024 / 1024)} Mio de contenu lu` : ''}). Ce rapport ne couvre qu'une partie du dépôt.`);
  }
  l.push(`- Point(s) d'entrée détecté(s) : ${ctx.entrees.map((e) => `\`${e}\``).join(', ') || 'aucun'}`);
  if (ctx.usagesGrist?.acces?.length) {
    l.push(`- Niveau d'accès Grist demandé dans le code : \`${[...new Set(ctx.usagesGrist.acces.map((a) => a.niveau))].join(', ')}\``);
  }
  l.push('');

  for (const axe of Object.values(notation.parAxe)) {
    l.push(`## Axe ${axe.code} — ${axe.titre}`);
    l.push('');
    if (axe.nonExecute) {
      l.push('*Axe non exécuté lors de cet audit (voir méthodologie).*');
      l.push('');
      continue;
    }
    l.push(`Score : **${axe.score}/100** — ${axe.repartition.critique} critique(s), ${axe.repartition.majeur} majeur(s), ${axe.repartition.mineur} mineur(s), ${axe.repartition.info} information(s).`);
    l.push('');
    const constats = trierConstats(axe.constats);
    if (!constats.length) { l.push('_Aucun constat sur cet axe._'); l.push(''); continue; }

    for (const c of constats) {
      const loc = c.fichier ? ` — \`${c.fichier}${c.ligne ? ':' + c.ligne : ''}\`` : '';
      l.push(`### ${ICONES[c.severite]} [${c.regle}] ${c.titre}${c.bloquant ? ' — **BLOQUANT**' : ''}`);
      l.push('');
      l.push(`${loc ? loc.slice(3) + '\n\n' : ''}${c.constat}`);
      l.push('');
      if (c.extrait) { l.push('```'); l.push(c.extrait); l.push('```'); l.push(''); }
      if (c.impact) { l.push(`**Impact.** ${c.impact}`); l.push(''); }
      if (c.remediation) { l.push(`**Remédiation.** ${c.remediation}`); l.push(''); }
      const meta2 = [`Confiance : ${CONFIANCES[c.confiance]}`];
      if (c.referentiels?.length) meta2.push(`Référentiel(s) : ${c.referentiels.join(' ; ')}`);
      l.push(`<sub>${meta2.join(' · ')}</sub>`);
      l.push('');
    }
  }

  return l.join('\n');
}
