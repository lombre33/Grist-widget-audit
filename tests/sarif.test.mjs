import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';
import { genererSarif } from '../src/rapport/sarif.js';

test('chaque résultat SARIF référence une règle existante et porte une localisation', () => {
  const constats = [
    constat({ regle: 'C-EXFIL-01', axe: 'C', titre: 'fuite', severite: 'critique', bloquant: true, constat: 'c', fichier: 'app.js', ligne: 12 }),
    constat({ regle: 'E-DEP-01', axe: 'E', titre: 'dépendance', severite: 'mineur', constat: 'd' }),
  ];
  const notation = noter(constats, new Set());
  const sarif = JSON.parse(genererSarif({ notation, meta: { version: '1.2.3', nomDepot: 'w' } }));

  assert.equal(sarif.version, '2.1.0');
  const run = sarif.runs[0];
  assert.equal(run.results.length, 2);
  for (const r of run.results) {
    assert.ok(run.tool.driver.rules[r.ruleIndex]);
    assert.equal(run.tool.driver.rules[r.ruleIndex].id, r.ruleId);
    assert.ok(r.locations?.[0]?.physicalLocation?.artifactLocation?.uri, 'localisation attendue même sans fichier connu');
  }
});

test("un constat trouvé dans un fichier synthétique (code littéral matérialisé, litteralImbrique) reçoit une artifactLocation.uri RÉELLE — un chemin fabriqué comme « app.js (code littéral, ligne 3) » n'existe pas sur disque et casse la résolution chez un ingesteur SARIF (relevé par la coordination le 2026-09-28)", () => {
  const cheminSynthetique = 'app.js (code littéral, ligne 3)';
  const ctx = {
    fichiers: [
      { chemin: 'app.js', contenu: 'eval("fetch(\'https://exemple.tiers/x\')");', executee: true },
      { chemin: cheminSynthetique, contenu: "fetch('https://exemple.tiers/x')", executee: true, litteralImbrique: true, origineReelle: { chemin: 'app.js', ligne: 3 } },
    ],
  };
  const constats = [
    constat({ regle: 'C-EXFIL-01', axe: 'C', titre: 'fuite', severite: 'critique', bloquant: true, constat: 'c', fichier: cheminSynthetique, ligne: 1 }),
  ];
  const notation = noter(constats, new Set());
  const sarif = JSON.parse(genererSarif({ ctx, notation, meta: { version: '1.0.0', nomDepot: 'w' } }));

  const loc = sarif.runs[0].results[0].locations[0].physicalLocation;
  assert.equal(loc.artifactLocation.uri, 'app.js', "doit pointer vers le fichier réel du dépôt, pas le chemin synthétique introuvable sur disque");
  assert.equal(loc.region.startLine, 3, "la ligne doit être celle du site d'appel dans le fichier réel, pas la numérotation interne du contenu décodé");
});

test('sans ctx (rétrocompatibilité) : un fichier déjà réel garde sa propre localisation, inchangée', () => {
  const constats = [
    constat({ regle: 'C-EXFIL-01', axe: 'C', titre: 'fuite', severite: 'critique', bloquant: true, constat: 'c', fichier: 'app.js', ligne: 12 }),
  ];
  const notation = noter(constats, new Set());
  const sarif = JSON.parse(genererSarif({ notation, meta: { version: '1.0.0', nomDepot: 'w' } }));
  const loc = sarif.runs[0].results[0].locations[0].physicalLocation;
  assert.equal(loc.artifactLocation.uri, 'app.js');
  assert.equal(loc.region.startLine, 12);
});

test('la sévérité critique se traduit en niveau SARIF error, mineur en note', () => {
  const constats = [
    constat({ regle: 'X', axe: 'A', titre: 't1', severite: 'critique', constat: 'c' }),
    constat({ regle: 'Y', axe: 'A', titre: 't2', severite: 'mineur', constat: 'c' }),
  ];
  const notation = noter(constats, new Set());
  const sarif = JSON.parse(genererSarif({ notation, meta: { version: '1.0.0', nomDepot: 'w' } }));

  const parRegle = Object.fromEntries(sarif.runs[0].results.map((r) => [r.ruleId, r.level]));
  assert.equal(parRegle.X, 'error');
  assert.equal(parRegle.Y, 'note');
});
