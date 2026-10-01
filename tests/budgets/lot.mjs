/**
 * Les budgets de temps, vus comme des essais `node:test` : c'est ce que rejoue `scripts/mutants-budgets.mjs`, le lot des
 * mutants que la suite par défaut ne voit pas (ils ne changent pas un résultat, seulement le temps qu'il faut pour
 * l'obtenir). Ce n'est pas un fichier de la suite par défaut (`npm test` ne lit que `tests/*.test.mjs`), et ce n'est pas
 * `scripts/verifier-budgets.mjs` non plus, qui juge, refuse sous charge et se lance à la main ou en CI.
 *
 * Le budget est celui du cas, sans facteur : un mutant quadratique le dépasse de plusieurs ordres de grandeur, et c'est
 * ce qui le tue. `GWAUDIT_BUDGETS_CAS` (expression régulière sur le nom) restreint les cas, pour que le lot ne rejoue
 * pas ceux qu'aucun de ses mutants ne touche. Le premier cas qui n'est pas tenu arrête les suivants (dits sautés) :
 * un mutant quadratique laisserait sinon chacun d'eux courir jusqu'à sa limite dure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { executerCas, jugerCas, limiteDure, listerCas } from '../../scripts/lib/budgets.mjs';

const filtre = process.env.GWAUDIT_BUDGETS_CAS ? new RegExp(process.env.GWAUDIT_BUDGETS_CAS) : null;
const cas = (await listerCas()).filter((c) => !filtre || filtre.test(c.nom));
let premierEchec = null;

test('des cas de budget sont retenus (un filtre qui n\'en garde aucun ne prouverait rien)', () => {
  assert.ok(cas.length > 0, `aucun cas ne correspond à GWAUDIT_BUDGETS_CAS=${process.env.GWAUDIT_BUDGETS_CAS}`);
});

for (const c of cas) {
  test(`budget ${c.budgetMs} ms : ${c.nom}`, { skip: c.ignore ?? false }, (t) => {
    if (premierEchec) return t.skip(`un cas précédent n'est pas tenu : ${premierEchec}`);
    const r = jugerCas(executerCas(c, { limiteMs: limiteDure(c.budgetMs, false) }), c.budgetMs, false);
    if (r.verdict !== 'passe') premierEchec = c.nom;
    assert.equal(r.verdict, 'passe', `${r.verdict}${r.dureeMs === null ? '' : ` : ${Math.round(r.dureeMs)} ms sur ${r.budgetMs} ms`}${r.raison ? ` (${r.raison})` : ''}`);
  });
}
