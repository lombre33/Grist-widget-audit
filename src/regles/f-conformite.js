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
import { constat } from '../moteur/modele.js';

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
      preuve: { emplacements: t.emplacements.slice(0, 10) },
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
export function analyserAccessibiliteStatique(ctx) {
  const constats = [];

  for (const f of ctx.fichiers) {
    if (!f.executee || f.binaire || !['.html', '.htm'].includes(f.ext)) continue;
    const c = f.contenu;
    const entree = ctx.entrees.includes(f.chemin);

    if (entree && !/<html[^>]+\blang\s*=\s*["'][a-z]{2}/i.test(c)) {
      const balise = c.match(/<html\b[^>]*>/i);
      constats.push(constat({
        regle: 'F-RGAA-01', axe: 'F', severite: 'mineur', confiance: 'certain',
        titre: "La langue de la page n'est pas déclarée",
        fichier: f.chemin, ligne: balise ? c.slice(0, balise.index).split('\n').length : null,
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

    const imgsSansAlt = [...c.matchAll(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi)];
    if (imgsSansAlt.length) {
      constats.push(constat({
        regle: 'F-RGAA-03', axe: 'F', severite: 'mineur', confiance: 'certain',
        titre: `${imgsSansAlt.length} image(s) sans attribut alt`,
        fichier: f.chemin, ligne: c.slice(0, imgsSansAlt[0].index).split('\n').length,
        extrait: imgsSansAlt[0][0],
        constat: "Des balises `<img>` ne portent pas d'attribut `alt`.",
        impact: "Le lecteur d'écran annonce le nom du fichier, ou rien. Une image décorative doit porter `alt=\"\"` explicitement pour être ignorée.",
        remediation: 'Ajouter `alt` : description brève pour une image porteuse de sens, `alt=""` pour une image décorative.',
        referentiels: ['RGAA 4.1 — critère 1.1', 'WCAG 2.1 — 1.1.1'],
      }));
    }

    const champs = [...c.matchAll(/<(input|select|textarea)\b[^>]*>/gi)]
      .filter((m) => !/\btype\s*=\s*["'](hidden|submit|button|reset|image)["']/i.test(m[0]))
      .filter((m) => !/\b(aria-label|aria-labelledby|title)\s*=/i.test(m[0]));
    const idsEtiquetes = new Set([...c.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
    const orphelins = champs.filter((m) => {
      const id = (m[0].match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1];
      return !id || !idsEtiquetes.has(id);
    });
    if (orphelins.length) {
      constats.push(constat({
        regle: 'F-RGAA-04', axe: 'F', severite: 'mineur', confiance: 'probable',
        titre: `${orphelins.length} champ(s) de formulaire sans étiquette associée`,
        fichier: f.chemin, ligne: c.slice(0, orphelins[0].index).split('\n').length,
        extrait: orphelins[0][0],
        constat: "Des champs n'ont ni `<label for>`, ni `aria-label`, ni `aria-labelledby`.",
        impact: "À la tabulation, le lecteur d'écran annonce « zone d'édition » sans dire à quoi elle sert : le formulaire devient inutilisable.",
        remediation: 'Associer un `<label for="…">`, ou à défaut un `aria-label`.',
        referentiels: ['RGAA 4.1 — critère 11.1', 'WCAG 2.1 — 3.3.2'],
      }));
    }

    const boutonsMuets = [...c.matchAll(/<button\b(?![^>]*\baria-label)[^>]*>\s*(?:<(?:i|span|svg)\b[^>]*>(?:\s*|<[^>]*>\s*)*<\/(?:i|span|svg)>\s*)*<\/button>/gi)];
    if (boutonsMuets.length) {
      constats.push(constat({
        regle: 'F-RGAA-05', axe: 'F', severite: 'mineur', confiance: 'probable',
        titre: `${boutonsMuets.length} bouton(s) sans intitulé accessible`,
        fichier: f.chemin, ligne: c.slice(0, boutonsMuets[0].index).split('\n').length,
        extrait: boutonsMuets[0][0],
        constat: 'Des boutons ne contiennent qu\'une icône, sans texte ni `aria-label`.',
        impact: "Le bouton est annoncé « bouton » sans indication de sa fonction.",
        remediation: 'Ajouter un `aria-label` explicite sur chaque bouton à icône.',
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
  const poids = ctx.fichiers.filter((f) => f.executee).reduce((s, f) => s + f.taille, 0);
  const lourds = ctx.fichiers.filter((f) => f.executee && f.taille > 500 * 1024)
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
