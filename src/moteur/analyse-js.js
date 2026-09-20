/**
 * Couche d'analyse syntaxique JavaScript.
 *
 * On préfère un AST à des expressions régulières partout où c'est possible :
 * une regexp qui cherche « eval( » se déclenche sur un commentaire, sur une
 * chaîne de caractères ou sur `medieval(`. Dans un rapport d'audit, un faux
 * positif coûte la confiance du lecteur — c'est le défaut le plus grave que
 * puisse avoir un outil comme celui-ci.
 */
import { parse } from 'acorn';
import * as walk from 'acorn-walk';

/**
 * Extrait les unités de code JavaScript d'un fichier : le fichier entier pour
 * un .js, chaque <script> inline pour un .html.
 * @returns {Array<{chemin:string, source:string, decalageLigne:number, inline:boolean}>}
 */
export function unitesJs(fichier) {
  if (fichier.binaire || !fichier.contenu) return [];
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(fichier.ext)) {
    return [{ chemin: fichier.chemin, source: fichier.contenu, decalageLigne: 0, inline: false }];
  }
  if (!['.html', '.htm'].includes(fichier.ext)) return [];

  const unites = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of fichier.contenu.matchAll(re)) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;                       // script externe : traité ailleurs
    if (/\btype\s*=\s*["'](?!module|text\/javascript|application\/javascript)/i.test(attrs)) continue; // template, json-ld…
    unites.push({
      chemin: fichier.chemin,
      source: m[2],
      decalageLigne: fichier.contenu.slice(0, m.index).split('\n').length - 1,
      inline: true,
    });
  }
  return unites;
}

/** Parse une unité. Renvoie null si le code est syntaxiquement invalide (TS, JSX exotique…). */
export function parser(source) {
  for (const sourceType of ['module', 'script']) {
    try {
      return parse(source, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true });
    } catch { /* on tente l'autre mode */ }
  }
  return null;
}

/**
 * Parcourt toutes les unités JS du contexte en appelant `visiteur` avec
 * l'AST et un utilitaire `signaler(noeud, …)` qui gère le décalage de ligne
 * des scripts inline.
 */
export function pourChaqueUniteJs(contexte, { surfaceSeulement = false } = {}, visiteur) {
  for (const f of contexte.fichiers) {
    if (surfaceSeulement && !f.executee) continue;
    for (const u of unitesJs(f)) {
      const ast = parser(u.source);
      if (!ast) { visiteur({ unite: u, ast: null, fichier: f, ligneDe: () => null, walk }); continue; }
      const ligneDe = (noeud) => (noeud?.loc?.start?.line ?? 0) + u.decalageLigne;
      visiteur({ unite: u, ast, fichier: f, ligneDe, walk });
    }
  }
}

/** Reconstitue le nom pointé d'un MemberExpression : `grist.docApi.fetchTable`. */
export function nomPointe(noeud) {
  const parts = [];
  let n = noeud;
  while (n) {
    if (n.type === 'Identifier') { parts.unshift(n.name); break; }
    if (n.type === 'ThisExpression') { parts.unshift('this'); break; }
    if (n.type === 'MemberExpression') {
      if (n.computed) {
        if (n.property.type === 'Literal') parts.unshift(String(n.property.value));
        else parts.unshift('[]');
      } else parts.unshift(n.property.name);
      n = n.object;
      continue;
    }
    if (n.type === 'CallExpression') { parts.unshift('()'); n = n.callee; continue; }
    return parts.length ? parts.join('.') : null;
  }
  return parts.join('.');
}

/** Extrait la valeur d'un littéral chaîne, y compris un template sans expression. */
export function chaineLitterale(noeud) {
  if (!noeud) return null;
  if (noeud.type === 'Literal' && typeof noeud.value === 'string') return noeud.value;
  if (noeud.type === 'TemplateLiteral' && noeud.expressions.length === 0) return noeud.quasis.map((q) => q.value.cooked).join('');
  return null;
}

/** Vrai si l'expression n'est pas une chaîne entièrement littérale (donc potentiellement dynamique). */
export function estDynamique(noeud) {
  if (!noeud) return false;
  if (noeud.type === 'Literal') return false;
  if (noeud.type === 'TemplateLiteral') return noeud.expressions.length > 0;
  if (noeud.type === 'BinaryExpression' && noeud.operator === '+') return estDynamique(noeud.left) || estDynamique(noeud.right);
  return true;
}
