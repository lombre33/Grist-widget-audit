/**
 * Budgets de temps du lecteur CSS et de C-EXFIL-03 (src/moteur/css.js, src/regles/c-securite.js), déplacés de
 * `tests/passe-html-css.test.mjs` : en V2, un quadratique sur une entrée de un mégaoctet est un déni de service, et
 * chaque piège ci-dessous en a été un (ou a failli l'être). Voir scripts/lib/budgets.mjs : ce n'est pas la suite
 * par défaut qui les mesure, mais `scripts/verifier-budgets.mjs`. Ce que les cas vérifient en plus du temps (les
 * constats rendus, la borne dite) reste vérifié dans la suite par défaut, sur des entrées qui n'ont pas besoin
 * d'un mégaoctet (`tests/passe-html-css.test.mjs`).
 */
import assert from 'node:assert/strict';
import { analyserRessourcesExternes, chargementsDeFichier } from '../../src/regles/c-securite.js';

const MIO = 1 << 20;
const fichier = (chemin, contenu, extra = {}) => ({ chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra });
const bornes = (html) => chargementsDeFichier(fichier('index.html', html)).filter((e) => e.borne);
const constatsExfil = (fichiers) => analyserRessourcesExternes({ fichiers }).filter((c) => c.regle === 'C-EXFIL-03');
const jusqua = (n, f) => Array.from({ length: n }, (_, i) => f(i));

const PIEGES_CSS = {
  'accolades ouvrantes': '{'.repeat(MIO),
  'parenthèses ouvrantes': '('.repeat(MIO),
  '@media imbriqués': '@media x{'.repeat(MIO / 9),
  'url( sans fin': 'a{b:url('.repeat(MIO / 8),
  '@import répétés': '@import url(a.css);'.repeat(MIO / 19),
  '@import à chaînes': '@import "a.css" screen;'.repeat(MIO / 23),
  'commentaires ouverts': '/*'.repeat(MIO / 2),
  'échappements': '\\'.repeat(MIO),
  'chaînes ouvertes': '"'.repeat(MIO),
  'data: dans des url(': 'a{b:url(data:text/css,'.repeat(MIO / 22),
  '@import data: de base64 invalide': '@import url("data:text/css;base64,!!!!");'.repeat(MIO / 40),
};

const PIEGES_PAGE = {
  'link à srcset': '<link rel=preload as=image imagesrcset="a 1x, b 2x, c 3x">'.repeat(MIO / 60),
  'candidats de srcset': `<link rel=preload as=image imagesrcset="${'a,'.repeat(MIO / 2)}">`,
  'candidats à parenthèses': `<link rel=preload as=image imagesrcset="${'a ('.repeat(MIO / 3)}">`,
  'style ouverts': '<style>@import url(a.css);'.repeat(MIO / 26),
  'link data:': "<link rel=stylesheet href='data:text/css,@import url(a.css);'>".repeat(MIO / 60),
  'attributs style': '<p style="background:url(a.png)">'.repeat(MIO / 34),
  'gabarits de style': '<template><style>@import url(a.css);</style>'.repeat(MIO / 45),
};

const BLANCS = ' '.repeat(MIO);
const PIEGES_BLANCS = {
  'url() entre guillemets': `<style>a{b:url("${BLANCS}x")}</style>`,
  'url() sans guillemets': `<style>a{b:url(${BLANCS}x${BLANCS})}</style>`,
  '@import': `<style>@import "${BLANCS}x";</style>`,
  'data: à blancs': `<link rel=stylesheet href='data:text/css,${BLANCS}x'>`,
  'href': `<link rel=stylesheet href="${BLANCS}x${BLANCS}">`,
  'type': `<link rel=stylesheet type="${BLANCS}x" href=a.css>`,
  'rel': `<link rel="${BLANCS}x${BLANCS}" href=a.css>`,
  'imagesrcset': `<link rel=preload as=image imagesrcset="${','.repeat(MIO / 2)}x">`,
  'style=': `<p style="${BLANCS}background:url(a.png)${BLANCS}">`,
  '@import de blancs': `<style>${'@import "  ";'.repeat(MIO / 13)}</style>`,
};

const N = 40000;
const PIEGES_REFERENCES = {
  '.css, une ligne': () => [fichier('a.css', jusqua(N, (i) => `.a${i}{background:url(https://e.example/${i}.png)}`).join(''))],
  '.css, une par ligne': () => [fichier('a.css', jusqua(N, (i) => `.a${i}{background:url(https://e.example/${i}.png)}\n`).join(''))],
  '<style>, @import sur une ligne': () => [fichier('index.html', `<!doctype html><style>${jusqua(N, (i) => `@import url(https://e.example/${i}.css);`).join('')}</style>`)],
  '<style>, url() sur une ligne': () => [fichier('index.html', `<!doctype html><style>${jusqua(N, (i) => `.a${i}{background:url(https://e.example/${i}.png)}`).join('')}</style>`)],
  'attributs style': () => [fichier('index.html', `<!doctype html>${jusqua(N, (i) => `<div style="background:url(https://e.example/${i}.png)">x</div>`).join('')}`)],
  '<link rel=stylesheet>': () => [fichier('index.html', `<!doctype html>${jusqua(N, (i) => `<link rel=stylesheet href="https://e.example/${i}.css">`).join('')}`)],
  'imagesrcset de candidats externes': () => [fichier('index.html', `<!doctype html><link rel=preload as=image imagesrcset="${jusqua(N, (i) => `https://e.example/${i}.png ${i + 1}w`).join(',')}">`)],
};

export const cas = [
  // Le même piège dans une page, un attribut style et un fichier .css : le lecteur est le même, l'entrée n'arrive pas par le même chemin.
  ...Object.entries(PIEGES_CSS).flatMap(([nom, css]) => [
    ['<style>', () => fichier('index.html', `<style>${css}</style>`)],
    ['style=', () => fichier('index.html', `<p style='${css.replaceAll("'", '&#39;')}'>`)],
    ['.css', () => fichier('style.css', css)],
  ].map(([contexte, fabriquer]) => ({
    nom: `CSS piégé : ${nom} (environ 1 Mio), dans ${contexte}`,
    budgetMs: 2000,
    executer() { chargementsDeFichier(fabriquer()); },
  }))),
  ...Object.entries(PIEGES_PAGE).map(([nom, html]) => ({
    nom: `page piégée : ${nom} (environ 1 Mio)`,
    budgetMs: 2000,
    executer() { chargementsDeFichier(fichier('index.html', html)); },
  })),
  ...Object.entries(PIEGES_BLANCS).map(([nom, html]) => ({
    nom: `blancs de bord : ${nom} (des Mio de blancs)`,
    budgetMs: 2000,
    executer() { chargementsDeFichier(fichier('index.html', html)); },
  })),
  {
    nom: 'le volume relu dans des feuilles data: est borné : au-delà d\'un Mio décodé, la borne de volume est dite',
    budgetMs: 2000,
    executer() {
      const grosse = `@import url("data:text/css,${encodeURIComponent('/*' + 'x'.repeat(600 * 1024) + '*/')}");`;
      const b = bornes(`<style>${grosse}${grosse}${grosse}</style>`);
      assert.equal(b[0]?.raison, 'volume');
    },
  },
  {
    nom: 'une feuille <link> data: de plus de 4 Mio de URL est bornée en volume et lue',
    budgetMs: 2000,
    executer() {
      const b = bornes(`<!doctype html><link rel=stylesheet href='data:text/css,${'a'.repeat(4 * MIO + 1)}'>`);
      assert.equal(b.length, 1);
      assert.equal(b[0].raison, 'volume');
    },
  },
  // Quarante mille références : un constat par référence, sur une ligne, sans quadratique (numeroLigne, extraitAutour, les extraits).
  ...Object.entries(PIEGES_REFERENCES).map(([nom, fabriquer]) => ({
    nom: `${N} références externes sur une ligne : ${nom}`,
    budgetMs: 4000,
    executer() {
      const fichiers = fabriquer();
      const constats = constatsExfil(fichiers);
      assert.equal(constats.length, N, 'un constat par référence');
      assert.ok(constats.every((c) => c.extrait.length <= 300), 'extraits bornés');
    },
  })),
];
