import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserRessourcesExternes } from '../src/regles/c-securite.js';

/**
 * Les textes des `<link>` disent pourquoi leur sévérité est celle-là : ce que
 * le navigateur en fait, pas le nom de la relation. Chaque test a son mutant
 * dans `scripts/mutants-liens-raisons.mjs`.
 *
 * Mineur : icône, police, image, connexion anticipée : une ressource
 * d'affichage ou une connexion, que le navigateur ne peut ni exécuter ni
 * appliquer ; le tiers y voit l'adresse IP et l'heure.
 * Majeur : les préchargements de script, de feuille, de module, de requête
 * (`fetch`) ou de piste, `prefetch`, `prerender` : de quoi la page peut
 * exécuter, appliquer ou lire, sans que ce qui s'en sert soit toujours visible
 * (un `onload` qui passe `rel` à `stylesheet`, un chargeur calculé), donc pas
 * d'abaissement faute de garantie. Une feuille de style tierce s'applique.
 */

const fichier = (chemin, contenu) => ({ chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false });
const constatsDe = (html) => analyserRessourcesExternes({ fichiers: [fichier('index.html', html)], entrees: ['index.html'] }).filter((x) => x.regle === 'C-EXFIL-03');
const page = (corps, dansLeCorps = '') => `<!doctype html><html lang="fr"><head><title>t</title>${corps}</head><body>${dansLeCorps}</body></html>`;
const lien = (attributs) => {
  const c = constatsDe(page(`<link ${attributs}>`));
  assert.equal(c.length, 1, `un constat attendu pour <link ${attributs}>, obtenu ${c.length}`);
  return c[0];
};
const T = 'https://cdn.tiers.example';

const AFFICHAGE = /Ce lien ne récupère qu'une ressource d'affichage : le navigateur ne l'exécute ni ne l'applique jamais, mais le tiers y voit l'adresse IP et l'heure de chaque affichage\./;
const CONNEXION = /Le navigateur n'exécute ni n'applique jamais rien de ce lien, qui n'ouvre qu'une connexion : le tiers y voit l'adresse IP \(avec `preconnect`\) et l'heure de chaque affichage\./;
const EXECUTABLE = /Ce lien récupère de quoi la page peut exécuter, appliquer ou lire, sans que ce qui s'en sert soit toujours visible \(un `onload` qui passe `rel` à `stylesheet`, un chargeur calculé\) : faute de garantie, la sévérité n'est pas abaissée\./;
const FEUILLE = /Une feuille de style tierce s'applique à la page : ses règles changent ce qui s'affiche, peuvent faire charger d'autres ressources et lire, par leurs sélecteurs, des valeurs présentes dans la page\./;
const RAISONS = { AFFICHAGE, CONNEXION, EXECUTABLE, FEUILLE };

/** Le constat porte exactement la raison attendue, et aucune des trois autres. */
function exactement(constat, attendue) {
  for (const [nom, re] of Object.entries(RAISONS)) {
    if (nom === attendue) assert.match(constat, re, `la raison ${nom} manque`);
    else assert.doesNotMatch(constat, re, `la raison ${nom} ne devrait pas figurer`);
  }
}

const MINEURS = [
  ['une icône', `rel="icon" href="${T}/i.ico"`, 'AFFICHAGE', 'une icône'],
  ['une icône de raccourci', `rel="shortcut icon" href="${T}/i.ico"`, 'AFFICHAGE', 'une icône'],
  ['une icône (rel en majuscules)', `rel="ICON" href="${T}/i.ico"`, 'AFFICHAGE', 'une icône'],
  ['un préchargement de police', `rel="preload" as="font" href="${T}/f.woff2" crossorigin`, 'AFFICHAGE', 'un préchargement de font'],
  ['un préchargement d\'image', `rel="preload" as="image" href="${T}/i.png"`, 'AFFICHAGE', 'un préchargement de image'],
  ['une connexion anticipée (preconnect)', `rel="preconnect" href="${T}"`, 'CONNEXION', null],
  ['une résolution anticipée (dns-prefetch)', `rel="dns-prefetch" href="${T}"`, 'CONNEXION', null],
];

for (const [nom, attributs, raison, libelle] of MINEURS) {
  test(`liens : ${nom} est mineur et dit pourquoi`, () => {
    const c = lien(attributs);
    assert.equal(c.severite, 'mineur');
    assert.equal(c.bloquant, false);
    exactement(c.constat, raison);
    if (libelle) assert.ok(c.constat.startsWith(`Le widget charge ${libelle} depuis`), `article ou libellé faux : ${c.constat.slice(0, 80)}`);
  });
}

test('liens : un préchargement d\'image par imagesrcset donne un constat par candidat, chacun avec la raison d\'affichage', () => {
  const c = constatsDe(page(`<link rel="preload" as="image" imagesrcset="${T}/i1.png 1x, ${T}/i2.png 2x">`));
  assert.equal(c.length, 2);
  for (const x of c) {
    assert.equal(x.severite, 'mineur');
    exactement(x.constat, 'AFFICHAGE');
  }
});

const MAJEURS = [
  ['un préchargement de script', `rel="preload" as="script" href="${T}/a.js"`, 'un préchargement de script'],
  ['un préchargement de feuille', `rel="preload" as="style" href="${T}/a.css"`, 'un préchargement de style'],
  ['un préchargement de requête (fetch)', `rel="preload" as="fetch" href="${T}/d.json" crossorigin`, 'un préchargement de fetch'],
  ['un préchargement de piste', `rel="preload" as="track" href="${T}/p.vtt"`, 'un préchargement de track'],
  ['un préchargement de module', `rel="modulepreload" href="${T}/m.js"`, 'un préchargement de module'],
  ['un prefetch', `rel="prefetch" href="${T}/n.js"`, 'un préchargement (prefetch)'],
  ['un prerender', `rel="prerender" href="${T}/p.html"`, 'un préchargement (prerender)'],
];

for (const [nom, attributs, libelle] of MAJEURS) {
  test(`liens : ${nom} est majeur et dit pourquoi on ne baisse pas`, () => {
    const c = lien(attributs);
    assert.equal(c.severite, 'majeur');
    assert.equal(c.bloquant, false, 'ce n\'est pas un script exécuté : il ne bloque pas');
    exactement(c.constat, 'EXECUTABLE');
    assert.ok(c.constat.startsWith(`Le widget charge ${libelle} depuis`), `article ou libellé faux : ${c.constat.slice(0, 80)}`);
  });
}

test('liens : une feuille de style tierce est majeure et dit qu\'elle s\'applique à la page', () => {
  const c = lien(`rel="stylesheet" href="${T}/a.css"`);
  assert.equal(c.severite, 'majeur');
  exactement(c.constat, 'FEUILLE');
  assert.ok(c.constat.startsWith('Le widget charge une feuille de style depuis'));
});

test('liens : integrity ne change pas la raison, qui suit ce que le navigateur fait du lien', () => {
  const EMPREINTE = 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC';
  const c = lien(`rel="preload" as="script" href="${T}/a.js" integrity="${EMPREINTE}"`);
  assert.match(c.constat, /\(avec attribut `integrity`\)/);
  exactement(c.constat, 'EXECUTABLE');
  exactement(lien(`rel="icon" href="${T}/i.ico" integrity="x"`).constat, 'AFFICHAGE');
});

test('liens : un lien qui cumule deux relations dit la raison de chacune, à son constat', () => {
  const c = constatsDe(page(`<link rel="icon stylesheet" href="${T}/a.css">`));
  assert.equal(c.length, 2);
  const [icone] = c.filter((x) => /icône/.test(x.titre));
  const [feuille] = c.filter((x) => /feuille de style/.test(x.titre));
  exactement(icone.constat, 'AFFICHAGE');
  exactement(feuille.constat, 'FEUILLE');
});

test('liens : la réserve de gabarit s\'ajoute après la raison, sans la remplacer', () => {
  const [c] = constatsDe(page('', `<template><link rel="prefetch" href="${T}/n.js"></template>`));
  exactement(c.constat, 'EXECUTABLE');
  assert.match(c.constat, /Précision : dans un `<template>`/);
  assert.ok(c.constat.indexOf('faute de garantie') < c.constat.indexOf('Précision'));
});

test('liens : les autres chargements (image, iframe, script) ne prennent aucune raison de lien', () => {
  const html = page(`<script src="${T}/s.js"></script>`, `<img src="${T}/i.png"><iframe src="${T}/f.html"></iframe>`);
  const c = constatsDe(html);
  assert.equal(c.length, 3);
  for (const x of c) exactement(x.constat, 'AUCUNE');
});

test('liens : le constat complet, phrase puis raison séparées d\'un seul blanc (ressource, puis connexion)', () => {
  assert.equal(
    lien(`rel="icon" href="${T}/i.ico"`).constat,
    'Le widget charge une icône depuis `cdn.tiers.example` sans contrôle d\'intégrité (`integrity`). Ce lien ne récupère qu\'une ressource d\'affichage : le navigateur ne l\'exécute ni ne l\'applique jamais, mais le tiers y voit l\'adresse IP et l\'heure de chaque affichage.',
  );
  assert.equal(
    lien(`rel="preconnect" href="${T}"`).constat,
    'Le widget prépare une connexion vers `cdn.tiers.example` (`preconnect` ou `dns-prefetch`) : le navigateur y résout le nom, et pour `preconnect` y ouvre une connexion, avant tout usage. Aucune ressource n\'est demandée. Le navigateur n\'exécute ni n\'applique jamais rien de ce lien, qui n\'ouvre qu\'une connexion : le tiers y voit l\'adresse IP (avec `preconnect`) et l\'heure de chaque affichage.',
  );
});
