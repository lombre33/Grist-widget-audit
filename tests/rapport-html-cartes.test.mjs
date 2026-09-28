import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';
import { genererHtml } from '../src/rapport/html.js';

/**
 * Cartes qui regroupent plus de quatre constats d'une règle (relevé par la
 * coordination le 2026-09-28). Elles comptent leurs occurrences comme la
 * notation et la feuille de route : une information n'en est pas une. Et
 * chaque constat regroupé reste joignable depuis la liste des points
 * bloquants, qui pointait dans le vide pour 68 bloquants sur 70 dans le
 * rapport réel de publipostageGrist.
 */

function page(constats) {
  return genererHtml({ ctx: { fichiers: [], surface: new Set() }, notation: noter(constats, new Set(['D'])), meta: { nomDepot: 'x', version: '0' } });
}

function occurrences(severites, extra = {}) {
  return severites.map((severite, i) => constat({ regle: 'C-XSS-04', axe: 'C', titre: 'Source de setTimeout', severite, constat: 'c', fichier: 'w.js', ligne: i + 1, ...extra }));
}

const titreDeCarte = (severites) => page(occurrences(severites)).match(/constat-groupe[\s\S]*?<span class="constat-titre">([^<]*)<\/span>/)[1];
const enteteDeCarte = (html) => html.match(/<details class="constat constat-groupe"[\s\S]*?<\/summary>/)[0];

test('une carte groupée distingue les occurrences des informations', () => {
  assert.match(titreDeCarte(['critique', 'info', 'info', 'info', 'info']), /^1 occurrence et 4 informations — /);
  assert.match(titreDeCarte(['majeur', 'mineur', 'info', 'mineur', 'info']), /^3 occurrences et 2 informations — /);
});

test('une carte groupée sans information, ou sans occurrence, ne cite que ce qu\'elle contient', () => {
  assert.match(titreDeCarte(['mineur', 'mineur', 'mineur', 'mineur', 'mineur']), /^5 occurrences — /);
  assert.match(titreDeCarte(['info', 'info', 'info', 'info', 'info']), /^5 informations — /);
});

test('chaque lien de la liste des points bloquants vise un élément de la page, même regroupé', () => {
  const html = page([...occurrences(['critique', 'critique', 'critique', 'critique', 'critique'], { bloquant: true }), constat({ regle: 'C-SEUL', axe: 'C', titre: 't', severite: 'critique', bloquant: true, constat: 'c' })]);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const liens = [...html.matchAll(/<a href="#([^"]+)">/g)].map((m) => m[1]);
  assert.equal(liens.length, 6);
  for (const lien of liens) assert.ok(ids.has(lien), `lien sans cible : #${lien}`);
});

test('une carte groupée porte le badge BLOQUANT dès qu\'un de ses membres est bloquant, et seulement alors', () => {
  const unBloquant = [...occurrences(['info', 'info', 'info', 'info']), ...occurrences(['critique'], { bloquant: true })];
  assert.match(enteteDeCarte(page(unBloquant)), /badge-bloquant/);
  assert.doesNotMatch(enteteDeCarte(page(occurrences(['critique', 'info', 'info', 'info', 'info']))), /badge-bloquant/);
});
