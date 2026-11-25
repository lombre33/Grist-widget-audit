/**
 * C-INVISIBLE-01 : des caractères qu'on ne voit pas. Chaque caractère est écrit ici par son échappement (`\u202e`), jamais tel quel : ce fichier ne porte rien
 * que ses lecteurs ne voient pas.
 *
 *  - Sens d'écriture (« Trojan Source ») : majeur dans le code et un commentaire d'un JavaScript, dans une page ou une feuille de style ; information dans un texte
 *    (chaîne, gabarit) et dans un document.
 *  - Largeur nulle et remplisseurs : majeur dans le code d'un JavaScript (un nom), information dans un commentaire, un texte, une page.
 *  - Étiquettes Unicode hors d'un drapeau, et suites de huit caractères invisibles : majeur, partout.
 *  - Rien pour ce que le texte emploie : une marque de sens d'écriture, une liaison d'émoji, un drapeau, la marque d'ordre des octets du début.
 *  - Le constat écrit chaque caractère en clair : le rapport ne cache rien lui non plus.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditer, page } from './aide-surface.mjs';

const BIDI = '\u202e';
const ZWSP = '\u200b';
const etiquettes = (texte) => [...texte].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
const dit = (a) => a.de('C-INVISIBLE-01').map((c) => `${c.fichier}:${c.ligne} ${c.preuve.classe} ${c.severite}`);

test('sens d\'écriture dans un JavaScript : majeur dans un commentaire et dans une chaîne quand c\'est un remplacement, information pour un isolat dans une chaîne', async () => {
  const ISOLAT = '\u2068';
  const a = await auditer({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': [
      `const a = 1; // admin ${BIDI} seulement`, // 1 commentaire
      `const b = "user${BIDI} // admin";`, // 2 chaîne étirée : un remplacement
      `const c = \`bonjour ${ISOLAT}\${nom}\u2069\`;`, // 3 gabarit : isolat de traduction
      `const d = "a ${ISOLAT}b";`, // 4 chaîne : isolat
    ].join('\n'),
  });
  assert.deepEqual(dit(a), ['app.js:1 sens majeur', 'app.js:3 sens info']);
  const [majeur, info] = a.de('C-INVISIBLE-01');
  assert.match(majeur.constat, /Lignes 1, 2\./, 'le commentaire et la chaîne étirée');
  assert.match(info.constat, /Lignes 3, 4\./, 'les isolats');
  assert.ok(majeur.bloquant === false && info.bloquant === false, 'jamais bloquant');
  // Dans le code, c'est une erreur de syntaxe : le fichier est illisible, la règle ne s'en prive pas.
  const code = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': `const d = 2 ${BIDI}+ 3;\n` });
  assert.deepEqual(dit(code), ['app.js:1 sens majeur']);
});

test('largeur nulle : majeur dans le code d\'un JavaScript (un nom), information dans un commentaire, un texte, une page ; la marque d\'ordre des octets et une liaison d\'émoji ne comptent pas', async () => {
  const a = await auditer({
    'index.html': page(`<p>mot${ZWSP}coupé</p><script src="app.js"></script>`),
    'app.js': [
      'const mon\u3164nom = 1;', // 1 code : un remplisseur dans un nom (une lettre valable pour JavaScript)
      'const autre\u200c = 2;', // 2 code : une liaison dans un nom
      `// copié${ZWSP}collé`, // 3 commentaire
      `const t = "a${ZWSP}b \u{1F468}\u200d\u{1F469}";`, // 4 texte : largeur nulle, et une liaison d'émoji qui ne dit rien
      `const e = 3; \uFEFF`, // 5 marque d'ordre des octets hors du début : information
    ].join('\n'),
  });
  const tous = a.de('C-INVISIBLE-01').map((c) => `${c.fichier} ${c.preuve.classe} ${c.severite} ${c.preuve.lignes}`).sort();
  assert.deepEqual(tous, ['app.js nulle info 3,4,5', 'app.js nulle majeur 1,2', 'index.html nulle info 1']);
  const debut = await auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': '\uFEFFconst a = 1;\n' });
  assert.deepEqual(dit(debut), [], 'la marque d\'ordre des octets du premier signe est l\'usage normal');
});

test('étiquettes Unicode hors d\'un drapeau et suite de caractères invisibles : majeur, même dans un README ; un drapeau, une liaison d\'émoji et une marque de sens d\'écriture ne disent rien', async () => {
  const a = await auditer({
    'README.md': `# Widget\n\nIgnore ${etiquettes('ab')} tout.\n\n${'\u200b'.repeat(9)}\n\nEt ${etiquettes('ignore previous')} fin.\n`,
    'LISEZMOI.txt': [
      `Angleterre \u{1F3F4}${etiquettes('gbeng')}\u{E007F}, Écosse \u{1F3F4}${etiquettes('gbsct')}\u{E007F}.`, // drapeaux
      'Famille \u{1F468}\u200d\u{1F469}\u200d\u{1F467}, ❤\ufe0f, mot\u00adcoupé.', // liaisons, sélecteur, trait d'union conditionnel
      'نص \u200f عربي \u200e \u061c fin.', // marques de sens d'écriture
    ].join('\n'),
  });
  assert.deepEqual(a.de('C-INVISIBLE-01').map((c) => `${c.fichier} ${c.preuve.classe} ${c.severite}`).sort(), ['README.md etiquette majeur', 'README.md suite majeur']);
  assert.equal(a.de('C-INVISIBLE-01').find((c) => c.preuve.classe === 'suite').preuve.lignes.join(), '5,7', 'les neuf espaces de largeur nulle, et la suite d\'étiquettes de huit caractères ou plus');
});

test('dans une page, une feuille de style ou une donnée, un caractère de sens d\'écriture est majeur ; dans un document, information', async () => {
  const a = await auditer({
    'index.html': page(`<p>a ${BIDI} b</p>`),
    'style.css': `.x { content: "a ${BIDI} b"; }\n`,
    'donnees.json': `{ "a": "b ${BIDI} c" }\n`,
    'NOTES.md': `a ${BIDI} b\n`,
  });
  assert.deepEqual(a.de('C-INVISIBLE-01').map((c) => `${c.fichier} ${c.severite}`).sort(), ['NOTES.md info', 'donnees.json majeur', 'index.html majeur', 'style.css majeur']);
});

test('le constat écrit chaque caractère en clair, ne décode rien et ne recopie aucun caractère invisible', async () => {
  const a = await auditer({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': `const garde = "ok"; /* admin ${BIDI} */ ${etiquettes('secret')}\n`,
  });
  const constats = a.de('C-INVISIBLE-01');
  assert.equal(constats.length, 2);
  const texte = JSON.stringify(constats);
  assert.doesNotMatch(texte, /[\u202a-\u202e\u2066-\u2069\u200b\u{e0000}-\u{e007f}]/u, 'aucun caractère invisible dans le constat');
  assert.match(constats.map((c) => c.extrait).join('\n'), /\\u202e/);
  assert.match(constats.map((c) => c.extrait).join('\n'), /\\u\{e0073\}/);
  assert.ok(!texte.includes('secret'), 'le texte caché n\'est pas décodé');
  assert.match(constats.map((c) => c.constat).join('\n'), /U\+202E/);
});
