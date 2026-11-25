// Le vocabulaire de la section « Grist réel » : une faute du widget s'affiche « Pas bien » (même déjà comptée ailleurs), une exposition due au niveau d'accès
// ou un comportement de Grist s'affiche d'un libellé neutre ; chaque essai dit franchement si le widget a fait quelque chose de mal et ce qu'il faut faire.
import test from 'node:test';
import assert from 'node:assert/strict';
import './aide-chromium.mjs';
import { htmlGristReel, markdownGristReel, verdictEssai, syntheseEssais } from '../src/rapport/grist-reel.js';
import { conseilEssai, classeEssai } from '../src/rapport/grist-reel-conseils.js';
import { ESSAIS_JOUES } from '../src/runtime/grist-reel/essais.js';

const essai = (id, resultat, extra = {}) => ({ id, titre: `Essai ${id}`, resultat, detail: 'détail', niveau: 'full', ...extra });
const resume = (essais) => ({ execute: true, produit: 'Grist Desktop', version: '0.3.17', plateforme: 'linux-x64', date: '2026-11-25T09:00:00Z', phases: [{ niveau: 'none' }, { niveau: 'full' }], essaisJoues: ESSAIS_JOUES, essaisPasEncore: '11', essais });

test("une exposition due au niveau d'accès (essai 8) : libellé neutre « Exposé, sans pénalité », « le widget n'a rien fait de mal », et les trois actions dans l'ordre", () => {
  const e = essai(8, 'reussi', { severite: 'info', nature: 'rayon' });
  const v = verdictEssai(e);
  assert.equal(v.mot, 'Exposé, sans pénalité');
  assert.equal(v.cle, 'a_savoir');
  const c = conseilEssai(e);
  assert.match(c.mal, /^Non, le widget n'a rien fait de mal/);
  assert.equal(c.faire.length, 3);
  assert.match(c.faire[0], /« read table » plutôt que « full »/);
  assert.match(c.faire[1], /empreinte `integrity`/);
  assert.match(c.faire[1], /embarquer dans le dépôt/);
  assert.match(c.faire[2], /Limiter le nombre de dépendances/);
  // À « read table », demander « read table » n'a plus de sens : l'action disparaît.
  assert.doesNotMatch(conseilEssai({ ...e, niveau: 'read table' }).faire.join(' '), /plutôt que « full »/);
});

test("une faute du widget déjà comptée ailleurs (essais 21 et 22) ou sans pénalité (essai 5) s'affiche « Pas bien », avec la précision qui dit pourquoi aucun point de plus", () => {
  const v21 = verdictEssai(essai(21, 'reussi', { severite: 'info', nature: 'confirmation', dejaCompte: 'E-DEP-01' }));
  assert.equal(v21.mot, 'Pas bien'); assert.equal(v21.cle, 'pas_bien');
  assert.match(v21.precision, /déjà compté par E-DEP-01, sans pénalité de plus/);
  const v22 = verdictEssai(essai(22, 'reussi', { severite: 'info', nature: 'confirmation', dejaCompte: 'C-CSP-01, C-CSP-02 ou C-CSP-03' }));
  assert.equal(v22.mot, 'Pas bien');
  assert.match(v22.precision, /C-CSP-01/);
  const v5 = verdictEssai(essai(5, 'reussi', { severite: 'info', nature: 'faiblesse' }));
  assert.equal(v5.mot, 'Pas bien');
  assert.match(v5.precision, /faiblesse du widget, sans pénalité/);
  const c21 = conseilEssai(essai(21, 'reussi', { severite: 'info', nature: 'confirmation' }));
  assert.match(c21.mal, /^Oui/);
  assert.match(c21.faire[0], /bundle local avec esbuild ou Vite/);
  assert.match(c21.faire[0], /plutôt que les charger depuis esm\.sh/);
});

test("un comportement de Grist s'affiche « Côté Grist, sans pénalité » ; un comportement à confirmer « À vérifier, sans pénalité » ; jamais le mot « À savoir »", () => {
  assert.equal(verdictEssai(essai(19, 'reussi', { severite: 'info' })).mot, 'Côté Grist, sans pénalité');
  assert.equal(verdictEssai(essai(24, 'reussi', { severite: 'info', nature: 'comportement' })).mot, 'À vérifier, sans pénalité');
  const html = htmlGristReel(resume([essai(8, 'reussi', { severite: 'info', nature: 'rayon' }), essai(19, 'reussi', { severite: 'info' }), essai(24, 'reussi', { severite: 'info', nature: 'comportement' }), essai(21, 'reussi', { severite: 'info', nature: 'confirmation', dejaCompte: 'E-DEP-01' })]));
  assert.doesNotMatch(html, /À savoir/);
  assert.doesNotMatch(markdownGristReel(resume([essai(8, 'reussi', { severite: 'info', nature: 'rayon' })])).join('\n'), /À savoir/);
});

test("« Sans objet » : ni une réussite, ni un essai raté ; il ne rend pas la synthèse inquiète", () => {
  const e = essai(5, 'sans_objet', { detail: "le widget demande déjà le niveau d'accès « full »" });
  assert.equal(classeEssai(e), 'sans_objet');
  const v = verdictEssai(e);
  assert.equal(v.mot, 'Sans objet'); assert.equal(v.cle, 'sans_objet');
  const s = syntheseEssais([essai(1, 'rien_observe'), e]);
  assert.equal(s.titre, 'Aucun problème trouvé');
  assert.equal(s.bande, 'bonne');
  assert.match(s.detail, /1 sans objet/);
  assert.doesNotMatch(s.detail, /pas testé/);
  const html = htmlGristReel(resume([e]));
  assert.match(html, /Sans objet/);
  assert.match(html, /ne s'applique pas à ce widget/);
});

test("chaque essai joué dit, pour chaque résultat possible, si le widget a fait quelque chose de mal et ce qu'il faut faire (jamais vide)", () => {
  const cas = [['reussi', { severite: 'critique' }], ['reussi', { severite: 'majeur' }], ['reussi', { severite: 'mineur' }], ['reussi', { severite: 'info' }], ['reussi', { severite: 'info', nature: 'rayon' }], ['reussi', { severite: 'info', nature: 'confirmation' }], ['reussi', { severite: 'info', nature: 'faiblesse' }], ['reussi', { severite: 'info', nature: 'comportement' }], ['bloque', {}], ['rien_observe', {}], ['non_teste', {}], ['sans_objet', {}]];
  for (const id of ESSAIS_JOUES) {
    for (const [resultat, extra] of cas) {
      const c = conseilEssai(essai(id, resultat, extra));
      assert.ok(c.mal.length > 20, `essai ${id} ${resultat} ${JSON.stringify(extra)} : phrase absente`);
      assert.ok(c.faire.length >= 1 && c.faire.every((a) => a.length > 5), `essai ${id} ${resultat} ${JSON.stringify(extra)} : action absente`);
    }
  }
  // Les trois réponses de fond : « Oui » pour une faute, « Non » sans faute, « On ne sait pas » quand l'essai n'a pas été joué.
  assert.match(conseilEssai(essai(4, 'reussi', { severite: 'majeur' })).mal, /^Oui/);
  assert.match(conseilEssai(essai(4, 'rien_observe')).mal, /^Non/);
  assert.match(conseilEssai(essai(4, 'non_teste')).mal, /^On ne sait pas/);
});

test("le rapport HTML et Markdown portent les deux lignes ; le texte est échappé et les extraits de code mis en forme", () => {
  const r = resume([essai(8, 'reussi', { severite: 'info', nature: 'rayon' }), essai(3, 'reussi', { severite: 'majeur', detail: '<img onerror=alert(1)>' })]);
  const html = htmlGristReel(r);
  assert.match(html, /Le widget a-t-il fait quelque chose de mal \?/);
  assert.match(html, /<strong>Que faire\.<\/strong>/);
  assert.match(html, /<code>integrity<\/code>/);
  assert.doesNotMatch(html, /<img onerror/);
  const md = markdownGristReel(r).join('\n');
  assert.match(md, /\| Le widget a-t-il fait quelque chose de mal \? \| Que faire \|/);
  assert.match(md, /1\. Demander « read table »/);
});
