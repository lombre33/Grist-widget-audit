/**
 * Les entrées piégées que la suite d'essais lit et que `scripts/chronometrer-pieges.mjs` chronomètre : une seule table pour les deux, pour qu'un
 * piège ajouté à l'une ne manque pas à l'autre.
 *
 * Les essais ne jugent pas le temps (aucun budget en temps réel dans la suite : sous charge, un essai de 2 secondes flanche sans qu'un défaut
 * ait paru). Ils vérifient que la lecture ne s'abandonne pas et donne ce que l'entrée contient ; le chronomètre dit ce qu'elle a coûté, en
 * temps et en mémoire, et un algorithme quadratique s'y voit au quadruple d'un temps quand la taille double.
 */

export const MIO = 1 << 20;

/**
 * Des feuilles de style qui mettent un lecteur de CSS en difficulté (environ 1 Mio chacune). Chaque entrée : `[nom, css, chargements]`,
 * `chargements` étant le nombre de ressources que la feuille charge quand elle est lue dans un `<style>` ou un fichier `.css` (une par règle
 * `@import` complète : 0 quand l'entrée n'en contient aucune).
 */
export const PIEGES_CSS = [
  ['accolades ouvrantes', '{'.repeat(MIO), 0],
  ['parenthèses ouvrantes', '('.repeat(MIO), 0],
  ['@media imbriqués', '@media x{'.repeat(MIO / 9), 0],
  ['url( sans fin', 'a{b:url('.repeat(MIO / 8), 0],
  ['@import répétés', '@import url(a.css);'.repeat(MIO / 19), Math.floor(MIO / 19)],
  ['@import à chaînes', '@import "a.css" screen;'.repeat(MIO / 23), Math.floor(MIO / 23)],
  ['commentaires ouverts', '/*'.repeat(MIO / 2), 0],
  ['échappements', '\\'.repeat(MIO), 0],
  ['chaînes ouvertes', '"'.repeat(MIO), 0],
  ['data: dans des url(', 'a{b:url(data:text/css,'.repeat(MIO / 22), 0],
  ['@import data: de base64 invalide', '@import url("data:text/css;base64,!!!!");'.repeat(MIO / 40), Math.floor(MIO / 40)],
];

/** Les trois endroits où un CSS s'écrit : un `<style>`, un attribut `style=`, un fichier `.css`. `[contexte, fichier, contenu]`. */
export function contextesCss(css) {
  return [
    ['<style>', 'index.html', `<style>${css}</style>`],
    ['style=', 'index.html', `<p style='${css.replaceAll("'", '&#39;')}'>`],
    ['.css', 'style.css', css],
  ];
}

/** Des pages dont les `<link>`, `<style>` et attributs `style` s'enchaînent par dizaines de milliers (environ 1 Mio chacune). `[nom, html]`. */
export const PIEGES_PAGES_CSS = [
  ['link à srcset', '<link rel=preload as=image imagesrcset="a 1x, b 2x, c 3x">'.repeat(MIO / 60)],
  ['candidats de srcset', `<link rel=preload as=image imagesrcset="${'a,'.repeat(MIO / 2)}">`],
  ['candidats à parenthèses', `<link rel=preload as=image imagesrcset="${'a ('.repeat(MIO / 3)}">`],
  ['style ouverts', '<style>@import url(a.css);'.repeat(MIO / 26)],
  ['link data:', "<link rel=stylesheet href='data:text/css,@import url(a.css);'>".repeat(MIO / 60)],
  ['attributs style', '<p style="background:url(a.png)">'.repeat(MIO / 34)],
  ['gabarits de style', '<template><style>@import url(a.css);</style>'.repeat(MIO / 45)],
];

/** Des Mio de blancs de bord dans une URL, un type, un rel, un href : rognés en temps linéaire. `[nom, html]`. */
const BLANCS = ' '.repeat(MIO);
export const PIEGES_BLANCS = [
  ['url() entre guillemets', `<style>a{b:url("${BLANCS}x")}</style>`],
  ['url() sans guillemets', `<style>a{b:url(${BLANCS}x${BLANCS})}</style>`],
  ['@import', `<style>@import "${BLANCS}x";</style>`],
  ['data: à blancs', `<link rel=stylesheet href='data:text/css,${BLANCS}x'>`],
  ['href', `<link rel=stylesheet href="${BLANCS}x${BLANCS}">`],
  ['type', `<link rel=stylesheet type="${BLANCS}x" href=a.css>`],
  ['rel', `<link rel="${BLANCS}x${BLANCS}" href=a.css>`],
  ['imagesrcset', `<link rel=preload as=image imagesrcset="${','.repeat(MIO / 2)}x">`],
  ['style=', `<p style="${BLANCS}background:url(a.png)${BLANCS}">`],
  ['@import de blancs', `<style>${'@import "  ";'.repeat(MIO / 13)}</style>`],
];

/**
 * Des pages qui mettent en difficulté l'analyseur HTML du standard (environ 1 Mio chacune). `[nom, html, boutons]` : `boutons`, le nombre de
 * boutons sans intitulé accessible que F-RGAA-05 y relève (chaque `<button>` ouvert en ferme un autre : un par balise).
 */
export const PIEGES_ACCESSIBILITE = [
  ['boutons non fermés', '<button>'.repeat(MIO / 8), MIO / 8],
  ['boutons et icônes non fermés', '<button><i>'.repeat(MIO / 11), Math.floor(MIO / 11)],
  ['div imbriqués puis </p> sans p ouvert', '<div>'.repeat(MIO / 10) + '</p>'.repeat(MIO / 8), 0],
  ['formatage non fermé puis </p>', '<b><i><u><s>'.repeat(MIO / 24) + '</p>'.repeat(MIO / 8), 0],
  ['div imbriqués puis <p>', '<div>'.repeat(MIO / 10) + '<p>'.repeat(MIO / 6), 0],
  ['une balise à des dizaines de milliers d\'attributs distincts', `<button ${Array.from({ length: MIO / 8 }, (_, i) => `a${i.toString(36)}`).join(' ')}>`, 1],
  ['images, champs, labels et html sans >', '<img <input <label <html '.repeat(MIO / 26), 0],
  ['svg et sorties vers le HTML', '<svg><g><div>'.repeat(MIO / 13), 0],
];

/** Des README de 1 Mio qui mettent en difficulté la recherche d'un titre de rubrique (blancs, marqueurs de titre, fins de ligne). `[nom, contenu]`. */
export const PIEGES_README = [
  ['de blancs sur deux lignes', `${' '.repeat(MIO)}\n`.repeat(2)],
  ['de signes =', `${'='.repeat(MIO)}\n`],
  ["d'étoiles et de blancs", `${'* '.repeat(MIO / 2)}\n`],
  ['de dièses', `${'#'.repeat(MIO)}\n`],
  ['de fins de ligne', '\n'.repeat(MIO)],
];

/** Trois feuilles `data:` de 600 Kio importées l'une après l'autre : au-delà d'un Mio décodé, la borne de volume est dite. */
const FEUILLE_DATA = `@import url("data:text/css,${encodeURIComponent(`/*${'x'.repeat(600 * 1024)}*/`)}");`;
export const PAGE_FEUILLES_DATA = `<style>${FEUILLE_DATA}${FEUILLE_DATA}${FEUILLE_DATA}</style>`;

/** Une feuille `<link>` `data:` de plus de 4 Mio de URL : au-delà, la borne de volume est dite. */
export const PAGE_LINK_DATA_GEANT = `<!doctype html><link rel=stylesheet href='data:text/css,${'a'.repeat(4 * MIO + 1)}'>`;

/**
 * Les fichiers que l'inventaire ne lit pas (au-delà du plafond par fichier, ou une extension de binaire) : une règle qui en lit le texte sans
 * vérifier qu'il existe fait lever une exception, et l'analyse s'arrête sans rapport (c'était le cas du README et de la licence). Les essais
 * (`tests/fichiers-non-lus-regles.test.mjs`) et le balayage (`scripts/balayer-fichiers-non-lus.mjs`) partagent ces tables : le nom du fichier non lu,
 * la façon dont la page ou le code le référence, sa nature.
 */

/** Les noms que des règles cherchent (README, licence, manifestes, verrous, `SECURITY`), ceux des dossiers qu'elles distinguent (`vendor/`, tests, `dist/`) et les autres que porte un widget. */
export const NOMS_DE_FICHIERS_NON_LUS = [
  'README.md', 'README.fr.md', 'LISEZMOI.md', 'README.txt', 'README', 'LICENSE', 'LICENSE.md', 'LICENCE', 'COPYING', 'LICENSE.pdf', 'COPYING.png',
  'package.json', 'package-lock.json', 'manifest.json', 'widget.json', '.gitignore', '.env', '.npmrc', 'notes.txt', 'data.json', 'data.csv', 'x.svg', 'x.map', 'x.md',
  'CHANGELOG.md', 'SECURITY.md', 'app.js', 'big.js', 'lib.mjs', 'worker.js', 'sw.js', 'style.css', 'theme.css', 'other.html', 'index.html', 'grist-plugin-api.js',
  'vendor.min.js', 'jquery.min.js', 'vendor/lib.js', 'libs/a.js', 'third-party/t.js', 'assets/js/lib/x.js', 'dist/bundle.js', 'static/js/main.abc12345.js', 'src/app.js',
  'docs/README.md', 'docs/LICENSE', '.github/SECURITY.md', 'SECURITY', 'tests/a.test.js', 'test/e2e/x.js', '__tests__/x.js', 'cypress/e2e/a.cy.js', 'playwright.config.js',
  'i18n/fr.json', 'locales/en.json', 'public/index.html', 'pages/two.html',
  'x.wasm', 'x.png', 'x.woff2', 'yarn.lock', 'pnpm-lock.yaml', 'tsconfig.json', 'webpack.config.js', 'x.test.js', 'x.d.ts',
];

const PAGE_DE_BASE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>t</title><link rel="stylesheet" href="style.css"></head><body><script src="app.js"></script></body></html>\n';

/**
 * Comment le widget référence le fichier `t` : `[nom de forme, (t) => fichiers du widget qui s'ajoutent ou remplacent ceux de base]`. Les fichiers de base
 * sont `index.html` (qui charge `app.js` et `style.css`), `app.js` et `style.css`.
 */
export const FORMES_DE_REFERENCE = {
  seul: () => ({}),
  script: (t) => ({ 'index.html': `<script src="${t}"></script>` }),
  module: (t) => ({ 'index.html': `<script type="module" src="${t}"></script>` }),
  feuille: (t) => ({ 'index.html': `<link rel="stylesheet" href="${t}">` }),
  iframe: (t) => ({ 'index.html': `<iframe src="${t}"></iframe>` }),
  manifeste: (t) => ({ 'index.html': `<link rel="manifest" href="${t}">` }),
  image: (t) => ({ 'index.html': `<img src="${t}"><object data="${t}"></object>` }),
  worker: (t) => ({ 'app.js': `new Worker('${t}');` }),
  importScripts: (t) => ({ 'app.js': `importScripts('${t}');` }),
  serviceWorker: (t) => ({ 'app.js': `navigator.serviceWorker.register('${t}');` }),
  importStatique: (t) => ({ 'app.js': `import './${t}';` }),
  fetch: (t) => ({ 'app.js': `fetch('${t}');` }),
  cssImport: (t) => ({ 'style.css': `@import url('${t}');` }),
  importMap: (t) => ({ 'index.html': `<script type="importmap">{"imports":{"x":"./${t}"}}</script><script type="module">import 'x';</script>` }),
};

/** Les deux natures d'un fichier non lu : un texte au-delà du plafond, un contenu binaire (NUL, octets invalides). */
export const NATURES_NON_LUES = ['texte', 'binaire'];

/**
 * Les fichiers (nom → contenu) d'un petit widget dont le fichier `nom` est celui que l'inventaire ne lira pas : un texte de `octets` octets, ou un
 * binaire. Il est écrit en dernier : quand `nom` est `index.html`, `app.js` ou `style.css`, c'est lui qui remplace le fichier de base.
 */
export function widgetAvecFichierNonLu(nom, forme, nature, octets) {
  return {
    'index.html': PAGE_DE_BASE, 'app.js': 'grist.ready();\n', 'style.css': 'body{margin:0}\n',
    ...FORMES_DE_REFERENCE[forme](nom),
    [nom]: nature === 'binaire' ? Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0), Buffer.from([0xff, 0xfe, 0x01])]) : 'a'.repeat(octets),
  };
}
