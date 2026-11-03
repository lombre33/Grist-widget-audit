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
 *  - Maintenance : deux signaux. Hors ligne, le drapeau « déprécié » que npm écrit dans `package-lock.json` (formats 2 et 3). Au registre npm (`e-registre.js`, même
 *    coupure `--sans-reseau` que `npm audit`), la date de dernière publication et le retard de version des dépendances directes de production. Une régularité que le
 *    registre n'a pas pu dire (option, registre injoignable, paquet hors registre) est écrite « non mesurée » ; une date de publication est un indice, jamais une preuve.
 */
import { constat } from '../moteur/modele.js';
import { estDuRegistre, interrogerRegistre, resumerPublications, MAX_INTERROGEES, SEUIL_ANCIENNETE_MOIS } from './e-registre.js';

/** Bornes d'un rapport lisible et d'un verrou hostile : un nom ou une version est coupé, les listes sont bornées (le total exact est gardé). */
const LONGUEUR_MAX = 100;
const MAX_DEPENDANCES = 200;
const MAX_DEPRECIEES = 100;
const MAX_NOMMEES = 8;

const court = (valeur) => String(valeur ?? '').slice(0, LONGUEUR_MAX);
const nombre = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;
const objetDe = (valeur) => (valeur && typeof valeur === 'object' && !Array.isArray(valeur) ? valeur : {});

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
 * @param {{reseau?: boolean}} [options] `reseau: false` (`--sans-reseau`) : le registre npm n'est pas interrogé
 * @param {(noms: string[]) => Promise<Map>} [lire] la lecture du registre ; les essais en fournissent une sans réseau
 * @returns {Promise<Array>} un constat E-DEP-07, ou rien quand le widget n'a aucune dépendance
 */
export async function bilanDependances(ctx, constatsE, options = {}, lire = interrogerRegistre) {
  const paquet = objetDe(ctx.paquet);
  const specifications = { ...objetDe(paquet.optionalDependencies), ...objetDe(paquet.dependencies) };
  const production = Object.keys(specifications);
  const developpement = Object.keys(objetDe(paquet.devDependencies));
  const embarquees = constatsE.filter((c) => c.regle === 'E-DEP-02');
  const distantes = constatsE.filter((c) => c.regle === 'E-DEP-01');
  const horsNpm = embarquees.length + distantes.length;
  const directes = production.length + developpement.length;
  if (!directes && !horsNpm) return [];

  // Le registre : les premières dépendances de production qui s'y lisent, à moins que l'utilisateur ne l'ait coupé (`--sans-reseau`).
  const aInterroger = production.filter((nom) => estDuRegistre(nom, specifications[nom])).slice(0, MAX_INTERROGEES);
  const registre = options.reseau === false ? 'option' : aInterroger.length ? 'interroge' : 'sans-objet';
  const lus = registre === 'interroge' ? await lire(aInterroger) : new Map();

  const verrou = lireVerrou(ctx);
  const audit = etatDeLAudit(constatsE);
  const depreciees = verrou.paquets ? deprecies(verrou.paquets) : null;
  const avis = new Map(constatsE.filter((c) => c.regle === 'E-VULN-01' && c.preuve?.nom).map((c) => [c.preuve.nom, c.preuve.avis?.severity]));

  const nomsDepreciees = new Set((depreciees ?? []).map((d) => d.nom));
  const versionVerrouillee = (nom) => court(verrou.paquets?.[`node_modules/${nom}`]?.version) || null;
  const surete = (nom) => (audit === 'avis' ? (avis.has(nom) ? { etat: 'avis', gravite: avis.get(nom) ?? null } : { etat: 'aucun-avis' }) : audit === 'aucun-avis' ? { etat: 'aucun-avis' } : { etat: 'non-mesuree', raison: audit });
  const nonMesuree = (raison) => ({ etat: 'non-mesuree', raison });
  const interrogees = new Set(aInterroger);
  /** Ce que le registre dit de la régularité d'une dépendance directe de production, ou pourquoi il ne le dit pas. */
  const regulariteDe = (nom) => {
    if (registre === 'option') return nonMesuree('option');
    if (!estDuRegistre(nom, specifications[nom])) return nonMesuree('hors-registre-public');
    if (!interrogees.has(nom)) return nonMesuree(`au-dela-des-${MAX_INTERROGEES}-premieres`);
    const lu = lus.get(nom);
    if (!lu) return nonMesuree('non-interrogee');
    return lu.erreur ? nonMesuree(lu.erreur) : resumerPublications(lu, versionVerrouillee(nom)) ?? nonMesuree('sans-date');
  };
  const entreeNpm = (nom, anneau, regularite) => ({
    nom: court(nom), version: versionVerrouillee(nom), anneau,
    maintenance: { depreciee: depreciees ? nomsDepreciees.has(court(nom)) : null, regularite },
    surete: surete(nom),
  });
  const entreeHorsNpm = (nom, c, anneau) => ({ nom: court(nom), anneau, regle: c.regle, maintenance: { depreciee: null, regularite: nonMesuree('hors-npm') }, surete: { etat: 'non-mesuree', raison: 'hors-npm-audit' } });
  const entreesProduction = production.map((n) => entreeNpm(n, 'npm-production', regulariteDe(n)));
  const dependances = [
    ...entreesProduction,
    ...developpement.map((n) => entreeNpm(n, 'npm-developpement', nonMesuree('developpement'))),
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
  const mesurees = entreesProduction.filter((e) => e.maintenance.regularite.etat !== 'non-mesuree');
  const anciennes = mesurees.filter((e) => e.maintenance.regularite.etat === 'ancienne');
  const enRetard = mesurees.filter((e) => e.maintenance.regularite.retardMajeur > 0);
  const nonLues = entreesProduction.length - mesurees.length;
  const DEFINITION = '(date de la dernière version, retard sur la version courante)';
  const NON_PROUVEE = " « Aucune dépréciation » ne veut donc pas dire « maintenue régulièrement ».";
  const PERIMETRE = ` Seules les dépendances directes de production sont interrogées (${MAX_INTERROGEES} au plus) : ni celles de développement, ni les paquets transitifs, ni les bibliothèques embarquées ou distantes.`;
  const regularite = registre === 'option' ? `La régularité des publications ${DEFINITION} n'est PAS mesurée : audit lancé avec --sans-reseau, le registre npm n'a pas été interrogé.${directes ? NON_PROUVEE : ''}`
    : registre === 'sans-objet' ? `La régularité des publications ${DEFINITION} n'est PAS mesurée : aucune dépendance directe de production ne se lit au registre public, et les bibliothèques embarquées ou distantes ne portent pas de date.${directes ? NON_PROUVEE : ''}`
    : !mesurees.length ? `La régularité des publications ${DEFINITION} n'est PAS mesurée : le registre npm n'a pas répondu (injoignable, ou paquets introuvables).${NON_PROUVEE}${PERIMETRE}`
    : `Régularité des publications (registre npm, à la date de l'audit) : ${mesurees.length} dépendance(s) directe(s) de production sur ${production.length} mesurée(s), `
      + `${mesurees.length - anciennes.length} avec une publication de moins de ${SEUIL_ANCIENNETE_MOIS} mois`
      + (anciennes.length ? ` ; sans publication depuis plus de ${SEUIL_ANCIENNETE_MOIS} mois : ${enumerer(anciennes.map((e) => `${e.nom} (dernière le ${e.maintenance.regularite.dernierePublication})`))}, abandon possible mais non prouvé (un paquet achevé peut ne plus bouger)` : '')
      + (enRetard.length ? ` ; en retard d'une version majeure ou plus sur la dernière : ${enumerer(enRetard.map((e) => `${e.nom}@${e.version} (${e.maintenance.regularite.retardMajeur})`))}` : '')
      + `. ${nonLues ? `${nonLues} non mesurée(s) (registre injoignable, paquet introuvable, hors registre public ou au-delà des ${MAX_INTERROGEES} premières). ` : ''}Une date de publication est un indice de maintenance, non une preuve.${PERIMETRE}`;
  const maintenance = [maintenanceNpm, regularite].filter(Boolean).join(' ');

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
    remediation: "Pour la maintenance et la sûreté mesurées, relancer sans --sans-reseau depuis un poste qui atteint registry.npmjs.org. Pour une dépendance non interrogée (développement, transitive, embarquée, distante), relever à la main la date de sa dernière version (`npm view <paquet> time`) et tenir une liste de version et d'origine pour les bibliothèques embarquées.",
    referentiels: ['OWASP Top 10 A06:2021 — Composants vulnérables et obsolètes', 'ANSSI — Maîtrise du code tiers'],
    preuve: {
      verrou: verrou.etat, audit, registre, regulariteMesuree: mesurees.length, seuilAncienneteMois: SEUIL_ANCIENNETE_MOIS,
      depreciees: depreciees?.slice(0, MAX_DEPRECIEES) ?? null, deprecieesTotal: depreciees?.length ?? null,
      dependances: dependances.slice(0, MAX_DEPENDANCES), dependancesTotal: dependances.length,
    },
  })];
}
