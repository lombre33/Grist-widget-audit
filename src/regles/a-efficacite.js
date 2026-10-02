/**
 * Axe A — Efficacité : deux motifs de lenteur que la lecture du code suffit à établir, dits en information.
 *
 * Ce que coûte une boucle dépend de la taille de la table que le widget lit, et le code ne la dit pas : une règle qui
 * pénaliserait un motif sans la connaître se tromperait plus souvent qu'elle n'aurait raison. Ces deux motifs se
 * reconnaissent sans elle, et restent des informations, sans pénalité : le constat dit où ils sont, l'auditeur juge si la
 * boucle est assez longue pour compter. Le reste (recherche répétée sur les lignes de la table, boucles imbriquées,
 * accumulateur recopié, interrogation d'une table que Grist pousse déjà) demande de savoir d'où viennent les données :
 * c'est le jugement que `docs/PROMPT-AUDIT-LLM.md` laisse à l'auditeur IA.
 */
import { constat } from '../moteur/modele.js';
import { pourChaqueUniteJs, nomPointe } from '../moteur/analyse-js.js';

const BOUCLES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const FONCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
/** Les méthodes de tableau qui appellent leur rappel une fois par élément. */
const PARCOURS = new Set(['forEach', 'map', 'filter', 'flatMap', 'reduce', 'some', 'every', 'find', 'findIndex']);

/** Les emplacements que la preuve garde : un dépôt qui répète un motif dix mille fois n'écrit pas dix mille lignes. */
const MAX_EMPLACEMENTS = 50;

/**
 * Ce qui répète l'exécution d'un nœud : une boucle dont il est dans le corps (ni dans son en-tête, évalué une fois), ou, avec `avecRappels`, le rappel
 * qu'un parcours de tableau appelle par élément. La remontée s'arrête à la première fonction : un rappel écrit dans une boucle ne s'y exécute pas
 * forcément à chaque tour. `ancetres` : ceux d'acorn-walk, le nœud lui-même en dernier.
 */
function estRepete(ancetres, avecRappels) {
  for (let i = ancetres.length - 2; i >= 0; i--) {
    const a = ancetres[i];
    if (BOUCLES.has(a.type) && a.body === ancetres[i + 1]) return true;
    if (!FONCTIONS.has(a.type)) continue;
    const appel = ancetres[i - 1];
    return avecRappels && appel?.type === 'CallExpression' && appel.arguments.includes(a)
      && appel.callee.type === 'MemberExpression' && PARCOURS.has(appel.callee.property.name);
  }
  return false;
}

/** Un appel qui sort du navigateur : l'API de Grist (`grist.docApi.fetchTable`, `grist.getTable().update`…), `fetch`, ou `applyUserActions` et `fetchTable` d'un `docApi` rangé dans une variable. */
const estAppelDistant = (nom) => /^(?:grist\.|(?:window\.|self\.|globalThis\.)?fetch$)|\.(?:applyUserActions|fetchTable)$/.test(nom);

const estInnerHtml = (membre) => membre.type === 'MemberExpression' && !membre.computed && membre.property.name === 'innerHTML';

/** Un constat par motif pour tout le dépôt, au premier emplacement, les autres dans la preuve. */
function constatDuMotif(trouvailles, { regle, titre, constat: texte, impact, remediation }) {
  if (!trouvailles.length) return null;
  const { fichier, ligne } = trouvailles[0];
  return constat({
    regle, axe: 'A', severite: 'info', confiance: 'probable',
    titre: titre(trouvailles.length), fichier, ligne, constat: texte, impact, remediation,
    preuve: {
      emplacements: trouvailles.slice(0, MAX_EMPLACEMENTS),
      ...(trouvailles.length > MAX_EMPLACEMENTS ? { omis: trouvailles.length - MAX_EMPLACEMENTS } : {}),
    },
  });
}

export function analyserEfficacite(ctx) {
  const appels = [];
  const concatenations = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.ancestor(ast, {
      AwaitExpression(n, _etat, ancetres) {
        const nom = n.argument.type === 'CallExpression' ? nomPointe(n.argument.callee) : null;
        if (nom && estAppelDistant(nom) && estRepete(ancetres, false)) appels.push({ fichier: unite.chemin, ligne: ligneDe(n) });
      },
      AssignmentExpression(n, _etat, ancetres) {
        if (n.operator === '+=' && estInnerHtml(n.left) && estRepete(ancetres, true)) concatenations.push({ fichier: unite.chemin, ligne: ligneDe(n) });
      },
    });
  });

  return [
    constatDuMotif(appels, {
      regle: 'A-PERF-01',
      titre: (n) => `${n} appel(s) à Grist ou au réseau attendu(s) un à un dans une boucle`,
      constat: "Un appel à l'API de Grist ou à `fetch` est attendu (`await`) à chaque tour d'une boucle : les appels s'exécutent l'un après l'autre, chacun attendant la réponse du précédent.",
      impact: "Avec N tours, le temps total est N fois la durée d'un aller-retour : mille lignes font mille allers-retours en série. Le motif signale un risque, sans conséquence si la boucle est courte, et voulu quand l'ordre des écritures ou une limite de débit l'exige.",
      remediation: "Regrouper les appels en un seul (une liste d'actions pour `applyUserActions`, la table entière pour `fetchTable`), ou lancer les appels indépendants ensemble avec `Promise.all`, si l'ordre et la limite de débit le permettent.",
    }),
    constatDuMotif(concatenations, {
      regle: 'A-PERF-02',
      titre: (n) => `${n} \`innerHTML +=\` dans une boucle ou un parcours`,
      constat: "Un `innerHTML +=` s'exécute à chaque tour d'une boucle (ou à chaque élément d'un parcours) : le navigateur relit et reconstruit à chaque fois tout le contenu déjà posé.",
      impact: "Avec N éléments, le temps croît comme N², et les écouteurs ou l'état des éléments déjà créés sont perdus à chaque tour. Le motif signale un risque, sans conséquence sur une liste courte.",
      remediation: "Accumuler le HTML dans une chaîne ou un tableau puis l'affecter une fois, ou construire les éléments (`createElement`, `DocumentFragment`) et les ajouter d'un coup.",
    }),
  ].filter(Boolean);
}
