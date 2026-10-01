/**
 * `src/moteur/texte-du-widget.js` : un texte que le widget choisit, cité dans le texte d'un constat. Chaque essai compare la sortie à un texte écrit ici, à la main
 * (aucun ne recalcule la réponse avec le code qu'il éprouve) ; un lecteur indépendant de l'extrait de code du Markdown, écrit d'après la définition de CommonMark, relit
 * ce que `citer` écrit et doit retrouver le texte neutralisé, pour des milliers de textes tirés au hasard. Aucun essai ne compare un temps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { neutraliser, citer, citerSiBesoin } from '../src/moteur/texte-du-widget.js';

/**
 * Ce que lit un lecteur CommonMark d'un extrait de code (un « code span » : une suite de guillemets inversés, le contenu, une suite de même longueur), ou `null` si
 * la chaîne n'est pas un extrait de code entier. La définition : une suite de guillemets inversés n'est précédée ni suivie d'un autre ; l'extrait s'ouvre par une suite et se
 * ferme à la première suite de même longueur qui la suit ; dans le contenu, les fins de ligne deviennent des espaces, puis une espace est retirée de chaque bout si le
 * contenu commence et finit par une espace sans être fait d'espaces seules.
 */
function lireExtraitDeCode(chaine) {
  const ouverture = /^`+/.exec(chaine);
  if (!ouverture) return null;
  const n = ouverture[0].length;
  const fermeture = [...chaine.matchAll(/`+/g)].find((suite) => suite.index > 0 && suite[0].length === n);
  if (!fermeture || fermeture.index + n !== chaine.length) return null;
  let contenu = chaine.slice(n, fermeture.index).replace(/\r\n|\r|\n/g, ' ');
  if (contenu.startsWith(' ') && contenu.endsWith(' ') && !/^ *$/.test(contenu)) contenu = contenu.slice(1, -1);
  return contenu;
}

const INVISIBLES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

test('neutraliser : chaque caractère qu\'on ne voit pas s\'écrit en clair, le reste est laissé', () => {
  const cas = [
    ['\u0000', '\\u0000'], ['\u0007', '\\u0007'], ['\t', '\\u0009'], ['\n', '\\u000a'], ['\r', '\\u000d'], ['\u001b', '\\u001b'], ['\u007f', '\\u007f'],
    ['\u0085', '\\u0085'], ['\u009b', '\\u009b'],                                   // contrôles C1, dont l'introducteur de séquence de contrôle
    [' ', '\\u2028'], [' ', '\\u2029'],                                   // séparateurs de ligne et de paragraphe
    ['­', '\\u00ad'], ['​', '\\u200b'], ['‍', '\\u200d'], ['‎', '\\u200e'], ['‮', '\\u202e'], ['⁦', '\\u2066'], ['﻿', '\\ufeff'], // formats : trait d'union conditionnel, largeur nulle, sens d'écriture, marque d'ordre des octets
    ['\u{e0067}', '\\u{e0067}'],                                                    // une étiquette, hors du plan de base
    ['\ud83d', '�'], ['\ude00', '�'],                                     // une moitié de paire de substitution : U+FFFD
  ];
  for (const [entree, attendu] of cas) assert.equal(neutraliser(`a${entree}b`), `a${attendu}b`, JSON.stringify(entree));
  // Ce qui se voit, et ce que le Markdown ou le HTML lisent autrement, reste : la citation, non la neutralisation, le protège.
  for (const visible of ['abc', 'é à ç', '日本語', '😀', '👍🏽', '<b>x</b>', 'a|b', '`x`', '# titre', 'x-->y', '[a](b)', 'a b', ' ', ' ', '�', '…']) {
    assert.equal(neutraliser(visible), visible, JSON.stringify(visible));
  }
  assert.equal(neutraliser(''), '');
  assert.equal(neutraliser('\r\n# titre\r\n| a | b |'), '\\u000d\\u000a# titre\\u000d\\u000a| a | b |');
  assert.equal(neutraliser('👨‍👩'), '👨\\u200d👩', 'le lien de largeur nulle d\'un emoji composé est dit aussi : il cache un caractère');
});

test('citer : le texte neutralisé dans un extrait de code du Markdown, à la barre qu\'il faut', () => {
  const cas = [
    ['abc', '`abc`'],
    ['<b>x</b>', '`<b>x</b>`'],
    ['a|b', '`a|b`'],
    ['x-->y', '`x-->y`'],
    ['# titre', '`# titre`'],
    ['https://projet.supabase.invalid/auth/v1', '`https://projet.supabase.invalid/auth/v1`'],
    ['a`b', '``a`b``'],                      // une suite d'un guillemet inversé dans le texte : la barre en a deux
    ['a``b', '```a``b```'],
    ['a`b``c', '```a`b``c```'],
    ['`x', '`` `x ``'],                      // le texte commence par un guillemet inversé : calé d'une espace que le Markdown retire
    ['x`', '`` x` ``'],
    ['`x`', '`` `x` ``'],
    ['``', '``` `` ```'],
    [' x', '`  x `'],                        // commence ou finit par une espace : calé aussi, sans quoi le Markdown la retirerait
    ['x ', '` x  `'],
    [' x ', '`  x  `'],
    ['   ', '`   `'],                        // fait d'espaces seules : le Markdown n'en retire aucune, aucune cale
    ['a\nb', '`a\\u000ab`'],
    ['\u001b[31mrouge\u001b[0m', '`\\u001b[31mrouge\\u001b[0m`'],
    ['\u001b]0;titre\u0007', '`\\u001b]0;titre\\u0007`'],
    ['a‮b', '`a\\u202eb`'],
    [' # titre', '`\\u2028# titre`'],
    ['a\ud83db', '`a�b`'],
    ['😀', '`😀`'],
  ];
  for (const [texte, attendu] of cas) assert.equal(citer(texte), attendu, JSON.stringify(texte));
});

test('citer : un lecteur CommonMark retrouve le texte neutralisé, en un seul extrait de code et sans rien autour, pour tout texte', () => {
  // Les mêmes tirages à chaque lancement (mulberry32), sur un alphabet qui a tout ce qui compte pour un extrait de code.
  let x = 20260930 >>> 0;
  const alea = () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = ['`', '`', '`', ' ', ' ', '<', '>', '|', '\n', '\r', '\t', 'x', 'é', '\u001b', '‮', ' ', '😀', '\ud83d', '#', '-', '*', '[', ']', '(', ')', '!', '\\', '&'];
  let avecGuillemets = 0;
  let avecCale = 0;
  for (let i = 0; i < 6000; i++) {
    const longueur = 1 + Math.floor(alea() * 12);
    let texte = '';
    for (let k = 0; k < longueur; k++) texte += alphabet[Math.floor(alea() * alphabet.length)];
    const cite = citer(texte);
    assert.equal(lireExtraitDeCode(cite), neutraliser(texte), `${JSON.stringify(texte)} → ${JSON.stringify(cite)}`);
    assert.ok(!INVISIBLES.test(cite), `${JSON.stringify(cite)} porte un caractère invisible`);
    if (texte.includes('`')) avecGuillemets++;
    const vu = neutraliser(texte);
    if (!/^ *$/.test(vu) && /^[ `]|[ `]$/.test(vu)) avecCale++;
  }
  // L'essai ne prouve rien s'il ne tire pas ce qui fait la difficulté.
  assert.ok(avecGuillemets > 2000, `${avecGuillemets} textes à guillemets inversés`);
  assert.ok(avecCale > 1000, `${avecCale} textes qui commencent ou finissent par une espace ou un guillemet inversé`);
});

test('le lecteur de l\'essai lit un extrait de code comme CommonMark, et refuse ce qui n\'en est pas un', () => {
  assert.equal(lireExtraitDeCode('`a`'), 'a');
  assert.equal(lireExtraitDeCode('``a`b``'), 'a`b');
  assert.equal(lireExtraitDeCode('`` `x ``'), '`x');
  assert.equal(lireExtraitDeCode('`  x `'), ' x');
  assert.equal(lireExtraitDeCode('`   `'), '   ');
  assert.equal(lireExtraitDeCode('`a\nb`'), 'a b');
  assert.equal(lireExtraitDeCode('`a`b`'), null, 'la fermeture est la première suite de même longueur : du texte suit');
  assert.equal(lireExtraitDeCode('``a`'), null, 'aucune suite de deux guillemets ne ferme');
  assert.equal(lireExtraitDeCode('a`b`'), null);
  assert.equal(lireExtraitDeCode('`a` et `b`'), null);
});

// Les caractères qu'une sortie lit comme autre chose que lui-même : la liste est écrite ici, pour qu'on ne l'élargisse ni ne la réduise sans le dire.
const FRAGILES = ['`', '<', '>', '&', '|', '*', '[', ']', '\\', '~', '#', '!', '(', ')', '{', '}', '$', '@'];
const HONNETES = ['api_key', 'API-KEY', 'apiKey', 'db.password', 'x-api-key', 'données.clé', 'mot de passe', 'Clé API', "l'api", 'a"b', 'user:password', 'a/b', 'a=b', 'a+b', 'a%b', 'a^b', 'a?b', 'a;b', 'a,b', '100', 'a b', 'é', '日本語'];

test('citerSiBesoin : dit tel quel le texte qu\'aucune sortie ne lit autrement, cite les autres', () => {
  for (const texte of HONNETES) assert.equal(citerSiBesoin(texte), texte, `${texte} : un nom honnête est dit tel quel`);
  for (const c of FRAGILES) {
    for (const texte of [`a${c}b`, `${c}ab`, `ab${c}`]) assert.equal(citerSiBesoin(texte), citer(texte), `${c} : ${texte}`);
  }
  for (const c of ['\u0000', '\u001b', '\n', '\r', '\t', '\u007f', '\u0085', ' ', ' ', '​', '‮', '﻿', '­', '\u{e0067}']) {
    assert.equal(citerSiBesoin(`a${c}b`), citer(`a${c}b`), `U+${c.codePointAt(0).toString(16)}`);
  }
  assert.equal(citerSiBesoin('api`key'), '``api`key``');
  assert.equal(citerSiBesoin('@octocat'), '`@octocat`');
});
