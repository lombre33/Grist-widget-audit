/**
 * Les clones de code, lus sur l'arbre syntaxique : des fonctions, des blocs et des suites d'instructions qui se répètent, à l'identique ou aux noms
 * et aux valeurs près.
 *
 * Un clone est un ensemble d'au moins deux exemplaires disjoints de même forme. « Même forme » : les mêmes nœuds d'arbre dans le même ordre, sans égard
 * aux blancs, aux commentaires, ni à la façon d'écrire une chaîne ; au choix du nom des variables, des propriétés et des fonctions, et à la valeur des
 * chaînes et des nombres, à une condition : le renommage est cohérent (`a + b * a` et `x + y * x` sont des copies ; `x + y * y` n'en est pas une :
 * la même variable n'y est plus au même endroit). Un clone dit `identique` quand ses exemplaires ne diffèrent en rien de ce qui s'écrit, `renomme` sinon.
 *
 * Ce qui se répète sans que ce soit à corriger n'en est pas un :
 *  - un morceau de données (littéraux, objets, tableaux, noms) : il faut au moins `logique` nœuds de logique (appels, affectations, contrôle de flux,
 *    fonctions) dans la masse ;
 *  - une suite d'appels du même appelé (`set('a', 1); set('b', 2); …`, `const a = document.getElementById('a'); …`) ou d'affectations de valeurs
 *    littérales : un tableau écrit en instructions, où la répétition est l'idiome ;
 *  - ce qu'un clone plus gros couvre déjà : une fonction de quarante lignes copiée ne fait pas trente-trois blocs, elle en fait un.
 *
 * Une fois les arbres numérotés, la recherche ne lit plus de texte : deux sous-arbres de même forme ont le même numéro (hash-consing : chaque nœud est
 * numéroté une fois, d'après les numéros de ses enfants), et une suite d'instructions se cherche comme une chaîne de numéros. Aucune récursion (un arbre
 * très profond ne fait pas déborder la pile), aucune expression régulière sur le code. Le travail est borné par des plafonds de nombres, pas de temps :
 * ce qui dépasse un plafond n'est pas comparé, et la recherche le dit (`ajouter` d'un arbre qu'elle ne garde pas, `limites` d'un travail qu'elle n'a pas fini) pour que le constat le dise aussi.
 *
 * Les arbres passés sont marqués (des champs `__…` sur leurs nœuds) : la fonction en prend l'usage, ils ne servent plus ensuite.
 */

/**
 * Ce qui fait d'une répétition un clone à signaler, et les plafonds de la recherche.
 *  - `masse` : nombre minimal de nœuds d'arbre d'un exemplaire ; `logique` : dont nœuds de logique, au moins ;
 *  - `noeuds` : nombre de nœuds d'arbre gardés pour la comparaison, tous fichiers confondus (la mémoire) ;
 *  - `pas` : nombre de pas de chacune des deux phases de la recherche (celle des suites : un exemplaire examiné à chaque instruction ajoutée à une suite ; puis le choix des
 *    clones : un nœud lu pour un renommage), borne du temps, comptée et non chronométrée. Réglé sur deux mesures : très au-dessus de ce que demande un widget réel
 *    (`scripts/mesurer-pas-clones.mjs`), assez bas pour que l'entrée piégée la plus gourmande y rende ses clones en quelques secondes au plus (`scripts/chronometrer-pieges.mjs`).
 */
export const SEUILS_CLONES = Object.freeze({ masse: 50, logique: 6, noeuds: 400_000, pas: 3_000_000 });

/**
 * Les attributs d'un nœud qui comptent dans sa forme (l'opérateur, le genre de déclaration, `async`…), en plus de son type et de ses enfants : ce que deux nœuds de
 * même type et de mêmes enfants peuvent avoir de différent. Les autres propriétés d'un nœud acorn sont des positions, des textes bruts, des enfants (les seuls objets
 * qui portent un `type`), ou ce que la lecture de `numeroter` traite à part (le nom d'un identifiant, la valeur d'un littéral).
 */
const ATTRIBUTS = new Set(['operator', 'kind', 'computed', 'async', 'generator', 'delegate', 'prefix', 'static', 'shorthand', 'method', 'optional', 'await']);

/** Les nœuds qui portent de la logique : un appel, une affectation, un contrôle de flux, une fonction, une classe. Un déclarant, une propriété, un opérateur binaire n'en portent pas. */
const LOGIQUES = new Set([
  'CallExpression', 'NewExpression', 'AssignmentExpression', 'UpdateExpression', 'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
  'SwitchStatement', 'TryStatement', 'ReturnStatement', 'ThrowStatement', 'FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration', 'ClassDeclaration', 'ClassExpression',
  'YieldExpression', 'AwaitExpression', 'ConditionalExpression', 'LogicalExpression', 'BreakStatement', 'ContinueStatement',
]);

const INSTRUCTIONS = new Set([
  'FunctionDeclaration', 'ClassDeclaration', 'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement',
  'BlockStatement', 'VariableDeclaration', 'ExpressionStatement', 'ReturnStatement', 'ThrowStatement', 'LabeledStatement',
]);
const FONCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression']);

/** Les nœuds dont une liste d'instructions est le corps : `body` (programme, bloc, bloc statique) ou `consequent` (un `case`). */
const LISTES = { Program: 'body', BlockStatement: 'body', StaticBlock: 'body', SwitchCase: 'consequent' };

/** Le numéro de forme d'une instruction qui n'existe pas : avant la première d'une liste, après la dernière (aucun exemplaire ne se prolonge). Les vrais numéros vont de 0. */
const AUCUNE = -1;

/**
 * Les nœuds d'un arbre, un nœud avant ses descendants (pré-ordre). Pile explicite : la profondeur d'un arbre n'est pas bornée par celle de la pile d'appels.
 * @param {object} racine
 * @param {(noeud: object) => void} [visiteur]
 * @param {number} [plafond] au-delà de ce nombre de nœuds, la lecture s'arrête et rend null (un arbre qu'on ne gardera pas n'est pas lu jusqu'au bout)
 * @returns {?object[]}
 */
export function noeudsDe(racine, visiteur, plafond = Infinity) {
  const noeuds = [];
  const pile = [racine];
  while (pile.length) {
    const n = pile.pop();
    if (noeuds.length >= plafond) return null;
    noeuds.push(n);
    visiteur?.(n);
    for (const k in n) {
      const v = n[k];
      if (v === null || typeof v !== 'object') continue;
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) {
          const x = v[i];
          if (x && typeof x.type === 'string') pile.push(x);
        }
      } else if (typeof v.type === 'string') pile.push(v);
    }
  }
  return noeuds;
}

/** Les tables où les formes sont numérotées : une pour la forme exacte, une pour la forme aux noms et aux valeurs près. Partagées par tous les fichiers d'une même recherche, pour que les numéros se comparent d'un fichier à l'autre. */
export function creerTables() {
  return { exacte: new Map(), abstraite: new Map() };
}

/**
 * Numérote chaque nœud : `__h1` (la forme exacte), `__h3` (la forme aux noms et aux valeurs près : tout identifiant, toute chaîne, tout nombre y est le même),
 * `__m` (la masse : le nombre de nœuds du sous-arbre, lui compris) et `__l` (dont le nombre de nœuds de logique). Une passe, en ordre inverse du pré-ordre :
 * un enfant est toujours numéroté avant son parent.
 * @param {object[]} noeuds les nœuds de l'arbre en pré-ordre (`noeudsDe`)
 * @param {{exacte: Map<string, number>, abstraite: Map<string, number>}} tables
 */
export function numeroter(noeuds, tables) {
  for (let i = noeuds.length - 1; i >= 0; i--) {
    const n = noeuds[i];
    let attributs = '';
    const exacts = [];
    const abstraits = [];
    let masse = 1;
    let logique = LOGIQUES.has(n.type) ? 1 : 0;
    for (const k in n) {
      const v = n[k];
      if (v === null) continue;
      if (typeof v !== 'object') {
        if (ATTRIBUTS.has(k)) attributs += `${k}=${v};`;
        continue;
      }
      if (Array.isArray(v)) {
        let e = '';
        let a = '';
        for (const x of v) {
          if (x === null) { e += '_,'; a += '_,'; }                                    // un trou (`[a, , b]`) compte : la place d'un élément absent ne se confond avec aucun nœud (un numéro de forme est un nombre)
          else if (typeof x.type === 'string') { e += `${x.__h1},`; a += `${x.__h3},`; masse += x.__m; logique += x.__l; }
        }
        exacts.push(`${k}:[${e}]`); abstraits.push(`${k}:[${a}]`);
      } else if (typeof v.type === 'string') {
        exacts.push(`${k}:${v.__h1}`); abstraits.push(`${k}:${v.__h3}`); masse += v.__m; logique += v.__l;
      }
    }
    let propre1 = '';
    let propre3 = '';
    if (n.type === 'Identifier') { propre1 = `n=${n.name};`; propre3 = 'n=$;'; }
    else if (n.type === 'PrivateIdentifier') { propre1 = `n=#${n.name};`; propre3 = 'n=#$;'; }
    else if (n.type === 'TemplateElement') { propre1 = `t=${n.value.cooked};`; propre3 = 't;'; }
    else if (n.type === 'Literal') {
      if (n.regex) { propre1 = propre3 = `re=${n.regex.pattern}/${n.regex.flags};`; }
      else if (n.bigint !== undefined) { propre1 = `big=${n.bigint};`; propre3 = 'big;'; }
      else {
        const genre = typeof n.value;
        propre1 = `${genre}=${String(n.value)};`;
        propre3 = genre === 'string' || genre === 'number' ? `${genre};` : propre1;      // chaînes et nombres abstraits ; booléens et null exacts
      }
    }
    const cle1 = `${n.type}|${attributs}${propre1}|${exacts.join(' ')}`;
    const cle3 = `${n.type}|${attributs}${propre3}|${abstraits.join(' ')}`;
    let h1 = tables.exacte.get(cle1);
    if (h1 === undefined) { h1 = tables.exacte.size; tables.exacte.set(cle1, h1); }
    let h3 = tables.abstraite.get(cle3);
    if (h3 === undefined) { h3 = tables.abstraite.size; tables.abstraite.set(cle3, h3); }
    n.__h1 = h1; n.__h3 = h3; n.__m = masse; n.__l = logique;
  }
}

/**
 * La suite des noms d'une ou plusieurs racines, numérotés par première occurrence : deux arbres de même forme sont des copies à renommage cohérent près
 * si et seulement si leurs signatures sont égales (`a + b * a` et `x + y * x` : 0,1,0 ; `x + y * y` : 0,1,1). Les noms de propriétés comptent : `a.foo`
 * et `b.bar` sont des copies, `a.foo + b.foo` et `a.bar + b.baz` n'en sont pas.
 */
function signature(racines) {
  const vus = new Map();
  const suite = [];
  for (const racine of racines) {
    noeudsDe(racine, (n) => {
      const nom = n.type === 'Identifier' ? n.name : n.type === 'PrivateIdentifier' ? `#${n.name}` : null;
      if (nom === null) return;
      let k = vus.get(nom);
      if (k === undefined) { k = vus.size; vus.set(nom, k); }
      suite.push(k);
    });
  }
  return suite.join(',');
}

/** Le nom d'un appelé simple (`set`, `a.b.bind`, `this.set`), ou null. Sans récursion. */
function nomAppele(appele) {
  const morceaux = [];
  let c = appele;
  while (c.type === 'MemberExpression') {
    if (c.computed || c.property.type !== 'Identifier') return null;
    morceaux.unshift(c.property.name);
    c = c.object;
  }
  if (c.type === 'Identifier') morceaux.unshift(c.name);
  else if (c.type === 'ThisExpression') morceaux.unshift('this');
  else return null;
  return morceaux.join('.');
}

/** Une valeur littérale : un nombre, une chaîne, un booléen, null, un gabarit sans expression, ou un signe devant l'une d'elles (`-1`). */
function estLitterale(n) {
  let c = n;
  while (c.type === 'UnaryExpression' && (c.operator === '-' || c.operator === '+' || c.operator === '!')) c = c.argument;
  if (c.type === 'Literal') return true;
  return c.type === 'TemplateLiteral' && c.expressions.length === 0;
}

/**
 * Une suite d'instructions qui est un tableau écrit en code, où la répétition est l'idiome : des appels du même appelé (`set('a', 1); set('b', 2); …`),
 * des déclarations ou affectations dont la valeur est un appel du même appelé (`const a = document.getElementById('a'); …`), ou des affectations de
 * valeurs littérales (`Code["List"] = "L"; …`). Tout en appels du même nom, ou tout en littéraux : un mélange n'en est pas une.
 */
function estSerieDAppels(liste, debut, longueur) {
  let nom = null;
  let litterales = 0;
  for (let k = 0; k < longueur; k++) {
    const st = liste[debut + k];
    let appel = null;
    if (st.type === 'ExpressionStatement' && st.expression.type === 'CallExpression') appel = st.expression;
    else if (st.type === 'VariableDeclaration' && st.declarations.length === 1 && st.declarations[0].init?.type === 'CallExpression') appel = st.declarations[0].init;
    else if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' && st.expression.operator === '=') {
      if (st.expression.right.type === 'CallExpression') appel = st.expression.right;
      else if (estLitterale(st.expression.right)) { litterales++; continue; }
    }
    if (!appel) return false;
    const n = nomAppele(appel.callee);
    if (n === null || (nom !== null && n !== nom)) return false;
    nom = n;
  }
  return nom === null || litterales === 0;                           // sans appel, chaque instruction était une affectation de littéral ; avec des appels, aucune ne l'est (un mélange n'en est pas une)
}

/** Les listes d'instructions d'une unité qui en ont au moins deux : ce sont elles qui portent les séries copiées-collées. */
function listesDInstructions(noeuds) {
  const listes = [];
  for (const n of noeuds) {
    const cle = LISTES[n.type];
    if (cle && n[cle].length >= 2) listes.push(n[cle]);
  }
  return listes;
}

/** Les instructions d'un exemplaire : les nœuds racines de ce qui se répète (un seul pour une fonction ou un bloc, la suite pour une série). */
const racinesDe = (x) => (x.liste ? x.liste.slice(x.i, x.i + x.longueur) : [x.debut]);

/**
 * Les clones de fonctions, de blocs et d'instructions seuls : les nœuds de masse suffisante qui ont la même forme.
 * @returns {object[]} des descripteurs `{ masse, forme, rang, debut, instances: [{ r, debut, fin }] }`
 */
function descripteursDeSousArbres(retenues, s) {
  const parForme = new Map();
  for (const r of retenues) {
    for (const n of r.noeuds) {
      if (!INSTRUCTIONS.has(n.type) && !FONCTIONS.has(n.type)) continue;
      if (n.__m < s.masse || n.__l < s.logique) continue;
      let g = parForme.get(n.__h3);
      if (!g) parForme.set(n.__h3, g = []);
      g.push({ r, debut: n, fin: n });
    }
  }
  const descripteurs = [];
  for (const membres of parForme.values()) {
    if (membres.length < 2) continue;
    const n = membres[0].debut;
    descripteurs.push({ masse: n.__m, forme: FONCTIONS.has(n.type) || n.type === 'FunctionDeclaration' ? 'fonction' : 'bloc', rang: membres[0].r.rang, debut: n.start, instances: membres });
  }
  return descripteurs;
}

/**
 * Les clones de suites d'instructions consécutives. Une suite se cherche comme une chaîne de numéros : des fenêtres de deux instructions voisines, groupées
 * par forme ; un groupe dont tous les exemplaires se prolongent vers la gauche de la même façon n'est que le décalage d'un autre groupe et n'est pas examiné ;
 * les autres s'étendent vers la droite tant que tous leurs exemplaires s'accordent. Quand ils divergent, la suite courante est maximale pour eux tous, et
 * chaque sous-ensemble (deux exemplaires au moins) qui continue ensemble est étendu à son tour. Les exemplaires d'un même groupe qui se chevauchent ne
 * comptent qu'une fois (le premier, de gauche à droite). Limite : un motif répété une fois et demie (`A B A B A`) ne donne rien : la plus longue suite commune, `A B A`,
 * se recouvre elle-même, et `A B` seule n'est pas cherchée.
 * @returns {object[]} des descripteurs `{ masse, forme: 'suite', rang, debut, instances: [{ r, debut, fin, liste, i, longueur }] }`
 */
function descripteursDeSuites(retenues, tables, s, limites, compteur) {
  const listes = [];
  for (const r of retenues) {
    for (const liste of listesDInstructions(r.noeuds)) {
      const masses = [0];
      const logiques = [0];
      for (const st of liste) { masses.push(masses[masses.length - 1] + st.__m); logiques.push(logiques[logiques.length - 1] + st.__l); }
      listes.push({ r, liste, masses, logiques });
    }
  }
  const largeur = tables.abstraite.size;                               // les numéros vont de 0 à largeur - 1 : un couple a une seule clé
  const fenetres = new Map();                                          // le couple de formes de deux instructions voisines -> [{ k, i }], dans l'ordre des listes puis des positions
  for (let k = 0; k < listes.length; k++) {
    const { liste } = listes[k];
    for (let i = 0; i + 1 < liste.length; i++) {
      const cle = liste[i].__h3 * largeur + liste[i + 1].__h3;
      let g = fenetres.get(cle);
      if (!g) fenetres.set(cle, g = []);
      g.push({ k, i });
    }
  }
  const suivant = (m, longueur) => { const { liste } = listes[m.k]; return m.i + longueur < liste.length ? liste[m.i + longueur].__h3 : AUCUNE; };
  const precedent = (m) => (m.i > 0 ? listes[m.k].liste[m.i - 1].__h3 : AUCUNE);
  const descripteurs = [];
  const ajouter = (membres, longueur) => {
    const gardees = [];
    let dernier = null;
    for (const m of membres) {
      if (dernier && dernier.k === m.k && m.i < dernier.i + longueur) continue;
      gardees.push(m);
      dernier = m;
    }
    if (gardees.length < 2) return;
    const { masses, logiques } = listes[gardees[0].k];
    const masse = masses[gardees[0].i + longueur] - masses[gardees[0].i];
    const logique = logiques[gardees[0].i + longueur] - logiques[gardees[0].i];
    if (masse < s.masse || logique < s.logique) return;
    compteur.pas += gardees.length * longueur;
    const ecrites = gardees.filter((m) => !estSerieDAppels(listes[m.k].liste, m.i, longueur));   // chaque exemplaire se juge : une série d'appels n'est pas une copie, même de même forme que des copies
    if (ecrites.length < 2) return;
    const instances = ecrites.map((m) => ({ r: listes[m.k].r, debut: listes[m.k].liste[m.i], fin: listes[m.k].liste[m.i + longueur - 1], liste: listes[m.k].liste, i: m.i, longueur }));
    descripteurs.push({ masse, forme: 'suite', rang: instances[0].r.rang, debut: instances[0].debut.start, instances });
  };
  // Les plus petits groupes d'abord (à taille égale, dans l'ordre des listes puis des positions : le tri est stable) : un groupe de milliers d'exemplaires, du code répété à
  // l'excès, ne prive pas de pas les copies ordinaires, deux ou trois exemplaires.
  const groupes = [...fenetres.values()].filter((g) => g.length >= 2).sort((a, b) => a.length - b.length);
  for (const g of groupes) {
    const avant = precedent(g[0]);
    if (avant !== AUCUNE && g.every((m) => precedent(m) === avant)) continue;
    const travail = [{ membres: g, longueur: 2 }];
    while (travail.length) {
      const { membres, longueur: depart } = travail.pop();
      let longueur = depart;
      let suites;
      for (;;) {
        compteur.pas += membres.length;
        if (compteur.pas > s.pas) { limites.pasEpuises = true; return descripteurs; }
        const h = suivant(membres[0], longueur);
        if (h !== AUCUNE && membres.every((m) => suivant(m, longueur) === h)) { longueur++; continue; }
        const parSuite = new Map();
        for (const m of membres) {
          const x = suivant(m, longueur);
          if (x === AUCUNE) continue;
          let e = parSuite.get(x);
          if (!e) parSuite.set(x, e = []);
          e.push(m);
        }
        suites = [...parSuite.values()].filter((e) => e.length >= 2);
        break;
      }
      for (const e of suites) travail.push({ membres: e, longueur });                   // chaque sous-groupe reprend où ils ont divergé : son premier tour de boucle ajoute l'instruction qu'il partage
      ajouter(membres, longueur);
    }
  }
  return descripteurs;
}

/**
 * Du plus gros au plus petit : un exemplaire déjà couvert par un clone plus gros ne compte plus, il faut deux exemplaires libres, et de même renommage
 * (la suite de leurs noms, numérotés par première occurrence, est la même). Les exemplaires retenus couvrent tout ce qu'ils contiennent.
 */
function selectionner(descripteurs, limites, s) {
  descripteurs.sort((a, b) => b.masse - a.masse || a.rang - b.rang || a.debut - b.debut);
  const clones = [];
  let pas = 0;                                                            // son compte à elle : une recherche de suites arrêtée au plafond ne retire pas le choix parmi ce qu'elle a trouvé
  for (const d of descripteurs) {
    const libres = d.instances.filter((x) => racinesDe(x).every((n) => !n.__couvert));
    if (libres.length < 2) continue;
    if (pas > s.pas) { limites.pasEpuises = true; break; }                // le plafond arrête un travail qui reste à faire : un clone déjà couvert n'en est pas un
    const parSignature = new Map();
    for (const x of libres) {
      pas += d.masse;
      const cle = signature(racinesDe(x));
      let e = parSignature.get(cle);
      if (!e) parSignature.set(cle, e = []);
      e.push(x);
    }
    for (const sous of parSignature.values()) {
      if (sous.length < 2) continue;
      for (const x of sous) for (const racine of racinesDe(x)) noeudsDe(racine, (n) => { n.__couvert = true; });
      const premier = racinesDe(sous[0]);
      const identique = sous.every((x) => racinesDe(x).every((n, k) => n.__h1 === premier[k].__h1));
      const instances = sous.map((x) => ({ chemin: x.r.u.chemin, ligne: x.r.u.ligneDe(x.debut), ligneFin: x.r.u.ligneFinDe(x.fin) }));
      clones.push({ forme: d.forme, type: identique ? 'identique' : 'renomme', masse: d.masse, lignes: Math.max(...instances.map((x) => x.ligneFin - x.ligne + 1)), instances });
    }
  }
  limites.pas += pas;
  return clones;
}

/**
 * Une recherche de clones : on y ajoute les unités une à une (`ajouter` numérote l'arbre, ou le laisse de côté, et le dit, quand les nœuds gardés dépasseraient le
 * plafond : l'arbre qu'on ne garde pas peut être libéré aussitôt), puis `chercher` rend les clones. Les unités ne sont pas gardées toutes ensemble
 * avant d'être comptées, c'est ce qui borne la mémoire d'un dépôt qui porte des mégaoctets de code.
 * @param {Partial<typeof SEUILS_CLONES>} [seuils]
 */
export function creerRecherche(seuils = {}) {
  const s = { ...SEUILS_CLONES, ...seuils };
  const limites = { pasEpuises: false, pas: 0 };
  const tables = creerTables();
  const retenues = [];
  let gardes = 0;
  return {
    /**
     * @param {{chemin: string, ast: ?object, ligneDe: (noeud: object) => number, ligneFinDe: (noeud: object) => number}} u
     *   `ligneDe` et `ligneFinDe` disent la ligne où un nœud commence et finit dans le fichier réel (un script inline a son décalage dans la page)
     * @returns {boolean} vrai si l'unité est gardée pour la comparaison
     */
    ajouter(u) {
      if (!u.ast) return false;
      const noeuds = noeudsDe(u.ast, undefined, s.noeuds - gardes);
      if (noeuds === null) return false;
      gardes += noeuds.length;
      numeroter(noeuds, tables);
      retenues.push({ u, noeuds, rang: retenues.length });
      return true;
    },
    /**
     * @returns {{
     *   clones: Array<{forme: 'fonction'|'bloc'|'suite', type: 'identique'|'renomme', masse: number, lignes: number, instances: Array<{chemin: string, ligne: number, ligneFin: number}>}>,
     *   limites: {pasEpuises: boolean, pas: number}
     * }} les clones du plus gros au plus petit (la masse), à masse égale dans l'ordre des unités ; `limites` : si le plafond de pas a arrêté la recherche, et le nombre de pas
     *   que la recherche a comptés, les deux phases ensemble (le même pour la même entrée)
     */
    chercher() {
      const compteur = { pas: 0 };
      const descripteurs = [...descripteursDeSousArbres(retenues, s), ...descripteursDeSuites(retenues, tables, s, limites, compteur)];
      limites.pas += compteur.pas;
      const clones = selectionner(descripteurs, limites, s);
      return { clones, limites };
    },
  };
}

/** Les clones d'une liste d'unités (voir `creerRecherche`). */
export function detecterClones(unites, seuils = {}) {
  const recherche = creerRecherche(seuils);
  for (const u of unites) recherche.ajouter(u);
  return recherche.chercher();
}
