/**
 * Chaînes d'attaque (C-CHAINE-01 à 04) : relier des constats que l'audit a déjà faits en un scénario, pour dire par où un attaquant passerait.
 *
 * Un défaut seul se lit mal : un `innerHTML` dynamique est un majeur parmi d'autres ; le même `innerHTML`, dans un widget qui lit la table et qui appelle
 * l'extérieur, est un chemin complet de la donnée à la sortie. Cette passe ne mesure rien de plus : elle ne lit que les constats déjà produits (et le niveau
 * d'accès que le widget demande), et elle écrit une HYPOTHÈSE, jamais une preuve. L'enchaînement n'a pas été exécuté ; seules les étapes que l'axe D a observées
 * sont dites prouvées. Information, sans pénalité, jamais bloquante : chaque étape pèse déjà par son propre constat.
 *
 * Le texte ne reprend aucun texte du widget : l'étape est nommée par sa règle, son fichier et sa ligne (le fichier cité en extrait de code).
 */
import { constat } from './modele.js';
import { citer } from './texte-du-widget.js';

const INJECTION = new Set(['C-XSS-01', 'C-XSS-02', 'C-XSS-03', 'C-XSS-04', 'C-XSS-05', 'C-XSS-07', 'D-XSS-01']);
const SORTIE = new Set(['C-EXFIL-01', 'C-EXFIL-02', 'D-RESEAU-01']);
const REFERENTIELS = ['OWASP Top 10 A03:2021 — Injection', 'OWASP Top 10 A08:2021 — Software and Data Integrity Failures', 'ANSSI — Recommandations pour la sécurisation des sites web'];

/** Le niveau d'accès aux données que le widget demande, quand il en lit : `read table` ou `full` ; `null` sinon (même lecture que la CSP, C-CSP-0x). */
function accesDemande(ctx) {
  const niveaux = (ctx?.usagesGrist?.acces ?? []).map((a) => String(a.niveau).trim().toLowerCase());
  return niveaux.includes('full') ? 'full' : niveaux.includes('read table') ? 'read table' : null;
}

const premier = (constats, estDuRole) => constats.find((c) => c.severite !== 'info' && estDuRole(c));

/** Une étape : ce qu'elle est, la règle qui la dit, où, et si l'axe D l'a observée. */
const etape = (role, c) => ({ role, regle: c.regle, fichier: c.fichier ?? null, ligne: c.ligne ?? null, prouvee: c.confiance === 'prouve' });
const etapeAcces = (acces) => ({ role: `accès « ${acces} » demandé`, regle: null, fichier: null, ligne: null, prouvee: false });
const lieu = (e) => (e.fichier ? ` (${citer(`${e.fichier}${e.ligne ? `:${e.ligne}` : ''}`)})` : '');

/**
 * @param {Array} constats tous les constats de l'audit (statiques et dynamiques)
 * @param {object} [ctx] le contexte de l'inventaire (pour le niveau d'accès demandé)
 * @returns {Array} zéro à quatre constats C-CHAINE-0x, dans cet ordre
 */
export function chainesDAttaque(constats, ctx) {
  const acces = accesDemande(ctx);
  const injection = premier(constats, (c) => INJECTION.has(c.regle) || (c.regle === 'D-XSS-02' && c.severite !== 'mineur'));   // D-XSS-02 par la seule adresse (mineur) n'est pas une porte qu'un autre peut ouvrir
  const message = premier(constats, (c) => c.regle === 'C-PM-01');
  const sortie = premier(constats, (c) => SORTIE.has(c.regle));
  const codeDistant = premier(constats, (c) => c.severite === 'critique' && (c.regle === 'E-DEP-01' || c.regle === 'C-EXFIL-03'));
  const ecriture = premier(constats, (c) => c.regle === 'C-GRIST-03' && c.severite !== 'mineur');

  const chaines = [];
  if (injection && acces && sortie) {
    chaines.push({
      regle: 'C-CHAINE-01', titre: "Scénario d'attaque possible : un contenu piégé lit les données du document et les envoie à l'extérieur",
      etapes: [etape('du contenu dynamique est écrit dans la page ou exécuté', injection), etapeAcces(acces), etape("le widget appelle l'extérieur", sortie)],
      conclusion: "un contenu piégé (une cellule, un paramètre, un message) qui s'exécute dans le widget pourrait lire les données auxquelles il a accès et les emporter par l'appel sortant",
    });
  }
  if (message && injection) {
    chaines.push({
      regle: 'C-CHAINE-02', titre: "Scénario d'attaque possible : une page voisine fait exécuter du contenu dans le widget",
      etapes: [etape("un message d'une autre fenêtre est accepté sans contrôle de l'origine", message), etape('du contenu dynamique est écrit dans la page ou exécuté', injection)],
      conclusion: "une autre page, ouverte dans la même fenêtre ou qui l'a ouverte, pourrait envoyer au widget un message dont le contenu est écrit dans la page ou exécuté",
    });
  }
  if (codeDistant && acces) {
    chaines.push({
      regle: 'C-CHAINE-03', titre: "Scénario d'attaque possible : un code tiers remplacé à la source s'exécute avec l'accès du widget aux données",
      etapes: [etape('du code tiers est chargé de loin sans empreinte', codeDistant), etapeAcces(acces)],
      conclusion: "si l'hôte de ce code était compromis, ou l'adresse détournée, le code servi s'exécuterait dans le widget avec l'accès aux données qu'il a demandé",
    });
  }
  if (injection && ecriture) {
    chaines.push({
      regle: 'C-CHAINE-04', titre: "Scénario d'attaque possible : un contenu piégé modifie les données du document",
      etapes: [etape('du contenu dynamique est écrit dans la page ou exécuté', injection), etape('le widget a le droit d\'écrire dans le document', ecriture)],
      conclusion: "un contenu piégé qui s'exécute dans le widget pourrait écrire dans le document avec le niveau d'accès « full »",
    });
  }

  return chaines.map((c) => {
    const prouvees = c.etapes.filter((e) => e.prouvee);
    const decrire = (e, i) => `${i + 1}) ${e.role}${e.regle ? ` — ${e.regle}${lieu(e)}` : ''}${e.prouvee ? ', observé à l\'exécution' : ''}`;
    return constat({
      regle: c.regle, axe: 'C', severite: 'info', confiance: 'a_verifier',
      titre: c.titre,
      constat: `Des constats de cet audit se combinent : ${c.etapes.map(decrire).join(' ; ')}. En les enchaînant, ${c.conclusion}. C'est une hypothèse : l'audit n'a pas exécuté cet enchaînement${prouvees.length ? ` ; ${prouvees.length} étape(s) seulement ${prouvees.length > 1 ? 'ont' : 'a'} été observée(s) à l'exécution` : ''}.`,
      impact: "Information seule : aucune pénalité, aucun blocage, chaque étape pèse déjà par son propre constat. Elle dit par où commencer : corriger une seule des étapes casse le scénario.",
      remediation: "Corriger l'étape la plus simple à fermer : vérifier l'origine des messages, remplacer l'écriture de contenu dynamique par `textContent`, demander l'accès « none » ou « read table » plutôt que « full », figer et embarquer les bibliothèques tierces.",
      referentiels: REFERENTIELS,
      preuve: { etapes: c.etapes },
    });
  });
}
