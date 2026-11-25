import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlGristReel, markdownGristReel, verdictEssai, syntheseEssais } from '../src/rapport/grist-reel.js';

/**
 * La section « Essais contre un Grist réel » se lit d'un coup d'œil : un verdict par essai (couleur ET mot), une phrase « En clair »,
 * le détail concret conservé. Un essai non testé n'est jamais présenté comme « bien ».
 */
const essai = (id, resultat, extra = {}) => ({ id, titre: `Essai ${id}`, resultat, detail: `détail concret ${id}`, ...extra });
const resume = (essais) => ({ execute: true, produit: 'Grist Desktop', version: '0.3.17', plateforme: 'linux-x64', date: '2026-11-25T09:00:00Z', phases: [{ niveau: 'none' }, { niveau: 'full' }], essaisPasEncore: '2 à 6', essais });

test("verdict : effet observé = pas bien (couleur selon la gravité), bloqué ou rien observé = bien, non testé = pas testé, jamais « bien »", () => {
  assert.deepEqual([verdictEssai(essai(1, 'reussi', { severite: 'critique' })).cle, verdictEssai(essai(1, 'reussi', { severite: 'critique' })).bande], ['pas_bien', 'critique']);
  assert.equal(verdictEssai(essai(16, 'reussi', { severite: 'majeur' })).bande, 'serieuse');
  assert.equal(verdictEssai(essai(7, 'reussi', { severite: 'info' })).cle, 'a_savoir', "défaut de Grist, pas du widget");
  const bloque = verdictEssai(essai(15, 'bloque', { barriere: 'Chromium' }));
  assert.deepEqual([bloque.cle, bloque.bande], ['bien', 'bonne']);
  assert.match(bloque.precision, /Chromium/);
  assert.equal(verdictEssai(essai(16, 'rien_observe')).cle, 'bien');
  const pasTeste = verdictEssai(essai(13, 'non_teste'));
  assert.deepEqual([pasTeste.cle, pasTeste.bande], ['non_teste', 'neutre']);
});

test("synthèse : un problème l'emporte ; des essais non testés ne donnent jamais un simple « aucun problème trouvé »", () => {
  assert.equal(syntheseEssais([essai(1, 'reussi', { severite: 'critique' }), essai(16, 'rien_observe')]).bande, 'critique');
  const partielle = syntheseEssais([essai(15, 'rien_observe'), essai(13, 'non_teste')]);
  assert.equal(partielle.bande, 'attention');
  assert.match(partielle.titre, /n'ont pas pu être joués/);
  assert.match(partielle.detail, /1 pas testé/);
  const propre = syntheseEssais([essai(15, 'rien_observe'), essai(16, 'bloque', { barriere: 'x' })]);
  assert.deepEqual([propre.bande, propre.titre], ['bonne', 'Aucun problème trouvé']);
  assert.equal(syntheseEssais([essai(13, 'non_teste'), essai(1, 'non_teste')]).titre, "Rien n'a pu être testé");
});

test("HTML : verdict avec symbole et mot, phrase « En clair », détail concret conservé et échappé ; les sorties externes sont dites sans accuser", () => {
  const html = htmlGristReel(resume([
    essai(13, 'rien_observe', { sorties: 36, detail: '36 requête(s) sortante(s) neutralisée(s) (esm.sh) <img src=x onerror=alert(1)>' }),
    essai(1, 'non_teste', { detail: 'aucune donnée reçue' }),
    essai(16, 'reussi', { severite: 'majeur', regle: 'D-REEL-16', detail: '1 boîte(s) de dialogue (alert)' }),
  ]));
  assert.match(html, /class="reel-verdict" data-bande="bonne"><span aria-hidden="true">✔<\/span> Bien/);
  assert.match(html, /data-bande="neutre"><span aria-hidden="true">\?<\/span> Pas testé/);
  assert.match(html, /data-bande="serieuse"><span aria-hidden="true">✘<\/span> Pas bien/);
  assert.match(html, /<strong>En clair\.<\/strong> Le widget a tenté 36 appel\(s\) vers l'extérieur[^<]*aucune valeur du document n'y figurait en clair/);
  assert.match(html, /Impossible de conclure[^<]*pas la même chose que « tout va bien »/);
  assert.match(html, /36 requête\(s\) sortante\(s\) neutralisée\(s\) \(esm\.sh\)/, 'le détail concret reste');
  assert.match(html, /<code>D-REEL-16<\/code>/);
  assert.ok(!html.includes('<img src=x'), 'le texte venu du widget est échappé');
});

test("Markdown : même verdict et même « En clair » que le HTML, détail et règle conservés", () => {
  const md = markdownGristReel(resume([essai(1, 'reussi', { severite: 'critique', regle: 'D-REEL-01', detail: 'la charge a lu la table appât' }), essai(13, 'non_teste')])).join('\n');
  assert.match(md, /\*\*1 problème trouvé\.\*\*/);
  assert.match(md, /✘ \*\*Pas bien\*\* — critique \| 1\. Essai 1/);
  assert.match(md, /la charge a lu la table appât \[D-REEL-01\]/);
  assert.match(md, /\? \*\*Pas testé\*\*/);
});

test("rapport : le nombre d'essais restant à développer vient de la liste des essais jouables, pas de ceux joués (l'essai 21 n'existe que si le widget a des bibliothèques)", () => {
  const r = { ...resume([essai(1, 'rien_observe'), essai(7, 'bloque')]), essaisJoues: Array.from({ length: 16 }, (_, i) => i + 1), essaisPasEncore: '2, 4 à 6, 11, 14, 19, 20' };
  assert.match(htmlGristReel(r), /8 essais du catalogue restent à développer \(n° 2, 4 à 6, 11, 14, 19, 20\)/);
});
