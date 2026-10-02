import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noter } from '../src/moteur/notation.js';
import { constatsDe, copie, copieSurUneLigne, dup, ecart, fichier, fonctionsDistinctes, noeudsDeSource, rempli, separateurA, separateurB } from './aide-a-dup.mjs';

/**
 * Ce que la recherche de code dupliqué ne compare pas, et comment elle le dit (A-DUP-00) : le code d'un autre (bibliothèques, code construit), celui qu'aucun humain
 * ne relit (minifié, empaqueté), ce qu'un outil a généré et que la page n'exécute pas, ce qui ne tient pas dans le plafond de nœuds ou de travail. Puis l'ordre où
 * les fichiers entrent dans la recherche, qui décide de ce que le plafond laisse. Rien de ce qui se lit n'est laissé de côté sans le dire, et du code que la page
 * exécute qu'un plafond a laissé rend la mesure partielle.
 */

const TIERCE = (n) => `${n} fichier(s) ou script(s) de bibliothèques tierces ou de code construit (dossiers vendor, node_modules, dist…) ne sont pas comparés`;
const MINIFIEE = (n) => `${n} fichier(s) ou script(s) minifiés (lignes de plus de 200 caractères en moyenne) ne sont pas comparés`;
const EMPAQUETEE = (n) => `${n} fichier(s) ou script(s) empaquetés par un outil de build ne sont pas comparés`;
const GENEREE = (n) => `${n} fichier(s) ou script(s) générés par un outil et que la page n'exécute pas ne sont pas comparés`;
const TRAVAIL = "la recherche a atteint le plafond de travail fixé et s'est arrêtée avant la fin";
const dit = (...causes) => `La recherche de code dupliqué n'a pas tout comparé : ${causes.join(' ; ')}.`;

/** Deux fichiers qui ont chacun la même fonction (`contenuDe(nom)`) : un clone, tant que rien ne les écarte de la comparaison. */
const paire = (contenuDe = copie, extra = {}) => [fichier('a.js', contenuDe('f'), extra), fichier('b.js', contenuDe('g'), extra)];
/** Le clone des deux fichiers est trouvé, et rien n'est dit laissé de côté. */
function comparees(fichiers, message) {
  assert.equal(dup(fichiers).length, 1, message);
  assert.equal(ecart(fichiers), undefined, message);
}
/** Aucun clone n'est trouvé, et A-DUP-00 dit exactement ces causes. */
function ecartees(fichiers, causes, message) {
  assert.deepEqual(dup(fichiers), [], message);
  assert.equal(ecart(fichiers)?.constat, dit(...causes), message);
}

// ---------------------------------------------------------------------------------------------------------------------
// Le code d'un autre

test('sans rien d\'écarté, aucun constat A-DUP-00', () => {
  comparees(paire());
});

test('le code d\'une bibliothèque tierce ou d\'un dossier construit ne se compare pas, et A-DUP-00 le dit', () => {
  for (const extra of [{ vendorise: true }, { dossierExclu: true }]) {
    ecartees([fichier('a.js', copie('f')), fichier('b.js', copie('g'), extra)], [TIERCE(1)], JSON.stringify(extra));
  }
  ecartees(paire(copie, { vendorise: true }), [TIERCE(2)]);
  ecartees(paire(copie, { dossierExclu: true }), [TIERCE(2)]);
});

test('du code que la page n\'exécute pas se compare, tests compris', () => {
  comparees(paire(copie, { executee: false }));
  comparees(paire(copie, { executee: undefined }));
  const enTest = [fichier('tests/a.test.js', copie('f'), { executee: false }), fichier('src/b.js', copie('g'))];
  assert.equal(dup(enTest).length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// Le code qu'aucun humain ne relit : minifié, empaqueté

const LONGUEURS = [
  ['une moyenne de 200 caractères par ligne', copie, 2400, 12, false],
  ['un peu plus de 200 caractères par ligne', copie, 2401, 12, true],
  ['1 Kio exactement, des lignes de plus de 200 caractères', copieSurUneLigne, 1024, 4, false],
  ['un peu plus de 1 Kio, des lignes de plus de 200 caractères', copieSurUneLigne, 1025, 4, true],
  ['une seule ligne de 1 Kio', copieSurUneLigne, 1024, 1, false],
  ['une seule ligne d\'un peu plus de 1 Kio', copieSurUneLigne, 1025, 1, true],
  ['un morceau de 6 Kio sur deux lignes, de ceux qu\'un empaqueteur découpe', copieSurUneLigne, 6144, 2, true],
  ['une seule ligne de 20 Kio', copieSurUneLigne, 20480, 1, true],
];
for (const [nom, source, taille, lignes, minifie] of LONGUEURS) {
  test(`${nom} : ${minifie ? 'du code minifié, écarté' : 'du code lisible, comparé'}`, () => {
    const fichiers = paire((n) => rempli(source(n), taille, lignes));
    if (minifie) ecartees(fichiers, [MINIFIEE(2)]);
    else comparees(fichiers);
  });
}

test('un texte qui commence par un retour à la ligne compte ses lignes : de 12 Kio sur 80 lignes, il est lisible', () => {
  comparees(paire((n) => `\n${rempli(copie(n), 11999, 79)}`));
  const page = (script) => `<!doctype html>\n<script>\n${script}</script>\n`;                      // le texte d'un script de page commence après la balise, par un retour à la ligne
  comparees([fichier('a.html', page(rempli(copie('f'), 12000, 80))), fichier('b.html', page(rempli(copie('g'), 12000, 80)))]);
});

test('ce qui se mesure est le script d\'une page, non la page : un grand texte autour d\'un petit script ne l\'écarte pas, un script minifié dans une petite page, si', () => {
  const page = (script, autour = '') => `<!doctype html>\n<body>${autour}</body>\n<script>\n${script}</script>\n`;
  comparees([fichier('a.html', page(copie('f'), 'x'.repeat(30000))), fichier('b.html', page(copie('g'), 'x'.repeat(30000)))]);
  const minifie = (nom) => rempli(copieSurUneLigne(nom), 12000, 1);
  ecartees([fichier('a.html', page(minifie('f'))), fichier('b.html', page(minifie('g')))], [MINIFIEE(2)]);
});

const SIGNATURES = ['__defProp', '__getOwnPropNames', '__getOwnPropDesc', '__getProtoOf', '__commonJS', '__esModule', '__toESM', '__webpack_require__', 'webpackBootstrap'];
for (const signature of SIGNATURES) {
  test(`${signature} : la signature d'un empaqueteur écarte le code, qui n'est pas relu par un humain`, () => {
    ecartees(paire((n) => `// ${signature}\n${copie(n)}`), [EMPAQUETEE(2)]);
  });
}

test('une signature d\'empaqueteur ne se reconnaît que mot entier', () => {
  for (const signature of SIGNATURES) {
    comparees(paire((n) => `// x${signature}\n${copie(n)}`), `x${signature}`);
    comparees(paire((n) => `// ${signature}x\n${copie(n)}`), `${signature}x`);
  }
});

/** `longueur` caractères sur des lignes de 80 : du remplissage qui ne rend pas minifié le fichier qu'il allonge. */
const lignesDe80 = (longueur) => Array.from({ length: longueur }, (_, i) => (i % 80 === 79 ? '\n' : 'x')).join('');
/** Un début de fichier de `longueur` caractères, un commentaire. */
const bourre = (longueur) => `/*${lignesDe80(longueur - 4)}*/`;

test('la signature d\'un empaqueteur se lit dans les 5 000 premiers caractères du code', () => {
  const avec = (position) => (n) => `${bourre(position)}__esModule;\n${copie(n)}`;                       // la signature occupe [position, position + 10)
  ecartees(paire(avec(4990)), [EMPAQUETEE(2)]);                                                            // son dernier caractère est le 5 000e
  comparees(paire(avec(4991)), 'un caractère de plus : la signature est coupée');
});

test('la signature d\'un empaqueteur d\'une page se lit dans son script, non dans le reste de la page', () => {
  const page = (script, avant = '') => `<!doctype html>\n<body>${avant}</body>\n<script>\n${script}</script>\n`;
  const pages = (contenuDe) => [fichier('a.html', contenuDe('f')), fichier('b.html', contenuDe('g'))];
  ecartees(pages((n) => page(`// __esModule\n${copie(n)}`, 'x'.repeat(6000))), [EMPAQUETEE(2)], 'le script porte la signature, la page la lui cache sous six mille caractères');
  comparees(pages((n) => page(copie(n), '__esModule')), 'la page nomme un empaqueteur, son script est écrit à la main');
});

// ---------------------------------------------------------------------------------------------------------------------
// Ce qu'un outil a généré et que la page n'exécute pas

const MARQUES = [
  ['@generated', '/* @generated */'],
  ['DO NOT EDIT', '// DO NOT EDIT'],
  ['do not edit, en minuscules', '// do not edit this file'],
  ['auto-generated', '// auto-generated'],
  ['autogenerated', '// autogenerated'],
  ['Auto-Generated, en capitales', '// Auto-Generated'],
  ['automatically generated', '// This file was automatically generated'],
  ['code generated', '// Code generated by protoc-gen-go'],
];
for (const [nom, marque] of MARQUES) {
  test(`${nom} : du code généré que la page n'exécute pas ne se compare pas, celui qu'elle exécute, si`, () => {
    const contenu = (n) => `${marque}\n${copie(n)}`;
    ecartees(paire(contenu, { executee: false }), [GENEREE(2)], 'non exécuté');
    ecartees(paire(contenu, { executee: undefined }), [GENEREE(2)], 'exécution non établie');
    comparees(paire(contenu, { executee: true }), 'exécuté');
  });
}

test('« généré par » un auteur, quel qu\'il soit, n\'est pas une marque : se dire généré par une IA n\'écarte rien', () => {
  for (const texte of ['generated by ChatGPT', 'Generated with Claude', 'the generated code lives elsewhere', 'regenerated by hand', 'not DO NOT']) {
    comparees(paire((n) => `// ${texte}\n${copie(n)}`, { executee: false }), texte);
  }
});

test('une marque de génération ne se reconnaît que mot entier', () => {
  for (const marque of ['@generated', 'DO NOT EDIT', 'auto-generated', 'autogenerated', 'automatically generated', 'code generated']) {
    if (!marque.startsWith('@')) comparees(paire((n) => `// x${marque}\n${copie(n)}`, { executee: false }), `x${marque}`);
    comparees(paire((n) => `// ${marque}x\n${copie(n)}`, { executee: false }), `${marque}x`);
  }
});

test('la marque de génération se lit dans les 5 000 premiers caractères du code', () => {
  const marquee = (position) => (n) => `/*${lignesDe80(position - 2)}@generated*/\n${copie(n)}`;               // la marque occupe [position, position + 10)
  ecartees(paire(marquee(4990), { executee: false }), [GENEREE(2)]);                                            // son dernier caractère est le 5 000e
  comparees(paire(marquee(4991), { executee: false }), 'un caractère de plus : la marque est coupée');
});

test('la marque de génération d\'une page se lit dans l\'en-tête de la page comme dans celui de son script', () => {
  const pages = (contenuDe, extra = { executee: false }) => [fichier('a.html', contenuDe('f'), extra), fichier('b.html', contenuDe('g'), extra)];
  const dansLaPage = (n) => `<!-- @generated -->\n<!doctype html>\n<script>\n${copie(n)}</script>\n`;
  const dansLeScript = (n) => `<!doctype html>\n<body>${'x'.repeat(6000)}</body>\n<script>\n// @generated\n${copie(n)}</script>\n`;   // le script commence après les 5 000 premiers caractères de la page
  const apres = (n) => `<!doctype html>\n<body>${'x'.repeat(6000)}</body>\n<script>\n${copie(n)}</script>\n<!-- @generated -->\n`;       // la marque est trop loin pour la page, et n'est pas dans le script
  ecartees(pages(dansLaPage), [GENEREE(2)], 'la marque est en tête de la page');
  ecartees(pages(dansLeScript), [GENEREE(2)], 'la marque est en tête du script');
  comparees(pages(apres), 'la marque est hors des deux en-têtes');
  comparees(pages(dansLaPage, { executee: true }), 'la page est exécutée');
});

// ---------------------------------------------------------------------------------------------------------------------
// Ce que rien n'exempte

const BANNIERE = "/*!\n * Licensed under the MIT License.\n * Copyright (c) 2020 Quelqu'un\n * @license MIT\n */\n";

test('une bannière de licence n\'exempte rien : le code qui la porte se compare, le code minifié qui la porte reste écarté', () => {
  comparees(paire((n) => BANNIERE + copie(n)));
  ecartees(paire((n) => rempli(BANNIERE + copieSurUneLigne(n), 20480, 6)), [MINIFIEE(2)]);
  ecartees(paire((n) => BANNIERE + `// __esModule\n${copie(n)}`), [EMPAQUETEE(2)]);
});

test('une seule cause compte par fichier, la première dans l\'ordre : bibliothèque, minifié, empaqueté, généré', () => {
  const minifie = (n) => rempli(copieSurUneLigne(n), 12000, 1);
  const fichiers = [
    fichier('vendor/min.js', minifie('f'), { vendorise: true }),                                              // bibliothèque et minifié : bibliothèque
    fichier('min.js', `// __esModule\n${minifie('g')}`),                                                      // minifié et empaqueté : minifié
    fichier('bundle.js', `// @generated\n// __esModule\n${copie('h')}`, { executee: false }),               // empaqueté et généré : empaqueté
  ];
  assert.equal(ecart(fichiers).constat, dit(TIERCE(1), MINIFIEE(1), EMPAQUETEE(1)));
});

// ---------------------------------------------------------------------------------------------------------------------
// Ce que les plafonds laissent de côté

test('un fichier trop volumineux pour être gardé : A-DUP-00 le nomme, la mesure est partielle quand la page l\'exécute, et la recherche garde ce qu\'elle a vu', () => {
  const fichiers = [fichier('a.js', copie('f')), fichier('b.js', copie('g')), fichier('gros.js', fonctionsDistinctes(30, separateurA))];
  const constats = constatsDe(fichiers, { seuils: { noeuds: 400 } });
  assert.deepEqual(constats.map((c) => c.regle), ['A-DUP-01', 'A-DUP-00'], 'les clones comparés, puis ce qui ne l\'a pas été');
  const c = constats[1];
  assert.equal(c.axe, 'A');
  assert.equal(c.severite, 'info');
  assert.equal(c.confiance, 'certain');
  assert.equal(c.titre, "Du code que la page exécute n'a pas été comparé par la recherche de code dupliqué");
  assert.equal(c.constat, dit("1 fichier(s) ou script(s) trop volumineux pour être gardés en mémoire (dont 1 que la page exécute) n'ont pas été comparés (`gros.js`)"));
  assert.equal(c.impact, "Du code dupliqué peut subsister dans ce qui n'a pas été comparé : l'absence de constat A-DUP-01 ne dit rien de ces parties.");
  assert.equal(c.mesurePartielle, true);
  assert.deepEqual(constats[0].preuve.groupes[0].instances.map((e) => e.fichier), ['a.js', 'b.js']);
});

test('trop volumineux et que la page n\'exécute pas : A-DUP-00 le dit sans que la mesure soit partielle', () => {
  const c = ecart([fichier('hors.js', copie('f'), { executee: false })], { seuils: { noeuds: 1 } });
  assert.equal(c.titre, 'Code laissé de côté par la recherche de code dupliqué');
  assert.equal(c.constat, dit("1 fichier(s) ou script(s) trop volumineux pour être gardés en mémoire n'ont pas été comparés (`hors.js`)"));
  assert.equal(c.mesurePartielle, false);
});

test('parmi les fichiers trop volumineux, A-DUP-00 compte ceux que la page exécute et les nomme dans l\'ordre de la recherche : l\'exécuté d\'abord', () => {
  const c = ecart([fichier('x.js', copie('f'), { executee: false }), fichier('y.js', copie('g'), { executee: false }), fichier('z.js', copie('h'))], { seuils: { noeuds: 1 } });
  assert.equal(c.constat, dit("3 fichier(s) ou script(s) trop volumineux pour être gardés en mémoire (dont 1 que la page exécute) n'ont pas été comparés (`z.js`, `x.js`, `y.js`)"));
  assert.equal(c.mesurePartielle, true);
});

test('A-DUP-00 ne nomme que dix fichiers, une fois chacun, et le dit', () => {
  const fichiers = Array.from({ length: 12 }, (_, i) => fichier(`u${String(i).padStart(2, '0')}.js`, copie('f')));
  const c = ecart(fichiers, { seuils: { noeuds: 1 } });
  assert.equal(c.constat, dit("12 fichier(s) ou script(s) trop volumineux pour être gardés en mémoire (dont 12 que la page exécute) n'ont pas été comparés (`u00.js`, `u01.js`, `u02.js`, `u03.js`, `u04.js`, `u05.js`, `u06.js`, `u07.js`, `u08.js`, `u09.js`, …)"));
  const dix = ecart(fichiers.slice(0, 10), { seuils: { noeuds: 1 } });
  assert.doesNotMatch(dix.constat, /…/, 'dix noms tiennent : rien à ajouter');
});

test('une page dont plusieurs scripts sont trop volumineux est nommée une fois, ses scripts comptés', () => {
  const page = `<!doctype html>\n<script>\n${copie('f')}</script>\n<script>\n${copie('g')}</script>\n`;
  const c = ecart([fichier('index.html', page)], { seuils: { noeuds: 1 } });
  assert.equal(c.constat, dit("2 fichier(s) ou script(s) trop volumineux pour être gardés en mémoire (dont 2 que la page exécute) n'ont pas été comparés (`index.html`)"));
  const onze = `<!doctype html>\n${Array.from({ length: 11 }, (_, i) => `<script>\n${copie(`f${i}`)}</script>\n`).join('')}`;
  assert.doesNotMatch(ecart([fichier('index.html', onze)], { seuils: { noeuds: 1 } }).constat, /…/, 'onze scripts, un seul nom : rien à ajouter');
});

test('un nom de fichier de plus de 120 caractères n\'est cité que par sa fin', () => {
  const nom = `${'d'.repeat(300)}.js`;
  const c = ecart([fichier(nom, copie('f'))], { seuils: { noeuds: 1 } });
  assert.ok(c.constat.includes(`(\`…${nom.slice(-120)}\`)`));
  assert.ok(!c.constat.includes(nom.slice(-121)));
});

test('un nom de fichier qui a du sens pour le Markdown est cité', () => {
  const c = ecart([fichier('a`b.js', copie('f'))], { seuils: { noeuds: 1 } });
  assert.match(c.constat, /\(``a`b\.js``\)\.$/);
});

test('le plafond de travail : A-DUP-00 le dit, et la mesure est partielle dès que du code exécuté a été lu', () => {
  const c = ecart(paire(), { seuils: { pas: 0 } });
  assert.equal(c.constat, dit(TRAVAIL));
  assert.equal(c.titre, "Du code que la page exécute n'a pas été comparé par la recherche de code dupliqué");
  assert.equal(c.mesurePartielle, true);
});

test('le plafond de travail ne rend la mesure partielle que si du code que la page exécute a été lu', () => {
  const horsPage = ecart(paire(copie, { executee: false }), { seuils: { pas: 0 } });
  assert.equal(horsPage.constat, dit(TRAVAIL));
  assert.equal(horsPage.titre, 'Code laissé de côté par la recherche de code dupliqué');
  assert.equal(horsPage.mesurePartielle, false);
  const un = ecart([fichier('a.js', copie('f'), { executee: false }), fichier('b.js', copie('g'))], { seuils: { pas: 0 } });
  assert.equal(un.mesurePartielle, true, 'un seul fichier exécuté suffit');
});

// Une erreur de l'outil pendant la recherche : l'audit ne s'arrête pas, A-DUP-00 la dit

/** Des plafonds dont la comparaison lève `erreur` : la recherche s'interrompt au premier pas qu'elle compte. */
const quiLeve = (erreur) => ({ seuils: { pas: { valueOf() { throw erreur; } } } });
const INTERROMPUE = (message) => `la recherche s'est interrompue sur une erreur de l'outil (${message}) : aucun clone n'a été rendu`;

test('une erreur de l\'outil pendant la recherche n\'arrête pas l\'audit : A-DUP-00 la dit, et la mesure est partielle', () => {
  const constats = constatsDe(paire(), quiLeve(new RangeError('Invalid array length')));
  assert.deepEqual(constats.map((c) => c.regle), ['A-DUP-00'], 'aucun clone n\'est rendu, le constat de la recherche qui échoue est le seul');
  assert.equal(constats[0].constat, dit(INTERROMPUE('RangeError : Invalid array length')));
  assert.equal(constats[0].titre, "Du code que la page exécute n'a pas été comparé par la recherche de code dupliqué");
  assert.equal(constats[0].mesurePartielle, true);
});

test('la recherche interrompue ne rend la mesure partielle que si du code que la page exécute a été lu', () => {
  const c = ecart(paire(copie, { executee: false }), quiLeve(new Error('x')));
  assert.equal(c.constat, dit(INTERROMPUE('Error : x')));
  assert.equal(c.titre, 'Code laissé de côté par la recherche de code dupliqué');
  assert.equal(c.mesurePartielle, false);
});

test('la pile qui déborde pendant la recherche se dit en deux mots, une erreur longue se tronque', () => {
  assert.equal(ecart(paire(), quiLeve(new RangeError('Maximum call stack size exceeded'))).constat, dit(INTERROMPUE('la pile déborde')));
  const c = ecart(paire(), quiLeve(new Error('x'.repeat(5000))));
  assert.equal(c.constat, dit(INTERROMPUE(`Error : ${'x'.repeat(200)}`)));
});

test('l\'erreur de l\'outil s\'ajoute aux autres causes, après le plafond de travail', () => {
  const c = ecart([...paire(), fichier('vendor/lib.js', copie('v'), { vendorise: true })], quiLeve(new Error('x')));
  assert.equal(c.constat, dit(TIERCE(1), INTERROMPUE('Error : x')));
});

test('plusieurs causes se disent ensemble, dans l\'ordre : bibliothèque, minifié, empaqueté, généré, volumineux, travail', () => {
  const fichiers = [
    fichier('vendor/lib.js', copie('v'), { vendorise: true }),
    fichier('min.js', rempli(copieSurUneLigne('m'), 12000, 1)),
    fichier('bundle.js', `// __esModule\n${copie('b')}`),
    fichier('genere.js', `// @generated\n${copie('g')}`, { executee: false }),
    fichier('gros.js', fonctionsDistinctes(20, separateurA)),
    ...Array.from({ length: 2 }, (_, i) => fichier(`u${i}.js`, copie('f'))),
    fichier('p.js', fonctionsDistinctes(2, separateurA)), fichier('q.js', fonctionsDistinctes(2, separateurB)),
  ];
  const c = ecart(fichiers, { seuils: { noeuds: 1500, pas: 0 } });
  assert.equal(c.constat, dit(TIERCE(1), MINIFIEE(1), EMPAQUETEE(1), GENEREE(1),
    "1 fichier(s) ou script(s) trop volumineux pour être gardés en mémoire (dont 1 que la page exécute) n'ont pas été comparés (`gros.js`)", TRAVAIL));
  assert.equal(c.mesurePartielle, true);
});

test('ce que les exclusions laissent ne rend jamais la mesure partielle, même du code que la page exécute', () => {
  const minifie = (n) => rempli(copieSurUneLigne(n), 12000, 1);
  const c = ecart(paire(minifie), {});
  assert.equal(c.titre, 'Code laissé de côté par la recherche de code dupliqué');
  assert.equal(c.mesurePartielle, false);
  const avecDuLisible = ecart([...paire(minifie), fichier('c.js', copie('h')), fichier('d.js', copie('i'))], {});
  assert.equal(avecDuLisible.mesurePartielle, false, 'du code lisible que la page exécute a été comparé : ce qui est écarté à côté n\'y change rien');
});

// ---------------------------------------------------------------------------------------------------------------------
// Ce que cela change à la note : rien que le verdict ne puisse dire

test('du code exécuté laissé de côté plafonne le verdict à CONFORME SOUS RÉSERVE sans coûter un point à l\'axe A', () => {
  const constats = constatsDe([fichier('a.js', copie('f'))], { seuils: { noeuds: 1 } });
  const sans = noter([], new Set());
  const note = noter(constats, new Set());
  assert.equal(note.verdict, 'CONFORME SOUS RÉSERVE');
  assert.deepEqual(note.axesPartiels, ['A']);
  assert.match(note.motif, /Audit partiel — couverture incomplète : A \(.*\) — Du code que la page exécute n'a pas été comparé par la recherche de code dupliqué/);
  assert.equal(note.parAxe.A.score, sans.parAxe.A.score, 'une information ne se paie pas');
  assert.equal(note.global, sans.global);
});

test('du code laissé de côté que la page n\'exécute pas, ou écarté par une exclusion, ne plafonne pas le verdict', () => {
  for (const constats of [
    constatsDe([fichier('a.js', copie('f'), { executee: false })], { seuils: { noeuds: 1 } }),
    constatsDe(paire(copie, { vendorise: true }), {}),
  ]) {
    assert.equal(constats.length, 1);
    const note = noter(constats, new Set());
    assert.equal(note.verdict, 'CONFORME');
    assert.deepEqual(note.axesPartiels, []);
    assert.equal(note.global, noter([], new Set()).global);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// L'ordre où les fichiers entrent dans la recherche : le plafond de nœuds laisse de côté ce qui vient en dernier

/** Les chemins que A-DUP-00 dit ne pas avoir comparés, `null` s'il ne dit rien. */
function ignoresDe(fichiers, noeuds) {
  const c = ecart(fichiers, { seuils: { noeuds } });
  return c ? c.constat.match(/comparés \((.*)\)\.$/)[1].split(', ').map((nom) => nom.replace(/^`|`$/g, '')) : null;
}
/** Les constats sans leur numéro de série, qui compte les constats créés depuis le début du processus. */
const sansUid = (constats) => constats.map(({ uid, ...reste }) => reste);
const permutations = (liste) => (liste.length <= 1 ? [liste] : liste.flatMap((x, i) => permutations([...liste.slice(0, i), ...liste.slice(i + 1)]).map((reste) => [x, ...reste])));
/** `copie` et quatre nœuds de plus (`var z = 1;`) : un peu plus long, de peu de nœuds. */
const copieEtUnPeu = (nom) => `${copie(nom)}var z = 1;\n`;

test('le plafond de nœuds laisse de côté le plus long des fichiers, quel que soit l\'ordre où l\'inventaire les donne', () => {
  const n = noeudsDeSource(copie('f'));
  const fichiers = [fichier('a.js', copieEtUnPeu('f')), fichier('b.js', copie('g')), fichier('c.js', copie('h'))];   // `a.js` : le premier par son chemin, le plus long par sa taille
  assert.equal(noeudsDeSource(fichiers[0].contenu), n + 4);
  const plafond = 2 * n;                        // `a.js` seul tient, avec lui aucun des deux autres ne tient ; les deux autres tiennent, avec eux `a.js` ne tient pas
  const attendu = sansUid(constatsDe(fichiers, { seuils: { noeuds: plafond } }));
  assert.deepEqual(ignoresDe(fichiers, plafond), ['a.js']);
  assert.deepEqual(attendu.find((c) => c.regle === 'A-DUP-01').preuve.groupes[0].instances.map((e) => e.fichier), ['b.js', 'c.js'], 'les deux fichiers gardés sont comparés');
  for (const ordre of permutations(fichiers)) {
    assert.deepEqual(sansUid(constatsDe(ordre, { seuils: { noeuds: plafond } })), attendu, ordre.map((f) => f.chemin).join(' '));
  }
});

test('le plafond de nœuds laisse de côté le code que la page ne charge pas avant celui qu\'elle exécute, même plus court', () => {
  const charge = fichier('charge.js', copieEtUnPeu('f'));
  const plafond = noeudsDeSource(charge.contenu);                 // de quoi garder un seul des deux
  for (const executee of [false, undefined]) {
    const fichiers = [fichier('hors.js', copie('g'), { executee }), charge];
    assert.deepEqual(ignoresDe(fichiers, plafond), ['hors.js'], `executee : ${executee}`);
    assert.deepEqual(ignoresDe([...fichiers].reverse(), plafond), ['hors.js'], `executee : ${executee}, l'inventaire à l'envers`);
  }
});

test('à longueur égale, le plafond de nœuds laisse de côté le dernier chemin dans l\'ordre alphabétique, non le dernier de l\'inventaire', () => {
  const fichiers = ['c.js', 'a.js', 'b.js'].map((chemin) => fichier(chemin, copie('f')));
  assert.deepEqual(ignoresDe(fichiers, 2 * noeudsDeSource(copie('f'))), ['c.js']);
});

test('la longueur qui ordonne un script de page est celle du script, non celle de la page', () => {
  const page = (corps, script) => `<!doctype html>\n<body>${corps}</body>\n<script>\n${script}</script>\n`;
  const longue = fichier('longue.html', page('x'.repeat(2000), copie('f')));         // la plus longue des pages, le plus court des scripts
  const courte = fichier('courte.html', page('', copieEtUnPeu('g')));
  const plafond = noeudsDeSource(copieEtUnPeu('g'));                                   // de quoi garder un seul des deux scripts
  assert.deepEqual(ignoresDe([courte, longue], plafond), ['courte.html']);
  assert.deepEqual(ignoresDe([longue, courte], plafond), ['courte.html']);
});
