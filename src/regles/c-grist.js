/**
 * Axe C — négociation du niveau d'accès Grist (C-GRIST-01 à 04).
 *
 * Ce que le widget demande (`grist.ready({ requiredAccess })`) et ce qu'il fait
 * de l'API document (écrire, lire hors de sa table liée, changer la structure)
 * se lisent dans l'AST, en suivant l'objet `grist` à travers les variables, les
 * déstructurations, `await` et les chaînes optionnelles.
 *
 * Le suivi se fait par NOM sur tout le widget, sans portée : un nom réutilisé
 * pour autre chose peut faire voir un usage de plus, jamais en cacher un. Quand
 * un objet de l'API est transmis ou rangé ailleurs que dans une variable, ce
 * qu'on en fait n'est plus lu (`opaque`) : aucun constat ne s'appuie alors sur
 * l'absence d'un usage, qui n'est pas établie.
 */
import { constat } from '../moteur/modele.js';
import { pourChaqueUniteJs, chaineLitterale } from '../moteur/analyse-js.js';
import { plierLitteraux } from '../moteur/litteraux.js';

const GLOBALES = new Set(['window', 'self', 'globalThis', 'top', 'parent']);
const OBJETS = new Set(['grist', 'docApi', 'table']);
const ECRITURES_DE_TABLE = new Set(['create', 'update', 'destroy', 'upsert']);
const LECTURES_DE_LA_TABLE_LIEE = new Set(['docApi.fetchSelectedTable', 'docApi.fetchSelectedRecord']);
// Actions utilisateur qui changent la structure du document, et celles qui n'écrivent que des enregistrements (de structure si la table est `_grist_*`).
const ACTIONS_DE_SCHEMA = new Set(['AddTable', 'AddEmptyTable', 'RemoveTable', 'RenameTable', 'DuplicateTable', 'AddColumn', 'AddVisibleColumn', 'AddHiddenColumn', 'RemoveColumn', 'RenameColumn', 'ModifyColumn']);
const ACTIONS_D_ENREGISTREMENT = new Set(['AddRecord', 'BulkAddRecord', 'UpdateRecord', 'BulkUpdateRecord', 'RemoveRecord', 'BulkRemoveRecord', 'ReplaceTableData']);

const nomDeCle = (p) => (p.computed || p.key.type !== 'Identifier' ? chaineLitterale(p.key) : p.key.name);
const nomDeMembre = (m) => (m.computed ? chaineLitterale(m.property) : m.property.type === 'Identifier' ? m.property.name : null);

/** `grist.docApi` et `grist.selectedTable` sont des objets ; tout autre membre d'un objet connu se nomme `objet.membre` (`grist.ready`, `table.update`). */
function membre(objet, nom) {
  if (objet === 'grist' && nom === 'docApi') return 'docApi';
  if (objet === 'grist' && nom === 'selectedTable') return 'table';
  return `${objet}.${nom}`;
}

/** Le chemin que suit une expression à partir d'un nom : `grist.getTable()` donne `['grist', 'getTable', '()']`. Null si l'expression n'est pas un tel chemin. `window.grist` vaut `grist`. */
function chemin(n) {
  switch (n?.type) {
    case 'Identifier': return [n.name];
    case 'AwaitExpression': return chemin(n.argument);
    case 'ChainExpression': return chemin(n.expression);
    case 'CallExpression': { const c = chemin(n.callee); return c && [...c, '()']; }
    case 'MemberExpression': {
      const nom = nomDeMembre(n);
      const c = nom && chemin(n.object);
      if (!c) return null;
      return nom === 'grist' && c.length === 1 && GLOBALES.has(c[0]) ? ['grist'] : [...c, nom];
    }
    default: return null;
  }
}

/** Ce qu'un chemin désigne dans l'API Grist : `grist`, `docApi`, `table`, `objet.membre` (`grist.ready`, `table.update`), ou null. */
function resoudre(c, liaisons) {
  let desc = c && (c[0] === 'grist' ? 'grist' : liaisons.get(c[0]));
  for (let i = 1; desc && i < c.length; i++) desc = c[i] === '()' ? (desc === 'grist.getTable' ? 'table' : null) : membre(desc, c[i]);
  return desc ?? null;
}

const origine = (n, liaisons) => resoudre(chemin(n), liaisons);

/** Ce que reçoit un motif de variable, sous une forme qui ne garde pas l'arbre : `{ nom }`, ou `{ proprietes: [[clé, nom]] }` pour `const { docApi, ready } = …`. */
function motifDe(motif) {
  if (motif.type === 'Identifier') return { nom: motif.name };
  if (motif.type !== 'ObjectPattern') return null;
  const proprietes = [];
  for (const p of motif.properties) {
    const cible = p.value?.type === 'AssignmentPattern' ? p.value.left : p.value;
    if (p.type === 'Property' && cible?.type === 'Identifier') proprietes.push([nomDeCle(p), cible.name]);
  }
  return { proprietes };
}

/** Ajoute à `liaisons` ce que `motif` reçoit d'un objet de l'API (`const t = grist.getTable()`). Vrai si une liaison est nouvelle. */
function lier({ nom, proprietes }, c, liaisons) {
  const objet = resoudre(c, liaisons);
  if (!objet) return false;
  const cibles = nom ? [[nom, objet]] : proprietes.filter(([cle]) => cle).map(([cle, cible]) => [cible, membre(objet, cle)]);
  let nouvelle = false;
  for (const [cible, desc] of cibles) {
    if (!liaisons.has(cible)) { liaisons.set(cible, desc); nouvelle = true; }
  }
  return nouvelle;
}

// Source gardée en mémoire (options de `grist.ready`, listes d'actions) : l'arbre d'une unité n'est jamais gardé. Au-delà, le suivi s'arrête et `opaque` le dit.
const BUDGET_DE_SOURCE = 200_000;

/** Les liaisons de l'API, les constantes et les `push` de tout le widget (voir l'en-tête : par nom, sans portée). */
function relever(ctx) {
  const declarations = [];
  const importes = [];
  const valeurs = new Map();
  const comptes = new Map();
  const ajouts = new Map();
  let budget = BUDGET_DE_SOURCE;
  let tronque = false;
  const compter = (nom) => comptes.set(nom, (comptes.get(nom) ?? 0) + 1);
  const garder = (n) => {
    if (n.end - n.start > budget) { tronque = true; return null; }
    budget -= n.end - n.start;
    return n;
  };
  const declarer = (motif, valeur) => {
    const c = chemin(valeur);
    const m = c && motifDe(motif);
    if (m) declarations.push([m, c]);
  };
  pourChaqueUniteJs(ctx, {}, ({ ast, walk }) => {
    walk.simple(ast, {
      VariableDeclarator(n) {
        if (n.id.type === 'Identifier') {
          compter(n.id.name);
          const liste = n.init?.type === 'ObjectExpression' || n.init?.type === 'ArrayExpression';
          valeurs.set(n.id.name, { texte: plierLitteraux(n.init), noeud: liste ? garder(n.init) : null });
        }
        if (n.init) declarer(n.id, n.init);
      },
      AssignmentExpression(n) {
        if (n.left.type === 'Identifier') compter(n.left.name);
        if (n.operator === '=') declarer(n.left, n.right);
      },
      ImportSpecifier(n) { importes.push([n.local.name, n.imported.name ?? n.imported.value]); },
      CallExpression(n) {
        if (n.callee.type !== 'MemberExpression' || n.callee.object.type !== 'Identifier' || nomDeMembre(n.callee) !== 'push') return;
        const nom = n.callee.object.name;
        ajouts.set(nom, [...(ajouts.get(nom) ?? []), ...n.arguments.map(garder).filter(Boolean)]);
      },
    });
  });
  const liaisons = new Map();
  for (let tour = 0, change = true; change && tour < 4; tour++) {
    change = false;
    for (const [motif, c] of declarations) change = lier(motif, c, liaisons) || change;
    for (const [local, importe] of importes) {
      if (liaisons.has(importe) && !liaisons.has(local)) { liaisons.set(local, liaisons.get(importe)); change = true; }
    }
  }
  // Une constante : déclarée une seule fois, jamais réécrite.
  const valeur = (nom) => (comptes.get(nom) === 1 ? valeurs.get(nom) : undefined);
  return { liaisons, ajouts, tronque, texte: (nom) => valeur(nom)?.texte ?? null, noeud: (nom) => valeur(nom)?.noeud ?? null };
}

const litteral = (n, suivi) => plierLitteraux(n) ?? (n?.type === 'Identifier' ? suivi.texte(n.name) : null);

/** Le niveau que dit un appel à `grist.ready` : `{ niveau }`, `{ absent }` (aucune propriété `requiredAccess`) ou `{ illisible }` (déclaré, mais pas lisible dans le code). */
function niveauDemande(arg, suivi) {
  if (!arg) return { absent: true };
  const options = arg.type === 'Identifier' ? suivi.noeud(arg.name) : arg;
  if (options?.type !== 'ObjectExpression') return { illisible: true };
  const prop = options.properties.find((p) => p.type === 'Property' && nomDeCle(p) === 'requiredAccess');
  if (!prop) return options.properties.some((p) => p.type === 'SpreadElement') ? { illisible: true } : { absent: true };
  const niveau = litteral(prop.value, suivi);
  return niveau === null ? { illisible: true } : { niveau };
}

/** Les actions de structure d'un appel à `applyUserActions` : le tableau d'actions, ou la variable qui le porte (`const lot = […]`, `lot.push(…)`), ou une action rangée dans une variable. */
function actionsDeSchema(noeud, suivi, profondeur = 0) {
  if (!noeud || profondeur > 3) return [];
  const suite = (n) => actionsDeSchema(n, suivi, profondeur + 1);
  if (noeud.type === 'Identifier') return [suivi.noeud(noeud.name), ...(suivi.ajouts.get(noeud.name) ?? [])].flatMap(suite);
  if (noeud.type === 'SpreadElement') return suite(noeud.argument);
  if (noeud.type !== 'ArrayExpression') return [];
  const [tete, table] = noeud.elements;
  const nom = litteral(tete, suivi);
  if (nom === null) return noeud.elements.flatMap(suite);          // une liste d'actions
  const enregistrements = ACTIONS_D_ENREGISTREMENT.has(nom) && String(litteral(table, suivi)).startsWith('_grist_');
  return ACTIONS_DE_SCHEMA.has(nom) || enregistrements ? [noeud] : [];
}

/** Vrai si l'objet de l'API qu'`ancetres` désigne (le dernier) est utilisé ailleurs que comme objet d'un membre, source d'une variable ou valeur ignorée. */
function echappe(ancetres) {
  let i = ancetres.length - 2;
  while (i > 0 && (ancetres[i].type === 'AwaitExpression' || ancetres[i].type === 'ChainExpression')) i--;
  const parent = ancetres[i];
  const enfant = ancetres[i + 1];
  switch (parent?.type) {
    case 'MemberExpression': return parent.object !== enfant || (parent.computed && chaineLitterale(parent.property) === null);
    case 'VariableDeclarator': return parent.init === enfant && parent.id.type === 'ArrayPattern';
    case 'AssignmentExpression': return parent.right === enfant && parent.left.type !== 'Identifier';
    case 'ExpressionStatement': return false;
    default: return true;
  }
}

function releverUsages(ctx, suivi) {
  const usages = { ready: [], acces: [], accesIllisible: [], horsTableLiee: [], ecriture: [], ecritureSchema: [], opaque: suivi.tronque };
  pourChaqueUniteJs(ctx, {}, ({ unite, ast, ligneDe, walk }) => {
    const verifier = (n, _etat, ancetres) => {
      if (OBJETS.has(origine(n, suivi.liaisons)) && echappe(ancetres)) usages.opaque = true;
    };
    walk.ancestor(ast, {
      Identifier: verifier,
      MemberExpression: verifier,
      CallExpression(n, etat, ancetres) {
        verifier(n, etat, ancetres);
        const appel = origine(n.callee, suivi.liaisons);
        if (!appel) return;
        const loc = { fichier: unite.chemin, ligne: ligneDe(n), appel };
        if (appel === 'grist.ready') {
          usages.ready.push(loc);
          const demande = niveauDemande(n.arguments[0], suivi);
          if (demande.niveau) usages.acces.push({ ...loc, niveau: demande.niveau });
          if (demande.illisible) usages.accesIllisible.push(loc);
        } else if (appel === 'docApi.applyUserActions') {
          usages.ecriture.push(loc);
          for (const action of actionsDeSchema(n.arguments[0], suivi)) usages.ecritureSchema.push({ ...loc, ligne: ligneDe(action) });
        } else if (appel.startsWith('table.') && ECRITURES_DE_TABLE.has(appel.slice('table.'.length))) {
          usages.ecriture.push(loc);
        } else if ((appel.startsWith('docApi.') && !LECTURES_DE_LA_TABLE_LIEE.has(appel)) || appel === 'grist.getAccessToken' || (appel === 'grist.getTable' && n.arguments.length)) {
          usages.horsTableLiee.push(loc);
        }
      },
    });
  });
  return usages;
}

/** Relève le niveau d'accès demandé et l'usage réel de l'API document. */
export function analyserAccesGrist(ctx) {
  const usages = releverUsages(ctx, relever(ctx));
  ctx.usagesGrist = usages;
  const constats = [];

  if (!usages.ready.length && !usages.opaque) {
    constats.push(constat({
      regle: 'C-GRIST-01', axe: 'C', severite: 'majeur', confiance: 'certain',
      titre: "Le widget n'appelle jamais grist.ready()",
      constat: "Aucun appel à `grist.ready()` n'a été trouvé dans le code exécuté.",
      impact: "Sans cet appel, le widget ne déclare ni son niveau d'accès ni ses colonnes attendues : Grist ne peut pas lui transmettre de données, et l'agent n'a aucun écran de consentement décrivant ce que le widget va lire.",
      remediation: "Appeler `grist.ready({ requiredAccess: '<niveau>', columns: [...] })` au chargement.",
      referentiels: ['Documentation Grist — Custom widgets / grist.ready()'],
    }));
  }

  if (usages.ready.length && !usages.acces.length) {
    const illisible = usages.accesIllisible.length > 0;
    constats.push(constat({
      regle: 'C-GRIST-02', axe: 'C', severite: 'majeur', confiance: illisible ? 'probable' : 'certain',
      titre: illisible ? "Le niveau d'accès demandé ne se lit pas dans le code" : "Le niveau d'accès demandé n'est pas déclaré explicitement",
      fichier: usages.ready[0].fichier, ligne: usages.ready[0].ligne,
      constat: illisible
        ? "`grist.ready()` reçoit un `requiredAccess` que le code ne donne pas en clair (valeur calculée, venue d'ailleurs ou réécrite)."
        : "`grist.ready()` est appelé sans propriété `requiredAccess`.",
      impact: illisible
        ? "Ni l'audit ni l'agent qui relit le code ne peuvent savoir quel niveau le widget demande à Grist."
        : "Le widget repose sur le niveau par défaut, qui peut changer selon la version de Grist et selon ce que l'agent a coché. Le comportement du widget devient dépendant de l'environnement.",
      remediation: "Déclarer explicitement le niveau minimal nécessaire, en littéral : `none`, `read table`, ou `full`.",
    }));
  }

  const emplacement = usages.acces.find((a) => a.niveau === 'full');
  if (emplacement) {
    const ecrit = usages.ecriture.length > 0;
    const lectureElargie = !ecrit && usages.horsTableLiee.length > 0;
    const probable = !ecrit && (lectureElargie || usages.opaque);
    constats.push(constat({
      regle: 'C-GRIST-03', axe: 'C', severite: ecrit || probable ? 'majeur' : 'critique', confiance: probable ? 'probable' : 'certain',
      titre: ecrit
        ? "Accès `full` demandé, avec écriture effective dans le document"
        : lectureElargie
          ? "Accès `full` demandé, avec lecture au-delà de la table liée"
          : probable
            ? "Accès `full` demandé, sans que le code montre ce qu'il en fait"
            : "Accès `full` demandé alors qu'aucune écriture n'a été détectée",
      fichier: emplacement.fichier, ligne: emplacement.ligne,
      constat: ecrit
        ? `Le widget demande \`requiredAccess: 'full'\` et réalise ${usages.ecriture.length} appel(s) d'écriture (\`applyUserActions\` / \`create\` / \`update\` / \`destroy\` / \`upsert\`).`
        : lectureElargie
          ? `Le widget demande \`requiredAccess: 'full'\` et appelle ${usages.horsTableLiee.length} fonction(s) du document au-delà de sa table liée (${[...new Set(usages.horsTableLiee.map((a) => a.appel))].join(', ')}), qui demandent ce niveau. Aucune écriture n'a été trouvée.`
          : probable
            ? "Le widget demande `requiredAccess: 'full'` ; l'objet `grist`, ou une table, est transmis ou rangé ailleurs que dans une variable : l'audit ne peut pas établir si le widget écrit."
            : `Le widget demande \`requiredAccess: 'full'\` mais n'a aucune écriture ni lecture au-delà de sa table liée : il ne fait que lire cette table.`,
      impact: "`full` donne au widget la lecture ET l'écriture de toutes les tables du document, y compris celles sans rapport avec sa fonction, ainsi que l'accès aux métadonnées. En cas de faille dans le widget ou dans une de ses dépendances, c'est le document entier qui est exposé.",
      remediation: ecrit || probable
        ? "Documenter dans le README pourquoi `full` est nécessaire, quelles tables sont lues ou écrites et dans quelles conditions. C'est la première question que posera l'équipe Grist.Gouv à la revue de sécurité."
        : "Rétrograder en `read table` : le widget ne fait que lire sa table liée. `full` est ici un privilège inutile, et donc une surface d'attaque gratuite.",
      referentiels: ['Principe du moindre privilège', 'ANSSI — Guide d\'hygiène informatique, mesure 23'],
    }));
  }

  if (usages.ecritureSchema.length) {
    const p = usages.ecritureSchema[0];
    constats.push(constat({
      regle: 'C-GRIST-04', axe: 'C', severite: 'majeur', confiance: 'certain',
      titre: 'Le widget modifie la structure du document, pas seulement les données',
      fichier: p.fichier, ligne: p.ligne,
      constat: `${usages.ecritureSchema.length} action(s) de schéma détectée(s) (création, renommage ou suppression de table ou de colonne, ou écriture dans les tables de structure).`,
      impact: "Une erreur de logique peut détruire des colonnes de l'agent, sans que Grist ne puisse distinguer cette action d'une action volontaire de l'utilisateur.",
      remediation: 'Confirmer explicitement auprès de l\'agent avant toute action de schéma, et documenter ces actions dans le README.',
      preuve: { emplacements: usages.ecritureSchema },
    }));
  }

  return constats;
}
