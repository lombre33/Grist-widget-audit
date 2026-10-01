import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserAccessibiliteStatique } from '../src/regles/f-conformite.js';
import { PIEGES_ACCESSIBILITE } from '../scripts/lib/pieges.mjs';

/**
 * F-RGAA-01, 03, 04 et 05 lisent la page en une passe du découpeur de parse5
 * (relevé par la coordination le 2026-09-28). Chaque garde a sa paire : la
 * forme fautive est signalée, la forme honnête voisine ne l'est pas. Les
 * pages piégées vérifient que l'analyse en rend ce qu'elles contiennent ; leur
 * temps est chronométré à part (`scripts/chronometrer-pieges.mjs`) : aucun
 * budget en temps réel dans la suite.
 */

function fichier(contenu) {
  return { chemin: 'index.html', contenu, lignes: contenu.split('\n'), ext: '.html', binaire: false, executee: true, vendorise: false };
}

/** Nombre d'éléments signalés par `regle` (le titre du constat commence par ce nombre), 0 sans constat. */
function signales(html, regle) {
  const c = analyserAccessibiliteStatique({ fichiers: [fichier(html)], entrees: ['index.html'] }).find((x) => x.regle === regle);
  if (!c) return 0;
  return Number(c.titre.match(/^\d+/)?.[0] ?? 1);
}

const page = (corps) => `<!doctype html><html lang="fr"><head><title>t</title></head><body>\n${corps}\n</body></html>`;
const boutonsMuets = (corps) => signales(page(corps), 'F-RGAA-05');

// F-RGAA-05 : nom accessible du bouton ----------------------------------------------

test('F-RGAA-05 : le texte d\'un span, un texte masqué visuellement, une ligature d\'icône nomment le bouton', () => {
  assert.equal(boutonsMuets('<button><span>Enregistrer</span></button>'), 0);
  assert.equal(boutonsMuets('<button><span class="sr-only">Supprimer</span><i class="fa fa-trash" aria-hidden="true"></i></button>'), 0);
  assert.equal(boutonsMuets('<button><i class="material-icons">delete</i></button>'), 0);
});

test('F-RGAA-05 : une icône seule, un svg vide, un bouton vide ou d\'espaces sont signalés', () => {
  assert.equal(boutonsMuets('<button><i class="fa fa-trash"></i></button>'), 1);
  assert.equal(boutonsMuets('<button><svg></svg></button>'), 1);
  assert.equal(boutonsMuets('<button> &nbsp; </button>'), 1);
});

test('F-RGAA-05 : le title d\'un svg et le texte d\'un svg nomment le bouton, un svg sans l\'un ni l\'autre non', () => {
  assert.equal(boutonsMuets('<button><svg viewBox="0 0 1 1"><title>Fermer</title><path d="M0"/></svg></button>'), 0);
  assert.equal(boutonsMuets('<button><svg><text>Suivant</text></svg></button>'), 0);
  assert.equal(boutonsMuets('<button><svg><path d="M0"/></svg></button>'), 1);
});

test('F-RGAA-05 : l\'alt non vide d\'une image nomme le bouton, une image sans alt ou à alt vide non', () => {
  assert.equal(boutonsMuets('<button><img src="x.png" alt="Supprimer"></button>'), 0);
  assert.equal(boutonsMuets('<button><img src="x.png"></button>'), 1);
  assert.equal(boutonsMuets('<button><img src="x.png" alt=""></button>'), 1);
});

test('F-RGAA-05 : aria-label et title nomment le bouton, vides ils ne nomment rien', () => {
  assert.equal(boutonsMuets('<button aria-label="Fermer"><i></i></button>'), 0);
  assert.equal(boutonsMuets('<button title="Mélanger"><i class="icon"></i></button>'), 0);
  assert.equal(boutonsMuets('<button aria-label="  "><i></i></button>'), 1);
  assert.equal(boutonsMuets('<button title=""><i></i></button>'), 1);
});

test('F-RGAA-05 : aria-labelledby nomme le bouton seulement s\'il vise un id présent dans la page', () => {
  assert.equal(boutonsMuets('<span id="l">Fermer</span><button aria-labelledby="l"><i></i></button>'), 0);
  assert.equal(boutonsMuets('<button aria-labelledby="absent l"><i></i></button><b id="l">x</b>'), 0);
  assert.equal(boutonsMuets('<button aria-labelledby="absent"><i></i></button>'), 1);
});

test('F-RGAA-05 : un texte sous aria-hidden="true", hidden ou display: none ne nomme rien', () => {
  assert.equal(boutonsMuets('<button><span aria-hidden="true">×</span></button>'), 1);
  assert.equal(boutonsMuets('<button><span hidden>Fermer</span></button>'), 1);
  assert.equal(boutonsMuets('<button><span style="display:none">Fermer</span></button>'), 1);
});

test('F-RGAA-05 (faux positif) : un bouton dans un conteneur masqué est jugé comme s\'il était affiché', () => {
  assert.equal(boutonsMuets('<div aria-hidden="true"><button>OK</button></div>'), 0);
  assert.equal(boutonsMuets('<div hidden><button><i></i></button></div>'), 1);
});

test('F-RGAA-05 (faux positif) : un bouton écrit dans un script, un style, un textarea ou un noscript n\'est pas un bouton', () => {
  assert.equal(boutonsMuets('<script>var s = "<button></button>";</script>'), 0);
  assert.equal(boutonsMuets('<style>/* <button></button> */</style>'), 0);
  assert.equal(boutonsMuets('<textarea><button></button></textarea>'), 0);
  assert.equal(boutonsMuets('<noscript><button></button></noscript>'), 0);
});

test('F-RGAA-05 : dans svg, une section CDATA est du texte ; en HTML, c\'est un commentaire', () => {
  assert.equal(boutonsMuets('<button><svg><![CDATA[Fermer]]></svg></button>'), 0);
  assert.equal(boutonsMuets('<button><![CDATA[Fermer]]></button>'), 1);
});

test('F-RGAA-05 : une balise HTML dans un svg, ou le contenu d\'un foreignObject, redevient du HTML', () => {
  assert.equal(boutonsMuets('<svg><div><button><i></i></button></div></svg>'), 1);
  assert.equal(boutonsMuets('<svg><foreignObject><button><i></i></button></foreignObject></svg>'), 1);
  assert.equal(boutonsMuets('<svg><button></button></svg>'), 0);
});

test('F-RGAA-05 : en HTML la barre oblique ne ferme pas un élément, dans svg elle le ferme', () => {
  assert.equal(boutonsMuets('<button><span aria-hidden="true"/>Fermer</button>'), 1);
  assert.equal(boutonsMuets('<button><svg><path aria-hidden="true"/><text>Fermer</text></svg></button>'), 0);
});

test('F-RGAA-05 : un élément vide ne s\'empile pas (le texte qui le suit ne lui appartient pas)', () => {
  assert.equal(boutonsMuets('<button><img src="x.png" alt="" hidden>Fermer</button>'), 0);
});

test('F-RGAA-05 : un bouton ouvert dans un bouton ferme le premier, qui est jugé seul', () => {
  assert.equal(boutonsMuets('<button><i></i><button>Texte</button>'), 1);
  assert.equal(boutonsMuets('<div><button><i></i></div>Texte après'), 1);
});

test('F-RGAA-05 : un attribut en double garde sa première valeur, comme le navigateur', () => {
  assert.equal(boutonsMuets('<button aria-label="" aria-label="Fermer"><i></i></button>'), 1);
  assert.equal(boutonsMuets('<button aria-label="Fermer" aria-label=""><i></i></button>'), 0);
});

test('F-RGAA-05 : le constat pointe la ligne du premier bouton signalé et en cite le texte', () => {
  const c = analyserAccessibiliteStatique({ fichiers: [fichier(page('<p>x</p>\n<button>Ok</button>\n<button class="x"><i></i></button>'))], entrees: ['index.html'] }).find((x) => x.regle === 'F-RGAA-05');
  assert.equal(c.ligne, 4);
  assert.equal(c.extrait, '<button class="x"><i></i></button>');
});

test('F-RGAA-05 : un <input type="button"> est nommé par sa value, un aria-label, un aria-labelledby présent ou un title, sinon il est signalé', () => {
  assert.equal(boutonsMuets('<input type="button">'), 1);
  assert.equal(boutonsMuets('<input type=BUTTON value="  ">'), 1);
  assert.equal(boutonsMuets('<input type="button" aria-labelledby="absent">'), 1);
  assert.equal(boutonsMuets('<input type="button" value="Valider">'), 0);
  assert.equal(boutonsMuets('<input type="button" aria-label="Valider">'), 0);
  assert.equal(boutonsMuets('<input type="button" title="Valider">'), 0);
  assert.equal(boutonsMuets('<b id="l">Valider</b><input type="button" aria-labelledby="l">'), 0);
});

test('F-RGAA-05 : un submit ou un reset a un nom par défaut, un <input type="image"> a besoin d\'un alt non vide', () => {
  assert.equal(boutonsMuets('<input type="submit"><input type="reset">'), 0);
  assert.equal(boutonsMuets('<input type="image" src="ok.png">'), 1);
  assert.equal(boutonsMuets('<input type="image" src="ok.png" alt="">'), 1);
  assert.equal(boutonsMuets('<input type="image" src="ok.png" alt="Envoyer">'), 0);
  assert.equal(boutonsMuets('<input type="image" src="ok.png" aria-label="Envoyer">'), 0);
});

test('F-RGAA-05 : boutons et <input> signalés sont comptés ensemble, et le constat cite le premier dans l\'ordre de la page', () => {
  const c = analyserAccessibiliteStatique({ fichiers: [fichier(page('<button class="a"><i></i>\n<input type="button" class="b">\n</button><input type="image">'))], entrees: ['index.html'] }).find((x) => x.regle === 'F-RGAA-05');
  assert.match(c.titre, /^3 /);
  assert.equal(c.ligne, 2);
  assert.match(c.extrait, /^<button class="a">/);
});

// F-RGAA-01, 03, 04 : même passe ----------------------------------------------------

test('F-RGAA-01 : lang sans guillemets est une langue déclarée ; lang vide ou absent, non ; un lang écrit dans un script ne compte pas', () => {
  const sans = (html) => signales(html, 'F-RGAA-01');
  assert.equal(sans('<!doctype html><html lang=fr><head><title>t</title></head></html>'), 0);
  assert.equal(sans('<!doctype html><html lang=""><head><title>t</title></head></html>'), 1);
  assert.equal(sans('<!doctype html><html><head><script>var a = \'<html lang="fr">\';</script></head></html>'), 1);
});

test('F-RGAA-03 : une image sans alt est comptée, alt="" suffit, une image écrite dans un script ne compte pas', () => {
  assert.equal(signales(page('<img src="a.png"><img src="b.png" alt="b"><img src="c.png">'), 'F-RGAA-03'), 2);
  assert.equal(signales(page('<img src="a.png" alt="">'), 'F-RGAA-03'), 0);
  assert.equal(signales(page('<script>var s = \'<img src="a.png">\';</script>'), 'F-RGAA-03'), 0);
});

test('F-RGAA-04 : un champ dans son label, ou visé par label for, ou nommé par un aria-labelledby présent, est étiqueté', () => {
  const orphelins = (corps) => signales(page(corps), 'F-RGAA-04');
  assert.equal(orphelins('<label>Nom <input></label>'), 0);
  assert.equal(orphelins('<label for="n">Nom</label><input id="n">'), 0);
  assert.equal(orphelins('<b id="l">Nom</b><input aria-labelledby="l">'), 0);
  assert.equal(orphelins('<input aria-labelledby="absent">'), 1);
  assert.equal(orphelins('<input id="n"><textarea></textarea>'), 2);
  assert.equal(orphelins('<input type=hidden><input type="submit"><input title="Nom">'), 0);
});

// Pages piégées -----------------------------------------------------------------------

for (const [nom, contenu, boutons] of PIEGES_ACCESSIBILITE) {
  test(`pages piégées : ${nom} (environ 1 Mio) s'analysent sans abandon, et ${boutons} bouton(s) sans nom y sont relevés`, () => {
    assert.equal(signales(contenu, 'F-RGAA-05'), boutons);
  });
}
