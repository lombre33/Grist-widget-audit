/**
 * La forme de mots seule ne fait pas un leurre : une clé que son fournisseur tire au hasard n'est prise pour un leurre que si l'un de ses morceaux est, par hasard,
 * un mot de remplacement entier (une limite, dite par le dernier essai de ce fichier et comptée par `scripts/mesurer-leurres-au-hasard.mjs`).
 *
 * Relevé au chronométrage des cas neufs de ce commit : le test des « mots joints » ne jugeait que la forme. Une clé AWS tirée au hasard dont le premier signe est un
 * chiffre et les quinze autres des lettres (une sur cent) se coupe en morceaux qui ont la forme de mots, et passait pour un leurre : la règle ne la disait pas, le masque
 * non plus. Un mot de remplacement est désormais exigé (`MOTS_DE_LEURRE`). Cet essai tire des clés au hasard, toujours les mêmes (mulberry32), de chaque alphabet et de
 * chaque longueur que les fournisseurs émettent, et exige qu'aucune de ces clés ne soit un leurre, dont un nombre de clés qui ont la forme de mots : sans elles
 * l'essai ne prouve rien. Les tirages sont déterministes, sans budget de temps.
 *
 * Chaque essai a son mutant dans `scripts/mutants-c-secret.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditer } from './aide-surface.mjs';
import { estCorpsDeLeurre, formatsDans, jugerValeur, motsDeLaValeur } from '../src/regles/c-secrets.js';
import { tirer, ALNUM, URL64, BASE32 } from './aide-secrets.mjs';

const MAJ36 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LETTRES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const TIRAGES = 30000;

test('aucune des clés tirées au hasard de ces tirages n\'est un leurre, alors que des milliers ont la forme de mots', () => {
  // [alphabet, longueur, nombre de clés qui ont la forme de mots que l'essai exige au moins]. Les cinq premiers sont ceux des fournisseurs (AWS : base 32 ou majuscules et
  // chiffres, seize signes ; Stripe : vingt-quatre signes ; des clés de vingt signes ; Google : soixante-quatre signes, trente-cinq), les deux derniers des lettres seules,
  // le pire cas, qu'aucun fournisseur n'émet.
  const formes = [
    ['AWS en base 32', BASE32, 16, 150],
    ['majuscules et chiffres', MAJ36, 16, 45],
    ['base 62, seize signes', ALNUM, 16, 75],
    ['base 62, vingt signes', ALNUM, 20, 25],
    ['base 62, vingt-quatre signes (une clé Stripe)', ALNUM, 24, 12],
    ['base 64 URL, vingt signes', URL64, 20, 17],
    ['lettres seules, vingt-quatre signes', LETTRES, 24, 750],
    ['lettres seules, trente-six signes', LETTRES, 36, 300],
  ];
  for (const [nom, alphabet, longueur, attendu] of formes) {
    let formeDeMots = 0;
    const pris = [];
    for (let i = 0; i < TIRAGES; i++) {
      const corps = tirer(longueur, alphabet);
      if (motsDeLaValeur(corps) !== null) formeDeMots++;
      if (estCorpsDeLeurre(corps)) pris.push(corps);
    }
    assert.ok(formeDeMots >= attendu, `${nom} : ${formeDeMots} clés ont la forme de mots, l'essai en exige ${attendu}`);
    // Aucune de ces clés : la forme de mots et un mot de remplacement de quatre lettres au moins, ensemble, sont rares (`scripts/mesurer-leurres-au-hasard.mjs` en compte sur quatre millions de tirages, voir la limite plus bas).
    assert.deepEqual(pris, [], `${nom} : ${pris.length} sur ${TIRAGES} prises pour un leurre`);
  }
});

test('une clé AWS tirée au hasard qui a la forme de mots reste une clé : le format la voit, le constat est critique et bloquant', async () => {
  const gardees = [];
  for (let i = 0; i < 20000 && gardees.length < 25; i++) {
    const corps = tirer(16, BASE32);
    if (motsDeLaValeur(corps) !== null) gardees.push(corps);
  }
  assert.equal(gardees.length, 25, 'vingt-cinq clés qui ont la forme de mots');
  for (const corps of gardees) {
    const cle = `AK${'IA'}${corps}`;
    assert.deepEqual(formatsDans(cle).map((t) => t.format.id), ['aws'], cle.slice(0, 8));
    assert.equal(jugerValeur('apiKey', cle).pourquoi === 'leurre', false, `${cle.slice(0, 8)} n'est pas jugée leurre`);
  }
  // Bout en bout : les trois premières, dans un fichier `.env`, sont des secrets critiques et bloquants.
  const a = await auditer({ '.env': gardees.slice(0, 3).map((corps, i) => `AWS_KEY_${i}=AK${'IA'}${corps}\n`).join('') });
  assert.deepEqual(a.de('C-SECRET-01').map((c) => `${c.ligne} ${c.severite}${c.bloquant ? ' bloquant' : ''}`), ['1 critique bloquant', '2 critique bloquant', '3 critique bloquant']);
});

test('limite : une clé tirée au hasard dont un morceau est un mot de remplacement entier passe pour un leurre, une absence que la mesure compte', () => {
  // Un tirage de la mesure (graine par défaut, quatre millions par forme) : vingt-quatre signes de base 62 dont l'un des morceaux est `TEST`, les autres ayant la forme de mots.
  // Le texte est assemblé ici, à l'exécution : aucun fichier du dépôt n'a une clé.
  const corps = ['SVj', 'TEST', 'EqpjYHNUlcmceCayK'].join('');
  assert.equal(corps.length, 24);
  assert.deepEqual(motsDeLaValeur(corps), ['S', 'Vj', 'TEST', 'Eqpj', 'YHN', 'Ulcmce', 'Cay', 'K']);
  assert.equal(estCorpsDeLeurre(corps), true, 'la limite : un morceau qui est un mot de remplacement, les autres de forme de mots');
  // Elle ne tient qu'au mot de remplacement : le même tirage dont ce morceau n'en est plus un (`TESX`) n'est pas un leurre.
  assert.equal(estCorpsDeLeurre(['SVj', 'TESX', 'EqpjYHNUlcmceCayK'].join('')), false);
});
