/**
 * Ce que le code de la surface charge par une adresse http(s) d'une autre origine que celle
 * des fichiers du widget (`import 'https://…'`, `export … from`, `import()` à littéral), et ce
 * qui protège chaque chargement. Un `import './a.js'` charge un fichier du widget, lu par
 * l'audit : il n'est pas retenu ici (voir le filtre du parcours).
 *
 * Un seul lecteur pour C-EXFIL-01 (d'où vient le code chargé) et E-DEP-01 (avec quelle
 * empreinte) : ce que l'un voit, l'autre le voit, et les deux disent la même chose de la
 * protection. Une empreinte, ici, est la clé `integrity` d'une import map de la page ;
 * Chromium 141 l'applique à ce qu'un document charge (`<script type="module" src>`,
 * `import`, `export … from`, `import()`), à l'adresse résolue, et jamais dans un worker
 * (Worker, SharedWorker, service worker, worklet, ni ce qu'ils importent), même quand la
 * page charge le même fichier ailleurs. Elle ne compte que si la carte est lue AVANT
 * la balise qui commence le chargement (mesuré : une page livrée en deux morceaux exécute
 * le module du premier morceau sans la vérifier), ni si un `<link rel="modulepreload">` de
 * la même adresse l'a chargé avant la carte ou avec un attribut `integrity` propre
 * (mesuré : le module que le code importe ensuite est celui-là). Un chargement n'est donc
 * protégé que si chaque document qui le charge porte une empreinte valide de cette adresse
 * dans une carte qui précède le script chargeur et tout lien de préchargement du module,
 * et qu'aucun worker ne peut l'exécuter.
 */
import { pourChaqueUniteJs, unitesJs, visiteursDImports, adressesProtegeesParEmpreinte, modulepreloadsDeLaPage, lienQuiBriseLEmpreinte, nomPointe } from '../moteur/analyse-js.js';
import { classifierSourceWorker, extraireCodeLitteralWorker, nomFinal } from '../moteur/litteraux.js';
import { ORIGINE_LOCALE } from '../moteur/base-url.js';
import { lirePage } from '../moteur/page-html.js';
import { NOM_ENREGISTREMENT, NOM_MODULE_DE_WORKLET } from './inventaire.js';

const estPage = (f) => ['.html', '.htm'].includes(f.ext);

/** La première unité (dans l'ordre du document) dont les lignes couvrent `ligne` : les unités ne se chevauchent pas, leurs dernières lignes croissent, une recherche par dichotomie suffit (une page de quelques dizaines de milliers de scripts ne coûte pas un produit). */
function uniteCouvrant(unites, ligne) {
  let bas = 0;
  let haut = unites.length;
  while (bas < haut) {
    const milieu = (bas + haut) >> 1;
    if (unites[milieu].finLigne < ligne) bas = milieu + 1;
    else haut = milieu;
  }
  const unite = unites[bas];
  return unite && unite.debutLigne <= ligne ? unite : undefined;
}

/** Les pages de deux listes de rangs croissantes et disjointes, dans l'ordre des rangs, lues au fur et à mesure : qui s'arrête tôt n'a rien payé du reste. */
function* fusionnerLesPages(pages, a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) yield pages[j >= b.length || (i < a.length && a[i] < b[j]) ? a[i++] : b[j++]];
}

export const RAISON_SANS_EMPREINTE = "aucune empreinte dans la clé `integrity` d'une import map de la page qui le charge";
export const RAISON_CHARGEUR_INCONNU = "aucune balise de la page ne peut être établie comme celle qui charge ce module : l'empreinte de l'import map ne peut pas être garantie";
export const RAISON_WORKER = "exécuté par un worker, où Chromium n'applique pas l'import map de la page : une empreinte n'y protège rien";
/** Le chargeur est inconnu parce que le budget d'analyse des documents est épuisé : la même raison, avec sa cause. */
export const RAISON_BUDGET_EPUISE = `${RAISON_CHARGEUR_INCONNU}, et le budget d'analyse des documents est épuisé (trop de pages d'entrée qui partagent trop de modules) : ce chargement est compté comme non protégé`;

/** La carte qui porte l'empreinte est lue après la balise qui charge le module : Chromium 141 n'applique l'empreinte qu'aux chargements qui commencent après elle (une page lue en deux temps exécute le module sans la vérifier). */
export const raisonCarteTardive = (ligneCarte, ligneChargeur) => `l'import map de la page qui porte l'empreinte (ligne ${ligneCarte}) est lue après le script qui le charge (ligne ${ligneChargeur}) : Chromium n'applique l'empreinte qu'aux chargements qui commencent après la carte, et le module s'exécute sans elle quand la page est lue en deux temps ; placer l'import map avant tout script qui charge du code`;
/** Même cas pour un `<script type="module" src>` : la balise résout son adresse quand elle est lue, avant de voir la carte (mesuré dans Chromium 141 : le module s'exécute, page livrée d'un bloc ou en deux morceaux). */
export const raisonCarteTardiveBalise = (ligneCarte, ligneBalise) => `l'import map de la page qui porte l'empreinte de cette adresse (ligne ${ligneCarte}) est lue après cette balise (ligne ${ligneBalise}) : Chromium résout l'adresse de la balise avant de lire la carte, et l'empreinte ne s'applique pas ; placer l'import map avant la balise`;
/** Une entrée d'import map dont l'empreinte n'est portée que par une carte lue après elle. */
export const raisonEntreeCarteTardive = (ligneCarte) => `l'empreinte de cette adresse n'est portée que par une import map lue après cette entrée (ligne ${ligneCarte}) : une empreinte ne compte que pour les chargements qui commencent après la carte qui la porte ; la déclarer dans la carte qui contient l'entrée, ou dans une carte qui la précède`;
/**
 * Un `<link rel="modulepreload">` a chargé le module sans l'empreinte de la carte : lu avant elle (le module qu'un import trouve ensuite est celui du lien), ou muni d'un attribut `integrity` vide ou mal formé, qui l'emporte sur la carte.
 * @param {number} ligneCarte la ligne de la carte qui porte l'empreinte
 * @param {{ ligne: number, attribut: boolean }} lien le lien (voir `lienQuiBriseLEmpreinte`)
 */
export const raisonLienDePrechargement = (ligneCarte, lien) => lien.attribut
  ? `le \`<link rel="modulepreload">\` de cette adresse (ligne ${lien.ligne}) porte un attribut \`integrity\` vide ou mal formé : Chromium ne consulte plus l'import map pour ce lien, le module qu'il charge sans vérification est celui que le code importe ensuite ; corriger l'attribut (une empreinte bien formée) ou retirer le lien`
  : `l'import map de la page qui porte l'empreinte (ligne ${ligneCarte}) est lue après le \`<link rel="modulepreload">\` de cette adresse (ligne ${lien.ligne}) : Chromium charge le module dès ce lien, avant de lire la carte, et le module qu'un import trouve ensuite est celui-là, sans l'empreinte ; placer l'import map avant le lien, ou porter l'empreinte dans l'attribut \`integrity\` du lien`;
/** Les raisons pour lesquelles l'empreinte que porte la carte de cette entrée ne la protège pas (liste vide : elle la protège). `e` : une entrée de `extraireImportMaps` ; `lue` : la page lue (`lirePage`). */
export function raisonsEntreeNonProtegee(e, lue) {
  if (e.sri || e.carte === undefined) return [];
  return [
    ...(e.carte > e.index ? [raisonEntreeCarteTardive(lue.positionDe(e.carte).ligne)] : []),
    ...(e.lien ? [raisonLienDePrechargement(lue.positionDe(e.carte).ligne, e.lien)] : []),
  ];
}
export const raisonWorkerNonResolu = (lieu) => `le widget crée un worker dont l'adresse n'est pas résolue (${lieu}) : il peut exécuter n'importe quel fichier du widget, et Chromium n'applique pas l'import map de la page à un worker`;

const memo = new WeakMap();

/**
 * @typedef {object} Protection
 * @property {boolean} sri l'empreinte d'une import map protège ce chargement
 * @property {string[]} raisons ce qui l'en empêche, toutes les raisons qui valent (corriger l'une sans les autres ne suffirait pas)
 * @property {?('worker'|'worker-non-resolu')} obstacle ce que l'empreinte ne peut pas lever : le fichier s'exécute dans un worker, ou un worker d'adresse inconnue peut l'exécuter
 */

/**
 * @typedef {object} ImportDistant
 * @property {object} noeud le nœud de l'import dans l'AST de l'unité
 * @property {'import statique'|'export … from'|'import() distant'} canal
 * @property {string} valeur l'adresse telle qu'elle est écrite
 * @property {URL} url l'adresse résolue
 * @property {object} unite l'unité de code qui le porte (voir `unitesJs`)
 * @property {object} fichier le fichier de cette unité
 * @property {number} ligne sa ligne dans ce fichier
 * @property {() => Protection} protection ce qui protège ce chargement (calculé à la demande)
 */

/**
 * Les imports par adresse http(s) du code de la surface, avec leur protection.
 * Calculé une fois par contexte (et refait si l'inventaire a gagné des fichiers, ce
 * que font les littéraux passés à `eval`), en un seul parcours du code de la surface.
 * @param {object} ctx le contexte de l'audit
 * @returns {{ imports: ImportDistant[], carteQuiProtege: (page: object, href: string) => (number|undefined), lienQuiBrise: (page: object, href: string, carte: number) => (object|undefined) }}
 *   `carteQuiProtege(page, href)` : le décalage, dans la page, de la carte dont la clé `integrity` protège cette adresse (undefined : aucune) ;
 *   `lienQuiBrise(page, href, carte)` : le `<link rel="modulepreload">` de cette adresse qui l'a chargée sans l'empreinte de la carte au décalage `carte` (undefined : aucun)
 */
export function importsDistants(ctx) {
  const vu = memo.get(ctx);
  if (vu && vu.longueur === ctx.fichiers.length) return vu.resultat;

  const pagesHtml = ctx.fichiers.filter((f) => f.executee && !f.binaire && estPage(f));
  const parChemin = new Map(ctx.fichiers.map((f) => [f.chemin, f]));
  const protegeesParPage = new Map();
  const protegeesDe = (page) => {                                // adresse → décalage de la carte qui la protège
    if (!protegeesParPage.has(page.chemin)) protegeesParPage.set(page.chemin, adressesProtegeesParEmpreinte(page.contenu, page.chemin));
    return protegeesParPage.get(page.chemin);
  };
  const liensParPage = new Map();
  const liensDe = (page) => {                                    // adresse → les `<link rel="modulepreload">` de la page qui la chargent
    if (!liensParPage.has(page.chemin)) liensParPage.set(page.chemin, modulepreloadsDeLaPage(page.contenu, page.chemin));
    return liensParPage.get(page.chemin);
  };
  const desWorkers = ctx.surfaceDesWorkers ? ctx.surfaceDesWorkers() : new Set();
  /** Où s'exécute le code d'un fichier : un littéral passé à `eval` ou à `Function` s'exécute là où l'appel s'exécute (le fichier d'origine, de proche en proche) ; celui d'un `Worker` dans un worker. */
  const contexteDe = (fichier) => {
    let racine = fichier;
    let worker = false;
    let ligneOrigine = null;                                     // la ligne, dans le fichier réel, du premier appel qui a produit ce code
    const vus = new Set();
    while (racine?.litteralImbrique && racine.origineReelle && !vus.has(racine.chemin)) {
      vus.add(racine.chemin);
      if (racine.executeParUnWorker) worker = true;
      ligneOrigine = racine.origineReelle.ligne;
      racine = parChemin.get(racine.origineReelle.chemin);
    }
    return { racine, worker: worker || (racine ? desWorkers.has(racine.chemin) : false), ligneOrigine };
  };
  const unitesParFichier = new Map();
  const unitesDe = (fichier) => {
    if (!unitesParFichier.has(fichier.chemin)) unitesParFichier.set(fichier.chemin, unitesJs(fichier));
    return unitesParFichier.get(fichier.chemin);
  };
  /**
   * Le décalage, dans `page`, de la balise dont le chargement fait exécuter ce code : le `<script>` même pour un script écrit dans la page (ou pour un littéral passé à `eval` dans ce script : celui qui couvre la ligne de l'appel), la première balise qui mène au fichier sinon. Une empreinte ne protège que ce dont le chargement commence après la lecture de la carte ; null quand aucune balise ne le dit (le fichier n'est pas dans le graphe du document, ou le budget d'arêtes est épuisé), et alors rien n'est garanti.
   */
  const debutDuChargeur = (page, racine, fichier, unite, ligneOrigine) => {
    if (!estPage(racine)) {
      const debut = ctx.debutDeChargement?.(page.chemin, racine.chemin);
      return Number.isFinite(debut) ? debut : null;
    }
    if (fichier === racine) return Number.isFinite(unite.debut) ? unite.debut : null;
    const couvrante = uniteCouvrant(unitesDe(racine), ligneOrigine);
    return couvrante && Number.isFinite(couvrante.debut) ? couvrante.debut : null;
  };
  /**
   * Les documents dont l'import map s'applique au code d'un fichier : la page pour un script écrit dedans, sinon chaque page dont le graphe de document atteint le fichier (le seul document du widget quand il n'y en a qu'un ; ce que le graphe ne sait pas dire compte comme chargeur), dans l'ordre des pages.
   * L'index fichier → pages se fait une fois, à l'arête près du budget : une page par fichier de la surface ne coûtait sinon qu'un produit pages × fichiers. La liste rendue se lit à la demande, sans être construite.
   */
  let indexDesPages = null;
  const pagesQuiChargent = (racine) => {
    if (!racine) return [];
    if (estPage(racine)) return [racine];
    if (pagesHtml.length === 1 || !ctx.surfaceDuDocument) return pagesHtml;
    if (!indexDesPages) {
      const connues = new Map();                                 // fichier → rangs des pages dont le document l'atteint
      const inconnues = [];                                      // rangs des pages dont le document n'est pas établi (budget épuisé) : elles comptent pour chaque fichier
      pagesHtml.forEach((page, rang) => {
        const document = ctx.surfaceDuDocument(page.chemin);
        if (!document) { inconnues.push(rang); return; }
        for (const chemin of document) {
          const rangs = connues.get(chemin);
          if (rangs) rangs.push(rang); else connues.set(chemin, [rang]);
        }
      });
      indexDesPages = { connues, inconnues };
    }
    return fusionnerLesPages(pagesHtml, indexDesPages.connues.get(racine.chemin) ?? [], indexDesPages.inconnues);
  };

  const trouvees = [];
  const workersNonResolus = [];
  const noterWorker = (fichier, ligne, argument) => {
    const categorie = classifierSourceWorker(argument);
    const resolu = categorie === 'chemin-local' || categorie === 'url-absolue' || (categorie === 'code-en-chaine' && extraireCodeLitteralWorker(argument) !== null);
    if (!resolu) workersNonResolus.push({ fichier: fichier.chemin, ligne });
  };
  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, unite, fichier, ligneDe, walk }) => {
    if (!ast) return;
    walk.simple(ast, {
      ...visiteursDImports({ unite, fichier }, (chargement) => {
        // Un fichier du widget se lit à part : ni C-EXFIL-01 ni E-DEP-01 n'en disent rien, et le retenir coûterait un objet par `import` (chaque module d'un widget qui en importe des centaines d'autres : autant d'entrées gardées pour rien).
        if (chargement.url.origin === ORIGINE_LOCALE) return;
        trouvees.push({ ...chargement, unite, fichier, ligne: ligneDe(chargement.noeud) });
      }),
      NewExpression(n) { if (/^(Worker|SharedWorker)$/.test(nomFinal(n.callee))) noterWorker(fichier, ligneDe(n), n.arguments[0]); },
      CallExpression(n) {
        const nom = nomPointe(n.callee) ?? '';
        if (NOM_ENREGISTREMENT.test(nom) || NOM_MODULE_DE_WORKLET.test(nom)) noterWorker(fichier, ligneDe(n), n.arguments[0]);
      },
    });
  });
  const lieuDuWorker = workersNonResolus.length ? `${workersNonResolus[0].fichier}, ligne ${workersNonResolus[0].ligne}` : null;

  /**
   * L'état de l'empreinte de `url` sur les pages qui chargent le code de `racine` : la première page sans empreinte le dit seule (`absente`, les suivantes n'y changent rien),
   * sinon la première page où elle ne s'applique pas (`tardive` : lue après le chargeur, ou brisée par un lien `modulepreload` de l'adresse), sinon rien (`vues` pages, toutes garanties).
   * Chaque page évaluée est un pas du budget des documents : `epuise` quand il ne reste rien, et l'état est alors inconnu. Pour un code qui n'est pas écrit dans une page, l'état ne dépend que de
   * la racine et de l'adresse : il se calcule une fois, quel que soit le nombre de fois que l'adresse est importée.
   */
  const etatsParAdresse = new Map();
  const etatDesPages = (racine, fichier, unite, ligneOrigine, url) => {
    const cle = racine && !estPage(racine) ? `${racine.chemin}\0${url.href}` : null;
    if (cle !== null && etatsParAdresse.has(cle)) return etatsParAdresse.get(cle);
    let etat = { vues: 0, absente: false, tardive: null, epuise: false };
    for (const page of pagesQuiChargent(racine)) {
      if (ctx.depenserPasDocuments && !ctx.depenserPasDocuments(1)) { etat = { ...etat, epuise: true }; break; }
      etat.vues++;
      const carte = protegeesDe(page).get(url.href);
      if (carte === undefined) { etat.absente = true; break; }
      const chargeur = debutDuChargeur(page, racine, fichier, unite, ligneOrigine);
      const lien = lienQuiBriseLEmpreinte(liensDe(page).get(url.href), carte);
      const carteAvantChargeur = chargeur !== null && carte <= chargeur;
      if (!carteAvantChargeur || lien) etat.tardive ??= { page, carte, chargeur, carteAvantChargeur, lien };
    }
    if (cle !== null) etatsParAdresse.set(cle, etat);
    return etat;
  };
  const protectionDe = ({ url, unite, fichier }) => {
    const { racine, worker, ligneOrigine } = contexteDe(fichier);
    // Un fichier exécuté par un worker n'est protégé par aucune empreinte : l'état des cartes n'a alors plus d'objet, et une seule raison est vraie.
    if (worker) return { sri: false, raisons: [RAISON_WORKER], obstacle: 'worker' };
    const etat = etatDesPages(racine, fichier, unite, ligneOrigine, url);
    const obstacle = workersNonResolus.length ? 'worker-non-resolu' : null;
    const parLaPage = !etat.epuise && etat.vues > 0 && !etat.absente && !etat.tardive;
    const raisonsNonProtegee = () => {
      if (etat.epuise) return [RAISON_BUDGET_EPUISE];
      const { tardive } = etat;
      if (!tardive || etat.absente) return [RAISON_SANS_EMPREINTE];
      const lue = lirePage(tardive.page.contenu);
      return [
        ...(tardive.carteAvantChargeur ? [] : [tardive.chargeur === null ? RAISON_CHARGEUR_INCONNU : raisonCarteTardive(lue.positionDe(tardive.carte).ligne, lue.positionDe(tardive.chargeur).ligne)]),
        ...(tardive.lien ? [raisonLienDePrechargement(lue.positionDe(tardive.carte).ligne, tardive.lien)] : []),
      ];
    };
    const raisons = [
      ...(parLaPage ? [] : raisonsNonProtegee()),
      ...(obstacle ? [raisonWorkerNonResolu(lieuDuWorker)] : []),
    ];
    return { sri: parLaPage && !obstacle, raisons, obstacle };
  };
  const imports = trouvees.map((t) => {
    let protection = null;
    return { ...t, protection: () => (protection ??= protectionDe(t)) };
  });

  const resultat = {
    imports,
    carteQuiProtege: (page, href) => protegeesDe(page).get(href),
    lienQuiBrise: (page, href, carte) => lienQuiBriseLEmpreinte(liensDe(page).get(href), carte),
  };
  memo.set(ctx, { longueur: ctx.fichiers.length, resultat });
  return resultat;
}
