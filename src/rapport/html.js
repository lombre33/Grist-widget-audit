/**
 * Rendu du rapport d'audit en page HTML autonome — un seul fichier, sans
 * dépendance réseau (pas de police ni de script externe), ouvrable en
 * local par double-clic ou publié tel quel.
 *
 * Même contrat de données que markdown.js / json.js : { ctx, notation, meta }.
 * Les règles qui remontent une occurrence par site (A-FONC-*) peuvent produire
 * des dizaines de constats de même règle sur un gros widget : on les regroupe
 * ici sous une seule carte dépliable pour que la page reste lisible, sans
 * changer la notation elle-même (qui a besoin du décompte à plat).
 */
import { SEVERITES, CONFIANCES } from '../moteur/modele.js';

const SEUIL_GROUPE = 4;

const LIBELLES_SEVERITE = { critique: 'Critique', majeur: 'Majeur', mineur: 'Mineur', info: 'Info' };
const ORDRE_SEVERITE = ['critique', 'majeur', 'mineur', 'info'];

export function genererHtml({ ctx, notation, meta }) {
  const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const bandeVerdict = bandeDe(notation.global, notation.bloquants.length > 0);

  return `<title>Audit — ${echapper(meta.nomDepot)}</title>
<meta name="description" content="Rapport d'audit gwaudit pour ${echapper(meta.nomDepot)} : ${notation.verdict}, score global ${notation.global}/100.">
<style>
${css()}
</style>
<div class="page" data-verdict="${bandeVerdict}">

  <header class="entete">
    <div class="entete-fil">
      <p class="eyebrow">Rapport d'audit widget Grist · gwaudit v${echapper(meta.version)}</p>
      <h1>${echapper(meta.nomDepot)}</h1>
      <p class="entete-meta">Généré le ${date} · ${ctx.fichiers.length} fichiers inventoriés, ${ctx.surface.size} dans la surface exécutée</p>
      <p class="entete-meta">Commit audité : <code>${echapper(meta.commit ?? 'non déterminable')}</code>${meta.commit ? ' — ce verdict ne vaut que pour ce commit précis' : ''}</p>
    </div>
    <div class="verdict-carte" data-bande="${bandeVerdict}">
      <span class="verdict-libelle">${echapper(notation.verdict)}</span>
      <span class="verdict-score"><span class="chiffre">${notation.global}</span><span class="sur100">/100</span></span>
    </div>
  </header>

  <p class="avertissement">Rapport à valeur de première analyse : il éclaire une revue humaine, il ne la remplace pas. Méthodologie complète dans <code>docs/METHODOLOGIE.md</code>.</p>

  ${notation.bloquants.length ? blocBloquants(notation.bloquants) : ''}

  <section class="section-meteres" aria-labelledby="titre-axes">
    <h2 id="titre-axes">Notation par axe</h2>
    <div class="grille-meteres">
      ${Object.values(notation.parAxe).map(metre).join('\n')}
    </div>
    <ul class="legende-bandes" aria-label="Légende des couleurs de score">
      <li><span class="pastille" data-bande="bonne"></span>≥ 80 conforme</li>
      <li><span class="pastille" data-bande="attention"></span>60–79 sous réserve</li>
      <li><span class="pastille" data-bande="serieuse"></span>40–59 insuffisant</li>
      <li><span class="pastille" data-bande="critique"></span>&lt; 40 critique</li>
      <li><span class="pastille" data-bande="neutre"></span>non exécuté</li>
    </ul>
  </section>

  <nav class="filtres" aria-label="Filtrer les constats par sévérité">
    <span class="filtres-titre">Filtrer :</span>
    <input type="radio" name="filtre-sev" id="f-tous" checked>
    <label for="f-tous">Tous <span class="cnt">${somme(notation.repartition)}</span></label>
    ${ORDRE_SEVERITE.map((s) => `<input type="radio" name="filtre-sev" id="f-${s}">
    <label for="f-${s}" data-sev="${s}"><span class="puce" data-sev="${s}"></span>${LIBELLES_SEVERITE[s]} <span class="cnt">${notation.repartition[s]}</span></label>`).join('\n    ')}
  </nav>

  <main class="axes">
    ${Object.values(notation.parAxe).map((axe) => sectionAxe(axe)).join('\n')}
  </main>

  <footer class="pied">
    <p>gwaudit v${echapper(meta.version)} — audit automatisé de widgets Grist. Six axes : qualité, lisibilité, sécurité statique, sécurité en condition réelle, dépendances, conformité. Un score élevé n'emporte aucune certification ; un point bloquant l'exclut quel que soit le reste.</p>
  </footer>
</div>
`;
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

function blocBloquants(bloquants) {
  return `
  <section class="alerte-bloquants" aria-labelledby="titre-bloquants">
    <h2 id="titre-bloquants">⛔ ${bloquants.length} point${bloquants.length > 1 ? 's' : ''} bloquant${bloquants.length > 1 ? 's' : ''}</h2>
    <p>Un hébergement sur instance officielle (DINUM, ANCT) est exclu tant que ces points ne sont pas corrigés — ils ne se compensent par aucun score par ailleurs élevé, à l'image d'un avis RSSI.</p>
    <ul>
      ${bloquants.map((c) => `<li><a href="#${c.uid}"><code>${echapper(c.regle)}</code> ${echapper(c.titre)}</a></li>`).join('\n      ')}
    </ul>
  </section>`;
}

function metre(axe) {
  const bande = axe.nonExecute ? 'neutre' : bandeDe(axe.score, false);
  const largeur = axe.nonExecute ? 0 : Math.max(2, axe.score);
  return `
      <a class="metre" href="#axe-${axe.code}" data-bande="${bande}">
        <div class="metre-entete">
          <span class="metre-code">${axe.code}</span>
          <span class="metre-titre">${echapper(axe.titre)}</span>
        </div>
        <div class="metre-piste" role="img" aria-label="${echapper(axe.titre)} : ${axe.nonExecute ? 'non exécuté' : `${axe.score} sur 100`}">
          <div class="metre-remplissage" data-bande="${bande}" style="width:${largeur}%"></div>
        </div>
        <div class="metre-pied">
          <span class="metre-valeur">${axe.nonExecute ? 'non exécuté' : `${axe.score}/100`}</span>
          ${!axe.nonExecute ? `<span class="metre-chips">${chipsSeverite(axe.repartition)}</span>` : ''}
        </div>
      </a>`;
}

function chipsSeverite(rep) {
  return ORDRE_SEVERITE.filter((s) => rep[s] > 0)
    .map((s) => `<span class="chip" data-sev="${s}">${rep[s]}</span>`).join('');
}

function sectionAxe(axe) {
  const constats = trierPourAffichage(axe.constats);
  return `
    <section class="axe" id="axe-${axe.code}" aria-labelledby="titre-axe-${axe.code}">
      <div class="axe-entete">
        <h2 id="titre-axe-${axe.code}"><span class="axe-code">${axe.code}</span> ${echapper(axe.titre)}</h2>
        ${axe.nonExecute
          ? '<p class="axe-non-execute">Axe non exécuté lors de cet audit.</p>'
          : `<p class="axe-score">Score <strong>${axe.score}/100</strong> — ${chipsSeverite(axe.repartition)}</p>`}
      </div>
      ${axe.nonExecute ? '' : `<div class="liste-constats">${grouperEtRendre(constats)}</div>`}
    </section>`;
}

/** Regroupe les occurrences d'une même règle au-delà d'un seuil pour ne pas noyer la page. */
function grouperEtRendre(constats) {
  const parRegle = new Map();
  for (const c of constats) (parRegle.get(c.regle) ?? parRegle.set(c.regle, []).get(c.regle)).push(c);

  const sortie = [];
  const traites = new Set();
  for (const c of constats) {
    if (traites.has(c.uid)) continue;
    const groupe = parRegle.get(c.regle);
    if (groupe.length > SEUIL_GROUPE) {
      for (const g of groupe) traites.add(g.uid);
      sortie.push(carteGroupee(groupe));
    } else {
      traites.add(c.uid);
      sortie.push(carte(c));
    }
  }
  return sortie.join('\n');
}

function carte(c) {
  const loc = c.fichier ? `<code class="loc">${echapper(c.fichier)}${c.ligne ? ':' + c.ligne : ''}</code>` : '';
  return `
      <details class="constat" data-sev="${c.severite}" id="${c.uid}">
        <summary>
          <span class="rayure" data-sev="${c.severite}" aria-hidden="true"></span>
          <span class="puce" data-sev="${c.severite}" aria-hidden="true"></span>
          <span class="constat-corps">
            <span class="constat-ligne1">
              <code class="regle">${echapper(c.regle)}</code>
              ${c.bloquant ? '<span class="badge-bloquant">BLOQUANT</span>' : ''}
              <span class="constat-titre">${echapper(c.titre)}</span>
            </span>
            ${loc ? `<span class="constat-ligne2">${loc}</span>` : ''}
          </span>
          <span class="chevron" aria-hidden="true"></span>
        </summary>
        <div class="constat-detail">
          <p>${echapper(c.constat)}</p>
          ${c.extrait ? `<pre><code>${echapper(c.extrait)}</code></pre>` : ''}
          ${c.impact ? `<p><strong>Impact.</strong> ${echapper(c.impact)}</p>` : ''}
          ${c.remediation ? `<p><strong>Remédiation.</strong> ${echapper(c.remediation)}</p>` : ''}
          <p class="constat-meta">Confiance : ${echapper(CONFIANCES[c.confiance])}${c.referentiels?.length ? ` · Référentiel(s) : ${echapper(c.referentiels.join(' ; '))}` : ''}</p>
        </div>
      </details>`;
}

function carteGroupee(groupe) {
  const tete = groupe[0];
  const sev = groupe.reduce((pire, g) => (SEVERITES[g.severite].rang > SEVERITES[pire].rang ? g.severite : pire), tete.severite);
  return `
      <details class="constat constat-groupe" data-sev="${sev}">
        <summary>
          <span class="rayure" data-sev="${sev}" aria-hidden="true"></span>
          <span class="puce" data-sev="${sev}" aria-hidden="true"></span>
          <span class="constat-corps">
            <span class="constat-ligne1">
              <code class="regle">${echapper(tete.regle)}</code>
              <span class="constat-titre">${groupe.length} occurrences — ${echapper(titreGenerique(tete.titre))}</span>
            </span>
          </span>
          <span class="chevron" aria-hidden="true"></span>
        </summary>
        <div class="constat-detail">
          ${tete.impact ? `<p><strong>Impact.</strong> ${echapper(tete.impact)}</p>` : ''}
          ${tete.remediation ? `<p><strong>Remédiation.</strong> ${echapper(tete.remediation)}</p>` : ''}
          <p class="constat-meta">Confiance : ${echapper(CONFIANCES[tete.confiance])}${tete.referentiels?.length ? ` · Référentiel(s) : ${echapper(tete.referentiels.join(' ; '))}` : ''}</p>
          <p class="occurrences-titre">Chaque occurrence :</p>
          <ul class="occurrences">
            ${groupe.map((g) => `<li><code class="loc">${echapper(g.fichier ?? '')}${g.ligne ? ':' + g.ligne : ''}</code> — ${echapper(g.titre)}</li>`).join('\n            ')}
          </ul>
        </div>
      </details>`;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function trierPourAffichage(constats) {
  return [...constats].sort((x, y) =>
    Number(y.bloquant) - Number(x.bloquant) ||
    SEVERITES[y.severite].rang - SEVERITES[x.severite].rang ||
    x.regle.localeCompare(y.regle));
}

function bandeDe(score, aDesBloquants) {
  if (aDesBloquants) return 'critique';
  if (score >= 80) return 'bonne';
  if (score >= 60) return 'attention';
  if (score >= 40) return 'serieuse';
  return 'critique';
}

function somme(rep) { return Object.values(rep).reduce((a, b) => a + b, 0); }

/** Retire le préfixe chiffré d'un titre générique du type « 68 fonctions… » pour le regroupement. */
function titreGenerique(titre) {
  return titre.replace(/^\d+[^:]*:\s*/, '').replace(/\s*:\s*.+$/, (m) => (m.length < 40 ? '' : m));
}

function echapper(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function css() {
  return `
:root{
  --bg:#f6f7f9; --surface:#ffffff; --surface-2:#eef1f5; --border:#dde2ea;
  --text:#141922; --text-2:#565f70; --text-muted:#7c8496;
  --accent:#2a78d6; --accent-ink:#0d366b;
  --bonne:#0ca30c; --attention:#c98500; --serieuse:#ec835a; --critique:#d03b3b;
  --bonne-bg:#e6f6e6; --attention-bg:#fdf1da; --serieuse-bg:#fbe7de; --critique-bg:#fbe3e3;
  --neutre:#9aa3b5; --neutre-bg:#eceef2;
  --font-sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0f1319; --surface:#171c25; --surface-2:#1e2530; --border:#2b3342;
    --text:#eef1f6; --text-2:#aab3c5; --text-muted:#7f8aa0;
    --accent:#5c9ce8; --accent-ink:#cfe2fb;
    --bonne:#39c239; --attention:#e4a93a; --serieuse:#f2926c; --critique:#e66767;
    --bonne-bg:#132a15; --attention-bg:#2e2410; --serieuse-bg:#33201a; --critique-bg:#331919;
    --neutre:#5c6579; --neutre-bg:#1c212b;
  }
}
:root[data-theme="dark"]{
  --bg:#0f1319; --surface:#171c25; --surface-2:#1e2530; --border:#2b3342;
  --text:#eef1f6; --text-2:#aab3c5; --text-muted:#7f8aa0;
  --accent:#5c9ce8; --accent-ink:#cfe2fb;
  --bonne:#39c239; --attention:#e4a93a; --serieuse:#f2926c; --critique:#e66767;
  --bonne-bg:#132a15; --attention-bg:#2e2410; --serieuse-bg:#33201a; --critique-bg:#331919;
  --neutre:#5c6579; --neutre-bg:#1c212b;
}
*{box-sizing:border-box;}
body{background:var(--bg); color:var(--text); margin:0;}
.page{font-family:var(--font-sans); max-width:920px; margin:0 auto; padding-inline:20px; padding-block:32px 64px; color:var(--text);}
code, pre{font-family:var(--font-mono);}
h1,h2{text-wrap:balance; font-weight:700; letter-spacing:-0.01em;}
a{color:inherit;}
.alerte-bloquants a{text-decoration:none; border-bottom:1px solid color-mix(in srgb, var(--critique) 50%, transparent);}
.alerte-bloquants a:hover{border-bottom-color:var(--critique);}

.entete{display:flex; flex-wrap:wrap; gap:20px; align-items:flex-end; justify-content:space-between; border-bottom:1px solid var(--border); padding-bottom:24px;}
.eyebrow{font-size:12.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); margin:0 0 6px;}
.entete h1{font-size:clamp(24px,4vw,32px); margin:0; font-family:var(--font-mono); font-weight:600;}
.entete-meta{color:var(--text-2); font-size:14px; margin:8px 0 0;}
.verdict-carte{border-radius:14px; padding:14px 20px; display:flex; flex-direction:column; gap:2px; align-items:flex-end; background:var(--surface-2); border:1px solid var(--border);}
.verdict-carte[data-bande="bonne"]{background:var(--bonne-bg);}
.verdict-carte[data-bande="attention"]{background:var(--attention-bg);}
.verdict-carte[data-bande="serieuse"]{background:var(--serieuse-bg);}
.verdict-carte[data-bande="critique"]{background:var(--critique-bg);}
.verdict-libelle{font-size:12.5px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--text-2);}
.verdict-score{font-family:var(--font-mono); font-variant-numeric:tabular-nums;}
.verdict-score .chiffre{font-size:40px; font-weight:600; line-height:1;}
.verdict-score .sur100{font-size:16px; color:var(--text-muted);}

.avertissement{font-size:13.5px; color:var(--text-muted); margin:16px 0 28px; padding-left:12px; border-left:3px solid var(--border);}
.avertissement code{font-size:12.5px; background:var(--surface-2); padding:1px 5px; border-radius:4px;}

.alerte-bloquants{background:var(--critique-bg); border:1px solid var(--critique); border-radius:14px; padding:18px 22px; margin-bottom:28px;}
.alerte-bloquants h2{font-size:17px; margin:0 0 6px; color:var(--critique);}
.alerte-bloquants p{margin:0 0 10px; font-size:14px; color:var(--text-2);}
.alerte-bloquants ul{margin:0; padding-left:20px;}
.alerte-bloquants li{margin-bottom:4px; font-size:14px;}
.alerte-bloquants code{font-size:12.5px; background:var(--surface); padding:1px 5px; border-radius:4px;}

.section-meteres{margin-bottom:28px;}
.section-meteres h2{font-size:15px; margin:0 0 14px; color:var(--text-2); text-transform:uppercase; letter-spacing:.04em; font-weight:600;}
.grille-meteres{display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px;}
.metre{display:block; text-decoration:none; color:inherit; background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:14px 16px; transition:border-color .15s;}
.metre:hover{border-color:var(--accent);}
.metre-entete{display:flex; align-items:baseline; gap:8px; margin-bottom:10px;}
.metre-code{font-family:var(--font-mono); font-weight:700; font-size:13px; color:var(--text-muted); border:1px solid var(--border); border-radius:5px; padding:0 5px;}
.metre-titre{font-size:13.5px; font-weight:600;}
.metre-piste{height:10px; border-radius:6px; background:var(--surface-2); overflow:hidden;}
.metre-remplissage{height:100%; border-radius:6px 4px 4px 6px;}
.metre-remplissage[data-bande="bonne"]{background:var(--bonne);}
.metre-remplissage[data-bande="attention"]{background:var(--attention);}
.metre-remplissage[data-bande="serieuse"]{background:var(--serieuse);}
.metre-remplissage[data-bande="critique"]{background:var(--critique);}
.metre-remplissage[data-bande="neutre"]{background:var(--neutre);}
.metre-pied{display:flex; justify-content:space-between; align-items:center; margin-top:8px;}
.metre-valeur{font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:13px; font-weight:600; color:var(--text-2);}
.metre-chips{display:flex; gap:4px;}

.legende-bandes{list-style:none; display:flex; flex-wrap:wrap; gap:14px; margin:14px 0 0; padding:0; font-size:12.5px; color:var(--text-muted);}
.legende-bandes li{display:flex; align-items:center; gap:6px;}
.pastille{width:9px; height:9px; border-radius:50%; display:inline-block;}
.pastille[data-bande="bonne"]{background:var(--bonne);}
.pastille[data-bande="attention"]{background:var(--attention);}
.pastille[data-bande="serieuse"]{background:var(--serieuse);}
.pastille[data-bande="critique"]{background:var(--critique);}
.pastille[data-bande="neutre"]{background:var(--neutre);}

.filtres{position:sticky; top:0; z-index:5; display:flex; flex-wrap:wrap; gap:8px; align-items:center; background:color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter:blur(6px); padding:10px 0; margin-bottom:8px; border-bottom:1px solid var(--border);}
.filtres-titre{font-size:12.5px; color:var(--text-muted); margin-right:2px;}
.filtres input{position:absolute; opacity:0; width:1px; height:1px;}
.filtres label{cursor:pointer; font-size:13px; padding:5px 11px; border-radius:999px; border:1px solid var(--border); background:var(--surface); display:inline-flex; align-items:center; gap:6px; color:var(--text-2);}
.filtres input:checked + label{background:var(--accent); border-color:var(--accent); color:#fff;}
.filtres input:focus-visible + label{outline:2px solid var(--accent); outline-offset:2px;}
.filtres .cnt{font-family:var(--font-mono); font-variant-numeric:tabular-nums; opacity:.75; font-size:11.5px;}
.puce{width:8px; height:8px; border-radius:50%; display:inline-block;}
.puce[data-sev="critique"]{background:var(--critique);}
.puce[data-sev="majeur"]{background:var(--serieuse);}
.puce[data-sev="mineur"]{background:var(--attention);}
.puce[data-sev="info"]{background:var(--neutre);}

.axe{margin:36px 0; scroll-margin-top:60px;}
.axe-entete{display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:8px; border-bottom:2px solid var(--border); padding-bottom:10px; margin-bottom:14px;}
.axe-entete h2{font-size:19px; margin:0; display:flex; align-items:center; gap:8px;}
.axe-code{font-family:var(--font-mono); font-size:13px; background:var(--surface-2); border:1px solid var(--border); border-radius:6px; padding:1px 7px;}
.axe-score{margin:0; font-size:13.5px; color:var(--text-2); display:flex; gap:8px; align-items:center;}
.axe-non-execute{margin:0; font-size:13.5px; color:var(--text-muted); font-style:italic;}
.chip{font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:11px; font-weight:600; border-radius:999px; padding:1px 7px; margin-left:3px;}
.chip[data-sev="critique"]{background:var(--critique-bg); color:var(--critique);}
.chip[data-sev="majeur"]{background:var(--serieuse-bg); color:var(--serieuse);}
.chip[data-sev="mineur"]{background:var(--attention-bg); color:var(--attention);}
.chip[data-sev="info"]{background:var(--neutre-bg); color:var(--text-muted);}

.liste-constats{display:flex; flex-direction:column; gap:8px;}
.constat{background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden;}
.constat summary{list-style:none; display:flex; align-items:center; gap:10px; padding:11px 14px; cursor:pointer;}
.constat summary::-webkit-details-marker{display:none;}
.constat summary:focus-visible{outline:2px solid var(--accent); outline-offset:-2px;}
.rayure{width:4px; align-self:stretch; border-radius:3px; flex:none;}
.rayure[data-sev="critique"]{background:var(--critique);}
.rayure[data-sev="majeur"]{background:var(--serieuse);}
.rayure[data-sev="mineur"]{background:var(--attention);}
.rayure[data-sev="info"]{background:var(--neutre);}
.constat-corps{flex:1; min-width:0; display:flex; flex-direction:column; gap:3px;}
.constat-ligne1{display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:14px;}
.regle{font-size:11.5px; color:var(--text-muted); background:var(--surface-2); border-radius:5px; padding:1px 6px; flex:none;}
.constat-titre{font-weight:500;}
.badge-bloquant{font-size:10px; font-weight:700; letter-spacing:.03em; color:#fff; background:var(--critique); border-radius:5px; padding:1px 6px; flex:none;}
.constat-ligne2 .loc{font-size:12px; color:var(--text-muted); background:none; padding:0;}
.chevron{flex:none; width:9px; height:9px; border-right:2px solid var(--text-muted); border-bottom:2px solid var(--text-muted); transform:rotate(-45deg); transition:transform .15s; margin-right:2px;}
.constat[open] .chevron{transform:rotate(45deg);}
.constat-detail{padding:0 14px 16px 28px; font-size:13.5px; color:var(--text-2); line-height:1.55;}
.constat-detail p{margin:8px 0;}
.constat-detail pre{background:var(--surface-2); border-radius:8px; padding:10px 12px; overflow-x:auto; font-size:12.5px; margin:8px 0;}
.constat-meta{font-size:12px; color:var(--text-muted); border-top:1px solid var(--border); padding-top:8px; margin-top:10px !important;}
.loc{background:var(--surface-2); padding:1px 5px; border-radius:4px; font-size:12.5px;}
.occurrences-titre{font-weight:600; font-size:12.5px; margin-top:12px !important;}
.occurrences{margin:6px 0 0; padding-left:18px; max-height:260px; overflow-y:auto;}
.occurrences li{margin-bottom:4px; font-size:12.5px;}

.pied{margin-top:56px; padding-top:18px; border-top:1px solid var(--border); font-size:12.5px; color:var(--text-muted); line-height:1.6;}

body:has(#f-critique:checked) .constat:not([data-sev="critique"]){display:none;}
body:has(#f-majeur:checked) .constat:not([data-sev="majeur"]){display:none;}
body:has(#f-mineur:checked) .constat:not([data-sev="mineur"]){display:none;}
body:has(#f-info:checked) .constat:not([data-sev="info"]){display:none;}

@media (max-width:520px){
  .entete{flex-direction:column; align-items:stretch;}
  .verdict-carte{align-items:flex-start;}
}
@media (prefers-reduced-motion:reduce){
  .metre, .chevron{transition:none;}
}
`;
}
