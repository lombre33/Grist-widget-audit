/**
 * Valeurs littérales d'une expression JavaScript, lues dans l'AST : ce qu'une
 * chaîne, une concaténation de constantes, `atob('…')`, `String.fromCharCode(…)`
 * ou une URL `data:` littérale valent sans rien exécuter, et de quoi une
 * expression passée à `new Worker(…)` est faite. Partagé par l'axe C
 * (C-XSS : `eval`, `Function`, minuteurs, workers construits depuis du texte) et
 * par le repérage des chargements de module (E-DEP-01, C-EXFIL-01), qui doit
 * savoir quel fichier un worker exécute avant de dire qu'une empreinte
 * d'import map protège un import. Ces fonctions ne disent que ce que le langage
 * garantit : une valeur qu'une variable, un appel ou une entrée extérieure
 * peuvent changer n'est jamais lue comme un littéral.
 */
import { nomPointe, chaineLitterale } from './analyse-js.js';

/** Nom simple d'un appelé (`Worker`, `createObjectURL`…), sans se soucier d'un alias global de tête (`window.`, `self.`, `globalThis.`) : `nomPointe(noeud)` donne la chaîne pointée complète, on ne garde que son dernier segment. Un objet non lié à l'alias qui porte la même propriété (`monObjet.Worker`) matche aussi — un compromis que l'axe C (`c-securite.js`) fait aussi pour `eval`/`Function`/`document.write`, gardé ici pour la même raison : l'angle mort d'un nom réel manqué coûte plus qu'un faux positif rarissime. */
export function nomFinal(noeud) {
  return (nomPointe(noeud) || '').split('.').pop();
}

/**
 * Replie une concaténation de `+` entre littéraux/gabarits statiques en une
 * seule chaîne : `'al' + 'ert(1)'` vaut alors comme le littéral `'alert(1)'`,
 * pas comme une valeur « calculée à l'exécution » — le texte que produisait
 * `chaineLitterale` seul (qui ne traite pas `BinaryExpression`) était inexact
 * sur ce cas précis, relevé par la coordination le 2026-09-28 : une
 * concaténation de constantes n'est pas une inconnue, c'est un peu
 * d'arithmétique de chaînes qu'on peut faire soi-même à l'analyse. Retourne
 * null dès qu'une partie n'est pas entièrement littérale (variable, appel).
 */
export function plierLitteraux(noeud) {
  if (!noeud) return null;
  const direct = chaineLitterale(noeud);
  if (direct !== null) return direct;
  if (noeud.type === 'BinaryExpression' && noeud.operator === '+') {
    const gauche = plierLitteraux(noeud.left);
    if (gauche === null) return null;
    const droite = plierLitteraux(noeud.right);
    if (droite === null) return null;
    return gauche + droite;
  }
  return null;
}

/** `atob(x)` retourne toujours une chaîne : si `x` est lui-même littéral (ou une concaténation qui se replie), son décodage est aussi peu une boîte noire qu'un littéral direct. */
export function decoderAtobLitteral(noeud) {
  if (noeud?.type !== 'CallExpression' || nomFinal(noeud.callee) !== 'atob' || noeud.arguments.length !== 1) return null;
  const arg = plierLitteraux(noeud.arguments[0]);
  if (arg === null) return null;
  try { return Buffer.from(arg, 'base64').toString('utf8'); } catch { return null; }
}

/**
 * `String.fromCharCode(...)` retourne toujours une chaîne : si tous ses
 * arguments sont des codes numériques littéraux, son résultat est aussi peu
 * une boîte noire qu'un littéral direct — comme `atob()`. La comparaison
 * tolère un alias global de tête (`window.String.fromCharCode`,
 * `self.String.fromCharCode`…), comme le fait déjà `nomFinal`
 * pour `eval`/`Function`/`document.write` : une correspondance
 * exacte manquait cette forme pourtant courante en code minifié/empaqueté
 * (relevé par la coordination le 2026-09-28).
 */
export function decoderFromCharCodeLitteral(noeud) {
  if (noeud?.type !== 'CallExpression' || !/(^|\.)String\.fromCharCode$/.test(nomPointe(noeud.callee) || '') || !noeud.arguments.length) return null;
  const codes = [];
  for (const a of noeud.arguments) {
    if (a.type !== 'Literal' || typeof a.value !== 'number') return null;
    codes.push(a.value);
  }
  return String.fromCharCode(...codes);
}

/**
 * Un littéral NON-chaîne (`null`, un nombre, un booléen) a une valeur
 * entièrement déterminée à la lecture : `ToString()` la fixe sans ambiguïté
 * (`String(null) === 'null'`, `String(42) === '42'`…), exactement comme une
 * chaîne littérale directe. Exclut une regex littérale (`/x/`), dont la
 * valeur n'est pas un primitif simple à coercer ainsi. `null` retourné
 * signifie ici « n'est pas un tel littéral », pas « vaut null » — comme le
 * reste des fonctions `plierLitteraux`/`decoder*Litteral` de ce fichier.
 */
export function coercerLitteralNonChaine(noeud) {
  if (noeud?.type !== 'Literal' || typeof noeud.value === 'string' || noeud.regex) return null;
  return String(noeud.value);
}

/** Partie littérale de tête d'une chaîne de `+` (`'data:...' + code` → `'data:...'`), ou d'un gabarit (son premier segment fixe). null si le nœud ne commence par rien de littéral. */
export function prefixeConcatenationLitteral(noeud) {
  if (!noeud) return null;
  if (noeud.type === 'Literal' && typeof noeud.value === 'string') return noeud.value;
  if (noeud.type === 'TemplateLiteral') return noeud.quasis[0]?.value.cooked ?? null;
  if (noeud.type === 'BinaryExpression' && noeud.operator === '+') return prefixeConcatenationLitteral(noeud.left);
  return null;
}

/** Classe une chaîne littérale résolue (ou son préfixe) par son schéma. */
function classifierSchemaLitteral(texte) {
  const t = texte.trim();
  if (/^(data|blob):/i.test(t)) return 'code-en-chaine';
  if (/^https?:\/\//i.test(t)) return 'url-absolue';
  return 'chemin-local';
}

/**
 * Un préfixe littéral de tête (concaténation, gabarit interpolé) ne peut
 * décider QUE le cas `code-en-chaine` : une fois le schéma `data:`/`blob:`
 * confirmé en tête, aucune suite ne peut plus le changer. Il ne décide
 * jamais `chemin-local` : une suite inconnue (variable de sélection du
 * fichier) peut désigner n'importe quel fichier, que l'analyse ne peut pas
 * énumérer — ce cas reste `non-resolue`, pas un chemin réputé sûr.
 */
function estPrefixeCodeEnChaine(noeud) {
  const prefixe = prefixeConcatenationLitteral(noeud);
  return prefixe !== null && /^(data|blob):/i.test(prefixe.trim());
}

/** Le texte que porte une URL `data:` littérale, décodé (base64 compris) ; null quand ce n'est pas une URL `data:`. */
function decoderDataLitteral(lit) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(lit.trim());
  if (!m) return null;
  if (/;base64\s*$/i.test(m[1])) {
    try { return Buffer.from(m[2], 'base64').toString('utf8'); } catch { return null; }
  }
  try { return decodeURIComponent(m[2]); } catch { return m[2]; }
}

/**
 * Extrait le texte du code exécuté par un Worker/SharedWorker classé
 * `code-en-chaine`, quand il est ENTIÈREMENT littéral (data: littérale — y
 * compris en base64 — ou Blob dont TOUS les éléments du tableau sont des
 * littéraux). Retourne null si une partie est calculée (variable, `atob()`,
 * concaténation avec une variable) : ce contenu reste hors de portée, comme
 * avant — c'est là qu'est le vrai risque, pas dans un littéral qu'on peut lire.
 */
export function extraireCodeLitteralWorker(arg) {
  // `plierLitteraux` (pas seulement `chaineLitterale`) : une URL data:/blob:
  // ou un élément de tableau assemblés par concaténation de CONSTANTES
  // (`'data:...,' + '...'`, `Blob(['a' + 'b'])`) sont tout aussi littéraux
  // qu'écrits en une seule chaîne — sans ce repli, ce cas précis retombait
  // à tort dans le texte « calculé à l'exécution : rien n'est lu », alors
  // qu'il n'y a rien de calculé (relevé par la coordination le 2026-09-28).
  const lit = plierLitteraux(arg);
  if (lit !== null) return decoderDataLitteral(lit);

  if (arg.type === 'CallExpression' && nomFinal(arg.callee) === 'createObjectURL') {
    const blob = arg.arguments[0];
    if (blob?.type === 'NewExpression' && nomFinal(blob.callee) === 'Blob' && blob.arguments[0]?.type === 'ArrayExpression') {
      // Chaque élément du tableau peut être un littéral direct, une
      // concaténation de constantes (`plierLitteraux`), OU lui-même encodé
      // (`atob(...)`, `String.fromCharCode(...)`) : un eval() équivalent
      // décode déjà ces deux formes (voir `traiterAppelExecution`, dans `c-securite.js`), le même
      // contenu caché dans un Worker doit recevoir le même traitement, pas
      // rester à tort « pas entièrement littéral » (relevé par la
      // coordination le 2026-09-28).
      const morceaux = blob.arguments[0].elements.map((el) => plierLitteraux(el) ?? decoderAtobLitteral(el) ?? decoderFromCharCodeLitteral(el));
      if (morceaux.length && morceaux.every((m) => m !== null)) return morceaux.join('');
    }
  }

  // `new URL('data:...')` : classifierSourceWorker fait déjà dépendre la
  // classification du seul premier argument, quelle que soit la base
  // (voir sa documentation) — extraire le contenu suit le même
  // raisonnement, en ignorant `arg.arguments[1]` de la même façon. Sans
  // cette branche, ce cas précis retombait à tort dans le texte « contenu
  // pas entièrement littéral », alors qu'il l'est.
  if (arg.type === 'NewExpression' && nomFinal(arg.callee) === 'URL') {
    return extraireCodeLitteralWorker(arg.arguments[0]);
  }

  return null;
}

/**
 * Classe la source passée à `new Worker(...)`/`new SharedWorker(...)`.
 * Vérifié par l'exécution (vraie Chromium) : un `importScripts()` vers un
 * domaine externe, sans aucun en-tête CORS, s'exécute aussi bien depuis un
 * worker `blob:` que depuis un worker `data:` — ni l'un ni l'autre n'a de
 * mécanisme d'intégrité, et surtout ni l'un ni l'autre n'est un fichier que
 * l'audit peut lire. Reconnaît un alias global de tête (`window.Worker`,
 * `self.URL.createObjectURL`…) via `nomFinal()`.
 *
 * - 'chemin-local' : chemin relatif littéral (`./w.js`), ou
 *   `new URL('./w.js', <base quelconque>)` — déjà suivi par
 *   `referencesSortantes()` pour la surface exécutée, rien à signaler ici.
 *   C'est le SCHÉMA du premier argument de `new URL(...)` qui décide, jamais
 *   sa base : si ce premier argument résout en `data:`/`blob:`, l'URL
 *   obtenue l'est aussi quelle que soit la base (ces schémas s'auto-suffisent
 *   et ignorent la base par construction) ; s'il est relatif, le résultat
 *   est local quelle que soit la base — et si la base est elle-même une URL
 *   absolue externe écrite en dur, le résultat est une URL absolue externe,
 *   qui retombe dans le cas 'url-absolue' ci-dessous (mort par construction,
 *   donc sans risque réel) : rien de ce qu'une base peut faire ne rend ce
 *   raisonnement par le seul premier argument incorrect.
 * - 'url-absolue' : URL http(s) littérale — lève toujours une
 *   `SecurityError` synchrone (vérifié), donc jamais exécutée : rien à
 *   signaler (voir be1b5f4, C-EXFIL-07 retirée pour cette raison).
 * - 'code-en-chaine' : une URL `data:`/`blob:` littérale ou obtenue par
 *   concaténation/gabarit, ou tout appel à `createObjectURL(...)` (quel que
 *   soit son propre argument — Blob littéral, Blob depuis une variable, ou
 *   variable déjà porteuse d'un Blob/File : aucune de ces formes n'est un
 *   fichier que l'audit peut lire, la question de fond est la même dans
 *   tous les cas). Signalé quel que soit le CONTENU, au même titre qu'`eval()`
 *   est signalé quel que soit son argument : chercher une source de confiance
 *   dans ce contenu ne prouve rien, et ne pas le faire n'enlève rien à la
 *   question de fond, qui est la construction elle-même — récupérer un
 *   contenu (déjà vu par C-EXFIL-01/02 si le Blob vient d'un `fetch`) et
 *   l'exécuter comme du code sont deux faits distincts, comme un `eval()` de
 *   la réponse d'un `fetch` relève à la fois de C-EXFIL et d'`eval`.
 * - 'non-resolue' : tout le reste (variable, gabarit interpolé, expression
 *   calculée) — y compris une URL `blob:` assemblée dans une instruction
 *   précédente, que l'analyse d'une seule expression ne peut pas remonter.
 */
export function classifierSourceWorker(arg) {
  if (!arg) return 'non-resolue';

  const lit = chaineLitterale(arg);
  if (lit !== null) return classifierSchemaLitteral(lit);
  if (estPrefixeCodeEnChaine(arg)) return 'code-en-chaine';

  if (arg.type === 'CallExpression' && nomFinal(arg.callee) === 'createObjectURL') {
    return 'code-en-chaine';
  }

  if (arg.type === 'NewExpression' && nomFinal(arg.callee) === 'URL') {
    const xLit = chaineLitterale(arg.arguments[0]);
    if (xLit !== null) return classifierSchemaLitteral(xLit);
    if (estPrefixeCodeEnChaine(arg.arguments[0])) return 'code-en-chaine';
  }

  return 'non-resolue';
}
