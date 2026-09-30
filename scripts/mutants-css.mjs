#!/usr/bin/env node
/**
 * Rejoue les mutants de l'étape 2a de la passe HTML (lecteur CSS, chargements
 * des `<link>`, `srcset`) ; voir `scripts/lib/rejouer-mutants.mjs` pour la
 * méthode (copie temporaire, chaînes vérifiées d'avance, suite verte et
 * complète sur le code non muté).
 *
 * Usage : node scripts/mutants-css.mjs [expression régulière sur le libellé] [--part=i/n]
 * (`--part=1/3`, `--part=2/3`, `--part=3/3` dans trois processus : trois fois plus vite)
 * (aucun Chromium n'est nécessaire : le CSS est comparé à l'enregistrement
 * `tests/fixtures/chromium-141-chargements.json`, voir `tests/passe-html-css.test.mjs`).
 */
import { lireArguments, rejouerMutants } from './lib/rejouer-mutants.mjs';

const C = 'src/regles/c-securite.js';
const P = 'src/moteur/page-html.js';
const S = 'src/moteur/css.js';
const D = 'src/moteur/decoupeur-html.js';
const M = 'src/moteur/modele.js';

const TESTS = ['tests/passe-html-lecteurs.test.mjs', 'tests/exhaustivite-chargements-externes.test.mjs', 'tests/modele.test.mjs', 'tests/passe-html-css.test.mjs'];

// [fichier, chaîne d'origine (une seule occurrence), chaîne mutée, libellé]
const MUTANTS = [
  // --- c-securite.js
  [C, "const urlVide = (url) => /^[\\t\\n\\f\\r ]*$/.test(url);", "const urlVide = (url) => /^$/.test(url);", 'urlVide : une URL de blancs ne compte plus pour vide'],
  [P, "if (valeur !== undefined && !estBlanc(valeur)) demandes.push(", "if (valeur !== undefined) demandes.push(", 'urlVide : garde du script retirée'],
  [C, "url != null && !urlVide(url)", "url != null", 'urlVide : garde des ressources retirée'],
  [C, "confiance: note ? 'probable' : 'certain'", "confiance: 'certain'", 'confiance probable retirée'],
  [C, "confiance: note ? 'probable' : 'certain'", "confiance: 'probable'", 'tout probable'],
  [C, "confiance: e.confiance ?? 'certain'", "confiance: 'certain'", 'confiance du chargement ignorée'],
  [C, "if (e.apresRegle) notes.push(", "if (false) notes.push(", 'note @import après une règle retirée'],
  [C, "if (feuille.modele) notes.push(", "if (false) notes.push(", 'note template retirée'],
  [C, "if (e.sorte === 'url') notes.push(", "if (false) notes.push(", 'note url() retirée'],
  [C, "severite: 'info', confiance: 'certain', mesurePartielle: true,", "severite: 'info', confiance: 'certain',", 'borne : mesurePartielle retirée'],
  [C, "severite: 'info', confiance: 'certain', mesurePartielle: true,", "severite: 'mineur', confiance: 'certain', mesurePartielle: true,", 'borne : sévérité mineure'],
  [C, "['@import CSS', 'majeur']", "['@import CSS', 'mineur']", '@import CSS mineur'],
  [C, "['ressource CSS', 'mineur']", "['ressource CSS', 'majeur']", 'ressource CSS majeure'],
  [C, "&& lirePage(g.contenu).quirks)", "&& false)", 'feuilleLibre : jamais'],
  [C, "&& lirePage(g.contenu).quirks)", "&& true)", 'feuilleLibre : toujours'],
  [C, "mimeLibre: feuilleLibre, base", "mimeLibre: false, base", '.css : mimeLibre ignoré'],
  [C, "connexion: u.genre === 'connexion'", "connexion: false", 'connexion : texte de sondage perdu'],
  [C, "font: 'mineur'", "font: 'majeur'", 'preload font majeur'],
  [C, "icone: ['icône', 'mineur', 'une']", "icone: ['icône', 'majeur', 'une']", 'icône majeure'],
  [C, "connexion: ['connexion anticipée', 'mineur', 'une']", "connexion: ['connexion anticipée', 'majeur', 'une']", 'connexion majeure'],
  [C, "if (e.sorte === 'borne') {", "if (false) {", 'entrée borne traitée comme une url'],

  // --- page-html.js : usageLien
  [P, "type === undefined || type === '' || sansBlancsDeBord(", "type === undefined || sansBlancsDeBord(", 'type="" refusé'],
  [P, "type.split(';')[0]", "type", 'type : paramètre après ; non coupé'],
  [P, "sansBlancsDeBord(enMinusculesAscii(type.split(';')[0])) === 'text/css'", "sansBlancsDeBord(type.split(';')[0]) === 'text/css'", 'type : casse'],
  [P, "sansBlancsDeBord(enMinusculesAscii(type.split(';')[0])) === 'text/css'", "enMinusculesAscii(type.split(';')[0]) === 'text/css'", 'type : blancs'],
  [P, "if (jetons.has('icon')) usages.push", "if (false) usages.push", 'icon retiré'],
  [P, "if (jetons.has('preload')) {", "if (false) {", 'preload retiré'],
  [P, "if (AS_PRECHARGES.has(as)) {", "if (as) {", 'preload : as quelconque'],
  [P, "const AS_PRECHARGES = new Set(['script', 'style', 'font', 'image', 'fetch', 'track']);", "const AS_PRECHARGES = new Set(['script', 'style', 'font', 'image', 'fetch']);", 'AS_PRECHARGES sans track'],
  [P, "const AS_PRECHARGES = new Set(['script', 'style', 'font', 'image', 'fetch', 'track']);", "const AS_PRECHARGES = new Set(['script', 'style', 'font', 'image', 'fetch', 'track', 'document', 'audio', 'video', 'worker']);", 'AS_PRECHARGES trop large'],
  [P, "as === 'image' ? attributs.get('imagesrcset') : undefined", "undefined", 'imagesrcset ignoré'],
  [P, "as === 'image' ? attributs.get('imagesrcset') : undefined", "attributs.get('imagesrcset')", 'imagesrcset pour tout as'],
  [P, "srcset !== undefined && sansBlancsDeBord(srcset) !== ''", "srcset !== undefined", 'imagesrcset blanc pris'],
  [P, "for (const genre of ['modulepreload', 'prefetch', 'prerender'])", "for (const genre of ['prefetch', 'prerender'])", 'modulepreload retiré'],
  [P, "for (const genre of ['modulepreload', 'prefetch', 'prerender'])", "for (const genre of ['modulepreload', 'prerender'])", 'prefetch retiré'],
  [P, "for (const genre of ['modulepreload', 'prefetch', 'prerender'])", "for (const genre of ['modulepreload', 'prefetch'])", 'prerender retiré'],
  [P, "jetons.has('preconnect') || jetons.has('dns-prefetch')", "jetons.has('preconnect')", 'dns-prefetch retiré'],
  [P, "jetons.has('preconnect') || jetons.has('dns-prefetch')", "jetons.has('dns-prefetch')", 'preconnect retiré'],
  [P, "sansBlancsDeBord(attributs.get('href') ?? '') === '' ? []", "(attributs.get('href') ?? '') === '' ? []", 'href de blancs pris'],
  [P, "enMinusculesAscii(attributs.get('rel') ?? '')", "(attributs.get('rel') ?? '')", 'rel : casse'],
  [P, "attributs.get('rel') ?? '').split(/[\\t\\n\\f\\r ]+/)", "attributs.get('rel') ?? '').split(' ')", 'rel : blancs ASCII'],
  [P, "return usages.filter((u) => u.urls.length);", "return usages;", 'usages sans url gardés'],
  [P, "enMinusculesAscii(attributs.get('as') ?? '')", "(attributs.get('as') ?? '')", 'as : casse'],
  [P, "if (jetons.has('stylesheet')) {", "if (jetons.has('stylesheet') || jetons.has('alternate')) {", 'alternate seul lu comme feuille'],

  // --- page-html.js : mode du document
  [P, "      doctypePossible = false;\n      quirks = true;", "      doctypePossible = false;", 'contenu avant doctype : pas quirks'],
  [P, "onStartTag(balise) {\n      contenuAvantDoctype();", "onStartTag(balise) {", 'balise avant doctype : pas quirks'],
  [P, "onEndTag(balise) {\n      contenuAvantDoctype();", "onEndTag(balise) {", 'fermante avant doctype : pas quirks'],
  [P, "onCharacter(jeton) {\n      contenuAvantDoctype();", "onCharacter(jeton) {", 'texte avant doctype : pas quirks'],
  [P, "onWhitespaceCharacter(jeton) { visiteur.texte", "onWhitespaceCharacter(jeton) { contenuAvantDoctype(); visiteur.texte", 'blanc avant doctype compte'],
  [P, "onDoctype(jeton) {\n      if (!doctypePossible) return;", "onDoctype(jeton) {", 'second doctype relu'],
  [P, "parse(source.slice(jeton.location.startOffset, jeton.location.endOffset))) === 'quirks'", "parse(source.slice(jeton.location.startOffset, jeton.location.endOffset))) !== 'no-quirks'", 'limited-quirks compté quirks'],
  [P, "onEof() {\n      if (doctypePossible) quirks = true;", "onEof() {", 'pas de doctype : pas quirks'],
  [P, "f.mimeLibre = quirks;", "f.mimeLibre = false;", 'feuille data: : mimeLibre ignoré'],
  [P, "if (f.sorte === 'lien') f.applique = f.data.mime === 'text/css' || quirks;", "if (f.sorte === 'lien') f.applique = f.data.mime === 'text/css';", 'link data: : quirks ignoré'],
  [P, "if (f.sorte === 'lien') f.applique = f.data.mime === 'text/css' || quirks;", "if (f.sorte === 'lien') f.applique = true;", 'link data: : tout MIME'],

  // --- page-html.js : srcset
  [P, "while (fin > 0 && url.charCodeAt(fin - 1) === 44) fin--;", "", 'srcset : virgule finale gardée'],
  [P, "while (fin > 0 && url.charCodeAt(fin - 1) === 44) fin--;", "if (fin > 0 && url.charCodeAt(fin - 1) === 44) fin--;", 'srcset : une seule virgule finale retirée'],
  [P, "else if (c === ',' && !parentheses) break;", "else if (c === ',') break;", 'srcset : virgule entre parenthèses sépare'],
  [P, "if (url && descripteursValides(descripteurs)) urls.push(url);", "if (url) urls.push(url);", 'srcset : descripteurs non contrôlés'],
  [P, "return !(largeur && densite);", "return true;", 'srcset : w et x mêlés'],
  [P, "Number(nombre) > 0 && !largeur", "!largeur", 'srcset : 0w admis'],
  [P, "&& !densite) densite = true;", ") densite = true;", 'srcset : deux x admis'],

  // --- css.js
  [S, "profondeur: 16,", "profondeur: 17,", 'profondeur 17'],
  [S, "octets: 1 << 20", "octets: 1 << 21", 'volume double'],
  [S, "if (profondeur >= LIMITES_CSS.profondeur) {", "if (profondeur > LIMITES_CSS.profondeur) {", 'borne : un niveau de plus'],
  [S, "(d.mime !== 'text/css' && !mimeLibre)", "(d.mime !== 'text/css')", '@import data: : mimeLibre ignoré'],
  [S, "(d.mime !== 'text/css' && !mimeLibre)", "false", '@import data: : tout MIME'],
  [S, "if (!d || d.invalide ||", "if (!d ||", '@import data: base64 invalide lu'],
  [S, "if (e.sorte === 'import' && !URL.canParse(e.url)) continue;", "", 'data: imbriqué : base opaque ignorée'],
  [S, "entrees = entrees.filter((e) => e.sorte !== 'import' || e.via === 'data' || URL.canParse(e.url));", "", 'link data: : base opaque ignorée'],
  [S, "if (feuille.trop && feuille.applique)", "if (feuille.trop)", 'link data: borne même non appliquée'],
  [S, "if (feuille.trop && feuille.applique)", "if (false)", 'link data: borne muette'],
  [S, "if (d.corps === null || budget.octets < d.corps.length) {", "if (d.corps === null) {", 'budget de volume ignoré'],
  [S, "budget.octets -= d.corps.length;", "", 'budget jamais débité'],
  [S, "if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) return null;", "if (/[^A-Za-z0-9+/]/.test(s)) return null;", 'base64 : reste 1 admis'],
  [S, "if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) return null;", "if (s.length % 4 === 1) return null;", 'base64 : alphabet libre'],
  [S, "if (s.length % 4 === 0) {", "if (true) {", 'base64 : = retiré sans condition de longueur'],
  [S, "if (s.endsWith('==')) s = s.slice(0, -2);\n    else if (s.endsWith('=')) s = s.slice(0, -1);", "if (s.endsWith('==')) s = s.slice(0, -2);", 'base64 : un seul = refusé'],
  [S, "texte.replace(/[\\t\\n\\f\\r ]+/g, '')", "texte", 'base64 : blancs gardés'],
  [S, "if (diese >= 0) propre = propre.slice(0, diese);", "", 'data: fragment non coupé'],
  [S, ".replace(/[\\t\\n\\r]/g, '')", "", 'data: tabulations gardées'],
  [S, "let propre = rognerUrl(String(url)).replace(", "let propre = String(url).replace(", 'data: contrôles de bord gardés'],
  [S, "octetsMax * 4", "octetsMax * 400", 'data: volume : marge'],
  [S, ".split(';')[0].trim().toLowerCase() || 'text/plain'", ".split(';')[0].trim() || 'text/plain'", 'data: MIME : casse'],
  [S, "if (!v && !(citee && valeur !== '')) return;", "", 'url vide ajoutée'],
  [S, "if (!v && !(citee && valeur !== '')) return;", "if (!v) return;", 'chaîne de blancs entre guillemets écartée (citee retiré)'],
  [S, "if (!v && !(citee && valeur !== '')) return;", "if (!v && !citee) return;", 'url("") chargée (valeur vide comptée comme citée)'],
  [S, "ajouterUrl(r.imp.v, 'import', r.imp.d, apres ? { apresRegle: true } : undefined);", "ajouterUrl(r.imp.v, 'import', r.imp.d, apres ? { apresRegle: true } : undefined, true);", '@import : chaîne de blancs chargée comme un url()'],
  [S, "apres ? { apresRegle: true } : undefined", "undefined", '@import après règle : marque retirée'],
  [S, "if (avecBloc && !r.invalide) apres = true;", "", 'règle qualifiée ne ferme pas le champ des @import'],
  [S, "if (nomRegle === 'charset' || nomRegle === 'layer') {", "if (nomRegle === 'charset') {", 'scanner : @layer'],
  [S, "if (nomRegle !== 'import') return sorties;", "", 'scanner : autre at-règle'],
  [S, "if (p.url && !vus.has(p.url))", "if (p.url)", 'scanner : doublon compté'],
  [S, "if (p.url && !vus.has(p.url))", "if (!vus.has(p.url))", 'scanner : url vide'],

  [S, "let propre = rognerUrl(String(url)).replace(", "let propre = String(url).trim().replace(", 'data: rognage par trim() (NBSP rogné)'],
  [S, "const v = rognerUrl(valeur);", "const v = valeur.trim();", 'ajouterUrl : rognage par trim() (NBSP rogné)'],
  [S, "v = v.slice(1, -1);\n  return v;", "v = v.slice(1, -1);\n  return v.trim();", 'scanner : valeur rognée par trim() (NBSP rogné)'],
  [S, "while (b > a && texte.charCodeAt(b - 1) <= 32) b--;", "{ const m = /[\\u0000- ]+$/.exec(texte.slice(a)); if (m) b = a + m.index; }", 'rognerUrl : regex quadratique'],
  [P, "  while (b > a && espace(texte.charCodeAt(b - 1))) b--;\n  return texte.slice(a, b);", "  return texte.replace(/^[\\t\\n\\f\\r ]+|[\\t\\n\\f\\r ]+$/g, '');", 'sansBlancsDeBord : regex quadratique'],
  [P, "(attribut(balise, 'encoding') ?? '')", "(attribut(balise, 'encoding') ?? '').trim()", 'annotation-xml : encoding rogné'],

  // --- extrait borné autour de la référence, numéro de ligne, temps des constats
  [M, "String(c.extrait).slice(0, LONGUEUR_LUE_EXTRAIT).replace(", "String(c.extrait).replace(", 'extrait : replié en entier avant la coupe (quadratique)'],
  [M, "const LONGUEUR_LUE_EXTRAIT = 4096;", "const LONGUEUR_LUE_EXTRAIT = 1 << 30;", 'extrait : longueur lue sans borne'],
  [M, ".replace(/\\s+/g, ' ').slice(0, 300)", ".replace(/\\s+/g, ' ')", 'extrait : plus coupé à 300 caractères'],
  [M, ".replace(/\\s+/g, ' ').slice(0, 300)", ".slice(0, 300)", 'extrait : blancs non repliés'],
  [C, "const debut = Math.max(0, decalage - 60);", "const debut = Math.max(0, decalage - 6);", 'extraitAutour : 6 caractères avant'],
  [C, "const fin = Math.min(contenu.length, decalage + 236);", "const fin = Math.min(contenu.length, decalage + 24);", 'extraitAutour : 24 caractères après'],
  [C, "const a = saut + 1;", "const a = 0;", 'extraitAutour : ligne précédente incluse'],
  [C, "const b = suite === -1 ? fenetre.length : fenetre[suite - 1] === '\\r' ? suite - 1 : suite;", "const b = fenetre.length;", 'extraitAutour : ligne suivante incluse'],
  [C, "const b = suite === -1 ? fenetre.length : fenetre[suite - 1] === '\\r' ? suite - 1 : suite;", "const b = suite === -1 ? fenetre.length : suite;", 'extraitAutour : CR de fin de ligne gardé'],
  [C, "${saut === -1 && debut > 0 ? '…' : ''}", "${''}", 'extraitAutour : pas de … devant'],
  [C, "${saut === -1 && debut > 0 ? '…' : ''}", "${debut > 0 ? '…' : ''}", 'extraitAutour : … devant même en début de ligne'],
  [C, "${suite === -1 && fin < contenu.length ? '…' : ''}", "${''}", 'extraitAutour : pas de … derrière'],
  [C, "const balise = decalage == null ? ligneDe(f, ligne).slice(0, 300) : extraitAutour(f.contenu, decalage);", "const balise = ligneDe(f, ligne);", 'constat CSS : la ligne entière en extrait'],
  [C, "ligne: numeroLigne(f.contenu, e.debut), decalage: e.debut }", "ligne: numeroLigne(f.contenu, e.debut) }", '.css : position sans décalage'],
  [P, "return { ligne, colonne, exacte, decalage: exacte ? origine + decalage : null };", "return { ligne, colonne, exacte, decalage: null };", '<style> : position sans décalage'],

  // --- inventaire / découpeur
  [D, "if (balise.nomsVus.has(this.currentAttr.name)) return;", "", 'découpeur : doublon gardé'],
];
const { partie, restants } = lireArguments(process.argv.slice(2));
const filtre = restants[0] ? new RegExp(restants[0]) : null;
const mutants = MUTANTS
  .filter(([, , , libelle]) => !filtre || filtre.test(libelle))
  .map(([fichier, ancien, nouveau, libelle]) => ({ libelle: `${libelle}  [${fichier.split('/').pop()}]`, fichier, ancien, nouveau }));

process.exitCode = rejouerMutants({ mutants, groupes: [{ nom: 'tests ciblés', fichiers: TESTS }], exigerChromium: false, partie });
