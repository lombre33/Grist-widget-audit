/**
 * C-SECRET-01 et les clés des services d'IA : un attaquant équipé d'une IA balaie les dépôts publics à la recherche de ces clés (elles se
 * revendent, ou se dépensent), et un widget ne peut pas en détenir une.
 *
 *  - Chaque fournisseur (Anthropic, Hugging Face, Groq, OpenRouter, xAI, Perplexity, Replicate) est un format : critique, bloquant, quel que
 *    soit le nom de la variable qui la porte (`CLE_ANTHROPIC`, pas seulement `apiKey`).
 *  - Ce qui se voit faux derrière le préfixe n'en est pas une, et un identifiant de code qui commence comme une clé (`hf_calculer…`) non plus.
 *  - `Authorization: 'Bearer <clé>'` : la clé d'un service sans format reconnaissable (Mistral) est jugée comme celle d'un « nom = valeur » ;
 *    un gabarit, une concaténation et un texte de remplacement ne disent rien.
 *  - Aucun rapport ne redit une clé de ce genre, y compris dans l'extrait d'une autre règle (l'appel qui la porte).
 *
 * Aucun secret n'est écrit ici : chaque valeur est assemblée à l'exécution (un hébergeur refuse de recevoir un dépôt qui en contient un).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditer } from './aide-surface.mjs';
import { tirer, ALNUM, URL64, HEX } from './aide-secrets.mjs';
import { masquerLesSecrets } from '../src/regles/c-secrets.js';

const C_SECRET = (a) => a.de('C-SECRET-01');
const dit = (a) => C_SECRET(a).map((c) => `${c.fichier}:${c.ligne} ${c.severite}${c.bloquant ? ' bloquant' : ''}`);

const CLES = [
  ['Anthropic', `sk${'-ant-api03-'}${tirer(93, URL64)}`],
  ['Anthropic (administration)', `sk${'-ant-admin01-'}${tirer(93, URL64)}`],
  ['Hugging Face', `hf${'_'}${tirer(34, ALNUM)}`],
  ['Groq', `gsk${'_'}${tirer(52, ALNUM)}`],
  ['OpenRouter', `sk${'-or-v1-'}${tirer(64, HEX)}`],
  ['xAI', `xai${'-'}${tirer(80, ALNUM)}`],
  ['Perplexity', `pplx${'-'}${tirer(48, ALNUM)}`],
  ['Replicate', `r8${'_'}${tirer(37, ALNUM)}`],
];

test('la clé de chaque service d\'IA est un secret critique et bloquant, dans une variable au nom que l\'outil ne connaît pas, et le rapport ne la redit pas', async () => {
  for (const [nom, cle] of CLES) {
    const a = await auditer({ 'app.js': `const MA_CLE_DE_SERVICE = '${cle}';\nvar autre = 1;\n`, 'README.md': `# Widget\n\nCe widget parle à un service.\n` });
    assert.deepEqual(dit(a), ['app.js:1 critique bloquant'], nom);
    assert.ok(!JSON.stringify(C_SECRET(a)).includes(cle.slice(8, 40)), `${nom} : le constat ne redit pas la clé`);
  }
});

test('ce qui se voit faux derrière le préfixe d\'une clé d\'IA n\'est pas une clé : des x, une suite, des mots de remplacement', async () => {
  const leurres = [
    `sk${'-ant-api03-'}${'x'.repeat(90)}`, `sk${'-ant-api03-'}your-api-key-goes-here-your-api-key-goes-here-your-api-key-goes-here`,
    `hf${'_'}${'x'.repeat(34)}`, `gsk${'_'}${'0'.repeat(52)}`, `xai${'-'}${'x'.repeat(80)}`, `pplx${'-'}${'x'.repeat(48)}`, `r8${'_'}${'x'.repeat(37)}`,
    `sk${'-or-v1-'}${'0'.repeat(64)}`,
  ];
  const a = await auditer({ 'app.js': leurres.map((v, i) => `var v${i} = '${v}';`).join('\n') });
  assert.deepEqual(dit(a), []);
});

test('un identifiant de code qui commence comme une clé d\'IA n\'est pas une clé : des mots en casse mixte derrière hf_, gsk_ ou r8_', async () => {
  const identifiants = [
    `hf${'_'}calculateTheTotalPriceForCustomerX`, `gsk${'_'}${'getUserProfileFromTheRemoteServer'.repeat(2).slice(0, 52)}`, `r8${'_'}${'renderTheMainTableForTheView'.repeat(2).slice(0, 37)}`,
  ];
  for (const v of identifiants) assert.match(v, /^[a-z0-9]+_[A-Za-z0-9]+$/, 'la forme d\'une clé : le préfixe, puis des signes alphanumériques');
  const a = await auditer({ 'app.js': identifiants.map((v, i) => `var v${i} = '${v}';`).join('\n') });
  assert.deepEqual(dit(a), []);
});

test('Authorization: Bearer <clé> : la clé d\'un service sans format reconnaissable est un secret ; un texte de remplacement, un gabarit et une concaténation ne disent rien', async () => {
  const cle = tirer(32, ALNUM); // la forme d'une clé Mistral : trente-deux signes, aucun préfixe
  const a = await auditer({
    'app.js': [
      `const entetes = { Authorization: 'Bearer ${cle}', 'content-type': 'application/json' };`, // 1 : lu
      `const proxy = { 'Proxy-Authorization': 'Token ${tirer(32, ALNUM)}' };`, // 2 : lu
      `const modele = { Authorization: 'Bearer YOUR_API_KEY' };`, // 3 : texte de remplacement
      'const gabarit = { Authorization: `Bearer ${maCle}` };', // 4 : gabarit, aucun littéral
      `const somme = { Authorization: 'Bearer ' + maCle };`, // 5 : concaténation
      `const court = { Authorization: 'Bearer abc' };`, // 6 : trop court pour être une clé
      `const autre = { Accept: 'Bearer ${tirer(32, ALNUM)}' };`, // 7 : pas un en-tête d'autorisation
    ].join('\n'),
  });
  assert.deepEqual(dit(a), ['app.js:1 critique bloquant', 'app.js:2 critique bloquant']);
  assert.ok(!JSON.stringify(C_SECRET(a)).includes(cle.slice(6, 26)), 'le constat ne redit pas la clé');
});

test('masquerLesSecrets : la clé qui suit « Bearer » est masquée dans le texte d\'une autre règle, sauf un texte de remplacement', () => {
  const cle = tirer(32, ALNUM);
  const extrait = `fetch(url, { headers: { Authorization: 'Bearer ${cle}' } })`;
  const masque = masquerLesSecrets(extrait);
  assert.ok(!masque.includes(cle.slice(4, 28)), masque);
  assert.match(masque, /Bearer \S{4}…\S{4} \(32 caractères\)/);
  const remplacement = `fetch(url, { headers: { Authorization: 'Bearer YOUR_API_KEY_GOES_HERE' } })`;
  assert.equal(masquerLesSecrets(remplacement), remplacement, 'un texte de remplacement reste lisible');
  // Hors d'un extrait de code (la prose d'un constat), rien n'est masqué : le texte est celui de l'outil.
  assert.equal(masquerLesSecrets(`Bearer ${cle}`, { code: false }), `Bearer ${cle}`);
});
