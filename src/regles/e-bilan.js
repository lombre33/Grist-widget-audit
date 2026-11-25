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
import { constatsPaquetsSuspects, estVersionExacte } from './e-paquets.js';
import { constatsNomsVoisins } from './e-noms-voisins.js';
import { paquetNpmDeAdresse } from '../moteur/bibliotheque.js';
import { interrogerOsv, constatsOsv, cleDe, MAX_PAQUETS as MAX_OSV } from './e-osv.js';
import { REGISTRE_NPM } from './npm-isole.js';
import { identifierLesEmbarquees, constatsIdentiques } from './e-identique.js';

/** Bornes d'un rapport lisible et d'un verrou hostile : un nom ou une version est coupé, les listes sont bornées (le total exact est gardé). */
const LONGUEUR_MAX = 100;
const MAX_DEPENDANCES = 200;
const MAX_DEPRECIEES = 100;
const MAX_NOMMEES = 8;
/** Les bibliothèques chargées de loin (esm.sh, unpkg…) dont le nom est lu au registre, en plus des dépendances de production. */
const MAX_DISTANTES = 15;
/** Un paquet qui existe, interrogé quand le registre répond « introuvable » à tout : si lui aussi est introuvable, le registre n'est pas cru (E-DEP-08). */
const CANARI = 'lodash';

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
 * @param {typeof interrogerOsv} [osv] la lecture d'OSV.dev (`e-osv.js`) ; les essais en fournissent une sans réseau
 * @param {typeof identifierLesEmbarquees} [identifier] la reconnaissance des bibliothèques embarquées au registre (`e-identique.js`) ; les essais en fournissent une sans réseau
 * @returns {Promise<Array>} le constat E-DEP-07 puis, selon ce que le registre dit des noms réclamés, E-DEP-08, E-DEP-09 et E-DEP-10 (`e-paquets.js`), E-DEP-11 (`e-noms-voisins.js`), E-DEP-12 (`e-identique.js`) et les avis d'OSV.dev (`e-osv.js`) ; rien quand le widget n'a aucune dépendance
 */
export async function bilanDependances(ctx, constatsE, options = {}, lire = interrogerRegistre, osv = interrogerOsv, identifier = identifierLesEmbarquees) {
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
  // Les bibliothèques chargées de loin dont le nom est celui d'un paquet npm (E-DEP-01) se lisent au même registre, pour E-DEP-08 à E-DEP-10.
  const distants = [];
  for (const c of distantes) {
    const p = c.preuve?.adresse ? paquetNpmDeAdresse(c.preuve.adresse) : null;
    if (p && estDuRegistre(p.nom, p.version ?? '*')) distants.push({ nom: p.nom, version: p.version, hote: court(c.preuve.adresse.split('/')[2]), fichier: c.fichier, ligne: c.ligne });
  }
  const nomsDistants = [...new Set(distants.map((d) => d.nom))].filter((nom) => !aInterroger.includes(nom)).slice(0, MAX_DISTANTES);
  const aLire = [...aInterroger, ...nomsDistants];
  const lus = options.reseau !== false && aLire.length ? await lire(aLire) : new Map();

  // Les bibliothèques embarquées identiques à un paquet publié (E-DEP-12) ont un nom et une version certains : elles rejoignent les questions posées à OSV.dev.
  const aReconnaitre = options.reseau === false ? [] : embarquees.map((c) => ctx.fichiers.find((f) => f.chemin === c.fichier)).filter((f) => f && typeof f.contenu === 'string');
  const reconnues = aReconnaitre.length ? await identifier(aReconnaitre, ctx.racine) : [];
  const identiques = constatsIdentiques(reconnues);
  const reconnueEn = new Map(reconnues.map((r) => [r.fichier, court(`${r.nom}@${r.version}`)]));

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
  const entreeHorsNpm = (nom, c, anneau) => ({ nom: court(nom), anneau, regle: c.regle, ...(anneau === 'embarquee' && reconnueEn.get(c.fichier) ? { reconnue: reconnueEn.get(c.fichier) } : {}), maintenance: { depreciee: null, regularite: nonMesuree('hors-npm') }, surete: { etat: 'non-mesuree', raison: 'hors-npm-audit' } });
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

  // Paquets inventés ou tout neufs (E-DEP-08 à E-DEP-10) : ce que le registre dit des noms réclamés par le widget ; rien quand `--sans-reseau` a coupé le registre.
  const candidats = [
    ...aInterroger.map((nom) => ({ nom, version: versionVerrouillee(nom) ?? (estVersionExacte(specifications[nom]) ? specifications[nom] : null), origine: 'package.json', fichier: 'package.json' })),
    ...distants.filter((d) => aInterroger.includes(d.nom) || nomsDistants.includes(d.nom)).map((d) => ({ ...d, origine: `chargé depuis ${d.hote}` })),
  ];
  const trouves = [...lus.values()];
  let registreFiable = trouves.some((r) => r.time);
  if (!registreFiable && trouves.some((r) => r.erreur === 'introuvable')) registreFiable = Boolean((await lire([CANARI])).get(CANARI)?.time);
  const suspects = lus.size ? constatsPaquetsSuspects({ candidats, lus, registreFiable }) : [];
  // Noms qui ressemblent à un paquet très connu : une comparaison de noms, qui se fait aussi hors ligne ; le registre ne sert qu'à dire un paquet récent.
  const voisins = constatsNomsVoisins({
    noms: [...production, ...developpement].map((nom) => ({ nom, origine: 'package.json', fichier: 'package.json' })).concat(distants.map((d) => ({ nom: d.nom, origine: `chargé depuis ${d.hote}`, fichier: d.fichier, ligne: d.ligne }))),
    lus,
  });

  // OSV.dev : les bibliothèques chargées de loin dont le nom ET la version exacte se lisent dans l'adresse (une version mal identifiée donnerait un faux avis),
  // et les paquets verrouillés du registre (pour les paquets malveillants ; leurs avis ordinaires restent à `npm audit`).
  const pourOsv = new Map();
  for (const d of distants) if (estVersionExacte(d.version)) pourOsv.set(cleDe(d.nom, d.version), { nom: d.nom, version: d.version, origine: 'distante', hote: d.hote, fichier: d.fichier, ligne: d.ligne });
  for (const [chemin, p] of Object.entries(verrou.paquets ?? {})) {
    const i = chemin.lastIndexOf('node_modules/');
    if (i < 0 || !p || p.link || (p.resolved !== undefined && !String(p.resolved).startsWith(REGISTRE_NPM))) continue;   // une adresse git, un dossier, un autre registre : le nom et la version ne désignent pas le paquet public
    const nom = typeof p.name === 'string' ? p.name : chemin.slice(i + 'node_modules/'.length);
    if (!estDuRegistre(nom, p.version ?? '*') || !estVersionExacte(p.version) || pourOsv.size >= MAX_OSV) continue;
    if (!pourOsv.has(cleDe(nom, p.version))) pourOsv.set(cleDe(nom, p.version), { nom, version: p.version, origine: 'verrou' });
  }
  const embarqueesOsv = reconnues.filter((r) => estVersionExacte(r.version)).map((r) => ({ nom: r.nom, version: r.version, origine: 'embarquee', fichier: r.fichier }));
  const questions = [...pourOsv.values(), ...embarqueesOsv];
  const paires = [...new Map(questions.map(({ nom, version }) => [cleDe(nom, version), { nom, version }])).values()];
  const etatOsv = !questions.length ? 'sans-objet' : options.reseau === false ? 'option' : null;
  const reponseOsv = etatOsv ? { erreur: null, lus: new Map() } : await osv(paires);
  const osvEtat = etatOsv ?? reponseOsv.erreur ?? 'interroge';
  const constatsDeOsv = osvEtat === 'interroge' ? constatsOsv(questions, reponseOsv.lus) : [];
  const osvDistantes = osvEtat === 'interroge' ? questions.filter((q) => q.origine === 'distante') : [];
  const osvEmbarquees = osvEtat === 'interroge' ? embarqueesOsv : [];

  const sureteNpm = !directes ? null
    : audit === 'aucun-avis' ? "`npm audit` ne remonte aucun avis publié sur les paquets verrouillés à la date de l'audit (E-VULN-02) : présumés sûrs au sens des avis connus, non relus."
    : audit === 'avis' ? `\`npm audit\` remonte des avis sur ${enumerer([...avis.keys()].map(court))} (E-VULN-01) ; aucun autre paquet verrouillé n'en porte.`
    : `non établie, ${RAISON_SURETE[audit]}.`;
  const nonVues = horsNpm - osvDistantes.length - osvEmbarquees.length;
  const sureteHorsNpm = nonVues > 0 ? `${nombre(nonVues, 'bibliothèque embarquée ou distante', 'bibliothèques embarquées ou distantes')} ${nonVues > 1 ? 'ne sont vues' : "n'est vue"} par aucune base d'avis : sûreté non vérifiée.` : null;
  const nbVerrou = questions.filter((q) => q.origine === 'verrou').length;
  const sureteOsv = osvEtat === 'sans-objet' ? null
    : osvEtat === 'option' ? "OSV.dev n'a pas été interrogé : audit lancé avec --sans-reseau."
    : osvEtat === 'interroge' ? `OSV.dev interrogé sur ${nombre(osvDistantes.length, 'bibliothèque chargée de loin', 'bibliothèques chargées de loin')}${osvEmbarquees.length ? `, ${nombre(osvEmbarquees.length, 'bibliothèque embarquée reconnue identique au paquet publié', 'bibliothèques embarquées reconnues identiques au paquet publié')} (E-DEP-12)` : ''} et ${nombre(nbVerrou, 'paquet verrouillé', 'paquets verrouillés')} : ${nombre(constatsDeOsv.filter((c) => c.regle === 'E-VULN-03').length, 'avis', 'avis')}, ${nombre(constatsDeOsv.filter((c) => c.regle === 'E-VULN-04').length, 'paquet malveillant', 'paquets malveillants')} (E-VULN-03, E-VULN-04).`
    : `OSV.dev n'a pas répondu (${osvEtat}) : sûreté non mesurée pour les bibliothèques chargées de loin et pour les paquets malveillants.`;

  return [constat({
    regle: 'E-DEP-07', axe: 'E', severite: 'info', confiance: 'certain',
    titre: `Bilan des dépendances : maintenance et sûreté (${nombre(directes + horsNpm, 'dépendance', 'dépendances')})`,
    constat: `Dépendances présentes : ${inventaire}. Maintenance : ${maintenance} Sûreté : ${[sureteNpm, sureteOsv, sureteHorsNpm].filter(Boolean).join(' ')}`,
    impact: "Information seule : aucun effet sur la note ni sur le verdict. Elle dit ce qui a été mesuré et ce qui ne l'a pas été ; « présumée sûre » ne veut pas dire sûre, et ce qui n'est pas mesuré n'est ni maintenu ni sûr.",
    remediation: "Pour la maintenance et la sûreté mesurées, relancer sans --sans-reseau depuis un poste qui atteint registry.npmjs.org. Pour une dépendance non interrogée (développement, transitive, embarquée, distante), relever à la main la date de sa dernière version (`npm view <paquet> time`) et tenir une liste de version et d'origine pour les bibliothèques embarquées.",
    referentiels: ['OWASP Top 10 A06:2021 — Composants vulnérables et obsolètes', 'ANSSI — Maîtrise du code tiers'],
    preuve: {
      verrou: verrou.etat, audit, registre, osv: { etat: osvEtat, interroges: paires.length }, regulariteMesuree: mesurees.length, seuilAncienneteMois: SEUIL_ANCIENNETE_MOIS,
      depreciees: depreciees?.slice(0, MAX_DEPRECIEES) ?? null, deprecieesTotal: depreciees?.length ?? null,
      dependances: dependances.slice(0, MAX_DEPENDANCES), dependancesTotal: dependances.length,
    },
  }), ...suspects, ...voisins, ...identiques, ...constatsDeOsv];
}
