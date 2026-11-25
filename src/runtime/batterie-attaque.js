/**
 * Axe D — batterie de charges d'attaque, jouée dans Chromium (D-XSS-02, D-XSS-03).
 *
 * La sonde de `dynamique.js` (D-XSS-01) n'essaie qu'une charge, la balise `<img onerror>`, dans une cellule : un widget qui échappe `<` et `>` mais pas les guillemets, qui
 * construit un gestionnaire en ligne par concaténation, ou qui n'affiche pas les cellules mais les noms de colonnes ou les options, la laisse passer. Cette passe rejoue le
 * widget sur une page à part, avec une vingtaine de charges adaptées au contexte où une valeur peut atterrir (texte HTML, valeur d'attribut entre guillemets ou apostrophes,
 * fermeture d'une balise, lien `javascript:`, Markdown, chaîne de code, gabarit, entités doublement décodées), envoyées par cinq entrées : valeur de cellule, nom de colonne,
 * options du widget, adresse (paramètres et ancre) et message d'une autre fenêtre.
 *
 * La preuve est celle de D-XSS-01 : chaque charge, si elle s'exécute, pose un bit dans une variable de la page hôte (`window.top.__poc_atq_<entrée>`), un bit par famille. Rien
 * n'est supposé : une charge qui ne s'exécute pas ne produit aucun constat, et le texte du rapport ne reprend jamais un texte du widget (il ne cite que ce catalogue).
 * Les charges qui demandent un geste (survol, focus, clic) sont déclenchées sur les seuls éléments qui portent une charge de l'audit, jamais sur le code du widget ; le rapport dit
 * si la charge s'est exécutée à l'affichage ou après ce geste.
 *
 * Sans pénalité par elle-même : un widget qui n'exécute rien reçoit une information qui dit ce qui a été joué, et qui n'est pas une preuve d'absence.
 */
import { constat } from '../moteur/modele.js';

/** Les entrées par lesquelles une charge est envoyée, et ce que le rapport en dit. */
export const ENTREES = {
  cellule: 'une valeur de cellule',
  entete: 'un nom de colonne',
  options: 'les options du widget',
  url: "l'adresse du widget (paramètres ou ancre)",
  message: 'un message envoyé par une autre fenêtre',
};

/**
 * Le code que la charge exécute, sans guillemet, sans chevron et sans espace : il tient dans n'importe quel contexte. `x |= 4` fonctionne sur une variable absente.
 * Un bit par famille (31 au plus) : la page hôte lit une seule variable par entrée.
 */
const code = (entree, indice) => `window.top.__poc_atq_${entree}|=${2 ** indice}`;

/**
 * Les familles de charges. `fabriquer(x)` rend la charge qui exécute le code `x` ; `declencheur` dit le geste qu'elle attend quand elle ne s'exécute pas à l'affichage.
 * Les libellés sont ceux du rapport : ils disent le contexte dans lequel la valeur atterrit.
 */
const FAMILLES = [
  { id: 'html-img', libelle: 'texte HTML (balise img)', declencheur: 'événement', fabriquer: (x) => `<img src=x onerror="${x}">` },
  { id: 'html-svg', libelle: 'texte HTML (balise svg)', declencheur: 'événement', fabriquer: (x) => `<svg onload="${x}">` },
  { id: 'html-details', libelle: 'texte HTML (balise details)', declencheur: 'événement', fabriquer: (x) => `<details open ontoggle="${x}">x</details>` },
  { id: 'attr-guillemets', libelle: "valeur d'attribut entre guillemets, fermée par un guillemet", declencheur: 'événement', fabriquer: (x) => `"><img src=x onerror='${x}'>` },
  { id: 'attr-apostrophes', libelle: "valeur d'attribut entre apostrophes, fermée par une apostrophe", declencheur: 'événement', fabriquer: (x) => `'><img src=x onerror="${x}">` },
  { id: 'attr-focus', libelle: "valeur d'attribut, gestionnaire ajouté sans balise (guillemets non échappés)", declencheur: 'focus', fabriquer: (x) => `" autofocus onfocus="${x}` },
  { id: 'attr-survol', libelle: "valeur d'attribut, gestionnaire de survol ajouté (guillemets non échappés)", declencheur: 'survol', fabriquer: (x) => `" onmouseover="${x}" x="` },
  { id: 'fermeture-textarea', libelle: 'contenu de textarea, fermé par sa balise', declencheur: 'événement', fabriquer: (x) => `</textarea><img src=x onerror="${x}">` },
  { id: 'fermeture-style', libelle: 'contenu de style, fermé par sa balise', declencheur: 'événement', fabriquer: (x) => `</style><img src=x onerror="${x}">` },
  { id: 'fermeture-script', libelle: 'données dans un script, fermé par sa balise', declencheur: 'événement', fabriquer: (x) => `</script><img src=x onerror="${x}">` },
  { id: 'lien-javascript', libelle: 'adresse de lien javascript:', declencheur: 'clic', fabriquer: (x) => `javascript:${x}` },
  { id: 'markdown-lien', libelle: 'lien Markdown javascript:', declencheur: 'clic', fabriquer: (x) => `[cliquer](javascript:${x})` },
  { id: 'markdown-image', libelle: 'image Markdown (attribut ajouté)', declencheur: 'événement', fabriquer: (x) => `![x](x"onerror="${x})` },
  { id: 'js-appel', libelle: "appel de fonction dans un gestionnaire en ligne (apostrophe et parenthèse fermées)", declencheur: 'clic', fabriquer: (x) => `');${x};//` },
  { id: 'js-guillemets', libelle: 'chaîne de code entre guillemets', declencheur: 'événement', fabriquer: (x) => `";${x};//` },
  { id: 'js-apostrophes', libelle: 'chaîne de code entre apostrophes', declencheur: 'événement', fabriquer: (x) => `';${x};//` },
  { id: 'gabarit-moustache', libelle: 'gabarit à double accolade', declencheur: 'événement', fabriquer: (x) => `{{constructor.constructor('${x}')()}}` },
  { id: 'gabarit-js', libelle: 'gabarit de chaîne JavaScript', declencheur: 'événement', fabriquer: (x) => `\${${x}}` },
  { id: 'entites', libelle: 'entités HTML décodées une seconde fois', declencheur: 'événement', fabriquer: (x) => `&lt;img src=x onerror=&quot;${x}&quot;&gt;` },
];
export const NOMBRE_DE_CHARGES = FAMILLES.length;
const indiceDe = (id) => FAMILLES.findIndex((f) => f.id === id);

/** Les familles envoyées en nom de colonne (tout texte HTML ou presque), puis par les entrées qui n'ont qu'une valeur par clé : une famille par clé, à tour de rôle. */
const POUR_ENTETES = ['html-img', 'html-svg', 'html-details', 'attr-guillemets', 'attr-focus'];
const POUR_CLES = ['html-img', 'attr-focus', 'attr-guillemets', 'lien-javascript', 'js-appel', 'gabarit-js'];
/** Les noms de clés les plus courants d'une option, d'un paramètre d'adresse ou d'un message : le widget ne dit pas lesquels il lit. */
const CLES_OPTIONS = ['title', 'label', 'text', 'name', 'header', 'description', 'message', 'html', 'content', 'placeholder', 'url', 'link', 'color', 'format', 'template'];
const CLES_ADRESSE = ['q', 'query', 'search', 'title', 'name', 'id', 'text', 'msg', 'message', 'value', 'label', 'url', 'redirect', 'next', 'callback', 'lang', 'mode', 'theme'];
const CLES_MESSAGE = ['type', 'html', 'text', 'message', 'data', 'value', 'title', 'content', 'payload', 'action', 'name'];
const ID_DEPART = 9001;

const charge = (id, entree) => FAMILLES[indiceDe(id)].fabriquer(code(entree, indiceDe(id)));
const parCles = (cles, entree) => cles.map((cle, i) => [cle, charge(POUR_CLES[i % POUR_CLES.length], entree)]);

/**
 * Le document de la batterie : celui de l'audit, avec en tête une ligne par charge dans chaque colonne de texte (les colonnes de nombres gardent un nombre), une colonne de texte et une colonne
 * de liste propres à la batterie, des colonnes dont le NOM est une charge, et les options du widget remplies de charges.
 * Les lignes d'abord : un widget qui pagine ou borne l'affichage montre les charges avant les données de test.
 * @param {{tableId: string, nom?: string, colonnes: Record<string, any[]>, tablesAppats?: any[], options?: object}} base `documentDeTest(scenario)` de dynamique.js
 */
export function documentDeBatterie(base) {
  const cellules = FAMILLES.map((f, i) => f.fabriquer(code('cellule', i)));
  const colonnes = {};
  let total = 0;
  for (const [nom, valeurs] of Object.entries(base.colonnes)) {
    const v = Array.isArray(valeurs) ? valeurs : [valeurs];
    total = Math.max(total, v.length + cellules.length);
    if (nom === 'id') colonnes[nom] = [...cellules.map((_, i) => ID_DEPART + i), ...v];
    else if (v.every((x) => typeof x === 'string')) colonnes[nom] = [...cellules, ...v];
    else colonnes[nom] = [...cellules.map(() => (typeof v[0] === 'number' ? 0 : (v[0] ?? null))), ...v];
  }
  total = Math.max(total, cellules.length);
  const complete = (tete, queue) => [...tete, ...Array.from({ length: Math.max(0, total - tete.length) }, () => queue)];
  colonnes._GwauditBatterie = complete(cellules, 'RAS');
  colonnes._GwauditBatterieListe = complete(cellules.map((c, i) => ['L', c, cellules[(i + 1) % cellules.length]]), ['L']);
  for (const id of POUR_ENTETES) colonnes[charge(id, 'entete')] = complete([], 'x');
  return {
    ...base,
    colonnes,
    options: { ...(base.options ?? {}), ...Object.fromEntries(parCles(CLES_OPTIONS, 'options')) },
  };
}

/** L'adresse du widget avec des paramètres et une ancre qui sont des charges. */
export function adresseDeBatterie(adresse) {
  const parametres = parCles(CLES_ADRESSE, 'url').map(([cle, valeur]) => `${encodeURIComponent(cle)}=${encodeURIComponent(valeur)}`).join('&');
  return `${adresse}${adresse.includes('?') ? '&' : '?'}${parametres}#${encodeURIComponent(charge('html-img', 'url'))}`;
}

/** Les messages qu'un cadre voisin envoie au widget : un texte, un objet dont chaque clé courante porte une charge, le même objet en JSON, et une liste. */
export function messagesDeBatterie() {
  const objet = Object.fromEntries(parCles(CLES_MESSAGE, 'message'));
  return [charge('html-img', 'message'), objet, JSON.stringify(objet), Object.values(objet)];
}

const DELAI_CHARGEMENT_MS = 15_000;
const DELAI_TOTAL_MS = 45_000;

/**
 * Déclenche, dans chaque cadre de la page, les seuls éléments qui portent une charge de l'audit : un gestionnaire en ligne (l'événement qu'il nomme) ou une adresse javascript: (un clic).
 * Le code du widget n'est jamais déclenché : seul ce qui contient le nom de la variable de la batterie l'est.
 */
async function declencher(page) {
  for (const cadre of page.frames()) {
    if (cadre === page.mainFrame()) continue;
    await cadre.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        for (const nom of el.getAttributeNames()) {
          const valeur = el.getAttribute(nom) ?? '';
          if (!valeur.includes('__poc_atq_')) continue;
          if (/^on/i.test(nom)) el.dispatchEvent(new Event(nom.slice(2).toLowerCase(), { bubbles: true, cancelable: true }));
          else if (/^\s*javascript:/i.test(valeur) && typeof el.click === 'function') el.click();
        }
      }
    }).catch(() => {});
  }
}

const lireBits = (page) => page.evaluate((entrees) => Object.fromEntries(entrees.map((e) => [e, window[`__poc_atq_${e}`] | 0])), Object.keys(ENTREES));

/** Les charges exécutées : un bit posé pour une entrée. `geste` dit si c'était à l'affichage ou après le déclenchement. */
function lireExecutions(avant, apres) {
  const executees = [];
  for (const entree of Object.keys(ENTREES)) {
    FAMILLES.forEach((f, i) => {
      if (!(apres[entree] & (2 ** i))) return;
      executees.push({ entree, famille: f.id, contexte: f.libelle, declenchement: avant[entree] & (2 ** i) ? 'affichage' : f.declencheur });
    });
  }
  return executees;
}

/**
 * Joue la batterie sur une page à part du même contexte Chromium (donc sous la même neutralisation du réseau), puis remet `brut` dans l'état où il était : ce que la batterie a provoqué
 * (une requête déclenchée par un clic sur une charge) n'est pas ce que le widget fait de lui-même, et les constats réseau de l'audit n'en tiennent pas compte.
 * @returns {Promise<{jouee: boolean, raison?: 'delai'|'erreur', executees?: Array, donneesLues?: boolean}>}
 */
export async function jouerBatterie({ contexte, origine, urlWidget, document: base, brut }) {
  const avant = brut ? ['requetes', 'requetesLocales', 'substitutionApiGrist'].map((cle) => [cle, brut[cle]?.length ?? 0]) : [];
  let page;
  let minuteur;
  try {
    page = await contexte.newPage();
    page.on('dialog', (d) => { d.dismiss().catch(() => {}); });
    await page.addInitScript(({ doc, widgetUrl }) => {
      window.__CONFIG_DOC__ = doc;
      window.__WIDGET_URL__ = widgetUrl;
      window.__REGLAGE__ = { niveauAccorde: 'full' };
    }, { doc: documentDeBatterie(base), widgetUrl: adresseDeBatterie(urlWidget) });
    const jeu = (async () => {
      await page.goto(`${origine}/harnais/page-hote.html`, { waitUntil: 'load', timeout: DELAI_CHARGEMENT_MS });
      await page.waitForFunction(() => window.__hotePret === true, { timeout: DELAI_CHARGEMENT_MS });
      const journal = await page.evaluate(() => window.__hoteJournal ?? null).catch(() => null);
      // Les messages partent d'un cadre voisin, non de l'hôte : un widget qui ne croit que son parent (`event.source === window.parent`) doit les refuser, comme dans un vrai Grist.
      await page.evaluate((messages) => {
        const voisin = document.createElement('iframe');
        voisin.style.cssText = 'position:absolute;width:0;height:0;border:0';
        document.body.appendChild(voisin);
        voisin.contentWindow.eval('(function (messages) { var cible = window.parent.frames[0]; for (var i = 0; i < messages.length; i++) cible.postMessage(messages[i], "*"); })')(messages);
      }, messagesDeBatterie());
      await page.waitForTimeout(500);
      const avantGeste = await lireBits(page);
      await declencher(page);
      await page.waitForTimeout(300);
      const apresGeste = await lireBits(page);
      const donneesLues = Boolean(journal?.appelsRpc?.some((a) => ['fetchSelectedTable', 'fetchTable', 'fetchSelectedRecord'].includes(a.methode)));
      return { jouee: true, executees: lireExecutions(avantGeste, apresGeste), donneesLues };
    })();
    jeu.catch(() => {});
    const delai = new Promise((resolve) => { minuteur = setTimeout(() => resolve({ jouee: false, raison: 'delai' }), DELAI_TOTAL_MS); });
    return await Promise.race([jeu.catch((e) => ({ jouee: false, raison: e?.name === 'TimeoutError' ? 'delai' : 'erreur' })), delai]);
  } catch {
    return { jouee: false, raison: 'erreur' };
  } finally {
    clearTimeout(minuteur);
    await page?.close().catch(() => {});
    for (const [cle, n] of avant) if (brut?.[cle]) brut[cle].length = n;
  }
}

const RANG = { critique: 3, majeur: 2, mineur: 1 };
/** Ce que vaut une exécution selon l'entrée : qui peut la provoquer sans rien d'autre que son accès au document. */
const SEVERITE_PAR_ENTREE = { cellule: 'critique', entete: 'critique', options: 'critique', message: 'majeur', url: 'mineur' };
const POURQUOI = {
  cellule: "toute personne qui peut écrire dans le document vise celles qui l'ouvrent",
  entete: "toute personne qui peut renommer une colonne vise celles qui ouvrent le document",
  options: "toute personne qui peut régler le widget vise celles qui l'ouvrent",
  message: "un autre widget de la même page peut écrire au widget",
  url: "l'adresse n'est choisie que par la personne qui installe le widget : l'exploitation suppose de la convaincre d'une adresse piégée",
};

/**
 * Le constat de la batterie : D-XSS-02 (critique et bloquant quand une charge s'exécute par une entrée qu'une autre personne contrôle ; moins pour un message ou l'adresse) quand une charge s'est exécutée,
 * D-XSS-03 (information) sinon, ou quand la batterie n'a pas pu être jouée.
 * @param {Awaited<ReturnType<typeof jouerBatterie>>|null} resultat `null` : la batterie n'a pas lieu d'être jouée (le widget n'a pas été chargé)
 */
export function constatsBatterie(resultat) {
  if (!resultat) return [];
  if (!resultat.jouee) {
    return [constat({
      regle: 'D-XSS-03', axe: 'D', severite: 'info', confiance: 'certain',
      titre: "Batterie de charges d'attaque non jouée",
      constat: `La page de la batterie n'a pas pu être menée à son terme (${resultat.raison === 'delai' ? 'délai dépassé' : 'erreur du navigateur'}) : seule la charge simple de D-XSS-01 a été essayée.`,
      impact: "Ce rapport ne dit rien des autres contextes (attribut, lien javascript:, Markdown, gabarit, noms de colonnes, options, adresse, message).",
      remediation: "Relancer l'audit ; si le délai se répète, chercher ce que le widget fait de long ou de bloquant à l'affichage.",
    })];
  }
  const { executees, donneesLues } = resultat;
  if (!executees.length) {
    return [constat({
      regle: 'D-XSS-03', axe: 'D', severite: 'info', confiance: 'certain',
      titre: `Batterie de ${NOMBRE_DE_CHARGES} charges d'attaque jouée : aucune exécutée`,
      constat: `${NOMBRE_DE_CHARGES} charges (texte HTML, attributs, fermetures de balise, liens javascript:, Markdown, chaînes de code, gabarits, entités) ont été envoyées au widget par ${Object.keys(ENTREES).length} entrées (${Object.values(ENTREES).join(', ')}) ; aucune ne s'est exécutée.${donneesLues ? '' : " Le widget n'a lu aucune donnée du document pendant cette passe : les cellules et les noms de colonnes ne lui ont pas été présentés."}`,
      impact: "Ce n'est pas une preuve d'absence : le widget n'affiche peut-être pas les colonnes de test (il n'en lit que certaines), ou ses options et ses paramètres d'adresse portent d'autres noms que ceux essayés.",
      remediation: 'Rien à corriger. Pour que la batterie atteigne ce que le widget affiche réellement, fournir un scénario avec ses colonnes (--scenario).',
      preuve: { charges: NOMBRE_DE_CHARGES, entrees: Object.keys(ENTREES), donneesLues },
    })];
  }
  const niveau = executees.map((e) => SEVERITE_PAR_ENTREE[e.entree]).reduce((n, s) => (RANG[s] > RANG[n] ? s : n), 'mineur');
  const parEntree = new Map();
  for (const e of executees) parEntree.set(e.entree, [...(parEntree.get(e.entree) ?? []), e]);
  const liste = [...parEntree].map(([entree, l]) => `${ENTREES[entree]} : ${l.slice(0, 6).map((e) => `${e.contexte}, ${e.declenchement === 'affichage' ? "à l'affichage" : `après un ${e.declenchement} simulé`}`).join(' ; ')}${l.length > 6 ? ` ; et ${l.length - 6} autre(s)` : ''}`).join(' | ');
  return [constat({
    regle: 'D-XSS-02', axe: 'D', severite: niveau, bloquant: niveau === 'critique', confiance: 'prouve',
    titre: `Charge d'attaque exécutée par ${parEntree.size > 1 ? `${parEntree.size} entrées` : ENTREES[[...parEntree.keys()][0]]} (preuve d'exécution)`,
    constat: `Dans la batterie de ${NOMBRE_DE_CHARGES} charges, ${executees.length} s'est exécutée dans le widget : ${liste}.`,
    impact: `Preuve d'exécution, comme D-XSS-01, pour un contexte que la charge simple n'essaie pas : ${[...parEntree.keys()].map((e) => `${ENTREES[e]} (${POURQUOI[e]})`).join(' ; ')}. Un échappement qui ne couvre que \`<\` et \`>\` laisse passer les guillemets, les gestionnaires en ligne, les liens javascript: et les gabarits.`,
    remediation: "Pour chaque entrée citée : rendre la valeur en texte (`textContent`, `setAttribute`) au lieu de construire du HTML par concaténation ; n'écrire aucun gestionnaire en ligne (`onclick=`) ; refuser dans un lien tout schéma autre que `http:` et `https:` ; ne jamais passer une valeur à `eval`, `new Function` ou à un gabarit compilé ; et poser une CSP sans `unsafe-inline` (C-CSP-01).",
    referentiels: ['OWASP Top 10 A03:2021 — Injection', 'CWE-79', 'CWE-83'],
    preuve: { charges: NOMBRE_DE_CHARGES, executees: executees.slice(0, 50), entrees: [...parEntree.keys()] },
  })];
}
