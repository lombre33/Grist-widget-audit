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
 * Les essais 8, 9 et 12 sont ceux de la « dépendance piégée » : du code étranger joué DANS le cadre du widget (voir kit.js) montre ce
 * qu'une bibliothèque compromise obtiendrait avec le niveau d'accès réellement accordé. Ils mesurent un rayon d'action, pas un défaut
 * prouvé du widget : leurs constats sont d'information (sans effet sur la note ; le niveau demandé est déjà pesé par C-GRIST-03),
 * sauf une persistance obtenue (webhook créé), qui est un constat majeur.
 */
import { constat } from '../../moteur/modele.js';
import { HOTE_PUITS } from './donnees.js';

export const ESSAIS_JOUES = [1, 7, 8, 9, 12, 13, 15, 16];
export const ESSAIS_PAS_ENCORE = '2 à 6, 10, 11, 14, 17 à 20';

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
