/**
 * C-CHAINE-01 à 04 : des constats déjà faits, reliés en un scénario d'attaque. Une hypothèse en information : sans pénalité, jamais bloquante,
 * et qui ne reprend aucun texte du widget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { constat } from '../src/moteur/modele.js';
import { chainesDAttaque } from '../src/moteur/chaines.js';

const c = (regle, extra = {}) => constat({ regle, axe: regle[0] === 'E' ? 'E' : regle[0], severite: 'majeur', confiance: 'probable', titre: `titre ${regle}`, constat: 'x', fichier: 'app.js', ligne: 3, ...extra });
const ctx = (...niveaux) => ({ usagesGrist: { acces: niveaux.map((niveau) => ({ niveau })) } });
const regles = (r) => r.map((x) => x.regle);

test("injection + accès aux données + appel sortant : C-CHAINE-01 ; sans accès aux données ou sans appel, rien", () => {
  const constats = [c('C-XSS-01'), c('C-EXFIL-01', { severite: 'critique', bloquant: true })];
  const [chaine, ...autres] = chainesDAttaque(constats, ctx('read table'));
  assert.equal(autres.length, 0);
  assert.equal(chaine.regle, 'C-CHAINE-01');
  assert.equal(`${chaine.severite} ${chaine.bloquant ? 'bloquant' : 'non bloquant'} ${chaine.confiance}`, 'info non bloquant a_verifier');
  assert.deepEqual(chaine.preuve.etapes.map((e) => e.regle), ['C-XSS-01', null, 'C-EXFIL-01']);
  assert.match(chaine.constat, /1\) du contenu dynamique est écrit dans la page ou exécuté — C-XSS-01 \(`app\.js:3`\) ; 2\) accès « read table » demandé ; 3\) le widget appelle l'extérieur — C-EXFIL-01/);
  assert.match(chaine.constat, /C'est une hypothèse : l'audit n'a pas exécuté cet enchaînement\.$/);
  assert.deepEqual(chainesDAttaque(constats, ctx('none')), [], "un widget sans accès aux données n'a rien à lire");
  assert.deepEqual(chainesDAttaque(constats, ctx()), []);
  assert.deepEqual(chainesDAttaque([c('C-XSS-01')], ctx('full')), [], "sans appel sortant ni écriture, pas de chaîne");
});

test("un message sans contrôle d'origine + une injection : C-CHAINE-02 ; l'un sans l'autre, rien", () => {
  assert.deepEqual(regles(chainesDAttaque([c('C-PM-01'), c('C-XSS-05', { severite: 'mineur' })], ctx())), ['C-CHAINE-02']);
  assert.deepEqual(chainesDAttaque([c('C-PM-01')], ctx('full')), []);
  assert.deepEqual(chainesDAttaque([c('C-XSS-06', { severite: 'info' }), c('C-PM-01')], ctx()), [], "l'innerHTML constant (information) n'est pas une injection");
});

test("du code tiers sans empreinte + accès aux données : C-CHAINE-03 ; un script avec empreinte (majeur) n'en est pas", () => {
  const sans = c('E-DEP-01', { severite: 'critique', bloquant: true, fichier: 'index.html', ligne: 7 });
  assert.deepEqual(regles(chainesDAttaque([sans], ctx('full'))), ['C-CHAINE-03']);
  assert.deepEqual(chainesDAttaque([sans], ctx()), []);
  assert.deepEqual(chainesDAttaque([c('E-DEP-01')], ctx('full')), [], 'avec empreinte, le constat est majeur : pas de chaîne');
});

test("une injection + l'écriture dans le document (accès full) : C-CHAINE-04 ; plusieurs chaînes sortent dans l'ordre 01 à 04, et une étape observée à l'exécution est dite observée", () => {
  const constats = [c('D-XSS-01', { severite: 'critique', bloquant: true, confiance: 'prouve' }), c('C-GRIST-03'), c('C-PM-01'), c('C-EXFIL-02')];
  const r = chainesDAttaque(constats, ctx('full'));
  assert.deepEqual(regles(r), ['C-CHAINE-01', 'C-CHAINE-02', 'C-CHAINE-04']);
  assert.match(r[0].constat, /D-XSS-01.*, observé à l'exécution/);
  assert.match(r[0].constat, /1 étape\(s\) seulement a été observée\(s\) à l'exécution/);
  assert.ok(r.every((x) => x.severite === 'info' && !x.bloquant), 'jamais une pénalité, jamais bloquant');
  assert.equal(r[2].preuve.etapes[1].regle, 'C-GRIST-03');
  assert.deepEqual(chainesDAttaque([c('D-XSS-01', { confiance: 'prouve' }), c('C-GRIST-03', { severite: 'mineur' })], ctx('full')), [], "C-GRIST-03 mineur : aucune écriture détectée");
});

test("D-XSS-02 (batterie jouée en Chromium) est une porte d'injection, sauf quand seule l'adresse du widget l'a ouverte (mineur)", () => {
  assert.deepEqual(regles(chainesDAttaque([c('D-XSS-02', { severite: 'critique', bloquant: true, confiance: 'prouve' }), c('C-PM-01')], ctx())), ['C-CHAINE-02']);
  assert.deepEqual(chainesDAttaque([c('D-XSS-02', { severite: 'mineur', confiance: 'prouve' }), c('C-PM-01')], ctx()), []);
});

test("le texte d'une chaîne ne reprend ni le titre ni l'extrait du widget, et cite un nom de fichier hostile en extrait de code", () => {
  const hostile = c('C-XSS-01', { titre: '<img src=x onerror=alert(1)> `titre`', extrait: '<script>boom</script>', fichier: 'a`\u{1b}[31m.js' });
  const [chaine] = chainesDAttaque([hostile, c('C-PM-01')], ctx());
  assert.doesNotMatch(chaine.constat, /<img|<script|boom|titre/);
  assert.doesNotMatch(chaine.constat, /\u{1b}/u, 'le caractère de contrôle est écrit en clair');
  assert.match(chaine.constat, /\\u001b/);
});
