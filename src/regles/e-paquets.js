/**
 * Axe E — paquets inventés ou tout neufs : ce que les dates du registre npm (`e-registre.js`) disent d'un nom qu'un widget réclame.
 *
 *  - E-DEP-08 : le registre ne connaît pas le nom. Une IA qui recommande des paquets en invente régulièrement ; le nom resté libre peut être publié par n'importe
 *    qui, et l'installation suivante exécute son code (« slopsquatting »). Un paquet privé ou retiré donne le même constat : d'où « probable » (et mineur pour
 *    un nom `@portée/…`, que son propriétaire sert souvent depuis un autre registre).
 *  - E-DEP-09 : le paquet a été créé il y a moins de 90 jours. Aucun recul ; un paquet neuf et légitime existe, c'est un « à vérifier ».
 *  - E-DEP-10 : la version verrouillée (ou figée dans l'adresse) a été publiée il y a moins de 7 jours : la fenêtre où se propagent les versions piégées
 *    avant qu'on les retire. La parade est un délai de carence avant d'adopter une version.
 *
 * Aucun de ces constats n'est bloquant : une date est un indice, jamais une preuve de malveillance. Un registre qui répond « introuvable » à tout n'est pas
 * cru (`registreFiable`) : un relais d'entreprise qui répond 404 ne rend aucun paquet inventé.
 */
import { constat } from '../moteur/modele.js';
import { REGISTRE_NPM } from './npm-isole.js';
import { creationDuPaquet, publicationDeVersion, SEUIL_CREATION_JOURS, SEUIL_VERSION_JOURS } from './e-registre.js';

const MAX_NOMMES = 8;
const LONGUEUR_MAX = 100;
const VERSION_EXACTE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const court = (valeur) => String(valeur ?? '').slice(0, LONGUEUR_MAX);
const enumerer = (liste) => liste.slice(0, MAX_NOMMES).join(', ') + (liste.length > MAX_NOMMES ? ` et ${liste.length - MAX_NOMMES} autre(s)` : '');
const REFERENTIELS = ['OWASP Top 10 A06:2021 — Composants vulnérables et obsolètes', 'OWASP Top 10 A08:2021 — Software and Data Integrity Failures', 'ANSSI — Maîtrise du code tiers'];

/** Vrai pour une version exacte (`1.2.3`), seule façon de dire quelle publication est installée ; une plage ou une étiquette ne le dit pas. */
export const estVersionExacte = (version) => typeof version === 'string' && VERSION_EXACTE.test(version);

/**
 * @param {{candidats: Array<{nom: string, version: ?string, origine: string, fichier?: string, ligne?: number}>, lus: Map, registreFiable: boolean, maintenant?: number}} entree
 *   `candidats` : un par (nom, origine) — `origine` dit d'où vient le nom (« package.json », « chargé depuis esm.sh »)
 * @returns {Array} les constats E-DEP-08, E-DEP-09 et E-DEP-10 qui s'appliquent, dans cet ordre
 */
export function constatsPaquetsSuspects({ candidats, lus, registreFiable, maintenant = Date.now() }) {
  // Un nom, quelle que soit la façon dont le widget le réclame : ses origines et ses versions exactes se regroupent.
  const parNom = new Map();
  for (const c of candidats) {
    let p = parNom.get(c.nom);
    if (!p) parNom.set(c.nom, p = { nom: c.nom, origines: [], versions: new Set(), fichier: c.fichier, ligne: c.ligne });
    if (!p.origines.includes(c.origine)) p.origines.push(c.origine);
    if (estVersionExacte(c.version)) p.versions.add(c.version);
  }
  const paquets = [...parNom.values()];
  const decrit = (p, detail) => `${court(p.nom)}${detail ? ` (${detail})` : ''}`;
  const origines = (p) => p.origines.join(' et ');
  const constats = [];

  const introuvables = registreFiable ? paquets.filter((p) => lus.get(p.nom)?.erreur === 'introuvable') : [];
  if (introuvables.length) {
    const nuAuMoinsUn = introuvables.some((p) => !p.nom.startsWith('@'));
    constats.push(constat({
      regle: 'E-DEP-08', axe: 'E', severite: nuAuMoinsUn ? 'majeur' : 'mineur', confiance: nuAuMoinsUn ? 'probable' : 'a_verifier',
      titre: `${introuvables.length > 1 ? `${introuvables.length} paquets introuvables` : 'Paquet introuvable'} au registre npm : ${enumerer(introuvables.map((p) => court(p.nom)))}`,
      fichier: introuvables[0].fichier, ligne: introuvables[0].ligne,
      constat: `Le registre npm ne connaît pas ${enumerer(introuvables.map((p) => decrit(p, origines(p))))}. Un nom que le registre ne connaît pas est une faute de frappe, un nom inventé (les assistants d'IA en proposent régulièrement), un paquet retiré, ou un paquet privé servi par un autre registre : l'audit ne peut pas dire lequel.`,
      impact: "Tant que le nom n'est à personne, l'installation échoue ; le jour où quelqu'un le publie, elle réussit, avec le code de cette personne (« slopsquatting »). Un paquet privé est signalé à tort : un nom `@portée/…`, que son propriétaire sert souvent depuis un autre registre, est donc noté mineur.",
      remediation: "Vérifier le nom (faute de frappe ? paquet réellement publié ?). Pour un paquet privé, dire dans le README son registre et sa portée. Sinon retirer la dépendance ou la remplacer par un paquet qui existe et dont l'auteur et le dépôt sont connus.",
      referentiels: REFERENTIELS,
      preuve: { registre: REGISTRE_NPM, paquets: introuvables.slice(0, 50).map((p) => ({ nom: court(p.nom), origines: p.origines })), total: introuvables.length },
    }));
  }

  const neufs = paquets.map((p) => ({ p, r: lus.get(p.nom)?.time ? creationDuPaquet(lus.get(p.nom), maintenant) : null })).filter(({ r }) => r?.ageJours < SEUIL_CREATION_JOURS);
  if (neufs.length) {
    constats.push(constat({
      regle: 'E-DEP-09', axe: 'E', severite: 'mineur', confiance: 'a_verifier',
      titre: `${neufs.length > 1 ? `${neufs.length} paquets créés` : 'Paquet créé'} il y a moins de ${SEUIL_CREATION_JOURS} jours : ${enumerer(neufs.map(({ p }) => court(p.nom)))}`,
      fichier: neufs[0].p.fichier, ligne: neufs[0].p.ligne,
      constat: `Le registre npm date la création de ${enumerer(neufs.map(({ p, r }) => decrit(p, `créé le ${r.date}, il y a ${r.ageJours} jour(s) ; ${origines(p)}`)))}. Un paquet sans recul n'a rien d'anormal quand il est légitime (un nouvel outil, le paquet d'un même auteur) ; c'est aussi la forme d'un paquet posé pour piéger les widgets qui l'adoptent (nom proche d'un paquet connu, nom que des assistants d'IA inventent).`,
      impact: "Personne n'a encore relu ce paquet à grande échelle : s'il est piégé, rien ne l'a encore signalé. L'audit ne dit pas qu'il l'est.",
      remediation: "Avant de s'y fier : vérifier l'auteur, le dépôt source (existe-t-il, est-il lié au paquet ?), le nombre de téléchargements et la proximité du nom avec un paquet connu.",
      referentiels: REFERENTIELS,
      preuve: { registre: REGISTRE_NPM, seuilJours: SEUIL_CREATION_JOURS, paquets: neufs.slice(0, 50).map(({ p, r }) => ({ nom: court(p.nom), creation: r.date, ageJours: r.ageJours, origines: p.origines })), total: neufs.length },
    }));
  }

  const recentes = [];
  for (const p of paquets) {
    const lu = lus.get(p.nom);
    if (!lu?.time) continue;
    for (const version of p.versions) {
      const pub = publicationDeVersion(lu, version, maintenant);
      if (pub && pub.ageJours < SEUIL_VERSION_JOURS) recentes.push({ p, version, ...pub });
    }
  }
  if (recentes.length) {
    constats.push(constat({
      regle: 'E-DEP-10', axe: 'E', severite: 'mineur', confiance: 'a_verifier',
      titre: `${recentes.length > 1 ? `${recentes.length} versions publiées` : 'Version publiée'} il y a moins de ${SEUIL_VERSION_JOURS} jours : ${enumerer(recentes.map(({ p, version }) => `${court(p.nom)}@${court(version)}`))}`,
      fichier: recentes[0].p.fichier, ligne: recentes[0].p.ligne,
      constat: `Le registre npm date la publication de ${enumerer(recentes.map(({ p, version, date, ageJours }) => decrit({ nom: `${p.nom}@${version}` }, `le ${date}, il y a ${ageJours} jour(s) ; ${origines(p)}`)))}. C'est la version que le widget installe ou charge.`,
      impact: "Les versions piégées publiées par un compte de mainteneur compromis circulent surtout pendant les premiers jours, avant qu'on les retire. Une version si récente n'a pas eu ce temps d'être relue ; l'audit ne dit pas qu'elle est piégée.",
      remediation: "Laisser passer un délai de carence (par exemple une semaine) avant d'adopter une version : l'option `cooldown` de Dependabot, `minimumReleaseAge` de Renovate. Vérifier la version dans le registre et son dépôt avant de la déployer.",
      referentiels: REFERENTIELS,
      preuve: { registre: REGISTRE_NPM, seuilJours: SEUIL_VERSION_JOURS, versions: recentes.slice(0, 50).map(({ p, version, date, ageJours }) => ({ nom: court(p.nom), version: court(version), date, ageJours, origines: p.origines })), total: recentes.length },
    }));
  }
  return constats;
}
