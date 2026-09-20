/**
 * Axe A — Qualité du code.
 *
 * Le guide Grist.Gouv n'impose ni linter ni formateur. Les règles ci-dessous
 * ne cherchent donc pas à imposer un style : elles mesurent ce qui coûte cher
 * à un relecteur bénévole et à la personne qui reprendra le widget dans deux
 * ans — taille des unités, complexité, duplication, erreurs silencieuses,
 * couverture de tests.
 */
import path from 'node:path';
import { constat } from '../moteur/modele.js';
import { pourChaqueUniteJs, nomPointe } from '../moteur/analyse-js.js';

const SEUILS = {
  fichierLong: 600,        // lignes significatives
  fichierTresLong: 1200,
  fonctionLongue: 80,
  fonctionTresLongue: 200,
  complexite: 15,
  complexiteForte: 30,
  imbrication: 5,
  ligneLongue: 160,
};

/** Taille des fichiers du code exécuté. */
export function analyserTailleFichiers(ctx) {
  const constats = [];
  const gros = ctx.fichiers
    .filter((f) => f.executee && !f.vendorise && ['.js', '.mjs'].includes(f.ext) && (f.locSignificatives ?? 0) > SEUILS.fichierLong)
    .sort((a, b) => b.locSignificatives - a.locSignificatives);

  for (const f of gros) {
    const tresLong = f.locSignificatives > SEUILS.fichierTresLong;
    constats.push(constat({
      regle: 'A-TAILLE-01', axe: 'A', severite: tresLong ? 'majeur' : 'mineur', confiance: 'certain',
      titre: `Fichier de ${f.locSignificatives} lignes significatives : ${f.chemin}`,
      fichier: f.chemin,
      constat: `Le fichier dépasse le seuil de ${tresLong ? SEUILS.fichierTresLong : SEUILS.fichierLong} lignes significatives.`,
      impact: "Le guide demande qu'un relecteur puisse lire la logique du widget « en une seule fois ». Au-delà d'un millier de lignes dans un fichier, la revue devient un survol : c'est souvent là que passent les défauts.",
      remediation: 'Découper par responsabilité (rendu, accès aux données, export…) en modules ES importés depuis un point d\'entrée.',
      referentiels: ['Guide de contribution Grist.Gouv — « Reviewers should be able to read your widget\'s logic in one sitting »'],
    }));
  }
  return constats;
}

/** Longueur, complexité cyclomatique et imbrication des fonctions. */
export function analyserFonctions(ctx) {
  const constats = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    const visiter = (n) => {
      const debut = n.loc?.start?.line, fin = n.loc?.end?.line;
      if (debut == null) return;
      const lignes = fin - debut + 1;
      const { complexite, imbrication } = mesurer(n, walk);
      const nom = n.id?.name ?? n.key?.name ?? '(fonction anonyme)';

      if (lignes > SEUILS.fonctionLongue) {
        const tres = lignes > SEUILS.fonctionTresLongue;
        constats.push(constat({
          regle: 'A-FONC-01', axe: 'A', severite: tres ? 'majeur' : 'mineur', confiance: 'certain',
          titre: `Fonction de ${lignes} lignes : ${nom}`,
          fichier: unite.chemin, ligne: ligneDe(n),
          constat: `\`${nom}\` s'étend sur ${lignes} lignes.`,
          impact: "Une fonction trop longue ne tient pas dans un écran ni dans la tête du relecteur : on ne peut plus vérifier qu'elle fait bien ce que son nom annonce, ni la tester unitairement.",
          remediation: 'Extraire les étapes internes en fonctions nommées, chacune testable isolément.',
        }));
      }
      if (complexite > SEUILS.complexite) {
        const forte = complexite > SEUILS.complexiteForte;
        constats.push(constat({
          regle: 'A-FONC-02', axe: 'A', severite: forte ? 'majeur' : 'mineur', confiance: 'certain',
          titre: `Complexité cyclomatique de ${complexite} : ${nom}`,
          fichier: unite.chemin, ligne: ligneDe(n),
          constat: `\`${nom}\` comporte ${complexite} chemins d'exécution indépendants (seuil retenu : ${SEUILS.complexite}).`,
          impact: `Il faut au minimum ${complexite} cas de test pour couvrir cette fonction. En pratique elle ne sera pas testée exhaustivement, et les branches rares porteront les défauts.`,
          remediation: 'Extraire les branches en fonctions distinctes, ou remplacer les cascades de conditions par une table de correspondance.',
          referentiels: ['Métrique de McCabe'],
        }));
      }
      if (imbrication > SEUILS.imbrication) {
        constats.push(constat({
          regle: 'A-FONC-03', axe: 'A', severite: 'mineur', confiance: 'certain',
          titre: `Imbrication de profondeur ${imbrication} : ${nom}`,
          fichier: unite.chemin, ligne: ligneDe(n),
          constat: `Le corps de \`${nom}\` atteint ${imbrication} niveaux de blocs imbriqués.`,
          impact: "Au-delà de quatre ou cinq niveaux, le lecteur perd le fil des conditions actives à un point donné.",
          remediation: 'Sortir tôt (`return` anticipé), extraire les blocs internes.',
        }));
      }
    };
    walk.simple(ast, {
      FunctionDeclaration: visiter,
      FunctionExpression: visiter,
      ArrowFunctionExpression: (n) => { if (n.body.type === 'BlockStatement') visiter(n); },
    });
  });
  return constats;
}

function mesurer(noeud, walk) {
  let complexite = 1;
  walk.simple(noeud, {
    IfStatement() { complexite++; },
    ForStatement() { complexite++; },
    ForInStatement() { complexite++; },
    ForOfStatement() { complexite++; },
    WhileStatement() { complexite++; },
    DoWhileStatement() { complexite++; },
    SwitchCase(n) { if (n.test) complexite++; },
    CatchClause() { complexite++; },
    ConditionalExpression() { complexite++; },
    LogicalExpression(n) { if (n.operator === '&&' || n.operator === '||' || n.operator === '??') complexite++; },
  });
  let imbrication = 0;
  const profondeur = (n, d) => {
    if (!n || typeof n !== 'object') return;
    const bloquant = ['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
      'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement'].includes(n.type);
    const d2 = bloquant ? d + 1 : d;
    if (d2 > imbrication) imbrication = d2;
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => profondeur(x, d2));
      else if (v && typeof v.type === 'string') profondeur(v, d2);
    }
  };
  profondeur(noeud.body, 0);
  return { complexite, imbrication };
}

/** Gestion d'erreur silencieuse : `catch` vide ou qui avale l'erreur. */
export function analyserGestionErreurs(ctx) {
  const constats = [];
  pourChaqueUniteJs(ctx, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      CatchClause(n) {
        const corps = n.body.body;
        if (corps.length === 0) {
          constats.push(constat({
            regle: 'A-ERR-01', axe: 'A', severite: 'majeur', confiance: 'certain',
            titre: 'Bloc catch vide : une erreur est avalée sans trace',
            fichier: unite.chemin, ligne: ligneDe(n),
            constat: 'Le bloc `catch` ne contient aucune instruction.',
            impact: "L'erreur disparaît sans message. Pour l'agent, le widget « ne fait rien » sans explication ; pour le mainteneur, l'incident est irreproductible.",
            remediation: "Au minimum journaliser l'erreur ; idéalement afficher un message compréhensible à l'agent.",
            referentiels: ['CWE-390'],
          }));
        }
      },
    });
  });
  return constats;
}

/** Traces de développement laissées dans le code livré. */
export function analyserTracesDev(ctx) {
  const constats = [];
  const consoles = [];
  const marqueurs = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      CallExpression(n) {
        const nom = nomPointe(n.callee) || '';
        if (/^console\.(log|debug|info|table|dir)$/.test(nom)) consoles.push({ fichier: unite.chemin, ligne: ligneDe(n) });
        if (/^debugger$/.test(nom)) consoles.push({ fichier: unite.chemin, ligne: ligneDe(n) });
      },
      DebuggerStatement(n) {
        constats.push(constat({
          regle: 'A-DEV-02', axe: 'A', severite: 'majeur', confiance: 'certain',
          titre: 'Instruction `debugger` présente dans le code livré',
          fichier: unite.chemin, ligne: ligneDe(n),
          constat: 'Une instruction `debugger` interrompt l\'exécution quand les outils de développement sont ouverts.',
          impact: "Le widget se fige pour tout agent ayant la console ouverte.",
          remediation: 'Supprimer.',
        }));
      },
    });
  });

  for (const f of ctx.fichiers) {
    if (!f.contenu || f.binaire || f.vendorise) continue;
    for (const m of f.contenu.matchAll(/\b(TODO|FIXME|XXX|HACK|À FAIRE|BUG)\b[ :]/g)) {
      marqueurs.push({ fichier: f.chemin, ligne: f.contenu.slice(0, m.index).split('\n').length, type: m[1] });
    }
  }

  if (consoles.length > 10) {
    const fichiers = [...new Set(consoles.map((c) => c.fichier))];
    constats.push(constat({
      regle: 'A-DEV-01', axe: 'A', severite: 'mineur', confiance: 'certain',
      titre: `${consoles.length} appels console.log laissés dans le code exécuté`,
      fichier: fichiers[0], ligne: consoles[0].ligne,
      constat: `${consoles.length} traces de débogage réparties sur ${fichiers.length} fichier(s).`,
      impact: "Bruit dans la console de l'agent, et risque d'y déverser le contenu de cellules du document — donc des données potentiellement sensibles, lisibles par toute extension de navigateur installée.",
      remediation: "Passer par une fonction de journalisation activable par un indicateur, désactivée par défaut.",
      preuve: { emplacements: consoles.slice(0, 30) },
    }));
  }
  if (marqueurs.length > 5) {
    constats.push(constat({
      regle: 'A-DEV-03', axe: 'A', severite: 'mineur', confiance: 'certain',
      titre: `${marqueurs.length} marqueurs TODO / FIXME dans le dépôt`,
      fichier: marqueurs[0].fichier, ligne: marqueurs[0].ligne,
      constat: `Le dépôt contient ${marqueurs.length} marqueurs de travail inachevé.`,
      impact: "Difficile pour un relecteur de distinguer ce qui est volontairement hors périmètre de ce qui est un défaut connu non traité.",
      remediation: 'Convertir en tickets, ou supprimer ceux qui ne sont plus d\'actualité.',
      preuve: { emplacements: marqueurs.slice(0, 30) },
    }));
  }
  return constats;
}

/** Duplication de blocs entre fichiers — explicitement visée par le guide. */
export function analyserDuplication(ctx) {
  const constats = [];
  const TAILLE = 8;                 // fenêtre de lignes normalisées
  const empreintes = new Map();

  for (const f of ctx.fichiers) {
    if (!f.contenu || f.binaire || f.vendorise || !['.js', '.mjs'].includes(f.ext)) continue;
    const lignes = f.lignes
      .map((l, i) => ({ i: i + 1, t: l.trim() }))
      .filter((l) => l.t && !/^(\/\/|\/\*|\*)/.test(l.t));

    for (let i = 0; i + TAILLE <= lignes.length; i++) {
      const bloc = lignes.slice(i, i + TAILLE);
      // Normalisation : on ignore les noms d'identifiants et les littéraux,
      // pour attraper le copier-coller légèrement retouché.
      const cle = bloc.map((l) => l.t.replace(/["'`][^"'`]*["'`]/g, 'S').replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/\s+/g, '')).join('|');
      if (cle.length < 120) continue;
      (empreintes.get(cle) ?? empreintes.set(cle, []).get(cle)).push({ fichier: f.chemin, ligne: bloc[0].i });
    }
  }

  const groupes = [...empreintes.values()]
    .filter((occ) => occ.length > 1)
    .filter((occ) => new Set(occ.map((o) => o.fichier)).size > 1 || occ.length > 2);

  // Fusion des groupes chevauchants : un bloc de 40 lignes dupliqué produit
  // sinon 33 groupes qui décrivent le même copier-coller.
  const retenus = [];
  const vus = new Set();
  for (const occ of groupes.sort((a, b) => b.length - a.length)) {
    const cle = occ.map((o) => `${o.fichier}:${Math.floor(o.ligne / 10)}`).sort().join(',');
    if (vus.has(cle)) continue;
    vus.add(cle);
    retenus.push(occ);
  }

  if (retenus.length) {
    const inter = retenus.filter((o) => new Set(o.map((x) => x.fichier)).size > 1);
    constats.push(constat({
      regle: 'A-DUP-01', axe: 'A',
      severite: inter.length > 5 ? 'majeur' : 'mineur', confiance: 'probable',
      titre: `${retenus.length} bloc(s) de code dupliqué(s)${inter.length ? `, dont ${inter.length} entre fichiers différents` : ''}`,
      fichier: retenus[0][0].fichier, ligne: retenus[0][0].ligne,
      constat: `Des séquences d'au moins ${TAILLE} lignes se répètent à l'identique (aux noms et littéraux près).`,
      impact: "Le guide le dit explicitement : « un défaut corrigé à un endroit restera silencieusement présent dans les autres ». La duplication entre fichiers est aussi ce qui fait grossir le temps de revue sans rien apporter.",
      remediation: 'Extraire la logique partagée dans un module commun importé par les deux emplacements.',
      referentiels: ['Guide de contribution Grist.Gouv — « Duplicated code is harder to review and creates maintenance debt »'],
      preuve: { groupes: retenus.slice(0, 15).map((o) => o.slice(0, 6)) },
    }));
  }
  return constats;
}

/** Présence et nature des tests, exigence explicite du guide. */
export function analyserTests(ctx) {
  const constats = [];
  const testsUnitaires = ctx.fichiers.filter((f) =>
    /(^|\/)(tests?|__tests__|spec)\//i.test(f.chemin) || /\.(test|spec)\.(m?js|ts|jsx|tsx)$/i.test(f.chemin));
  const e2e = ctx.fichiers.filter((f) =>
    /(playwright|cypress|puppeteer|e2e|integration|browser)/i.test(f.chemin) ||
    (f.contenu && /@playwright\/test|require\(['"]puppeteer|from ['"]playwright/.test(f.contenu)));

  if (!testsUnitaires.length) {
    constats.push(constat({
      regle: 'A-TEST-01', axe: 'A', severite: 'majeur', confiance: 'certain',
      titre: 'Aucun test unitaire identifié',
      constat: "Aucun fichier de test unitaire n'a été trouvé (motifs cherchés : `test/`, `*.test.js`, `*.spec.js`).",
      impact: "Le guide de contribution exige que « les fonctionnalités principales soient couvertes par des tests unitaires ». Sans tests, aucune modification ultérieure ne peut être validée autrement qu'à la main, et l'équipe Grist.Gouv devra refuser le widget pour un hébergement officiel.",
      remediation: "Ajouter des tests sur la logique métier pure (transformation de données, formatage, validation). Le lanceur intégré de Node (`node --test`) suffit et n'ajoute aucune dépendance.",
      referentiels: ['Guide de contribution Grist.Gouv — section Tests'],
    }));
  }
  if (!e2e.length) {
    constats.push(constat({
      regle: 'A-TEST-02', axe: 'A', severite: 'majeur', confiance: 'certain',
      titre: "Aucun test d'intégration ou de bout en bout identifié",
      constat: "Aucun test pilotant le widget dans un navigateur n'a été trouvé.",
      impact: "Le guide demande des tests d'intégration couvrant « au minimum le scénario de base : création du document, interaction avec le widget ». C'est le seul type de test qui vérifie la négociation avec Grist (`grist.ready`, mappage de colonnes, réception des enregistrements).",
      remediation: "Ajouter un scénario Playwright qui charge le widget, simule l'hôte Grist et vérifie l'affichage. Le banc d'essai livré avec cet outil (axe D) peut servir de base.",
      referentiels: ['Guide de contribution Grist.Gouv — section Tests'],
    }));
  }
  if (testsUnitaires.length) {
    constats.push(constat({
      regle: 'A-TEST-03', axe: 'A', severite: 'info', confiance: 'certain',
      titre: `${testsUnitaires.length} fichier(s) de test unitaire présents`,
      constat: `Fichiers repérés : ${testsUnitaires.slice(0, 6).map((f) => f.chemin).join(', ')}${testsUnitaires.length > 6 ? '…' : ''}`,
      impact: "Point positif au regard du guide. L'outil ne mesure pas la couverture réelle : un relecteur doit vérifier que ces tests portent bien sur la logique métier.",
      remediation: 'Rien à corriger.',
    }));
  }
  return constats;
}

/** Pratiques de langage qui coûtent en fiabilité. */
export function analyserPratiques(ctx) {
  const constats = [];
  const laches = [];
  const vars = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      BinaryExpression(n) {
        if (n.operator === '==' || n.operator === '!=') {
          // `x == null` est un idiome délibéré et correct : on ne le compte pas.
          const nul = (c) => c.type === 'Literal' && c.value === null;
          if (!nul(n.left) && !nul(n.right)) laches.push({ fichier: unite.chemin, ligne: ligneDe(n), op: n.operator });
        }
      },
      VariableDeclaration(n) { if (n.kind === 'var') vars.push({ fichier: unite.chemin, ligne: ligneDe(n) }); },
    });
  });

  if (laches.length) {
    constats.push(constat({
      regle: 'A-LANG-01', axe: 'A', severite: 'mineur', confiance: 'certain',
      titre: `${laches.length} comparaison(s) non strictes (== / !=)`,
      fichier: laches[0].fichier, ligne: laches[0].ligne,
      constat: 'Des comparaisons utilisent `==` ou `!=` avec conversion de type implicite.',
      impact: "`'0' == false` vaut vrai, `[] == false` aussi : ces conversions produisent des défauts difficiles à reproduire, en particulier sur des valeurs de cellules Grist qui peuvent être nulles, vides ou numériques.",
      remediation: 'Utiliser `===` et `!==`.',
      preuve: { emplacements: laches.slice(0, 20) },
    }));
  }
  if (vars.length > 20) {
    constats.push(constat({
      regle: 'A-LANG-02', axe: 'A', severite: 'mineur', confiance: 'certain',
      titre: `${vars.length} déclarations \`var\``,
      fichier: vars[0].fichier, ligne: vars[0].ligne,
      constat: 'Le code utilise massivement `var` plutôt que `let` / `const`.',
      impact: "`var` remonte au niveau de la fonction : une variable reste visible en dehors du bloc où elle a été déclarée, ce qui produit des collisions silencieuses dans les fonctions longues.",
      remediation: 'Remplacer par `const` par défaut, `let` si réaffectation.',
      preuve: { emplacements: vars.slice(0, 20) },
    }));
  }
  return constats;
}

/**
 * Code syntaxiquement inatteignable : instructions placées après un
 * `return` / `throw` / `break` / `continue` dans le même bloc. Volontairement
 * restreint à ce cas non ambigu (pas d'analyse d'exhaustivité des branches
 * if/else) : le guide demande un widget « minimal, sans code mort », et un
 * faux positif ici coûterait plus cher à la confiance dans l'outil que ce
 * que rapporterait une détection plus large.
 */
const TERMINALES = new Set(['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement']);

export function analyserCodeInatteignable(ctx) {
  const constats = [];
  const trouvailles = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    const verifierListe = (liste) => {
      if (!Array.isArray(liste)) return;
      let mort = false;
      for (const stmt of liste) {
        if (mort && stmt.type !== 'FunctionDeclaration') {
          trouvailles.push({ fichier: unite.chemin, ligne: ligneDe(stmt) });
        }
        if (!mort && TERMINALES.has(stmt.type)) mort = true;
      }
    };
    walk.simple(ast, {
      Program(n) { verifierListe(n.body); },
      BlockStatement(n) { verifierListe(n.body); },
      SwitchCase(n) { verifierListe(n.consequent); },
    });
  });

  if (trouvailles.length) {
    constats.push(constat({
      regle: 'A-MORT-01', axe: 'A', severite: trouvailles.length > 3 ? 'majeur' : 'mineur', confiance: 'certain',
      titre: `${trouvailles.length} instruction(s) syntaxiquement inatteignable(s)`,
      fichier: trouvailles[0].fichier, ligne: trouvailles[0].ligne,
      constat: "Du code apparaît après un `return`, `throw`, `break` ou `continue` dans le même bloc : il ne s'exécute jamais.",
      impact: "Le guide demande un widget « minimal […], sans code mort ». Du code structurellement inatteignable trompe le relecteur sur le comportement réel du widget, et signale parfois une erreur de logique (un `return` placé trop tôt par mégarde).",
      remediation: "Supprimer les instructions mortes, ou déplacer le `return` / `throw` / `break` / `continue` si le code qui suit devait réellement s'exécuter.",
      referentiels: ['Guide de contribution Grist.Gouv — « Minimal: no unnecessary dependencies, no dead code »', 'CWE-561'],
      preuve: { emplacements: trouvailles.slice(0, 20) },
    }));
  }
  return constats;
}

export const reglesA = [
  analyserTailleFichiers, analyserFonctions, analyserGestionErreurs,
  analyserTracesDev, analyserDuplication, analyserTests, analyserPratiques,
  analyserCodeInatteignable,
];
