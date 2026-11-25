/**
 * Rendu de la sous-section « Essais contre un Grist réel » (mode --grist-reel), en HTML et en Markdown.
 * Les constats eux-mêmes (D-REEL-NN) sont des constats ordinaires, notés et exportés comme les autres ;
 * cette section remet ensemble ce que chaque essai a donné, y compris ce qui n'a PAS donné de constat
 * (essai bloqué par Grist ou par le navigateur, rien observé, non testé), pour que « rien trouvé » ne se lise
 * jamais à la place de « pas testé ».
 *
 * Chaque essai porte un verdict lisible d'un coup d'œil (Bien / Pas bien / À savoir / Pas testé : une couleur ET un mot)
 * et une phrase « En clair » ; le détail concret (ce qui a été observé, la barrière, les étapes, la règle) reste dessous, tel quel.
 */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

const LIBELLE = { reussi: 'Effet observé (constat)', bloque: 'Bloqué', rien_observe: 'Rien observé', non_teste: 'Non testé' };

/** Nombre d'essais du catalogue de l'étude (joués ou non). */
const ESSAIS_DU_CATALOGUE = 20;

/** Ce que chaque essai tente, en une phrase. */
const QUOI = {
  1: "On place dans une cellule du document un texte piégé (du code déguisé en donnée), puis on regarde si le widget l'exécute.",
  7: "On limite le widget au niveau d'accès « none » (aucune donnée) et on vérifie que Grist ne lui transmet rien.",
  13: "On remplit le document de valeurs repérables (des « canaris ») et on regarde si l'une d'elles sort du widget vers un site extérieur.",
  15: "On regarde si le widget peut rediriger la page Grist qui l'héberge (de quoi afficher une fausse page de connexion).",
  16: "On regarde si le widget ouvre des fenêtres, des boîtes de dialogue ou des téléchargements sans qu'on le lui demande.",
};

const NON_CONCLUANT = "Impossible de conclure : l'essai n'a pas pu être joué (raison dans le détail). Ce n'est pas la même chose que « tout va bien ».";

/** Ce que le résultat veut dire, sans jargon. */
function enClair(e) {
  const t = e.resultat;
  if (t === 'non_teste') {
    if (e.bibliothequesManquantes) return "Impossible de conclure : des bibliothèques du widget n'ont pas pu être chargées, son code n'a pas été joué en entier (raison dans le détail). Ce n'est pas la même chose que « tout va bien ».";
    if (e.id === 1) return "Impossible de conclure : le piège n'a pas pu être présenté au widget (raison dans le détail). Ce n'est pas la même chose que « tout va bien ».";
    if (e.id === 7) return "Impossible de conclure : le widget n'a rien échangé avec Grist pendant l'essai (raison dans le détail).";
    if (e.id === 13) return "Impossible de conclure : aucune donnée du document n'est arrivée au widget, une fuite ne pouvait donc ni se produire ni être mesurée. Ce n'est pas la même chose que « aucune fuite ».";
    return NON_CONCLUANT;
  }
  switch (e.id) {
    case 1:
      if (t === 'rien_observe') return "Le texte piégé ne s'est pas exécuté : le widget l'affiche comme du simple texte. C'est ce qu'on attend.";
      return e.severite === 'critique'
        ? "Le texte piégé s'est exécuté dans le widget et a pu lire une autre table du document. Quiconque peut écrire dans le document peut donc faire agir du code avec les droits du widget."
        : "Le texte piégé s'est exécuté dans le widget, mais Grist a refusé qu'il lise une autre table. Le défaut est réel ; il deviendrait plus grave si l'accès accordé au widget était élargi.";
    case 7:
      return t === 'bloque'
        ? "Grist a bien refusé de transmettre les données au niveau « none ». C'est le garde-fou de Grist qui est vérifié ici, pas le widget."
        : "Grist a transmis des données alors que le niveau était « none » : défaut de Grist, pas du widget. Sans effet sur la note ; à signaler à l'éditeur de Grist.";
    case 13:
      if (t === 'reussi') return "Des données du document sortent du widget vers un site extérieur : c'est une fuite.";
      return e.sorties > 0
        ? `Le widget a tenté ${e.sorties} appel(s) vers l'extérieur (bloqués par l'audit), mais aucune valeur du document n'y figurait en clair. Ces appels restent à examiner comme dépendances (voir la synthèse en bas de rapport).`
        : "Le widget n'a contacté aucun site extérieur pendant l'essai.";
    case 15:
      if (t === 'bloque') return "Le navigateur a refusé que le widget redirige la page Grist : le garde-fou a fonctionné.";
      if (t === 'reussi') return "Le widget a redirigé la page Grist : il pourrait la remplacer par une fausse page de connexion.";
      return "La page Grist n'a pas bougé. (Une redirection qui exige un clic de l'utilisateur n'est pas jouée.)";
    case 16:
      return t === 'reussi'
        ? "Le widget a ouvert des fenêtres, des boîtes de dialogue ou des téléchargements sans qu'on le lui demande : de quoi bloquer Grist ou piéger l'utilisateur."
        : "Aucune fenêtre, boîte de dialogue ni téléchargement n'est apparu pendant le chargement.";
    default:
      return '';
  }
}

/** Le verdict d'un essai : une couleur de la palette du rapport (bande), un symbole et un mot. */
export function verdictEssai(e) {
  if (e.resultat === 'non_teste') return { cle: 'non_teste', bande: 'neutre', symbole: '?', mot: 'Pas testé', precision: 'aucune conclusion' };
  if (e.resultat === 'reussi') {
    if (e.severite === 'info') return { cle: 'a_savoir', bande: 'neutre', symbole: 'i', mot: 'À savoir', precision: "défaut de Grist, pas du widget" };
    if (e.severite === 'critique') return { cle: 'pas_bien', bande: 'critique', symbole: '✘', mot: 'Pas bien', precision: 'critique' };
    return { cle: 'pas_bien', bande: 'serieuse', symbole: '✘', mot: 'Pas bien', precision: e.severite ?? 'majeur' };
  }
  return { cle: 'bien', bande: 'bonne', symbole: '✔', mot: 'Bien', precision: e.resultat === 'bloque' ? `arrêté par ${e.barriere ?? 'une barrière'}` : "rien d'anormal observé" };
}

/** La synthèse en une phrase : combien d'essais sont bien, pas bien, pas testés. */
export function syntheseEssais(essais) {
  const n = { bien: 0, pas_bien: 0, a_savoir: 0, non_teste: 0 };
  for (const e of essais) n[verdictEssai(e).cle] += 1;
  const morceaux = [];
  if (n.pas_bien) morceaux.push(`${n.pas_bien} pas bien`);
  if (n.bien) morceaux.push(`${n.bien} bien (rien d'anormal, ou arrêté par une barrière)`);
  if (n.a_savoir) morceaux.push(`${n.a_savoir} à savoir (défaut de Grist, pas du widget)`);
  if (n.non_teste) morceaux.push(`${n.non_teste} pas testé${n.non_teste > 1 ? 's' : ''} (aucune conclusion possible sur ces points)`);
  const bande = n.pas_bien ? 'critique' : (n.non_teste ? 'attention' : 'bonne');
  const titre = n.pas_bien ? `${n.pas_bien} problème${n.pas_bien > 1 ? 's' : ''} trouvé${n.pas_bien > 1 ? 's' : ''}`
    : (n.non_teste && !n.bien ? 'Rien n\'a pu être testé' : (n.non_teste ? 'Aucun problème trouvé, mais des essais n\'ont pas pu être joués' : 'Aucun problème trouvé'));
  return { bande, titre, detail: `Sur ${essais.length} essai${essais.length > 1 ? 's' : ''} joué${essais.length > 1 ? 's' : ''} : ${morceaux.join(' ; ')}.` };
}

function lireDate(iso) {
  try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }); } catch { return String(iso ?? ''); }
}

function bandeau(r) {
  const niveaux = r.phases?.map((p) => `« ${p.niveau} »`).join(' puis ') ?? '';
  return `${r.produit} ${r.version} (${r.plateforme}), instance jetable lancée pour cet audit, le ${lireDate(r.date)}. Phases jouées : ${niveaux || 'aucune'}${r.niveauParDefaut ? " (le widget ne déclare aucun niveau : niveau usuel « read table » supposé)" : ''}. Ce résultat vaut pour cette version de Grist et cette configuration, pas pour l'instance où le widget sera installé (Grist.Gouv, par exemple) si elle diffère.${r.sansBacASable ? " Chromium a tourné sans son bac à sable (dérogation explicite, voir D-INDISPONIBLE-BAC-A-SABLE)." : ''}`;
}

const nonJoues = (r) => `Ce rapport ne couvre pas tout : ${ESSAIS_DU_CATALOGUE - r.essais.length} essais du catalogue restent à développer (n° ${r.essaisPasEncore}).`;

const COMMENT_LIRE = "Comment lire : « Bien » veut dire que l'essai n'a rien révélé d'anormal, ou que Grist ou le navigateur l'a arrêté (aucune pénalité). « Pas bien » veut dire qu'un effet a été observé : il devient un constat noté (règle D-REEL-NN). « Pas testé » veut dire que l'essai n'a pas pu être joué : aucune conclusion, ni dans un sens ni dans l'autre. Un « Bien » ne prouve pas que le widget est sûr : il dit seulement que cet essai-là n'a rien trouvé.";

const BIBLIOTHEQUES_AFFICHEES = 40;
const INTRO_BIBLIOTHEQUES = "L'audit a téléchargé lui-même ces fichiers (le navigateur reste coupé d'Internet) et les a servis au widget pour qu'il s'affiche pour de vrai. L'empreinte SHA-256 permet de vérifier plus tard que c'est le même code.";
const kilo = (octets) => `${Math.max(1, Math.round(octets / 1024))} Ko`;

function htmlBibliotheques(b) {
  if (!b || (!b.chargees?.length && !b.refusees?.length)) return '';
  const lignes = [
    ...b.chargees.slice(0, BIBLIOTHEQUES_AFFICHEES).map((f) => `<li><code>${esc(f.url)}</code> — ${kilo(f.taille)}, SHA-256 <code title="${esc(f.sha256)}">${esc(f.sha256.slice(0, 16))}…</code></li>`),
    ...(b.chargees.length > BIBLIOTHEQUES_AFFICHEES ? [`<li>… et ${b.chargees.length - BIBLIOTHEQUES_AFFICHEES} autre(s) fichier(s)</li>`] : []),
    ...b.refusees.slice(0, 20).map((f) => `<li><code>${esc(f.url)}</code> — non téléchargé : ${esc(f.raison)}</li>`),
  ];
  return `<details class="reel-bibliotheques"><summary>Bibliothèques du widget jouées : ${b.chargees.length} fichier(s)${b.refusees.length ? `, ${b.refusees.length} non téléchargé(s)` : ''}</summary><p class="reel-contexte">${esc(INTRO_BIBLIOTHEQUES)}</p><ul>${lignes.join('')}</ul></details>`;
}

function markdownBibliotheques(b) {
  if (!b || (!b.chargees?.length && !b.refusees?.length)) return [];
  return [
    `**Bibliothèques du widget jouées : ${b.chargees.length} fichier(s)${b.refusees.length ? `, ${b.refusees.length} non téléchargé(s)` : ''}.** ${INTRO_BIBLIOTHEQUES}`, '',
    ...b.chargees.slice(0, BIBLIOTHEQUES_AFFICHEES).map((f) => `- \`${f.url}\` — ${kilo(f.taille)}, SHA-256 \`${f.sha256}\``),
    ...(b.chargees.length > BIBLIOTHEQUES_AFFICHEES ? [`- … et ${b.chargees.length - BIBLIOTHEQUES_AFFICHEES} autre(s) fichier(s)`] : []),
    ...b.refusees.slice(0, 20).map((f) => `- \`${f.url}\` — non téléchargé : ${f.raison}`), '',
  ];
}

export function htmlGristReel(r) {
  if (!r) return '';
  if (!r.execute) {
    return `
  <section class="synthese-externe reel" aria-labelledby="titre-reel">
    <h2 id="titre-reel">Essais contre un Grist réel</h2>
    <p><strong>Non exécutés.</strong> ${esc(r.cause ?? 'cause inconnue')} Ce n'est pas une absence de risque : c'est une absence de mesure.</p>
  </section>`;
  }
  const synthese = syntheseEssais(r.essais);
  const cartes = r.essais.map((e) => {
    const v = verdictEssai(e);
    const etapes = e.etapes?.length ? `<details><summary>Étapes</summary><ol>${e.etapes.map((s) => `<li>${s.ok ? 'Franchie' : 'Arrêtée'} : ${esc(s.etape)}${s.barriere ? ` — ${esc(s.barriere)}` : ''}</li>`).join('')}</ol></details>` : '';
    return `<li class="reel-essai" data-bande="${v.bande}">
        <div class="reel-entete"><span class="reel-verdict" data-bande="${v.bande}"><span aria-hidden="true">${v.symbole}</span> ${esc(v.mot)}</span><span class="reel-precision">${esc(v.precision)}</span><span class="reel-num">Essai ${e.id} · niveau ${esc(e.niveau ?? 'tous')}</span></div>
        <p class="reel-titre">${esc(e.titre)}</p>
        <p class="reel-quoi">${esc(QUOI[e.id] ?? '')}</p>
        <p class="reel-clair"><strong>En clair.</strong> ${esc(enClair(e))}</p>
        <p class="reel-detail"><strong>Observé.</strong> ${esc(e.detail)}${e.barriere ? ` <em>(barrière : ${esc(e.barriere)})</em>` : ''} <span class="reel-brut">· Résultat : ${esc(LIBELLE[e.resultat])}</span>${e.regle ? ` <code>${esc(e.regle)}</code>` : ''}</p>
        ${etapes}
      </li>`;
  });
  return `
  <section class="synthese-externe reel" aria-labelledby="titre-reel">
    <h2 id="titre-reel">Essais contre un Grist réel</h2>
    <p class="reel-resume" data-bande="${synthese.bande}"><strong>${esc(synthese.titre)}.</strong> ${esc(synthese.detail)}</p>
    <ul class="reel-liste">
      ${cartes.join('\n      ')}
    </ul>
    ${htmlBibliotheques(r.bibliotheques)}
    <p class="reel-contexte">${esc(bandeau(r))}</p>
    <p class="reel-contexte">${esc(COMMENT_LIRE)} ${esc(nonJoues(r))}</p>
  </section>`;
}

/** Style de la section, ajouté à la feuille du rapport HTML (mêmes variables de couleur que le reste, thèmes clair et sombre compris). */
export const cssGristReel = `
.reel-resume{margin:12px 0; padding:10px 14px; border-radius:10px; border:1px solid var(--border); border-left-width:5px; font-size:14px; background:var(--surface-2);}
.reel-resume[data-bande="bonne"]{background:var(--bonne-bg); border-left-color:var(--bonne);}
.reel-resume[data-bande="attention"]{background:var(--attention-bg); border-left-color:var(--attention);}
.reel-resume[data-bande="critique"]{background:var(--critique-bg); border-left-color:var(--critique);}
.reel-liste{list-style:none; padding:0; margin:12px 0; display:grid; gap:10px;}
.reel-essai{background:var(--surface); border:1px solid var(--border); border-left-width:5px; border-radius:10px; padding:10px 14px; font-size:13.5px; line-height:1.5;}
.reel-essai[data-bande="bonne"]{border-left-color:var(--bonne);}
.reel-essai[data-bande="serieuse"]{border-left-color:var(--serieuse);}
.reel-essai[data-bande="critique"]{border-left-color:var(--critique);}
.reel-essai[data-bande="neutre"]{border-left-color:var(--neutre);}
.reel-essai p{margin:6px 0;}
.reel-entete{display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px;}
.reel-verdict{font-weight:700; font-size:13px; padding:2px 10px; border-radius:999px; color:var(--text); background:var(--neutre-bg);}
.reel-verdict[data-bande="bonne"]{background:var(--bonne-bg);}
.reel-verdict[data-bande="serieuse"]{background:var(--serieuse-bg);}
.reel-verdict[data-bande="critique"]{background:var(--critique-bg);}
.reel-precision{color:var(--text-2); font-size:12.5px;}
.reel-num{margin-left:auto; color:var(--text-muted); font-size:12px;}
.reel-titre{font-weight:600;}
.reel-quoi{color:var(--text-2);}
.reel-detail{color:var(--text-2); font-size:12.5px;}
.reel-brut{color:var(--text-muted);}
.reel-contexte{color:var(--text-2); font-size:12.5px;}
.reel-bibliotheques{margin:10px 0; font-size:12.5px; color:var(--text-2);}
.reel-bibliotheques ul{margin:6px 0; padding-left:20px; word-break:break-all;}
`;

export function markdownGristReel(r) {
  if (!r) return [];
  const l = ['## Essais contre un Grist réel', ''];
  if (!r.execute) {
    l.push(`**Non exécutés.** ${r.cause ?? 'cause inconnue'} Ce n'est pas une absence de risque : c'est une absence de mesure.`, '');
    return l;
  }
  const synthese = syntheseEssais(r.essais);
  l.push(`**${synthese.titre}.** ${synthese.detail}`, '');
  l.push('| Verdict | Essai | En clair | Observé (détail concret) |', '|---|---|---|---|');
  for (const e of r.essais) {
    const v = verdictEssai(e);
    const suite = e.etapes?.length ? ` Étapes : ${e.etapes.map((s) => `${s.ok ? 'franchie' : 'arrêtée'} (${s.etape}${s.barriere ? ` — ${s.barriere}` : ''})`).join(' ; ')}.` : '';
    l.push(`| ${v.symbole} **${v.mot}** — ${md(v.precision)} | ${e.id}. ${md(e.titre)} — niveau ${md(e.niveau ?? 'tous')} | ${md(enClair(e))} | ${md(e.detail + (e.barriere ? ` (barrière : ${e.barriere})` : '') + (e.regle ? ` [${e.regle}]` : '') + suite)} (résultat : ${LIBELLE[e.resultat]}) |`);
  }
  l.push('', ...markdownBibliotheques(r.bibliotheques), bandeau(r), '', `${COMMENT_LIRE} ${nonJoues(r)}`, '');
  return l;
}
