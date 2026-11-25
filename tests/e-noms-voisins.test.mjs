/**
 * E-DEP-11 : un nom de paquet qui ressemble à celui d'un paquet très téléchargé. Une ressemblance, jamais une accusation : information, mineur seulement quand le registre
 * dit le paquet créé il y a moins d'un an. Se lit hors ligne.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { bilanDependances } from '../src/regles/e-bilan.js';
import { voisinDe, aUneFauteDe, constatsNomsVoisins } from '../src/regles/e-noms-voisins.js';

test("voisinDe : une lettre changée, ajoutée, retirée, deux lettres échangées, ou les séparateurs déplacés ; jamais un paquet connu, un nom à portée ou un nom court", () => {
  for (const [nom, voisin] of [['react-domm', 'react-dom'], ['lodahs', 'lodash'], ['expres', 'express'], ['axioss', 'axios'], ['momnet', 'moment'], ['reactdom', 'react-dom'], ['react_dom', 'react-dom'], ['vue-routr', 'vue-router'], ['Lodash2', 'lodash']]) {
    assert.equal(voisinDe(nom), voisin, nom);
  }
  for (const nom of ['lodash', 'react-dnd', 'dayjs', 'chalk', 'left-pad', 'mon-widget', 'grist-plugin-api', '@types/react', '@lodash/x', 'vue', 'axio', '', 'x'.repeat(200)]) {
    assert.equal(voisinDe(nom), null, nom);
  }
  assert.equal(aUneFauteDe('abcd', 'abdc'), true);
  assert.equal(aUneFauteDe('abcd', 'abcde'), true);
  assert.equal(aUneFauteDe('abcd', 'abxy'), false);
  assert.equal(aUneFauteDe('abc', 'abc'), false);
});

test("constatsNomsVoisins : information hors ligne ; mineur si le registre dit le paquet créé il y a moins d'un an ; aucun constat pour des noms qui ne ressemblent à rien", () => {
  const noms = [{ nom: 'react-domm', origine: 'package.json', fichier: 'package.json' }, { nom: 'mon-widget', origine: 'package.json' }];
  const [hors] = constatsNomsVoisins({ noms });
  assert.equal(`${hors.regle} ${hors.severite} ${hors.bloquant ? 'bloquant' : 'non bloquant'} ${hors.confiance}`, 'E-DEP-11 info non bloquant a_verifier');
  assert.match(hors.constat, /react-domm \(package\.json\) ressemble à react-dom\./);
  assert.match(hors.constat, /ne dit pas lequel des deux est le bon/);
  const ilYAJours = (j) => new Date(Date.now() - j * 24 * 3600 * 1000).toISOString();
  const lus = (jours) => new Map([['react-domm', { time: { created: ilYAJours(jours), '1.0.0': ilYAJours(jours) } }]]);
  const [recent] = constatsNomsVoisins({ noms, lus: lus(30) });
  assert.equal(recent.severite, 'mineur');
  assert.match(recent.constat, /créé le \d{4}-\d{2}-\d{2}.*créé il y a moins d'un an/);
  assert.equal(constatsNomsVoisins({ noms, lus: lus(900) })[0].severite, 'info', 'un paquet ancien reste une information : react-domm existe depuis des années');
  assert.deepEqual(constatsNomsVoisins({ noms: [{ nom: 'mon-widget', origine: 'package.json' }] }), []);
});

test("bilanDependances : les dépendances de développement et les bibliothèques chargées de loin comptent, et --sans-reseau n'y change rien", async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-voisins-'));
  fs.writeFileSync(path.join(dossier, 'index.html'), '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>w</title></head><body><main><h1>w</h1></main></body></html>');
  fs.writeFileSync(path.join(dossier, 'package.json'), JSON.stringify({ name: 'w', version: '1.0.0', dependencies: { lodash: '4.17.21' }, devDependencies: { lodahs: '1.0.0' } }));
  const ctx = construireContexte(dossier);
  const r = await bilanDependances(ctx, [], { reseau: false }, async () => { throw new Error('le registre ne doit pas être lu'); });
  assert.deepEqual(r.map((c) => c.regle), ['E-DEP-07', 'E-DEP-11']);
  assert.match(r[1].constat, /lodahs \(package\.json\) ressemble à lodash/);
});
