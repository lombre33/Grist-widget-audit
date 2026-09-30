/**
 * Un widget qui empêche une mesure (il bloque le navigateur, un fichier de code n'a pas pu être lu) ne note
 * jamais mieux que s'il la laissait se faire. `axesEmpeches` sur un constat bloquant met ces axes à 0, dit ce
 * qu'ils vaudraient sur ce qui a pu être lu et pourquoi ils sont à 0, dans les trois rapports, dans la feuille
 * de route et dans la comparaison de deux rapports. Il ne se confond pas avec `mesurePartielle` (un choix ou
 * l'environnement : l'axe garde sa note) ni avec un axe que l'utilisateur n'a pas lancé (`axesNonExecutes`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AXES, constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';
import { genererHtml } from '../src/rapport/html.js';
import { genererMarkdown } from '../src/rapport/markdown.js';
import { genererJson } from '../src/rapport/json.js';

const cause = (extra = {}) => constat({
  regle: 'C-SURFACE-02', axe: 'C', titre: 'Fichier de code non lu', severite: 'critique', bloquant: true,
  constat: 'Le fichier gros.js n\'a pas été lu.', fichier: 'gros.js', axesEmpeches: ['C', 'E'], ...extra,
});
const autre = (regle, axe, severite, extra = {}) => constat({ regle, axe, titre: `titre ${regle}`, severite, constat: 'c', ...extra });
const sansEmpechement = (constats) => constats.map((c) => constat({ ...c, axesEmpeches: [] }));

// C : un critique (35) et un majeur (12) → 53 ; E : un mineur (3) → 97 ; A, B, F : 100 ; D non lancé.
const widget = () => [cause(), autre('C-XSS-04', 'C', 'majeur'), autre('E-DEP-05', 'E', 'mineur')];
const noterSansD = (constats) => noter(constats, new Set(['D']));

const meta = { nomDepot: 'w', version: '0' };
const ctx = () => ({ fichiers: [], surface: new Set(), entrees: [] });
const pages = (notation) => ({
  html: genererHtml({ ctx: ctx(), notation, meta }),
  md: genererMarkdown({ ctx: ctx(), notation, meta }),
  json: JSON.parse(genererJson({ ctx: ctx(), notation, meta })),
});

test('axesEmpeches : absent, il vaut [] ; une liste se range dans l\'ordre des axes, sans doublon', () => {
  assert.deepEqual(autre('A-X', 'A', 'mineur').axesEmpeches, []);
  assert.deepEqual(cause({ axesEmpeches: ['F', 'D', 'D', 'C'] }).axesEmpeches, ['C', 'D', 'F']);
  assert.deepEqual(cause({ axesEmpeches: [] }).axesEmpeches, []);
});

test('axesEmpeches : ce qui n\'est pas une liste de codes d\'axe connus est refusé, jamais ignoré', () => {
  assert.throws(() => cause({ axesEmpeches: 'D' }), /liste de codes d'axe/);
  assert.throws(() => cause({ axesEmpeches: { D: true } }), /liste de codes d'axe/);
  assert.throws(() => cause({ axesEmpeches: ['Z'] }), /Axe inconnu dans axesEmpeches : Z/);
  assert.throws(() => cause({ axesEmpeches: ['C', 'd'] }), /Axe inconnu dans axesEmpeches : d/);
});

test('axesEmpeches : un constat qui empêche une mesure est bloquant, sans quoi il est refusé', () => {
  assert.throws(() => cause({ bloquant: false }), /C-SURFACE-02 déclare des axes empêchés sans être bloquante/);
  assert.throws(() => cause({ bloquant: undefined }), /sans être bloquante/);
  assert.throws(() => cause({ severite: 'majeur', bloquant: false }), /sans être bloquante/);
  assert.deepEqual(cause().axesEmpeches, ['C', 'E']);
  // Une liste vide n'empêche rien : aucune obligation.
  assert.deepEqual(autre('A-X', 'A', 'mineur', { axesEmpeches: [] }).axesEmpeches, []);
});

test('noter : chaque axe empêché est noté 0, garde ce qu\'il vaut sur ce qui a pu être lu et nomme sa cause ; les autres axes ne bougent pas', () => {
  const avec = noterSansD(widget());
  const sans = noterSansD(sansEmpechement(widget()));
  assert.deepEqual(avec.axesEmpeches, ['C', 'E']);
  assert.deepEqual(sans.axesEmpeches, []);
  for (const code of ['C', 'E']) {
    const axe = avec.parAxe[code];
    assert.equal(axe.score, 0, `${code} est noté 0`);
    assert.equal(axe.empeche, true);
    assert.equal(axe.scoreMesure, sans.parAxe[code].score, `${code} garde ce qu'il vaut sur ce qui a pu être lu`);
    assert.equal(axe.causes.length, 1);
    const { uid, ...reste } = axe.causes[0];
    assert.match(uid, /^C-SURFACE-02#/);
    assert.deepEqual(reste, { regle: 'C-SURFACE-02', axe: 'C', titre: 'Fichier de code non lu', fichier: 'gros.js', ligne: null });
  }
  assert.equal(avec.parAxe.C.scoreMesure, 53);
  assert.equal(avec.parAxe.E.scoreMesure, 97);
  for (const code of ['A', 'B', 'F']) {
    assert.equal(avec.parAxe[code].score, 100);
    assert.equal(avec.parAxe[code].empeche, undefined, `${code} n'est pas empêché`);
    assert.equal(avec.parAxe[code].causes, undefined);
  }
  assert.equal(avec.parAxe.D.nonExecute, true);
});

test('noter : le score global compte les zéros (53 au lieu de 84) et le verdict est NON CONFORME', () => {
  const avec = noterSansD(widget());
  const sans = noterSansD(sansEmpechement(widget()));
  assert.equal(sans.global, 84, '(100×20 + 100×15 + 53×25 + 97×10 + 100×5) / 75');
  assert.equal(avec.global, 53, '(100×20 + 100×15 + 0×25 + 0×10 + 100×5) / 75');
  assert.equal(avec.verdict, 'NON CONFORME');
  assert.equal(avec.bloquants.length, 1);
});

test('invariant : un widget qui empêche une mesure ne note jamais mieux que s\'il la laissait se faire, quels que soient les axes', () => {
  const combinaisons = [['A'], ['B'], ['C'], ['E'], ['F'], ['A', 'B', 'C', 'E', 'F'], ['C', 'E'], ['D', 'F']];
  const bases = [[], [autre('A-DEV-01', 'A', 'critique')], widget().slice(1), [autre('C-XSS-04', 'C', 'majeur'), autre('B-NOM-01', 'B', 'mineur')]];
  for (const axes of combinaisons) {
    for (const base of bases) {
      const constats = [...base, cause({ axesEmpeches: axes })];
      const avec = noter(constats, new Set());
      const sans = noter(sansEmpechement(constats), new Set());
      assert.ok(avec.global <= sans.global, `${axes} : ${avec.global} ≤ ${sans.global}`);
      for (const code of Object.keys(AXES)) {
        assert.ok(avec.parAxe[code].score <= sans.parAxe[code].score, `${axes} : axe ${code}`);
        assert.equal(avec.parAxe[code].score === 0 && avec.parAxe[code].empeche === true, axes.includes(code), `${axes} : seuls ces axes sont empêchés (${code})`);
      }
      assert.equal(avec.verdict, 'NON CONFORME');
      assert.deepEqual(avec.axesEmpeches, axes);
    }
  }
});

test('un axe que l\'utilisateur n\'a pas lancé reste non exécuté (jamais noté 0) : ce n\'est pas le widget qui l\'empêche', () => {
  const n = noter([cause({ axesEmpeches: ['C', 'D'] })], new Set(['D']));
  assert.equal(n.parAxe.D.nonExecute, true);
  assert.equal(n.parAxe.D.score, null);
  assert.equal(n.parAxe.D.empeche, undefined);
  assert.deepEqual(n.axesEmpeches, ['C'], 'D n\'est pas dit empêché');
  assert.equal(n.parAxe.C.score, 0);
});

test('plusieurs causes sur un même axe : toutes sont gardées, le motif dit la première et le nombre des autres', () => {
  const n = noterSansD([cause({ axesEmpeches: ['C'] }), cause({ regle: 'C-SURFACE-01', titre: 'Plafond atteint', axesEmpeches: ['C'] }), cause({ regle: 'C-SURFACE-03', titre: 'Code illisible', axesEmpeches: ['C'] })]);
  assert.deepEqual(n.parAxe.C.causes.map((c) => c.regle), ['C-SURFACE-02', 'C-SURFACE-01', 'C-SURFACE-03']);
  assert.match(n.motif, /C \(Sécurité applicative[^)]*\)[^—]*— Fichier de code non lu \(et 2 autres\)/);
  const deux = noterSansD([cause({ axesEmpeches: ['C'] }), cause({ regle: 'C-SURFACE-01', titre: 'Plafond atteint', axesEmpeches: ['C'] })]);
  assert.match(deux.motif, /\(et 1 autre\)/);
});

test('le motif du verdict dit qu\'une mesure est empêchée, par quoi, et que le 0 n\'est pas un jugement sur le code', () => {
  const n = noterSansD(widget());
  assert.match(n.motif, /^⛔ Mesure empêchée par le widget : C \(.+\) — Fichier de code non lu ; E \(.+\) — Fichier de code non lu\./);
  assert.match(n.motif, /Un 0 dit ici que ces axes n'ont pas pu être mesurés, non que le code est mauvais/);
  assert.match(n.motif, /la cause est elle-même un point bloquant/);
  const un = noterSansD([cause({ axesEmpeches: ['C'] })]);
  assert.match(un.motif, /Un 0 dit ici que cet axe n'a pas pu être mesuré, non que le code est mauvais/);
  // Aucun axe empêché : le motif est celui d'avant, sans mention.
  assert.doesNotMatch(noterSansD(sansEmpechement(widget())).motif, /empêchée/);
});

test('un axe empêché n\'est pas « partiel » : mesurePartielle garde son sens (l\'axe garde sa note), les deux se disent à part', () => {
  const partiel = autre('D-RGAA-INDISPONIBLE', 'D', 'info', { mesurePartielle: true });
  const n = noter([partiel], new Set());
  assert.deepEqual(n.axesPartiels, ['D']);
  assert.deepEqual(n.axesEmpeches, []);
  assert.equal(n.parAxe.D.score, 100, 'une mesure partielle laisse la note de l\'axe');
  assert.equal(n.parAxe.D.empeche, undefined);
  const les2 = noter([partiel, cause({ axesEmpeches: ['D'] })], new Set());
  assert.deepEqual(les2.axesPartiels, ['D']);
  assert.deepEqual(les2.axesEmpeches, ['D']);
  assert.equal(les2.parAxe.D.score, 0);
  assert.match(les2.motif, /Mesure empêchée par le widget/);
  assert.match(les2.motif, /Audit partiel/);
  // Le constat qui empêche n'est jamais lui-même une mesure partielle : la seule cause d'un axe à 0 est le blocage.
  assert.equal(cause().mesurePartielle, false);
});

test('feuille de route : la cause d\'un axe empêché rend ce qu\'il vaut sur ce qui a pu être lu, les autres règles de cet axe ne gagnent rien tant qu\'elle reste', () => {
  const n = noterSansD(widget());
  const item = (regle) => n.roadmap.find((i) => i.regle === regle);
  // C sans la cause : 100 − 12 = 88 (×25) ; E rendu à sa mesure : 97 (×10) ; total des poids 75 (D non lancé) → 3170 / 75.
  assert.equal(item('C-SURFACE-02').gainGlobalEstime, 42.3);
  assert.deepEqual(item('C-SURFACE-02').retabliMesure, ['C', 'E']);
  assert.equal(item('C-XSS-04').gainGlobalEstime, 0, 'corriger cette règle ne sort pas C de 0 tant que la cause reste');
  assert.deepEqual(item('C-XSS-04').retabliMesure, []);
  assert.equal(item('E-DEP-05').gainGlobalEstime, 0);
  assert.equal(n.roadmap[0].regle, 'C-SURFACE-02', 'le bloquant passe en premier');
});

test('feuille de route : quand deux règles tiennent le même axe à 0, aucune ne le rétablit seule', () => {
  const n = noterSansD([cause({ axesEmpeches: ['C'] }), cause({ regle: 'C-SURFACE-01', titre: 'Plafond atteint', axesEmpeches: ['C'] })]);
  for (const regle of ['C-SURFACE-02', 'C-SURFACE-01']) {
    const i = n.roadmap.find((x) => x.regle === regle);
    assert.deepEqual(i.retabliMesure, [], regle);
    assert.equal(i.gainGlobalEstime, 0, regle);
  }
  // Une règle qui n'est cause que d'une partie des axes ne rétablit que ceux dont elle est la seule cause.
  const m = noterSansD([cause({ axesEmpeches: ['C', 'E'] }), cause({ regle: 'C-SURFACE-01', titre: 'Plafond atteint', axesEmpeches: ['C'] })]);
  assert.deepEqual(m.roadmap.find((x) => x.regle === 'C-SURFACE-02').retabliMesure, ['E']);
  assert.deepEqual(m.roadmap.find((x) => x.regle === 'C-SURFACE-01').retabliMesure, []);
});

test('feuille de route : sans axe empêché, le gain estimé est celui d\'avant (retabliMesure vide, jamais un autre nombre)', () => {
  const n = noterSansD([autre('C-XSS-04', 'C', 'majeur'), autre('E-DEP-05', 'E', 'mineur')]);
  assert.deepEqual(n.roadmap.map((i) => [i.regle, i.gainGlobalEstime, i.retabliMesure]), [['C-XSS-04', 4, []], ['E-DEP-05', 0.4, []]]);
});

test('rapport JSON : les axes empêchés portent empeche, scoreMesure et causes, la liste est au sommet, les autres axes n\'ont rien de plus', () => {
  const { json } = pages(noterSansD(widget()));
  assert.deepEqual(json.axesEmpeches, ['C', 'E']);
  assert.equal(json.axes.C.score, 0);
  assert.equal(json.axes.C.empeche, true);
  assert.equal(json.axes.C.scoreMesure, 53);
  assert.equal(json.axes.C.causes[0].regle, 'C-SURFACE-02');
  assert.equal(json.axes.E.scoreMesure, 97);
  for (const code of ['A', 'B', 'D', 'F']) {
    assert.equal('empeche' in json.axes[code], false, code);
    assert.equal('causes' in json.axes[code], false, code);
    assert.equal('scoreMesure' in json.axes[code], false, code);
  }
  const constatCause = json.axes.C.constats.find((c) => c.regle === 'C-SURFACE-02');
  assert.deepEqual(constatCause.axesEmpeches, ['C', 'E']);
  assert.deepEqual(json.axes.C.constats.find((c) => c.regle === 'C-XSS-04').axesEmpeches, []);
  assert.deepEqual(pages(noterSansD(sansEmpechement(widget()))).json.axesEmpeches, []);
});

test('rapport HTML : le motif, la jauge et la section de chaque axe empêché disent la mesure empêchée, avec un lien vers la cause qui existe dans la page', () => {
  const { html } = pages(noterSansD(widget()));
  assert.match(html, /<p class="motif-verdict motif-partiel">⛔ Mesure empêchée par le widget/);
  // Tous les axes lancés : seule la mesure empêchée met le motif en valeur (un axe non lancé le ferait déjà, ci-dessus).
  assert.match(pages(noter(widget(), new Set())).html, /<p class="motif-verdict motif-partiel">⛔ Mesure empêchée par le widget/);
  assert.match(pages(noter(sansEmpechement(widget()), new Set())).html, /<p class="motif-verdict">1 point\(s\) bloquant\(s\)/);
  assert.equal((html.match(/0\/100 · mesure empêchée/g) ?? []).length, 2, 'les jauges de C et de E');
  assert.match(html, /aria-label="Sécurité applicative[^"]*: noté 0 sur 100, mesure empêchée par le widget"/);
  const sections = [...html.matchAll(/<p class="axe-empeche">([^]*?)<\/p>/g)].map((m) => m[1]);
  assert.equal(sections.length, 2);
  assert.match(sections[0], /Sur ce qui a pu être lu, il vaut 53\/100\./);
  assert.match(sections[1], /Sur ce qui a pu être lu, il vaut 97\/100\./);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const lien of sections.flatMap((s) => [...s.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]))) assert.ok(ids.has(lien), `lien sans cible : #${lien}`);
  // Un axe non empêché n'affiche rien de tel, ni un rapport sans axe empêché.
  const sans = pages(noterSansD(sansEmpechement(widget()))).html;
  assert.doesNotMatch(sans, /empêchée/);
  assert.doesNotMatch(sans, /<p class="axe-empeche">/);
});

test('rapport Markdown : un axe empêché dit, sous sa note, ce qu\'il vaut sur ce qui a pu être lu et sa cause', () => {
  const { md } = pages(noterSansD(widget()));
  const bloc = [...md.matchAll(/^> ⛔ Mesure empêchée par le widget : ([^\n]*)$/gm)].map((m) => m[1]);
  assert.equal(bloc.length, 2);
  assert.match(bloc[0], /Sur ce qui a pu être lu, il vaut 53\/100\. Cause : \[C-SURFACE-02\] Fichier de code non lu\./);
  assert.match(bloc[1], /il vaut 97\/100\./);
  assert.doesNotMatch(pages(noterSansD(sansEmpechement(widget()))).md, /empêchée/);
});
