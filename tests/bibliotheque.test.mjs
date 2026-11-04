import test from 'node:test';
import assert from 'node:assert/strict';
import { bibliothequeDeAdresse, regrouperParBibliotheque } from '../src/moteur/bibliotheque.js';
import { constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';
import { genererHtml } from '../src/rapport/html.js';
import { auditer, page } from './aide-surface.mjs';

/**
 * Un chargement externe dit de quelle bibliothèque il est : les sous-modules d'une même bibliothèque se regroupent sous son nom
 * (demandé par Antoine, 2026-11-04, sur un rapport où 34 chargements esm.sh ne disaient rien de ce qu'ils chargeaient).
 */

const lire = (adresse) => { const b = bibliothequeDeAdresse(adresse); return b && [b.nom, b.version, b.module]; };

test('la bibliothèque se lit dans l\'adresse : version, sous-module, portée, préfixe de build', () => {
  assert.deepEqual(lire('https://esm.sh/react@18.3.1'), ['react', '18.3.1', 'react']);
  assert.deepEqual(lire('https://esm.sh/react-dom@18.3.1/client'), ['react-dom', '18.3.1', 'react-dom/client']);
  assert.deepEqual(lire('https://esm.sh/v135/@fluentui/react-button@9.3.0/lib/x.js'), ['@fluentui/react-button', '9.3.0', '@fluentui/react-button/lib/x.js']);
  assert.deepEqual(lire('https://esm.sh/*react@18/jsx-runtime'), ['react', '18', 'react/jsx-runtime']);
  assert.deepEqual(lire('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js'), ['lodash', '4.17.21', 'lodash/lodash.min.js']);
  assert.deepEqual(lire('https://unpkg.com/vue/dist/vue.js'), ['vue', null, 'vue/dist/vue.js']);
  assert.deepEqual(lire('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js'), ['jquery', '3.7.1', 'jquery/jquery.min.js']);
});

test('une adresse qui n\'est pas d\'un hébergeur de paquets connu ne désigne aucune bibliothèque', () => {
  assert.equal(bibliothequeDeAdresse('https://exemple.org/x/lib.js'), null);
  assert.equal(bibliothequeDeAdresse('https://cdn.jsdelivr.net/foo/bar.js'), null);
  assert.equal(bibliothequeDeAdresse('data:text/javascript,1'), null);
  assert.equal(bibliothequeDeAdresse('pas une adresse'), null);
});

test('E-DEP-01 et C-EXFIL-01 portent la bibliothèque de chaque import ; les sous-modules se regroupent sous leur bibliothèque', async () => {
  const code = [
    "import React from 'https://esm.sh/react@18.3.1';",
    "import { jsx } from 'https://esm.sh/react@18.3.1/jsx-runtime';",
    "import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';",
    'React; jsx; createRoot;',
  ].join('\n');
  const a = await auditer({ 'index.html': page(`<script type="module">\n${code}\n</script>`) });
  for (const regle of ['E-DEP-01', 'C-EXFIL-01']) {
    assert.deepEqual(a.de(regle).map((c) => c.preuve.module), ['react', 'react/jsx-runtime', 'react-dom/client'], regle);
  }
  assert.deepEqual(regrouperParBibliotheque(a.de('E-DEP-01')).map((b) => [b.nom, b.versions, b.chargements, b.modules.map((m) => m.module)]), [
    ['react', ['18.3.1'], 2, ['react', 'react/jsx-runtime']],
    ['react-dom', ['18.3.1'], 1, ['react-dom/client']],
  ]);
});

test('le rapport HTML nomme les bibliothèques d\'un groupe de chargements, et les points bloquants nomment la leur', () => {
  const adresses = ['react@18.3.1', 'react@18.3.1/jsx-runtime', 'react@18.3.1/jsx-runtime', 'react-dom@18.3.1/client', '<img src=x onerror=1>@1/y'];
  const constats = adresses.map((p, i) => constat({
    regle: 'E-DEP-01', axe: 'E', severite: 'critique', bloquant: true, titre: "Bibliothèque tierce chargée à l'exécution depuis esm.sh", constat: 'c', fichier: 'w.js', ligne: i + 1,
    preuve: { adresse: `https://esm.sh/${p}`, ...Object.fromEntries(Object.entries(bibliothequeDeAdresse(`https://esm.sh/${p}`) ?? {}).map(([k, v]) => [k === 'nom' ? 'bibliotheque' : k, v])) },
  }));
  const html = genererHtml({ ctx: { fichiers: [], surface: new Set() }, notation: noter(constats, new Set(['D'])), meta: { nomDepot: 'x', version: '0' } });
  assert.match(html, /Bibliothèques concernées \(3\)/);
  assert.match(html, /<strong>react<\/strong> \(18\.3\.1\) — 3 chargements : react, react\/jsx-runtime ×2/);
  assert.match(html, /<strong>react-dom<\/strong> \(18\.3\.1\) — 1 chargement : react-dom\/client/);
  assert.match(html, /<code>E-DEP-01<\/code> Bibliothèque tierce chargée à lchargée à l'exécution depuis esm\.sh — <code>react-dom#39;exécution depuis esm\.sh — <code>react-dom\/client \(18\.3\.1\)<\/code>/);
  assert.doesNotMatch(html, /<img src=x/, 'le nom venu du widget est échappé');
});
