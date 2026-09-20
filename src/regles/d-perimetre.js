/**
 * Axe D — accès prouvé à une table hors du périmètre déclaré (RSSI §8.2).
 *
 * Grist ne déclare qu'un niveau d'accès global (`none`/`read table`/`full`),
 * jamais un périmètre par table : rien ne permet de comparer statiquement
 * « ce que le widget touche » à « ce qu'il annonce faire ». La table appât
 * (`TABLE_APPAT_ID`, définie dans `src/runtime/dynamique.js` et câblée dans
 * `src/runtime/harnais/hote.js`) transforme cette question invérifiable en
 * signal mécanique : elle n'est jamais la table sélectionnée, jamais
 * annoncée par une colonne que `grist.ready()` déclare attendre, jamais
 * montrée par l'interface. Un widget honnête n'a aucune raison de la lire.
 *
 * `listTables()` la révèle — comme le ferait un vrai Grist en accès `full` —
 * ce n'est donc volontairement PAS le signal : un widget dont le métier est
 * de parcourir la structure du document (ex. `Grist_Table_structure_import`,
 * CONFORME 81/100) énumère légitimement. Le signal est la LECTURE ou
 * l'ÉCRITURE effective de cette table précise (`fetchTable`/
 * `applyUserActions` avec son identifiant).
 *
 * Ce que le signal ne juge PAS : lire l'ensemble d'un document est un usage
 * parfaitement légitime pour certains widgets (un tableau de bord
 * transversal, un outil de résolution de variables inter-tables). Comme
 * D-RESEAU-01 pour un contact réseau et B-DOC-04 pour son absence de
 * documentation, le défaut n'est pas dans le comportement mais dans son
 * silence : un widget qui annonce, dans son README, lire l'ensemble du
 * document et demande l'accès `full` en conséquence est honnête, même
 * gourmand — celui qui ne l'annonce pas surprend l'agent qui l'installe.
 * `trouveDeclarationLectureEtendue` reprend telle quelle l'information que
 * B-DOC-03/04 (`src/regles/b-lisibilite.js`) utilisent déjà : le texte du
 * README et `ctx.usagesGrist.acces`.
 *
 * Cette fonction interprète `journal.appelsRpc` (produit par
 * `creerHoteGrist`, voir sa doc) et `ctx` (le contexte statique, pour le
 * README et le niveau d'accès déclaré) : elle doit être appelée par le code
 * qui assemble les constats de l'axe D, avec les deux — au même titre que
 * `constatsNegociationAcces` dans `src/runtime/dynamique.js`.
 */
import path from 'node:path';
import { constat } from '../moteur/modele.js';
import { TABLE_APPAT_ID } from '../runtime/dynamique.js';

const METHODES_SURVEILLEES = new Set(['fetchTable', 'applyUserActions']);

// Volontairement une liste de fragments littéraux plutôt qu'une expression
// régulière unique : même technique, même niveau de rigueur que B-DOC-04
// (`texte.includes(h.toLowerCase())`) — un faux négatif ici ne fait que
// garder le constat sous sa forme « non déclaré », jamais disparaître un
// vrai signal ; un faux positif dispenserait à tort un widget de la
// mention. Les deux formulations françaises retenues sont celles
// effectivement utilisées dans les README examinés (« l'ensemble du
// document », « toutes les tables »), complétées par leurs équivalents.
const FRAGMENTS_LECTURE_ETENDUE = [
  "l'ensemble du document",
  "l'ensemble des tables",
  "l'ensemble du classeur",
  "l'intégralité du document",
  "l'intégralité des tables",
  'tout le document',
  'toutes les tables',
  'chaque table',
  'entire document',
  'all tables',
  'every table',
  'whole document',
];

/**
 * Un widget en accès `full` dont le README annonce explicitement lire (ou
 * écrire sur) l'ensemble du document est honnête sur son comportement,
 * quand bien même il est gourmand : l'agent qui l'installe voit passer la
 * demande d'accès `full` et sait, avant de l'accorder, ce qu'elle recouvre.
 * Un niveau d'accès inférieur à `full` ne suffit techniquement pas à
 * atteindre d'autres tables dans un vrai Grist ; l'exiger en plus du texte
 * évite qu'une phrase généraliste sur un widget à accès restreint neutralise
 * à tort un vrai constat.
 */
function trouveDeclarationLectureEtendue(ctx) {
  const readme = ctx?.fichiers?.find(
    (f) => /^readme(\.md|\.txt)?$/i.test(path.basename(f.chemin)) && !f.chemin.includes('/'),
  );
  if (!readme?.contenu) return false;

  const acces = ctx.usagesGrist?.acces?.[0]?.niveau;
  if (acces !== 'full') return false;

  const texte = readme.contenu.toLowerCase();
  return FRAGMENTS_LECTURE_ETENDUE.some((fragment) => texte.includes(fragment));
}

/**
 * @param {{appelsRpc?: Array<{interface:string, methode:string, args:any[], t:number}>}} journal
 * @param {object} [ctx] contexte statique — README et `usagesGrist.acces` (voir `trouveDeclarationLectureEtendue`)
 */
export function analyserAccesAppat(journal, ctx) {
  if (!journal?.appelsRpc?.length) return [];

  const appels = journal.appelsRpc.filter(
    (a) => METHODES_SURVEILLEES.has(a.methode) && a.args?.[0] === TABLE_APPAT_ID,
  );
  if (!appels.length) return [];

  const methodes = [...new Set(appels.map((a) => a.methode))].join('`/`');
  const preuve = { emplacements: appels.map((a) => ({ methode: a.methode, t: a.t })) };

  if (trouveDeclarationLectureEtendue(ctx)) {
    return [constat({
      regle: 'D-PERIMETRE-01', axe: 'D', severite: 'info', bloquant: false, confiance: 'prouve',
      titre: "Lecture d'une table hors du périmètre habituel du widget, mais annoncée dans le README",
      constat: `${appels.length} appel(s) \`${methodes}\` observé(s) sur une table présente dans le document de test uniquement comme témoin, jamais sélectionnée, jamais annoncée par une colonne attendue. Le README annonce cependant explicitement une lecture (ou écriture) portant sur l'ensemble du document, cohérente avec l'accès \`full\` demandé.`,
      impact: "Une lecture large du document n'est pas un défaut quand elle est annoncée : l'agent qui installe le widget voit la demande d'accès `full` et dispose, dans le README, de l'explication de ce qu'elle recouvre avant de l'accorder.",
      remediation: "Rien à corriger sur ce point précis : le comportement observé correspond à ce que le README annonce. Vérifier seulement, au fil des évolutions du widget, que cette annonce reste à jour.",
      preuve,
    })];
  }

  return [constat({
    regle: 'D-PERIMETRE-01', axe: 'D', severite: 'critique', bloquant: true, confiance: 'prouve',
    titre: "Le widget lit ou modifie une table sans que rien — interface, déclaration ou README — ne l'annonce",
    constat: `${appels.length} appel(s) \`${methodes}\` observé(s) sur une table présente dans le document de test uniquement comme témoin, jamais sélectionnée, jamais annoncée par une colonne attendue, et que le README ne mentionne à aucun endroit comme relevant d'une lecture ou écriture portant sur l'ensemble du document.`,
    impact: "Cette table n'est révélée que par une énumération complète du document (`listTables()` puis récupération systématique de chaque table trouvée) : c'est le comportement d'un widget qui aspire tout ce qu'il peut atteindre plutôt que de se limiter à ce que sa fonction déclarée justifie. Avec un accès `full` sur un vrai document Grist, la même logique atteint des tables réelles sans aucun rapport avec le widget — RH, paie, tout ce que l'agent n'a jamais imaginé lui exposer en installant ce widget précis. Rien dans le README ne l'a prévenu que c'était possible.",
    remediation: "Si ce comportement est intentionnel, l'annoncer dans le README (rubrique « Accès au document ») : que le widget lit ou écrit sur l'ensemble du document, et pourquoi. Sinon, restreindre le widget aux tables et colonnes qu'il déclare réellement utiliser (voir `columns` dans `grist.ready()`), et ne jamais énumérer aveuglément le document avec `listTables()` suivi d'une récupération systématique de chaque table trouvée.",
    preuve,
    referentiels: ['Principe du moindre privilège', 'ANSSI — Guide d\'hygiène informatique, mesure 23'],
  })];
}
