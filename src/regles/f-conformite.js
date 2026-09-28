/**
 * Axe F — Conformité Grist.Gouv, souveraineté numérique, accessibilité,
 * sobriété.
 *
 * C'est l'axe « administration ». Un widget peut être irréprochable
 * techniquement et rester inéligible à un hébergement sur une instance de
 * l'État : parce qu'il fait appeler un service américain par chaque agent,
 * parce qu'il est inutilisable au lecteur d'écran, ou parce qu'il ne se
 * déclare pas dans le format attendu par le catalogue.
 */
import path from 'node:path';
import { TokenizerMode, foreignContent } from 'parse5';
import { constat } from '../moteur/modele.js';
import { Decoupeur } from '../moteur/decoupeur-html.js';

/**
 * Domaines dont l'appel depuis le navigateur d'un agent pose une question
 * RGPD ou de souveraineté. La liste est volontairement courte et explicite :
 * mieux vaut manquer un domaine que produire un constat contestable.
 */
const NON_SOUVERAINS = [
  [/(^|\.)fonts\.googleapis\.com$/i, 'Google Fonts', "chaque affichage transmet l'adresse IP de l'agent à Google ; plusieurs autorités de protection des données européennes ont jugé cet usage non conforme sans consentement"],
  [/(^|\.)fonts\.gstatic\.com$/i, 'Google Fonts (statiques)', "même analyse que fonts.googleapis.com"],
  [/(^|\.)google-analytics\.com$/i, 'Google Analytics', 'mesure d\'audience non conforme au RGPD en configuration par défaut (décisions CNIL 2022)'],
  [/(^|\.)googletagmanager\.com$/i, 'Google Tag Manager', 'chargeur de traceurs tiers'],
  [/(^|\.)facebook\.(net|com)$/i, 'Meta', 'traceur publicitaire'],
  [/(^|\.)doubleclick\.net$/i, 'DoubleClick', 'régie publicitaire'],
  [/(^|\.)hotjar\.com$/i, 'Hotjar', 'enregistrement de session : capture potentielle du contenu affiché, donc des données du document'],
  [/(^|\.)sentry\.io$/i, 'Sentry (hébergement mutualisé)', "remontée d'erreurs incluant souvent le contexte d'exécution ; à héberger soi-même"],
  [/(^|\.)cdn\.jsdelivr\.net$/i, 'jsDelivr', 'distribution de code tiers hors maîtrise de l\'administration'],
  [/(^|\.)unpkg\.com$/i, 'unpkg', 'distribution de code tiers hors maîtrise de l\'administration'],
  [/(^|\.)cdnjs\.cloudflare\.com$/i, 'cdnjs (Cloudflare)', 'distribution de code tiers hors maîtrise de l\'administration'],
  [/(^|\.)openai\.com$/i, 'OpenAI', "envoi de données à un service d'IA hors UE : incompatible avec des données d'administration sans cadre juridique dédié"],
  [/(^|\.)api\.anthropic\.com$/i, 'Anthropic', "envoi de données à un service d'IA hors UE : incompatible avec des données d'administration sans cadre juridique dédié"],
];

export function analyserSouverainete(ctx) {
  const constats = [];
  const trouves = new Map();

  for (const f of ctx.fichiers) {
    if (!f.executee || f.binaire || !f.contenu) continue;
    for (const m of f.contenu.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
      const h = m[1];
      for (const [re, nom, motif] of NON_SOUVERAINS) {
        if (!re.test(h)) continue;
        // Un fichier synthétique (`litteralImbrique`, code littéral matérialisé
        // par `preparerCodeExecuteEnChaine`) reproduit parfois TEXTUELLEMENT une
        // référence déjà visible dans son fichier d'origine (un littéral direct,
        // non obfusqué, contient l'hôte en clair des deux côtés) : la compter une
        // deuxième fois gonflerait le nombre de références sans rapport avec la
        // réalité (relevé par la coordination le 2026-09-28). Elle n'est ignorée
        // ici QUE si le fichier d'origine la porte déjà en clair — si le littéral
        // était encodé (base64, URI, fromCharCode...), l'hôte n'apparaît nulle
        // part ailleurs en clair et reste une référence à part entière, révélée
        // par le seul décodage.
        if (f.litteralImbrique && f.origineReelle) {
          const origine = ctx.fichiers.find((of) => of.chemin === f.origineReelle.chemin);
          if (origine?.contenu?.includes(h)) continue;
        }
        const cle = `${nom}`;
        if (!trouves.has(cle)) trouves.set(cle, { nom, motif, emplacements: [] });
        trouves.get(cle).emplacements.push({ fichier: f.chemin, ligne: f.contenu.slice(0, m.index).split('\n').length, hote: h });
      }
    }
  }

  for (const t of trouves.values()) {
    constats.push(constat({
      regle: 'F-SOUV-01', axe: 'F', severite: 'majeur', confiance: 'certain',
      titre: `Appel à un service tiers non souverain : ${t.nom}`,
      fichier: t.emplacements[0].fichier, ligne: t.emplacements[0].ligne,
      constat: `${t.emplacements.length} référence(s) à ${t.nom} dans le code exécuté.`,
      impact: `Le widget est affiché dans le navigateur d'agents publics, sur une instance souveraine. Ici, ${t.motif}. Sur une instance DINUM ou ANCT, ce flux devra être justifié ou supprimé avant mise en production.`,
      remediation: "Internaliser la ressource : embarquer les polices dans le dépôt, remplacer une mesure d'audience par une solution auto-hébergée (Matomo, ou l'offre mutualisée de l'État), supprimer les traceurs.",
      referentiels: ['RGPD art. 44 et suivants (transferts hors UE)', 'Doctrine « Cloud au centre » (circulaire du 31 mai 2023)', 'Référentiel général de sécurité'],
      // `t.nom` est un libellé humain (« Google Fonts »), pas l'hôte littéral :
      // `hotes` porte le(s) hôte(s) réels vus dans le code (`emplacements[].hote`),
      // pour permettre à la roadmap de rapprocher ce constat d'un autre qui cite
      // le même hôte (ex. B-DOC-04 sur un service non documenté), sans dépendre
      // du libellé qui, lui, ne coïncide avec aucune autre règle.
      preuve: { emplacements: t.emplacements, hotes: [...new Set(t.emplacements.map((e) => e.hote))] },
    }));
  }
  return constats;
}

/**
 * Accessibilité — contrôles statiques seulement.
 *
 * Le RGAA compte 106 critères, dont la grande majorité demande un jugement
 * humain. L'analyse statique ne couvre honnêtement que quelques manquements
 * mécaniques ; l'axe D complète par un passage d'axe-core dans le widget réel.
 * Le rapport doit dire clairement que « aucun constat » ne vaut pas
 * « conforme RGAA ».
 */

const ELEMENTS_VIDES = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Éléments dont le contenu n'est pas du balisage : dans parse5, c'est le constructeur d'arbre qui bascule le découpeur, ici c'est à nous. `noscript` suit un navigateur où les scripts s'exécutent.
const MODES_TEXTE_BRUT = new Map([
  ['script', TokenizerMode.SCRIPT_DATA], ['style', TokenizerMode.RAWTEXT], ['xmp', TokenizerMode.RAWTEXT],
  ['iframe', TokenizerMode.RAWTEXT], ['noembed', TokenizerMode.RAWTEXT], ['noframes', TokenizerMode.RAWTEXT],
  ['noscript', TokenizerMode.RAWTEXT], ['textarea', TokenizerMode.RCDATA], ['title', TokenizerMode.RCDATA],
  ['plaintext', TokenizerMode.PLAINTEXT],
]);

const CHAMPS_DE_FORMULAIRE = new Set(['input', 'select', 'textarea']);
const TYPES_SANS_ETIQUETTE = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
const LONGUEUR_MAX_EXTRAIT = 300;

const attribut = (balise, nom) => balise.attrs.find((a) => a.name === nom)?.value;
const renseigne = (valeur) => typeof valeur === 'string' && valeur.trim() !== '';
const idsReferences = (valeur) => (valeur ?? '').split(/\s+/).filter(Boolean);

/** Sous-arbre absent de l'arbre d'accessibilité : son texte ne nomme rien. */
function estMasque(balise) {
  if (balise.attrs.some((a) => a.name === 'hidden')) return true;
  if ((attribut(balise, 'aria-hidden') ?? '').trim().toLowerCase() === 'true') return true;
  return /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attribut(balise, 'style') ?? '');
}

/** Élément étranger (SVG, MathML) dont les enfants sont de nouveau lus comme du HTML. */
function estPointIntegration(ns, nom, balise) {
  if (ns === 'svg') return nom === 'foreignobject' || nom === 'desc' || nom === 'title';
  if (nom === 'annotation-xml') return /^(text\/html|application\/xhtml\+xml)$/i.test((attribut(balise, 'encoding') ?? '').trim());
  return ['mi', 'mo', 'mn', 'ms', 'mtext'].includes(nom);
}

/** Ce qu'un élément apporte lui-même au nom d'un bouton : `aria-label`, `title` (en dernier recours), l'alternative d'une image. */
function nommeParSesAttributs(balise) {
  return renseigne(attribut(balise, 'aria-label')) || renseigne(attribut(balise, 'title')) || (balise.tagName === 'img' && renseigne(attribut(balise, 'alt')));
}

/**
 * Une passe du découpeur de parse5 (l'automate du standard HTML) sur une
 * page, qui relève ce qu'examinent F-RGAA-01, 03, 04 et 05. Le constructeur
 * d'arbre de parse5 n'est pas utilisé : il est quadratique sur des pages
 * piégées, comme l'étaient les expressions régulières de ces règles. Il est
 * remplacé par une pile d'éléments simplifiée où chaque élément entre et sort
 * une fois, et un compte des éléments ouverts par nom, qui fait ignorer en
 * temps constant une balise fermante sans ouvrante. Ce que le constructeur
 * faisait et qui change le résultat est repris ici : le contenu de `script`,
 * `style`, `textarea`… n'est pas du balisage ; dans `svg` et `math`, `title`
 * n'en est pas un et la barre oblique ferme l'élément ; une balise HTML y
 * ramène au HTML ; les éléments vides ne s'empilent pas ; un `<button>`
 * ferme celui qui est ouvert.
 *
 * Un bouton a un nom s'il porte un `aria-label` ou un `title`, si son
 * `aria-labelledby` vise un id présent dans la page (résolu à la fin de la
 * passe, sans relire le texte visé), ou si son contenu hors `aria-hidden`,
 * `hidden` et `display: none` porte du texte (celui d'un `<span>`, même
 * masqué visuellement, le `<title>` d'un `<svg>`, la ligature d'une police
 * d'icônes comme `<i>delete</i>`), l'alternative d'une image ou un nom
 * donné par ces mêmes attributs. Un seul bouton est suivi à la fois, et son
 * nom est un booléen : aucun texte n'est accumulé.
 *
 * Simplification assumée : un bouton se ferme à sa balise fermante, à la
 * fermeture d'un élément qui le contient, ou à l'ouverture d'un autre
 * bouton, portée des tableaux mise à part.
 */
function examinerPage(source) {
  const ids = new Set();
  const idsEtiquetes = new Set();
  const balisesHtml = [];
  const imagesSansAlt = [];
  const champs = [];
  const boutons = [];
  const pile = [];
  const ouverts = new Map();
  let bouton = null;

  const extraire = (debut, fin) => {
    const texte = source.slice(debut, fin);
    return texte.length > LONGUEUR_MAX_EXTRAIT ? `${texte.slice(0, LONGUEUR_MAX_EXTRAIT)}…` : texte;
  };
  const fermerBouton = (fin) => {
    if (!bouton.nomme) boutons.push({ debut: bouton.debut, ligne: bouton.ligne, extrait: extraire(bouton.debut, Math.max(fin, bouton.finOuvrante)), references: bouton.references });
    bouton = null;
  };
  const empiler = (element) => {
    pile.push(element);
    ouverts.set(element.nom, (ouverts.get(element.nom) ?? 0) + 1);
  };
  const depiler = (fin) => {
    const element = pile.pop();
    ouverts.set(element.nom, ouverts.get(element.nom) - 1);
    if (element.bouton) fermerBouton(fin);
  };
  const ajusterModeEtranger = () => {
    const haut = pile.at(-1);
    decoupeur.inForeignNode = Boolean(haut && haut.ns !== 'html' && !haut.integration);
  };

  const decoupeur = new Decoupeur({ sourceCodeLocationInfo: true }, {
    onStartTag(balise) {
      const nom = balise.tagName;
      const { startOffset, endOffset, startLine } = balise.location;
      const id = attribut(balise, 'id');
      if (id) ids.add(id);

      if (decoupeur.inForeignNode && foreignContent.causesExit(balise)) {
        while (pile.length && pile.at(-1).ns !== 'html' && !pile.at(-1).integration) depiler(startOffset);
        ajusterModeEtranger();
      }
      const ns = decoupeur.inForeignNode ? pile.at(-1).ns : nom === 'svg' || nom === 'math' ? nom : 'html';
      if (ns === 'html' && nom === 'button' && bouton) {
        while (!pile.at(-1).bouton) depiler(startOffset);
        depiler(startOffset);
        ajusterModeEtranger();
      }
      const parent = pile.at(-1);
      const element = { nom, ns, integration: ns !== 'html' && estPointIntegration(ns, nom, balise), masque: Boolean(parent?.masque) || estMasque(balise), bouton: false, brut: false };

      if (ns === 'html') {
        if (nom === 'html') balisesHtml.push({ ligne: startLine, extrait: extraire(startOffset, endOffset), lang: attribut(balise, 'lang') });
        if (nom === 'img' && attribut(balise, 'alt') === undefined) imagesSansAlt.push({ ligne: startLine, extrait: extraire(startOffset, endOffset) });
        if (nom === 'label' && attribut(balise, 'for')) idsEtiquetes.add(attribut(balise, 'for'));
        const type = (attribut(balise, 'type') ?? '').trim().toLowerCase();
        if (CHAMPS_DE_FORMULAIRE.has(nom) && !TYPES_SANS_ETIQUETTE.has(type) &&
          !renseigne(attribut(balise, 'aria-label')) && !renseigne(attribut(balise, 'title'))) {
          champs.push({ ligne: startLine, extrait: extraire(startOffset, endOffset), id, dansEtiquette: Boolean(ouverts.get('label')), references: idsReferences(attribut(balise, 'aria-labelledby')) });
        }
        // Un submit ou un reset a un nom par défaut ; un bouton `<input>` n'a
        // pas de contenu, son nom ne vient que de ses attributs.
        const nomInput = { button: 'value', image: 'alt' }[type];
        if (nom === 'input' && nomInput && !renseigne(attribut(balise, nomInput)) &&
          !renseigne(attribut(balise, 'aria-label')) && !renseigne(attribut(balise, 'title'))) {
          boutons.push({ debut: startOffset, ligne: startLine, extrait: extraire(startOffset, endOffset), references: idsReferences(attribut(balise, 'aria-labelledby')) });
        }
      }

      if (ns === 'html' && nom === 'button') {
        bouton = { debut: startOffset, finOuvrante: endOffset, ligne: startLine, nomme: nommeParSesAttributs(balise), references: idsReferences(attribut(balise, 'aria-labelledby')) };
        // Jugé comme s'il était affiché, même dans un conteneur masqué qu'un script révélera.
        Object.assign(element, { bouton: true, masque: false });
      } else if (bouton && !element.masque) {
        if (nommeParSesAttributs(balise)) bouton.nomme = true;
        else for (const reference of idsReferences(attribut(balise, 'aria-labelledby'))) bouton.references.push(reference);
      }

      if (ns === 'html' ? ELEMENTS_VIDES.has(nom) : balise.selfClosing) return;
      if (ns === 'html' && MODES_TEXTE_BRUT.has(nom)) {
        decoupeur.state = MODES_TEXTE_BRUT.get(nom);
        element.brut = true;
      }
      empiler(element);
      ajusterModeEtranger();
    },
    onEndTag(balise) {
      const nom = balise.tagName;
      if (!ouverts.get(nom)) return;
      const fin = balise.location.endOffset;
      while (pile.at(-1).nom !== nom) depiler(fin);
      depiler(fin);
      ajusterModeEtranger();
    },
    onCharacter(texte) {
      const haut = pile.at(-1);
      if (bouton && !haut.masque && !haut.brut && /\S/.test(texte.chars)) bouton.nomme = true;
    },
    onNullCharacter() {},
    onWhitespaceCharacter() {},
    onComment() {},
    onDoctype() {},
    onEof() {
      if (bouton) fermerBouton(source.length);
    },
  });
  decoupeur.write(source, true);

  const visePresent = (references) => references.some((reference) => ids.has(reference));
  return {
    balisesHtml,
    imagesSansAlt,
    champsOrphelins: champs.filter((c) => !c.dansEtiquette && !(c.id && idsEtiquetes.has(c.id)) && !visePresent(c.references)),
    // Un `<button>` n'est relevé qu'à sa fermeture : l'ordre du document est rétabli pour que le constat cite le premier.
    boutonsMuets: boutons.filter((b) => !visePresent(b.references)).sort((x, y) => x.debut - y.debut),
  };
}

export function analyserAccessibiliteStatique(ctx) {
  const constats = [];

  for (const f of ctx.fichiers) {
    if (!f.executee || f.binaire || !['.html', '.htm'].includes(f.ext)) continue;
    const c = f.contenu;
    const entree = ctx.entrees.includes(f.chemin);
    const page = examinerPage(c);

    if (entree && !page.balisesHtml.some((b) => /^[a-z]{2}/i.test((b.lang ?? '').trim()))) {
      constats.push(constat({
        regle: 'F-RGAA-01', axe: 'F', severite: 'mineur', confiance: 'certain',
        titre: "La langue de la page n'est pas déclarée",
        fichier: f.chemin, ligne: page.balisesHtml[0]?.ligne ?? null,
        constat: "La balise `<html>` ne porte pas d'attribut `lang`.",
        impact: "Le lecteur d'écran prononce le contenu avec la mauvaise voix de synthèse, ce qui le rend souvent inintelligible.",
        remediation: 'Ajouter `<html lang="fr">`.',
        referentiels: ['RGAA 4.1 — critère 8.3', 'WCAG 2.1 — 3.1.1'],
      }));
    }
    if (entree && !/<title>\s*\S/i.test(c)) {
      constats.push(constat({
        regle: 'F-RGAA-02', axe: 'F', severite: 'mineur', confiance: 'certain',
        titre: 'La page du widget n\'a pas de titre',
        fichier: f.chemin,
        constat: 'Aucune balise `<title>` non vide.',
        impact: "Le titre est la première information annoncée par un lecteur d'écran à l'ouverture d'un cadre.",
        remediation: 'Ajouter un `<title>` décrivant la fonction du widget.',
        referentiels: ['RGAA 4.1 — critère 8.5', 'WCAG 2.1 — 2.4.2'],
      }));
    }

    const imgsSansAlt = page.imagesSansAlt;
    if (imgsSansAlt.length) {
      constats.push(constat({
        regle: 'F-RGAA-03', axe: 'F', severite: 'mineur', confiance: 'certain',
        titre: `${imgsSansAlt.length} image(s) sans attribut alt`,
        fichier: f.chemin, ligne: imgsSansAlt[0].ligne,
        extrait: imgsSansAlt[0].extrait,
        constat: "Des balises `<img>` ne portent pas d'attribut `alt`.",
        impact: "Le lecteur d'écran annonce le nom du fichier, ou rien. Une image décorative doit porter `alt=\"\"` explicitement pour être ignorée.",
        remediation: 'Ajouter `alt` : description brève pour une image porteuse de sens, `alt=""` pour une image décorative.',
        referentiels: ['RGAA 4.1 — critère 1.1', 'WCAG 2.1 — 1.1.1'],
      }));
    }

    const orphelins = page.champsOrphelins;
    if (orphelins.length) {
      constats.push(constat({
        regle: 'F-RGAA-04', axe: 'F', severite: 'mineur', confiance: 'probable',
        titre: `${orphelins.length} champ(s) de formulaire sans étiquette associée`,
        fichier: f.chemin, ligne: orphelins[0].ligne,
        extrait: orphelins[0].extrait,
        constat: "Des champs n'ont ni `<label>` associé, ni `aria-label`, ni `aria-labelledby` vers un élément de la page, ni `title`.",
        impact: "À la tabulation, le lecteur d'écran annonce « zone d'édition » sans dire à quoi elle sert : le formulaire devient inutilisable.",
        remediation: 'Associer un `<label for="…">`, ou à défaut un `aria-label`.',
        referentiels: ['RGAA 4.1 — critère 11.1', 'WCAG 2.1 — 3.3.2'],
      }));
    }

    const boutonsMuets = page.boutonsMuets;
    if (boutonsMuets.length) {
      constats.push(constat({
        regle: 'F-RGAA-05', axe: 'F', severite: 'mineur', confiance: 'probable',
        titre: `${boutonsMuets.length} bouton(s) sans intitulé accessible`,
        fichier: f.chemin, ligne: boutonsMuets[0].ligne,
        extrait: boutonsMuets[0].extrait,
        constat: "Des boutons n'ont ni texte lu par un lecteur d'écran, ni `aria-label`, ni `aria-labelledby` vers un élément de la page, ni `title` : leur contenu se réduit à une icône, une image sans alternative, ou rien. Pour un `<input type=\"button\">`, le texte est sa `value` ; pour un `<input type=\"image\">`, son `alt`.",
        impact: "Le bouton est annoncé « bouton » sans indication de sa fonction.",
        remediation: 'Ajouter un `aria-label` explicite sur chaque bouton à icône, une `value` sur chaque `<input type="button">`, un `alt` sur chaque `<input type="image">`.',
        referentiels: ['RGAA 4.1 — critère 11.9', 'WCAG 2.1 — 4.1.2'],
      }));
    }
  }

  constats.push(constat({
    regle: 'F-RGAA-00', axe: 'F', severite: 'info', confiance: 'certain',
    titre: 'Portée de la vérification RGAA effectuée',
    constat: "Seuls quelques critères mécaniquement vérifiables ont été contrôlés (langue, titre, alternatives textuelles, étiquettes de formulaire, intitulés de boutons).",
    impact: "L'absence de constat dans cette rubrique ne signifie pas que le widget est conforme au RGAA. Les critères de contraste, de navigation au clavier, d'ordre de tabulation et de gestion du focus demandent un examen humain, complété par le passage d'axe-core de l'axe D.",
    remediation: "Pour un déploiement sur instance officielle, faire réaliser un test utilisateur au lecteur d'écran. L'article 47 de la loi du 11 février 2005 impose l'accessibilité des services publics numériques.",
    referentiels: ['RGAA 4.1', 'Loi n° 2005-102, art. 47'],
  }));

  return constats;
}

/** Sobriété : poids réellement envoyé au navigateur de l'agent. */
export function analyserSobriete(ctx) {
  const constats = [];
  // `litteralImbrique` (axe C) est un fichier synthétique dont le contenu est
  // déjà compté dans le poids du fichier source qui le contient : l'inclure
  // ici compterait ces octets une seconde fois.
  const poids = ctx.fichiers.filter((f) => f.executee && !f.litteralImbrique).reduce((s, f) => s + f.taille, 0);
  const lourds = ctx.fichiers.filter((f) => f.executee && !f.litteralImbrique && f.taille > 500 * 1024)
    .sort((a, b) => b.taille - a.taille);

  if (poids > 2 * 1024 * 1024) {
    constats.push(constat({
      regle: 'F-ECO-01', axe: 'F', severite: poids > 5 * 1024 * 1024 ? 'majeur' : 'mineur', confiance: 'certain',
      titre: `${Math.round(poids / 1024 / 1024 * 10) / 10} Mo envoyés au navigateur à chaque ouverture du widget`,
      fichier: lourds[0]?.chemin,
      constat: lourds.length
        ? `Fichiers les plus lourds : ${lourds.slice(0, 4).map((f) => `${f.chemin} (${Math.round(f.taille / 1024)} Ko)`).join(', ')}.`
        : `Poids cumulé de la surface exécutée : ${Math.round(poids / 1024)} Ko.`,
      impact: "Le widget se recharge à chaque ouverture de la vue. Sur un poste d'agent en site distant ou sur un réseau contraint, ce volume se traduit par plusieurs secondes d'attente à chaque usage, et par une consommation réseau qui se multiplie par le nombre d'agents.",
      remediation: "Charger à la demande ce qui n'est pas nécessaire à l'affichage initial (`import()` dynamique), et vérifier que les ressources les plus lourdes — polices embarquées, bibliothèques d'export — servent réellement au scénario courant.",
      referentiels: ['Référentiel général d\'écoconception de services numériques (RGESN)'],
    }));
  }
  return constats;
}

/** Conformité aux attendus de publication du guide. */
export function analyserConformiteGuide(ctx) {
  const constats = [];
  const nomDepot = path.basename(ctx.racine);

  if (!/^grist[-_]widget[-_]/i.test(nomDepot)) {
    constats.push(constat({
      regle: 'F-GUIDE-01', axe: 'F', severite: 'info', confiance: 'certain',
      titre: `Nom de dépôt hors convention recommandée : ${nomDepot}`,
      constat: "Le guide recommande le format `grist-widget-[nom-fonctionnel]`.",
      impact: "Recommandation, non obligation. Elle facilite le repérage du dépôt par l'équipe Grist.Gouv, qui procède par découverte (« nous forkons les dépôts que nous jugeons pertinents ») : un nom conforme améliore directement les chances d'être trouvé.",
      remediation: `Renommer en \`grist-widget-${nomDepot.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^grist-?/, '')}\`.`,
      referentiels: ['Guide de contribution Grist.Gouv — Conventions'],
    }));
  }

  const secu = ctx.fichiers.find((f) => /^SECURITY(\.md)?$/i.test(path.basename(f.chemin)));
  if (!secu) {
    constats.push(constat({
      regle: 'F-GUIDE-02', axe: 'F', severite: 'mineur', confiance: 'certain',
      titre: 'Aucun canal de signalement de vulnérabilité documenté',
      constat: "Le dépôt ne contient pas de fichier SECURITY.md.",
      impact: "Le guide demande que les vulnérabilités soient signalées sans divulgation publique préalable. Sans canal indiqué, la personne qui trouve une faille ouvrira une issue publique — ce que le guide interdit explicitement.",
      remediation: "Ajouter un `SECURITY.md` renvoyant vers la politique de divulgation de l'État (https://vdp.numerique.gouv.fr/p/Send-a-report) et vers un contact direct.",
      referentiels: ['Guide de contribution Grist.Gouv — Reporting a security vulnerability'],
    }));
  }

  // Cohérence du ou des manifest.json de publication.
  for (const m of ctx.manifestes) {
    const liste = Array.isArray(m.contenu) ? m.contenu : (m.contenu.widgets ?? null);
    if (!liste) continue;
    for (const w of liste) {
      if (!w || typeof w !== 'object') continue;
      const manque = ['name', 'url', 'widgetId'].filter((k) => !w[k]);
      if (manque.length) {
        constats.push(constat({
          regle: 'F-GUIDE-03', axe: 'F', severite: 'mineur', confiance: 'certain',
          titre: `Entrée de manifeste incomplète : champs manquants (${manque.join(', ')})`,
          fichier: m.chemin, ligne: ligneDansManifeste(ctx, m.chemin, w.name ?? w.widgetId ?? w.url),
          constat: `L'entrée \`${w.name ?? w.widgetId ?? '(sans nom)'}\` ne déclare pas : ${manque.join(', ')}.`,
          impact: "Un manifeste incomplet empêche l'ajout du widget au catalogue d'une instance : Grist ne peut ni l'identifier de façon stable ni le charger.",
          remediation: 'Compléter `name`, `url`, `widgetId`, et déclarer `accessLevel` pour que le niveau d\'accès soit visible avant installation.',
          referentiels: ['Documentation Grist — Widget manifest'],
        }));
      }
      if (w.accessLevel === undefined && ctx.usagesGrist?.acces?.length) {
        constats.push(constat({
          regle: 'F-GUIDE-04', axe: 'F', severite: 'mineur', confiance: 'certain',
          titre: `Le manifeste ne déclare pas le niveau d'accès de « ${w.name ?? w.widgetId} »`,
          fichier: m.chemin, ligne: ligneDansManifeste(ctx, m.chemin, w.name ?? w.widgetId ?? w.url),
          constat: `Le code demande \`${ctx.usagesGrist.acces[0].niveau}\`, le manifeste ne mentionne pas \`accessLevel\`.`,
          impact: "L'agent découvre la demande d'accès au moment de l'installation, sans pouvoir la comparer à ce qui était annoncé au catalogue.",
          remediation: `Ajouter \`"accessLevel": "${ctx.usagesGrist.acces[0].niveau}"\` à l'entrée du manifeste.`,
          referentiels: ['Documentation Grist — Widget manifest'],
        }));
      }
    }
  }
  return constats;
}

/**
 * Ligne (1-based) d'une entrée dans le manifest.json brut, repérée par une
 * valeur de champ encore présente dans l'entrée (name, widgetId ou url) —
 * `ctx.manifestes` ne garde que le JSON déjà interprété, sans position.
 */
function ligneDansManifeste(ctx, cheminManifeste, valeurAncre) {
  if (!valeurAncre) return null;
  const f = ctx.fichiers.find((x) => x.chemin === cheminManifeste);
  if (!f?.lignes) return null;
  const i = f.lignes.findIndex((l) => l.includes(String(valeurAncre)));
  return i === -1 ? null : i + 1;
}

export const reglesF = [
  analyserSouverainete, analyserAccessibiliteStatique,
  analyserSobriete, analyserConformiteGuide,
];
