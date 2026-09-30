/**
 * Ce que l'outil n'a pas pu lire ou parcourir : un plafond atteint, un fichier de code qu'il n'a pas lu.
 *
 * Un audit qui ne dit pas ce qu'il n'a pas vu se lit comme un audit qui n'a rien trouvé. Chaque plafond de
 * l'inventaire (nombre de fichiers, octets lus, entrées de dossier listées, résolutions d'adresse, arêtes de
 * document) et chaque fichier de code que la page atteint sans que l'outil le lise (trop gros, plafond cumulé
 * atteint, lecture refusée, extension de binaire que la page charge comme du code) est donc un constat critique
 * et BLOQUANT, qui dit lequel et pourquoi, et qui empêche les axes que ce qui n'a pas été lu aurait nourris
 * (`axesEmpeches` : ils sont notés 0, `noter()` dit ce qu'ils valent sur ce qui a pu être lu). Un widget qui
 * s'arrange pour que l'outil ne le lise pas ne note jamais mieux que s'il s'était laissé lire. Un fichier non
 * lu que la page n'atteint pas (des données, du code qu'aucune page ne charge) est dit, sans bloquer : il
 * n'est pas exécuté par ce que l'outil a suivi.
 *
 * Ce passage tourne APRÈS toutes les règles (`analyseStatique`) : le budget des arêtes de document ne se sait
 * épuisé qu'une fois les graphes de document demandés par l'axe E.
 */
import { constat } from '../moteur/modele.js';
import { cheminVendorise } from '../contexte/inventaire.js';

/** Les fichiers non lus dits un à un ; au-delà, un seul constat les regroupe (ils sont tous dans sa preuve). */
export const MAX_FICHIERS_DITS = 50;

export const TOUS_LES_AXES_STATIQUES = ['A', 'B', 'C', 'E', 'F'];
/**
 * Ce que tout code exécuté alimente, le sien ou celui d'un tiers : injection (C), chargements distants (E), hôtes contactés
 * (F), et la documentation de ces hôtes et de l'accès demandé (B-DOC-03 et B-DOC-04 lisent ce que C a relevé sur tout le code
 * exécuté). Seul l'axe A ne juge que le code du contributeur.
 */
const AXES_DU_CODE_EXECUTE = ['B', 'C', 'E', 'F'];

export const nombre = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
/** Une taille à l'unité qui la rend lisible (un plafond abaissé pour un essai tient en octets). */
const mio = (octets) => {
  if (octets >= 1024 * 1024) return `${(octets / 1024 / 1024).toFixed(1).replace('.', ',')} Mio`;
  if (octets >= 1024) return `${(octets / 1024).toFixed(1).replace('.', ',')} Kio`;
  return `${octets} octets`;
};

/**
 * Chaque plafond d'inventaire, dans l'ordre où `raisonsDeTroncature` les dit : ce que l'outil s'est interdit et
 * pourquoi ce n'est pas une raison d'absoudre. `p` : les valeurs du plafond (`ctx.tronque`), lues telles quelles.
 */
const PLAFONDS = [
  {
    drapeau: 'fichiers',
    titre: (t) => `Plus de ${nombre(t.maxFichiers)} fichiers dans le dépôt : l'inventaire s'est arrêté`,
    constat: (t) => `Le dépôt compte plus de ${nombre(t.maxFichiers)} fichiers, le plafond de l'outil. Les fichiers au-delà n'ont été ni inventoriés, ni lus, ni audités, par aucun axe.`,
    impact: "Un widget n'a pas de raison de contenir autant de fichiers : c'est la forme d'un dépôt qui embarque ses dépendances ou ses données, ou d'un dépôt construit pour que l'outil n'arrive pas au code qui compte. Ce qui n'a pas été lu peut contenir ce que les règles cherchent.",
    remediation: "Retirer du dépôt ce que le widget ne charge pas (dépendances versionnées, données, sorties de build), ou n'auditer que le dossier qui contient le widget.",
  },
  {
    drapeau: 'octets',
    titre: (t) => `Plus de ${Math.round(t.maxOctets / 1024 / 1024)} Mio de contenu lu : l'inventaire s'est arrêté`,
    constat: (t) => `L'outil a lu ${Math.round(t.maxOctets / 1024 / 1024)} Mio de fichiers texte, son plafond, et a cessé de lire. Les fichiers qui ont suivi ne l'ont pas été (chacun est nommé dans un constat C-SURFACE-02).`,
    impact: "Un volume de texte de cet ordre n'a pas de raison d'être dans un widget. Ce qui n'a pas été lu peut contenir ce que les règles cherchent, et le dépôt ne peut pas être déclaré conforme sur ce qu'on n'a pas vu.",
    remediation: "Retirer du dépôt les fichiers volumineux que le widget ne charge pas, ou découper ceux qu'il charge (le code du widget d'un côté, les bibliothèques de l'autre).",
  },
  {
    drapeau: 'listage',
    titre: (t) => `Plus de ${nombre(t.maxEntreesListees)} entrées lues dans les dossiers exclus : des modules n'ont pas été cherchés`,
    constat: (t) => `Pour suivre une adresse d'import map ou un import() à début fixe, l'outil liste les dossiers que l'inventaire n'explore pas (node_modules, dist, vendor…) ; il s'est arrêté à ${nombre(t.maxEntreesListees)} entrées. Des modules que la page peut charger depuis ces dossiers n'ont pas été cherchés, donc pas lus.`,
    impact: "Un module que la page charge et que l'outil n'a pas cherché est du code exécuté que personne n'a lu.",
    remediation: "Réduire ces dossiers, ou remplacer l'adresse à préfixe (`\"lib/\": \"./libs/\"`, `import('./locales/' + langue)`) par des adresses de fichier écrites en clair.",
  },
  {
    drapeau: 'surface',
    titre: (t) => `Plus de ${nombre(t.maxResolutions)} résolutions d'adresses de worker : la surface exécutée n'est pas complète`,
    constat: (t) => `L'outil a fait ${nombre(t.maxResolutions)} résolutions d'adresses de worker sous les pages d'entrée, son plafond : la liste des fichiers que le navigateur exécute s'arrête là, et des fichiers qu'il charge n'y figurent pas.`,
    impact: "Un fichier que le navigateur exécute et que la surface n'inclut pas n'est lu par aucune règle de sécurité.",
    remediation: "Réduire le nombre de pages d'entrée ou d'adresses de worker calculées, ou les écrire en clair.",
  },
  {
    drapeau: 'documents',
    titre: (t) => `Plus de ${nombre(t.maxPasDocuments)} pas d'analyse de document : ni l'ordre de chargement ni les noms que le code importe ne sont établis pour toutes les pages`,
    constat: (t) => `L'outil a parcouru ${nombre(t.maxPasDocuments)} arêtes de documents (les fichiers qu'une page charge, dans l'ordre des balises, et les noms que le code importe, résolus par les cartes d'import), son plafond : pour les pages suivantes, il n'a pas établi quelle carte d'import précède quel script, donc si une empreinte d'intégrité protège ce que la page charge, ni quels fichiers les noms importés désignent, donc quel code la page exécute.`,
    impact: "Une empreinte d'import map ne protège que les chargements qui commencent après la carte : sans l'ordre, l'outil ne peut pas dire si du code distant est protégé. Un nom que la carte résout en un fichier en fait du code exécuté : sans la résolution, l'outil ne sait pas quel fichier l'est.",
    remediation: "Réduire le nombre de pages d'entrée et de fichiers qu'elles chargent.",
  },
];

/** Les causes d'un fichier non lu : le constat, l'impact et la remédiation qui lui conviennent. */
const CAUSES = {
  taille: {
    constat: (n, p) => `Ce fichier fait ${mio(n.taille)} ; l'outil ne lit pas un fichier de plus de ${mio(p.octetsFichier)}. Aucune règle ne l'a examiné : ni injection, ni sortie réseau, ni secret, ni dépendance, ni conformité.`,
    remediation: "Découper le paquet (le code du widget d'un côté, les bibliothèques tierces de l'autre, chacun lisible) ou publier les sources non minifiées.",
  },
  cumul: {
    constat: (n, p) => `L'outil avait déjà lu ${mio(p.octets)} de fichiers texte, son plafond, quand il est arrivé à ce fichier (${mio(n.taille)}) : il ne l'a pas lu.`,
    remediation: "Retirer du dépôt les fichiers volumineux que le widget ne charge pas, ou découper ceux qu'il charge.",
  },
  lecture: {
    constat: () => "Le système de fichiers a refusé la lecture de ce fichier : l'outil n'en connaît pas le contenu.",
    remediation: 'Rendre le fichier lisible (droits d\'accès) et relancer l\'audit.',
  },
  extension: {
    constat: (n) => `Ce fichier porte une extension de fichier non textuel (\`${n.chemin.slice(n.chemin.lastIndexOf('.'))}\`) mais la page le charge comme du code (balise script, import, worker ou carte d'import) : l'outil ne lit pas les fichiers de cette extension. Si son contenu est du JavaScript, le navigateur l'exécute selon le type que l'hébergement lui donne, sans que personne ne l'ait lu.`,
    remediation: "Donner au fichier l'extension de ce qu'il est (`.js`), ou ne pas le charger comme du code.",
  },
};

const IMPACT_NON_LU = "Un fichier que personne n'a lu peut contenir n'importe quoi, y compris ce que les règles cherchent : un audit qui ne peut pas le lire ne peut pas le déclarer conforme.";

/**
 * Les axes qu'un fichier de code non lu empêche : B, C, E et F lisent tout code que la page exécute (injection, chargements
 * distants, hôtes contactés et leur documentation) ; A juge le code que le contributeur a écrit, donc pas celui d'un dossier
 * exclu ni d'un chemin de bibliothèque tierce (les mêmes critères que l'inventaire applique à un fichier lu).
 */
export function axesDUnFichierNonLu(n) {
  return !n.dossierExclu && !cheminVendorise(n.chemin) ? TOUS_LES_AXES_STATIQUES : AXES_DU_CODE_EXECUTE;
}

export function analyserSurface(ctx) {
  const constats = [];
  const t = ctx.tronque ?? null;
  if (t) {
    for (const p of PLAFONDS) {
      if (!t[p.drapeau]) continue;
      constats.push(constat({
        regle: 'C-SURFACE-01', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
        titre: p.titre(t), constat: p.constat(t), impact: p.impact, remediation: p.remediation,
        axesEmpeches: TOUS_LES_AXES_STATIQUES,
        preuve: { plafond: p.drapeau },
      }));
    }
  }

  const plafonds = ctx.plafonds ?? {};
  const nonLus = [...(ctx.nonLus ?? [])].sort((a, b) => b.taille - a.taille || (a.chemin < b.chemin ? -1 : 1));
  // Du code que la surface de chargement atteint : c'est lui que le navigateur exécute sans que personne l'ait lu. Un fichier de
  // code qu'aucune page n'atteint n'est pas exécuté par ce que l'outil a suivi : il est dit, comme les données, sans bloquer.
  const code = nonLus.filter((n) => n.code && n.atteint);
  const hors = nonLus.filter((n) => !(n.code && n.atteint));

  for (const n of code.slice(0, MAX_FICHIERS_DITS)) {
    const cause = CAUSES[n.cause];
    constats.push(constat({
      regle: 'C-SURFACE-02', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain', titre: n.taille ? `Fichier de code non lu (${mio(n.taille)})` : 'Fichier de code non lu',
      fichier: n.chemin,
      constat: cause.constat(n, plafonds),
      impact: IMPACT_NON_LU,
      remediation: cause.remediation,
      axesEmpeches: axesDUnFichierNonLu(n),
      preuve: { cause: n.cause, taille: n.taille, commeCode: n.commeCode },
    }));
  }
  if (code.length > MAX_FICHIERS_DITS) {
    const reste = code.slice(MAX_FICHIERS_DITS);
    const axes = ['A', 'B', 'C', 'E', 'F'].filter((a) => reste.some((n) => axesDUnFichierNonLu(n).includes(a)));
    constats.push(constat({
      regle: 'C-SURFACE-02', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain', titre: reste.length === 1 ? '1 autre fichier de code non lu' : `${nombre(reste.length)} autres fichiers de code non lus`,
      constat: `${nombre(code.length)} fichiers de code n'ont pas été lus ; les ${MAX_FICHIERS_DITS} plus gros sont dits un à un, ceux-ci sont les ${nombre(reste.length)} autres (leur liste, avec la cause et la taille de chacun, est dans la preuve du rapport JSON).`,
      impact: IMPACT_NON_LU,
      remediation: CAUSES.taille.remediation,
      axesEmpeches: axes,
      preuve: { emplacements: reste.map((n) => ({ fichier: n.chemin, cause: n.cause, taille: n.taille })) },
    }));
  }
  if (hors.length) {
    constats.push(constat({
      regle: 'C-SURFACE-02', axe: 'C', severite: 'info', confiance: 'certain', titre: `${nombre(hors.length)} fichier(s) non lus que le widget n'exécute pas`,
      constat: `${nombre(hors.length)} fichier(s) que l'outil n'a pas lus (taille au-delà de ${mio(plafonds.octetsFichier ?? 0)}, plafond cumulé ou lecture refusée) et qu'aucune page ne charge comme du code : des données, ou du code que la surface de chargement n'atteint pas : ${hors.slice(0, 5).map((n) => `${n.chemin} (${mio(n.taille)})`).join(', ')}${hors.length > 5 ? '…' : ''}. Les règles qui lisent tout le texte du dépôt (secrets, services externes) ne les ont pas vus.`,
      impact: "Un secret ou une adresse de service externe peut se trouver dans un fichier que personne n'a lu ; les pages que l'outil a suivies ne l'exécutent pas, le risque est celui d'une fuite, non d'une exécution. Si le widget le charge par une adresse que l'outil ne sait pas suivre, ce qu'il contient n'a été vu par aucune règle.",
      remediation: 'Retirer du dépôt les fichiers que le widget ne charge pas, ou les découper.',
      preuve: { emplacements: hors.map((n) => ({ fichier: n.chemin, cause: n.cause, taille: n.taille })) },
    }));
  }
  return constats;
}
