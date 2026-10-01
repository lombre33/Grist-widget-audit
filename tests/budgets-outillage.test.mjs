/**
 * L'outillage des budgets de temps (scripts/lib/budgets.mjs, scripts/lib/cas-budget.mjs, scripts/verifier-budgets.mjs) :
 * ce qu'il refuse, comment il juge un cas, ce qu'il fait d'un cas qui plante ou qui ne finit pas. Aucun essai ici
 * ne dépend de l'horloge : un cas « lent » l'est parce que son budget est nul et qu'il travaille au moins 5 ms, un cas
 * « tué » parce qu'il boucle sans fin sous une limite de 400 ms, un cas « tenu » parce qu'il ne fait rien sous un budget
 * de dix mille secondes. Les budgets eux-mêmes sont dans tests/budgets/ (voir scripts/lib/budgets.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ECHANTILLON_MS, FACTEUR_CI, FACTEUR_LIMITE, LIMITE_DURE_MIN_MS, OCCUPATION_MAX, budgetRetenu, executerCas, jugerCas, limiteDure, listerCas,
  mesurerOccupation, occupationEntre, refusSousCharge, verifierBudgets,
} from '../scripts/lib/budgets.mjs';

const SCRIPT = new URL('../scripts/verifier-budgets.mjs', import.meta.url).pathname;

/** Un dossier de fichiers de budgets : nom → source du module. */
function dossierDeBudgets(t, fichiers) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-test-budgets-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  for (const [nom, source] of Object.entries(fichiers)) fs.writeFileSync(path.join(d, nom), source);
  return d;
}
const instantane = (...coeurs) => coeurs.map(([user, sys, idle]) => ({ times: { user, nice: 0, sys, idle, irq: 0 } }));

// --- l'occupation de la machine ------------------------------------------------------------------------------------

test('occupationEntre : la part du temps de processeur qui n\'était pas au repos entre deux instantanés, tous les cœurs ensemble', () => {
  assert.equal(occupationEntre(instantane([0, 0, 0]), instantane([10, 0, 90])), 0.1);
  assert.equal(occupationEntre(instantane([0, 0, 0], [0, 0, 0]), instantane([50, 0, 50], [0, 0, 100])), 0.25, 'un cœur plein, un cœur au repos');
  assert.equal(occupationEntre(instantane([5, 5, 0]), instantane([5, 5, 100])), 0, 'rien n\'a tourné');
  assert.equal(occupationEntre(instantane([0, 0, 0]), instantane([50, 50, 0])), 1);
  assert.equal(occupationEntre(instantane([0, 0, 0]), instantane([0, 40, 60])), 0.4, 'le temps système compte');
});

test('occupationEntre : le temps « nice » et celui des interruptions comptent parmi le temps occupé', () => {
  const t = (user, nice, sys, idle, irq) => [{ times: { user, nice, sys, idle, irq } }];
  assert.equal(occupationEntre(t(0, 0, 0, 0, 0), t(10, 20, 0, 60, 10)), 0.4, 'nice et irq : 30 sur 100');
  assert.equal(occupationEntre(t(0, 0, 0, 0, 0), t(0, 25, 0, 75, 0)), 0.25, 'nice seul');
  assert.equal(occupationEntre(t(0, 0, 0, 0, 0), t(0, 0, 0, 90, 10)), 0.1, 'irq seul');
});

test('occupationEntre : deux instantanés identiques (rien n\'a avancé) ne disent rien, jamais une machine « au calme »', () => {
  assert.equal(occupationEntre(instantane([1, 1, 1]), instantane([1, 1, 1])), null);
});

test('mesurerOccupation : lit, attend, relit ; la durée d\'attente est celle qu\'on demande', () => {
  const lectures = [instantane([0, 0, 0]), instantane([30, 0, 70])];
  const attentes = [];
  const occupation = mesurerOccupation({ ms: 1234, lire: () => lectures.shift(), attendre: (ms) => attentes.push(ms) });
  assert.equal(occupation, 0.3);
  assert.deepEqual(attentes, [1234]);
  assert.equal(lectures.length, 0, 'deux lectures exactement');
  const defaut = [];
  mesurerOccupation({ lire: () => instantane([0, 0, 0]), attendre: (ms) => defaut.push(ms) });
  assert.deepEqual(defaut, [ECHANTILLON_MS], 'sans durée demandée : la fenêtre d\'échantillonnage du mode local');
  assert.equal(ECHANTILLON_MS, 1500, 'une seconde et demie : assez pour voir une charge, assez court pour ne pas retarder chaque lancement');
});

test('refusSousCharge : une machine occupée au-delà du seuil, ou dont l\'occupation est inconnue, est refusée en le disant', () => {
  assert.equal(refusSousCharge(0), null);
  assert.equal(refusSousCharge(OCCUPATION_MAX), null, 'au seuil exact : encore au calme');
  assert.match(refusSousCharge(0.5), /pas au calme \(50 % du processeur occupé, 25 % au plus\)/);
  assert.match(refusSousCharge(0.5), /--ci/, 'et dit où mesurer quand même');
  assert.match(refusSousCharge(0.26), /26 %/);
  for (const inconnue of [null, undefined, NaN]) assert.match(refusSousCharge(inconnue), /n'a pas pu être mesurée/, String(inconnue));
  assert.equal(refusSousCharge(0.4, { max: 0.5 }), null, 'le seuil se règle');
});

// --- les budgets retenus et le jugement d'un cas ---------------------------------------------------------------------

test('budgetRetenu et limiteDure : le budget seul en local, un ordre de grandeur au-dessus en CI ; la limite dure dépasse toujours le budget retenu', () => {
  assert.equal(FACTEUR_CI, 10);
  assert.equal(budgetRetenu(2000, false), 2000);
  assert.equal(budgetRetenu(2000, true), 20_000);
  assert.equal(limiteDure(100, false), LIMITE_DURE_MIN_MS, 'un petit budget : la limite plancher');
  assert.equal(limiteDure(2000, false), Math.max(LIMITE_DURE_MIN_MS, FACTEUR_LIMITE * 2000));
  assert.equal(limiteDure(2000, true), FACTEUR_LIMITE * 20_000);
  for (const budget of [1, 1000, 90_000]) for (const ci of [false, true]) assert.ok(limiteDure(budget, ci) > budgetRetenu(budget, ci), `${budget} ${ci}`);
});

test('jugerCas : tenu, trop lent, fautif, tué ; en CI le budget est celui du cas fois dix', () => {
  const ok = (dureeMs) => ({ statut: 'ok', dureeMs, raison: null });
  assert.deepEqual(jugerCas(ok(1999), 2000, false), { verdict: 'passe', dureeMs: 1999, budgetMs: 2000, raison: null });
  assert.deepEqual(jugerCas(ok(2000), 2000, false), { verdict: 'passe', dureeMs: 2000, budgetMs: 2000, raison: null }, 'au budget exact : tenu');
  assert.deepEqual(jugerCas(ok(2001), 2000, false), { verdict: 'lent', dureeMs: 2001, budgetMs: 2000, raison: null });
  assert.equal(jugerCas(ok(5000), 2000, true).verdict, 'passe', 'en CI, 5 s sur un budget de 2 s : tenu');
  assert.equal(jugerCas(ok(20_001), 2000, true).verdict, 'lent');
  assert.deepEqual(jugerCas({ statut: 'echec', dureeMs: null, raison: 'résultat faux' }, 2000, false), { verdict: 'echec', dureeMs: null, budgetMs: 2000, raison: 'résultat faux' });
  assert.deepEqual(jugerCas({ statut: 'limite', dureeMs: null, raison: 'tué' }, 2000, true), { verdict: 'limite', dureeMs: null, budgetMs: 20_000, raison: 'tué' });
  assert.equal(jugerCas({ statut: 'inconnu', dureeMs: 1, raison: null }, 2000, false).verdict, 'echec', 'un statut qu\'on ne connaît pas n\'est jamais tenu');
});

// --- les cas et leur processus ----------------------------------------------------------------------------------------

const MODULE = (cas) => `export const cas = ${cas};\n`;

test('listerCas : les cas de tous les fichiers *.budget.mjs, dans l\'ordre des noms ; un autre fichier est ignoré ; ignorerSi (même asynchrone) dit pourquoi un cas n\'est pas joué', async (t) => {
  const d = dossierDeBudgets(t, {
    'b.budget.mjs': MODULE("[{ nom: 'b1', budgetMs: 10, executer() {} }, { nom: 'b2', budgetMs: 20, executer() {}, ignorerSi: async () => 'pas de Chromium' }]"),
    'a.budget.mjs': MODULE("[{ nom: 'a1', budgetMs: 5, executer() {}, ignorerSi: () => null }]"),
    'notes.txt': 'pas un budget',
    'lot.mjs': 'throw new Error("ne doit pas être chargé");',
  });
  const cas = await listerCas(d);
  assert.deepEqual(cas.map((c) => [path.basename(c.fichier), c.indice, c.nom, c.budgetMs, c.ignore]), [
    ['a.budget.mjs', 0, 'a1', 5, null], ['b.budget.mjs', 0, 'b1', 10, null], ['b.budget.mjs', 1, 'b2', 20, 'pas de Chromium'],
  ]);
});

test('listerCas : les fichiers sont lus dans l\'ordre des noms, quel que soit l\'ordre où le système de fichiers les rend', async (t) => {
  const fichiers = {};
  for (const n of ['e', 'd', 'c', 'b', 'a']) fichiers[`${n}.budget.mjs`] = MODULE(`[{ nom: '${n}', budgetMs: 10, executer() {} }]`);
  const cas = await listerCas(dossierDeBudgets(t, fichiers));
  assert.deepEqual(cas.map((c) => c.nom), ['a', 'b', 'c', 'd', 'e']);
});

test('listerCas : un fichier sans cas, ou un cas mal formé, est une erreur qui nomme le fichier (un budget qui ne s\'exécute pas ne prouve rien)', async (t) => {
  const mal = async (source, motif) => {
    const d = dossierDeBudgets(t, { 'x.budget.mjs': source });
    await assert.rejects(listerCas(d), motif);
  };
  await mal('export const autre = 1;', /x\.budget\.mjs : doit exporter `cas`/);
  await mal(MODULE('[]'), /x\.budget\.mjs : doit exporter `cas`, une liste non vide/);
  await mal(MODULE("[{ nom: 'a', budgetMs: 0, executer() {} }]"), /x\.budget\.mjs, cas 1 : \{ nom, budgetMs > 0, executer \} attendus/);
  await mal(MODULE("[{ nom: 'a', budgetMs: 10, executer() {} }, { nom: '', budgetMs: 10, executer() {} }]"), /cas 2/);
  await mal(MODULE("[{ nom: 'a', budgetMs: 10 }]"), /cas 1/);
  await mal(MODULE("[{ nom: 7, budgetMs: 10, executer() {} }]"), /cas 1/);
  await mal(MODULE("[{ nom: 'a', executer() {} }]"), /cas 1/);
});

test('executerCas : un cas tenu rend sa durée mesurée dans son processus ; celle qu\'il rend lui-même l\'emporte', async (t) => {
  const d = dossierDeBudgets(t, { 'x.budget.mjs': MODULE("[{ nom: 'rien', budgetMs: 1, executer() {} }, { nom: 'sa durée', budgetMs: 1, executer() { return { dureeMs: 123 }; } }, { nom: 'attend 30 ms', budgetMs: 1, async executer() { await new Promise((r) => setTimeout(r, 30)); } }]") });
  const [rien, sienne, attend] = await listerCas(d);
  const r1 = executerCas(rien, { limiteMs: 60_000 });
  assert.equal(r1.statut, 'ok');
  assert.ok(Number.isFinite(r1.dureeMs) && r1.dureeMs >= 0 && r1.dureeMs < 5000, `${r1.dureeMs}`);
  assert.deepEqual(executerCas(sienne, { limiteMs: 60_000 }), { statut: 'ok', dureeMs: 123, raison: null });
  const r3 = executerCas(attend, { limiteMs: 60_000 });
  assert.ok(r3.dureeMs >= 25, `un cas qui attend 30 ms dure au moins ces 30 ms : ${r3.dureeMs}`);
});

test('executerCas : un cas qui écrit sur sa sortie standard est lu par sa dernière ligne ; un cas qui sort en erreur après avoir dit sa durée n\'est pas tenu', async (t) => {
  const d = dossierDeBudgets(t, { 'x.budget.mjs': MODULE("[{ nom: 'bavard', budgetMs: 1, executer() { console.log('du bruit avant'); console.log('du bruit encore'); } }, { nom: 'sort mal', budgetMs: 1, executer() { process.exitCode = 3; } }, { nom: 'se tue', budgetMs: 1, executer() { process.kill(process.pid, 'SIGKILL'); } }]") });
  const [bavard, sortMal, seTue] = await listerCas(d);
  const r1 = executerCas(bavard, { limiteMs: 60_000 });
  assert.equal(r1.statut, 'ok', r1.raison);
  assert.ok(Number.isFinite(r1.dureeMs));
  const r2 = executerCas(sortMal, { limiteMs: 60_000 });
  assert.equal(r2.statut, 'echec', 'le code de sortie compte, même quand la durée a été dite');
  assert.match(r2.raison, /sorti avec le code 3/);
  if (process.platform !== 'win32') {   // sous Windows un processus tué n'a pas de signal : il sort en code 1, et le dit comme tel
    const r3 = executerCas(seTue, { limiteMs: 60_000 });
    assert.equal(r3.statut, 'echec');
    assert.match(r3.raison, /tué par SIGKILL/);
  }
});

test('executerCas : une dernière ligne de sortie qui n\'est pas la durée n\'est pas une durée, même avec le code 0', async (t) => {
  const d = dossierDeBudgets(t, { 'x.budget.mjs': MODULE("[{ nom: 'truque', budgetMs: 1, executer() { process.on('exit', () => console.log(JSON.stringify({ erreur: 'sortie truquée' }))); } }]") });
  const [truque] = await listerCas(d);
  const r = executerCas(truque, { limiteMs: 60_000 });
  assert.equal(r.statut, 'echec', 'la durée dite avant, le code 0 : rien n\'y fait, la dernière ligne n\'en est pas une');
  assert.equal(r.raison, 'sortie truquée');
});

test('executerCas : le cas qui meurt sans rien dire est accompagné des trois dernières lignes de son erreur, bornées', async (t) => {
  const d = dossierDeBudgets(t, { 'x.budget.mjs': MODULE("[{ nom: 'bavard', budgetMs: 1, executer() { for (const n of [1, 2, 3, 4]) console.error('ligne ' + n); console.error('x'.repeat(1000)); process.exit(7); } }, { nom: 'court', budgetMs: 1, executer() { for (const n of [1, 2, 3, 4]) console.error('ligne ' + n); process.exit(7); } }]") });
  const [bavard, court] = await listerCas(d);
  const r = executerCas(court, { limiteMs: 60_000 });
  assert.equal(r.statut, 'echec');
  assert.match(r.raison, /sorti avec le code 7 : ligne 2 \| ligne 3 \| ligne 4$/, 'les trois dernières, dans l\'ordre');
  assert.doesNotMatch(r.raison, /ligne 1/);
  const long = executerCas(bavard, { limiteMs: 60_000 });
  assert.ok(long.raison.length < 600, `la fin de l'erreur est bornée : ${long.raison.length} caractères`);
  assert.ok(long.raison.endsWith('x'), 'et c\'est la fin qui reste');
});

test('executerCas : le chargement du module n\'est pas mesuré, seul executer l\'est', async (t) => {
  const d = dossierDeBudgets(t, { 'x.budget.mjs': `const fin = Date.now() + 300; while (Date.now() < fin) {}\n${MODULE("[{ nom: 'rien', budgetMs: 1, executer() {} }]")}` });
  const [cas] = await listerCas(d);   // le chargement (300 ms) a lieu ici, une fois ; le processus du cas le refait, sans qu'il compte
  const r = executerCas(cas, { limiteMs: 60_000 });
  assert.equal(r.statut, 'ok');
  assert.ok(r.dureeMs < 250, `le chargement de 300 ms n'est pas dans la mesure : ${r.dureeMs}`);
});

test('executerCas : un cas qui lève est fautif et dit pourquoi (un budget tenu par un résultat faux ne prouve rien)', async (t) => {
  const d = dossierDeBudgets(t, { 'x.budget.mjs': MODULE("[{ nom: 'faux', budgetMs: 1, executer() { throw new Error('le résultat est faux\\nsuite'); } }, { nom: 'rejet', budgetMs: 1, async executer() { throw new Error('rejeté'); } }]") });
  const [faux, rejet] = await listerCas(d);
  assert.deepEqual(executerCas(faux, { limiteMs: 60_000 }), { statut: 'echec', dureeMs: null, raison: 'le résultat est faux' });
  assert.deepEqual(executerCas(rejet, { limiteMs: 60_000 }), { statut: 'echec', dureeMs: null, raison: 'rejeté' });
});

test('executerCas : un cas qui ne finit pas est tué à la limite dure, et dit tué (pas une durée)', async (t) => {
  const d = dossierDeBudgets(t, { 'x.budget.mjs': MODULE("[{ nom: 'boucle', budgetMs: 1, executer() { for (;;) {} } }]") });
  const [boucle] = await listerCas(d);
  const r = executerCas(boucle, { limiteMs: 400 });
  assert.equal(r.statut, 'limite');
  assert.equal(r.dureeMs, null);
  assert.match(r.raison, /limite dure de \d+ s : le processus a été tué/);
});

test('executerCas : un processus qui meurt sans rien dire (sortie brutale, module qui plante au chargement, cas absent) est fautif, avec sa cause', async (t) => {
  const d = dossierDeBudgets(t, {
    'sortie.budget.mjs': MODULE("[{ nom: 'sort', budgetMs: 1, executer() { process.exit(7); } }]"),
    'plante.budget.mjs': `throw new Error('chargement');\n${MODULE("[{ nom: 'x', budgetMs: 1, executer() {} }]")}`,
  });
  const sort = { fichier: path.join(d, 'sortie.budget.mjs'), indice: 0 };
  const r1 = executerCas(sort, { limiteMs: 60_000 });
  assert.equal(r1.statut, 'echec');
  assert.match(r1.raison, /sorti avec le code 7/);
  const r2 = executerCas({ fichier: path.join(d, 'plante.budget.mjs'), indice: 0 }, { limiteMs: 60_000 });
  assert.equal(r2.statut, 'echec');
  assert.match(r2.raison, /chargement/);
  const r3 = executerCas({ fichier: sort.fichier, indice: 5 }, { limiteMs: 60_000 });
  assert.equal(r3.statut, 'echec');
  assert.match(r3.raison, /n'a pas de cas 5/);
});

// --- la commande -------------------------------------------------------------------------------------------------------

async function lancer(t, fichiers, argv, options = {}) {
  const d = dossierDeBudgets(t, fichiers);
  const sortie = [];
  const erreurs = [];
  const code = await verifierBudgets({ argv, dossier: d, sortie: (l) => sortie.push(l), erreur: (l) => erreurs.push(l), ...options });
  return { code, sortie: sortie.join('\n'), erreurs: erreurs.join('\n') };
}
const TROIS_CAS = {
  'x.budget.mjs': MODULE("[{ nom: 'tenu', budgetMs: 10_000_000, executer() {} }, { nom: 'lent', budgetMs: 0.0001, executer() { const fin = performance.now() + 5; while (performance.now() < fin) {} } }, { nom: 'faux', budgetMs: 10_000_000, executer() { throw new Error('non'); } }]"),
};

test('verifierBudgets : chaque cas est dit tenu, trop lent ou fautif avec ses chiffres ; le code est 1 dès qu\'un cas n\'est pas tenu', async (t) => {
  const r = await lancer(t, TROIS_CAS, ['--ci'], {});
  assert.equal(r.code, 1);
  assert.match(r.sortie, /^Mode CI : chaque budget multiplié par 10, aucun refus sous charge\./);
  assert.match(r.sortie, /^ok {8}\d+ ms sur 100000000 ms {2}tenu$/m);
  assert.match(r.sortie, /^TROP LENT \d+ ms sur 0\.001 ms {2}lent$/m);
  assert.match(r.sortie, /^FAUTIF {3} faux {2}\(non\)$/m);
  assert.match(r.sortie, /1\/3 cas tenus, 2 non tenus\.$/);
  assert.equal(r.erreurs, '');
});

test('verifierBudgets : tous tenus, code 0 ; --liste ne lance rien et dit les budgets retenus du mode ; un filtre restreint les cas', async (t) => {
  const seul = await lancer(t, TROIS_CAS, ['--ci', '^tenu$'], {});
  assert.equal(seul.code, 0);
  assert.match(seul.sortie, /1\/1 cas tenus\.$/);
  const liste = await lancer(t, TROIS_CAS, ['--liste', '^t'], {});
  assert.equal(liste.code, 0);
  assert.match(liste.sortie, /^10000000 ms {2}tenu$/);
  assert.doesNotMatch(liste.sortie, /Mode /, 'rien n\'a été mesuré');
  const listeCi = await lancer(t, TROIS_CAS, ['--liste', '--ci', '^t'], {});
  assert.match(listeCi.sortie, /^100000000 ms {2}tenu$/, 'le budget retenu en CI');
});

test('verifierBudgets : aucun cas retenu (filtre qui ne correspond à rien) : rien n\'a été mesuré, code 2 ; ce n\'est pas un succès', async (t) => {
  const r = await lancer(t, TROIS_CAS, ['--ci', 'rien-de-tel'], {});
  assert.equal(r.code, 2);
  assert.match(r.erreurs, /Aucun cas de budget pour « rien-de-tel » : rien à mesurer\./);
  assert.equal(r.sortie, '');
});

test('verifierBudgets : en local, une machine occupée ou inconnue est refusée (code 2, aucun cas lancé) ; au calme le mode local juge le budget lui-même ; en CI la charge est ignorée', async (t) => {
  const charge = await lancer(t, TROIS_CAS, ['^tenu$'], { occupation: () => 0.9 });
  assert.equal(charge.code, 2);
  assert.match(charge.erreurs, /^Budgets non mesurés : la machine n'est pas au calme \(90 %/);
  assert.equal(charge.sortie, '', 'aucun cas lancé');
  const inconnue = await lancer(t, TROIS_CAS, ['^tenu$'], { occupation: () => null });
  assert.equal(inconnue.code, 2);
  const calme = await lancer(t, TROIS_CAS, ['^tenu$'], { occupation: () => 0.05 });
  assert.equal(calme.code, 0, calme.erreurs);
  assert.match(calme.sortie, /^Mode local : le budget de chaque cas, machine au calme\./);
  assert.match(calme.sortie, /sur 10000000 ms {2}tenu/, 'le budget lui-même, pas multiplié');
  const ci = await lancer(t, TROIS_CAS, ['--ci', '^tenu$'], { occupation: () => 0.99 });
  assert.equal(ci.code, 0, 'en CI, une occupation élevée ne refuse rien');
});

test('verifierBudgets : un cas ignoré est dit, compté à part, et ne compte ni comme tenu ni comme raté', async (t) => {
  const r = await lancer(t, { 'x.budget.mjs': MODULE("[{ nom: 'tenu', budgetMs: 10_000_000, executer() {} }, { nom: 'chromium', budgetMs: 10, executer() { throw new Error('ne doit pas se lancer'); }, ignorerSi: () => 'Chromium introuvable' }]") }, ['--ci'], {});
  assert.equal(r.code, 0, r.sortie);
  assert.match(r.sortie, /^IGNORÉ {4}chromium {2}\(Chromium introuvable\)$/m);
  assert.match(r.sortie, /1\/1 cas tenus, 1 ignoré \(dit ci-dessus : un cas ignoré n'a rien mesuré\)\.$/);
  const liste = await lancer(t, { 'x.budget.mjs': MODULE("[{ nom: 'chromium', budgetMs: 10, executer() {}, ignorerSi: () => 'Chromium introuvable' }]") }, ['--liste'], {});
  assert.match(liste.sortie, /chromium {2}\(ignoré : Chromium introuvable\)$/);
});

test('scripts/verifier-budgets.mjs : la commande lit ses arguments et sort avec le code de verifierBudgets (--liste sur les vrais budgets)', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--liste', '--ci'], { encoding: 'utf8', timeout: 120_000 });   // une commande qui ignorerait `--liste` mesurerait chaque budget : elle est arrêtée ici
  assert.equal(r.status, 0, `${r.stderr}${r.error ?? ''}`);
  assert.doesNotMatch(r.stdout, /Mode CI/, '--liste ne mesure rien');
  assert.match(r.stdout, /ms {2}CSS piégé : accolades ouvrantes/);
  assert.match(r.stdout, /moteur de mutants : un lot tué par SIGTERM/);
  const rien = spawnSync(process.execPath, [SCRIPT, '--liste', 'ce-cas-n-existe-pas'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(rien.status, 2);
});

test('les budgets réels : chacun est bien formé (nom, budget, executer) et les noms sont distincts', async () => {
  const cas = await listerCas();
  assert.ok(cas.length >= 60, `${cas.length} cas`);
  assert.equal(new Set(cas.map((c) => c.nom)).size, cas.length, 'deux cas ne portent pas le même nom');
  for (const c of cas) assert.ok(c.budgetMs > 0 && c.budgetMs <= 90_000, c.nom);
});
