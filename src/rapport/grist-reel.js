/**
 * Rendu de la sous-section « Essais contre un Grist réel » (mode --grist-reel), en HTML et en Markdown.
 * Les constats eux-mêmes (D-REEL-NN) sont des constats ordinaires, notés et exportés comme les autres ;
 * cette section remet ensemble ce que chaque essai a donné, y compris ce qui n'a PAS donné de constat
 * (essai bloqué par Grist ou par le navigateur, rien observé, non testé), pour que « rien trouvé » ne se lise
 * jamais à la place de « pas testé ».
 */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const LIBELLE = { reussi: 'Effet observé (constat)', bloque: 'Bloqué', rien_observe: 'Rien observé', non_teste: 'Non testé' };

function lireDate(iso) {
  try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }); } catch { return String(iso ?? ''); }
}

function bandeau(r) {
  const niveaux = r.phases?.map((p) => `« ${p.niveau} »`).join(' puis ') ?? '';
  return `${r.produit} ${r.version} (${r.plateforme}), instance jetable lancée pour cet audit, le ${lireDate(r.date)}. Phases jouées : ${niveaux || 'aucune'}${r.niveauParDefaut ? " (le widget ne déclare aucun niveau : niveau usuel « read table » supposé)" : ''}. Ce résultat vaut pour cette version de Grist et cette configuration, pas pour l'instance où le widget sera installé (Grist.Gouv, par exemple) si elle diffère.${r.sansBacASable ? " Chromium a tourné sans son bac à sable (dérogation explicite, voir D-INDISPONIBLE-BAC-A-SABLE)." : ''}`;
}

const nonJoues = (r) => `Essais du catalogue pas encore joués : ${r.essaisPasEncore}.`;

export function htmlGristReel(r) {
  if (!r) return '';
  if (!r.execute) {
    return `
  <section class="synthese-externe" aria-labelledby="titre-reel">
    <h2 id="titre-reel">Essais contre un Grist réel</h2>
    <p><strong>Non exécutés.</strong> ${esc(r.cause ?? 'cause inconnue')} Ce n'est pas une absence de risque : c'est une absence de mesure.</p>
  </section>`;
  }
  const lignes = r.essais.map((e) => {
    const etapes = e.etapes?.length ? `<details><summary>Étapes</summary><ol>${e.etapes.map((s) => `<li>${s.ok ? 'Franchie' : 'Arrêtée'} : ${esc(s.etape)}${s.barriere ? ` — ${esc(s.barriere)}` : ''}</li>`).join('')}</ol></details>` : '';
    return `<tr><td>${e.id}</td><td>${esc(e.titre)}</td><td>${esc(e.niveau ?? 'tous')}</td><td>${LIBELLE[e.resultat]}</td><td>${esc(e.detail)}${e.barriere ? ` <em>(barrière : ${esc(e.barriere)})</em>` : ''}${e.regle ? ` <code>${esc(e.regle)}</code>` : ''}${etapes}</td></tr>`;
  });
  return `
  <section class="synthese-externe" aria-labelledby="titre-reel">
    <h2 id="titre-reel">Essais contre un Grist réel</h2>
    <p>${esc(bandeau(r))}</p>
    <div class="tableau-defilant"><table><thead><tr><th>N°</th><th>Essai</th><th>Niveau</th><th>Résultat</th><th>Ce qui a été observé</th></tr></thead><tbody>
      ${lignes.join('\n      ')}
    </tbody></table></div>
    <p>Un effet observé devient un constat noté (règle D-REEL-NN). « Bloqué » nomme la barrière qui a arrêté l'essai : c'est un bon signe, sans pénalité. « Rien observé » veut dire que l'essai s'est joué sans effet visible, pas qu'aucune tentative n'a eu lieu. « Non testé » dit pourquoi. ${esc(nonJoues(r))}</p>
  </section>`;
}

export function markdownGristReel(r) {
  if (!r) return [];
  const l = ['## Essais contre un Grist réel', ''];
  if (!r.execute) {
    l.push(`**Non exécutés.** ${r.cause ?? 'cause inconnue'} Ce n'est pas une absence de risque : c'est une absence de mesure.`, '');
    return l;
  }
  l.push(bandeau(r), '');
  l.push('| N° | Essai | Niveau | Résultat | Ce qui a été observé |', '|---|---|---|---|---|');
  for (const e of r.essais) {
    const suite = e.etapes?.length ? ` Étapes : ${e.etapes.map((s) => `${s.ok ? 'franchie' : 'arrêtée'} (${s.etape}${s.barriere ? ` — ${s.barriere}` : ''})`).join(' ; ')}.` : '';
    l.push(`| ${e.id} | ${md(e.titre)} | ${md(e.niveau ?? 'tous')} | ${LIBELLE[e.resultat]} | ${md(e.detail + (e.barriere ? ` (barrière : ${e.barriere})` : '') + (e.regle ? ` [${e.regle}]` : '') + suite)} |`);
  }
  l.push('', `Un effet observé devient un constat noté (règle D-REEL-NN). « Bloqué » nomme la barrière qui a arrêté l'essai (bon signe, sans pénalité). « Rien observé » : l'essai s'est joué sans effet visible, pas « aucune tentative ». « Non testé » dit pourquoi. ${nonJoues(r)}`, '');
  return l;
}
