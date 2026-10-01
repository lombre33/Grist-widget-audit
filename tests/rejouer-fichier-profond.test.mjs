/**
 * `scripts/rejouer-fichier-profond.mjs` : le rejeu, lancement après lancement, de l'audit d'un fichier `x=>{` empilé derrière
 * widget-exemple. Ce que V8 fait d'un code trop profond varie d'un lancement à l'autre (le code se lit, la lecture lève, le processus
 * est arrêté) : les essais ne comparent aucun de ces comptes à une valeur écrite. Ils éprouvent ce que le script juge, sur des
 * arbres factices dont la fin de chaque lancement est décidée d'avance : un rapport complet qui n'a ni le témoin planté au cœur du
 * fichier ni C-SURFACE-03 est un silence, à toute profondeur, l'abandon du processus n'en est pas un (sauf avec `--sans-abandon`, qui
 * l'interdit : le rejeu d'un arbre qui porte le correctif de la lecture), une sortie 3 est un plantage, un lancement qui ne finit pas est
 * un délai, et le code de sortie du script suit. Les arbres factices disent aussi comment l'audit a été lancé (fil principal ou
 * Worker, pile, options) ; deux lancements réels, à un niveau que la pile porte, éprouvent le fil principal et l'enveloppe Worker.
 * Chaque essai a son mutant dans `scripts/mutants-lecture-qui-leve.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TEMOIN, SANS_CAUSE, fichierProfond, diraitIllisible, aVuLeTemoin, classer, causeDAbandon, rejouer, tableau } from '../scripts/rejouer-fichier-profond.mjs';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(RACINE, 'scripts', 'rejouer-fichier-profond.mjs');

const constatDe = (extra) => ({ regle: 'C-SURFACE-03', severite: 'critique', bloquant: true, ...extra });
const rapportAvec = (...constats) => ({ axes: { A: { constats: [] }, C: { constats } } });
/** Ce que C-EXFIL-01 dit du témoin planté au cœur du fichier. */
const temoinDe = (extra) => ({ regle: 'C-EXFIL-01', severite: 'critique', bloquant: true, titre: `Requête réseau sortante vers un service externe : ${TEMOIN}`, ...extra });

test('le fichier empile « x=>{ » N fois, le témoin au cœur, puis « } » N fois, sur une seule ligne', () => {
  assert.equal(fichierProfond(3), `x=>{x=>{x=>{fetch("https://${TEMOIN}/")}}}`);
  assert.equal(fichierProfond(0), `fetch("https://${TEMOIN}/")`);
  assert.equal(fichierProfond(20_000).length, 100_000 + fichierProfond(0).length);
  assert.doesNotMatch(fichierProfond(50), /\n/);
  assert.match(TEMOIN, /\.invalid$/, 'un domaine réservé (RFC 2606) : le témoin ne résout jamais');
});

test('un rapport porte le témoin quand un C-EXFIL-01 nomme l\'hôte planté au cœur du fichier, sur un axe quelconque', () => {
  assert.equal(aVuLeTemoin(rapportAvec(temoinDe({}))), true);
  assert.equal(aVuLeTemoin({ axes: { E: { constats: [temoinDe({})] } } }), true, 'sur n\'importe quel axe');
  assert.equal(aVuLeTemoin(rapportAvec(temoinDe({ titre: 'x', extrait: `https://${TEMOIN}/` }))), true, 'l\'hôte peut n\'être que dans l\'extrait');
  assert.equal(aVuLeTemoin(rapportAvec(temoinDe({ titre: 'Requête réseau sortante vers un service externe : cdn.exemple.fr' }))), false, 'un autre hôte n\'est pas le témoin');
  assert.equal(aVuLeTemoin(rapportAvec(temoinDe({ regle: 'C-EXFIL-02' }))), false, 'une autre règle non plus');
  assert.equal(aVuLeTemoin(rapportAvec(constatDe({ titre: TEMOIN }))), false, 'un C-SURFACE-03 qui cite l\'hôte non plus');
  assert.equal(aVuLeTemoin(rapportAvec()), false);
  assert.equal(aVuLeTemoin({ axes: {} }), false);
  assert.equal(aVuLeTemoin({ axes: { C: {} } }), false, 'un axe sans constats');
  assert.equal(aVuLeTemoin(null), false);
});

test('un rapport dit un code illisible quand il porte un C-SURFACE-03 critique ET bloquant, sur un axe quelconque', () => {
  assert.equal(diraitIllisible(rapportAvec(constatDe({}))), true);
  assert.equal(diraitIllisible({ axes: { E: { constats: [constatDe({})] } } }), true, 'sur n\'importe quel axe');
  assert.equal(diraitIllisible(rapportAvec(constatDe({ bloquant: false }))), false, 'un constat qui ne bloque pas ne dit pas un code non lu');
  assert.equal(diraitIllisible(rapportAvec(constatDe({ severite: 'info' }))), false, 'l\'information d\'un fichier qu\'aucune page n\'exécute non plus');
  assert.equal(diraitIllisible(rapportAvec(constatDe({ regle: 'C-SURFACE-02' }))), false, 'un autre constat non plus');
  assert.equal(diraitIllisible(rapportAvec()), false);
  assert.equal(diraitIllisible({ axes: {} }), false);
  assert.equal(diraitIllisible({ axes: { C: {} } }), false, 'un axe sans constats');
  assert.equal(diraitIllisible(null), false);
});

test('la fin d\'un lancement : délai, abandon, plantage, autre, dit, lu, silence', () => {
  const dit = rapportAvec(constatDe({}));
  const vu = rapportAvec(temoinDe({}));
  const muet = rapportAvec();
  const cas = [
    ['le lancement n\'a pas fini à temps', { status: null, signal: 'SIGTERM', rapport: null, delai: true }, 'delai'],
    ['un délai avant tout code de sortie, même sans signal', { status: null, signal: null, rapport: null, delai: true }, 'delai'],
    ['un délai n\'est pas un abandon, même avec un rapport', { status: 1, signal: null, rapport: dit, delai: true }, 'delai'],
    ['abandon sous Linux (SIGABRT : code 134)', { status: 134, signal: null, rapport: null }, 'abandon'],
    ['abandon par un signal', { status: null, signal: 'SIGABRT', rapport: null }, 'abandon'],
    ['abandon sous Windows (code de 128 ou plus)', { status: 3_221_226_505, signal: null, rapport: null }, 'abandon'],
    ['le premier code que l\'outil n\'a pas : 128', { status: 128, signal: null, rapport: null }, 'abandon'],
    ['un lancement sans code de sortie ni signal : le processus n\'a pas fini de lui-même', { status: null, signal: null, rapport: null }, 'abandon'],
    ['l\'outil a planté (sortie 3)', { status: 3, signal: null, rapport: null }, 'plantage'],
    ['sortie 3 même avec un rapport', { status: 3, signal: null, rapport: dit }, 'plantage'],
    ['cible refusée (sortie 4) : pas une fin connue', { status: 4, signal: null, rapport: null }, 'autre'],
    ['sortie 4 même avec un rapport : pas une fin connue', { status: 4, signal: null, rapport: dit }, 'autre'],
    ['erreur du Worker (sortie 97)', { status: 97, signal: null, rapport: null }, 'autre'],
    ['l\'outil a fini sans rapport', { status: 1, signal: null, rapport: null }, 'autre'],
    ['C-SURFACE-03 bloquant, NON CONFORME (sortie 2)', { status: 2, signal: null, rapport: dit }, 'dit'],
    ['C-SURFACE-03 bloquant ET le témoin : l\'audit le dit', { status: 2, signal: null, rapport: rapportAvec(constatDe({}), temoinDe({})) }, 'dit'],
    ['le témoin dans le rapport : une règle a lu le code jusqu\'au cœur', { status: 2, signal: null, rapport: vu }, 'lu'],
    ['le témoin, sortie 1', { status: 1, signal: null, rapport: vu }, 'lu'],
    ['un rapport complet sans le témoin ni C-SURFACE-03 : le code n\'a pas été lu et personne ne le dit', { status: 1, signal: null, rapport: muet }, 'silence'],
    ['sortie 0 (conforme) sans le témoin : un silence aussi', { status: 0, signal: null, rapport: muet }, 'silence'],
    ['l\'information d\'un fichier non exécuté n\'est pas une lecture dite', { status: 1, signal: null, rapport: rapportAvec(constatDe({ severite: 'info', bloquant: false })) }, 'silence'],
    ['un C-EXFIL-01 qui nomme un autre hôte n\'est pas le témoin', { status: 2, signal: null, rapport: rapportAvec(temoinDe({ titre: 'Requête réseau sortante vers un service externe : cdn.exemple.fr' })) }, 'silence'],
  ];
  for (const [nom, lancement, attendu] of cas) assert.equal(classer(lancement), attendu, nom);
});

// ---------------------------------------------------------------------------
// Des arbres factices : `bin/gwaudit.js` y termine comme le scénario le veut, et dit comment il a été lancé.
// ---------------------------------------------------------------------------

/**
 * Écrit un arbre de l'outil factice (fixtures/widget-exemple, bin/gwaudit.js) : le lancement finit comme `scenario` le dit (`lit` : le
 * rapport porte le témoin ; `muet` : un rapport complet qui ne dit rien ; `dit` : C-SURFACE-03 bloquant ; ...), et inscrit
 * dans `trace` son nom, la taille de `app.js`, le fil où il tourne (`principal` ou `worker`), la pile du Worker (`-` au fil
 * principal) et ses options, à raison d'une ligne par lancement.
 */
function arbreFactice(parent, nom, scenario, trace = null) {
  const arbre = path.join(parent, nom);
  fs.mkdirSync(path.join(arbre, 'fixtures', 'widget-exemple'), { recursive: true });
  fs.mkdirSync(path.join(arbre, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(arbre, 'package.json'), '{ "type": "module" }\n');
  fs.writeFileSync(path.join(arbre, 'fixtures', 'widget-exemple', 'app.js'), 'var a = 1;\n');
  fs.writeFileSync(path.join(arbre, 'fixtures', 'widget-exemple', 'index.html'), '<script src="app.js"></script>\n');
  fs.writeFileSync(path.join(arbre, 'bin', 'gwaudit.js'), `import fs from 'node:fs';
import path from 'node:path';
import { isMainThread, resourceLimits } from 'node:worker_threads';
const args = process.argv.slice(2);
const sortie = args[args.indexOf('--sortie') + 1];
const widget = args[0];
const scenario = ${JSON.stringify(scenario)};
const trace = ${JSON.stringify(trace)};
const temoin = ${JSON.stringify(TEMOIN)};
if (trace) fs.appendFileSync(trace, [${JSON.stringify(nom)}, fs.statSync(path.join(widget, 'app.js')).size, isMainThread ? 'principal' : 'worker', resourceLimits.stackSizeMb ?? '-', ...args.filter((a) => a.startsWith('--'))].join(' ') + '\\n');
const rapport = (constats) => { fs.mkdirSync(sortie, { recursive: true }); fs.writeFileSync(path.join(sortie, 'rapport.json'), JSON.stringify({ axes: { C: { constats } } })); };
const illisible = { regle: 'C-SURFACE-03', severite: 'critique', bloquant: true };
if (scenario === 'lit') { rapport([{ regle: 'C-EXFIL-01', severite: 'critique', bloquant: true, titre: 'Requête réseau sortante vers un service externe : ' + temoin }]); process.exitCode = 2; }
else if (scenario === 'muet') { rapport([]); process.exitCode = 1; }
else if (scenario === 'dit') { rapport([illisible]); process.exitCode = 2; }
else if (scenario === 'info') { rapport([{ ...illisible, severite: 'info', bloquant: false }]); process.exitCode = 1; }
else if (scenario === 'abandon') process.exit(134);
else if (scenario === 'abandon-v8') { console.error('FATAL ERROR: RegExpCompiler Allocation failed - process out of memory'); process.exit(134); }
else if (scenario === 'abandon-alterne') {
  const compteur = path.join(import.meta.dirname, 'compteur');
  const k = fs.existsSync(compteur) ? Number(fs.readFileSync(compteur, 'utf8')) : 0;
  fs.writeFileSync(compteur, String(k + 1));
  console.error(k % 3 === 2 ? 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory' : 'FATAL ERROR: RegExpCompiler Allocation failed - process out of memory');
  process.exit(134);
}
else if (scenario === 'abandon-vide') { console.error('FATAL ERROR: '); process.exit(134); }
else if (scenario === 'lit-bruyant') { console.error('FATAL ERROR: RegExpCompiler Allocation failed - process out of memory'); rapport([{ regle: 'C-EXFIL-01', severite: 'critique', bloquant: true, titre: 'Requête réseau sortante vers un service externe : ' + temoin }]); process.exitCode = 2; }
else if (scenario === 'lit-volumineux') { for (let i = 0; i < 48; i++) fs.writeSync(2, 'x'.repeat(65535) + '\\n'); rapport([{ regle: 'C-EXFIL-01', severite: 'critique', bloquant: true, titre: 'Requête réseau sortante vers un service externe : ' + temoin }]); process.exitCode = 2; }
else if (scenario === 'plante') { console.error('Erreur : boom'); process.exitCode = 3; }
else if (scenario === 'refuse') process.exitCode = 4;
else if (scenario === 'boucle') setInterval(() => {}, 1000);
else process.exitCode = 1;
`);
  return arbre;
}

async function avecArbres(suite) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-rejeu-essai-'));
  try { return await suite(parent); } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}

const FINS = ['lu', 'dit', 'abandon', 'silence', 'plantage', 'autre', 'delai'];
const pris = (ligne) => Object.fromEntries(FINS.map((f) => [f, ligne[f]]));
/** Les comptes d'une ligne du tableau, dont seules les fins nommées sont non nulles. */
const comptes = (non_nuls) => Object.fromEntries(FINS.map((f) => [f, non_nuls[f] ?? 0]));
const OPTIONS = ['--sans-dynamique', '--sans-reseau', '--sans-html', '--json', '--sortie'];
const lignesDeTrace = (trace) => fs.readFileSync(trace, 'utf8').trim().split('\n').map((l) => l.split(' '));

for (const regime of ['principal', 'worker']) {
  test(`rejouer, en régime ${regime} : chaque fin de lancement est comptée à sa place, et seuls le silence, le plantage, la sortie inconnue et le délai sont interdits`, () => avecArbres((parent) => {
    const cas = [
      ['lit', 20_000, { lu: 3 }, 0],
      ['lit', 1_400, { lu: 3 }, 0],
      ['muet', 20_000, { silence: 3 }, 3],
      ['muet', 1_400, { silence: 3 }, 3],
      ['muet', 100, { silence: 3 }, 3],
      ['dit', 20_000, { dit: 3 }, 0],
      ['info', 20_000, { silence: 3 }, 3],
      ['abandon', 20_000, { abandon: 3 }, 0],
      ['plante', 20_000, { plantage: 3 }, 3],
      ['refuse', 20_000, { autre: 3 }, 3],
      ['sans-rapport', 20_000, { autre: 3 }, 3],
    ];
    for (const [scenario, niveaux, attendu, interdites] of cas) {
      const arbre = arbreFactice(parent, `arbre-${scenario}-${niveaux}`, scenario);
      const r = rejouer({ niveaux: [niveaux], essais: 3, regime, arbres: [arbre] });
      assert.equal(r.lignes.length, 1);
      assert.deepEqual(pris(r.lignes[0]), comptes(attendu), `${scenario} à ${niveaux} niveaux`);
      assert.equal(r.lignes[0].essais, 3);
      assert.equal(r.lignes[0].niveaux, niveaux);
      assert.equal(r.interdites, interdites, `${scenario} à ${niveaux} niveaux : fins interdites`);
    }
  }));
}

test('rejouer, avec `sansAbandon` : l\'arrêt par V8 devient une fin interdite, et aucune autre fin ne change de sens ni n\'est comptée deux fois', () => avecArbres((parent) => {
  const cas = [
    ['abandon', { abandon: 3 }, 3],
    ['lit', { lu: 3 }, 0],
    ['dit', { dit: 3 }, 0],
    ['muet', { silence: 3 }, 3],
    ['plante', { plantage: 3 }, 3],
    ['refuse', { autre: 3 }, 3],
  ];
  for (const regime of ['principal', 'worker']) {
    for (const [scenario, attendu, interdites] of cas) {
      const arbre = arbreFactice(parent, `sans-abandon-${regime}-${scenario}`, scenario);
      const r = rejouer({ niveaux: [20_000], essais: 3, regime, arbres: [arbre], sansAbandon: true });
      assert.deepEqual(pris(r.lignes[0]), comptes(attendu), `${scenario} (${regime})`);
      assert.equal(r.interdites, interdites, `${scenario} (${regime}) : fins interdites`);
    }
  }
  const abandon = arbreFactice(parent, 'abandon-seul', 'abandon');
  assert.equal(rejouer({ niveaux: [20_000], essais: 2, regime: 'principal', arbres: [abandon], sansAbandon: false }).interdites, 0, 'sans l\'option, l\'abandon reste une fin permise');
  assert.equal(rejouer({ niveaux: [20_000], essais: 2, regime: 'principal', arbres: [abandon] }).interdites, 0, 'l\'option est facultative');
  const dit = arbreFactice(parent, 'dit-seul', 'dit');
  const deux = rejouer({ niveaux: [20_000], essais: 2, regime: 'principal', arbres: [abandon, dit], sansAbandon: true });
  assert.deepEqual(deux.lignes.map((l) => [path.basename(l.arbre), l.abandon, l.dit]), [['abandon-seul', 2, 0], ['dit-seul', 0, 2]]);
  assert.equal(deux.interdites, 2, 'seuls les lancements de l\'arbre qui s\'abandonne comptent');
}));

test('causeDAbandon : la ligne « FATAL ERROR » de V8, sans son préfixe ni ses blancs, coupée à cent vingt caractères ; null quand V8 n\'en a dit aucune', () => {
  const regexp = 'RegExpCompiler Allocation failed - process out of memory';
  const tas = 'Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory';
  assert.equal(causeDAbandon(`FATAL ERROR: ${regexp}\n ----- Native stack trace -----\n\n 1: 0x1234 node::Abort()`), regexp);
  assert.equal(causeDAbandon(`FATAL ERROR: ${tas}\n`), tas);
  assert.equal(causeDAbandon(`un avertissement\nFATAL ERROR: ${regexp}\r\nla suite`), regexp, 'précédée d\'autres lignes, terminée par un retour chariot');
  assert.equal(causeDAbandon(`FATAL ERROR: ${regexp}  \t \n`), regexp, 'les blancs de fin ne sont pas la cause');
  assert.equal(causeDAbandon(`FATAL ERROR: première\nFATAL ERROR: seconde\n`), 'première', 'la première ligne');
  assert.equal(causeDAbandon(`FATAL ERROR: ${'x'.repeat(120)}`), 'x'.repeat(120), 'cent vingt caractères : entière');
  assert.equal(causeDAbandon(`FATAL ERROR: ${'x'.repeat(121)}`), 'x'.repeat(120), 'cent vingt et un : coupée');
  assert.equal(causeDAbandon(`FATAL ERROR: ${'x'.repeat(5000)}\n`).length, 120);
  assert.equal(causeDAbandon('FATAL ERROR: \n'), '', 'un message vide est une cause vide, que le tableau ne garde pas');
  for (const rien of ['', 'Erreur : boom', 'fatal error: minuscules', 'FATAL ERROR:collé', '# Fatal error in , line 0', null, undefined]) assert.equal(causeDAbandon(rien), null, String(rien));
});

test('rejouer : chaque abandon compte sa cause, celle que V8 a dite, « aucun message de V8 » quand il n\'en a dit aucune, et seuls les abandons ont des causes', () => avecArbres((parent) => {
  const regexp = 'RegExpCompiler Allocation failed - process out of memory';
  const tas = 'Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory';
  const cas = [
    ['abandon-v8', { abandon: 3 }, { [regexp]: 3 }],
    ['abandon', { abandon: 3 }, { [SANS_CAUSE]: 3 }],
    ['abandon-vide', { abandon: 3 }, { [SANS_CAUSE]: 3 }],
    ['abandon-alterne', { abandon: 3 }, { [regexp]: 2, [tas]: 1 }],
    ['lit-bruyant', { lu: 3 }, {}],
    ['lit', { lu: 3 }, {}],
    ['dit', { dit: 3 }, {}],
    ['muet', { silence: 3 }, {}],
    ['plante', { plantage: 3 }, {}],
    ['refuse', { autre: 3 }, {}],
  ];
  for (const regime of ['principal', 'worker']) {
    for (const [scenario, fins, causes] of cas) {
      const arbre = arbreFactice(parent, `causes-${regime}-${scenario}`, scenario);
      const r = rejouer({ niveaux: [20_000], essais: 3, regime, arbres: [arbre] });
      assert.deepEqual(pris(r.lignes[0]), comptes(fins), `${scenario} (${regime})`);
      assert.deepEqual(r.lignes[0].causes, causes, `${scenario} (${regime}) : causes`);
    }
  }
  // Un arbre par ligne : chaque arbre compte ses causes, non celles d'un autre ; chaque niveau les siennes.
  const a = arbreFactice(parent, 'cause-a', 'abandon-v8');
  const b = arbreFactice(parent, 'cause-b', 'abandon');
  const deux = rejouer({ niveaux: [1_400, 20_000], essais: 2, regime: 'principal', arbres: [a, b] });
  assert.deepEqual(deux.lignes.map((l) => [path.basename(l.arbre), l.niveaux, l.causes]), [
    ['cause-a', 1_400, { [regexp]: 2 }], ['cause-b', 1_400, { [SANS_CAUSE]: 2 }],
    ['cause-a', 20_000, { [regexp]: 2 }], ['cause-b', 20_000, { [SANS_CAUSE]: 2 }],
  ]);
}));

test('rejouer : une sortie d\'erreur de plusieurs Mio ne fait pas échouer le lancement : il se lit, il n\'est ni arrêté ni compté en abandon', () => avecArbres((parent) => {
  const arbre = arbreFactice(parent, 'volumineux', 'lit-volumineux');
  const r = rejouer({ niveaux: [20_000], essais: 2, regime: 'principal', arbres: [arbre], sansAbandon: true });
  assert.deepEqual(pris(r.lignes[0]), comptes({ lu: 2 }));
  assert.deepEqual(r.lignes[0].causes, {});
  assert.equal(r.interdites, 0);
}));

test('rejouer : un lancement qui ne finit pas dans le temps donné est arrêté et compté en délai (interdit), non en abandon', () => avecArbres((parent) => {
  const arbre = arbreFactice(parent, 'boucle', 'boucle');
  const r = rejouer({ niveaux: [20_000], essais: 2, regime: 'principal', arbres: [arbre], delaiMs: 700 });
  assert.deepEqual(pris(r.lignes[0]), comptes({ delai: 2 }));
  assert.equal(r.interdites, 2);
}));

test('rejouer : l\'audit lance le fichier profond du niveau demandé, à chaque niveau, derrière le widget d\'exemple de l\'arbre', () => avecArbres((parent) => {
  const trace = path.join(parent, 'trace.txt');
  const arbre = arbreFactice(parent, 'a', 'lit', trace);
  rejouer({ niveaux: [10, 1_000], essais: 2, regime: 'principal', arbres: [arbre] });
  const temoin = fichierProfond(0).length;
  assert.deepEqual(lignesDeTrace(trace).map((l) => Number(l[1])), [50 + temoin, 50 + temoin, 5_000 + temoin, 5_000 + temoin], 'app.js fait 5 caractères par niveau et le témoin, pour chaque lancement du niveau');
}));

test('rejouer : l\'audit est lancé sans navigateur ni réseau, rapport JSON dans un dossier de sortie, dans le fil principal ou dans un Worker dont la pile est celle qu\'on donne', () => avecArbres((parent) => {
  const trace = path.join(parent, 'trace.txt');
  const arbre = arbreFactice(parent, 'a', 'lit', trace);
  rejouer({ niveaux: [10], essais: 1, regime: 'principal', arbres: [arbre] });
  rejouer({ niveaux: [10], essais: 1, regime: 'worker', arbres: [arbre] });
  rejouer({ niveaux: [10], essais: 1, regime: 'worker', pileMb: 2, arbres: [arbre] });
  const taille = String(50 + fichierProfond(0).length);
  assert.deepEqual(lignesDeTrace(trace), [
    ['a', taille, 'principal', '-', ...OPTIONS],
    ['a', taille, 'worker', '4', ...OPTIONS],
    ['a', taille, 'worker', '2', ...OPTIONS],
  ]);
}));

test('rejouer : plusieurs arbres sont lancés en alternance, un lancement de chacun à tour de rôle, et comptés chacun à part', () => avecArbres((parent) => {
  const trace = path.join(parent, 'trace.txt');
  const avant = arbreFactice(parent, 'avant', 'muet', trace);
  const apres = arbreFactice(parent, 'apres', 'dit', trace);
  const r = rejouer({ niveaux: [20_000, 500], essais: 3, regime: 'principal', arbres: [avant, apres] });
  assert.deepEqual(lignesDeTrace(trace).map((l) => l[0]), ['avant', 'apres', 'avant', 'apres', 'avant', 'apres', 'avant', 'apres', 'avant', 'apres', 'avant', 'apres']);
  assert.deepEqual(r.lignes.map((l) => [path.basename(l.arbre), l.niveaux, l.silence, l.dit, l.lu]), [['avant', 20_000, 3, 0, 0], ['apres', 20_000, 0, 3, 0], ['avant', 500, 3, 0, 0], ['apres', 500, 0, 3, 0]]);
  assert.equal(r.interdites, 6);
}));

test('le tableau dit, par niveau (et par arbre s\'il y en a plusieurs), les comptes de chaque fin', () => {
  const lignes = [{ arbre: '/x/avant', niveaux: 20_000, essais: 21, lu: 5, dit: 3, abandon: 6, silence: 1, plantage: 2, autre: 4, delai: 7 }];
  const seul = tableau(lignes, { plusieursArbres: false }).split('\n');
  assert.equal(seul.length, 2);
  assert.match(seul[0], /niveaux \| lancements \|\s+lu \| dit \| abandon \| silence \| plantage \| autre \| delai$/);
  assert.match(seul[1], /^\s+20000 \|\s+21 \|\s+5 \|\s+3 \|\s+6 \|\s+1 \|\s+2 \|\s+4 \|\s+7$/);
  const plusieurs = tableau(lignes, { plusieursArbres: true }).split('\n');
  assert.match(plusieurs[0], /^arbre\s+niveaux/);
  assert.match(plusieurs[1], /^avant\s+20000 \|/);
});

test('le tableau dit aussi, sous les comptes, la cause de chaque abandon : une ligne par cause, avec le nom de l\'arbre quand il y en a plusieurs ; aucune quand il n\'y en a pas', () => {
  const fins = { lu: 0, dit: 0, silence: 0, plantage: 0, autre: 0, delai: 0 };
  const lignes = [
    { arbre: '/x/avant', niveaux: 1_700, essais: 10, ...fins, lu: 4, abandon: 6, causes: { 'RegExpCompiler Allocation failed - process out of memory': 5, [SANS_CAUSE]: 1 } },
    { arbre: '/x/apres', niveaux: 1_700, essais: 10, ...fins, lu: 10, abandon: 0, causes: {} },
    { arbre: '/x/avant', niveaux: 20_000, essais: 10, ...fins, dit: 10, abandon: 0, causes: {} },
  ];
  const seul = tableau(lignes.slice(0, 1), { plusieursArbres: false }).split('\n');
  assert.equal(seul.length, 6, 'l\'en-tête, la ligne, un blanc, le titre des causes, deux causes');
  assert.equal(seul[2], '', 'un blanc sépare les comptes des causes');
  assert.deepEqual(seul.slice(3), [
    'Causes des abandons (la ligne « FATAL ERROR » de V8) :',
    '  1700 niveaux : 5 × RegExpCompiler Allocation failed - process out of memory',
    `  1700 niveaux : 1 × ${SANS_CAUSE}`,
  ]);
  const plusieurs = tableau(lignes, { plusieursArbres: true }).split('\n').slice(5);
  assert.deepEqual(plusieurs, [
    'Causes des abandons (la ligne « FATAL ERROR » de V8) :',
    '  avant, 1700 niveaux : 5 × RegExpCompiler Allocation failed - process out of memory',
    `  avant, 1700 niveaux : 1 × ${SANS_CAUSE}`,
  ]);
  assert.equal(tableau(lignes.slice(1), { plusieursArbres: true }).split('\n').length, 3, 'sans abandon, pas de ligne de causes');
});

// ---------------------------------------------------------------------------
// La ligne de commande.
// ---------------------------------------------------------------------------

const lancer = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000 });

test('la ligne de commande sort en code 1 sur un silence, dit pourquoi, et en code 0 quand aucun lancement n\'a fini d\'une fin interdite', () => avecArbres((parent) => {
  const muet = arbreFactice(parent, 'muet', 'muet');
  const r = lancer(`--arbre=${muet}`, '--niveaux=20000', '--essais=2');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /20000 \|\s+2 \|\s+0 \|\s+0 \|\s+0 \|\s+2 \|/);
  assert.match(r.stdout, /2 lancement\(s\) ont fini d'une fin qui ne doit pas exister/);
  const dit = arbreFactice(parent, 'dit', 'dit');
  const bon = lancer(`--arbre=${dit}`, '--niveaux=20000,1400', '--essais=2');
  assert.equal(bon.status, 0, bon.stdout + bon.stderr);
  assert.match(bon.stdout, /Aucune fin interdite/);
  const abandon = arbreFactice(parent, 'abandon', 'abandon');
  assert.equal(lancer(`--arbre=${abandon}`, '--niveaux=20000', '--essais=1').status, 0, 'un abandon n\'est pas un silence : c\'est l\'enfant qui l\'isole');
  const plante = arbreFactice(parent, 'plante', 'plante');
  assert.equal(lancer(`--arbre=${plante}`, '--niveaux=20000', '--essais=1').status, 1, 'une sortie 3 est un plantage');
  const peuProfond = lancer(`--arbre=${muet}`, '--niveaux=50', '--essais=1');
  assert.equal(peuProfond.status, 1, 'un niveau que la pile lit sans peine n\'excuse pas un rapport sans témoin : c\'est un silence à toute profondeur');
  assert.match(peuProfond.stdout, /\n\s+50 \|\s+1 \|\s+0 \|\s+0 \|\s+0 \|\s+1 \|/);
  const lit = arbreFactice(parent, 'lit', 'lit');
  assert.equal(lancer(`--arbre=${lit}`, '--niveaux=20000,50', '--essais=1').status, 0, 'le témoin dans le rapport : le code a été lu, à toute profondeur');
  const trace = path.join(parent, 'trace.txt');
  const enWorker = arbreFactice(parent, 'enWorker', 'dit', trace);
  const worker = lancer(`--arbre=${enWorker}`, '--niveaux=20', '--essais=1', '--regime=worker', '--pile-mb=3.5');
  assert.equal(worker.status, 0, worker.stdout + worker.stderr);
  assert.match(worker.stdout, /\s+20 \|\s+1 \|\s+0 \|\s+1 \|/);
  assert.deepEqual(lignesDeTrace(trace), [['enWorker', String(100 + fichierProfond(0).length), 'worker', '3.5', ...OPTIONS]], 'le régime et la pile demandés sont ceux du lancement');
  const deux = lancer(`--arbre=${muet}`, `--arbre=${dit}`, '--niveaux=20000', '--essais=1');
  assert.equal(deux.status, 1, deux.stdout + deux.stderr);
  const lignes = deux.stdout.split('\n');
  assert.match(lignes[0], /^arbre\s+niveaux \|/);
  assert.match(lignes[1], /^muet\s+20000 \|\s+1 \|\s+0 \|\s+0 \|\s+0 \|\s+1 \|/);
  assert.match(lignes[2], /^dit\s+20000 \|\s+1 \|\s+0 \|\s+1 \|/);
}));

test('la ligne de commande, avec `--sans-abandon`, sort en code 1 quand V8 arrête un lancement et le dit, et en code 0 quand aucun lancement n\'est arrêté', () => avecArbres((parent) => {
  const abandon = arbreFactice(parent, 'abandon', 'abandon');
  const r = lancer(`--arbre=${abandon}`, '--niveaux=20000', '--essais=2', '--sans-abandon');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /20000 \|\s+2 \|\s+0 \|\s+0 \|\s+2 \|\s+0 \|/);
  assert.match(r.stdout, /2 lancement\(s\) ont fini d'une fin qui ne doit pas exister/);
  assert.match(r.stdout, /abandon : le processus a été arrêté par V8/);
  const avant = lancer('--sans-abandon', `--arbre=${abandon}`, '--niveaux=20000', '--essais=1');
  assert.equal(avant.status, 1, 'l\'option se place où l\'on veut dans la ligne');
  const sans = lancer(`--arbre=${abandon}`, '--niveaux=20000', '--essais=2');
  assert.equal(sans.status, 0, 'sans l\'option, l\'abandon reste permis');
  assert.match(sans.stdout, /Aucune fin interdite : chaque lancement a lu le code, l'a dit \(C-SURFACE-03 bloquant\) ou a été arrêté par V8\./);
  assert.doesNotMatch(sans.stdout, /abandon : le processus a été arrêté/);
  const dit = arbreFactice(parent, 'dit', 'dit');
  const bon = lancer(`--arbre=${dit}`, '--niveaux=20000,1400', '--essais=2', '--sans-abandon');
  assert.equal(bon.status, 0, bon.stdout + bon.stderr);
  assert.match(bon.stdout, /Aucune fin interdite : chaque lancement a lu le code ou l'a dit \(C-SURFACE-03 bloquant\), aucun n'a été arrêté par V8\./);
  const muet = arbreFactice(parent, 'muet', 'muet');
  const silence = lancer(`--arbre=${muet}`, '--niveaux=20', '--essais=1', '--sans-abandon');
  assert.equal(silence.status, 1, silence.stdout + silence.stderr);
  assert.match(silence.stdout, /1 lancement\(s\) ont fini d'une fin qui ne doit pas exister \(silence : .* delai : pas fini à temps ; abandon : le processus a été arrêté par V8\)\./);
  const deux = lancer(`--arbre=${abandon}`, `--arbre=${dit}`, '--niveaux=20000', '--essais=1', '--sans-abandon');
  assert.equal(deux.status, 1, deux.stdout + deux.stderr);
  assert.match(deux.stdout, /\n1 lancement\(s\) ont fini/);
}));

test('la ligne de commande dit la cause de chaque abandon sous le tableau, avec ou sans `--sans-abandon`, et n\'en dit aucune quand aucun lancement n\'est arrêté', () => avecArbres((parent) => {
  const v8 = arbreFactice(parent, 'v8', 'abandon-v8');
  for (const options of [[], ['--sans-abandon']]) {
    const r = lancer(`--arbre=${v8}`, '--niveaux=20000', '--essais=2', ...options);
    assert.equal(r.status, options.length ? 1 : 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\nCauses des abandons \(la ligne « FATAL ERROR » de V8\) :\n {2}20000 niveaux : 2 × RegExpCompiler Allocation failed - process out of memory\n/);
  }
  const sans = arbreFactice(parent, 'sans', 'abandon');
  assert.match(lancer(`--arbre=${sans}`, '--niveaux=20000', '--essais=1').stdout, /\n {2}20000 niveaux : 1 × aucun message de V8\n/);
  const lit = arbreFactice(parent, 'lit', 'lit');
  assert.doesNotMatch(lancer(`--arbre=${lit}`, '--niveaux=20000', '--essais=1').stdout, /Causes des abandons/);
}));

test('la ligne de commande, sans `--arbre`, rejoue l\'arbre qui la porte : un vrai lancement de l\'audit, à 40 niveaux', () => {
  const r = lancer('--niveaux=40', '--essais=1');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^\s+niveaux \| lancements \|/);
  assert.match(r.stdout, /\n\s+40 \|\s+1 \|\s+1 \|\s+0 \|\s+0 \|\s+0 \|\s+0 \|\s+0 \|\s+0\n/);
});

test('la ligne de commande, sans option, rejoue 1 400, 1 700 et 20 000 niveaux, dix lancements de chacun, dans le fil principal, et tient pour un silence tout rapport sans le témoin ni C-SURFACE-03, à chaque niveau', () => avecArbres((parent) => {
  const trace = path.join(parent, 'trace.txt');
  const muet = arbreFactice(parent, 'muet', 'muet', trace);
  const r = lancer(`--arbre=${muet}`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const lignes = r.stdout.split('\n');
  assert.match(lignes[1], /^\s+1400 \|\s+10 \|\s+0 \|\s+0 \|\s+0 \|\s+10 \|/);
  assert.match(lignes[2], /^\s+1700 \|\s+10 \|\s+0 \|\s+0 \|\s+0 \|\s+10 \|/);
  assert.match(lignes[3], /^\s+20000 \|\s+10 \|\s+0 \|\s+0 \|\s+0 \|\s+10 \|/);
  assert.match(r.stdout, /30 lancement\(s\) ont fini d'une fin qui ne doit pas exister/);
  const lances = lignesDeTrace(trace);
  assert.equal(lances.length, 30);
  assert.ok(lances.every((l) => l[2] === 'principal' && l[3] === '-'), 'le fil principal, non un Worker');
}));

test('la ligne de commande refuse en code 2 une option inconnue ou fausse, et dit l\'usage', () => avecArbres((parent) => {
  const arbre = arbreFactice(parent, 'a', 'lit');
  const sansBin = path.join(parent, 'sans-bin');
  fs.mkdirSync(path.join(sansBin, 'fixtures', 'widget-exemple'), { recursive: true });
  const sansFixture = path.join(parent, 'sans-fixture');
  fs.mkdirSync(path.join(sansFixture, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sansFixture, 'bin', 'gwaudit.js'), '');
  // Une option qui passerait le contrôle ne doit lancer qu'un essai sur un arbre factice : le refus se juge vite, non après un vrai rejeu.
  const refuse = (args, motif) => {
    const sans = (nom, defaut) => (args.some((a) => a.startsWith(`--${nom}=`)) ? [] : [defaut]);
    const r = lancer(...args, ...sans('arbre', `--arbre=${arbre}`), ...sans('niveaux', '--niveaux=5'), ...sans('essais', '--essais=1'));
    assert.equal(r.status, 2, `${args.join(' ')} : ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, motif, args.join(' '));
    assert.match(r.stderr, /Usage : node scripts\/rejouer-fichier-profond\.mjs/);
    assert.match(r.stderr, /\[--sans-abandon\]$/m, 'l\'usage dit l\'option qui interdit l\'abandon');
    assert.equal(r.stdout, '', 'rien n\'est lancé');
  };
  refuse(['--bidon=1'], /Option inconnue : --bidon=1/);
  refuse(['--sans-abandon=1'], /Option inconnue : --sans-abandon=1/); // un drapeau, non une option à valeur : une valeur qu'on ignorerait en silence est refusée
  refuse(['--sans-abandons'], /Option inconnue : --sans-abandons/);
  refuse([`--arbre=${arbre}`, '--niveaux=abc'], /Niveaux invalides/);
  refuse([`--arbre=${arbre}`, '--niveaux=0'], /Niveaux invalides/);
  refuse([`--arbre=${arbre}`, '--niveaux=1.5'], /Niveaux invalides/);
  refuse([`--arbre=${arbre}`, '--niveaux=10,,20'], /Niveaux invalides/);
  refuse([`--arbre=${arbre}`, '--essais=0'], /Nombre d'essais invalide/);
  refuse([`--arbre=${arbre}`, '--essais=2.5'], /Nombre d'essais invalide/);
  refuse([`--arbre=${arbre}`, '--regime=autre'], /Régime inconnu/);
  refuse([`--arbre=${arbre}`, '--pile-mb=3.5'], /ne vaut que pour `--regime=worker`/);
  refuse([`--arbre=${arbre}`, '--regime=worker', '--pile-mb=-1'], /Pile invalide/);
  refuse([`--arbre=${arbre}`, '--regime=worker', '--pile-mb=0'], /Pile invalide/);
  refuse([`--arbre=${arbre}`, '--regime=worker', '--pile-mb=abc'], /Pile invalide/);
  refuse([`--arbre=${arbre}`, '--sans-lecture=10000'], /Option inconnue : --sans-lecture=10000/); // le seuil de niveaux n'existe plus : le témoin décide, une option qu'on ignorerait en silence est refusée
  refuse([`--arbre=${path.join(parent, 'inexistant')}`], /Pas un arbre de l'outil/);
  refuse([`--arbre=${sansBin}`], /Pas un arbre de l'outil/);
  refuse([`--arbre=${sansFixture}`], /Pas un arbre de l'outil/);
  refuse([`--arbre=${arbre}`, `--arbre=${sansBin}`], /Pas un arbre de l'outil/);
}));

// ---------------------------------------------------------------------------
// Deux lancements réels, à un niveau que la pile porte : le fil principal et l'enveloppe Worker.
// ---------------------------------------------------------------------------

for (const [regime, options] of [['principal', {}], ['worker', { pileMb: 4 }]]) {
  test(`un lancement réel de l'audit, en régime ${regime}, à 40 niveaux : le code se lit, l'audit rend son rapport`, () => {
    const r = rejouer({ niveaux: [40], essais: 1, regime, arbres: [RACINE], ...options });
    assert.deepEqual(pris(r.lignes[0]), comptes({ lu: 1 }));
    assert.equal(r.interdites, 0);
  });
}
