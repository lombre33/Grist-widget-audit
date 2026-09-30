/**
 * Ce qui protège un chargement de module distant : la clé `integrity` d'une import
 * map, mais seulement si la carte est lue AVANT la balise qui commence le chargement
 * (Chromium 141 : une page livrée en deux morceaux exécute le module du premier sans
 * la vérifier ; une balise `<script type="module" src>` résout son adresse avant de
 * voir une carte qui la suit), et jamais quand un worker l'exécute. E-DEP-01 (avec quelle
 * empreinte) et C-EXFIL-01 (d'où vient le code) lisent le même verdict
 * (`contexte/imports-distants.js`) : ils ne peuvent pas se contredire.
 * Le différentiel `e-dep-imports-chromium.test.mjs` fait dire ces faits au navigateur ;
 * ici la règle, cas par cas, dans l'ordre du document.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditer, avecWidget, page } from './aide-surface.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { importsDistants, RAISON_CHARGEUR_INCONNU, RAISON_SANS_EMPREINTE } from '../src/contexte/imports-distants.js';

const U = 'https://esm.sh/foo@1.2.3';
const SRI = `sha384-${'A'.repeat(64)}`;
const MOD = (code) => `<script type="module">\n${code}\n</script>`;
const CARTE = (integrity = { [U]: SRI }, imports = {}) => `<script type="importmap">${JSON.stringify({ imports, integrity })}</script>`;
const E = (a) => a.de('E-DEP-01');
const C = (a) => a.de('C-EXFIL-01');
const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''}`;
const RAISON_TARDIVE = /l'import map de la page qui porte l'empreinte \(ligne (\d+)\) est lue après le script qui le charge \(ligne (\d+)\)/;

test('un module lu avant la carte n\'est pas protégé, après elle il l\'est : E-DEP-01 et C-EXFIL-01 disent la même chose', async () => {
  const avant = await auditer({ 'index.html': page(`${MOD(`import "${U}";`)}${CARTE()}`) });
  assert.deepEqual(E(avant).map(etat), ['critique bloquant']);
  assert.deepEqual(C(avant).map(etat), ['critique bloquant']);
  const [, ligneCarte, ligneScript] = RAISON_TARDIVE.exec(E(avant)[0].constat);
  assert.deepEqual([ligneCarte, ligneScript], ['3', '1'], 'la carte est ligne 3, le script qui charge ligne 1');
  assert.match(C(avant)[0].constat, RAISON_TARDIVE, 'C-EXFIL-01 dit pourquoi, avec les mêmes mots');

  const apres = await auditer({ 'index.html': page(`${CARTE()}${MOD(`import "${U}";`)}`) });
  assert.deepEqual(E(apres).map(etat), ['majeur']);
  assert.deepEqual(C(apres).map(etat), ['majeur']);
  assert.match(C(apres)[0].constat, /l'empreinte de la clé `integrity` d'une import map de la page fige ce code/);
});

test('la carte dans l\'en-tête précède tout script du corps ; un script de l\'en-tête placé avant elle non', async () => {
  const entete = await auditer({ 'index.html': page(MOD(`import "${U}";`), CARTE()) });
  assert.deepEqual(E(entete).map(etat), ['majeur']);
  const avant = await auditer({ 'index.html': page('', `${MOD(`import "${U}";`)}${CARTE()}`) });
  assert.deepEqual(E(avant).map(etat), ['critique bloquant']);
});

test('un module .js que la page charge par une balise placée avant la carte n\'est pas protégé ; après la carte, si', async () => {
  const module = { 'app.js': `import "${U}";\n` };
  const avant = await auditer({ 'index.html': page(`<script type="module" src="app.js"></script>${CARTE()}`), ...module });
  assert.deepEqual(E(avant).map((c) => `${c.fichier}:${c.ligne} ${etat(c)}`), ['app.js:1 critique bloquant']);
  assert.match(E(avant)[0].constat, RAISON_TARDIVE);
  const apres = await auditer({ 'index.html': page(`${CARTE()}<script type="module" src="app.js"></script>`), ...module });
  assert.deepEqual(E(apres).map((c) => `${c.fichier}:${c.ligne} ${etat(c)}`), ['app.js:1 majeur']);
});

test('un module atteint de proche en proche prend la balise qui mène à lui : la carte doit précéder la première', async () => {
  const fichiers = { 'app.js': 'import "./b.js";\n', 'b.js': `import "${U}";\n` };
  const avant = await auditer({ 'index.html': page(`<script type="module" src="app.js"></script>${CARTE()}`), ...fichiers });
  assert.deepEqual(E(avant).map(etat), ['critique bloquant']);
  const apres = await auditer({ 'index.html': page(`${CARTE()}<script type="module" src="app.js"></script>`), ...fichiers });
  assert.deepEqual(E(apres).map(etat), ['majeur']);
});

test('un fichier que deux balises chargent compte à la première : la carte entre les deux ne le protège pas', async () => {
  const a = await auditer({
    'index.html': page(`<script type="module" src="app.js"></script>${CARTE()}<script type="module" src="app.js"></script>`),
    'app.js': `import "${U}";\n`,
  });
  assert.deepEqual(E(a).map(etat), ['critique bloquant']);
});

test('un module de la page lu avant la carte n\'est pas protégé même quand une autre balise, après la carte, en charge un autre', async () => {
  const a = await auditer({
    'index.html': page(`${MOD(`import "${U}";`)}${CARTE()}${MOD('/* rien */')}`),
  });
  assert.deepEqual(E(a).map((c) => `${c.ligne} ${etat(c)}`), ['2 critique bloquant']);
});

test('deux cartes : l\'entrée est déclarée dans la première, l\'empreinte n\'est que dans la seconde : l\'entrée n\'est pas protégée, l\'import qui suit les deux l\'est', async () => {
  const premiere = CARTE({}, { foo: U });
  const seconde = CARTE({ [U]: SRI });
  const a = await auditer({ 'index.html': page(`${premiere}${seconde}${MOD(`import "${U}";`)}`) });
  const entree = E(a).find((c) => c.extrait.startsWith('"foo"'));
  const chargement = E(a).find((c) => c.extrait.startsWith('import'));
  assert.equal(etat(entree), 'critique bloquant');
  assert.match(entree.constat, /n'est portée que par une import map lue après cette entrée \(ligne \d+\)/);
  assert.equal(etat(chargement), 'majeur', 'le module lu après les deux cartes est protégé par l\'empreinte de la seconde');
});

test('deux cartes, l\'empreinte dans la première : l\'entrée de la seconde est protégée', async () => {
  const a = await auditer({ 'index.html': page(`${CARTE({ [U]: SRI })}${CARTE({}, { foo: U })}`) });
  assert.deepEqual(E(a).map(etat), ['majeur']);
});

test('l\'entrée et son empreinte dans la même carte : protégée', async () => {
  const a = await auditer({ 'index.html': page(CARTE({ [U]: SRI }, { foo: U })) });
  assert.deepEqual(E(a).map(etat), ['majeur']);
});

// --- une balise <script type="module" src> vers le tiers : l'empreinte de la carte qui la précède s'applique quand la balise n'a aucun attribut `integrity`

test('un <script type="module" src> vers le tiers sans attribut integrity est protégé par la carte qui le précède', async () => {
  const a = await auditer({ 'index.html': page(`${CARTE()}<script type="module" src="${U}"></script>`) });
  const [c] = E(a);
  assert.deepEqual([E(a).length, etat(c)], [1, 'majeur']);
  assert.doesNotMatch(c.constat, /aucun contrôle d'intégrité/);
  assert.match(c.constat, /Son empreinte est portée par la clé `integrity` d'une import map de la page, lue avant cette balise\./);
});

test('un attribut integrity présent l\'emporte, même vide ou mal formé : la carte n\'est plus consultée (Chromium exécute le module)', async () => {
  for (const attribut of ['integrity=""', 'integrity="x"', 'integrity="md5-AAAA"', 'integrity']) {
    const a = await auditer({ 'index.html': page(`${CARTE()}<script type="module" src="${U}" ${attribut}></script>`) });
    assert.deepEqual(E(a).map(etat), ['critique bloquant'], attribut);
    assert.match(E(a)[0].constat, /aucun contrôle d'intégrité/, attribut);
  }
});

test('un attribut integrity bien formé protège sans carte', async () => {
  const a = await auditer({ 'index.html': page(`<script type="module" src="${U}" integrity="${SRI}" crossorigin="anonymous"></script>`) });
  assert.deepEqual(E(a).map(etat), ['majeur']);
});

test('un script classique n\'est jamais couvert par la carte', async () => {
  const a = await auditer({ 'index.html': page(`${CARTE()}<script src="${U}"></script>`) });
  assert.deepEqual(E(a).map(etat), ['critique bloquant']);
  assert.match(E(a)[0].constat, /aucun contrôle d'intégrité/);
});

test('une carte lue après la balise ne la protège pas, et le constat le dit avec les deux lignes', async () => {
  const a = await auditer({ 'index.html': page(`<script type="module" src="${U}"></script>\n${CARTE()}`) });
  assert.deepEqual(E(a).map(etat), ['critique bloquant']);
  assert.match(E(a)[0].constat, /aucun contrôle d'intégrité \(`integrity`\) sur la balise, et l'import map de la page qui porte l'empreinte de cette adresse \(ligne 2\) est lue après cette balise \(ligne 1\)/);
});

test('un type que seul le standard lit (` module `) ne reçoit rien de la carte : Chromium ne l\'exécute pas, on ne garantit rien de plus que l\'attribut', async () => {
  const a = await auditer({ 'index.html': page(`${CARTE()}<script type=" module " src="${U}"></script>`) });
  assert.deepEqual(E(a).map(etat), ['critique bloquant']);
  assert.match(E(a)[0].constat, /Précision : /);
});

test('la carte d\'une autre page ne couvre pas la balise de celle-ci', async () => {
  const a = await auditer({
    'manifest.json': JSON.stringify({ widgets: [{ url: 'index.html' }, { url: 'autre.html' }] }),
    'index.html': page(`${CARTE()}<script type="module" src="${U}"></script>`),
    'autre.html': page(`<script type="module" src="${U}"></script>`),
  });
  assert.deepEqual(E(a).map((c) => `${c.fichier} ${etat(c)}`).sort(), ['autre.html critique bloquant', 'index.html majeur']);
});

// --- le worker : rien n'y est protégé, et C-EXFIL-01 le dit comme E-DEP-01

test('un module que le worker exécute : critique et bloquant pour les deux règles, même avec la carte avant, avec le remède qui convient', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}${MOD('new Worker("w.js", { type: "module" });')}`),
    'w.js': `import "${U}";\n`,
  });
  assert.deepEqual(E(a).map(etat), ['critique bloquant']);
  assert.deepEqual(C(a).map(etat), ['critique bloquant']);
  for (const c of [E(a)[0], C(a)[0]]) assert.match(c.constat, /exécuté par un worker, où Chromium n'applique pas l'import map de la page/);
  for (const c of [E(a)[0], C(a)[0]]) assert.doesNotMatch(c.remediation, /déclarer son adresse dans la clé `integrity`|dans une import map avec `integrity`/, 'une empreinte ne protège rien dans un worker : ce n\'est pas le remède');
  assert.match(C(a)[0].remediation, /dans un worker, l'empreinte d'une import map ne s'applique pas/);
});

test('un worker d\'adresse calculée : l\'import protégé par la carte ne l\'est plus, chacune des raisons est dite', async () => {
  const code = `import "${U}";\nconst nom = ["w", "js"].join(".");\nnew Worker(nom, { type: "module" });`;
  const protege = await auditer({ 'index.html': page(`${CARTE()}${MOD(code)}`), 'w.js': 'self.postMessage(1);\n' });
  assert.deepEqual(E(protege).map(etat), ['critique bloquant']);
  assert.deepEqual(C(protege).map(etat), ['critique bloquant']);
  assert.match(E(protege)[0].constat, /le widget crée un worker dont l'adresse n'est pas résolue \(index\.html, ligne 4\)/);
  assert.doesNotMatch(E(protege)[0].constat, /aucune empreinte/, 'l\'empreinte est là, seul le worker empêche');
  assert.match(E(protege)[0].remediation, /écrire aussi l'adresse du worker en littéral/);

  const nue = await auditer({ 'index.html': page(MOD(code)), 'w.js': 'self.postMessage(1);\n' });
  assert.match(E(nue)[0].constat, /aucune empreinte dans la clé `integrity` d'une import map de la page qui le charge, le widget crée un worker dont l'adresse n'est pas résolue/, 'sans empreinte, les deux raisons sont dites : corriger l\'une seule ne suffirait pas');
});

test('C-EXFIL-01 ne touche qu\'aux chargements de code : un fetch vers le tiers reste critique et bloquant, carte ou pas', async () => {
  const a = await auditer({ 'index.html': page(`${CARTE()}${MOD(`fetch("${U}");`)}`) });
  assert.deepEqual(C(a).map(etat), ['critique bloquant']);
  assert.deepEqual(E(a), [], 'un fetch n\'est pas une dépendance chargée : E-DEP-01 n\'en dit rien');
});

test('le code littéral d\'un eval prend la balise de l\'appel : lu avant la carte il n\'est pas protégé, après elle il l\'est', async () => {
  const eval_ = `eval('import("${U}")');`;
  const avant = await auditer({ 'index.html': page(`${MOD(eval_)}${CARTE()}`) });
  assert.deepEqual(E(avant).map(etat), ['critique bloquant']);
  assert.match(E(avant)[0].constat, RAISON_TARDIVE);
  const apres = await auditer({ 'index.html': page(`${CARTE()}${MOD(eval_)}`) });
  assert.deepEqual(E(apres).map(etat), ['majeur']);
});

// --- le lecteur partagé

test('importsDistants : un seul parcours par contexte, refait quand l\'inventaire a gagné des fichiers, protection calculée à la demande et une fois', async () => {
  const a = await auditer({ 'index.html': page(`${CARTE()}${MOD(`import "${U}";`)}`) });
  const premier = importsDistants(a.ctx);
  assert.equal(importsDistants(a.ctx), premier, 'le même résultat tant que l\'inventaire ne change pas');
  assert.equal(premier.imports.length, 1);
  const [imp] = premier.imports;
  assert.deepEqual([imp.canal, imp.url.href, imp.ligne, imp.fichier.chemin], ['import statique', U, 2, 'index.html']);
  assert.equal(imp.protection(), imp.protection(), 'calculée une fois');
  assert.deepEqual(imp.protection(), { sri: true, raisons: [], obstacle: null });

  a.ctx.fichiers.push({ chemin: 'ajoute.js', contenu: `import "${U}";\n`, lignes: [], ext: '.js', binaire: false, executee: true, taille: 10 });
  const refait = importsDistants(a.ctx);
  assert.notEqual(refait, premier);
  assert.equal(refait.imports.length, 2, 'le fichier ajouté est lu');
});

test('importsDistants : un import d\'un fichier du widget n\'est pas retenu, celui d\'une autre origine l\'est (même sous une <base> qui ramène chez un tiers)', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}${MOD(`import "./local.js";\nimport "${U}";\nexport * from "../hors-dossier.js";\nimport("/absolu.js");`)}`),
    'local.js': `import "./autre.js";\nimport "${U}";\nexport { x } from "./autre.js";\nexport const y = import("./autre.js");\n`,
    'autre.js': 'export const x = 1;\n',
  });
  const { imports } = importsDistants(a.ctx);
  assert.deepEqual(imports.map((i) => [i.fichier.chemin, i.url.href]).sort(), [['index.html', U], ['local.js', U]], 'seules les adresses d\'une autre origine sont retenues');

  const sousBase = await auditer({ 'index.html': `<!doctype html><html lang="fr"><head><title>t</title><base href="https://tiers.example/"></head><body>${MOD('import "./local.js";')}</body></html>` });
  assert.deepEqual(importsDistants(sousBase.ctx).imports.map((i) => i.url.href), ['https://tiers.example/local.js'], 'un import relatif d\'un script de la page, sous une base externe, charge chez un tiers : il est retenu');
});

test('importsDistants : carteQuiProtege donne le décalage de la carte de la page qui porte l\'empreinte, undefined sinon', async () => {
  const contenu = page(`${CARTE({ 'https://cdn.example/a.js': SRI })}${CARTE({ [U]: SRI, 'https://cdn.example/b.js': 'x' })}`);
  const a = await auditer({ 'index.html': contenu });
  const { carteQuiProtege } = importsDistants(a.ctx);
  const index = a.fichier('index.html');
  const debutSeconde = contenu.indexOf('<script type="importmap">', contenu.indexOf('<script type="importmap">') + 1);
  assert.equal(carteQuiProtege(index, 'https://cdn.example/a.js'), contenu.indexOf('<script type="importmap">'));
  assert.equal(carteQuiProtege(index, U), debutSeconde);
  assert.equal(carteQuiProtege(index, 'https://cdn.example/b.js'), undefined, 'valeur mal formée : ne protège rien');
  assert.equal(carteQuiProtege(index, 'https://cdn.example/c.js'), undefined);
});

// --- le graphe du document : la position de la balise qui mène à chaque fichier

test('debutDeChargement : le décalage de la première balise de la page qui mène au fichier, Infinity sans balise qui le charge d\'elle-même, null hors du document', async () => {
  const contenu = page('<link rel="stylesheet" href="s.css"><script type="module" src="app.js"></script><script type="module" src="app.js"></script><script type="module" src="b.js"></script>');
  const a = await auditer({
    'index.html': contenu,
    'app.js': 'import "./c.js";\n',
    'c.js': 'export const c = 1;\n',
    'b.js': 'export const b = 1;\n',
    's.css': 'body{}\n',
    'orphelin.js': 'export const o = 1;\n',
  });
  const tag = (src) => contenu.indexOf(`<script type="module" src="${src}">`);
  assert.equal(a.ctx.debutDeChargement('index.html', 'app.js'), tag('app.js'), 'deux balises vers app.js : la première');
  assert.equal(a.ctx.debutDeChargement('index.html', 'c.js'), tag('app.js'), 'ce qu\'app.js importe prend la balise d\'app.js');
  assert.equal(a.ctx.debutDeChargement('index.html', 'b.js'), tag('b.js'));
  assert.equal(a.ctx.debutDeChargement('index.html', 's.css'), Infinity, 'une feuille n\'a pas de balise script : elle ne charge aucun module qu\'une empreinte protège');
  assert.equal(a.ctx.debutDeChargement('index.html', 'orphelin.js'), null, 'la page ne le charge pas');
  assert.equal(a.ctx.debutDeChargement('absente.html', 'app.js'), null);
});

test('debutDeChargement : la surface du document est exactement la page et ce dont elle donne une position', async () => {
  const a = await auditer({
    'index.html': page('<script type="module" src="app.js"></script><script>new Worker("w.js");</script>'),
    'app.js': 'import "./c.js";\n',
    'c.js': 'export const c = 1;\n',
    'w.js': 'importScripts("x.js");\n',
    'x.js': '/* worker */\n',
    'autre.html': page('<script src="y.js"></script>'),
    'y.js': '/* autre page */\n',
  });
  const surface = a.ctx.surfaceDuDocument('index.html');
  assert.deepEqual([...surface].sort(), ['app.js', 'c.js', 'index.html']);
  for (const chemin of surface) if (chemin !== 'index.html') assert.ok(Number.isFinite(a.ctx.debutDeChargement('index.html', chemin)) || a.ctx.debutDeChargement('index.html', chemin) === Infinity, chemin);
  for (const chemin of ['w.js', 'x.js', 'y.js']) assert.equal(a.ctx.debutDeChargement('index.html', chemin), null, `${chemin} n'est pas dans le document`);
});

test('un module que seule une balise <link> mène à charger n\'a pas de chargeur établi : l\'empreinte n\'est pas garantie, le constat le dit', async () => {
  const fichiers = { 'app.js': `import "${U}";\n` };
  const seul = await auditer({ 'index.html': page(`${CARTE()}<link rel="modulepreload" href="app.js">`), ...fichiers });
  assert.deepEqual(E(seul).map(etat), ['critique bloquant']);
  assert.match(E(seul)[0].constat, /aucune balise de la page ne peut être établie comme celle qui charge ce module/);
  assert.match(C(seul)[0].constat, /aucune balise de la page ne peut être établie comme celle qui charge ce module/);
  const avecBalise = await auditer({ 'index.html': page(`${CARTE()}<link rel="modulepreload" href="app.js"><script type="module" src="app.js"></script>`), ...fichiers });
  assert.deepEqual(E(avecBalise).map(etat), ['majeur'], 'la balise script, elle, est un chargeur : le <link> placé avant ne la remplace pas');
});

test('le code d\'un eval écrit sur la ligne même de la balise : la ligne de l\'appel suffit à trouver le script qui le porte', async () => {
  const sur = (avant, apres) => auditer({ 'index.html': page(`${avant}<script type="module">eval('import("${U}")');</script>${apres}`) });
  assert.deepEqual(E(await sur(CARTE(), '')).map(etat), ['majeur']);
  const avant = await sur('', CARTE());
  assert.deepEqual(E(avant).map(etat), ['critique bloquant']);
  assert.match(E(avant)[0].constat, RAISON_TARDIVE);
});

test('adressesProtegeesParEmpreinte : deux clés d\'une même carte vers la même adresse, la dernière s\'applique ; deux cartes, la première', async () => {
  const { adressesProtegeesParEmpreinte } = await import('../src/moteur/analyse-js.js');
  const HOTE_MAJ = U.replace('esm.sh', 'ESM.SH');
  const carte = (integrity) => `<script type="importmap">${JSON.stringify({ integrity })}</script>`;
  const protege = (contenu) => [...adressesProtegeesParEmpreinte(contenu, 'index.html').keys()].includes(U);
  assert.equal(protege(carte({ [U]: SRI, [HOTE_MAJ]: '' })), false, 'la dernière clé (vide) s\'applique');
  assert.equal(protege(carte({ [HOTE_MAJ]: '', [U]: SRI })), true, 'la dernière clé (empreinte) s\'applique');
  assert.equal(protege(`${carte({ [U]: '' })}${carte({ [U]: SRI })}`), false, 'la première carte s\'applique : sa valeur vide n\'est pas remplacée');
  assert.equal(protege(`${carte({ [U]: SRI })}${carte({ [U]: '' })}`), true, 'la première carte s\'applique : son empreinte tient');
  assert.equal(adressesProtegeesParEmpreinte(`${carte({ [U]: SRI })}${carte({ [U]: '' })}`, 'index.html').get(U), 0, 'le décalage est celui de la première carte');
});

test('le budget d\'arêtes des graphes de document : compté à l\'arête, épuisé sans rien blanchir', async () => {
  const fichiers = {
    'index.html': page(`${CARTE()}<script type="module" src="app.js"></script>`),
    'app.js': 'import "./c.js";\n',
    'c.js': `import "${U}";\n`,
  };
  await avecWidget(fichiers, {}, async (racine) => {
    const ctx = construireContexte(racine);
    assert.equal(ctx.pasDocuments(), 0, 'rien n\'est parcouru avant qu\'une règle ou un appel le demande');
    assert.ok(ctx.surfaceDuDocument('index.html'));
    assert.equal(ctx.pasDocuments(), 5, 'la page (1 arête + 1), app.js (1 + 1), c.js (0 + 1)');
    ctx.surfaceDuDocument('index.html');
    assert.equal(ctx.pasDocuments(), 5, 'un graphe déjà lu ne se recompte pas');
  });
  const normal = await auditer(fichiers);
  assert.deepEqual(E(normal).map(etat), ['majeur']);

  const epuise = await auditer(fichiers, { plafonds: { maxPasDocuments: 4 } });
  assert.deepEqual(E(epuise).map(etat), ['critique bloquant'], 'le graphe ne dit plus qui charge c.js : l\'empreinte n\'est plus garantie');
  assert.match(E(epuise)[0].constat, /aucune balise de la page ne peut être établie comme celle qui charge ce module/);
  assert.equal(epuise.ctx.surfaceDuDocument('index.html'), null);
  assert.equal(epuise.ctx.debutDeChargement('index.html', 'c.js'), null);

  const juste = await auditer(fichiers, { plafonds: { maxPasDocuments: 6 } });
  assert.deepEqual(E(juste).map(etat), ['majeur'], 'un budget qui suffit exactement suffit : 5 pas d\'arêtes, et la page évaluée pour l\'import');
  assert.equal(juste.ctx.pasDocuments(), 6);
  const presque = await auditer(fichiers, { plafonds: { maxPasDocuments: 5 } });
  assert.deepEqual(E(presque).map(etat), ['critique bloquant'], 'un pas de moins : rien n\'est blanchi');
});

test('une entrée locale d\'import map est une borne basse du chargement, jamais un chargeur postérieur : un module que l\'entrée peut avoir fait charger avant la carte d\'empreinte n\'est pas protégé', async () => {
  // Le module de la balise T0 (`import "lib"`) charge lib.js dès la première carte, avant que la seconde ne porte l'empreinte : la balise qui le nomme après ne change rien.
  const carteEntree = CARTE({}, { lib: './lib.js' });
  const carteEmpreinte = CARTE({ [U]: SRI });
  const contenu = page(`${carteEntree}${MOD('import "lib";')}${carteEmpreinte}<script type="module" src="lib.js"></script>`);
  const a = await auditer({ 'index.html': contenu, 'lib.js': `import "${U}";\n` });
  assert.deepEqual(E(a).filter((c) => c.fichier === 'lib.js').map(etat), ['critique bloquant']);
  assert.equal(a.ctx.debutDeChargement('index.html', 'lib.js'), contenu.indexOf('<script type="importmap">'), 'la position de lib.js est celle de la carte qui le nomme, la plus basse des balises qui y mènent');
  // Les deux cartes avant tout : l'empreinte précède ce que l'entrée peut charger.
  const avant = await auditer({
    'index.html': page(`${carteEmpreinte}${carteEntree}${MOD('import "lib";')}<script type="module" src="lib.js"></script>`),
    'lib.js': `import "${U}";\n`,
  });
  assert.deepEqual(E(avant).filter((c) => c.fichier === 'lib.js').map(etat), ['majeur']);
});

test('une page que la page lit par un <link> est dans son document, mais son graphe n\'est pas le sien', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}<link rel="prefetch" href="autre.html">`),
    'autre.html': page('<script type="module" src="y.js"></script>'),
    'y.js': `import "${U}";\n`,
  });
  assert.ok(a.ctx.surfaceDuDocument('index.html').has('autre.html'));
  assert.equal(a.ctx.debutDeChargement('index.html', 'autre.html'), Infinity);
  assert.equal(a.ctx.debutDeChargement('index.html', 'y.js'), null, 'ce que la page voisine charge est dans son document à elle');
  assert.ok(a.ctx.surface.has('y.js'), 'la surface, elle, y va');
});

test('un worker créé dans un module de la page n\'est pas dans le document de la page, ni ce qu\'il importe', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}<script type="module" src="app.js"></script>`),
    'app.js': 'new Worker("w2.js");\n',
    'w2.js': `import "${U}";\n`,
  });
  assert.deepEqual([...a.ctx.surfaceDuDocument('index.html')].sort(), ['app.js', 'index.html']);
  assert.deepEqual(E(a).map((c) => `${c.fichier} ${etat(c)}`), ['w2.js critique bloquant']);
});

test('un worker dont l\'adresse n\'est pas résolue, sous toutes ses formes : Worker, SharedWorker, service worker, worklet ; le constat nomme le premier', async () => {
  for (const [nom, appel] of [
    ['Worker', 'new Worker(nom);'],
    ['SharedWorker', 'new SharedWorker(nom);'],
    ['service worker', 'navigator.serviceWorker.register(nom);'],
    ['worklet', 'new AudioContext().audioWorklet.addModule(nom);'],
  ]) {
    const a = await auditer({ 'index.html': page(`${CARTE()}${MOD(`import "${U}";\nconst nom = ["w", "js"].join(".");\n${appel}`)}`) });
    assert.deepEqual(E(a).map(etat), ['critique bloquant'], nom);
    assert.match(E(a)[0].constat, /le widget crée un worker dont l'adresse n'est pas résolue \(index\.html, ligne 4\)/, nom);
  }
  const deux = await auditer({ 'index.html': page(`${CARTE()}${MOD(`import "${U}";\nconst nom = ["w", "js"].join(".");\nnew Worker(nom);\nnew Worker(nom + "2");`)}`) });
  assert.match(E(deux)[0].constat, /\(index\.html, ligne 4\)/, 'le premier des deux');
});

test('une page qu\'aucune balise ne charge n\'est pas un chargeur : sa carte manquante ne retire rien à la page qui charge le module', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}<script type="module" src="app.js"></script>`),
    'orpheline.html': page('<script type="module" src="app.js"></script>'),
    'app.js': `import "${U}";\n`,
  });
  assert.ok(!a.fichier('orpheline.html').executee, 'la page n\'est pas exécutée : personne ne l\'ouvre');
  assert.deepEqual(E(a).map(etat), ['majeur']);
});

test('deux pages qui chargent le module, l\'une sans empreinte, l\'autre avec une carte lue trop tard : c\'est l\'empreinte qui manque, dite comme telle', async () => {
  const a = await auditer({
    'manifest.json': JSON.stringify({ widgets: [{ url: 'index.html' }, { url: 'autre.html' }] }),
    'index.html': page(`<script type="module" src="app.js"></script>${CARTE()}`),
    'autre.html': page('<script type="module" src="app.js"></script>'),
    'app.js': `import "${U}";\n`,
  });
  assert.deepEqual(E(a).map(etat), ['critique bloquant']);
  assert.match(E(a)[0].constat, /aucune empreinte dans la clé `integrity` d'une import map de la page qui le charge\.$/);
  assert.doesNotMatch(E(a)[0].constat, /est lue après/);
});

test('un code littéral dont le fichier d\'origine est perdu ou qui tourne en rond n\'a aucun document : jamais protégé, et la lecture s\'arrête', () => {
  const synthetique = (chemin, origine) => ({ chemin, contenu: `import "${U}";\n`, lignes: [], ext: '.js', binaire: false, executee: true, litteralImbrique: true, origineReelle: { chemin: origine, ligne: 1 }, taille: 30 });
  const verdicts = (fichiers) => importsDistants({ fichiers }).imports.map((i) => i.protection());
  const [perdu] = verdicts([synthetique('a (code littéral, ligne 1)', 'introuvable.js')]);
  assert.deepEqual([perdu.sri, perdu.raisons.length], [false, 1]);
  const [rond] = verdicts([synthetique('a', 'b'), synthetique('b', 'a')]);
  assert.equal(rond.sri, false);
});

test('adressesProtegeesParEmpreinte et extraireImportMaps : une clé integrity qui n\'est pas un objet, une entrée qui n\'est pas une adresse, ne cassent rien et ne protègent rien', async () => {
  const { adressesProtegeesParEmpreinte, extraireImportMaps } = await import('../src/moteur/analyse-js.js');
  for (const integrity of [null, 'x', 12, [SRI], true]) {
    const contenu = `<script type="importmap">${JSON.stringify({ imports: { lib: U }, integrity })}</script>`;
    assert.deepEqual([...adressesProtegeesParEmpreinte(contenu, 'index.html')], [], JSON.stringify(integrity));
    assert.deepEqual(extraireImportMaps(contenu, 'index.html').map((e) => e.sri), [false], JSON.stringify(integrity));
  }
  const nue = `<script type="importmap">${JSON.stringify({ imports: { lib: 'lodash', autre: U }, integrity: { [U]: SRI } })}</script>`;
  assert.deepEqual(extraireImportMaps(nue, 'index.html').map((e) => [e.spec, e.sri]), [['lib', false], ['autre', true]], 'un nom nu n\'est pas une adresse : rien ne le protège, et rien ne casse');
});

// --- un <link rel="modulepreload"> vers l'adresse du module la charge à la balise : mesuré dans Chromium 141 (e-dep-imports-chromium.test.mjs, cas `modulepreload-*`)

const LIEN = (attributs = '', href = U) => `<link rel="modulepreload" href="${href}"${attributs}>`;
const RAISON_LIEN_AVANT = /l'import map de la page qui porte l'empreinte \(ligne (\d+)\) est lue après le `<link rel="modulepreload">` de cette adresse \(ligne (\d+)\)/;
const RAISON_LIEN_ATTRIBUT = /le `<link rel="modulepreload">` de cette adresse \(ligne (\d+)\) porte un attribut `integrity` vide ou mal formé/;

test('un lien modulepreload vers l\'adresse, lu avant la carte, charge le module sans l\'empreinte : E-DEP-01 et C-EXFIL-01 le disent, avec les deux lignes', async () => {
  const a = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${LIEN()}\n${CARTE()}`) });
  for (const [nom, constats] of [['E-DEP-01', E(a)], ['C-EXFIL-01', C(a)]]) {
    assert.deepEqual(constats.map(etat), ['critique bloquant'], nom);
    const [, ligneCarte, ligneLien] = RAISON_LIEN_AVANT.exec(constats[0].constat) ?? [];
    assert.deepEqual([ligneCarte, ligneLien], ['2', '1'], `${nom} : la carte est ligne 2, le lien ligne 1`);
    assert.match(constats[0].constat, /placer l'import map avant le lien, ou porter l'empreinte dans l'attribut `integrity` du lien/, nom);
  }
  const apres = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${CARTE()}${LIEN()}`) });
  assert.deepEqual(E(apres).map(etat), ['majeur']);
  assert.deepEqual(C(apres).map(etat), ['majeur']);
});

test('un lien modulepreload dont l\'attribut integrity est une empreinte bien formée vérifie lui-même son chargement : il ne brise rien, même avant la carte', async () => {
  const a = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${LIEN(` integrity="${SRI}"`)}${CARTE()}`) });
  assert.deepEqual(E(a).map(etat), ['majeur']);
  assert.deepEqual(C(a).map(etat), ['majeur']);
});

test('un lien modulepreload dont l\'attribut integrity est vide ou mal formé l\'emporte sur la carte, même lue avant lui : le module est chargé sans vérification', async () => {
  for (const attribut of ['', '="x"', '="md5-AAAAAAAAAAAAAAAAAAAAAA=="', '="sha384-"']) {
    const a = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${CARTE()}${LIEN(` integrity${attribut}`)}`) });
    assert.deepEqual(E(a).map(etat), ['critique bloquant'], attribut);
    assert.deepEqual(C(a).map(etat), ['critique bloquant'], attribut);
    assert.match(E(a)[0].constat, RAISON_LIEN_ATTRIBUT, attribut);
    assert.doesNotMatch(E(a)[0].constat, /est lue après/, `${attribut} : la carte est lue avant le lien, ce n'est pas le motif`);
  }
});

test('ce qui ne charge pas le module à sa balise ne brise rien : preload, prefetch, un autre module, un fichier local, un lien inerte', async () => {
  const autres = [
    ['preload as=script', '<link rel="preload" as="script" crossorigin href="' + U + '">'],
    ['preload as=fetch', '<link rel="preload" as="fetch" crossorigin href="' + U + '">'],
    ['prefetch', `<link rel="prefetch" href="${U}">`],
    ['un autre module', LIEN('', 'https://esm.sh/autre@1.0.0')],
    ['un fichier local', LIEN('', 'lib.js')],
    ['dans un template', `<template>${LIEN()}</template>`],
    ['modulepreload sans href', '<link rel="modulepreload">'],
  ];
  for (const [nom, lien] of autres) {
    const a = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${lien}${CARTE()}`), 'lib.js': '' });
    assert.deepEqual(E(a).filter((c) => c.constat.includes(U)).map(etat), ['majeur'], nom);
    assert.deepEqual(C(a).map(etat), ['majeur'], nom);
  }
});

test('l\'adresse du lien se résout comme Chromium la résout : contre la base du document, en majuscules d\'hôte, avec un segment point', async () => {
  const relatif = await auditer({ 'index.html': page(MOD(`import "${U}";`), `<base href="https://esm.sh/"><link rel="modulepreload" href="./foo@1.2.3">${CARTE()}`) });
  assert.deepEqual(E(relatif).map(etat), ['critique bloquant'], 'sous une <base> vers le tiers, « ./foo@1.2.3 » est l\'adresse du module');
  const hote = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${LIEN('', U.replace('esm.sh', 'ESM.SH'))}${CARTE()}`) });
  assert.deepEqual(E(hote).map(etat), ['critique bloquant'], 'hôte en capitales');
  const point = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${LIEN('', 'https://esm.sh/./foo@1.2.3')}${CARTE()}`) });
  assert.deepEqual(E(point).map(etat), ['critique bloquant'], 'segment point');
});

test('un lien modulepreload et une carte lue après le script qui charge : les deux raisons sont dites, corriger l\'une ne suffirait pas', async () => {
  const a = await auditer({ 'index.html': page(`${MOD(`import "${U}";`)}${LIEN()}${CARTE()}`) });
  assert.deepEqual(E(a).map(etat), ['critique bloquant']);
  assert.match(E(a)[0].constat, RAISON_TARDIVE);
  assert.match(E(a)[0].constat, RAISON_LIEN_AVANT);
});

test('un <script type="module" src> vers le tiers, après la carte : un lien modulepreload de la même adresse lu avant elle a déjà chargé le module', async () => {
  const balise = `<script type="module" src="${U}"></script>`;
  const brise = await auditer({ 'index.html': page(balise, `${LIEN()}\n${CARTE()}`) });
  assert.deepEqual(E(brise).map(etat), ['critique bloquant']);
  assert.match(E(brise)[0].constat, /aucun contrôle d'intégrité \(`integrity`\) sur la balise, et l'import map de la page qui porte l'empreinte \(ligne 2\) est lue après le `<link rel="modulepreload">` de cette adresse \(ligne 1\)/);
  const sain = await auditer({ 'index.html': page(balise, `${CARTE()}${LIEN()}`) });
  assert.deepEqual(E(sain).map(etat), ['majeur']);
  assert.match(E(sain)[0].constat, /Son empreinte est portée par la clé `integrity` d'une import map de la page, lue avant cette balise/);
  const attribut = await auditer({ 'index.html': page(balise, `${CARTE()}${LIEN(' integrity=""')}`) });
  assert.deepEqual(E(attribut).map(etat), ['critique bloquant']);
  assert.match(E(attribut)[0].constat, RAISON_LIEN_ATTRIBUT);
  const propre = await auditer({ 'index.html': page(balise, `${LIEN(` integrity="${SRI}"`)}${CARTE()}`) });
  assert.deepEqual(E(propre).map(etat), ['majeur'], 'l\'attribut bien formé du lien vérifie son chargement');
  const tardivePlusLien = await auditer({ 'index.html': page(`${balise}${CARTE()}`, LIEN()) });
  assert.match(E(tardivePlusLien)[0].constat, /est lue après cette balise \(ligne \d+\).*, et l'import map de la page qui porte l'empreinte \(ligne \d+\) est lue après le `<link rel="modulepreload">`/s);
});

test('une entrée d\'import map vers le tiers : un lien modulepreload lu avant la carte brise son empreinte, E-DEP-01 et C-EXFIL-03 le disent', async () => {
  const carte = CARTE({ [U]: SRI }, { foo: U });
  const brise = await auditer({ 'index.html': page(MOD('import "foo";'), `${LIEN()}\n${carte}`) });
  const entree = E(brise).filter((c) => c.extrait === `"foo": "${U}"`);
  assert.deepEqual(entree.map(etat), ['critique bloquant']);
  assert.match(entree[0].constat, RAISON_LIEN_AVANT);
  assert.doesNotMatch(entree[0].constat, /lue après cette entrée/, 'la carte est celle de l\'entrée : elle ne la suit pas');
  const deLEntree = (a) => a.de('C-EXFIL-03').filter((c) => c.extrait === `"foo": "${U}"`);       // le lien lui-même a son constat de préchargement (C-EXFIL-03, majeur), à part
  const c03 = deLEntree(brise);
  assert.deepEqual(c03.map(etat), ['critique bloquant']);
  assert.match(c03[0].constat, /la clé `integrity` d'une import map de la page porte une empreinte de cette adresse, qui ne la protège pourtant pas/);
  assert.match(c03[0].constat, RAISON_LIEN_AVANT);
  const sain = await auditer({ 'index.html': page(MOD('import "foo";'), `${carte}${LIEN()}`) });
  assert.deepEqual(E(sain).filter((c) => c.extrait === `"foo": "${U}"`).map(etat), ['majeur']);
  assert.deepEqual(deLEntree(sain).map(etat), ['majeur']);
  assert.match(deLEntree(sain)[0].constat, /couverte par la clé `integrity` de l'import map/);
  const sans = await auditer({ 'index.html': page(MOD('import "foo";'), CARTE({}, { foo: U })) });
  assert.match(deLEntree(sans)[0].constat, /sans empreinte `integrity` valide dans l'import map/);
});

// --- des garde-fous que les mutants du lot `mutants-e-dep-imports.mjs` exigent

test('une entrée d\'import map et l\'empreinte dans la même carte : la carte précède l\'import qui passe par l\'entrée, le module est protégé', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE({ [U]: SRI }, { lib: './lib.js' })}<script type="module" src="lib.js"></script>`),
    'lib.js': `import "${U}";\n`,
  });
  assert.deepEqual(E(a).filter((c) => c.fichier === 'lib.js').map(etat), ['majeur'], 'la position de lib.js est celle de la carte (l\'entrée le nomme) : l\'égalité protège');
  assert.deepEqual(C(a).filter((c) => c.fichier === 'lib.js').map(etat), ['majeur']);
});

test('une page qui en lit une autre par un <link> n\'est pas le document de ses scripts : sa carte manquante ne retire rien à la page qui porte les siens', async () => {
  const a = await auditer({
    'manifest.json': JSON.stringify({ widgets: [{ url: 'index.html' }, { url: 'autre.html' }] }),
    'index.html': page(MOD(`import "${U}";`), CARTE()),
    'autre.html': page('', '<link rel="prefetch" href="index.html">'),
  });
  assert.ok(a.ctx.surfaceDuDocument('autre.html').has('index.html'), 'la page voisine est dans le document de l\'autre');
  assert.deepEqual(E(a).map(etat), ['majeur']);
});

test('budget des arêtes de document épuisé : le chargeur est inconnu, jamais protégé, et la raison le dit (une ou plusieurs pages, carte au tout début)', async () => {
  const carteEnTete = CARTE();                                   // décalage 0 : `0 <= null` vaudrait vrai
  const unePage = await auditer({
    'index.html': `${carteEnTete}<script type="module" src="app.js"></script>`,
    'app.js': `import "${U}";\n`,
  }, { plafonds: { maxPasDocuments: 0 } });
  assert.equal(unePage.ctx.debutDeChargement('index.html', 'app.js'), null);
  assert.deepEqual(E(unePage).map(etat), ['critique bloquant']);
  assert.match(E(unePage)[0].constat, /aucune balise de la page ne peut être établie comme celle qui charge ce module/);
  const deuxPages = await auditer({
    'manifest.json': JSON.stringify({ widgets: [{ url: 'index.html' }, { url: 'autre.html' }] }),
    'index.html': `${carteEnTete}<script type="module" src="app.js"></script>`,
    'autre.html': `${carteEnTete}<script type="module" src="app.js"></script>`,
    'app.js': `import "${U}";\n`,
  }, { plafonds: { maxPasDocuments: 0 } });
  assert.deepEqual(E(deuxPages).map(etat), ['critique bloquant']);
  assert.match(E(deuxPages)[0].constat, /aucune balise de la page ne peut être établie comme celle qui charge ce module/, 'chaque page compte comme chargeur quand le graphe est inconnu');
});

test('une page que le widget ne contient pas n\'a pas de document : rien ne casse, aucun chargeur', async () => {
  const a = await auditer({ 'index.html': page('') });
  assert.equal(a.ctx.debutDeChargement('absente.html', 'app.js'), null);
  assert.doesNotThrow(() => a.ctx.surfaceDuDocument('absente.html'));
  assert.equal(a.ctx.surfaceDuDocument('absente.html').has('app.js'), false);
});

test('un littéral passé à eval dans un script écrit sur une seule ligne prend la balise qui couvre l\'appel : la première et la dernière ligne du script comptent', async () => {
  const code = `eval('import("${U}")');`;
  const avant = await auditer({ 'index.html': page(`<script type="module">${code}</script>`, CARTE()) });
  assert.deepEqual(E(avant).map(etat), ['majeur'], 'carte avant : le littéral de la ligne unique du script est couvert par ce script');
  const apres = await auditer({ 'index.html': page(`<script type="module">${code}</script>${CARTE()}`) });
  assert.deepEqual(E(apres).map(etat), ['critique bloquant'], 'carte après : le chargeur est ce script');
  assert.match(E(apres)[0].constat, RAISON_TARDIVE);
});

test('les remédiations disent ce qui protège vraiment : une import map avec integrity, le vendoring seul dans un worker, l\'adresse du worker à écrire en littéral', async () => {
  const normal = await auditer({ 'index.html': page(MOD(`import "${U}";`)) });
  assert.match(E(normal)[0].remediation, /déclarer son adresse dans la clé `integrity` d'une import map de la page/);
  assert.doesNotMatch(E(normal)[0].remediation, /worker/);
  assert.match(C(normal)[0].remediation, /le déclarer dans une import map avec `integrity`/);
  const worker = await auditer({ 'index.html': page(`${CARTE()}${MOD('new Worker("w.js");')}`), 'w.js': `import "${U}";\n` });
  assert.match(E(worker)[0].remediation, /c'est le seul moyen de le protéger dans un worker, où l'empreinte d'une import map ne s'applique pas/);
  assert.doesNotMatch(E(worker)[0].remediation, /clé `integrity`/);
  assert.match(C(worker)[0].remediation, /dans un worker, l'empreinte d'une import map ne s'applique pas/);
  const calcule = await auditer({ 'index.html': page(`${CARTE()}${MOD(`import "${U}";\nconst nom = ["w", "js"].join(".");\nnew Worker(nom);`)}`) });
  assert.match(E(calcule)[0].remediation, /écrire aussi l'adresse du worker en littéral \(`new Worker\('\.\/w\.js'\)`\), pour que l'audit établisse quel fichier il exécute/);
  assert.match(E(calcule)[0].remediation, /clé `integrity` d'une import map de la page/);
  const balise = await auditer({ 'index.html': page(`<script src="${U}"></script>`) });
  assert.match(E(balise)[0].remediation, /ajouter `integrity` et `crossorigin="anonymous"`/);
});

test('un script classique vers le tiers n\'est jamais couvert par la carte, une balise que seul le standard lit non plus ; un module sans attribut, si', async () => {
  const classique = await auditer({ 'index.html': page(`<script src="${U}"></script>`, CARTE()) });
  assert.deepEqual(E(classique).map(etat), ['critique bloquant']);
  assert.doesNotMatch(E(classique)[0].constat, /import map/);
  const module = await auditer({ 'index.html': page(`<script type="module" src="${U}"></script>`, CARTE()) });
  assert.deepEqual(E(module).map(etat), ['majeur']);
  const sansCarte = await auditer({ 'index.html': page(`<script type="module" src="${U}"></script>`) });
  assert.deepEqual(E(sansCarte).map(etat), ['critique bloquant']);
  assert.doesNotMatch(E(sansCarte)[0].constat, /import map/, 'aucune carte : le constat ne parle pas de carte');
  const standard = await auditer({ 'index.html': page(`<script type=" module " src="${U}"></script>`, CARTE()) });
  assert.deepEqual(E(standard).map(etat), ['critique bloquant'], 'Chromium n\'exécute pas cette balise : seul un navigateur qui suit le standard la lirait, rien n\'est garanti');
  assert.doesNotMatch(E(standard)[0].constat, /est lue après/);
  const attribut = await auditer({ 'index.html': page(`<script type="module" src="${U}" integrity=""></script>`, CARTE()) });
  assert.deepEqual(E(attribut).map(etat), ['critique bloquant']);
  assert.doesNotMatch(E(attribut)[0].constat, /import map/, 'l\'attribut présent l\'emporte : la carte n\'est pas consultée, et le constat ne parle pas de carte');
});

test('une valeur qui n\'est pas une chaîne ne nomme pas l\'adresse (mesuré dans Chromium 141) : la carte suivante, ou la clé suivante d\'une même carte, la protège', async () => {
  for (const [nom, contenu] of [
    ['null puis empreinte, deux cartes', `${CARTE({ [U]: null })}${CARTE()}`],
    ['nombre puis empreinte, deux cartes', `${CARTE({ [U]: 12 })}${CARTE()}`],
    ['null puis empreinte, deux clés', CARTE({ [U]: null, [U.replace('esm.sh', 'ESM.SH')]: SRI })],
    ['empreinte puis null, deux clés', CARTE({ [U]: SRI, [U.replace('esm.sh', 'ESM.SH')]: null })],
  ]) {
    const a = await auditer({ 'index.html': page(MOD(`import "${U}";`), contenu) });
    assert.deepEqual(E(a).map(etat), ['majeur'], nom);
  }
});

test('une carte qui n\'est pas un objet (null, nombre) n\'affirme rien et ne casse rien', async () => {
  for (const contenu of ['null', '12', '"x"', '[]']) {
    const a = await auditer({ 'index.html': page(MOD(`import "${U}";`), `<script type="importmap">${contenu}</script>`) });
    assert.deepEqual(E(a).map(etat), ['critique bloquant'], contenu);
  }
});

test('un lien modulepreload qui n\'a pas d\'adresse lisible, une image, une iframe ne cassent pas la lecture de la page', async () => {
  const a = await auditer({ 'index.html': page(`<img src="a.png"><iframe src="fille.html"></iframe><object data="o.bin"></object><embed src="e.bin">${MOD(`import "${U}";`)}`, `${LIEN('', 'http://[')}${LIEN('', 'https://')}${CARTE()}`), 'fille.html': page('') });
  assert.deepEqual(E(a).map(etat), ['majeur']);
});

test('deux liens modulepreload de la même adresse : celui qui brise l\'empreinte compte, même si un autre est placé après la carte', async () => {
  const a = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${LIEN()}${CARTE()}${LIEN()}`) });
  assert.deepEqual(E(a).map(etat), ['critique bloquant']);
  const attribut = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${CARTE()}${LIEN(` integrity="${SRI}"`)}${LIEN(' integrity=""')}`) });
  assert.deepEqual(E(attribut).map(etat), ['critique bloquant'], 'le second lien, sans empreinte valide, brise même après un premier lien sain');
});

test('un fichier que la page charge depuis un script écrit dedans prend la position de ce script, pas celle de la page ni de la carte', async () => {
  const lib = { 'lib.js': `import "${U}";\n` };
  const avant = await auditer({ 'index.html': page(`${CARTE()}${MOD('import("./lib.js");')}`), ...lib });
  assert.deepEqual(E(avant).filter((c) => c.fichier === 'lib.js').map(etat), ['majeur']);
  const apres = await auditer({ 'index.html': page(`${MOD('import("./lib.js");')}${CARTE()}`), ...lib });
  assert.deepEqual(E(apres).filter((c) => c.fichier === 'lib.js').map(etat), ['critique bloquant']);
  assert.match(E(apres).find((c) => c.fichier === 'lib.js').constat, RAISON_TARDIVE);
});

test('un dossier dont tout module peut être chargé (import() à préfixe) est dans le document : ses fichiers prennent la position de la balise qui y mène', async () => {
  const dossier = { 'lib/x.js': `import "${U}";\n` };
  // depuis un script écrit dans la page
  const page1 = await auditer({ 'index.html': page(`${CARTE()}${MOD('const n = location.hash; import("./lib/" + n);')}`), ...dossier });
  assert.deepEqual(E(page1).filter((c) => c.fichier === 'lib/x.js').map(etat), ['majeur']);
  const page2 = await auditer({ 'index.html': page(`${MOD('const n = location.hash; import("./lib/" + n);')}${CARTE()}`), ...dossier });
  assert.deepEqual(E(page2).filter((c) => c.fichier === 'lib/x.js').map(etat), ['critique bloquant']);
  // depuis un module de la page
  const fichier = await auditer({ 'index.html': page('<script type="module" src="app.js"></script>', CARTE()), 'app.js': 'const n = location.hash; import("./lib/" + n);\n', ...dossier });
  assert.deepEqual(E(fichier).filter((c) => c.fichier === 'lib/x.js').map(etat), ['majeur']);
  assert.ok(fichier.ctx.surfaceDuDocument('index.html').has('lib/x.js'));
});

test('le document d\'une page contient la page elle-même et les fichiers qu\'elle charge, jamais un fichier qui n\'est pas du code', async () => {
  const a = await auditer({ 'index.html': page('<script type="module" src="rien.png"></script><script type="module" src="app.js"></script>', CARTE()), 'rien.png': 'PNG\u0000\u0000\u0000', 'app.js': '' });
  const document = a.ctx.surfaceDuDocument('index.html');
  assert.ok(document.has('index.html'));
  assert.ok(document.has('app.js'));
  assert.equal(document.has('rien.png'), false, 'un fichier binaire n\'est pas un module : rien à y lire');
});

test('une clé integrity qui n\'est pas une adresse (nom nu, texte) ne protège rien et ne casse rien ; les autres clés de la carte protègent encore', async () => {
  const a = await auditer({ 'index.html': page(MOD(`import "${U}";`), CARTE({ lodash: SRI, 'pas une adresse': SRI, [U]: SRI })) });
  assert.deepEqual(E(a).map(etat), ['majeur']);
  const sans = await auditer({ 'index.html': page(MOD(`import "${U}";`), CARTE({ lodash: SRI })) });
  assert.deepEqual(E(sans).map(etat), ['critique bloquant']);
});

test('un contexte construit à la main, sans graphe de document : le chargeur d\'un fichier .js est inconnu, la carte de la page ne le garantit pas', () => {
  const fichier = (chemin, contenu, ext) => ({ chemin, contenu, lignes: contenu.split('\n'), ext, binaire: false, executee: true, taille: contenu.length });
  const ctx = { fichiers: [fichier('index.html', `${CARTE()}<script type="module" src="app.js"></script>`, '.html'), fichier('app.js', `import "${U}";\n`, '.js')] };
  const [import1] = importsDistants(ctx).imports;
  assert.equal(import1.fichier.chemin, 'app.js');
  const { sri, raisons } = import1.protection();
  assert.equal(sri, false);
  assert.deepEqual(raisons, ["aucune balise de la page ne peut être établie comme celle qui charge ce module : l'empreinte de l'import map ne peut pas être garantie"]);
});

test('un fichier exécuté par un worker et un autre worker d\'adresse inconnue : l\'obstacle est le worker connu, la remédiation ne demande pas d\'écrire l\'adresse de l\'autre', async () => {
  const a = await auditer({
    'index.html': page(`${CARTE()}${MOD('new Worker("w.js");\nconst nom = ["x", "js"].join(".");\nnew Worker(nom);')}`),
    'w.js': `import "${U}";\n`,
  });
  const dew = E(a).filter((c) => c.fichier === 'w.js');
  assert.deepEqual(dew.map(etat), ['critique bloquant']);
  assert.match(dew[0].remediation, /c'est le seul moyen de le protéger dans un worker/);
  assert.doesNotMatch(dew[0].remediation, /écrire aussi l'adresse du worker/);
  assert.doesNotMatch(dew[0].constat, /adresse n'est pas résolue/, 'exécuté par un worker : une seule raison est vraie');
  assert.match(dew[0].constat, /exécuté par un worker, où Chromium n'applique pas l'import map de la page/);
});

test('une entrée d\'import map vers le tiers sans aucune empreinte : le constat dit qu\'il n\'y a aucun contrôle d\'intégrité', async () => {
  const a = await auditer({ 'index.html': page(MOD('import "foo";'), CARTE({}, { foo: U })) });
  const entree = E(a).filter((c) => c.extrait === `"foo": "${U}"`);
  assert.deepEqual(entree.map(etat), ['critique bloquant']);
  assert.match(entree[0].constat, /aucun contrôle d'intégrité \(`integrity`\)/);
  assert.doesNotMatch(entree[0].constat, /est lue après/);
});

test('le budget des arêtes de document se compte au fichier près : une page sans arête coûte 1, le budget de 1 la lit, le budget de 0 la refuse', async () => {
  const fichiers = { 'index.html': page('') };
  const juste = await auditer(fichiers, { plafonds: { maxPasDocuments: 1 } });
  assert.notEqual(juste.ctx.surfaceDuDocument('index.html'), null, 'le budget juste suffit');
  assert.equal(juste.ctx.pasDocuments(), 1);
  const vide = await auditer(fichiers, { plafonds: { maxPasDocuments: 0 } });
  assert.equal(vide.ctx.surfaceDuDocument('index.html'), null, 'le budget épuisé donne un document inconnu, non vide');
});

test('un lien sans attribut placé après la carte ne brise rien, mais un lien à attribut vide ou mal formé qui le suit, si : c\'est le premier de ceux-là qui est dit', async () => {
  const seul = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${CARTE()}\n${LIEN()}`) });
  assert.deepEqual(E(seul).map(etat), ['majeur']);
  const a = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${CARTE()}\n${LIEN()}\n${LIEN(' integrity=""')}\n${LIEN(' integrity="x"')}`) });
  assert.deepEqual(E(a).map(etat), ['critique bloquant']);
  assert.match(E(a)[0].constat, /le `<link rel="modulepreload">` de cette adresse \(ligne 3\) porte un attribut `integrity` vide ou mal formé/, 'ligne 1 : la page ; 2 : la carte ; 3 : le premier lien à attribut mal formé ; 4 : le second');
  const avant = await auditer({ 'index.html': page(MOD(`import "${U}";`), `${LIEN()}\n${CARTE()}\n${LIEN(' integrity=""')}`) });
  assert.match(E(avant)[0].constat, RAISON_LIEN_AVANT, 'le lien lu avant la carte est le premier qui brise l\'empreinte');
});

test('le chargeur d\'un littéral passé à eval est le script qui couvre la ligne de l\'appel, parmi plusieurs scripts de la page', async () => {
  const eval1 = `eval('import("${U}")');`;
  const scripts = (avantB, apresB) => page(`${MOD('/* a */')}${avantB}${MOD(eval1)}${apresB}${MOD('/* c */')}`);
  const avant = await auditer({ 'index.html': scripts(CARTE(), '') });
  assert.deepEqual(E(avant).map(etat), ['majeur'], 'carte avant le script B qui porte l\'eval');
  const apres = await auditer({ 'index.html': scripts('', CARTE()) });
  assert.deepEqual(E(apres).map(etat), ['critique bloquant'], 'carte entre le script B et le script C : B charge avant elle');
  const dernier = await auditer({ 'index.html': page(`${MOD('/* a */')}${MOD('/* b */')}${CARTE()}${MOD(eval1)}`) });
  assert.deepEqual(E(dernier).map(etat), ['majeur'], 'l\'appel est dans le dernier script, la carte le précède');
});

test('une ligne d\'appel que aucun script de la page ne couvre n\'a pas de chargeur : jamais protégée', () => {
  const contenu = ['<!doctype html>', `<script type="importmap">${JSON.stringify({ integrity: { [U]: SRI } })}</script>`, '<script type="module">/* a */</script>', '', '<script type="module">/* b */</script>'].join('\n');
  const fichier = (chemin, texte, ext, plus = {}) => ({ chemin, contenu: texte, lignes: texte.split('\n'), ext, binaire: false, executee: true, taille: texte.length, ...plus });
  const ctx = { fichiers: [
    fichier('index.html', contenu, '.html'),
    fichier('index.html (code littéral, ligne 4)', `import "${U}";\n`, '.js', { litteralImbrique: true, origineReelle: { chemin: 'index.html', ligne: 4 } }),
  ] };
  const [import1] = importsDistants(ctx).imports;
  const { sri, raisons } = import1.protection();
  assert.equal(sri, false, 'la ligne 4 est entre deux scripts : rien ne dit quelle balise charge');
  assert.match(raisons[0], /aucune balise de la page ne peut être établie comme celle qui charge ce module/);
});

const MANIFEST_DEUX_PAGES = JSON.stringify({ widgets: [{ url: 'p1.html' }, { url: 'p2.html' }] });   // les pages se lisent dans l'ordre des chemins

test('chaque page évaluée pour un import est un pas du budget des documents ; une même adresse importée deux fois par un même fichier n\'en coûte qu\'un', async () => {
  const deux = await auditer({
    'index.html': page(`${CARTE()}<script type="module" src="app.js"></script>`),
    'app.js': `import "${U}";\nimport "${U}";\n`,
  });
  assert.deepEqual(E(deux).map(etat), ['majeur', 'majeur']);
  assert.equal(deux.ctx.pasDocuments(), 4, 'le graphe : la page (1 arête + 1) et app.js (0 + 1) ; puis un seul import évalué, le second lit le même état');
  const autres = await auditer({
    'index.html': page(`${CARTE({ [U]: SRI, 'https://esm.sh/autre@1.0.0': SRI })}<script type="module" src="app.js"></script>`),
    'app.js': `import "${U}";\nimport "https://esm.sh/autre@1.0.0";\n`,
  });
  assert.equal(autres.ctx.pasDocuments(), 5, 'deux adresses, deux évaluations');
  const differentes = await auditer({
    'index.html': page(`${CARTE()}<script type="module" src="app.js"></script>`),
    'app.js': `import "${U}";\nimport "https://esm.sh/autre@1.0.0";\n`,
  });
  assert.deepEqual(E(differentes).map(etat).sort(), ['critique bloquant', 'majeur'], 'un même fichier : une adresse protégée, l\'autre non, chacune son état');
  const deuxFichiers = await auditer({
    'index.html': page(`${CARTE()}<script type="module" src="app.js"></script><script type="module" src="b.js"></script>`),
    'app.js': `import "${U}";\n`,
    'b.js': `import "${U}";\n`,
  });
  assert.equal(deuxFichiers.ctx.pasDocuments(), 7, 'le graphe : la page (2 arêtes + 1), app.js (1), b.js (1) ; deux fichiers, deux évaluations');
  const sansBudget = await auditer({ 'index.html': page(`${CARTE()}${MOD(`import "${U}";`)}`) });
  assert.equal(sansBudget.ctx.pasDocuments(), 1, 'un import écrit dans la page : aucun graphe à lire, une page évaluée');
});

test('la première page sans empreinte dit le verdict à elle seule : les suivantes ne sont pas évaluées', async () => {
  const fichiers = (premiere, seconde) => ({
    'manifest.json': MANIFEST_DEUX_PAGES,
    'p1.html': `${premiere}<script type="module" src="app.js"></script>`,
    'p2.html': `${seconde}<script type="module" src="app.js"></script>`,
    'app.js': `import "${U}";\n`,
  });
  const sansPuisAvec = await auditer(fichiers('', CARTE()));
  assert.deepEqual(E(sansPuisAvec).map(etat), ['critique bloquant']);
  assert.match(E(sansPuisAvec)[0].constat, /aucune empreinte dans la clé `integrity` d'une import map de la page qui le charge/);
  assert.equal(sansPuisAvec.ctx.pasDocuments(), 7, 'les deux graphes (3 pas chacun) et une seule page évaluée');
  const avecPuisSans = await auditer(fichiers(CARTE(), ''));
  assert.deepEqual(E(avecPuisSans).map(etat), ['critique bloquant']);
  assert.equal(avecPuisSans.ctx.pasDocuments(), 8, 'la première page a une empreinte : il faut lire la seconde pour savoir qu\'elle n\'en a pas');
});

test('le budget épuisé pendant les évaluations : les imports déjà évalués gardent leur verdict, les suivants sont inconnus, non protégés, et la raison dit le budget', async () => {
  const V = 'https://esm.sh/autre@1.0.0';
  const fichiers = {
    'index.html': page(`${CARTE({ [U]: SRI, [V]: SRI })}<script type="module" src="app.js"></script>`),
    'app.js': `import "${U}";\nimport "${V}";\n`,
  };
  const assez = await auditer(fichiers, { plafonds: { maxPasDocuments: 5 } });
  assert.deepEqual(E(assez).map(etat), ['majeur', 'majeur'], 'le graphe (3) et deux évaluations (2) : 5 pas suffisent');
  const un = await auditer(fichiers, { plafonds: { maxPasDocuments: 4 } });
  const parAdresse = (a) => Object.fromEntries(E(a).map((c) => [c.constat.match(/`(https:[^`]+)`/)[1], c]));
  assert.equal(etat(parAdresse(un)[U]), 'majeur', 'le premier import a eu son pas');
  assert.equal(etat(parAdresse(un)[V]), 'critique bloquant', 'le second n\'en a plus : rien n\'est blanchi');
  assert.match(parAdresse(un)[V].constat, /le budget d'analyse des documents est épuisé \(trop de pages d'entrée qui partagent trop de modules\) : ce chargement est compté comme non protégé/);
  assert.match(parAdresse(un)[V].constat, /aucune balise de la page ne peut être établie comme celle qui charge ce module/, 'la raison du chargeur inconnu reste dite, avec sa cause');
  assert.equal(un.ctx.pasDocuments(), 5, 'le pas refusé est compté : le budget reste épuisé');
  assert.deepEqual(C(un).map((c) => [c.extrait, etat(c)]).sort(), [[V, 'critique bloquant'], [U, 'majeur']], 'C-EXFIL-01 dit la même chose : le premier import est protégé, le second est compté comme non protégé');
});

test('les pages qui chargent un fichier se lisent dans l\'ordre des pages, celles dont le graphe est inconnu comprises, et une page qui ne l\'atteint pas n\'en est pas une', () => {
  const fichier = (chemin, contenu, ext) => ({ chemin, contenu, lignes: contenu.split('\n'), ext, binaire: false, executee: true, taille: contenu.length });
  const balise = '<script type="module" src="app.js"></script>';
  const tardive = (n) => `\n${balise}\n${'\n'.repeat(n)}${CARTE()}`;                  // la carte, à la ligne n + 3, après la balise (ligne 2)
  const pages = [fichier('p0.html', tardive(0), '.html'), fichier('p1.html', tardive(0), '.html'), fichier('p2.html', tardive(4), '.html'), fichier('p3.html', '', '.html')];
  const positions = { 'p0.html': pages[0].contenu.indexOf(balise), 'p2.html': pages[2].contenu.indexOf(balise) };
  const ctx = {
    fichiers: [...pages, fichier('app.js', `import "${U}";\n`, '.js')],
    surfaceDuDocument: (chemin) => ({ 'p0.html': new Set(['p0.html', 'app.js']), 'p1.html': null, 'p2.html': new Set(['p2.html', 'app.js']), 'p3.html': new Set(['p3.html']) })[chemin],
    debutDeChargement: (chemin) => positions[chemin] ?? null,
  };
  const { sri, raisons } = importsDistants(ctx).imports[0].protection();
  assert.equal(sri, false);
  assert.equal(raisons.length, 1);
  const [, ligneCarte, ligneChargeur] = raisons[0].match(RAISON_TARDIVE);
  assert.deepEqual([Number(ligneCarte), Number(ligneChargeur)], [3, 2], 'la première page de la liste est p0, pas la page au graphe inconnu ni la dernière');
  const sansLaPremiere = { ...ctx, surfaceDuDocument: (chemin) => (chemin === 'p0.html' ? new Set(['p0.html']) : ctx.surfaceDuDocument(chemin)) };
  assert.deepEqual(importsDistants(sansLaPremiere).imports[0].protection().raisons, [RAISON_CHARGEUR_INCONNU], 'sans p0, c\'est p1 (graphe inconnu) qui vient avant p2 : son chargeur est inconnu');
});

test('le budget épuisé à la seconde page : la première avait une empreinte, l\'import n\'est pas dit protégé pour autant', async () => {
  const fichiers = {
    'manifest.json': MANIFEST_DEUX_PAGES,
    'p1.html': `${CARTE()}<script type="module" src="app.js"></script>`,
    'p2.html': `${CARTE()}<script type="module" src="app.js"></script>`,
    'app.js': `import "${U}";\n`,
  };
  const assez = await auditer(fichiers, { plafonds: { maxPasDocuments: 8 } });
  assert.deepEqual(E(assez).map(etat), ['majeur'], 'les deux graphes (3 pas chacun) et les deux pages évaluées (2) : 8 pas suffisent');
  assert.equal(assez.ctx.pasDocuments(), 8);
  const presque = await auditer(fichiers, { plafonds: { maxPasDocuments: 7 } });
  assert.deepEqual(E(presque).map(etat), ['critique bloquant'], 'la seconde page n\'a pas été évaluée : rien n\'est blanchi');
  assert.match(E(presque)[0].constat, /le budget d'analyse des documents est épuisé/);
  assert.deepEqual(C(presque).map(etat), ['critique bloquant'], 'C-EXFIL-01 dit la même chose');
});

test('un contexte sans graphe de document : chaque page compte comme chargeur d\'un fichier .js, la page qui n\'a pas d\'empreinte le dit', () => {
  const fichier = (chemin, contenu, ext) => ({ chemin, contenu, lignes: contenu.split('\n'), ext, binaire: false, executee: true, taille: contenu.length });
  const ctx = { fichiers: [
    fichier('p1.html', `${CARTE()}<script type="module" src="app.js"></script>`, '.html'),
    fichier('p2.html', '<script type="module" src="app.js"></script>', '.html'),
    fichier('app.js', `import "${U}";\n`, '.js'),
  ] };
  const { sri, raisons } = importsDistants(ctx).imports[0].protection();
  assert.equal(sri, false);
  assert.deepEqual(raisons, [RAISON_SANS_EMPREINTE]);
});
