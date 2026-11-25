/**
 * Ce que les observations d'un vrai Grist veulent dire : les essais et leurs constats.
 *
 * Quatre résultats par essai, jamais davantage :
 *  - `reussi`       : l'effet a été observé ; un constat noté en découle (sauf l'essai 7, voir plus bas) ;
 *  - `bloque`       : Grist ou le navigateur a arrêté l'essai, avec le nom de la barrière (un bon signe, sans pénalité) ;
 *  - `rien_observe` : l'essai a pu se jouer et n'a rien produit (« rien observé » ne dit pas « aucune tentative » : une
 *                     tentative que Chromium abandonne sans rien consigner n'est pas vue) ;
 *  - `non_teste`    : l'essai n'a pas pu se jouer, avec la raison. Jamais présenté comme « rien trouvé ».
 *
 * Règle de prudence du projet : un faux constat est pire qu'un oubli. Un essai ne conclut donc rien tant que la
 * page n'a pas été chargée ET que Grist n'a pas transmis de données au widget (sinon `non_teste`).
 *
 * Numéros : ceux du catalogue de l'étude (essai 1 = XSS, 7 = niveau none, 8 = lecture hors périmètre, 9 = jeton d'accès et
 * appels directs, 12 = persistance par webhook, 13 = exfiltration mesurée, 15 = navigation du cadre parent, 16 = fenêtres).
 *
 * L'essai 21 (hors du catalogue de l'étude) répond à : si le CDN, ou quelqu'un qui en a pris le contrôle, sert un fichier modifié à la même
 * adresse, le widget l'exécute-t-il, ou une empreinte `integrity` l'arrête-t-elle ? Le fichier n'est modifié que par un marqueur inoffensif.
 *
 * L'essai 10 (écritures) vise des tables sacrifiées, une par effet ; les effets sont relus côté serveur par l'audit (verifierEcritures).
 *
 * L'essai 22 (hors du catalogue de l'étude) mesure les voies de sortie du navigateur que la politique de sécurité (CSP) du widget laisse ouvertes
 * à du code étranger : fetch, image, sendBeacon, WebSocket, balises, formulaire… Passe à part, vers un hôte factice distinct du puits.
 *
 * Les essais 8, 9 et 12 sont ceux de la « dépendance piégée » : du code étranger joué DANS le cadre du widget (voir kit.js) montre ce
 * qu'une bibliothèque compromise obtiendrait avec le niveau d'accès réellement accordé. Ils mesurent un rayon d'action, pas un défaut
 * prouvé du widget : leurs constats sont d'information (sans effet sur la note ; le niveau demandé est déjà pesé par C-GRIST-03),
 * sauf une persistance obtenue (webhook créé), qui est un constat majeur.
 */
import { constat } from '../../moteur/modele.js';
import { HOTE_PUITS, HOTE_CANAUX } from './donnees.js';

export const ESSAIS_JOUES = [1, 3, 4, 7, 8, 9, 10, 12, 13, 15, 16, 17, 18, 21, 22, 23, 24];
export const ESSAIS_PAS_ENCORE = '2, 5, 6, 11, 14, 19, 20';

/** Les voies de sortie essayées (identifiant dans l'adresse, libellé) ; la navigation du cadre est à part : aucune CSP ne la ferme. */
const CANAUX = [['fetch', 'fetch'], ['xhr', 'XMLHttpRequest'], ['image', 'image (balise img)'], ['beacon', 'sendBeacon'], ['websocket', 'WebSocket'], ['script', 'balise script'], ['iframe', 'cadre iframe'], ['feuille', 'feuille de style'], ['cssurl', 'image de fond CSS'], ['prefetch', 'préchargement (link prefetch)'], ['formulaire', 'formulaire envoyé']];

const resume = (texte, n = 300) => String(texte ?? '').replace(/\s+/g, ' ').slice(0, n);
const phasesChargees = (phases) => [phases.none, phases.demande?.obs].filter((o) => o?.charge);

function essai(id, titre, resultat, detail, extra = {}) { return { id, titre, resultat, detail, ...extra }; }

/** Quand le widget n'a rien échangé avec Grist : ce que le navigateur a vu qui peut l'expliquer (ressource du widget introuvable, erreur de page), pour que « non testé » dise pourquoi. */
function indiceSansEchange(obs) {
  if (obs?.introuvables?.length) return ` ; ressource(s) du widget introuvable(s) sur son serveur : ${obs.introuvables.slice(0, 3).map((r) => `${r.chemin} (${r.statut})`).join(', ')}`;
  if (obs?.erreursPage?.length) return ` ; erreur de page : ${resume(obs.erreursPage[0], 150)}`;
  return '';
}

/**
 * @param {{none: object|null, demande: {niveau: string, obs: object}|null}} phases
 * @param {object} jeu
 * @returns {{essais: Array, constats: Array}}
 */
export function evaluerEssais(phases, jeu) {
  const essais = []; const constats = [];
  const chargees = phasesChargees(phases);
  const niveauDemande = phases.demande?.niveau ?? null;
  const aucunePage = !chargees.length;
  const raisonPage = phases.none?.erreur ?? phases.demande?.obs?.erreur ?? "la page du widget n'a pas pu être chargée dans le vrai Grist";

  // --- 1. XSS : exécution, lecture hors table avec le niveau réel, sortie (enchaînement a) ---
  {
    const titre = 'XSS par valeur de cellule, puis lecture et sortie (enchaînement a)';
    const d = phases.demande;
    if (!d) essais.push(essai(1, titre, 'non_teste', aucunePage ? raisonPage : "le widget ne demande aucun accès aux données : aucune valeur de cellule ne lui est présentée"));
    else if (!d.obs.charge) essais.push(essai(1, titre, 'non_teste', `le widget n'a pas été chargé au niveau « ${d.niveau} » (${resume(d.obs.erreur)})`, { niveau: d.niveau }));
    else if (!d.obs.canariRecu) essais.push(essai(1, titre, 'non_teste', `Grist n'a transmis aucune donnée du document au widget au niveau « ${d.niveau} » (le widget n'a peut-être pas appelé grist.ready, ou attend une correspondance de colonnes que l'audit n'a pas su établir)${d.obs.appelsRpc.length ? '' : indiceSansEchange(d.obs)} : la charge ne lui a pas été présentée`, { niveau: d.niveau }));
    else if (!d.obs.xss.executions) essais.push(essai(1, titre, 'rien_observe', "la charge n'a pas été exécutée : valeur affichée en texte ou échappée, absente de l'écran du widget, ou refusée par sa politique de sécurité", { niveau: d.niveau }));
    else {
      const x = d.obs.xss;
      const lu = typeof x.lu === 'string' && x.lu.includes(jeu.prefixe);
      const sortie = d.obs.requetesExternes.find((r) => r.hote === HOTE_PUITS && r.canari);
      const etapes = [
        { etape: 'exécution dans le cadre du widget', ok: true },
        { etape: `lecture de la table appât par l'API Grist (niveau « ${d.niveau} »)`, ok: lu, ...(lu ? {} : { barriere: x.refus ? `refus de Grist : ${resume(x.refus, 160)}` : (x.erreur ? `API Grist inutilisable depuis la charge : ${resume(x.erreur, 160)}` : 'aucune lecture aboutie') }) },
        { etape: 'sortie vers un hôte externe (neutralisée par l\'audit)', ok: !!sortie, ...(sortie ? {} : { barriere: lu ? 'aucune requête de sortie observée' : 'rien à sortir' }) },
      ];
      if (lu) {
        essais.push(essai(1, titre, 'reussi', `la charge s'est exécutée, a lu la table appât avec le niveau « ${d.niveau} »${sortie ? ' et l\'a envoyée à l\'extérieur' : ' (sortie non observée)'}`, { niveau: d.niveau, regle: 'D-REEL-01', severite: 'critique', etapes }));
        constats.push(constat({
          regle: 'D-REEL-01', axe: 'D', severite: 'critique', bloquant: true, confiance: 'prouve',
          titre: `XSS exécutée dans un vrai Grist, avec lecture d'une autre table au niveau « ${d.niveau} »${sortie ? ' et sortie des données' : ''}`,
          constat: `Une valeur de cellule contenant \`<img onerror=…>\` a été rendue de façon à exécuter du code dans le cadre du widget, chargé par un vrai Grist (Grist Desktop, instance jetable) au niveau d'accès « ${d.niveau} ». Ce code a lu par l'API Grist une table qui n'était pas celle du widget (la table appât, canari ${jeu.prefixe}-APPAT-…)${sortie ? " et en a envoyé le contenu vers un hôte externe (requête interceptée par l'audit, rien n'est sorti de la machine)" : ''}.`,
          impact: "Une donnée de cellule ordinaire devient du code qui agit avec le niveau d'accès que l'agent a accordé au widget, et lit le reste du document. N'importe quel contributeur du document peut viser quiconque ouvre ce widget. Contrairement à D-XSS-01 (faux hôte), la lecture a été accordée ou refusée par Grist lui-même.",
          remediation: "Rendre les valeurs de cellule en texte (`textContent`) ou les échapper avant tout `innerHTML` ; ajouter une politique de sécurité (CSP) sans `unsafe-inline` ; ne demander que le niveau d'accès nécessaire.",
          referentiels: ['OWASP Top 10 A03:2021 — Injection', 'CWE-79'],
          preuve: { niveau: d.niveau, etapes, canariLu: true, sortieObservee: !!sortie },
        }));
      } else {
        essais.push(essai(1, titre, 'reussi', `la charge s'est exécutée ; la lecture hors table a été arrêtée (${etapes[1].barriere})`, { niveau: d.niveau, regle: 'D-REEL-01', severite: 'majeur', etapes }));
        constats.push(constat({
          regle: 'D-REEL-01', axe: 'D', severite: 'majeur', bloquant: false, confiance: 'prouve',
          titre: `XSS exécutée dans un vrai Grist (lecture hors table arrêtée au niveau « ${d.niveau} »)`,
          constat: `Une valeur de cellule contenant \`<img onerror=…>\` a été rendue de façon à exécuter du code dans le cadre du widget, chargé par un vrai Grist (Grist Desktop, instance jetable) au niveau d'accès « ${d.niveau} ». La tentative de lecture d'une autre table par ce code n'a pas abouti : ${etapes[1].barriere}.`,
          impact: "Le code injecté s'exécute avec les moyens du widget : il agit sur ce que le widget affiche et sur les données de la table qu'il reçoit. Ici, Grist a refusé la lecture hors de cette table ; un niveau d'accès plus large (`full`) l'aurait permise.",
          remediation: "Rendre les valeurs de cellule en texte (`textContent`) ou les échapper avant tout `innerHTML` ; ajouter une politique de sécurité (CSP) sans `unsafe-inline`.",
          referentiels: ['OWASP Top 10 A03:2021 — Injection', 'CWE-79'],
          preuve: { niveau: d.niveau, etapes },
        }));
      }
    }
  }

  // --- 7. Niveau none : Grist ne doit transmettre aucune donnée ---
  {
    const titre = "Niveau d'accès « none » : aucune donnée transmise";
    const a = phases.none;
    if (!a?.charge) essais.push(essai(7, titre, 'non_teste', raisonPage, { niveau: 'none' }));
    else if (a.canariRecu) {
      essais.push(essai(7, titre, 'reussi', "des données du document sont arrivées au widget alors qu'il était limité à « none » (défaut de Grist, pas du widget)", { niveau: 'none', regle: 'D-REEL-07', severite: 'info' }));
      constats.push(constat({
        regle: 'D-REEL-07', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
        titre: 'Grist a transmis des données à un widget limité au niveau « none »',
        constat: "Au niveau d'accès « none », des valeurs du document de test (canari) sont arrivées au widget. Ce n'est pas un défaut du widget : le niveau d'accès est appliqué par Grist.",
        impact: "À signaler à l'éditeur de Grist, en précisant la version testée. Ne pèse pas sur la note du widget.",
        remediation: "Aucune action sur le widget. Vérifier la version de Grist avant de conclure et la signaler.",
        preuve: { niveau: 'none' },
      }));
    } else if (a.appelsRpc.length) {
      essais.push(essai(7, titre, 'bloque', "Grist n'a transmis aucune donnée du document au widget au niveau « none »", { niveau: 'none', barriere: 'Grist (niveau d\'accès)' }));
    } else essais.push(essai(7, titre, 'non_teste', `le widget n'a eu aucun échange avec Grist pendant l'essai (grist.ready non appelé)${indiceSansEchange(a)}`, { niveau: 'none' }));
  }

  // --- 13. Exfiltration mesurée : un canari du document arrive-t-il à l'extérieur ? ---
  {
    const titre = 'Exfiltration mesurée par canaris';
    const avecDonnees = chargees.filter((o) => o.canariRecu);
    if (aucunePage) essais.push(essai(13, titre, 'non_teste', raisonPage));
    else if (!avecDonnees.length) essais.push(essai(13, titre, 'non_teste', "aucune donnée du document n'est arrivée au widget (à aucun niveau joué) : une fuite ne pouvait pas se produire, l'absence de fuite n'est pas démontrée"));
    else {
      const sorties = chargees.flatMap((o) => o.requetesExternes.filter((r) => (r.provenance === 'widget' || r.provenance === 'fenetre') && r.hote !== HOTE_PUITS));
      const fuites = sorties.filter((r) => r.canari);
      if (fuites.length) {
        const hotes = [...new Set(fuites.map((r) => r.hote))];
        essais.push(essai(13, titre, 'reussi', `une valeur du document a été trouvée dans une requête vers ${hotes.join(', ')}`, { regle: 'D-REEL-13', severite: 'critique' }));
        constats.push(constat({
          regle: 'D-REEL-13', axe: 'D', severite: 'critique', bloquant: true, confiance: 'prouve',
          titre: `Des données du document sortent du widget vers ${hotes.join(', ')} (canari retrouvé)`,
          constat: `${fuites.length} requête(s) émise(s) par le widget, chargé par un vrai Grist, contenaient une valeur du document de test (canari « ${resume(fuites[0].canari, 60)} ») : ${fuites.slice(0, 3).map((r) => `${r.methode} ${resume(r.url, 160)}`).join(' ; ')}. Les requêtes ont été interceptées par l'audit : rien n'est sorti de la machine.`,
          impact: "C'est la preuve que des données du document quittent bien le widget, pas seulement qu'une requête externe est tentée (D-RESEAU-01). En usage réel elles atteindraient ce domaine.",
          remediation: "Confirmer avec le contributeur ce que cette requête transporte ; la supprimer ou la déclarer explicitement (README, liste blanche) et n'y envoyer aucune donnée du document.",
          referentiels: ['OWASP Top 10 A10:2021', 'CWE-200'],
          preuve: { requetes: fuites.slice(0, 10).map(({ url, methode, hote, type, corps, canari }) => ({ url, methode, hote, type, corps, canari })) },
        }));
      } else if (sorties.length) {
        essais.push(essai(13, titre, 'rien_observe', `${sorties.length} requête(s) sortante(s) neutralisée(s) (${[...new Set(sorties.map((r) => r.hote))].slice(0, 4).join(', ')}) ; aucun canari ni valeur du document trouvé en clair dans leur adresse ou leur corps (hors encodage particulier)`, { sorties: sorties.length }));
      } else essais.push(essai(13, titre, 'rien_observe', 'aucune requête sortante du widget pendant les phases jouées'));
    }
  }

  // --- 15. Navigation du cadre parent ---
  {
    const titre = 'Navigation du cadre parent (la page Grist)';
    const navs = chargees.flatMap((o) => o.navigations);
    const refusees = chargees.flatMap((o) => o.navigationsRefusees);
    if (aucunePage) essais.push(essai(15, titre, 'non_teste', raisonPage));
    else if (navs.length) {
      essais.push(essai(15, titre, 'reussi', `la page Grist a été redirigée vers ${resume(navs[0].url, 120)}`, { regle: 'D-REEL-15', severite: 'majeur' }));
      constats.push(constat({
        regle: 'D-REEL-15', axe: 'D', severite: 'majeur', bloquant: false, confiance: 'prouve',
        titre: 'Le widget redirige la page Grist qui l\'héberge',
        constat: `Le widget, chargé par un vrai Grist, a fait naviguer la page parente vers ${resume(navs[0].url, 200)} (navigation interceptée par l'audit).`,
        impact: "Un widget qui peut remplacer la page Grist peut présenter une fausse page de connexion à quelqu'un qui croit être dans son document.",
        remediation: 'Supprimer toute navigation du cadre parent (`window.top.location`, `target=_top`, formulaire vers `_top`, `<meta refresh>` dans le parent).',
        preuve: { navigations: navs.slice(0, 5) },
      }));
    } else if (refusees.length) {
      essais.push(essai(15, titre, 'bloque', `Chromium a refusé une navigation du cadre parent : ${resume(refusees[0], 140)}`, { barriere: 'Chromium (navigation du cadre parent sans geste de l\'utilisateur)' }));
    } else essais.push(essai(15, titre, 'rien_observe', 'la page Grist est restée à son adresse, sans navigation consignée (sans clic de personne : une navigation qui exige un geste n\'est pas jouée)'));
  }

  // --- 16. Fenêtres, boîtes de dialogue, téléchargements ---
  {
    const titre = 'Fenêtres, boîtes de dialogue, téléchargements';
    const popups = chargees.flatMap((o) => o.popups); const dialogues = chargees.flatMap((o) => o.dialogues); const dl = chargees.flatMap((o) => o.telechargements);
    if (aucunePage) essais.push(essai(16, titre, 'non_teste', raisonPage));
    else if (popups.length || dialogues.length || dl.length) {
      const liste = [popups.length ? `${popups.length} fenêtre(s) ouverte(s)` : null, dialogues.length ? `${dialogues.length} boîte(s) de dialogue (${[...new Set(dialogues.map((d) => d.type))].join(', ')})` : null, dl.length ? `${dl.length} téléchargement(s)` : null].filter(Boolean).join(', ');
      essais.push(essai(16, titre, 'reussi', liste, { regle: 'D-REEL-16', severite: 'majeur' }));
      constats.push(constat({
        regle: 'D-REEL-16', axe: 'D', severite: 'majeur', bloquant: false, confiance: 'prouve',
        titre: `Le widget ouvre des fenêtres, des boîtes de dialogue ou des téléchargements (${liste})`,
        constat: `Pendant le chargement dans un vrai Grist, le widget a produit : ${liste}. Les fenêtres ont été refermées, les boîtes de dialogue fermées et les téléchargements annulés par l'audit.`,
        impact: "Une boîte de dialogue bloque l'interface de Grist ; une fenêtre ou un téléchargement non demandés sont des vecteurs d'hameçonnage ou de dépôt de fichier.",
        remediation: "Retirer `window.open`, `alert`/`confirm`/`prompt` et les téléchargements automatiques du chargement du widget ; ne les déclencher qu'après un clic explicite.",
        preuve: { fenetres: popups.slice(0, 5), dialogues: dialogues.slice(0, 5), telechargements: dl.slice(0, 5) },
      }));
    } else essais.push(essai(16, titre, 'rien_observe', 'aucune fenêtre, boîte de dialogue ni téléchargement pendant les phases jouées'));
  }

  // --- 8, 9, 12. Dépendance piégée : ce que du code étranger dans le cadre du widget obtient avec le niveau réellement accordé ---
  {
    const niveau = niveauDemande ?? 'none';
    const o = niveauDemande ? phases.demande.obs : phases.none;
    const k = o?.kit ?? null;
    const raison = aucunePage ? raisonPage
      : !o?.charge ? `le widget n'a pas été chargé au niveau « ${niveau} » (${resume(o?.erreur)})`
      : !k ? "le code d'essai n'a pas pu être joué dans le cadre du widget"
      : k.erreur ? `le code d'essai n'a pas pu être joué dans le cadre du widget (${resume(k.erreur, 150)})`
      : !k.grist ? "le widget n'expose pas l'API Grist (`grist`) : le code d'essai n'a rien pour parler à Grist"
      : null;
    const titre8 = 'Dépendance piégée : lecture hors de la table du widget';
    const titre9 = "Dépendance piégée : jeton d'accès et appels directs à l'API";
    const titre12 = 'Dépendance piégée : persistance par webhook';
    if (raison) for (const [id, titre] of [[8, titre8], [9, titre9], [12, titre12]]) essais.push(essai(id, titre, 'non_teste', raison, { niveau }));
    else {
      const refus = (r) => !!r && r.ok === false && /access not granted/i.test(r.erreur ?? '');
      const barriereGrist = `refus de Grist au niveau « ${niveau} »`;
      const csp = (k.violations ?? []).some((v) => /^connect-src/.test(v));
      const marche = (r) => !!r?.ok;

      // 8. Lecture hors périmètre
      {
        const etapes = [
          { etape: 'liste des tables du document', ok: marche(k.tables), ...(marche(k.tables) ? {} : { barriere: refus(k.tables) ? barriereGrist : resume(k.tables?.erreur, 120) }) },
          { etape: "lecture d'une table sans rapport avec le widget (la table appât)", ok: marche(k.appat), ...(marche(k.appat) ? {} : { barriere: refus(k.appat) ? barriereGrist : resume(k.appat?.erreur, 120) }) },
          { etape: "lecture des tables système (structure du document, règles d'accès, vues)", ok: Object.values(k.systeme ?? {}).some(marche), ...(Object.values(k.systeme ?? {}).some(marche) ? {} : { barriere: Object.values(k.systeme ?? {}).every(refus) ? barriereGrist : resume(Object.values(k.systeme ?? {})[0]?.erreur, 120) }) },
        ];
        const lus = etapes.filter((x) => x.ok).map((x) => x.etape);
        if (lus.length) {
          const precis = ["la liste des tables du document", "une table sans rapport avec le widget", "les tables système (structure, règles d'accès, vues)"].filter((_, i) => etapes[i].ok);
          essais.push(essai(8, titre8, 'reussi', `avec le niveau « ${niveau} », le code d'essai joué dans le widget a pu : ${precis.join(' ; ')}`, { niveau, regle: 'D-REEL-08', severite: 'info', nature: 'rayon', etapes, lus: precis }));
          constats.push(constat({
            regle: 'D-REEL-08', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
            titre: `Avec le niveau « ${niveau} », du code étranger dans le widget lirait bien plus que sa table`,
            constat: `Du code exécuté dans le cadre du widget, comme le ferait une bibliothèque piégée, chargé par un vrai Grist (Grist Desktop, instance jetable) au niveau d'accès « ${niveau} », a pu : ${precis.join(' ; ')}. Essai fait sur le document de test de l'audit ; il mesure ce que le niveau permet, il ne prouve pas qu'une dépendance du widget soit piégée.`,
            impact: "Si une bibliothèque chargée par le widget était un jour compromise (compte du mainteneur piraté, version non figée, CDN compromis), elle aurait ce rayon d'action. Il grandit avec le niveau d'accès demandé. Le niveau demandé est déjà pesé par C-GRIST-03 : cette mesure n'ajoute pas de pénalité.",
            remediation: "Ne demander que le niveau nécessaire (`read table` si le widget ne lit que sa table liée) ; figer les bibliothèques (version et empreinte) ou les embarquer dans le dépôt.",
            referentiels: ['Principe du moindre privilège', 'OWASP Top 10 A08:2021 — Software and Data Integrity Failures'],
            preuve: { niveau, etapes },
          }));
        } else if (etapes.every((x) => x.barriere === barriereGrist)) {
          essais.push(essai(8, titre8, 'bloque', `Grist a refusé au niveau « ${niveau} » toute lecture hors de la table du widget (liste des tables, table appât, tables système)`, { niveau, barriere: "Grist (niveau d'accès)", etapes }));
        } else essais.push(essai(8, titre8, 'non_teste', `les lectures n'ont pas abouti sans que Grist les refuse (${resume(etapes.map((x) => x.barriere).join(' ; '), 200)})`, { niveau, etapes }));
      }

      // 9. Jeton d'accès et appels directs à l'API du document
      {
        const jetons = [k.jetonLecture, k.jetonEcriture];
        const direct = !!(k.tablesRest?.cite || k.sql?.cite);
        const autre = k.autreDoc ?? null;
        const etapes = [
          { etape: "jeton d'accès en lecture (`getAccessToken`)", ok: marche(k.jetonLecture), ...(marche(k.jetonLecture) ? {} : { barriere: refus(k.jetonLecture) ? barriereGrist : resume(k.jetonLecture?.erreur, 120) }) },
          { etape: "jeton d'accès avec écriture", ok: marche(k.jetonEcriture), ...(marche(k.jetonEcriture) ? {} : { barriere: refus(k.jetonEcriture) ? barriereGrist : resume(k.jetonEcriture?.erreur, 120) }) },
          ...(jetons.some(marche) ? [{ etape: "appel direct à l'API du document avec le jeton (liste des tables, requête SQL)", ok: direct, ...(direct ? {} : { barriere: csp ? 'politique de sécurité (CSP) du widget : connect-src' : resume(k.sql?.erreur ?? k.tablesRest?.erreur ?? `réponse ${k.sql?.statut ?? k.tablesRest?.statut ?? 'absente'}`, 120) }) }] : []),
          ...(direct && autre ? [{ etape: 'le même jeton sur un AUTRE document de l\'instance', ok: !!autre.canari, ...(autre.canari ? {} : { barriere: `Grist : ${autre.statut ?? ''} ${autre.erreurGrist ?? autre.erreur ?? ''}`.trim() }) }] : []),
        ];
        if (autre?.canari) {
          essais.push(essai(9, titre9, 'reussi', `le jeton d'accès obtenu par le widget a ouvert un autre document de l'instance (canari retrouvé), au niveau « ${niveau} »`, { niveau, regle: 'D-REEL-09', severite: 'info', etapes }));
          constats.push(constat({
            regle: 'D-REEL-09', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
            titre: "Un jeton d'accès obtenu par un widget ouvre un autre document de l'instance",
            constat: `Au niveau « ${niveau} », le jeton d'accès délivré par Grist au code du widget a permis de lire un autre document de l'instance jetable (son canari a été retrouvé). Ce n'est pas un défaut du widget : les jetons doivent être limités à leur document.`,
            impact: "À signaler à l'éditeur de Grist, en précisant la version testée. Ne pèse pas sur la note du widget.",
            remediation: "Aucune action sur le widget. Vérifier la version de Grist avant de conclure et la signaler.",
            preuve: { niveau, etapes },
          }));
        } else if (direct) {
          const ecrit = marche(k.jetonEcriture);
          const phrase = `avec le niveau « ${niveau} », le code d'essai a obtenu un jeton d'accès${ecrit ? ' avec écriture' : ' en lecture'} et l'a utilisé pour interroger directement l'API du document${autre ? ' (un autre document de l\'instance est resté fermé)' : ''}`;
          essais.push(essai(9, titre9, 'reussi', phrase, { niveau, regle: 'D-REEL-09', severite: 'info', nature: 'rayon', etapes, ecriture: ecrit, autreDocumentFerme: !!autre }));
          constats.push(constat({
            regle: 'D-REEL-09', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
            titre: `Avec le niveau « ${niveau} », du code étranger dans le widget obtiendrait un jeton d'accès à l'API du document`,
            constat: `Du code exécuté dans le cadre du widget, comme le ferait une bibliothèque piégée, a obtenu de Grist un jeton d'accès${ecrit ? ' avec écriture' : ' en lecture'} (valable quelques minutes) et s'en est servi pour appeler directement l'API du document (liste des tables, requête SQL). ${autre ? "Le même jeton n'a pas ouvert un autre document de l'instance. " : ''}Essai fait sur le document de test de l'audit ; il mesure ce que le niveau permet, il ne prouve pas qu'une dépendance du widget soit piégée.`,
            impact: "Un jeton permet de lire, et ici d'écrire, le document hors de l'interface du widget, depuis n'importe quel code qui s'exécute dans son cadre. Seule la politique de sécurité (CSP) du widget limite les adresses qu'il peut appeler. Le niveau demandé est déjà pesé par C-GRIST-03 : cette mesure n'ajoute pas de pénalité.",
            remediation: "Ne demander que le niveau nécessaire ; restreindre les appels réseau du widget par une CSP (`connect-src`) ; figer les bibliothèques (version et empreinte) ou les embarquer dans le dépôt.",
            referentiels: ['Principe du moindre privilège', 'OWASP Top 10 A08:2021 — Software and Data Integrity Failures'],
            preuve: { niveau, etapes },
          }));
        } else if (!jetons.some(marche) && jetons.every(refus)) {
          essais.push(essai(9, titre9, 'bloque', `Grist a refusé de délivrer un jeton d'accès au niveau « ${niveau} »`, { niveau, barriere: "Grist (niveau d'accès)", etapes }));
        } else if (jetons.some(marche) && csp) {
          essais.push(essai(9, titre9, 'bloque', `un jeton a été délivré au niveau « ${niveau} », mais l'appel direct à l'API a été arrêté par la politique de sécurité (CSP) du widget`, { niveau, barriere: 'politique de sécurité (CSP) du widget', etapes }));
        } else essais.push(essai(9, titre9, 'non_teste', `le jeton d'accès ou l'appel direct n'a pas abouti sans que Grist ou la CSP le refuse (${resume(etapes.map((x) => x.barriere).filter(Boolean).join(' ; '), 200)})`, { niveau, etapes }));
      }

      // 12. Persistance : un webhook créé reste en place après le retrait du widget
      {
        const w = k.webhook ?? null;
        if (w?.cree) {
          essais.push(essai(12, titre12, 'reussi', `le code d'essai a créé un webhook vers un hôte extérieur au niveau « ${niveau} »${w.listeContientLeWebhook ? ', et il figure dans la liste des webhooks du document' : ''}`, { niveau, regle: 'D-REEL-12', severite: 'majeur' }));
          constats.push(constat({
            regle: 'D-REEL-12', axe: 'D', severite: 'majeur', bloquant: false, confiance: 'prouve',
            titre: `Du code dans le widget a pu créer un webhook (niveau « ${niveau} »)`,
            constat: `Du code exécuté dans le cadre du widget, comme le ferait une bibliothèque piégée, a créé dans le document de test un webhook vers un hôte extérieur (adresse neutralisée par l'audit : ${HOTE_PUITS}).`,
            impact: "Un webhook appartient au document, pas au widget : il resterait en place après le retrait du widget et continuerait d'envoyer les modifications du document à une adresse extérieure.",
            remediation: "Ne pas accorder le niveau « full » à un widget qui n'écrit pas ; restreindre les adresses de webhook autorisées côté administration de Grist (`ALLOWED_WEBHOOK_DOMAINS`) ; surveiller la liste des webhooks du document.",
            referentiels: ['OWASP Top 10 A08:2021 — Software and Data Integrity Failures', 'CWE-912'],
            preuve: { niveau, statut: w.statut },
          }));
        } else if (!marche(k.jetonEcriture)) {
          if (refus(k.jetonEcriture)) essais.push(essai(12, titre12, 'bloque', `au niveau « ${niveau} », Grist ne délivre pas de jeton avec écriture : aucun webhook ne peut être créé`, { niveau, barriere: "Grist (niveau d'accès)" }));
          else essais.push(essai(12, titre12, 'non_teste', `le jeton avec écriture n'a pas pu être obtenu (${resume(k.jetonEcriture?.erreur, 150)})`, { niveau }));
        } else if (w?.statut === 403 && /forbidden/i.test(w.erreurGrist ?? '')) {
          essais.push(essai(12, titre12, 'bloque', `Grist a refusé la création du webhook (« ${resume(w.erreurGrist, 80)} ») : aucune adresse de webhook n'est autorisée dans le réglage par défaut`, { niveau, barriere: "réglage par défaut de Grist (aucune adresse de webhook autorisée)" }));
        } else if (csp) {
          essais.push(essai(12, titre12, 'bloque', `la création du webhook a été arrêtée par la politique de sécurité (CSP) du widget`, { niveau, barriere: 'politique de sécurité (CSP) du widget' }));
        } else essais.push(essai(12, titre12, 'non_teste', `la création du webhook n'a pas abouti sans refus identifié (${w ? `réponse ${w.statut ?? ''} ${resume(w.erreurGrist ?? w.erreur, 100)}` : 'aucune réponse'})`, { niveau }));
      }
    }
  }

  // --- 21. Altération d'une bibliothèque servie à la même adresse : le navigateur l'exécute-t-il ? ---
  {
    const a = phases.alteration;
    const titre = "Bibliothèque modifiée à la source, servie à la même adresse";
    if (a) {
      const niveau = a.niveau;
      const refuseesPar = (obs) => (obs?.consoles ?? []).filter((c) => /integrity|digest/i.test(c.texte)).map((c) => (c.texte.match(/resource '([^']+)'/) ?? [])[1]).filter(Boolean);
      const dejaRefusees = new Set(chargees.flatMap((o) => refuseesPar(o)));
      const refusees = new Set(refuseesPar(a.obs));
      const fichiers = new Map((a.fichiers ?? []).map((f) => [f.url, f]));
      if (a.indisponible) essais.push(essai(21, titre, 'non_teste', a.indisponible, { niveau }));
      else if (!a.obs?.charge) essais.push(essai(21, titre, 'non_teste', `le widget n'a pas été chargé avec les bibliothèques modifiées (${resume(a.obs?.erreur)})`, { niveau }));
      else {
        const executees = (a.obs.alteration?.executees ?? []).map((id) => a.marqueurs?.get(id)).filter(Boolean);
        const protegeesExecutees = executees.filter((u) => fichiers.get(u)?.protegee);
        const refuseesPourLaModification = [...fichiers.keys()].filter((u) => refusees.has(u) && !dejaRefusees.has(u));
        const liste = (urls) => urls.slice(0, 3).map((u) => resume(u, 100)).join(', ') + (urls.length > 3 ? ` et ${urls.length - 3} autre(s)` : '');
        if (protegeesExecutees.length) {
          essais.push(essai(21, titre, 'reussi', `${liste(protegeesExecutees)} : le fichier modifié a été exécuté alors que l'analyse du code le croit protégé par une empreinte (integrity)`, { niveau, regle: 'D-REEL-21', severite: 'critique', fichiers: protegeesExecutees.length }));
          constats.push(constat({
            regle: 'D-REEL-21', axe: 'D', severite: 'critique', bloquant: true, confiance: 'prouve',
            titre: "Une bibliothèque modifiée à la source est exécutée malgré l'empreinte (integrity) déclarée",
            constat: `Le fichier ${resume(protegeesExecutees[0], 200)}${protegeesExecutees.length > 1 ? ` (et ${protegeesExecutees.length - 1} autre(s))` : ''}, servi à la même adresse avec une ligne de plus (un marqueur inoffensif, qui ne lit ni n'envoie rien), a été exécuté par le widget chargé dans un vrai Grist (niveau « ${niveau} »), alors que l'analyse du code le croit protégé par une empreinte. L'empreinte déclarée ne joue donc pas son rôle dans ce navigateur.`,
            impact: "Un fichier modifié par le CDN, ou par quiconque en prend le contrôle, s'exécuterait dans le widget avec ses droits : voir les essais 8 et 9 pour ce que cela donne avec le niveau d'accès accordé.",
            remediation: "Vérifier la forme de l'empreinte (algorithme `sha384`, valeur en base64, `crossorigin=\"anonymous\"`) et, pour un module, la clé `integrity` de l'import map ; à défaut, embarquer la bibliothèque dans le dépôt (`vendor/`).",
            referentiels: ['OWASP Top 10 A08:2021 — Software and Data Integrity Failures', 'CWE-353'],
            preuve: { niveau, fichiers: protegeesExecutees.slice(0, 5) },
          }));
        } else if (executees.length) {
          essais.push(essai(21, titre, 'reussi', `${liste(executees)} : le fichier modifié a été exécuté, rien n'a vérifié son contenu (aucune empreinte déclarée)`, { niveau, regle: 'D-REEL-21', severite: 'info', nature: 'confirmation', fichiers: executees.length }));
          constats.push(constat({
            regle: 'D-REEL-21', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
            titre: "Une bibliothèque modifiée à la source serait exécutée par le widget (aucune empreinte)",
            constat: `Le fichier ${resume(executees[0], 200)}${executees.length > 1 ? ` (et ${executees.length - 1} autre(s))` : ''}, servi à la même adresse avec une ligne de plus (un marqueur inoffensif, qui ne lit ni n'envoie rien), a été exécuté par le widget chargé dans un vrai Grist (niveau « ${niveau} »). L'analyse du code ne lui reconnaissait aucune empreinte : l'essai le confirme.`,
            impact: "Confirme E-DEP-01, déjà noté : ce qu'un CDN compromis servirait s'exécuterait dans le widget avec ses droits (voir les essais 8 et 9). Cette mesure n'ajoute pas de pénalité.",
            remediation: "Embarquer la bibliothèque dans le dépôt (`vendor/`), ou la figer par version et empreinte (`integrity`, ou clé `integrity` de l'import map).",
            referentiels: ['OWASP Top 10 A08:2021 — Software and Data Integrity Failures', 'CWE-353'],
            preuve: { niveau, fichiers: executees.slice(0, 5) },
          }));
        } else if (refuseesPourLaModification.length) {
          essais.push(essai(21, titre, 'bloque', `${liste(refuseesPourLaModification)} : le navigateur a refusé le fichier modifié (l'empreinte ne correspond plus)`, { niveau, barriere: "empreinte d'intégrité (integrity) vérifiée par le navigateur" }));
        } else {
          essais.push(essai(21, titre, 'non_teste', `aucun des ${fichiers.size} fichier(s) modifié(s) n'a été exécuté et aucun refus d'empreinte n'a été vu : la bibliothèque n'a pas été demandée par le widget, ou elle a échoué pour une autre raison${dejaRefusees.size ? " (une empreinte refuse déjà le fichier non modifié : elle ne correspond pas à ce que le serveur sert)" : ''}`, { niveau }));
        }
      }
    }
  }

  // --- 22. Voies de sortie ouvertes à du code piégé dans le widget (passe à part, vers un hôte factice distinct du puits) ---
  {
    const c = phases.canaux;
    const titre = 'Dépendance piégée : voies de sortie des données';
    if (c) {
      const niveau = c.niveau;
      const o = c.obs;
      const k = o?.canaux ?? null;
      if (!o?.charge) essais.push(essai(22, titre, 'non_teste', `le widget n'a pas été chargé pour cet essai (${resume(o?.erreur)})`, { niveau }));
      else if (!k || k.erreur) essais.push(essai(22, titre, 'non_teste', `le code d'essai n'a pas pu être joué dans le cadre du widget${k?.erreur ? ` (${resume(k.erreur, 150)})` : ''}`, { niveau }));
      else {
        const nomDe = (adresse) => (String(adresse).match(new RegExp(`//([a-z]+)\\.${HOTE_CANAUX.replace(/\./g, '\\.')}`)) ?? [])[1];
        const vus = new Set(o.requetesExternes.filter((r) => String(r.hote).endsWith(`.${HOTE_CANAUX}`)).map((r) => nomDe(r.url)).filter(Boolean));
        // La WebSocket n'est pas interceptée : tentée sans que la CSP l'arrête = la connexion a été essayée (elle échoue faute de DNS).
        if (k.reseau?.websocket && !(k.violations ?? []).some((v) => nomDe(v.bloque) === 'websocket')) vus.add('websocket');
        const arretes = new Map((k.violations ?? []).map((v) => [nomDe(v.bloque), v.directive]).filter(([nom]) => nom));
        const etat = (nom) => (vus.has(nom) ? 'ouvert' : arretes.has(nom) ? 'ferme' : 'inconnu');
        const etapes = CANAUX.map(([nom, libelle]) => ({ etape: `envoi par ${libelle}`, ok: etat(nom) === 'ouvert', ...(etat(nom) === 'ferme' ? { barriere: `politique de sécurité (CSP) : ${resume(arretes.get(nom), 60)}` } : etat(nom) === 'inconnu' ? { barriere: 'aucune requête vue, aucun blocage signalé' } : {}) }));
        const ouverts = CANAUX.filter(([nom]) => etat(nom) === 'ouvert').map(([, l]) => l);
        const fermes = CANAUX.filter(([nom]) => etat(nom) === 'ferme').map(([, l]) => l);
        const inconnus = CANAUX.filter(([nom]) => etat(nom) === 'inconnu').map(([, l]) => l);
        const navigation = etat('navigation') === 'ouvert';
        const note = navigation ? " Reste ouverte dans tous les cas : la navigation du cadre vers une adresse extérieure, qu'aucune politique de sécurité ne peut fermer." : '';
        if (ouverts.length) {
          essais.push(essai(22, titre, 'reussi', `avec le niveau « ${niveau} », le code d'essai a pu envoyer vers l'extérieur par ${ouverts.length} voie(s) sur ${CANAUX.length} : ${ouverts.join(', ')}${fermes.length ? ` ; arrêtées par la CSP : ${fermes.join(', ')}` : ''}${inconnus.length ? ` ; sans observation : ${inconnus.join(', ')}` : ''}.${note}`, { niveau, regle: 'D-REEL-22', severite: 'info', nature: 'rayon', etapes, ouverts: ouverts.length, total: CANAUX.length, navigation }));
          constats.push(constat({
            regle: 'D-REEL-22', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
            titre: `Si une dépendance du widget était piégée, ${ouverts.length} voie(s) de sortie sur ${CANAUX.length} lui seraient ouvertes`,
            constat: `Du code exécuté dans le cadre du widget, comme le ferait une bibliothèque piégée, chargé par un vrai Grist au niveau d'accès « ${niveau} », a tenté d'envoyer un marqueur vers un hôte extérieur factice (intercepté par l'audit, rien n'est sorti de la machine). Voies ouvertes : ${ouverts.join(', ')}.${fermes.length ? ` Voies arrêtées par la politique de sécurité (CSP) du widget : ${fermes.join(', ')}.` : ' Aucune voie arrêtée : le widget ne déclare pas de politique de sécurité qui les ferme.'}${note}`,
            impact: "La politique de sécurité (CSP) du widget est la seule barrière qui empêcherait du code compromis d'envoyer ce qu'il a lu (voir les essais 8 et 9 pour ce qu'il peut lire). Mesure d'un rayon d'action : elle ne prouve pas qu'une dépendance soit piégée. L'absence de CSP est déjà pesée par C-CSP-01 et C-CSP-02 : cette mesure n'ajoute pas de pénalité.",
            remediation: "Déclarer une CSP restrictive par `<meta http-equiv=\"Content-Security-Policy\">` : par exemple `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`, à ajuster à ce dont le widget a besoin ; embarquer les bibliothèques dans le dépôt pour que `script-src 'self'` suffise.",
            referentiels: ['OWASP Top 10 A05:2021 — Security Misconfiguration', 'CWE-1021'],
            preuve: { niveau, ouvertes: ouverts, arretees: fermes, sansObservation: inconnus, navigation },
          }));
        } else if (!inconnus.length) {
          essais.push(essai(22, titre, 'bloque', `la politique de sécurité (CSP) du widget a arrêté les ${CANAUX.length} voies d'envoi essayées (${[...new Set(arretes.values())].slice(0, 4).join(', ')}).${note}`, { niveau, barriere: 'politique de sécurité (CSP) du widget', etapes, navigation }));
        } else {
          essais.push(essai(22, titre, 'non_teste', `aucune voie n'a abouti et ${inconnus.length} sur ${CANAUX.length} n'ont donné ni requête vue ni blocage signalé (${inconnus.slice(0, 3).join(', ')}) : la mesure n'est pas fiable`, { niveau, etapes }));
        }
      }
    }
  }

  // --- 3. Données hostiles : des clés dangereuses ajoutent-elles une propriété aux prototypes du widget ? (même passe que l'essai 22) ---
  {
    const c = phases.canaux;
    const titre = 'Données hostiles : pollution des prototypes (__proto__, constructor)';
    if (c) {
      const niveau = c.niveau;
      const o = c.obs;
      const k = o?.pollution ?? null;
      if (!o?.charge) essais.push(essai(3, titre, 'non_teste', `le widget n'a pas été chargé pour cet essai (${resume(o?.erreur)})`, { niveau }));
      else if (!k || k.erreur) essais.push(essai(3, titre, 'non_teste', `${k?.erreur ? `le contrôle des prototypes n'a pas pu être joué dans le cadre du widget (${resume(k.erreur, 150)})` : "les lignes hostiles n'ont pas pu être ajoutées au document de test"}`, { niveau }));
      else if (k.polluees?.length) {
        essais.push(essai(3, titre, 'reussi', `des données de cellule ont ajouté une propriété à Object.prototype dans le widget : ${k.polluees.join(', ')}`, { niveau, regle: 'D-REEL-03', severite: 'majeur', polluees: k.polluees }));
        constats.push(constat({
          regle: 'D-REEL-03', axe: 'D', severite: 'majeur', bloquant: false, confiance: 'prouve',
          titre: "Des données de cellule modifient les prototypes du widget (pollution de prototype)",
          constat: `Le document de test contenait des lignes dont le texte est un JSON piégé (\`__proto__\`, \`constructor.prototype\`) ou un chemin \`__proto__.clé\`. Après leur réception par le widget chargé dans un vrai Grist (niveau « ${niveau} »), \`Object.prototype\` portait une propriété qui ne peut venir que de ces données : ${k.polluees.join(', ')}.`,
          impact: "Quiconque peut écrire une cellule du document peut ajouter des propriétés à tous les objets du widget : cela ouvre la voie à un contournement de contrôles, à des erreurs en cascade ou, avec un bout de code du widget qui lit ces propriétés, à l'exécution de code (CWE-1321).",
          remediation: "Ne pas fusionner de JSON issu des cellules avec une fonction récursive maison ou une bibliothèque ancienne (lodash < 4.17.21, jQuery.extend profond < 3.4) ; ignorer les clés `__proto__`, `constructor` et `prototype` ; utiliser `Object.create(null)` ou une `Map` pour les tables de correspondance ; `Object.freeze(Object.prototype)` en dernier recours.",
          referentiels: ['CWE-1321', 'OWASP Top 10 A03:2021 — Injection'],
          preuve: { niveau, polluees: k.polluees },
        }));
      } else if (o.hostileRecu) {
        essais.push(essai(3, titre, 'rien_observe', `le widget a reçu les lignes hostiles (JSON avec __proto__ et constructor.prototype, chemin __proto__.clé, mots-clés dangereux) sans qu'une propriété soit ajoutée à Object.prototype`, { niveau }));
      } else {
        essais.push(essai(3, titre, 'non_teste', `les lignes hostiles n'ont pas atteint le widget au niveau « ${niveau} » (aucune donnée transmise, colonnes non liées, ou widget qui ne lit que la ligne sélectionnée) : le contrôle des prototypes ne prouve rien`, { niveau }));
      }
    }
  }

  // --- 4. Messages forgés : un cadre voisin sans droit fait-il agir le widget par postMessage ? (même passe que l'essai 22) ---
  {
    const c = phases.canaux;
    const titre = 'Messages forgés envoyés au widget par un cadre voisin';
    if (c) {
      const niveau = c.niveau;
      const o = c.obs;
      const m = o?.messages ?? null;
      const exec = m?.executions ?? 0;
      const requetes = m?.requetes ?? 0;
      if (!o?.charge) essais.push(essai(4, titre, 'non_teste', `le widget n'a pas été chargé pour cet essai (${resume(o?.erreur)})`, { niveau }));
      else if (!m || m.erreur) essais.push(essai(4, titre, 'non_teste', `le cadre voisin n'a pas pu envoyer ses messages${m?.erreur ? ` (${resume(m.erreur, 150)})` : ''}`, { niveau }));
      else if (exec > 0 || requetes > 0) {
        const effets = [exec > 0 ? `une charge HTML reçue dans un message s'est exécutée dans le widget (${exec} fois)` : null, requetes > 0 ? `le widget a appelé ${requetes} fois l'adresse donnée par un message` : null].filter(Boolean);
        essais.push(essai(4, titre, 'reussi', `un cadre voisin sans droit a fait agir le widget par postMessage : ${effets.join(' ; ')}`, { niveau, regle: 'D-REEL-04', severite: 'majeur', executions: exec, requetes }));
        constats.push(constat({
          regle: 'D-REEL-04', axe: 'D', severite: 'majeur', bloquant: false, confiance: 'prouve',
          titre: "Le widget obéit à des messages postMessage venus d'un cadre quelconque",
          constat: `Dans un vrai Grist (niveau « ${niveau} »), un cadre voisin à l'origine opaque (« null »), sans aucun droit, a envoyé au widget des messages sous quatre formes (texte brut, objet, objet imbriqué, JSON) et sous les noms de champs usuels. Effet : ${effets.join(' ; ')}. Le widget n'a donc vérifié ni l'origine ni la source des messages qu'il reçoit.`,
          impact: "N'importe quelle page qui encadre le widget, ou un autre widget de la même page Grist, peut y faire exécuter du code (XSS par message, CWE-79 et CWE-346) ou lui faire appeler une adresse de son choix, avec les droits d'accès du widget.",
          remediation: "Dans le gestionnaire du `message`, n'accepter que `event.source === window.parent`, vérifier `event.origin` contre l'origine de Grist, ne jamais écrire le contenu d'un message avec `innerHTML` (utiliser `textContent`) ni s'en servir comme adresse ; ou ne pas écouter `message` du tout : l'API Grist suffit.",
          referentiels: ['CWE-346', 'CWE-79', 'OWASP Top 10 A03:2021 — Injection'],
          preuve: { niveau, executions: exec, requetes },
        }));
      } else if ((m.forgeRecu ?? 0) > 0 && !m.cadreIllisible) {
        essais.push(essai(4, titre, 'rien_observe', `quatre formes de message forgé (texte brut, objet, objet imbriqué, JSON), reçues par le widget (${m.forgeRecu}), n'ont déclenché ni exécution de code ni appel réseau`, { niveau }));
      } else {
        essais.push(essai(4, titre, 'non_teste', m.cadreIllisible ? "le cadre du widget n'a pas pu être relu après l'envoi des messages" : "les messages forgés ne sont pas arrivés jusqu'au widget (aucun message d'origine « null » vu dans son cadre) : l'essai ne prouve rien", { niveau }));
      }
    }
  }

  // --- 17 et 18. Droits du navigateur donnés au cadre du widget (même passe que l'essai 22) ---
  {
    const c = phases.canaux;
    const titre17 = 'Dépendance piégée : écrire dans le presse-papier';
    const titre18 = 'Dépendance piégée : droits du navigateur donnés au cadre (caméra, micro, position…)';
    if (c) {
      const niveau = c.niveau;
      const o = c.obs;
      const d = o?.droits ?? null;
      const k = d?.cadre ?? null;
      const sautes = (raison) => { essais.push(essai(17, titre17, 'non_teste', raison, { niveau }), essai(18, titre18, 'non_teste', raison, { niveau })); };
      if (!o?.charge) sautes(`le widget n'a pas été chargé pour cet essai (${resume(o?.erreur)})`);
      else if (!d || d.erreur || !k || k.erreur) sautes(`le code d'essai n'a pas pu être joué dans le cadre du widget${d?.erreur || k?.erreur ? ` (${resume(d?.erreur ?? k?.erreur, 150)})` : ''}`);
      else {
        const politique = Array.isArray(k.politique) ? k.politique : null;
        const connues = new Set(Array.isArray(k.connues) ? k.connues : []);
        const allow = d.attributs?.allow ?? null;
        const delegation = allow ? `attribut allow du cadre posé par Grist : « ${resume(allow, 80)} »` : "aucun attribut allow sur le cadre";

        // 17. Écriture dans le presse-papier, après un vrai clic dans le widget
        {
          const ecr = k.ecriture ?? null;
          const refusPolitique = ecr?.ok === false && /permissions? policy/i.test(ecr.erreur ?? '');
          const nonDelegue = !!politique && connues.has('clipboard-write') && !politique.includes('clipboard-write');
          const etapes = [
            { etape: `Grist délègue l'écriture du presse-papier au cadre (${delegation})`, ok: !!politique?.includes('clipboard-write') },
            { etape: 'clic réel dans le widget, reçu par le cadre', ok: !!d.clic && !!k.activation },
            { etape: "le cadre écrit un texte de test dans le presse-papier", ok: ecr?.ok === true, ...(ecr?.ok === false ? { barriere: resume(ecr.erreur, 120) } : {}) },
            { etape: 'la page Grist relit ce texte dans le presse-papier', ok: d.relu === 'attendu' },
          ];
          if (ecr?.ok && d.relu === 'attendu') {
            essais.push(essai(17, titre17, 'reussi', `après un clic dans le widget, le code d'essai joué dans le cadre a remplacé le contenu du presse-papier par un texte de test (relu depuis la page Grist)`, { niveau, regle: 'D-REEL-17', severite: 'info', nature: 'rayon', etapes }));
            constats.push(constat({
              regle: 'D-REEL-17', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
              titre: "Du code étranger dans le widget pourrait remplacer le contenu du presse-papier de la personne",
              constat: `Dans un vrai Grist (Grist Desktop, instance jetable), le cadre du widget a reçu de Grist le droit d'écrire dans le presse-papier (${delegation}). Après un clic de l'audit dans le widget, le code d'essai y a écrit un texte de test, que l'audit a relu depuis la page Grist. Le navigateur de l'audit accorde l'écriture au presse-papier à la page Grist, comme un Chrome ordinaire pour l'onglet actif.`,
              impact: "Une bibliothèque compromise pourrait, au prochain clic de la personne dans le widget, remplacer ce qu'elle a copié par un texte de son choix (une commande à coller dans un terminal, une adresse de virement). Ce droit est donné par Grist à tous les widgets : mesure d'un rayon d'action, sans pénalité de plus.",
              remediation: "Rien à changer dans le widget lui-même : c'est la délégation de Grist. La parade est de ne pas faire exécuter de code étranger au widget (bibliothèques embarquées dans le dépôt ou figées par empreinte) ; côté personne, relire avant de coller ce qui a été copié depuis un widget.",
              referentiels: ['OWASP Top 10 A08:2021 — Software and Data Integrity Failures', 'CWE-1021'],
              preuve: { niveau, etapes },
            }));
          } else if (refusPolitique || nonDelegue) {
            essais.push(essai(17, titre17, 'bloque', `le navigateur a refusé au cadre d'écrire dans le presse-papier : Grist ne lui en délègue pas le droit (${delegation})`, { niveau, barriere: "politique d'autorisations du navigateur (Grist ne délègue pas l'écriture au cadre)", etapes }));
          } else {
            const raison = !d.pageRelit ? "le presse-papier du navigateur de l'audit n'a pas pu être relu depuis la page Grist"
              : (!d.clic ? "le cadre du widget est trop petit pour y faire un clic" : (!k.activation ? "le clic de l'audit n'a pas été reçu par le widget" : (ecr?.ok === false ? `l'écriture a échoué sans que la politique l'explique (${resume(ecr.erreur, 150)})` : "le texte écrit n'a pas été retrouvé dans le presse-papier")));
            essais.push(essai(17, titre17, 'non_teste', raison, { niveau, etapes }));
          }
        }

        // 18. Autres droits sensibles : la politique d'autorisations appliquée au cadre, lue dans le cadre
        {
          const SENSIBLES = [['camera', 'caméra'], ['microphone', 'micro'], ['geolocation', 'position'], ['display-capture', "partage d'écran"], ['fullscreen', 'plein écran'], ['payment', 'paiement'], ['usb', 'USB'], ['serial', 'port série'], ['hid', 'périphériques HID'], ['bluetooth', 'Bluetooth'], ['midi', 'MIDI'], ['clipboard-read', 'lecture du presse-papier'], ['web-share', 'partage système'], ['publickey-credentials-get', 'clés d\'accès (passkeys)'], ['otp-credentials', 'codes à usage unique'], ['identity-credentials-get', "identité fédérée"], ['screen-wake-lock', "maintien de l'écran allumé"], ['accelerometer', 'accéléromètre'], ['gyroscope', 'gyroscope'], ['magnetometer', 'magnétomètre'], ['window-management', 'gestion des fenêtres'], ['local-fonts', 'polices locales']];
          const connus = SENSIBLES.filter(([f]) => connues.has(f));
          if (!politique || connus.length < 8) essais.push(essai(18, titre18, 'non_teste', politique ? `ce Chromium ne connaît que ${connus.length} des ${SENSIBLES.length} droits sensibles à vérifier : la mesure n'est pas fiable` : "la politique d'autorisations du cadre n'a pas pu être lue (API absente)", { niveau }));
          else {
            const ouverts = connus.filter(([f]) => politique.includes(f));
            const etapes = connus.map(([f, l]) => ({ etape: `${l} (${f})`, ok: politique.includes(f), ...(politique.includes(f) ? {} : { barriere: "politique d'autorisations du navigateur" }) }));
            if (ouverts.length) {
              const noms = ouverts.map(([, l]) => l);
              essais.push(essai(18, titre18, 'reussi', `le cadre du widget peut demander à la personne : ${noms.join(', ')} (${delegation})`, { niveau, regle: 'D-REEL-18', severite: 'info', nature: 'rayon', etapes, ouverts: noms }));
              constats.push(constat({
                regle: 'D-REEL-18', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
                titre: `Du code étranger dans le widget pourrait demander l'accès à : ${noms.join(', ')}`,
                constat: `La politique d'autorisations que le navigateur applique au cadre du widget dans un vrai Grist (${delegation}) laisse le cadre demander : ${noms.join(', ')}. La personne verrait alors une demande d'autorisation du navigateur, au nom de Grist.`,
                impact: "Une bibliothèque compromise pourrait profiter de la confiance que la personne accorde à Grist pour obtenir ces autorisations. Mesure d'un rayon d'action, sans pénalité de plus.",
                remediation: "Rien à changer dans le widget : c'est la délégation de Grist. Signaler à l'éditeur de Grist que cette délégation dépasse le besoin des widgets ; ne pas faire exécuter de code étranger au widget.",
                referentiels: ['Principe du moindre privilège', 'OWASP Top 10 A05:2021 — Security Misconfiguration'],
                preuve: { niveau, ouverts: noms },
              }));
            } else {
              essais.push(essai(18, titre18, 'bloque', `la politique d'autorisations du navigateur n'a donné au cadre aucun des ${connus.length} droits sensibles vérifiés (caméra, micro, position, partage d'écran, USB, paiement…) : ${delegation}`, { niveau, barriere: "politique d'autorisations du navigateur (délégation de Grist limitée à l'écriture du presse-papier)", etapes }));
            }
          }
        }
      }
    }
  }

  // --- 23. Stockage dans le navigateur : des données du document gardées après la fermeture du document ? ---
  {
    const d = phases.demande;
    const titre = 'Stockage dans le navigateur : le widget garde-t-il des données du document ?';
    if (d) {
      const niveau = d.niveau;
      const o = d.obs;
      const s = o?.stockage ?? null;
      if (!o?.charge) essais.push(essai(23, titre, 'non_teste', `le widget n'a pas été chargé pour cet essai (${resume(o?.erreur)})`, { niveau }));
      else if (!s || s.erreur) essais.push(essai(23, titre, 'non_teste', `le contenu du stockage du navigateur n'a pas pu être lu dans le cadre du widget${s?.erreur ? ` (${resume(s.erreur, 150)})` : ''}`, { niveau }));
      else {
        const cookies = s.cookies ?? [];
        const lieux = [['localStorage', s.local, s.local?.nombre], ['sessionStorage', s.session, s.session?.nombre], ['IndexedDB', s.indexedDB, s.indexedDB?.nombre], ['cookie', { canari: cookies.some((c) => c.canari) }, cookies.length]];
        const gardes = lieux.filter(([, x]) => x?.canari).map(([nom]) => nom);
        const usage = lieux.filter(([, , n]) => n > 0).map(([nom, , n]) => `${nom} (${n})`);
        const illisibles = [s.local, s.session, s.indexedDB].filter((x) => x?.erreur || x?.indisponible).length;
        const etapes = lieux.map(([nom, x, n]) => ({ etape: `${nom} : données du document retrouvées`, ok: !!x?.canari, ...(x?.canari ? {} : { barriere: n > 0 ? `${n} entrée(s), aucune donnée du document` : 'vide' }) }));
        const cookiesTexte = cookies.length ? ` Cookies de l'origine du widget : ${cookies.slice(0, 5).map((c) => c.nom).join(', ')}${cookies.length > 5 ? '…' : ''}.` : '';
        if (gardes.length) {
          essais.push(essai(23, titre, 'reussi', `le widget a gardé des données du document dans le navigateur : ${gardes.join(', ')}`, { niveau, regle: 'D-REEL-23', severite: 'mineur', etapes, gardes }));
          constats.push(constat({
            regle: 'D-REEL-23', axe: 'D', severite: 'mineur', bloquant: false, confiance: 'prouve',
            titre: `Le widget garde des données du document dans le navigateur (${gardes.join(', ')})`,
            constat: `Dans un vrai Grist (Grist Desktop, instance jetable), au niveau d'accès « ${niveau} », des valeurs du document de test (canaris et valeurs ordinaires) ont été retrouvées dans : ${gardes.join(', ')}. Elles y restent après la fermeture du document.${cookiesTexte}`,
            impact: "Des données du document, parfois personnelles, survivent dans le navigateur de la personne, hors de Grist, sans que le document ni ses règles d'accès les gouvernent. Tout code qui s'exécute sur la même origine peut les lire : les autres widgets du même hébergeur, une bibliothèque compromise (essais 8 à 10). Question de conservation des données (RGPD) autant que de sécurité.",
            remediation: "Ne rien écrire dans le stockage du navigateur ; si un cache est nécessaire, y garder des réglages, jamais des données du document, et l'effacer à la fermeture (`sessionStorage` plutôt que `localStorage`). Héberger le widget sur une origine qui lui soit propre.",
            referentiels: ['RGPD art. 5 (limitation de la conservation, minimisation)', 'CWE-922'],
            preuve: { niveau, gardes, usage },
          }));
        } else if (!o.canariRecu) {
          essais.push(essai(23, titre, 'non_teste', `aucune donnée du document n'est arrivée au widget au niveau « ${niveau} » : une conservation ne pouvait ni se produire ni être mesurée${usage.length ? `. Stockage utilisé : ${usage.join(', ')}` : ''}`, { niveau, etapes }));
        } else if (illisibles >= 3) {
          essais.push(essai(23, titre, 'non_teste', "le stockage du navigateur n'a pas pu être lu dans le cadre du widget (localStorage, sessionStorage et IndexedDB inaccessibles)", { niveau, etapes }));
        } else {
          essais.push(essai(23, titre, 'rien_observe', `aucune donnée du document n'a été retrouvée dans le stockage du navigateur du widget${usage.length ? ` (stockage utilisé : ${usage.join(', ')})` : ' (stockage vide)'}.${cookiesTexte}`, { niveau, etapes, usage }));
        }
      }
    }
  }

  // --- 24. Écritures du widget lui-même, au chargement, sans que personne n'ait rien fait (le journal des appels à Grist le dit) ---
  {
    const d = phases.demande;
    const titre = 'Le widget écrit-il dans le document sans qu\'on le lui demande ?';
    if (d) {
      const niveau = d.niveau;
      const o = d.obs;
      if (!o?.charge) essais.push(essai(24, titre, 'non_teste', `le widget n'a pas été chargé pour cet essai (${resume(o?.erreur)})`, { niveau }));
      else if (!o.appelsRpc?.length) essais.push(essai(24, titre, 'non_teste', "le widget n'a rien échangé avec Grist pendant l'essai : ses écritures éventuelles n'ont pas pu être vues", { niveau }));
      else {
        const ecritures = o.appelsRpc.filter((a) => a.methode === 'applyUserActions' && /GristDocAPI/.test(a.interface ?? ''));
        const acceptees = ecritures.filter((a) => a.issue === 'accepte');
        const refusees = ecritures.filter((a) => a.issue === 'refuse');
        const actions = [...new Set(acceptees.flatMap((a) => [...String(a.args ?? '').matchAll(/\["([A-Z][A-Za-z]+)",/g)].map((m) => m[1])))].slice(0, 6);
        if (acceptees.length) {
          essais.push(essai(24, titre, 'reussi', `le widget a écrit dans le document dès son chargement, sans clic ni saisie : ${acceptees.length} appel(s) accepté(s) par Grist${actions.length ? ` (${actions.join(', ')})` : ''}`, { niveau, regle: 'D-REEL-24', severite: 'info', nature: 'comportement', appels: acceptees.length, actions }));
          constats.push(constat({
            regle: 'D-REEL-24', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
            titre: "Le widget modifie le document dès son chargement, sans action de la personne",
            constat: `Dans un vrai Grist (Grist Desktop, instance jetable), au niveau d'accès « ${niveau} », le widget a appelé \`applyUserActions\` ${acceptees.length} fois pendant son chargement${actions.length ? ` (${actions.join(', ')})` : ''}, sans que l'audit clique ni saisisse quoi que ce soit ; Grist a accepté ces écritures.`,
            impact: "Un widget qui écrit tout seul modifie des données que la personne n'a pas touchées (et remplit l'historique du document). Parfois voulu (initialiser une colonne), parfois une boucle ou une erreur. Information sur le comportement, sans pénalité.",
            remediation: "N'écrire que sur une action de la personne (clic, saisie) ; si une initialisation est nécessaire, la documenter et la faire une seule fois, en vérifiant que la donnée n'existe pas déjà.",
            referentiels: ['Principe de moindre surprise'],
            preuve: { niveau, appels: acceptees.length, actions, exemple: String(acceptees[0].args ?? '').slice(0, 200) },
          }));
        } else {
          essais.push(essai(24, titre, 'rien_observe', `le widget n'a écrit dans le document à aucun moment de son chargement${refusees.length ? ` (${refusees.length} tentative(s) d'écriture refusée(s) par Grist au niveau « ${niveau} »)` : ''}`, { niveau }));
        }
      }
    }
  }

  // --- 10. Écritures : ce que du code étranger dans le widget pourrait changer dans le document (effets relus côté serveur, jamais crus sur parole) ---
  {
    const w = phases.ecritures;
    const titre = 'Dépendance piégée : écritures dans le document';
    if (w) {
      const niveau = w.niveau;
      const k = w.obs?.ecritures ?? null;
      const s = w.serveur ?? null;
      const EFFETS = [['ajout', 'ajouter des lignes'], ['renom', 'renommer une colonne'], ['colonne', 'supprimer une colonne'], ['table', 'supprimer une table'], ['regle', "créer une règle d'accès"]];
      const refusDe = (cle) => (k?.[cle]?.ok === false ? String(k[cle].erreur ?? '') : '');
      const refuse = (cle) => /access not granted/i.test(refusDe(cle));
      if (!w.obs?.charge) essais.push(essai(10, titre, 'non_teste', `le widget n'a pas été chargé pour cet essai (${resume(w.obs?.erreur)})`, { niveau }));
      else if (!s || s.erreur) essais.push(essai(10, titre, 'non_teste', `l'état du document n'a pas pu être relu après l'essai${s?.erreur ? ` (${resume(s.erreur, 150)})` : ''}`, { niveau }));
      else {
        const etapes = EFFETS.map(([cle, libelle]) => ({ etape: libelle, ok: !!s[cle], ...(s[cle] ? {} : { barriere: refuse(cle) ? `refus de Grist au niveau « ${niveau} »` : (refusDe(cle) ? resume(refusDe(cle), 120) : 'aucun changement constaté dans le document') }) }));
        const faits = EFFETS.filter(([cle]) => s[cle]).map(([, libelle]) => libelle);
        if (faits.length) {
          essais.push(essai(10, titre, 'reussi', `avec le niveau « ${niveau} », le code d'essai joué dans le widget a pu, d'après le document relu côté serveur : ${faits.join(' ; ')}`, { niveau, regle: 'D-REEL-10', severite: 'info', nature: 'rayon', etapes, faits }));
          constats.push(constat({
            regle: 'D-REEL-10', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
            titre: `Avec le niveau « ${niveau} », du code étranger dans le widget pourrait modifier le document (${faits.join(', ')})`,
            constat: `Du code exécuté dans le cadre du widget, comme le ferait une bibliothèque piégée, chargé par un vrai Grist (Grist Desktop, instance jetable) au niveau d'accès « ${niveau} », a pu : ${faits.join(' ; ')}. L'audit a relu le document de test côté serveur : ces effets y sont. Les essais visent des tables créées pour l'audit, jamais le document du widget.`,
            impact: "Une bibliothèque compromise pourrait, avec le niveau accordé au widget, supprimer des tables, détruire des colonnes et modifier les règles d'accès du document (les fermer ou les ouvrir). Le niveau demandé est déjà pesé par C-GRIST-03 : cette mesure n'ajoute pas de pénalité. La reprise après de tels effets dépend de l'historique et des sauvegardes du document : elle n'est pas mesurée ici.",
            remediation: "Ne demander que le niveau nécessaire (`read table` si le widget ne fait que lire) ; si `full` est indispensable, figer les bibliothèques (version et empreinte) ou les embarquer dans le dépôt, et sauvegarder régulièrement le document.",
            referentiels: ['Principe du moindre privilège', 'OWASP Top 10 A08:2021 — Software and Data Integrity Failures'],
            preuve: { niveau, etapes },
          }));
        } else if (k && !k.erreur && EFFETS.every(([cle]) => refuse(cle))) {
          essais.push(essai(10, titre, 'bloque', `Grist a refusé au niveau « ${niveau} » toute écriture du code d'essai (ajout, renommage, suppression, règle d'accès) : le document n'a pas changé`, { niveau, barriere: "Grist (niveau d'accès)", etapes }));
        } else essais.push(essai(10, titre, 'non_teste', `aucun changement dans le document, et Grist n'a pas signalé de refus pour chaque écriture${k?.erreur ? ` (${resume(k.erreur, 120)})` : ''} : l'essai ne prouve rien`, { niveau, etapes }));
      }
    }
  }

  // Des bibliothèques du widget n'ont pas pu être chargées (adresse calculée à l'exécution, refus de l'outil, hors ligne) : leur code n'a pas été joué.
  // Un « rien observé » ne prouverait alors rien, il devient « non testé » (un effet observé, ou une barrière, reste vrai).
  const manquantes = [...new Map(chargees.flatMap((o) => o.dependancesNonResolues ?? []).map((d) => [d.url, d])).values()];
  if (manquantes.length) {
    const hotes = [...new Set(manquantes.map((d) => d.hote).filter(Boolean))].slice(0, 3).join(', ');
    essais.forEach((e, i) => {
      if (e.resultat !== 'rien_observe') return;
      essais[i] = essai(e.id, e.titre, 'non_teste', `${manquantes.length} bibliothèque(s) du widget n'ont pas pu être chargées pendant l'essai (${hotes}) : leur code n'a pas été joué, « rien observé » ne prouverait rien`, { ...(e.niveau ? { niveau: e.niveau } : {}), bibliothequesManquantes: manquantes.length });
    });
  }

  essais.sort((a, b) => a.id - b.id);
  return { essais, constats, niveauDemande };
}

/** Constat d'information quand le mode « Grist réel » n'a pas pu s'exécuter : jamais une note meilleure, jamais « rien trouvé ». */
export function constatIndisponible(cause) {
  return constat({
    regle: 'D-REEL-INDISPONIBLE', axe: 'D', severite: 'info', confiance: 'certain',
    titre: 'Essais contre un Grist réel non exécutés',
    constat: `Le mode --grist-reel n'a pas pu s'exécuter : ${resume(cause, 500)}`,
    impact: "Les essais contre un vrai Grist (XSS avec le niveau d'accès réel, sorties de données mesurées par canaris, navigation et fenêtres) sont absents de ce rapport. Ce n'est pas une absence de risque, c'est une absence de mesure ; les constats de l'axe D joués contre le faux hôte de test restent valables.",
    remediation: 'Traiter la cause indiquée, puis relancer avec --grist-reel.',
    mesurePartielle: true,
  });
}
