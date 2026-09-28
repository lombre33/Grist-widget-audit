import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';
import { genererHtml } from '../src/rapport/html.js';

/**
 * Une carte qui regroupe les constats d'une règle compte ses occurrences
 * comme la notation et la feuille de route : une information n'en est pas
 * une (relevé par la coordination le 2026-09-28 : un critique et quatre
 * informations s'affichaient « 5 occurrences », la feuille de route en
 * comptait une).
 */

function titreDeCarte(severites) {
  const constats = severites.map((severite, i) => constat({ regle: 'C-XSS-04', axe: 'C', titre: 'Source de setTimeout', severite, constat: 'c', fichier: 'w.js', ligne: i + 1 }));
  const html = genererHtml({ ctx: { fichiers: [], surface: new Set() }, notation: noter(constats, new Set(['D'])), meta: { nomDepot: 'x', version: '0' } });
  return html.match(/constat-groupe[\s\S]*?<span class="constat-titre">([^<]*)<\/span>/)[1];
}

test('une carte groupée distingue les occurrences des informations', () => {
  assert.match(titreDeCarte(['critique', 'info', 'info', 'info', 'info']), /^1 occurrence et 4 informations — /);
  assert.match(titreDeCarte(['majeur', 'mineur', 'info', 'mineur', 'info']), /^3 occurrences et 2 informations — /);
});

test('une carte groupée sans information, ou sans occurrence, ne cite que ce qu\'elle contient', () => {
  assert.match(titreDeCarte(['mineur', 'mineur', 'mineur', 'mineur', 'mineur']), /^5 occurrences — /);
  assert.match(titreDeCarte(['info', 'info', 'info', 'info', 'info']), /^5 informations — /);
});
