import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyserDuplication } from '../src/regles/a-qualite.js';
import { PIEGES_CLONES } from '../scripts/lib/pieges.mjs';

/**
 * Les entrées piégées de la recherche de code dupliqué (`scripts/lib/pieges.mjs`, que `scripts/chronometrer-pieges.mjs` chronomètre) : des répétitions de la taille où un
 * défaut se verrait, lues par la règle telle qu'elle tourne, sous les plafonds par défaut. Aucun temps n'est jugé ici (aucun budget en temps réel dans la suite) : la recherche
 * ne s'abandonne pas, et ce qu'elle rend dit ce qu'elle a fait. Une recherche que le plafond arrête rend ce qu'elle avait trouvé et le dit, jamais rien en silence.
 */

/** Le widget que fabrique un piège, écrit dans un dossier temporaire et lu comme l'inventaire le lit : le code que la page charge est exécuté. */
function analyser(fabriquer) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-clones-'));
  try {
    for (const [fichier, contenu] of Object.entries(fabriquer())) fs.writeFileSync(path.join(dossier, fichier), contenu);
    return analyserDuplication(construireContexte(dossier));
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}

const ATTENDU = {
  repete: 'des clones, ou une mesure partielle qui dit que la recherche s\'est arrêtée',
  ecarte: 'écarté de la comparaison, et dit',
  libre: 'la recherche ne lève pas',
};

for (const [nom, fabriquer, attendu] of PIEGES_CLONES) {
  test(`entrée piégée « ${nom} » : ${ATTENDU[attendu]}`, () => {
    const constats = analyser(fabriquer);
    const clones = constats.filter((c) => c.regle === 'A-DUP-01');
    const laisse = constats.find((c) => c.regle === 'A-DUP-00');
    if (attendu === 'repete') {
      assert.ok(clones.length === 1 || laisse?.mesurePartielle === true, 'le code se répète : des clones, ou le constat que la recherche est partielle');
    } else if (attendu === 'ecarte') {
      assert.deepEqual(clones, []);
      assert.match(laisse?.constat ?? '', /minifiés/);
      assert.equal(laisse.mesurePartielle, false, 'ce qu\'une exclusion écarte ne rend pas la mesure partielle');
    }
    assert.ok(constats.every((c) => c.regle === 'A-DUP-01' || c.regle === 'A-DUP-00'), 'la règle ne rend que ses deux constats');
    assert.ok(clones.length <= 1, 'un seul constat de duplication pour tout le dépôt');
  });
}
