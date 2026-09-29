import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparerCodeExecuteEnChaine } from '../src/regles/c-securite.js';

/**
 * Liaisons que le langage garantit (décision de la coordination le
 * 2026-09-28). Dans une fonction, un bloc ou au premier niveau d'un module,
 * une var, un let ou une fonction initialisés par un littéral ou une
 * expression de fonction, et jamais écrits dans leur portée, se résolvent
 * comme un const. Seul le premier niveau d'un script classique reste non
 * garanti hors const : tout autre script de la page peut y remplacer la
 * liaison, et le constat le dit. Chaque garde a son test de sécurité et son
 * test de faux positif.
 */

function fichier(chemin, contenu) {
  return { chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: true, vendorise: false, taille: Buffer.byteLength(contenu, 'utf8') };
}

function constatsDe(fichiers, regle) {
  return preparerCodeExecuteEnChaine({ fichiers }).filter((c) => c.regle === regle);
}

function unique(fichiers, regle) {
  const c = constatsDe(fichiers, regle);
  assert.equal(c.length, 1, `un seul constat ${regle} attendu, obtenu ${c.length}`);
  return c[0];
}

const verdict = (c) => (c ? `${c.severite}${c.bloquant ? '+B' : ''}` : 'rien');

function verdictMinuteur(contenu, chemin = 'app.js') {
  const c = constatsDe([fichier(chemin, contenu)], 'C-XSS-04');
  assert.ok(c.length <= 1, `au plus un constat de minuteur attendu, obtenu ${c.length}`);
  return verdict(c[0]);
}

const verdictExecution = (contenu) => verdict(unique([fichier('app.js', contenu)], 'C-XSS-03'));
const minuteur = (contenu) => unique([fichier('app.js', contenu)], 'C-XSS-04');
const execution = (contenu) => unique([fichier('app.js', contenu)], 'C-XSS-03');

// Module ou script classique ----------------------------------------------------

test('module : une fonction de premier niveau d\'un fichier qui exporte n\'est remplaçable par aucun autre script', () => {
  assert.equal(verdictMinuteur('export function tick() {}\nsetTimeout(tick, 0);'), 'rien');
});

test('module : une fonction de premier niveau d\'un fichier qui importe, pareil', () => {
  assert.equal(verdictMinuteur('import { x } from "./x.js";\nfunction tick() {}\nsetTimeout(tick, 0);'), 'rien');
});

test('module : un `import()` dynamique, permis dans un script classique, ne fait pas un module', () => {
  assert.equal(verdictMinuteur('function tick() {}\nimport("./x.js");\nsetTimeout(tick, 0);'), 'info');
});

test('module : un `<script type="module">` écrit dans la page est un module', () => {
  assert.equal(verdictMinuteur('<script type="module">function tick() {} setTimeout(tick, 0);</script>', 'index.html'), 'rien');
});

test('module : un `<script>` sans type est un script classique', () => {
  assert.equal(verdictMinuteur('<script>function tick() {} setTimeout(tick, 0);</script>', 'index.html'), 'info');
});

test('module : le type se lit sans tenir compte de la casse, et le script est bien lu', () => {
  assert.equal(verdictMinuteur('<script type="MODULE">function tick() {} setTimeout(tick, 0);</script>', 'index.html'), 'rien');
  assert.equal(verdictMinuteur('<script type="MODULE">setTimeout("tick()", 0);</script>', 'index.html'), 'mineur');
});

test('module : un type à blancs de bord est un module, pas un script ignoré', () => {
  assert.equal(verdictMinuteur('<script type=" module ">function tick() {} setTimeout(tick, 0);</script>', 'index.html'), 'rien');
  assert.equal(verdictMinuteur('<script type=" module ">setTimeout("tick()", 0);</script>', 'index.html'), 'mineur');
});

test('module : seul le premier attribut `type` compte, comme pour le navigateur', () => {
  assert.equal(verdictMinuteur('<script type="text/javascript" type="module">function tick() {} setTimeout(tick, 0);</script>', 'index.html'), 'info');
});

test('module : « type=module » dans la valeur d\'un autre attribut ne fait pas un module', () => {
  assert.equal(verdictMinuteur('<script data-note="type=module">function tick() {} setTimeout(tick, 0);</script>', 'index.html'), 'info');
});

test('module : un fichier sans import ni export reste un script classique, même chargé par `type="module"` (un autre chargement peut l\'exécuter comme script classique)', () => {
  const c = constatsDe([
    fichier('index.html', '<script type="module" src="app.js"></script>'),
    fichier('app.js', 'function tick() {}\nsetTimeout(tick, 0);'),
  ], 'C-XSS-04');
  assert.deepEqual(c.map(verdict), ['info']);
});

test('module : un let de premier niveau d\'un module, jamais écrit, est garanti (un importeur ne peut pas l\'écrire)', () => {
  assert.equal(verdictExecution('export const v = 1;\nlet g = "return this";\nFunction(g)();'), 'mineur');
});

test('module : un let de premier niveau d\'un module écrit dans le module n\'est pas garanti', () => {
  assert.equal(verdictExecution('export const v = 1;\nlet g = "return this";\ng = obtenir();\nFunction(g)();'), 'critique+B');
});

test('module : une var de premier niveau d\'un module, jamais écrite, est garantie', () => {
  assert.equal(verdictExecution('export const v = 1;\nvar g = "return this";\nFunction(g)();'), 'mineur');
});

// Liaison locale : var, let, fonction ---------------------------------------------

test('locale : une var initialisée par un littéral et jamais écrite se résout comme un const (code transpilé en ES5)', () => {
  assert.equal(verdictExecution('(function () { var g = "return this"; Function(g)(); })();'), 'mineur');
});

test('locale : un let initialisé par un littéral et jamais écrit, pareil', () => {
  assert.equal(verdictExecution('(function () { let g = "return this"; Function(g)(); })();'), 'mineur');
});

test('locale : une chaîne dans une var jamais écrite est auditée au minuteur comme un littéral', () => {
  assert.equal(verdictMinuteur('(function () { var code = "void 0"; setTimeout(code, 0); })();'), 'mineur');
});

test('locale : une var initialisée par une expression de fonction est une fonction garantie (hammer.js, `removeLastTouch`)', () => {
  const contenu = [
    'function setLastTouch(eventData) {',
    '  var lts = this.lastTouches;',
    '  var removeLastTouch = function () { lts.shift(); };',
    '  setTimeout(removeLastTouch, 2500);',
    '}',
  ].join('\n');
  assert.equal(verdictMinuteur(contenu), 'rien');
});

test('locale : une var écrite dans sa portée n\'est pas garantie', () => {
  assert.equal(verdictExecution('(function () { var g = "return this"; g = obtenir(); Function(g)(); })();'), 'critique+B');
});

test('locale : une fonction dans une var écrite dans sa portée n\'est plus garantie', () => {
  assert.equal(verdictMinuteur('(function () { var cb = function () {}; cb = obtenir(); setTimeout(cb, 0); })();'), 'info');
});

test('locale : une var initialisée à deux déclarations n\'est pas garantie', () => {
  const c = execution('(function () { var g = "return this"; var g = "return 1"; Function(g)(); })();');
  assert.equal(verdict(c), 'critique+B');
  assert.match(c.constat, /reçoit une valeur à plusieurs déclarations/);
});

test('locale : une var déstructurée n\'a pas de valeur lisible, même depuis un littéral (`[g]` d\'une chaîne n\'en est que le premier caractère)', () => {
  assert.equal(verdictExecution('(function (o) { var { g } = o; Function(g)(); })();'), 'critique+B');
  assert.equal(verdictExecution('(function () { var [g] = "return this"; Function(g)(); })();'), 'critique+B');
});

test('locale : une var initialisée par un appel n\'a pas de valeur lisible', () => {
  const c = execution('(function () { var g = obtenir(); Function(g)(); })();');
  assert.equal(verdict(c), 'critique+B');
  assert.match(c.constat, /`g` est une variable `var` dont la valeur initiale ne se lit pas dans le code/);
});

test('locale : un eval() direct peut écrire le let qu\'il lit ; seul un const l\'en empêche, et le texte le dit', () => {
  const c = execution('(function () { let code = "1+1"; eval(code); })();');
  assert.equal(verdict(c), 'critique+B');
  assert.match(c.constat, /`code` est une variable `let` qu'un eval\(\) direct de sa portée peut réécrire/);
  assert.match(c.remediation, /Si ce code doit rester, déclarer `code` en `const` :/);
});

test('locale (faux positif) : un const lu par un eval() direct reste garanti', () => {
  assert.equal(verdictExecution('(function () { const code = "1+1"; eval(code); })();'), 'mineur');
});

test('locale : une fonction locale qu\'un eval() direct peut réécrire le dit', () => {
  const c = minuteur('(function () { function tick() {} eval("1"); setTimeout(tick, 0); })();');
  assert.match(c.constat, /une fonction déclarée qu'un eval\(\) direct de sa portée peut réécrire/);
});

test('locale : une fonction locale réécrite le dit', () => {
  const c = minuteur('(function () { function tick() {} tick = obtenir(); setTimeout(tick, 0); })();');
  assert.match(c.constat, /une fonction déclarée, mais réécrite dans sa portée/);
});

// Premier niveau d'un script classique ------------------------------------------

test('script classique : une var de premier niveau reste non garantie, et le texte dit pourquoi', () => {
  const c = execution('var g = "return this";\nFunction(g)();');
  assert.equal(verdict(c), 'critique+B');
  assert.match(c.constat, /`g` est déclaré au premier niveau d'un script classique, comme une propriété de l'objet global que tout autre script de la page peut remplacer/);
  assert.match(c.remediation, /Si ce code doit rester, déclarer `g` en `const`, ou dans une fonction englobante ou un module/);
});

test('script classique : pour un eval() direct, seul un const garantit la valeur (il écrirait une var ou un let local)', () => {
  const c = execution('var code = "1+1";\neval(code);');
  assert.match(c.remediation, /Si ce code doit rester, déclarer `code` en `const` : /);
  assert.doesNotMatch(c.remediation, /fonction englobante/);
});

test('script classique : un let de premier niveau peut être réaffecté par tout autre script', () => {
  const c = minuteur('let cb = () => {};\nsetTimeout(cb, 0);');
  assert.equal(verdict(c), 'info');
  assert.match(c.constat, /`cb`, est déclaré en `let` au premier niveau d'un script classique, où tout autre script de la page peut le réaffecter/);
});

test('script classique : la remédiation d\'une fonction globale propose un const, une fonction englobante ou un module, pas « passer une fonction » (printlabels.js)', () => {
  const c = minuteur('function tick() {}\nsetTimeout(tick, 0);');
  assert.equal(verdict(c), 'info');
  assert.match(c.remediation, /^Déclarer `tick` en `const` \(`const tick = \(\) => …`\), ou dans une fonction englobante ou un module/);
  assert.doesNotMatch(c.remediation, /Passer/);
});

test('script classique : une chaîne dans un let de premier niveau, au minuteur, propose une fonction ou une déclaration qui garantit', () => {
  const c = minuteur('let code = "void 0";\nsetTimeout(code, 0);');
  assert.equal(verdict(c), 'critique+B');
  assert.match(c.remediation, /^Passer une fonction : `setTimeout\(\(\) => …, délai\)`\. Si cette chaîne doit rester, déclarer `code` en `const`, ou dans une fonction englobante ou un module/);
});

// Annexe B : une fonction déclarée dans un bloc est aussi une var de sa fonction --

test('annexe B : une fonction déclarée dans un bloc crée une var de la fonction, qu\'une chaîne peut remplacer', () => {
  assert.equal(verdictMinuteur('const cb = () => {};\nfunction f() {\n  if (0) { function cb() {} }\n  cb = "alert(1)";\n  setTimeout(cb, 0);\n}'), 'critique+B');
});

test('annexe B : sans écriture, cette var n\'est pas pour autant la fonction extérieure', () => {
  const c = minuteur('const cb = () => {};\nfunction f() {\n  if (0) { function cb() {} }\n  setTimeout(cb, 0);\n}');
  assert.equal(verdict(c), 'info');
  assert.match(c.constat, /est aussi le nom d'une fonction déclarée dans un bloc imbriqué/);
});

test('annexe B (faux positif) : la fonction d\'un bloc d\'une fonction imbriquée reste dans celle-ci, même quand cette fonction est elle-même dans un bloc', () => {
  assert.equal(verdictMinuteur('const cb = () => {};\nfunction f() {\n  function g() { if (0) { function cb() {} } }\n  setTimeout(cb, 0);\n}'), 'rien');
  assert.equal(verdictMinuteur('const cb = () => {};\nfunction f() {\n  if (1) { function g() { if (0) { function cb() {} } } }\n  setTimeout(cb, 0);\n}'), 'rien');
  assert.equal(verdictMinuteur('const cb = () => {};\nfunction f() {\n  if (1) { const h = function () { if (0) { function cb() {} } }; }\n  setTimeout(cb, 0);\n}'), 'rien');
  assert.equal(verdictMinuteur('const cb = () => {};\nfunction f() {\n  if (1) { const h = () => { if (0) { function cb() {} } }; }\n  setTimeout(cb, 0);\n}'), 'rien');
});

test('annexe B (faux positif) : une fonction de premier niveau du corps n\'est pas visible des valeurs par défaut des paramètres', () => {
  assert.equal(verdictMinuteur('const cb = () => {};\nfunction f(x = setTimeout(cb, 0)) { function cb() {} }'), 'rien');
});

// Ce que le texte affirme du premier argument d'un minuteur ---------------------

test('texte : une donnée reçue n\'est pas dite « chaîne », son type est inconnu', () => {
  const c = minuteur('grist.onRecord(r => { setTimeout(r.Formule, 0); });');
  assert.equal(verdict(c), 'critique+B');
  assert.match(c.constat, /provient d'une donnée reçue par le widget, dont le type n'est pas connu/);
  assert.doesNotMatch(`${c.titre} ${c.constat}`, /est une chaîne, pas une fonction|Chaîne de caractères/);
});

test('texte : un littéral qui n\'est pas une chaîne est dit converti', () => {
  assert.match(minuteur('setTimeout(null, 1);').constat, /est un littéral, pas une fonction : il est converti en chaîne/);
});

test('texte : un littéral garanti qui n\'est pas une chaîne est dit converti, lui aussi', () => {
  assert.match(minuteur('(function () { const d = 0; setTimeout(d, 0); })();').constat, /est un littéral, pas une fonction/);
});

test('texte : une concaténation non repliée peut donner un nombre, elle n\'est pas dite « chaîne »', () => {
  const c = minuteur('setTimeout(a + b, 0);');
  assert.match(c.constat, /est une concaténation, jamais une fonction/);
});

test('texte : une chaîne littérale est bien dite chaîne', () => {
  assert.match(minuteur('setTimeout("void 0", 0);').constat, /est une chaîne, pas une fonction/);
});

test('texte : une liaison qui reçoit une chaîne ailleurs le dit, sans affirmer qu\'elle en est une', () => {
  const c = minuteur('let code;\ncode = "void 0";\nsetTimeout(code, 0);');
  assert.match(c.constat, /`code`, reçoit une chaîne ou une donnée ailleurs dans le code : si c'en est une au moment de l'appel/);
});

test('texte : un paramètre non garanti propose une fonction écrite sur place qui l\'appelle', () => {
  assert.match(minuteur('function armer(cb) { setTimeout(cb, 10); }').remediation, /^Passer à `setTimeout` une fonction écrite sur place \(`setTimeout\(\(\) => cb\(\), délai\)`\)/);
});

test('texte : un argument qui n\'est pas un identifiant propose une fonction écrite sur place', () => {
  assert.match(minuteur('setTimeout(obj.m, 10);').remediation, /^Passer à `setTimeout` une fonction écrite sur place \(`setTimeout\(\(\) => …, délai\)`\)/);
});

test('texte : eval() dit pourquoi un identifiant n\'est pas garanti', () => {
  assert.match(execution('function f(code) { eval(code); }').constat, /`code` est un paramètre, dont la valeur dépend de l'appelant/);
});
