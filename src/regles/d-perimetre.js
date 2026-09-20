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
 * `applyUserActions` avec son identifiant), qu'aucune fonction déclarée ne
 * justifie jamais.
 *
 * Cette fonction ne fait qu'interpréter `journal.appelsRpc` (produit par
 * `creerHoteGrist`, voir sa doc) : elle doit être appelée par le code qui
 * assemble les constats de l'axe D, avec le `journal` de l'exécution — au
 * même titre que `constatsNegociationAcces` dans `src/runtime/dynamique.js`.
 */
import { constat } from '../moteur/modele.js';
import { TABLE_APPAT_ID } from '../runtime/dynamique.js';

const METHODES_SURVEILLEES = new Set(['fetchTable', 'applyUserActions']);

/** @param {{appelsRpc?: Array<{interface:string, methode:string, args:any[], t:number}>}} journal */
export function analyserAccesAppat(journal) {
  if (!journal?.appelsRpc?.length) return [];

  const appels = journal.appelsRpc.filter(
    (a) => METHODES_SURVEILLEES.has(a.methode) && a.args?.[0] === TABLE_APPAT_ID,
  );
  if (!appels.length) return [];

  return [constat({
    regle: 'D-PERIMETRE-01', axe: 'D', severite: 'critique', bloquant: true, confiance: 'prouve',
    titre: "Le widget a lu ou modifié une table qu'aucune interface ni déclaration ne lui montrait",
    constat: `${appels.length} appel(s) \`${[...new Set(appels.map((a) => a.methode))].join('`/`')}\` observé(s) sur une table présente dans le document de test uniquement comme témoin, jamais sélectionnée, jamais annoncée par une colonne attendue.`,
    impact: "Cette table n'est révélée que par une énumération complète du document (`listTables()` puis récupération systématique de chaque table trouvée) : c'est le comportement d'un widget qui aspire tout ce qu'il peut atteindre plutôt que de se limiter à ce que sa fonction déclarée justifie. Avec un accès `full` sur un vrai document Grist, la même logique atteint des tables réelles sans aucun rapport avec le widget — RH, paie, tout ce que l'agent n'a jamais imaginé lui exposer en installant ce widget précis.",
    remediation: "Restreindre le widget aux tables et colonnes qu'il déclare réellement utiliser (voir `columns` dans `grist.ready()`), et ne jamais énumérer aveuglément le document avec `listTables()` suivi d'une récupération systématique de chaque table trouvée.",
    preuve: { emplacements: appels.map((a) => ({ methode: a.methode, t: a.t })) },
    referentiels: ['Principe du moindre privilège', 'ANSSI — Guide d\'hygiène informatique, mesure 23'],
  })];
}
