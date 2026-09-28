import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constat } from '../src/moteur/modele.js';
import { noter, noterAxe } from '../src/moteur/notation.js';

const arrondi = (x) => Math.round(x * 10) / 10;

test('un seul point bloquant condamne le verdict quel que soit le score', () => {
  const constats = [constat({ regle: 'X', axe: 'C', titre: 'fuite', severite: 'critique', bloquant: true, constat: 'c' })];
  const n = noter(constats, new Set(['D']));
  assert.equal(n.verdict, 'NON CONFORME');
  assert.equal(n.bloquants.length, 1);
});

test('un axe non exécuté est exclu du score global plutôt que noté 100', () => {
  const n1 = noter([], new Set());
  const n2 = noter([], new Set(['D']));
  assert.equal(n1.parAxe.D.score, 100);
  assert.equal(n2.parAxe.D.score, null);
  assert.ok(n2.axesNonExecutes.includes('D'));
});

test('un axe non exécuté abaisse le verdict et le dit dans le motif, jamais silencieusement', () => {
  const n = noter([], new Set(['D']));
  assert.equal(n.verdict, 'CONFORME SOUS RÉSERVE');
  assert.match(n.motif, /non exécuté/);
  assert.match(n.motif, /\bD\b/);
});

test('sans axe manquant, un score haut reste CONFORME sans réserve', () => {
  const n = noter([], new Set());
  assert.equal(n.verdict, 'CONFORME');
  assert.doesNotMatch(n.motif, /non exécuté/);
});

test('noterAxe est non-croissante : une pénalité plus grande ne rend jamais une note supérieure', () => {
  // Défaut corrigé cette fois : à la jonction entre les deux branches, une
  // remontée artificielle ferait qu'une pénalité plus grande obtienne une
  // MEILLEURE note. Le score arrondi peut plafonner par paliers une fois la
  // pénalité très grande (il n'y a que 8 valeurs entières disponibles entre
  // le seuil et 0), mais il ne doit jamais remonter.
  let precedent = noterAxe(0);
  for (let p = 1; p <= 1000; p++) {
    const score = noterAxe(p);
    assert.ok(score <= precedent, `pénalité ${p} : score ${score} ne doit jamais dépasser le score en ${p - 1} (${precedent})`);
    precedent = score;
  }
});

test('noterAxe ne touche aucun score déjà publié sous le seuil du plancher souple', () => {
  assert.equal(noterAxe(0), 100);
  assert.equal(noterAxe(12), 88);
  assert.equal(noterAxe(38), 62); // axe D mesuré sur publipostageGrist
  assert.equal(noterAxe(92), 8); // le seuil exact : jonction entre les deux branches
});

test('noterAxe reste distincte et cohérente au-delà de l\'ancien plancher à 0', () => {
  const a = noterAxe(141); // pénalité observée sur l'axe A de publipostageGrist avant la correction A-TEST-01/02
  const c = noterAxe(130); // axe C mesuré sur publipostageGrist
  assert.ok(a > 0 && c > 0, 'les deux doivent rester au-dessus de 0, jamais atteint exactement');
  assert.notEqual(a, c, 'deux pénalités différentes ne doivent plus rendre le même score muet');
  assert.ok(a < 8 && c < 8, 'toujours nettement pire que le seuil, pas une remontée artificielle');
});

test('la pénalité brute est exposée telle quelle, même quand le score arrondi sature', () => {
  const beaucoup = Array.from({ length: 5 }, (_, i) => constat({ regle: `R${i}`, axe: 'A', titre: 't', severite: 'critique', bloquant: false, constat: 'c' }));
  const n = noter(beaucoup, new Set());
  assert.ok(n.parAxe.A.penaliteBrute > 100, `pénalité brute attendue > 100, obtenue ${n.parAxe.A.penaliteBrute}`);
  assert.equal(n.parAxe.A.score, noterAxe(n.parAxe.A.penaliteBrute));
});

test('les occurrences répétées d\'une même règle sont plafonnées, pas simplement additionnées', () => {
  const beaucoup = Array.from({ length: 50 }, () => constat({ regle: 'REP', axe: 'A', titre: 't', severite: 'mineur', constat: 'c' }));
  const n = noter(beaucoup, new Set());
  // Avec une pénalité linéaire non plafonnée, 50 occurrences mineures (3 pts) auraient annulé le score.
  assert.ok(n.parAxe.A.score > 0, `score attendu > 0, obtenu ${n.parAxe.A.score}`);
});

test('un constat mesurePartielle (ex. E-VULN-00) garde son axe dans la moyenne, contrairement à un axe non exécuté', () => {
  const c = constat({ regle: 'E-VULN-00', axe: 'E', titre: 'npm audit injoignable', severite: 'info', constat: 'c', mesurePartielle: true });
  const n = noter([c], new Set());
  assert.notEqual(n.parAxe.E.score, null, 'l\'axe a tourné : il ne doit pas être exclu comme un axe non exécuté');
  assert.ok(n.axesPartiels.includes('E'));
  assert.ok(!n.axesNonExecutes.includes('E'), 'mesurePartielle et axe non exécuté sont deux mécanismes distincts');
});

test('un constat mesurePartielle plafonne le verdict à SOUS RÉSERVE et le nomme dans le motif', () => {
  const c = constat({ regle: 'E-VULN-00', axe: 'E', titre: 'npm audit injoignable', severite: 'info', constat: 'c', mesurePartielle: true });
  const n = noter([c], new Set());
  assert.equal(n.verdict, 'CONFORME SOUS RÉSERVE');
  assert.match(n.motif, /npm audit injoignable/);
});

test('E-DEP-03 (pas de package.json, rien à mesurer) ne plafonne jamais le verdict : ce n\'est pas un échec', () => {
  const c = constat({ regle: 'E-DEP-03', axe: 'E', titre: 'Aucune dépendance déclarée', severite: 'info', constat: 'c' });
  const n = noter([c], new Set());
  assert.equal(n.verdict, 'CONFORME');
  assert.equal(n.axesPartiels.length, 0, 'l\'absence de dépendances ne doit jamais faire basculer un widget par ailleurs sain');
});

// ---------------------------------------------------------------------------
// D4 (relevé par la coordination le 2026-09-28) : la pénalité d'une règle
// suivait la sévérité de sa PREMIÈRE occurrence dans l'ordre d'itération —
// un ordre arbitraire, sans rapport avec la sévérité réelle des occurrences.
// Ajouter une occurrence plus légère APRÈS une occurrence plus grave de la
// même règle pouvait donc faire RETOMBER la pénalité totale : mesuré par la
// coordination, un majeur puis un critique donnait 20,3, un critique puis un
// majeur (mêmes deux occurrences, ordre inversé) donnait 59,3.
// ---------------------------------------------------------------------------

test("D4 : l'ordre des deux mêmes occurrences ne change rien, et le critique pèse au premier rang", () => {
  const majeurPuisCritique = [
    constat({ regle: 'X', axe: 'C', titre: 't', severite: 'majeur', constat: 'c' }),
    constat({ regle: 'X', axe: 'C', titre: 't', severite: 'critique', constat: 'c' }),
  ];
  const critiquePuisMajeur = [...majeurPuisCritique].reverse();
  const n1 = noter(majeurPuisCritique, new Set());
  const n2 = noter(critiquePuisMajeur, new Set());
  assert.equal(n1.parAxe.C.penaliteBrute, n2.parAxe.C.penaliteBrute, "l'ordre d'itération ne doit jamais changer la pénalité calculée");
  // Le critique au premier rang (poids 1), le majeur au second (poids ln 2) :
  // avant D4, l'ordre « majeur puis critique » retenait à tort le majeur.
  assert.equal(n1.parAxe.C.penaliteBrute, arrondi(35 + 12 * Math.log(2)));
});

test("D4 : ajouter une occurrence plus légère AVANT une occurrence critique déjà présente (donc désormais première dans l'ordre d'itération) ne doit jamais FAIRE BAISSER la pénalité", () => {
  const critiqueSeul = [constat({ regle: 'X', axe: 'C', titre: 't', severite: 'critique', constat: 'c' })];
  // Le majeur est ajouté EN TÊTE de liste : occ[0] devient le majeur, alors
  // que la pire occurrence reste le critique — exactement le cas que l'ancien
  // code (qui retenait occ[0]) notait à tort plus clément.
  const majeurAvantCritique = [constat({ regle: 'X', axe: 'C', titre: 't', severite: 'majeur', constat: 'c' }), ...critiqueSeul];
  const p1 = noter(critiqueSeul, new Set()).parAxe.C.penaliteBrute;
  const p2 = noter(majeurAvantCritique, new Set()).parAxe.C.penaliteBrute;
  assert.ok(p2 >= p1, `ajouter un constat, même moins sévère et même placé en tête, ne doit jamais faire baisser la pénalité (${p1} → ${p2})`);
});

test('D4 : le détail de pénalité par règle (detailPenalites) rapporte la sévérité de la pire occurrence', () => {
  const constats = [
    constat({ regle: 'X', axe: 'C', titre: 't', severite: 'majeur', constat: 'c' }),
    constat({ regle: 'X', axe: 'C', titre: 't', severite: 'critique', constat: 'c' }),
  ];
  const n = noter(constats, new Set());
  const d = n.parAxe.C.detailPenalites.find((d) => d.regle === 'X');
  assert.equal(d.severite, 'critique');
});

// ---------------------------------------------------------------------------
// Poids par rang (relevé par la coordination le 2026-09-28) : une information
// ne compte jamais, et chaque occurrence pèse sa propre sévérité au poids que
// `facteurOccurrences` donne à son rang, f(k) − f(k−1).
// ---------------------------------------------------------------------------

const f = (k) => Math.min(1 + Math.log(k), 2.5);
const PENALITE = { critique: 35, majeur: 12, mineur: 3, info: 0 };
const occurrences = (...severites) => severites.map((severite) => constat({ regle: 'X', axe: 'A', titre: 't', severite, constat: 'c' }));
const penaliteDe = (...severites) => noter(occurrences(...severites), new Set()).parAxe.A.penaliteBrute;

test("une information ne compte jamais, ni par sa sévérité ni par son nombre (un critique et trente informations : 35, pas 87,5)", () => {
  assert.equal(penaliteDe('critique', 'info'), 35);
  assert.equal(penaliteDe('critique', ...Array(30).fill('info')), 35);
  assert.equal(penaliteDe('mineur', ...Array(4).fill('info'), 'mineur'), arrondi(3 * f(2)));
});

test("une règle qui n'a que des informations ne pèse rien et n'entre pas dans le détail des pénalités", () => {
  const n = noter(occurrences('info', 'info', 'info'), new Set());
  assert.equal(n.parAxe.A.penaliteBrute, 0);
  assert.deepEqual(n.parAxe.A.detailPenalites, []);
});

test('chaque occurrence pèse sa propre sévérité au poids de son rang, la plus grave en premier', () => {
  assert.equal(penaliteDe('mineur', 'majeur'), arrondi(12 + 3 * Math.log(2)));
  // Une fonction majeure parmi quatre mineures (le cas d'A-FONC-02) : le
  // majeur au premier rang, les mineurs aux rangs 2 à 5.
  assert.equal(penaliteDe('mineur', 'mineur', 'majeur', 'mineur', 'mineur'), arrondi(12 + 3 * (f(5) - f(1))));
});

test("à sévérités égales, la pénalité vaut exactement l'ancienne formule (sévérité × f(n))", () => {
  for (const severite of ['critique', 'majeur', 'mineur']) {
    for (let n = 1; n <= 12; n++) {
      assert.equal(penaliteDe(...Array(n).fill(severite)), arrondi(PENALITE[severite] * f(n)), `${n} × ${severite}`);
    }
  }
});

test("la pénalité ne dépend pas de l'ordre des occurrences", () => {
  const base = ['mineur', 'critique', 'info', 'majeur', 'mineur', 'majeur'];
  const attendu = penaliteDe(...base);
  const permutations = (liste) => (liste.length <= 1 ? [liste] : liste.flatMap((x, i) => permutations([...liste.slice(0, i), ...liste.slice(i + 1)]).map((p) => [x, ...p])));
  for (const p of permutations(base)) assert.equal(penaliteDe(...p), attendu, p.join(' '));
});

test("ajouter une occurrence ne fait jamais baisser la pénalité, qui ne dépasse jamais l'ancienne formule (pire × f(n))", () => {
  const severites = ['critique', 'majeur', 'mineur'];
  const multiensembles = (taille, depuis = 0) => (taille === 0 ? [[]] : severites.slice(depuis).flatMap((s, i) => multiensembles(taille - 1, depuis + i).map((m) => [s, ...m])));
  for (let taille = 1; taille <= 6; taille++) {
    for (const m of multiensembles(taille)) {
      const avant = penaliteDe(...m);
      assert.ok(avant <= arrondi(Math.max(...m.map((s) => PENALITE[s])) * f(m.length)) + 1e-9, `${m.join(' ')} dépasse pire × f(n)`);
      for (const ajout of [...severites, 'info']) {
        const apres = penaliteDe(...m, ajout);
        assert.ok(apres >= avant, `${m.join(' ')} + ${ajout} : ${avant} → ${apres}`);
      }
    }
  }
});

test("le détail d'une règle ne compte que ses occurrences pénalisantes", () => {
  const d = noter(occurrences('info', 'majeur', 'info', 'mineur'), new Set()).parAxe.A.detailPenalites[0];
  assert.equal(d.occurrences, 2);
  assert.equal(d.severite, 'majeur');
  assert.equal(d.penalite, arrondi(12 + 3 * Math.log(2)));
});
