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
import { pourChaqueUniteJs, nomPointe, aCommentaireDansPortee, ligneFinDans, erreurDeParcours } from '../moteur/analyse-js.js';
import { numeroLigne } from '../moteur/lignes.js';
import { mesurerFonction, mesurerProgramme, nomDeFonction, nomDuNiveauSuperieur, estAutoAppelee } from '../moteur/fonctions.js';
import { mesurerLignes, NOTE_LIGNES_APPROCHEES } from '../moteur/lignes-de-code.js';
import { creerRecherche } from '../moteur/clones.js';
import { aSignatureDeBundleur } from '../contexte/inventaire.js';
import { citerSiBesoin } from '../moteur/texte-du-widget.js';
import { analyserEfficacite } from './a-efficacite.js';

const SEUILS = {
  fichierLong: 600,        // lignes de code
  fichierTresLong: 1200,
  fonctionLongue: 80,
  fonctionTresLongue: 200,
  complexite: 15,
  complexiteForte: 30,
  imbrication: 5,
  ligneLongue: 160,
};

/**
 * Une carte de sources (`.map`) est générée par l'empaqueteur et embarque le texte des sources, celles des bibliothèques tierces
 * comprises : le contributeur ne l'a pas écrite, et ce qu'elle contient (marqueurs de travail inachevé, adresses de bibliothèques
 * qui parlent d'un navigateur) ne dit rien de son travail ni de ses tests. Les règles qui cherchent ces signes dans le texte de
 * tout le dépôt (A-DEV-03, A-TEST-02) la laissent donc de côté.
 */
const estCarteDeSources = (f) => f.ext === '.map';

/** Taille des fichiers du code exécuté, en lignes de code (ni lignes vides, ni commentaires seuls). */
export function analyserTailleFichiers(ctx) {
  const constats = [];
  const gros = ctx.fichiers
    .filter((f) => f.executee && !f.vendorise && !f.dossierExclu && ['.js', '.mjs'].includes(f.ext) && f.contenu)
    .map((f) => ({ f, ...mesurerLignes(f) }))
    .filter((m) => m.code > SEUILS.fichierLong)
    .sort((a, b) => b.code - a.code);

  for (const { f, code, exacte } of gros) {
    const tresLong = code > SEUILS.fichierTresLong;
    constats.push(constat({
      regle: 'A-TAILLE-01', axe: 'A', severite: tresLong ? 'majeur' : 'mineur', confiance: 'certain',
      titre: `Fichier de ${code} lignes de code : ${f.chemin}`,
      fichier: f.chemin,
      constat: `Le fichier dépasse le seuil de ${tresLong ? SEUILS.fichierTresLong : SEUILS.fichierLong} lignes de code (hors commentaires et lignes vides).${exacte ? '' : NOTE_LIGNES_APPROCHEES}`,
      impact: "Le guide demande qu'un relecteur puisse lire la logique du widget « en une seule fois ». Au-delà d'un millier de lignes dans un fichier, la revue devient un survol : c'est souvent là que passent les défauts.",
      remediation: 'Découper par responsabilité (rendu, accès aux données, export…) en modules ES importés depuis un point d\'entrée.',
      referentiels: ['Guide de contribution Grist.Gouv — « Reviewers should be able to read your widget\'s logic in one sitting »'],
    }));
  }
  return constats;
}

/** Le groupe nominal d'une fonction (« la fonction `f` »), mis au début d'une phrase. */
const enPhrase = (groupe) => groupe.charAt(0).toUpperCase() + groupe.slice(1);

/** Le constat de complexité (A-FONC-02) d'une unité de code : une fonction, ou le niveau supérieur d'un script. `nom` : `{ titre, groupe }`. */
function constatComplexite(chemin, ligne, nom, complexite) {
  const forte = complexite > SEUILS.complexiteForte;
  return constat({
    regle: 'A-FONC-02', axe: 'A', severite: forte ? 'majeur' : 'mineur', confiance: 'certain',
    titre: `Complexité cyclomatique de ${complexite} : ${nom.titre}`,
    fichier: chemin, ligne,
    constat: `${enPhrase(nom.groupe)} comporte ${complexite} chemins d'exécution indépendants (seuil retenu : ${SEUILS.complexite}).`,
    impact: `Il faut au minimum ${complexite} cas de test pour couvrir tous les chemins. En pratique ils ne seront pas tous testés, et les branches rares porteront les défauts.`,
    remediation: 'Extraire les branches en fonctions distinctes, ou remplacer les cascades de conditions par une table de correspondance.',
    referentiels: ['Métrique de McCabe'],
  });
}

/** Le constat d'imbrication (A-FONC-03) d'une unité de code. Le niveau supérieur d'un script n'a pas de `return` anticipé : le conseil n'est pas le même. */
function constatImbrication(chemin, ligne, nom, imbrication, dansUneFonction) {
  return constat({
    regle: 'A-FONC-03', axe: 'A', severite: 'mineur', confiance: 'certain',
    titre: `Imbrication de profondeur ${imbrication} : ${nom.titre}`,
    fichier: chemin, ligne,
    constat: `${enPhrase(nom.groupe)} atteint ${imbrication} niveaux de blocs imbriqués.`,
    impact: "Au-delà de quatre ou cinq niveaux, le lecteur perd le fil des conditions actives à un point donné.",
    remediation: dansUneFonction
      ? 'Sortir tôt (`return` anticipé), extraire les blocs internes.'
      : 'Extraire les blocs internes en fonctions nommées, que le script appelle.',
  });
}

/**
 * Longueur, complexité cyclomatique et imbrication des fonctions, chacune sur son propre corps (voir `moteur/fonctions.js`). Une fonction
 * appelée là où elle est écrite, l'enveloppe d'un module `(function () { … })()`, ne se mesure en longueur que sur ses lignes propres : celles
 * des fonctions qu'elle contient sont comptées pour chacune, et la taille du fichier est dite par A-TAILLE-01. Une enveloppe de dix lignes qui
 * contient trente fonctions n'est pas « une fonction de neuf cents lignes ».
 * Le code qui n'est dans aucune fonction (le niveau supérieur d'un fichier, d'un script de page) se mesure de la même façon, en complexité et en
 * imbrication : un widget écrit à plat ne vaut pas mieux que le même code dans une fermeture. Sa longueur reste dite par A-TAILLE-01.
 */
export function analyserFonctions(ctx) {
  const constats = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;

    const niveauSuperieur = mesurerProgramme(ast);
    if (niveauSuperieur.complexite > SEUILS.complexite) {
      constats.push(constatComplexite(unite.chemin, ligneDe(niveauSuperieur.premiere), nomDuNiveauSuperieur(unite), niveauSuperieur.complexite));
    }
    if (niveauSuperieur.imbrication > SEUILS.imbrication) {
      constats.push(constatImbrication(unite.chemin, ligneDe(niveauSuperieur.plusProfonde), nomDuNiveauSuperieur(unite), niveauSuperieur.imbrication, false));
    }

    const visiter = (n, _etat, ancetres) => {
      const { complexite, imbrication, etendue, lignesPropres } = mesurerFonction(n);
      const autoAppelee = estAutoAppelee(n, ancetres);
      const lignes = autoAppelee ? lignesPropres : etendue;

      if (lignes > SEUILS.fonctionLongue) {
        const tres = lignes > SEUILS.fonctionTresLongue;
        const nom = nomDeFonction(n, ancetres);
        constats.push(constat({
          regle: 'A-FONC-01', axe: 'A', severite: tres ? 'majeur' : 'mineur', confiance: 'certain',
          titre: `Fonction de ${lignes} lignes : ${nom.titre}`,
          fichier: unite.chemin, ligne: ligneDe(n),
          constat: etendue > lignes
            ? `${enPhrase(nom.groupe)} occupe ${lignes} lignes en propre, sans compter les ${etendue - lignes} lignes des fonctions qu'elle contient, mesurées chacune à part.`
            : `${enPhrase(nom.groupe)} s'étend sur ${lignes} lignes.`,
          impact: "Une fonction trop longue ne tient pas dans un écran ni dans la tête du relecteur : on ne peut plus vérifier qu'elle fait bien ce que son nom annonce, ni la tester unitairement.",
          remediation: 'Extraire les étapes internes en fonctions nommées, chacune testable isolément.',
        }));
      }
      if (complexite > SEUILS.complexite) {
        constats.push(constatComplexite(unite.chemin, ligneDe(n), nomDeFonction(n, ancetres), complexite));
      }
      if (imbrication > SEUILS.imbrication) {
        constats.push(constatImbrication(unite.chemin, ligneDe(n), nomDeFonction(n, ancetres), imbrication, true));
      }
    };
    walk.ancestor(ast, {
      FunctionDeclaration: visiter,
      FunctionExpression: visiter,
      ArrowFunctionExpression: visiter,
    });
  });
  return constats;
}

/** Gestion d'erreur silencieuse : `catch` vide ou qui avale l'erreur. */
export function analyserGestionErreurs(ctx) {
  const constats = [];
  pourChaqueUniteJs(ctx, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      CatchClause(n) {
        const corps = n.body.body;
        // Un corps vide MAIS commenté est un repli documenté (ex. stockage
        // best-effort dans un contexte où l'échec est attendu et sans
        // conséquence), pas une erreur avalée en silence : le commentaire
        // porte l'explication que la règle cherche à imposer. acorn ne
        // rattache aucun commentaire aux nœuds par défaut, d'où le passage
        // par `ast.commentaires` (voir `aCommentaireDansPortee`).
        if (corps.length === 0 && !aCommentaireDansPortee(ast, n.body)) {
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

/**
 * Un marqueur de travail inachevé : le mot entier, suivi d'une espace ou de deux-points.
 * `\b` ne borne que des caractères de mot ASCII, et « À » n'en est pas un : devant « À FAIRE »,
 * il ne trouvait de frontière que si le caractère d'avant était une lettre ou un chiffre, donc
 * le marqueur ne correspondait qu'accolé à un mot (« xÀ FAIRE ») et jamais isolé. Le marqueur
 * accentué a sa propre borne (ni lettre, ni chiffre, ni soulignement avant lui), et son propre groupe.
 */
const MARQUEUR_INACHEVE = /(?:\b(TODO|FIXME|XXX|HACK|BUG)|(?<![\p{L}\p{N}_])(À FAIRE))\b[ :]/gu;

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
    if (!f.contenu || f.binaire || f.vendorise || f.dossierExclu || estCarteDeSources(f)) continue;
    for (const m of f.contenu.matchAll(MARQUEUR_INACHEVE)) {
      marqueurs.push({ fichier: f.chemin, ligne: numeroLigne(f.contenu, m.index), type: m[1] ?? m[2] });
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
      preuve: { emplacements: consoles },
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
      preuve: { emplacements: marqueurs },
    }));
  }
  return constats;
}

/** Le nombre de clones, et d'exemplaires par clone, que la preuve de A-DUP-01 garde : les plus gros ; le titre dit le total, `groupesOmis` et `instancesOmises` le reste. */
const MAX_CLONES_DANS_LA_PREUVE = 100;
const MAX_EXEMPLAIRES_DANS_LA_PREUVE = 20;

/** Le nombre de clones que le texte de A-DUP-01 décrit : les plus gros. */
const CLONES_DITS = 3;

/** Au-delà de ce nombre d'exemplaires, un clone est une duplication massive, majeure à elle seule : un plafond qui laisserait passer sans rien dire le code répété plus souvent ferait gagner à répéter. */
const EXEMPLAIRES_MAJEUR = 5000;

/** Le nombre de fichiers dont A-DUP-00 dit le nom : quelques-uns, pas les dix mille d'un dépôt hostile. */
const MAX_NOMMES = 10;

/**
 * Un code qu'on dit minifié : des lignes de plus de 200 caractères en moyenne, sur plus de 1 Kio. Rien sur le nombre de lignes : une seule ligne de 20 Kio l'est. Le plancher
 * laisse hors de cause un court script d'une page, sans écarter les morceaux de quelques Kio qu'un empaqueteur découpe (les morceaux d'une même bibliothèque, minifiés,
 * se ressemblent entre eux : comparés, ils feraient du code de la bibliothèque un défaut du widget).
 */
const MINIFIE = { ligneMoyenne: 200, taille: 1024 };

/** Ce que les outils de génération écrivent en tête de leur sortie (`@generated`, « DO NOT EDIT », « auto-generated »…), lu dans les premiers caractères d'un fichier ou d'un script de page. */
const MARQUE_DE_GENERATION = /@generated\b|\bDO NOT EDIT\b|\bauto-?generated\b|\bautomatically generated\b|\bcode generated\b/i;
const DEBUT_LU = 5000;

/** Pourquoi on ne compare pas ce code, dans l'ordre où A-DUP-00 le dit : la clé de `raisonDeNePasComparer` et ce qu'il en dit. */
const RAISONS_DE_NE_PAS_COMPARER = [
  ['tierce', 'de bibliothèques tierces ou de code construit (dossiers vendor, node_modules, dist…) ne sont pas comparés'],
  ['minifiee', `minifiés (lignes de plus de ${MINIFIE.ligneMoyenne} caractères en moyenne) ne sont pas comparés`],
  ['empaquetee', 'empaquetés par un outil de build ne sont pas comparés'],
  ['generee', "générés par un outil et que la page n'exécute pas ne sont pas comparés"],
];

/** Un texte minifié : sans condition sur le nombre de lignes, qu'un code minifié n'a pas. */
function estMinifie(texte) {
  if (texte.length <= MINIFIE.taille) return false;
  let lignes = 1;
  for (let i = texte.indexOf('\n'); i !== -1; i = texte.indexOf('\n', i + 1)) lignes++;
  return texte.length / lignes > MINIFIE.ligneMoyenne;
}

/** L'en-tête de la page ou du fichier, ou celui du script, dit-il qu'un outil a généré le code ? */
const estGenere = (fichier, unite) => [fichier.contenu, unite.source].some((texte) => MARQUE_DE_GENERATION.test(texte.slice(0, DEBUT_LU)));

/**
 * Pourquoi une unité n'entre pas dans la comparaison, ou null : le code d'un autre (une bibliothèque, ce qu'un outil a construit), le code qu'aucun humain ne relit
 * (minifié, empaqueté), ce qu'un outil a généré et que la page n'exécute pas. Une bannière de licence n'y change rien, et le code généré que la page exécute se compare :
 * rien ne s'esquive en s'en disant l'auteur.
 */
function raisonDeNePasComparer(fichier, unite) {
  if (fichier.vendorise || fichier.dossierExclu) return 'tierce';
  if (estMinifie(unite.source)) return 'minifiee';
  if (aSignatureDeBundleur(unite.source)) return 'empaquetee';
  if (!fichier.executee && estGenere(fichier, unite)) return 'generee';
  return null;
}

/** Au-delà de ce nombre de caractères, le chemin d'un fichier du widget n'est cité que par sa fin : le nom du fichier se lit, un chemin de milliers de caractères ne remplit pas un constat. */
const LONGUEUR_CHEMIN_CITE = 120;

/** Le chemin d'un fichier du widget tel qu'une phrase de constat le dit : borné, en extrait de code, cité quand un de ses caractères a un sens pour une sortie. */
function cheminEnCode(chemin) {
  const borne = chemin.length > LONGUEUR_CHEMIN_CITE ? `…${chemin.slice(-LONGUEUR_CHEMIN_CITE).toWellFormed()}` : chemin;
  const cite = citerSiBesoin(borne);
  return cite === borne ? `\`${borne}\`` : cite;
}

/** Où se trouve un exemplaire d'un clone : `js/a.js` lignes 10 à 45. */
const endroit = (e) => `${cheminEnCode(e.chemin)} lignes ${e.ligne} à ${e.ligneFin}`;

/** Un clone en une phrase : ses deux premiers exemplaires, les autres comptés, et sa taille. */
function direClone(c) {
  const autres = c.instances.length - 2;
  return `${endroit(c.instances[0])} et ${endroit(c.instances[1])}${autres > 0 ? ` (et ${autres} autre${autres > 1 ? 's' : ''})` : ''}, ${c.lignes} lignes`;
}

/** Le constat des clones trouvés (A-DUP-01) : un seul pour tout le dépôt, les clones dans sa preuve. */
function constatDuplication(clones, exemplairesMajeur) {
  const entreFichiers = clones.filter((c) => new Set(c.instances.map((e) => e.chemin)).size > 1);
  const enTest = clones.filter((c) => c.instances.every((e) => estFichierDeTest(e.chemin)));
  const massifs = clones.filter((c) => c.instances.length > exemplairesMajeur);
  const lignesCopiees = clones.reduce((total, c) => total + c.lignes * (c.instances.length - 1), 0);
  const plusGros = clones[0].instances[0];
  return constat({
    regle: 'A-DUP-01', axe: 'A',
    severite: entreFichiers.length > 5 || massifs.length ? 'majeur' : 'mineur', confiance: 'probable',
    titre: `${clones.length} bloc(s) de code dupliqué(s)${entreFichiers.length ? `, dont ${entreFichiers.length} entre fichiers différents` : ''}`,
    fichier: plusGros.chemin, ligne: plusGros.ligne,
    constat: `Des fonctions, des blocs ou des suites d'instructions se répètent à l'identique, ou aux noms et aux valeurs près : environ ${lignesCopiees} lignes sont la copie d'un autre endroit. Seul ce qui porte de la logique compte, ni les tableaux de données, ni les suites d'appels du même nom. Les plus gros : ${clones.slice(0, CLONES_DITS).map(direClone).join(' ; ')}.`
      + (enTest.length ? ` ${enTest.length} de ces blocs sont entièrement dans des fichiers de test.` : '')
      + (massifs.length ? ` ${massifs.length} bloc(s) sont répétés plus de ${exemplairesMajeur} fois : une duplication massive.` : ''),
    impact: "Le guide le dit explicitement : « un défaut corrigé à un endroit restera silencieusement présent dans les autres ». La duplication entre fichiers est aussi ce qui fait grossir le temps de revue sans rien apporter.",
    remediation: 'Extraire la logique partagée dans une fonction ou un module commun, appelé par chacun des emplacements.',
    referentiels: ['Guide de contribution Grist.Gouv — « Duplicated code is harder to review and creates maintenance debt »'],
    preuve: {
      groupes: clones.slice(0, MAX_CLONES_DANS_LA_PREUVE).map((c) => ({
        forme: c.forme, type: c.type, lignes: c.lignes, masse: c.masse,
        instances: c.instances.slice(0, MAX_EXEMPLAIRES_DANS_LA_PREUVE).map((e) => ({ fichier: e.chemin, ligne: e.ligne, ligneFin: e.ligneFin })),
        ...(c.instances.length > MAX_EXEMPLAIRES_DANS_LA_PREUVE ? { instancesOmises: c.instances.length - MAX_EXEMPLAIRES_DANS_LA_PREUVE } : {}),
      })),
      ...(clones.length > MAX_CLONES_DANS_LA_PREUVE ? { groupesOmis: clones.length - MAX_CLONES_DANS_LA_PREUVE } : {}),
    },
  });
}

/**
 * Ce que la recherche n'a pas comparé (A-DUP-00, une information) : l'absence de A-DUP-01 ne dit rien de ces parties. Du code que la page exécute qu'un plafond a laissé
 * de côté, ou qu'une erreur de l'outil a interrompu, rend la mesure partielle : l'axe garde ce qu'il a vu, sans prix, et le verdict ne peut pas être CONFORME sans réserve.
 * @param {{laissees: Object<string, number>, trop: Array<{chemin: string, executee: boolean}>, executeesLues: number}} bilan
 * @param {{pasEpuises: boolean, echec?: string}} limites `echec` : ce que dit l'erreur qui a interrompu la recherche
 */
function constatCodeNonCompare({ laissees, trop, executeesLues }, limites) {
  const causes = RAISONS_DE_NE_PAS_COMPARER.filter(([raison]) => laissees[raison]).map(([raison, texte]) => `${laissees[raison]} fichier(s) ou script(s) ${texte}`);
  const tropExecutes = trop.filter((u) => u.executee).length;
  if (trop.length) {
    const chemins = [...new Set(trop.map((u) => u.chemin))];                    // une page à plusieurs scripts n'est nommée qu'une fois
    causes.push(`${trop.length} fichier(s) ou script(s) trop volumineux pour être gardés en mémoire${tropExecutes ? ` (dont ${tropExecutes} que la page exécute)` : ''} n'ont pas été comparés (${chemins.slice(0, MAX_NOMMES).map(cheminEnCode).join(', ')}${chemins.length > MAX_NOMMES ? ', …' : ''})`);
  }
  if (limites.pasEpuises) causes.push("la recherche a atteint le plafond de travail fixé et s'est arrêtée avant la fin");
  if (limites.echec) causes.push(`la recherche s'est interrompue sur une erreur de l'outil (${limites.echec}) : aucun clone n'a été rendu`);
  if (!causes.length) return null;
  const partielle = tropExecutes > 0 || ((limites.pasEpuises || Boolean(limites.echec)) && executeesLues > 0);
  return constat({
    regle: 'A-DUP-00', axe: 'A', severite: 'info', confiance: 'certain',
    titre: partielle ? "Du code que la page exécute n'a pas été comparé par la recherche de code dupliqué" : 'Code laissé de côté par la recherche de code dupliqué',
    constat: `La recherche de code dupliqué n'a pas tout comparé : ${causes.join(' ; ')}.`,
    impact: "Du code dupliqué peut subsister dans ce qui n'a pas été comparé : l'absence de constat A-DUP-01 ne dit rien de ces parties.",
    remediation: "Rien à corriger pour cela : c'est ce que l'outil ne compare pas, dit pour que l'absence de constat ne passe pas pour une preuve. Du code minifié, empaqueté ou trop volumineux se relit dans ses sources, à part.",
    mesurePartielle: partielle,
  });
}

/** La recherche, ou ce qu'une erreur de l'outil (la mémoire, la pile) en a laissé : l'audit ne s'arrête pas pour elle, A-DUP-00 la dit. */
function chercherSansAbandon(recherche) {
  try {
    return recherche.chercher();
  } catch (e) {
    return { clones: [], limites: { pasEpuises: false, echec: erreurDeParcours(e).message } };
  }
}

/**
 * L'ordre où les unités entrent dans la recherche : le code exécuté d'abord, puis du plus court au plus long, puis par chemin. Les nœuds gardés ont un plafond pour tout le
 * dépôt, et ce qui ne tient pas n'est pas comparé : mieux vaut que ce soit le plus gros fichier, ou du code que la page ne charge pas, que du code que le widget exécute, et
 * que le choix ne tombe pas sur les derniers noms de l'inventaire, quels qu'ils soient.
 */
const ordreDesUnites = (a, b) => Number(Boolean(b.fichier.executee)) - Number(Boolean(a.fichier.executee))
  || a.unite.source.length - b.unite.source.length
  || (a.unite.chemin < b.unite.chemin ? -1 : a.unite.chemin > b.unite.chemin ? 1 : 0);

/**
 * Duplication de code, explicitement visée par le guide : des fonctions, des blocs et des suites d'instructions qui se répètent, à l'identique ou aux noms et
 * aux valeurs près (voir `moteur/clones.js`), dans un fichier ou entre fichiers. Tout le code lisible qui n'est pas celui d'un autre se compare, exécuté ou non, tests
 * compris ; le code des scripts de page se compare comme celui des fichiers. Ce qui ne se compare pas est dit (A-DUP-00).
 * `seuils` : ceux de la recherche (les essais les abaissent ; la suite des règles n'en donne aucun) ; `exemplairesMajeur` : le nombre d'exemplaires d'un clone qui en fait un constat majeur.
 */
export function analyserDuplication(ctx, { seuils, exemplairesMajeur = EXEMPLAIRES_MAJEUR } = {}) {
  const recherche = creerRecherche(seuils);
  const bilan = { laissees: {}, trop: [], executeesLues: 0 };
  const garder = ({ fichier, unite }) => {
    const raison = raisonDeNePasComparer(fichier, unite);
    if (raison) bilan.laissees[raison] = (bilan.laissees[raison] ?? 0) + 1;
    return !raison;
  };
  pourChaqueUniteJs(ctx, { garder, ordre: ordreDesUnites }, ({ ast, unite, fichier, ligneDe }) => {
    const gardee = recherche.ajouter({ chemin: unite.chemin, ast, ligneDe, ligneFinDe: (noeud) => ligneFinDans(unite, noeud) });
    if (!gardee) bilan.trop.push({ chemin: unite.chemin, executee: Boolean(fichier.executee) });
    else if (fichier.executee) bilan.executeesLues++;
  });
  const { clones, limites } = chercherSansAbandon(recherche);
  return [...(clones.length ? [constatDuplication(clones, exemplairesMajeur)] : []), ...[constatCodeNonCompare(bilan, limites)].filter(Boolean)];
}

/** Présence et nature des tests, exigence explicite du guide. */
// `(^|\/)(tests?...)\/ ` exigeait la limite de segment juste avant, donc
// ratait `dev-tests/` (le `dev-` est collé, pas séparé par `/`) : un vrai
// dossier de tests substantiel se voyait déclaré absent. `[/\\_-]` élargit
// la frontière acceptée à `-`/`_`/`\` en plus de `/`, ce qui attrape
// `dev-tests/`, `test-utils/`, `unit_tests/` sans capturer `latest.js` ou
// `contest.js` (le caractère juste avant `test` y est une lettre, pas une
// frontière). Le `\` compte : `ctx.fichiers[].chemin` vient de
// `path.relative()` (src/contexte/inventaire.js), qui rend un séparateur
// natif — donc `\` sous Windows, jamais normalisé en `/`. Un motif qui
// n'accepte que `/` repasserait à côté du même `dev-tests\...` sur cette
// plateforme, exactement le bug qu'on corrige ici.
const CHEMIN_TEST_UNITAIRE = /(^|[/\\_-])tests?([/\\_-]|$)/i;
// Même défaut côté e2e : `require('/opt/.../playwright')` ne matche ni
// `require(['"]puppeteer` ni `from ['"]playwright`, alors que c'est
// exactement la preuve qu'un vrai Chromium est piloté. On élargit à
// `playwright` n'importe où dans un require/import (pas seulement en
// spécificateur de module nu), et aux appels caractéristiques de
// Playwright/Puppeteer eux-mêmes plutôt qu'au nom exact du paquet cité.
const CONTENU_TEST_E2E = /require\(['"][^'"]*playwright|from\s+['"][^'"]*playwright|@playwright\/test|require\(['"]puppeteer|\.launch\(|\.newPage\(|\bchromium\./i;

const estFichierDeTest = (chemin) => CHEMIN_TEST_UNITAIRE.test(chemin) || /\.(test|spec)\.(m?js|ts|jsx|tsx)$/i.test(chemin);

export function analyserTests(ctx) {
  const constats = [];
  const testsUnitaires = ctx.fichiers.filter((f) => estFichierDeTest(f.chemin));
  const e2e = ctx.fichiers.filter((f) =>
    /(playwright|cypress|puppeteer|e2e|integration|browser)/i.test(f.chemin) ||
    (f.contenu && !estCarteDeSources(f) && CONTENU_TEST_E2E.test(f.contenu)));

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
      preuve: { emplacements: laches },
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
      preuve: { emplacements: vars },
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
      preuve: { emplacements: trouvailles },
    }));
  }
  return constats;
}

export const reglesA = [
  analyserTailleFichiers, analyserFonctions, analyserGestionErreurs,
  analyserTracesDev, analyserDuplication, analyserTests, analyserPratiques,
  analyserCodeInatteignable, analyserEfficacite,
];
