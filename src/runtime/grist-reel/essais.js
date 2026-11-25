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
 * Numéros : ceux du catalogue de l'étude (essai 1 = XSS, 7 = niveau none, 13 = exfiltration mesurée,
 * 15 = navigation du cadre parent, 16 = fenêtres).
 */
import { constat } from '../../moteur/modele.js';
import { HOTE_PUITS } from './donnees.js';

export const ESSAIS_JOUES = [1, 7, 13, 15, 16];
export const ESSAIS_PAS_ENCORE = '2 à 6, 8 à 12, 14, 17 à 20';

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
        essais.push(essai(1, titre, 'reussi', `la charge s'est exécutée, a lu la table appât avec le niveau « ${d.niveau} »${sortie ? ' et l\'a envoyée à l\'extérieur' : ' (sortie non observée)'}`, { niveau: d.niveau, regle: 'D-REEL-01', etapes }));
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
        essais.push(essai(1, titre, 'reussi', `la charge s'est exécutée ; la lecture hors table a été arrêtée (${etapes[1].barriere})`, { niveau: d.niveau, regle: 'D-REEL-01', etapes }));
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
      essais.push(essai(7, titre, 'reussi', "des données du document sont arrivées au widget alors qu'il était limité à « none » (défaut de Grist, pas du widget)", { niveau: 'none', regle: 'D-REEL-07' }));
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
        essais.push(essai(13, titre, 'reussi', `une valeur du document a été trouvée dans une requête vers ${hotes.join(', ')}`, { regle: 'D-REEL-13' }));
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
        essais.push(essai(13, titre, 'rien_observe', `${sorties.length} requête(s) sortante(s) neutralisée(s) (${[...new Set(sorties.map((r) => r.hote))].slice(0, 4).join(', ')}) ; aucun canari ni valeur du document trouvé en clair dans leur adresse ou leur corps (hors encodage particulier)`));
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
      essais.push(essai(15, titre, 'reussi', `la page Grist a été redirigée vers ${resume(navs[0].url, 120)}`, { regle: 'D-REEL-15' }));
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
      essais.push(essai(16, titre, 'reussi', liste, { regle: 'D-REEL-16' }));
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
