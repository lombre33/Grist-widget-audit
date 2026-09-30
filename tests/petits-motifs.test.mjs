import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserSignauxGeneration, analyserReadme } from '../src/regles/b-lisibilite.js';
import { analyserTracesDev } from '../src/regles/a-qualite.js';
import { analyserSouverainete } from '../src/regles/f-conformite.js';
import { constat, MAX_EMPLACEMENTS } from '../src/moteur/modele.js';

/**
 * Trois corrections de motifs et de listes, chacune vérifiée par ce qu'elle rend, sans mesurer aucun temps
 * (un essai à budget en temps réel n'a pas sa place dans la suite par défaut) :
 *  - B-IA-01 : les blancs des motifs ne franchissent plus une fin de ligne (`\s*` courait d'une ligne vide à
 *    la suivante, en temps quadratique, et rattachait un `//` de fin de ligne au texte de la ligne d'après),
 *    et le JSDoc générique se cherche par son `@param`, dans une fenêtre bornée ;
 *  - A-DEV-03 : « À FAIRE » correspond enfin (`\b` n'y trouvait de frontière qu'après une lettre) ;
 *  - la liste `preuve.emplacements` d'un constat est bornée, le nombre d'omis est dit.
 */

function fichier(chemin, contenu, extra = {}) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, ...extra };
}

// --- B-IA-01

const FORMULES = Array.from({ length: 4 }, () => '// Voici le code').join('\n');       // famille « formules d'assistant » : 4
const JOURNAL = Array.from({ length: 4 }, () => '// Ajout de x').join('\n');           // famille « journal de modification » : 4
const ETAPES = Array.from({ length: 4 }, (_, i) => `// Step ${i + 1}: x`).join('\n');   // famille « Étape N » : 4

/** Les signaux d'un fichier .js : `contenu` suivi de remplissages qui portent le total à 8 sur deux familles, pour que le constat existe. */
function signauxDe(contenu, ...remplissages) {
  const fond = remplissages.length ? remplissages : [FORMULES, JOURNAL];
  const c = analyserSignauxGeneration({ fichiers: [fichier('app.js', `${contenu}\n${fond.join('\n')}`)] }).find((x) => x.regle === 'B-IA-01');
  assert.ok(c, 'le remplissage porte le total à 8 sur deux familles : le constat doit exister');
  return c.preuve.signaux;
}
const famille = (signaux, morceau) => signaux.find((s) => s.libelle.includes(morceau));

test('B-IA-01 « Étape N » : le blanc de tête (tabulation, espace insécable, marque d\'ordre des octets) ne change ni le compte ni la ligne', () => {
  const contenu = ['\uFEFF// Step 1: a', '\t// Étape 2 - b', '\u00a0// Etape 3: c', 'const x = 1;', '  //   STEP 4 -  d'].join('\n');
  const e = famille(signauxDe(contenu), 'Étape N');
  assert.deepEqual([e.occurrences, e.ligne], [4, 1]);
});

test('B-IA-01 « Étape N » : des lignes vides avant le commentaire ne le déplacent pas, la ligne rendue est celle du commentaire', () => {
  const e = famille(signauxDe('\n\n\n\n// Step 1: a'), 'Étape N');
  assert.deepEqual([e.occurrences, e.ligne], [1, 5]);
});

test('B-IA-01 « Étape N » : un `//` seul sur sa ligne ne se rattache pas à « Step 1: » de la ligne d\'après (ni un `Step` à un nombre de la ligne d\'après)', () => {
  for (const coupure of ['\n', '\r', '\u2028', '\u2029']) {
    assert.equal(famille(signauxDe(`//${coupure}Step 1: a`, FORMULES, JOURNAL), 'Étape N'), undefined, `« // » puis ${JSON.stringify(coupure)} puis « Step 1: » : deux lignes, aucun commentaire numéroté`);
  }
  assert.equal(famille(signauxDe('// Step\n1: a', FORMULES, JOURNAL), 'Étape N'), undefined, '« Step » puis « 1: » à la ligne : pas un commentaire numéroté');
});

test('B-IA-01 délimiteurs Markdown : indentés, ils comptent ; à la ligne d\'un texte, non ; la ligne est celle du délimiteur, non d\'une ligne vide au-dessus', () => {
  const contenu = ['texte', '', '   ```js', 'x', '```', 'a ``` b'].join('\n');
  const d = famille(signauxDe(contenu), 'délimiteurs');
  assert.deepEqual([d.occurrences, d.ligne], [2, 3]);
});

test('B-IA-01 journal de modification : `//` puis un mot à la ligne d\'après ne compte pas ; l\'espace insécable après `//` compte', () => {
  const contenu = ['//', 'Ajout de x', '// Ajout de y', '//\u00a0Removed the z', '// ajout du t'].join('\n');
  const j = famille(signauxDe(contenu, FORMULES, ETAPES), 'journal');
  assert.deepEqual([j.occurrences, j.ligne], [3, 3], 'la casse ne change rien (« ajout du t »)');
});

test('B-IA-01 commentaires paraphrasant : `//` seul sur sa ligne ne se rattache pas au « Retourne le x » de la ligne d\'après', () => {
  const contenu = ['a();', '//', 'Retourne le x', 'b();', '// Retourne le x', 'c();', '// Returns the y   ', 'd();', '// retourne la valeur'].join('\n');
  const p = famille(signauxDe(contenu, FORMULES, JOURNAL), 'paraphrasant');
  assert.deepEqual([p.occurrences, p.ligne], [3, 5], 'la casse ne change rien (« retourne la valeur »)');
});

test('B-IA-01 commentaires paraphrasant : un commentaire au milieu du fichier compte (`$` est une fin de ligne, non la fin du fichier)', () => {
  const p = famille(signauxDe('a();\n// Retourne le x\nb();\nc();', FORMULES, JOURNAL), 'paraphrasant');
  assert.deepEqual([p.occurrences, p.ligne], [1, 2]);
});

test('B-IA-01 JSDoc générique : un `@param {type} nom - The …` dans l\'ouverture d\'un commentaire compte, la ligne est celle de `/**`', () => {
  const contenu = ['const a = 1;', '', '/**', ' * Additionne.', ' * @param {number} a - The first number', ' */', 'function f(a) {}'].join('\n');
  const j = famille(signauxDe(contenu), 'JSDoc');
  assert.deepEqual([j.occurrences, j.ligne], [1, 3]);
});

test('B-IA-01 JSDoc générique : un seul par commentaire (le texte d\'une occurrence est consommé), un par commentaire distinct', () => {
  const deux = '/**\n * @param {a} x - The x\n * @param {b} y - The y\n */';
  assert.equal(famille(signauxDe(deux), 'JSDoc').occurrences, 1, 'deux @param d\'un même commentaire : une occurrence');
  assert.equal(famille(signauxDe(`${deux}\nf();\n${deux}`), 'JSDoc').occurrences, 2, 'deux commentaires : deux occurrences');
  assert.equal(famille(signauxDe('/** @param {a} x - The x @param {b} y - The y */'), 'JSDoc').occurrences, 1, 'deux @param sur la ligne de `/**` : une occurrence');
  assert.equal(famille(signauxDe('/** @param {/**} x - The x @param {b} y - The y */'), 'JSDoc').occurrences, 1, 'un `/**` dans le type du premier @param ne rouvre pas un commentaire : le texte de l\'occurrence est consommé');
});

test('B-IA-01 JSDoc générique : la fenêtre est de 200 caractères entre `/**` et `@param` (200 : compté, 201 : non)', () => {
  const avec = (ecart) => `/**${'z'.repeat(ecart)}@param {a} x - The x */`;
  assert.equal(famille(signauxDe(avec(200)), 'JSDoc')?.occurrences, 1, '200 caractères entre l\'ouverture et le @param');
  assert.equal(famille(signauxDe(avec(201), FORMULES, JOURNAL), 'JSDoc'), undefined, '201 caractères : hors fenêtre');
  assert.equal(famille(signauxDe(avec(0)), 'JSDoc')?.occurrences, 1, 'accolés : compté');
});

test('B-IA-01 JSDoc générique : le type entre accolades est borné à 200 caractères (200 : compté, 201 : non)', () => {
  const avec = (longueur) => `/** @param {${'T'.repeat(longueur)}} x - The x */`;
  assert.equal(famille(signauxDe(avec(200)), 'JSDoc')?.occurrences, 1, 'type de 200 caractères');
  assert.equal(famille(signauxDe(avec(201), FORMULES, JOURNAL), 'JSDoc'), undefined, 'type de 201 caractères : non compté');
});

test('B-IA-01 JSDoc générique : sans ouverture `/**` dans la fenêtre (commentaire ordinaire, ligne isolée), rien ne compte ; la casse ne change rien', () => {
  assert.equal(famille(signauxDe('* @param {a} x - The x', FORMULES, JOURNAL), 'JSDoc'), undefined, 'sans ouverture');
  assert.equal(famille(signauxDe('/* @param {a} x - The x */', FORMULES, JOURNAL), 'JSDoc'), undefined, 'un commentaire `/*` n\'est pas un JSDoc');
  assert.equal(famille(signauxDe('* @param {a} x - The x\n/** un autre commentaire, plus loin */', FORMULES, JOURNAL), 'JSDoc'), undefined, 'une ouverture `/**` après le `@param` n\'en fait pas un JSDoc');
  assert.equal(famille(signauxDe('/** @PARAM {A} x - THE x */'), 'JSDoc')?.occurrences, 1, 'majuscules');
});

test('B-IA-01 : les six familles se comptent chacune à leur ligne, dans un même fichier', () => {
  const contenu = [
    'a();',
    '// Step 1: un',                  // 2
    'b();',
    '// As an AI, voici',             // 4
    '```',                            // 5
    '// Ajout de x',                  // 6
    '/** @param {a} x - The x */',    // 7
    '// Retourne le x',               // 8
    '// Voici le code',               // 9  (deuxième et troisième formules : le total atteint huit)
    '// Here\'s the code',            // 10
  ].join('\n');
  const c = analyserSignauxGeneration({ fichiers: [fichier('app.js', contenu)] }).find((x) => x.regle === 'B-IA-01');
  assert.ok(c, 'huit occurrences sur six familles : le constat se déclenche');
  assert.deepEqual(c.preuve.signaux.map((s) => [s.libelle.split(' ')[0], s.occurrences, s.ligne]), [
    ['commentaires', 1, 2], ['formules', 3, 4], ['délimiteurs', 1, 5], ['commentaires', 1, 6], ['JSDoc', 1, 7], ['commentaires', 1, 8],
  ]);
  assert.equal(c.ligne, 2, 'le constat pointe la première ligne du premier signal');
});

test('B-DOC-02 : la rubrique « ce que fait le widget » se reconnaît après une suite de lignes vides, un titre suivi de sa ligne, ou une indentation ; pas au milieu d\'une phrase', () => {
  const readme = (contenu) => analyserReadme({ fichiers: [fichier('README.md', contenu)] }).find((x) => x.regle === 'B-DOC-02');
  const AUTRES = '\nconfiguration\ndépendances\n';
  assert.equal(readme(`# Widget\n\n\n\n   Description du widget${AUTRES}`), undefined, 'après des lignes vides, indentée');
  assert.equal(readme(`#\nDescription${AUTRES}`), undefined, 'un titre vide, puis le mot à la ligne');
  assert.equal(readme(`## Usage${AUTRES}`), undefined, 'un titre Markdown');
  assert.equal(readme(`# Widget\n\u00a0Description du widget${AUTRES}`), undefined, 'indentée par une espace insécable');
  assert.equal(readme(`# Widget\r\n\r\n\r\nDescription du widget${AUTRES}`), undefined, 'fins de ligne CRLF');
  assert.match(readme(`texte avec description au milieu${AUTRES}`)?.titre ?? '', /ce que fait le widget/, 'au milieu d\'une phrase : la rubrique manque');
});

// --- A-DEV-03 : « À FAIRE »

test('A-DEV-03 : « À FAIRE » correspond isolé (en tête de commentaire, entre parenthèses, en fin de code) et ne correspond pas accolé à une lettre, un chiffre ni un soulignement', () => {
  const contenu = [
    '// TODO: un',                     // 1
    '// À FAIRE: deux',                // 2
    'x(); /* À FAIRE trois */',        // 3
    '// xÀ FAIRE: non',                // 4
    '// 9À FAIRE: non',                // 5
    '// _À FAIRE: non',                // 6
    '// À FAIREZ: non',                // 7
    '// xTODO: non',                   // 8
    '// FIXME: quatre',                // 9
    '// XXX: cinq',                    // 10
    '// (À FAIRE: six)',               // 11
  ].join('\n');
  const c = analyserTracesDev({ fichiers: [fichier('app.js', contenu)] }).find((x) => x.regle === 'A-DEV-03');
  assert.ok(c, 'six marqueurs : le constat se déclenche');
  assert.deepEqual(c.preuve.emplacements.map((e) => [e.ligne, e.type]), [[1, 'TODO'], [2, 'À FAIRE'], [3, 'À FAIRE'], [9, 'FIXME'], [10, 'XXX'], [11, 'À FAIRE']]);
});

// --- la borne des emplacements

const uneSuite = (n) => Array.from({ length: n }, (_, i) => ({ fichier: 'app.js', ligne: i + 1 }));
const avecPreuve = (preuve) => constat({ regle: 'X-TEST-01', axe: 'A', severite: 'mineur', titre: 't', constat: 'c', preuve });

test('constat() : la borne des emplacements est 500 (la changer est une décision, dite au message du commit)', () => {
  assert.equal(MAX_EMPLACEMENTS, 500);
});

test('constat() : 500 emplacements sont gardés tels quels, sans champ d\'omis ; 501 sont coupés à 500 avec `emplacementsOmis` = 1', () => {
  const exact = avecPreuve({ emplacements: uneSuite(500) });
  assert.equal(exact.preuve.emplacements.length, 500);
  assert.equal('emplacementsOmis' in exact.preuve, false, 'rien d\'omis : pas de champ');
  const trop = avecPreuve({ emplacements: uneSuite(501), hotes: ['a.example'] });
  assert.equal(trop.preuve.emplacements.length, 500);
  assert.equal(trop.preuve.emplacementsOmis, 1);
  assert.deepEqual([trop.preuve.emplacements[0].ligne, trop.preuve.emplacements[499].ligne], [1, 500], 'les premiers, dans l\'ordre');
  assert.deepEqual(trop.preuve.hotes, ['a.example'], 'le reste de la preuve est gardé');
});

test('constat() : 5 000 emplacements donnent 500 gardés et 4 500 omis ; la liste de la règle n\'est pas modifiée', () => {
  const liste = uneSuite(5000);
  const c = avecPreuve({ emplacements: liste });
  assert.deepEqual([c.preuve.emplacements.length, c.preuve.emplacementsOmis], [500, 4500]);
  assert.equal(liste.length, 5000, 'la liste d\'origine reste entière');
});

test('constat() : une preuve absente reste nulle, une preuve sans liste d\'emplacements ou dont `emplacements` n\'est pas une liste reste telle quelle', () => {
  assert.equal(avecPreuve(undefined).preuve, null);
  assert.equal(avecPreuve(null).preuve, null);
  const sansListe = { hotes: ['a'] };
  assert.equal(avecPreuve(sansListe).preuve, sansListe);
  const chaine = { emplacements: 'x'.repeat(600) };
  assert.equal(avecPreuve(chaine).preuve.emplacements.length, 600, 'une chaîne n\'est pas une liste d\'emplacements');
});

test('A-DEV-01, A-DEV-03 et F-SOUV-01 : au-delà de la borne le constat garde les 500 premiers emplacements et dit combien il en omet, son texte porte le total exact', () => {
  const traces = analyserTracesDev({ fichiers: [fichier('app.js', [...Array.from({ length: 510 }, () => 'console.log(1);'), ...Array.from({ length: 520 }, () => '// TODO: x')].join('\n'))] });
  const consoles = traces.find((x) => x.regle === 'A-DEV-01');
  assert.deepEqual([consoles.preuve.emplacements.length, consoles.preuve.emplacementsOmis], [500, 10]);
  assert.match(consoles.titre, /^510 appels/);
  const marqueurs = traces.find((x) => x.regle === 'A-DEV-03');
  assert.deepEqual([marqueurs.preuve.emplacements.length, marqueurs.preuve.emplacementsOmis], [500, 20]);
  assert.match(marqueurs.titre, /^520 marqueurs/);
  assert.match(marqueurs.constat, /520 marqueurs/);
  const souverainete = analyserSouverainete({ fichiers: [fichier('app.js', Array.from({ length: 510 }, (_, i) => `// https://fonts.googleapis.com/a${i}`).join('\n'))] }).find((x) => x.regle === 'F-SOUV-01');
  assert.deepEqual([souverainete.preuve.emplacements.length, souverainete.preuve.emplacementsOmis], [500, 10]);
  assert.match(souverainete.constat, /^510 référence/);
  assert.ok(souverainete.preuve.hotes.includes('fonts.googleapis.com'), 'les hôtes se déduisent de la liste entière, avant la coupe');
});
