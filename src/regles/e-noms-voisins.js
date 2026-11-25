/**
 * Axe E — noms qui imitent un paquet très téléchargé (E-DEP-11) : `react-domm`, `lodahs`, `reactdom`.
 *
 * Un attaquant publie le nom d'à côté, que la main ou une IA écrit de travers. Le constat est une RESSEMBLANCE, jamais une accusation : un paquet légitime peut avoir
 * un nom voisin (`react-domm` existe vraiment sur npm depuis 2021), et l'outil ne dit pas lequel des deux est le bon. D'où une information, qui ne devient un mineur
 * que quand le registre dit le paquet créé il y a moins d'un an. Seuls les noms sans portée sont comparés, à une courte liste de paquets très connus, tenue à la main.
 */
import { constat } from '../moteur/modele.js';
import { creationDuPaquet } from './e-registre.js';

/** Des paquets très téléchargés, tenus à la main (une liste de noms exacts, pas de téléchargements lus). Ceux de la liste ne sont jamais signalés. */
const POPULAIRES = new Set(`
react react-dom react-router react-router-dom react-redux react-native react-scripts react-query react-select react-dnd react-hook-form react-helmet react-table
react-datepicker react-bootstrap react-icons react-i18next redux redux-thunk redux-saga next nuxt vue vue-router vuex pinia svelte angular jquery jquery-ui lodash
lodash-es underscore moment moment-timezone dayjs date-fns luxon axios express koa fastify hapi webpack webpack-cli webpack-dev-server vite rollup esbuild parcel
gulp grunt typescript ts-node tslib eslint prettier jest mocha chai sinon karma jasmine cypress puppeteer playwright chalk commander yargs inquirer ora dotenv uuid
nanoid debug minimist semver glob rimraf mkdirp fs-extra request node-fetch cross-env nodemon rxjs core-js bluebird async ramda immutable immer mobx zustand d3 three
chart.js leaflet bootstrap tailwindcss postcss autoprefixer sass less styled-components classnames prop-types formik yup zod ajv joi validator socket.io ws mongoose
mongodb mysql mysql2 pg redis ioredis sequelize typeorm prisma knex passport jsonwebtoken bcrypt bcryptjs crypto-js body-parser cors helmet morgan cookie-parser multer
compression express-session marked highlight.js cheerio jsdom handlebars ejs pug mustache xml2js js-yaml papaparse xlsx jszip pako sharp jimp left-pad colors faker
event-stream ua-parser-js node-sass qs tar cookie iconv-lite readable-stream inherits safe-buffer babel-core babel-loader css-loader style-loader sass-loader file-loader
html-webpack-plugin mini-css-extract-plugin terser uglify-js http-server serve live-server browserify requirejs backbone ember-source polymer lit alpinejs htmx.org swr
graphql apollo-client prismjs quill tinymce ckeditor codemirror monaco-editor sortablejs hammerjs animejs gsap lottie-web swiper flatpickr choices.js tippy.js
popper.js numeral accounting big.js bignumber.js decimal.js mathjs fuse.js lunr mark.js clipboard file-saver html2canvas jspdf pdfjs-dist pdfmake sweetalert2 toastr
noty nprogress dompurify sanitize-html xss he entities is-number is-odd isarray
`.split(/\s+/).filter(Boolean));

/** Les noms comparés sans leurs séparateurs (`react-dom`, `reactdom`, `react_dom`, `react.dom` se valent). */
const sansSeparateurs = (nom) => nom.replace(/[-_.]/g, '');

/** Vrai quand `a` et `b` ne diffèrent que d'une lettre changée, ajoutée, retirée, ou de deux lettres voisines échangées. */
export function aUneFauteDe(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const [court, long] = a.length < b.length ? [a, b] : [b, a];
  return court.slice(i) === long.slice(i + 1);
}

/** Le paquet très connu dont `nom` est le voisin, ou `null` : un nom sans portée, d'au moins cinq lettres, qui n'est pas lui-même dans la liste. */
export function voisinDe(nom) {
  if (typeof nom !== 'string' || nom.startsWith('@') || nom.length < 5 || nom.length > 100) return null;
  const n = nom.toLowerCase();
  if (POPULAIRES.has(n)) return null;
  const sans = sansSeparateurs(n);
  for (const p of POPULAIRES) {
    if (p.length < 5) continue;
    if (sansSeparateurs(p) === sans || aUneFauteDe(n, p)) return p;
  }
  return null;
}

const MAX_NOMMES = 8;
const JOURS_PAR_AN = 365;
const court = (valeur) => String(valeur ?? '').slice(0, 100);

/**
 * Le constat E-DEP-11, ou rien. `lus` : ce que le registre a rendu (peut être vide : hors ligne, la ressemblance se dit quand même).
 * @param {{noms: Array<{nom: string, origine: string, fichier?: string, ligne?: number}>, lus?: Map, maintenant?: number}} entree
 */
export function constatsNomsVoisins({ noms, lus = new Map(), maintenant = Date.now() }) {
  const vus = new Set();
  const voisins = [];
  for (const { nom, origine, fichier, ligne } of noms) {
    if (vus.has(nom)) continue;
    vus.add(nom);
    const p = voisinDe(nom);
    if (!p) continue;
    const lu = lus.get(nom);
    const creation = lu?.time ? creationDuPaquet(lu, maintenant) : null;
    voisins.push({ nom, voisin: p, origine, fichier, ligne, creation, recent: Boolean(creation && creation.ageJours < JOURS_PAR_AN) });
  }
  if (!voisins.length) return [];
  const recents = voisins.some((v) => v.recent);
  const liste = voisins.slice(0, MAX_NOMMES).map((v) => `${court(v.nom)} (${v.origine}) ressemble à ${v.voisin}${v.creation ? `, créé le ${v.creation.date}` : ''}`).join(' ; ') + (voisins.length > MAX_NOMMES ? ` ; et ${voisins.length - MAX_NOMMES} autre(s)` : '');
  return [constat({
    regle: 'E-DEP-11', axe: 'E', severite: recents ? 'mineur' : 'info', confiance: 'a_verifier',
    titre: `${voisins.length > 1 ? `${voisins.length} noms de paquets ressemblent` : 'Un nom de paquet ressemble'} à celui d'un paquet très téléchargé : ${voisins.slice(0, MAX_NOMMES).map((v) => court(v.nom)).join(', ')}`,
    fichier: voisins[0].fichier, ligne: voisins[0].ligne,
    constat: `${liste}. Une ressemblance de nom n'est pas une preuve : un paquet légitime peut avoir un nom voisin, et l'outil ne dit pas lequel des deux est le bon.${recents ? " Au moins un de ces paquets a été créé il y a moins d'un an, ce qui monte le constat en mineur." : ''}`,
    impact: "Un attaquant publie le nom d'à côté, que la main ou un assistant d'IA écrit de travers ; le paquet installé n'est alors pas celui qu'on croit. C'est la voie des paquets « typosquattés ».",
    remediation: "Vérifier, pour chaque nom, que c'est bien le paquet voulu : son auteur, son dépôt source, son nombre de téléchargements, et la différence d'écriture avec le paquet connu.",
    referentiels: ['OWASP Top 10 A06:2021 — Composants vulnérables et obsolètes', 'ANSSI — Maîtrise du code tiers'],
    preuve: { paquets: voisins.slice(0, 50).map((v) => ({ nom: court(v.nom), voisin: v.voisin, origine: v.origine, creation: v.creation?.date ?? null })), total: voisins.length },
  })];
}
