/**
 * C-EXFIL-09 : une adresse du poste de qui ouvre le widget, écrite en entier dans le code (`http://localhost:11434/…`), n'est pas le widget lui-même :
 * mineur, non bloquant (un service local voulu, un modèle d'IA, un serveur MCP, s'écrit ainsi) ; majeur quand c'est du code qu'on charge de là.
 * Une adresse relative reste « une requête sur soi-même », et un nom qui ne fait que contenir « localhost » est un service externe.
 *
 * C-EXFIL-10 : un appel par un relais CORS public (corsproxy.io, allorigins…) : une information de plus, l'appel restant signalé comme service externe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditer, page } from './aide-surface.mjs';

const widget = (code) => auditer({ 'index.html': page('<script src="app.js"></script>'), 'app.js': `${code}\n` });
const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''}`;

test('C-EXFIL-09 : une adresse locale écrite en entier est signalée (mineur, non bloquant), quelle que soit la forme du poste local et le canal', async () => {
  const appels = [
    "fetch('http://localhost:11434/api/generate', { method: 'POST' });",
    "fetch('http://127.0.0.1:3000/x');",
    "fetch('http://127.8.9.10/x');",
    "fetch('http://[::1]:8080/x');",
    "fetch('http://0.0.0.0:9/x');",
    "fetch('//localhost:5000/x');",
    "new WebSocket('ws://localhost:3000/mcp');",
    "const x = new XMLHttpRequest(); x.open('GET', 'http://localhost/x');",
  ];
  for (const code of appels) {
    const r = await widget(code);
    const [c, ...autres] = r.de('C-EXFIL-09');
    assert.equal(autres.length, 0, code);
    assert.equal(`${etat(c)} ${c.fichier}`, 'mineur app.js', code);
    assert.deepEqual(r.de('C-EXFIL-01'), [], `${code} : ce n'est pas un service externe`);
  }
});

test('C-EXFIL-09 : une adresse relative, un nom qui contient « localhost » sans l\'être et un hôte externe ne sont pas le poste local', async () => {
  const relatives = ["fetch('/api/x');", "fetch('./data.json');", "fetch('data.json');", "fetch('../x.json');"];
  for (const code of relatives) {
    const r = await widget(code);
    assert.deepEqual(r.de('C-EXFIL-09'), [], code);
    assert.deepEqual(r.de('C-EXFIL-01'), [], code);
  }
  for (const code of ["fetch('http://api.localhost/x');", "fetch('https://localhost.exemple.org/x');", "fetch('https://notlocalhost.com/x');", "fetch('https://exemple.org/localhost');"]) {
    const r = await widget(code);
    assert.deepEqual(r.de('C-EXFIL-09'), [], code);
    assert.equal(r.de('C-EXFIL-01').length, 1, `${code} : un service externe`);
  }
});

test('C-EXFIL-09 : du code chargé depuis le poste local est majeur (non bloquant), une feuille de style mineur, une destination calculée reste calculée', async () => {
  const codes = [
    ['index.html', page('<script src="app.js"></script>'), "import('http://localhost:5173/module.js');", 'majeur'],
    ['index.html', page('<script src="app.js"></script>'), "importScripts('http://localhost:5173/w.js');", 'majeur'],
    ['index.html', page('<script src="app.js"></script>'), "const s = document.createElement('script'); s.src = 'http://localhost:5173/a.js'; document.head.append(s);", 'majeur'],
    ['index.html', page('<script src="http://localhost:5173/@vite/client"></script><script src="app.js"></script>'), 'const a = 1;', 'majeur'],
    ['index.html', page('<script type="importmap">{"imports":{"lib":"http://localhost:5173/lib.js"}}</script><script type="module" src="app.js"></script>'), "import 'lib';", 'majeur'],
    ['index.html', page('<link rel="stylesheet" href="http://127.0.0.1:8000/s.css"><script src="app.js"></script>'), 'const a = 1;', 'mineur'],
  ];
  for (const [, html, code, attendu] of codes) {
    const r = await auditer({ 'index.html': html, 'app.js': `${code}\n` });
    const [c, ...autres] = r.de('C-EXFIL-09');
    assert.equal(autres.length, 0, code);
    assert.equal(etat(c), attendu, code);
  }
  const relatif = await auditer({ 'index.html': page('<link rel="stylesheet" href="s.css"><script src="/app.js"></script>'), 'app.js': 'const a = 1;\n', 's.css': 'a{}' });
  assert.deepEqual(relatif.de('C-EXFIL-09'), [], 'des ressources relatives ne sont pas le poste local');
  // `'http://localhost:' + port` : l'adresse ne se lit pas en entier, c'est une destination calculée, comme avant.
  assert.deepEqual((await widget("fetch('http://localhost:' + port + '/x');")).de('C-EXFIL-09'), []);
});

test('C-EXFIL-10 : un appel par un relais CORS public ajoute une information, sans retirer le constat de service externe', async () => {
  for (const url of ['https://corsproxy.io/?https://api.exemple.org/x', 'https://api.allorigins.win/raw?url=https://api.exemple.org/x', 'https://cors-anywhere.herokuapp.com/https://api.exemple.org/x']) {
    const r = await widget(`fetch('${url}');`);
    const [c, ...autres] = r.de('C-EXFIL-10');
    assert.equal(autres.length, 0, url);
    assert.equal(etat(c), 'info', url);
    assert.equal(etat(r.de('C-EXFIL-01')[0]), 'critique bloquant', `${url} : le constat de service externe reste`);
  }
  for (const url of ['https://api.exemple.org/x', 'https://notcorsproxy.io/x', 'https://corsproxy.io.exemple.org/x']) {
    assert.deepEqual((await widget(`fetch('${url}');`)).de('C-EXFIL-10'), [], url);
  }
});
