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

/** Nombre d'essais du catalogue de l'étude (joués ou non), plus les essais 21 (altération d'une bibliothèque) 22 (voies de sortie), 23 (stockage dans le navigateur) et 24 (écritures spontanées), ajoutés ensuite. */
const ESSAIS_DU_CATALOGUE = 24;

/** Ce que chaque essai tente, en une phrase. */
const QUOI = {
  1: "On place dans une cellule du document un texte piégé (du code déguisé en donnée), puis on regarde si le widget l'exécute.",
  3: "On ajoute au document des lignes dont le texte est piégé (JSON avec __proto__ ou constructor.prototype, chemin __proto__.clé) et on regarde si le widget, en les lisant, modifie les objets de base de JavaScript (pollution de prototype).",
  4: "Un cadre voisin sans aucun droit (comme un autre widget de la même page) envoie au widget des messages forgés ; on regarde si le widget les prend pour des ordres : exécution de code, appel d'une adresse donnée par le message.",
  5: "On appelle le widget avec une adresse qui affirme « access=full&readonly=false » alors que Grist lui accorde moins, et on compare ses appels à Grist (accès demandé, écritures tentées) avec ceux de l'adresse normale.",
  7: "On limite le widget au niveau d'accès « none » (aucune donnée) et on vérifie que Grist ne lui transmet rien.",
  8: "On joue, depuis l'intérieur du widget, ce que ferait du code étranger (une bibliothèque piégée) : lire la liste des tables, une table sans rapport avec le widget, les tables système.",
  9: "On joue ce que ferait ce code étranger pour obtenir un jeton d'accès, appeler directement l'API du document avec ce jeton, et l'essayer sur un autre document.",
  10: "On joue ce que ferait ce code étranger pour modifier le document : ajouter des lignes, renommer ou supprimer une colonne, supprimer une table, créer une règle d'accès. L'audit relit ensuite le document pour voir ce qui a vraiment changé (sur des tables créées pour l'essai).",
  12: "On joue ce que ferait ce code étranger pour créer un webhook, une sortie permanente de données qui survivrait au retrait du widget.",
  17: "Après un clic réel dans le widget, on joue ce que ferait du code étranger pour remplacer le contenu du presse-papier, et on relit le presse-papier depuis la page Grist.",
  18: "On lit, dans le cadre du widget, la politique d'autorisations que le navigateur lui applique : caméra, micro, position, partage d'écran, USB, paiement, lecture du presse-papier… lesquels Grist lui délègue-t-il ?",
  23: "Une fois le widget chargé avec ses données, on regarde ce qu'il a gardé dans le navigateur (localStorage, sessionStorage, IndexedDB, cookies) et si des valeurs du document s'y trouvent : elles y survivraient à la fermeture du document.",
  24: "On charge le widget et on lit le journal de ses appels à Grist, sans cliquer ni saisir : écrit-il dans le document de lui-même ?",
  19: "On lit les en-têtes de sécurité de la page Grist qui héberge le widget, tels que le navigateur les reçoit : politique de sécurité (CSP), protection contre l'inclusion en cadre, Referrer-Policy, nosniff.",
  20: "Depuis le cadre du widget, on appelle l'API de l'instance Grist avec la session de la personne et on regarde si le document se lit, quel que soit le niveau d'accès accordé au widget (un appel témoin est fait depuis la page Grist).",
  21: "On sert à la même adresse chacune des bibliothèques du widget avec une ligne de plus, qui ne fait rien d'autre que se signaler, et on regarde si le navigateur l'exécute ou la refuse.",
  22: "On joue ce que ferait du code étranger dans le widget pour envoyer ce qu'il a lu vers l'extérieur : fetch, image, sendBeacon, WebSocket, balises, formulaire. Chaque tentative est interceptée ; on regarde lesquelles la politique de sécurité du widget laisse passer.",
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
    case 3:
      return t === 'reussi'
        ? "En lisant des cellules piégées, le widget a modifié les objets de base de JavaScript : quiconque peut écrire dans le document peut changer le comportement du widget (pollution de prototype)."
        : "Le widget a lu des cellules piégées (JSON avec __proto__ et constructor.prototype, chemin __proto__.clé) sans modifier les objets de base de JavaScript. C'est ce qu'on attend ; cela ne couvre que ces trois formes de piège.";
    case 4:
      return t === 'reussi'
        ? "Le widget a obéi à des messages envoyés par un cadre quelconque : il n'en vérifie pas l'origine. Une page qui encadre le widget, ou un autre widget de la même page, peut lui faire exécuter du code ou appeler une adresse de son choix."
        : "Le widget a reçu des messages forgés (texte brut, objet, JSON) sans rien en faire : pas d'exécution de code, pas d'appel réseau. Cela ne couvre que ces formes de message et les noms de champs usuels.";
    case 5:
      return t === 'reussi'
        ? `Le widget a changé de conduite quand son adresse affirmait un accès « full » : ${(e.faits ?? []).join(' ; ')}. Il n'obtient pas pour autant plus d'accès (Grist fixe le niveau réel), mais il se règle sur son adresse plutôt que sur ce que Grist lui accorde. Information sans effet sur la note.`
        : "Le widget fait les mêmes appels à Grist quand son adresse affirme un accès « full » : il ne se règle pas sur son adresse. Seuls ses appels à Grist sont comparés, pas l'apparence de sa page.";
    case 7:
      return t === 'bloque'
        ? "Grist a bien refusé de transmettre les données au niveau « none ». C'est le garde-fou de Grist qui est vérifié ici, pas le widget."
        : "Grist a transmis des données alors que le niveau était « none » : défaut de Grist, pas du widget. Sans effet sur la note ; à signaler à l'éditeur de Grist.";
    case 8:
      return t === 'reussi'
        ? `Avec le niveau « ${e.niveau} », du code étranger qui s'exécuterait dans le widget (une bibliothèque piégée, par exemple) pourrait lire bien plus que sa table : ${(e.lus ?? []).join(', ')}. C'est ce que permet ce niveau d'accès ; cela ne devient un problème que si une dépendance du widget est compromise. Mesure donnée à titre d'information, sans effet sur la note.`
        : "Grist a refusé toute lecture en dehors de la table du widget : même du code piégé dans une bibliothèque ne pourrait pas lire le reste du document. Il garderait l'accès à la table du widget elle-même.";
    case 9:
      if (e.severite === 'info' && e.nature !== 'rayon') return "Grist a laissé un jeton d'accès ouvrir un autre document : défaut de Grist, pas du widget. Sans effet sur la note ; à signaler à l'éditeur de Grist.";
      return t === 'reussi'
        ? `Avec le niveau « ${e.niveau} », du code étranger dans le widget obtiendrait de Grist un jeton d'accès${e.ecriture ? ' avec écriture' : ''}, valable quelques minutes, et pourrait interroger directement l'API du document.${e.autreDocumentFerme ? " Grist refuse en revanche d'utiliser ce jeton sur un autre document." : ''} Mesure donnée à titre d'information, sans effet sur la note.`
        : "Du code piégé dans une bibliothèque ne pourrait pas se servir d'un jeton d'accès pour appeler l'API du document : un garde-fou l'a arrêté (nommé dans le détail).";
    case 10:
      return t === 'reussi'
        ? `Avec le niveau « ${e.niveau} », du code étranger dans le widget pourrait modifier le document : ${(e.faits ?? []).join(', ')}. L'audit l'a constaté en relisant le document de test, pas sur la parole du widget. Mesure donnée à titre d'information, sans effet sur la note (le niveau demandé est déjà pesé par C-GRIST-03).`
        : "Grist a refusé toute écriture à ce niveau : du code piégé dans une bibliothèque ne pourrait rien modifier dans le document.";
    case 12:
      return t === 'reussi'
        ? "Du code dans le widget a pu créer un webhook : il resterait en place après le retrait du widget et continuerait d'envoyer les modifications du document vers une adresse extérieure."
        : "Du code piégé dans le widget n'a pas pu créer de webhook, cette sortie permanente de données qui survivrait au retrait du widget. Résultat valable pour le réglage par défaut de Grist : un administrateur qui autorise des adresses de webhook peut le changer.";
    case 17:
      return t === 'reussi'
        ? "Après un clic dans le widget, du code étranger qui s'y exécuterait pourrait remplacer ce que la personne a copié (une commande à coller dans un terminal, par exemple). Grist donne ce droit à tous les widgets ; la mesure est donnée à titre d'information, sans effet sur la note."
        : "Le navigateur a refusé que le widget écrive dans le presse-papier : du code piégé n'aurait pas pu remplacer ce que la personne a copié.";
    case 18:
      return t === 'reussi'
        ? `Le navigateur laisserait du code étranger dans le widget demander à la personne : ${(e.ouverts ?? []).join(', ')}. Mesure donnée à titre d'information, sans effet sur la note ; à signaler à l'éditeur de Grist.`
        : "Grist ne donne au cadre du widget aucun des droits sensibles du navigateur (caméra, micro, position, partage d'écran, USB, paiement…) : du code piégé ne pourrait pas en demander à la personne. Seule l'écriture du presse-papier lui est déléguée (voir l'essai 17).";
    case 23:
      return t === 'reussi'
        ? `Le widget a gardé des données du document dans le navigateur (${(e.gardes ?? []).join(', ')}) : elles y restent après la fermeture du document et tout code de la même origine peut les lire. Effet limité (pénalité faible) ; à corriger si les données sont personnelles.`
        : "Aucune donnée du document n'a été retrouvée dans le navigateur après le chargement du widget : il ne garde rien en dehors de Grist.";
    case 24:
      return t === 'reussi'
        ? `Le widget a modifié le document dès son chargement, sans qu'on lui demande rien${(e.actions ?? []).length ? ` (${e.actions.join(', ')})` : ''}. Parfois voulu (initialiser une colonne), parfois une erreur ou une boucle : à vérifier. Information sans effet sur la note.`
        : "Le widget n'a rien écrit dans le document pendant son chargement : il ne modifie les données que sur une action de la personne.";
    case 19:
      return t === 'reussi'
        ? `La page Grist qui héberge le widget n'envoie pas tous ses en-têtes de sécurité : il manque ${(e.absents ?? []).length} sur ${e.total}. C'est une mesure de Grist et de son déploiement, pas du widget ; une instance derrière un proxy peut les poser. Information sans effet sur la note.`
        : "La page Grist qui héberge le widget envoie les en-têtes de sécurité mesurés (CSP, protection contre l'inclusion en cadre, Referrer-Policy, nosniff). Leur contenu n'est pas jugé.";
    case 20:
      return t === 'reussi'
        ? "Le widget a pu lire le document avec la session de la personne par l'API de l'instance : le niveau d'accès ne le borne plus. Défaut de Grist ou de son déploiement, pas du widget : sans effet sur la note ; à signaler."
        : "Le code du widget ne peut pas se servir de la session de la personne pour appeler l'API de l'instance : le navigateur (CORS) ou la CSP du widget l'arrête. Cela vaut pour un widget hébergé sur un site différent de celui de Grist ; un hébergement sur un sous-domaine du même site n'est pas simulé.";
    case 21:
      if (t === 'bloque') return "Le navigateur a refusé le fichier modifié : l'empreinte (integrity) déclarée par le widget fait son travail. Si le CDN servait un jour un fichier altéré, il ne s'exécuterait pas.";
      return e.severite === 'critique'
        ? "Le widget a exécuté une bibliothèque modifiée alors qu'il déclare une empreinte pour la protéger : l'empreinte ne protège pas. Un CDN compromis pourrait faire exécuter son code dans le widget."
        : "Le widget a exécuté la bibliothèque modifiée : rien ne vérifie ce que le CDN sert. Un CDN compromis pourrait faire exécuter son code dans le widget (voir les essais 8 et 9 pour ce que ce code obtiendrait). Déjà signalé par la règle E-DEP-01 : sans effet de plus sur la note.";
    case 22:
      if (t === 'bloque') return "La politique de sécurité (CSP) du widget a arrêté toutes les voies d'envoi usuelles : du code piégé ne pourrait pas envoyer ce qu'il a lu par ces voies." + (e.navigation ? " Il lui resterait la navigation du cadre vers une adresse extérieure, qu'aucune CSP ne ferme." : '');
      return `Si une bibliothèque du widget était piégée, elle pourrait envoyer ce qu'elle a lu vers l'extérieur par ${e.ouverts} voie(s) sur ${e.total}. Seule une politique de sécurité (CSP) stricte dans la page du widget les ferme. Mesure donnée à titre d'information, sans effet sur la note (l'absence de CSP est déjà signalée par C-CSP-01 et C-CSP-02).`;
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
    if (e.severite === 'info') return { cle: 'a_savoir', bande: 'neutre', symbole: 'i', mot: 'À savoir', precision: e.nature === 'rayon' ? "ce qu'obtiendrait une dépendance piégée, sans effet sur la note" : (e.nature === 'confirmation' ? "confirme E-DEP-01, sans effet de plus sur la note" : (e.nature === 'comportement' ? "comportement du widget, sans effet sur la note" : "défaut de Grist, pas du widget")) };
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
  if (n.a_savoir) morceaux.push(`${n.a_savoir} à savoir (information sans effet sur la note)`);
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

// Le nombre d'essais développés vient de la liste des essais jouables (`essaisJoues`), pas de ceux joués : l'essai 21, par exemple, n'existe que si le widget déclare des bibliothèques.
const nonJoues = (r) => `Ce rapport ne couvre pas tout : ${ESSAIS_DU_CATALOGUE - (r.essaisJoues?.length ?? r.essais.length)} essais du catalogue restent à développer (n° ${r.essaisPasEncore}).`;

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
