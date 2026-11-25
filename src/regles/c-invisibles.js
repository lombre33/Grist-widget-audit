/**
 * C-INVISIBLE-01 : des caractères qu'on ne voit pas, dans un fichier du dépôt.
 *
 * Ce qu'une revue lit n'est pas toujours ce que le navigateur exécute : des caractères de sens d'écriture (U+202A à U+202E, U+2066 à U+2069) réordonnent
 * l'affichage du code sans le changer (« Trojan Source », CVE-2021-42574), des caractères de largeur nulle ou des remplisseurs font deux noms identiques à
 * l'œil, et des étiquettes Unicode (U+E0000 à U+E007F) écrivent un texte que l'écran ne montre pas mais qu'un assistant IA ou un script lit : une consigne cachée à
 * un relecteur IA. La règle dit ce qui est là, où, et ce qu'on voit à l'écran : jamais plus.
 *
 * Quatre classes, graduées par ce qu'elles permettent (aucune n'est bloquante : le caractère est certain, son intention ne l'est pas) :
 *  - SUITE : huit caractères invisibles de suite ou plus, de toute nature : un texte encodé, non un accident de copier-coller. Majeur, partout.
 *  - ÉTIQUETTE : un caractère d'étiquette Unicode hors de la séquence d'un drapeau (U+1F3F4, puis des étiquettes, puis U+E007F : les drapeaux d'Écosse, du pays de
 *    Galles, d'Angleterre). Majeur, partout.
 *  - SENS D'ÉCRITURE (les neuf contrôles d'embrayage, de remplacement et d'isolat ; pas les marques U+200E, U+200F, U+061C, que le texte de droite à gauche emploie) :
 *    majeur dans un commentaire d'un JavaScript, dans une chaîne quand c'est un remplacement ou un embrayage (U+202A à U+202E : la forme de l'attaque), dans une page, une
 *    feuille de style ou une donnée ; information pour un isolat (U+2066 à U+2069 : l'usage des traductions) dans une chaîne, et dans un document (Markdown, texte).
 *    Dans le code d'un JavaScript, un tel caractère est une erreur de syntaxe : le fichier est « illisible » (C-SURFACE-03), et la règle le dit majeur.
 *  - LARGEUR NULLE (U+200B, U+2060 à U+2064, U+FEFF hors du premier signe, U+180E), remplisseurs (U+115F, U+1160, U+3164, U+FFA0) et liaisons (U+200C, U+200D) : dans le
 *    code d'un JavaScript (un nom : les remplisseurs et les liaisons y sont des lettres valables), majeur ; dans un commentaire, un texte ou une page, information (un
 *    espace insécable collé d'une page web en porte), et rien pour une liaison (émoji, écriture persane). La marque d'ordre des octets hors du début n'est jamais que de l'information.
 * Ne sont pas lus seuls : le trait d'union conditionnel et les sélecteurs de variante, que le texte et les émojis emploient ; ils ne comptent qu'au sein d'une suite.
 *
 * Aucun texte caché n'est décodé ni recopié : le constat dit les points de code (`\u202e`), les lignes, et l'extrait neutralisé de la première, où chaque caractère
 * invisible est écrit en clair. Un fichier hostile en porte des centaines de milliers : la lecture s'arrête à `MAX_OCCURRENCES`, et le constat le dit.
 */
import * as walk from 'acorn-walk';
import { constat } from '../moteur/modele.js';
import { numeroLigne } from '../moteur/lignes.js';
import { lire, unitesJs } from '../moteur/analyse-js.js';
import { neutraliser } from '../moteur/texte-du-widget.js';

const MAX_OCCURRENCES = 5000;
const MAX_LIGNES_DITES = 20;
const LONGUEUR_DE_SUITE = 8;
/** Ce qu'on montre autour du premier caractère : soixante caractères de chaque côté. */
const FENETRE = 60;

const SENS_D_ECRITURE = /[\u202a-\u202e\u2066-\u2069]/u;
const REMPLACEMENTS = /[\u202a-\u202e]/u;
const LIAISONS = /[\u200c\u200d]/u;
/** Tout ce qui ne se voit pas et que la règle compte : une suite en est faite, ou une classe. */
const CACHES = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164\ufe00-\ufe0f\ufeff\uffa0\u{E0000}-\u{E01EF}]/gu;
const LARGEUR_NULLE = /[\u200b\u2060-\u2064\ufeff\u180e\u115f\u1160\u3164\uffa0]/u;
const ETIQUETTE = /[\u{E0000}-\u{E007F}]/u;
/** Le drapeau d'une subdivision : un drapeau noir, ses étiquettes, l'étiquette d'annulation. Le seul emploi légitime des étiquettes. */
const DRAPEAU = /\u{1F3F4}[\u{E0020}-\u{E007E}]{2,8}\u{E007F}/gu;

const EXTENSIONS_DE_DOCUMENT = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '']);
const VERROUS = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

const point = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Où chaque position d'un fichier JavaScript tombe : `texte` (une chaîne, un gabarit, une expression régulière), `commentaire`, ou `code`. `lieu(index)` ;
 * `null` quand le fichier n'est pas un JavaScript que l'outil sait lire (la position n'est pas connue).
 */
function lecteurDeLieux(fichier) {
  const unite = unitesJs(fichier).find((u) => !u.inline);
  if (!unite) return null;
  const { ast } = lire(unite.source);
  if (!ast) return null;
  const bornes = [];
  walk.simple(ast, {
    Literal(n) { if (typeof n.value === 'string' || n.regex) bornes.push([n.start, n.end, 'texte']); },
    TemplateElement(n) { bornes.push([n.start, n.end, 'texte']); },
  });
  for (const c of ast.commentaires ?? []) bornes.push([c.debut, c.fin, 'commentaire']);
  bornes.sort((a, b) => a[0] - b[0]);
  return (index) => {
    // Les bornes ne se recouvrent pas (un commentaire n'est pas dans un texte, ni l'inverse) : la dernière qui commence avant `index` est la seule candidate.
    let a = 0;
    let b = bornes.length;
    while (a < b) {
      const milieu = (a + b) >> 1;
      if (bornes[milieu][0] <= index) a = milieu + 1;
      else b = milieu;
    }
    const candidate = bornes[a - 1];
    return candidate && index < candidate[1] ? candidate[2] : 'code';
  };
}

/** Les caractères cachés d'un contenu : `{ index, c }`, ceux d'un drapeau légitime et le premier signe BOM retirés ; `tronque` si la lecture s'est arrêtée au plafond. */
function cachesDe(contenu) {
  const dansDesDrapeaux = [];
  if (contenu.includes('\u{1F3F4}')) for (const m of contenu.matchAll(DRAPEAU)) dansDesDrapeaux.push([m.index, m.index + m[0].length]);
  const caches = [];
  let tronque = false;
  let drapeau = 0;
  for (const m of contenu.matchAll(CACHES)) {
    if (caches.length >= MAX_OCCURRENCES) { tronque = true; break; }
    while (drapeau < dansDesDrapeaux.length && dansDesDrapeaux[drapeau][1] <= m.index) drapeau++;
    if (drapeau < dansDesDrapeaux.length && m.index >= dansDesDrapeaux[drapeau][0]) continue;
    if (m.index === 0 && m[0] === '\ufeff') continue; // la marque d'ordre des octets, au début : l'usage normal
    caches.push({ index: m.index, c: m[0] });
  }
  return { caches, tronque };
}

/** Les suites d'au moins `LONGUEUR_DE_SUITE` caractères cachés contigus : `Set` des indices qui y sont. */
function dansUneSuite(caches) {
  const dedans = new Set();
  let debut = 0;
  for (let i = 1; i <= caches.length; i++) {
    const contigu = i < caches.length && caches[i].index === caches[i - 1].index + caches[i - 1].c.length;
    if (contigu) continue;
    if (i - debut >= LONGUEUR_DE_SUITE) for (let j = debut; j < i; j++) dedans.add(caches[j].index);
    debut = i;
  }
  return dedans;
}

const CLASSES = {
  suite: {
    titre: 'Une suite de caractères invisibles cache un texte',
    constat: (n) => `${n} caractère(s) invisibles se suivent, par huit ou plus : ce n'est pas un accident de copier-coller, c'est un texte encodé que l'écran ne montre pas.`,
    impact: "Ce texte n'est vu ni par un relecteur ni par un éditeur, mais un script ou un assistant IA qui lit le fichier le lit : une consigne cachée à l'assistant qui relit le dépôt, ou des données passées sous les yeux de tous.",
  },
  etiquette: {
    titre: 'Des étiquettes Unicode cachent un texte',
    constat: (n) => `${n} caractère(s) d'étiquette Unicode (U+E0000 à U+E007F) hors de la séquence d'un drapeau : chacun double une lettre ASCII que l'écran ne montre pas.`,
    impact: "Ces caractères écrivent, à l'œil, rien du tout, et pour un assistant IA ou un script, du texte : le moyen d'adresser une consigne cachée à l'assistant qui relit le dépôt (injection d'invite).",
  },
  sens: {
    titre: "Des caractères de sens d'écriture cachés dans le fichier",
    constat: (n, lieu) => `${n} caractère(s) de remplacement, d'embrayage ou d'isolat de sens d'écriture (U+202A à U+202E, U+2066 à U+2069)${lieu === 'texte' ? ', dans des textes' : ''}.`,
    impact: "Ces caractères réordonnent l'affichage du code sans le changer (« Trojan Source », CVE-2021-42574) : un commentaire ou un texte peut y paraître contenir ce que le navigateur exécute, ou l'inverse, et le code lu en revue n'est pas celui qui s'exécute.",
  },
  nulle: {
    titre: 'Des caractères de largeur nulle dans le fichier',
    constat: (n, lieu) => `${n} caractère(s) de largeur nulle ou remplisseur (U+200B, U+2060 à U+2064, U+FEFF hors du début, U+180E, U+115F, U+1160, U+3164, U+FFA0)${lieu === 'code' ? ' dans le code' : ''}.`,
    impact: "Deux noms qui paraissent identiques peuvent être deux noms : une variable, une fonction ou une adresse peut en doubler une autre sans qu'aucun relecteur le voie.",
  },
};

/** La classe et la gravité d'un caractère caché : `{ classe, severite }`, ou `null` quand la règle ne le compte pas (une liaison, un sélecteur de variante, une marque seuls). */
function juger(c, lieu, ext, suite) {
  if (suite) return { classe: 'suite', severite: 'majeur' };
  if (ETIQUETTE.test(c)) return { classe: 'etiquette', severite: 'majeur' };
  const document = EXTENSIONS_DE_DOCUMENT.has(ext);
  if (SENS_D_ECRITURE.test(c)) {
    // Un isolat (U+2066 à U+2069) isole un nom dans un texte de droite à gauche : l'usage des traductions. Un remplacement ou un embrayage (U+202A à U+202E) dans une chaîne est la forme de l'attaque (« chaîne étirée »).
    if (document || (lieu === 'texte' && !REMPLACEMENTS.test(c))) return { classe: 'sens', severite: 'info' };
    return { classe: 'sens', severite: 'majeur' };
  }
  // Une liaison (U+200C, U+200D) ne s'écrit que dans un texte ou un commentaire (l'émoji, l'écriture persane) : dans le code d'un JavaScript, elle fait partie d'un nom, où rien ne la justifie.
  if (LIAISONS.test(c)) return lieu === 'code' ? { classe: 'nulle', severite: 'majeur' } : null;
  // La marque d'ordre des octets hors du début (un fichier recollé à un autre : un assemblage d'outil en laisse) ne change rien à ce que le code dit : information.
  if (LARGEUR_NULLE.test(c)) return { classe: 'nulle', severite: lieu === 'code' && c !== '\uFEFF' ? 'majeur' : 'info' };
  return null;
}

export function analyserInvisibles(ctx) {
  const constats = [];
  for (const f of ctx.fichiers) {
    if (f.binaire || typeof f.contenu !== 'string' || f.litteralImbrique || VERROUS.test(f.chemin)) continue;
    const { caches, tronque } = cachesDe(f.contenu);
    if (!caches.length) continue;
    const suite = dansUneSuite(caches);
    // La position dans le JavaScript ne se lit qu'une fois, et seulement quand un caractère à graduer par le lieu est là.
    let lieux;
    const lieu = (index) => {
      if (lieux === undefined) lieux = lecteurDeLieux(f);
      return lieux ? lieux(index) : 'inconnu';
    };
    const groupes = new Map(); // `${classe} ${severite}` → { classe, severite, indices: [], codes: Set }
    for (const { index, c } of caches) {
      const enSuite = suite.has(index);
      const besoinDuLieu = !enSuite && (SENS_D_ECRITURE.test(c) || LARGEUR_NULLE.test(c) || LIAISONS.test(c));
      const jugement = juger(c, besoinDuLieu ? lieu(index) : 'inconnu', f.ext, enSuite);
      if (!jugement) continue;
      const cle = `${jugement.classe} ${jugement.severite}`;
      if (!groupes.has(cle)) groupes.set(cle, { ...jugement, lieu: besoinDuLieu ? lieu(index) : null, indices: [], codes: new Set() });
      const g = groupes.get(cle);
      g.indices.push(index);
      g.codes.add(point(c));
    }
    for (const g of groupes.values()) {
      const lignes = [...new Set(g.indices.map((i) => numeroLigne(f.contenu, i)))];
      const ligne = lignes[0];
      const modele = CLASSES[g.classe];
      // Le début de la ligne du premier caractère, et l'entourage de celui-ci : de quoi le voir, écrit en clair, sans recopier une ligne de plusieurs Mio.
      const debutDeLigne = f.contenu.lastIndexOf('\n', g.indices[0] - 1) + 1;
      const depart = Math.max(debutDeLigne, g.indices[0] - FENETRE);
      const finDeLigne = f.contenu.indexOf('\n', g.indices[0]);
      const entourage = f.contenu.slice(depart, Math.min(finDeLigne === -1 ? f.contenu.length : finDeLigne, g.indices[0] + FENETRE));
      constats.push(constat({
        regle: 'C-INVISIBLE-01', axe: 'C', severite: g.severite, confiance: 'certain',
        titre: modele.titre,
        fichier: f.chemin, ligne,
        extrait: `${depart > debutDeLigne ? '…' : ''}${neutraliser(entourage)}`,
        constat: `${modele.constat(g.indices.length, g.lieu)} Lignes ${lignes.slice(0, MAX_LIGNES_DITES).join(', ')}${lignes.length > MAX_LIGNES_DITES ? `… (${lignes.length} lignes)` : ''}. Points de code : ${[...g.codes].slice(0, 12).join(', ')}.${tronque ? ` La lecture s'est arrêtée après ${MAX_OCCURRENCES} caractères.` : ''}`,
        impact: modele.impact,
        remediation: "Retirer ces caractères. Si un texte en a vraiment besoin, l'écrire en séquence d'échappement visible (`\\u202e`). Faire échouer la revue sur ces caractères : l'avertissement « caractères Unicode ambigus ou invisibles » de l'éditeur ou de la forge, ou `git diff --check`.",
        referentiels: ['CVE-2021-42574 (Trojan Source)', 'CWE-1007'],
        preuve: { classe: g.classe, occurrences: g.indices.length, lignes: lignes.slice(0, 200), codes: [...g.codes], lecturePartielle: tronque },
      }));
    }
  }
  return constats;
}
