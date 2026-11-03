/**
 * Axe E — bilan des dépendances : sont-elles maintenues, et présumées sûres ?
 *
 * Un seul constat d'information (E-DEP-07), présent quand le widget a au moins une dépendance (npm, embarquée dans le dépôt ou chargée à
 * l'exécution depuis un hôte distant). Il ne note rien et ne bloque rien : il dit, pour chacune des deux questions, ce qui a été MESURÉ et
 * ce qui ne l'a pas été. Ce qui n'a pas été mesuré ne se dit jamais « maintenu » ni « sûr ».
 *
 *  - Sûreté : l'état de `npm audit` tel que les règles de `e-dependances.js` l'ont déjà dit (E-VULN-00/01/02, E-VULN-OPTION) ; « présumée sûre »
 *    veut dire « aucun avis publié à la date de l'audit », jamais « code relu ». Les bibliothèques embarquées ou distantes, qu'aucune base d'avis
 *    ne voit, restent non vérifiées.
 *  - Maintenance : un seul signal se lit hors ligne, le drapeau « déprécié » que npm écrit dans `package-lock.json` (formats 2 et 3). La régularité des
 *    publications demande des dates, que le verrou ne porte pas : elle n'est PAS mesurée, et le constat le dit. L'audit n'interroge pas le registre pour elle.
 */
import { constat } from '../moteur/modele.js';

/** Bornes d'un rapport lisible et d'un verrou hostile : un nom ou une version est coupé, les listes sont bornées (le total exact est gardé). */
const LONGUEUR_MAX = 100;
const MAX_DEPENDANCES = 200;
const MAX_DEPRECIEES = 100;
const MAX_NOMMEES = 8;

const court = (valeur) => String(valeur ?? '').slice(0, LONGUEUR_MAX);
const nombre = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;
const nomsDe = (objet) => (objet && typeof objet === 'object' && !Array.isArray(objet) ? Object.keys(objet) : []);

/** Le verrou npm lu hors ligne : ses paquets, ou la raison pour laquelle on ne les a pas. */
function lireVerrou(ctx) {
  const fichier = ctx.fichiers.find((f) => f.chemin === 'package-lock.json');
  if (!fichier || typeof fichier.contenu !== 'string') return { etat: 'non-lu', paquets: null };
  try {
    const paquets = JSON.parse(fichier.contenu).packages;
    return paquets && typeof paquets === 'object' ? { etat: 'lu', paquets } : { etat: 'non-lu', paquets: null };
  } catch {
    return { etat: 'non-lu', paquets: null };
  }
}

/** Ce que `npm audit` a dit, d'après les constats déjà produits par l'axe E. */
function etatDeLAudit(constatsE) {
  const regles = new Set(constatsE.map((c) => c.regle));
  if (regles.has('E-VULN-01')) return 'avis';
  if (regles.has('E-VULN-02')) return 'aucun-avis';
  if (regles.has('E-VULN-00')) return 'echec';
  if (regles.has('E-VULN-OPTION')) return 'option';
  return 'non-lance';
}

const RAISON_SURETE = {
  echec: "`npm audit` n'a pas abouti (E-VULN-00)",
  option: "audit lancé avec --sans-reseau, `npm audit` n'a pas été lancé (E-VULN-OPTION)",
  'non-lance': "sans fichier de verrouillage, `npm audit` n'a rien lu (E-DEP-04)",
};

/** Les paquets verrouillés (directs ou non) que leur mainteneur a marqués dépréciés, d'après le verrou. */
function deprecies(paquets) {
  const liste = [];
  for (const [chemin, p] of Object.entries(paquets)) {
    if (!chemin || !p || typeof p.deprecated !== 'string' || !p.deprecated) continue;
    liste.push({ nom: court(chemin.slice(chemin.lastIndexOf('node_modules/') + 'node_modules/'.length)), version: court(p.version), production: !(p.dev === true || p.devOptional === true) });
  }
  return liste;
}

/** Les premiers noms d'une liste, et combien d'autres le texte ne nomme pas. */
const enumerer = (noms) => noms.slice(0, MAX_NOMMEES).join(', ') + (noms.length > MAX_NOMMEES ? ` et ${noms.length - MAX_NOMMEES} autre(s)` : '');

/**
 * @param {object} ctx contexte de l'inventaire
 * @param {Array} constatsE les constats de l'axe E déjà produits (CDN : E-DEP-01, embarquées : E-DEP-02, `npm audit` : E-VULN-*)
 * @returns {Array} un constat E-DEP-07, ou rien quand le widget n'a aucune dépendance
 */
export function bilanDependances(ctx, constatsE) {
  const paquet = ctx.paquet && typeof ctx.paquet === 'object' ? ctx.paquet : {};
  const production = [...nomsDe(paquet.dependencies), ...nomsDe(paquet.optionalDependencies)];
  const developpement = nomsDe(paquet.devDependencies);
  const embarquees = constatsE.filter((c) => c.regle === 'E-DEP-02');
  const distantes = constatsE.filter((c) => c.regle === 'E-DEP-01');
  const horsNpm = embarquees.length + distantes.length;
  const directes = production.length + developpement.length;
  if (!directes && !horsNpm) return [];

  const verrou = lireVerrou(ctx);
  const audit = etatDeLAudit(constatsE);
  const depreciees = verrou.paquets ? deprecies(verrou.paquets) : null;
  const avis = new Map(constatsE.filter((c) => c.regle === 'E-VULN-01' && c.preuve?.nom).map((c) => [c.preuve.nom, c.preuve.avis?.severity]));

  const nomsDepreciees = new Set((depreciees ?? []).map((d) => d.nom));
  const versionVerrouillee = (nom) => court(verrou.paquets?.[`node_modules/${nom}`]?.version) || null;
  const surete = (nom) => (audit === 'avis' ? (avis.has(nom) ? { etat: 'avis', gravite: avis.get(nom) ?? null } : { etat: 'aucun-avis' }) : audit === 'aucun-avis' ? { etat: 'aucun-avis' } : { etat: 'non-mesuree', raison: audit });
  const entreeNpm = (nom, anneau) => ({
    nom: court(nom), version: versionVerrouillee(nom), anneau,
    maintenance: { depreciee: depreciees ? nomsDepreciees.has(court(nom)) : null, regularite: 'non-mesuree' },
    surete: surete(nom),
  });
  const entreeHorsNpm = (nom, c, anneau) => ({ nom: court(nom), anneau, regle: c.regle, maintenance: { depreciee: null, regularite: 'non-mesuree' }, surete: { etat: 'non-mesuree', raison: 'hors-npm-audit' } });
  const dependances = [
    ...production.map((n) => entreeNpm(n, 'npm-production')),
    ...developpement.map((n) => entreeNpm(n, 'npm-developpement')),
    ...embarquees.map((c) => entreeHorsNpm(c.fichier, c, 'embarquee')),
    ...distantes.map((c) => entreeHorsNpm(c.extrait ?? c.titre, c, 'distante')),
  ];

  const inventaire = [
    directes && `${nombre(directes, 'paquet npm direct', 'paquets npm directs')} (${production.length} de production, ${developpement.length} de développement)`,
    verrou.paquets && directes && `${nombre(Object.keys(verrou.paquets).filter(Boolean).length, 'paquet verrouillé au total', 'paquets verrouillés au total')}`,
    embarquees.length && `${nombre(embarquees.length, 'bibliothèque embarquée dans le dépôt', 'bibliothèques embarquées dans le dépôt')}`,
    distantes.length && `${nombre(distantes.length, 'bibliothèque chargée à l\'exécution depuis un hôte distant', 'bibliothèques chargées à l\'exécution depuis un hôte distant')}`,
  ].filter(Boolean).join(', ');

  const maintenanceNpm = !directes ? null
    : !depreciees ? 'aucun signal lu : le verrou `package-lock.json` (format 2 ou 3) est absent ou illisible.'
    : depreciees.length
      ? `${nombre(depreciees.length, 'paquet verrouillé est marqué déprécié', 'paquets verrouillés sont marqués dépréciés')} par leur mainteneur (état à l'écriture du verrou) : ${enumerer(depreciees.map((d) => `${d.nom}@${d.version} (${d.production ? 'production' : 'développement'})`))}.`
      : "seul signal lisible hors ligne, le drapeau « déprécié » que npm inscrit dans le verrou : aucun paquet verrouillé n'en porte (état à l'écriture du verrou).";
  const maintenance = [
    maintenanceNpm,
    "La régularité des publications (date de la dernière version, retard sur la version courante) n'est PAS mesurée : elle demande des dates de publication que ni le verrou ni le dépôt ne portent, et l'audit n'interroge pas le registre pour cela."
      + (directes ? ' « Aucune dépréciation » ne veut donc pas dire « maintenue régulièrement ».' : ''),
    horsNpm ? "Aucune bibliothèque embarquée ou distante n'est suivie non plus." : null,
  ].filter(Boolean).join(' ');

  const sureteNpm = !directes ? null
    : audit === 'aucun-avis' ? "`npm audit` ne remonte aucun avis publié sur les paquets verrouillés à la date de l'audit (E-VULN-02) : présumés sûrs au sens des avis connus, non relus."
    : audit === 'avis' ? `\`npm audit\` remonte des avis sur ${enumerer([...avis.keys()].map(court))} (E-VULN-01) ; aucun autre paquet verrouillé n'en porte.`
    : `non établie, ${RAISON_SURETE[audit]}.`;
  const sureteHorsNpm = horsNpm ? `${nombre(horsNpm, 'bibliothèque embarquée ou distante', 'bibliothèques embarquées ou distantes')} ${horsNpm > 1 ? 'ne sont vues' : "n'est vue"} par aucune base d'avis : sûreté non vérifiée.` : null;

  return [constat({
    regle: 'E-DEP-07', axe: 'E', severite: 'info', confiance: 'certain',
    titre: `Bilan des dépendances : maintenance et sûreté (${nombre(directes + horsNpm, 'dépendance', 'dépendances')})`,
    constat: `Dépendances présentes : ${inventaire}. Maintenance : ${maintenance} Sûreté : ${[sureteNpm, sureteHorsNpm].filter(Boolean).join(' ')}`,
    impact: "Information seule : aucun effet sur la note ni sur le verdict. Elle dit ce qui a été mesuré et ce qui ne l'a pas été ; « présumée sûre » ne veut pas dire sûre, et ce qui n'est pas mesuré n'est ni maintenu ni sûr.",
    remediation: "Pour établir la régularité de maintenance, relever à la main la date de la dernière version de chaque dépendance directe (`npm view <paquet> time`). Pour la sûreté, relancer sans --sans-reseau depuis un poste qui atteint registry.npmjs.org, et tenir une liste de version et d'origine pour les bibliothèques embarquées.",
    referentiels: ['OWASP Top 10 A06:2021 — Composants vulnérables et obsolètes', 'ANSSI — Maîtrise du code tiers'],
    preuve: {
      verrou: verrou.etat, audit, regulariteMesuree: false,
      depreciees: depreciees?.slice(0, MAX_DEPRECIEES) ?? null, deprecieesTotal: depreciees?.length ?? null,
      dependances: dependances.slice(0, MAX_DEPENDANCES), dependancesTotal: dependances.length,
    },
  })];
}
