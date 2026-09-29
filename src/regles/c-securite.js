/**
 * Axe C — Sécurité applicative, analyse statique (point de vue RSSI).
 *
 * Modèle de menace retenu pour un widget Grist :
 * un widget est une page web tierce chargée dans une iframe de la page du
 * document, à laquelle l'agent accorde un niveau d'accès (`none`,
 * `read table`, `full`). Avec `full`, le widget lit ET écrit l'intégralité du
 * document via `grist.docApi`. Le risque dominant n'est donc pas la
 * compromission du widget par un tiers : c'est le widget lui-même, qui
 * dispose légitimement des données et peut les faire sortir — volontairement,
 * ou parce qu'une dépendance CDN a été compromise.
 *
 * D'où l'ordre des priorités : sortie de données > privilège excessif >
 * injection > stockage hors Grist > le reste.
 */
import path from 'node:path';
import * as acornWalk from 'acorn-walk';
import { constat } from '../moteur/modele.js';
import { pourChaqueUniteJs, nomPointe, chaineLitterale, estDynamique, extraireImportMaps, parser, syntaxeDeModule, colonneDans } from '../moteur/analyse-js.js';
import { lirePage, integriteProtege, urlDe, urlDeCarte, mentionDe } from '../moteur/page-html.js';
import { lireFeuille, nouveauBudgetCss, LIMITES_CSS } from '../moteur/css.js';

/** Hôtes considérés comme faisant partie de l'infrastructure Grist elle-même. */
const HOTES_GRIST = [/(^|\.)getgrist\.com$/i, /(^|\.)grist\.numerique\.gouv\.fr$/i, /(^|\.)gristlabs\.com$/i];

const REF_ANSSI = 'ANSSI — Recommandations pour la sécurisation des sites web';
const REF_GUIDE = 'Guide de contribution Grist.Gouv — « Safe : no requests to undocumented external services »';

function hote(url) {
  try { return new URL(url, 'https://widget.local/').hostname; } catch { return null; }
}
const estGrist = (h) => h && HOTES_GRIST.some((r) => r.test(h));
const estLocal = (h) => !h || h === 'widget.local' || h === 'localhost' || h === '127.0.0.1';

/** Mémorise un hôte externe réellement contacté, pour le contrôle croisé « documenté dans le README » de l'axe B (B-DOC-04). */
function enregistrerDestination(ctx, h) {
  if (!h) return;
  (ctx.destinationsExternes ?? (ctx.destinationsExternes = new Set())).add(h);
}

// ---------------------------------------------------------------------------
// C-GRIST — négociation du niveau d'accès
// ---------------------------------------------------------------------------

/** Relève le niveau d'accès demandé et l'usage réel de l'API document. */
export function analyserAccesGrist(ctx) {
  const constats = [];
  const usages = { ready: [], acces: [], lecture: [], ecriture: [], ecritureSchema: [] };

  pourChaqueUniteJs(ctx, {}, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      CallExpression(n) {
        const nom = nomPointe(n.callee) || '';
        const loc = { fichier: unite.chemin, ligne: ligneDe(n) };

        if (/(^|\.)grist\.ready$/.test(nom)) {
          usages.ready.push(loc);
          const opts = n.arguments[0];
          if (opts?.type === 'ObjectExpression') {
            const prop = opts.properties.find((p) => (p.key?.name ?? p.key?.value) === 'requiredAccess');
            const val = chaineLitterale(prop?.value);
            if (val) usages.acces.push({ ...loc, niveau: val });
          }
        }
        if (/docApi\.(fetchTable|listTables|getTable|fetchSelectedTable|fetchSelectedRecord|getAccessToken|getDocName)$/.test(nom)
            || /^grist\.(selectedTable|getTable)/.test(nom)) usages.lecture.push({ ...loc, appel: nom });
        if (/docApi\.applyUserActions$/.test(nom) || /selectedTable\.(create|update|destroy|upsert)$/.test(nom)) {
          usages.ecriture.push({ ...loc, appel: nom });
          // Une action de schéma (AddTable, ModifyColumn…) va au-delà de la
          // simple écriture de données : elle modifie la structure du document.
          const texte = JSON.stringify(n.arguments?.[0] ?? '');
          if (/"(AddTable|RemoveTable|AddColumn|RemoveColumn|ModifyColumn|RenameTable|AddEmptyTable)"/.test(texte)) {
            usages.ecritureSchema.push({ ...loc, appel: nom });
          }
        }
      },
    });
  });

  ctx.usagesGrist = usages;

  if (!usages.ready.length) {
    constats.push(constat({
      regle: 'C-GRIST-01', axe: 'C', severite: 'majeur', confiance: 'certain',
      titre: "Le widget n'appelle jamais grist.ready()",
      constat: "Aucun appel à `grist.ready()` n'a été trouvé dans le code exécuté.",
      impact: "Sans cet appel, le widget ne déclare ni son niveau d'accès ni ses colonnes attendues : Grist ne peut pas lui transmettre de données, et l'agent n'a aucun écran de consentement décrivant ce que le widget va lire.",
      remediation: "Appeler `grist.ready({ requiredAccess: '<niveau>', columns: [...] })` au chargement.",
      referentiels: ['Documentation Grist — Custom widgets / grist.ready()'],
    }));
  }

  const niveaux = new Set(usages.acces.map((a) => a.niveau));
  if (usages.ready.length && !usages.acces.length) {
    constats.push(constat({
      regle: 'C-GRIST-02', axe: 'C', severite: 'majeur', confiance: 'certain',
      titre: "Le niveau d'accès demandé n'est pas déclaré explicitement",
      fichier: usages.ready[0].fichier, ligne: usages.ready[0].ligne,
      constat: "`grist.ready()` est appelé sans propriété `requiredAccess`.",
      impact: "Le widget repose sur le niveau par défaut, qui peut changer selon la version de Grist et selon ce que l'agent a coché. Le comportement du widget devient dépendant de l'environnement.",
      remediation: "Déclarer explicitement le niveau minimal nécessaire : `none`, `read table`, ou `full`.",
    }));
  }

  if (niveaux.has('full')) {
    const emplacement = usages.acces.find((a) => a.niveau === 'full');
    const ecrit = usages.ecriture.length > 0;
    constats.push(constat({
      regle: 'C-GRIST-03', axe: 'C', severite: ecrit ? 'majeur' : 'critique', confiance: 'certain',
      titre: ecrit
        ? "Accès `full` demandé, avec écriture effective dans le document"
        : "Accès `full` demandé alors qu'aucune écriture n'a été détectée",
      fichier: emplacement.fichier, ligne: emplacement.ligne,
      constat: ecrit
        ? `Le widget demande \`requiredAccess: 'full'\` et réalise ${usages.ecriture.length} appel(s) d'écriture (\`applyUserActions\` / \`create\` / \`update\`).`
        : `Le widget demande \`requiredAccess: 'full'\` mais aucune écriture n'a été trouvée : ${usages.lecture.length} appel(s) de lecture seulement.`,
      impact: "`full` donne au widget la lecture ET l'écriture de toutes les tables du document, y compris celles sans rapport avec sa fonction, ainsi que l'accès aux métadonnées. En cas de faille dans le widget ou dans une de ses dépendances, c'est le document entier qui est exposé.",
      remediation: ecrit
        ? "Documenter dans le README pourquoi `full` est nécessaire, quelles tables sont écrites et dans quelles conditions. C'est la première question que posera l'équipe Grist.Gouv à la revue de sécurité."
        : "Rétrograder en `read table` : le widget ne fait que lire. `full` est ici un privilège inutile, et donc une surface d'attaque gratuite.",
      referentiels: ['Principe du moindre privilège', 'ANSSI — Guide d\'hygiène informatique, mesure 23'],
    }));
  }

  if (usages.ecritureSchema.length) {
    const p = usages.ecritureSchema[0];
    constats.push(constat({
      regle: 'C-GRIST-04', axe: 'C', severite: 'majeur', confiance: 'certain',
      titre: 'Le widget modifie la structure du document, pas seulement les données',
      fichier: p.fichier, ligne: p.ligne,
      constat: `${usages.ecritureSchema.length} action(s) de schéma détectée(s) (création ou suppression de table ou de colonne).`,
      impact: "Une erreur de logique peut détruire des colonnes de l'agent, sans que Grist ne puisse distinguer cette action d'une action volontaire de l'utilisateur.",
      remediation: 'Confirmer explicitement auprès de l\'agent avant toute action de schéma, et documenter ces actions dans le README.',
      preuve: { emplacements: usages.ecritureSchema },
    }));
  }

  return constats;
}

// ---------------------------------------------------------------------------
// C-EXFIL — sortie de données hors du périmètre
// ---------------------------------------------------------------------------

/** Appels réseau sortants dans le code JavaScript exécuté. */
export function analyserSortiesReseau(ctx) {
  const constats = [];
  const vus = new Set();

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite, fichier }) => {
    if (!ast) return;
    const signaler = (n, canal, cible, dynamique) => {
      const h = hote(cible);
      if (estLocal(h) && !dynamique) return;                 // requête sur soi-même
      if (estGrist(h)) return;                               // API Grist : hors périmètre de ce constat
      // `cible` fait partie de la clé : `importScripts('./a.js', 'https://x')`
      // signale les deux arguments sur le même nœud, avec le même `canal` —
      // sans elle, le second argument serait pris pour un doublon du premier.
      const cle = `${unite.chemin}:${ligneDe(n)}:${canal}:${cible}`;
      if (vus.has(cle)) return;
      vus.add(cle);
      if (!dynamique) enregistrerDestination(ctx, h);

      const chargeDuCode = CANAUX_DE_CODE.has(canal);
      constats.push(constat({
        regle: dynamique ? 'C-EXFIL-02' : 'C-EXFIL-01', axe: 'C',
        // Une destination littérale externe est un fait : elle bloque.
        // Une destination calculée n'est qu'une question ouverte, que l'axe D
        // tranche en capturant le trafic réellement émis. La marquer bloquante
        // reviendrait à condamner sur une hypothèse — et à apprendre au
        // lecteur à ignorer les constats bloquants.
        severite: dynamique ? 'majeur' : 'critique', bloquant: !dynamique,
        confiance: dynamique ? 'a_verifier' : 'certain',
        titre: dynamique
          ? `Requête réseau sortante vers une destination calculée à l'exécution (${canal})`
          : `Requête réseau sortante vers un service externe : ${h}`,
        fichier: unite.chemin, ligne: ligneDe(n),
        extrait: cible ? String(cible).slice(0, 200) : canal,
        constat: dynamique
          ? `Le code construit l'URL de destination à l'exécution : la lecture du code seule ne permet pas de savoir vers où part la requête.`
          : chargeDuCode
            ? `Le widget charge et exécute du code depuis \`${h}\` (${canal}), un service extérieur à l'instance Grist.`
            : `Le widget émet une requête ${canal} vers \`${h}\`, un service extérieur à l'instance Grist.`,
        impact: chargeDuCode
          ? "Un module tiers s'exécute avec tous les privilèges du widget, donc avec l'accès que l'agent a accordé au document. Si ce domaine est compromis ou remplacé, le document entier l'est aussi : c'est le scénario type d'attaque par la chaîne d'approvisionnement."
          : "Le widget a accès aux données du document. Toute requête sortante est un canal de sortie possible pour ces données, y compris à l'insu de l'agent. C'est le point qu'un RSSI regarde en premier, et le guide de contribution l'interdit explicitement pour les services non documentés.",
        remediation: dynamique
          ? "Restreindre la destination à une liste blanche de constantes, et documenter dans le README la liste exhaustive des hôtes appelés. L'axe D capture le trafic réellement émis et confirmera ou lèvera ce constat."
          : chargeDuCode
            ? "Héberger le module dans le dépôt (vendoring) et l'importer en relatif. Si l'import distant est réellement nécessaire, le déclarer dans une import map avec `integrity`, et documenter le domaine dans le README."
            : `Supprimer l'appel, ou documenter dans le README ce qui est envoyé à \`${h}\`, pourquoi, et sur quelle base juridique (RGPD) si des données personnelles transitent. Un hébergement sur instance officielle suppose une validation explicite de ce flux.`,
        referentiels: [REF_GUIDE, 'RGPD art. 5 (minimisation)', 'OWASP Top 10 A10:2021 — SSRF / flux sortants'],
      }));
    };

    // Ce qu'un module charge : `import`, `export … from` et `import()` à littéral. Une adresse relative se résout
    // contre la base du document pour un script écrit dans la page (sous une `<base>` externe, elle mène chez un
    // tiers), contre l'emplacement du fichier pour un fichier ; un nom nu n'est pas une adresse (seule une import
    // map en fait une, lue ailleurs). Un `import` statique d'un script classique de la page est une erreur de
    // syntaxe : rien n'y est chargé, rien n'est dit.
    const importer = (n, source, canal) => {
      if (canal !== 'import() distant' && unite.inline && !unite.module) return;
      const valeur = chaineLitterale(source);
      if (valeur === null) return;
      const url = cibleReseau(urlDeCarte(valeur, unite.inline ? unite.baseBrute : null, fichier.chemin));
      if (url) signaler(n, canal, url.href, false);
    };

    walk.simple(ast, {
      CallExpression(n) {
        const nom = nomPointe(n.callee) || '';
        if (/(^|\.)fetch$/.test(nom)) {
          const arg = n.arguments[0];
          signaler(n, 'fetch()', chaineLitterale(arg) ?? '(URL calculée)', estDynamique(arg));
        }
        if (/\.open$/.test(nom) && n.arguments.length >= 2) {
          const arg = n.arguments[1];
          const v = chaineLitterale(arg);
          if (v !== null || estDynamique(arg)) signaler(n, 'XMLHttpRequest', v ?? '(URL calculée)', estDynamique(arg));
        }
        if (/sendBeacon$/.test(nom)) signaler(n, 'navigator.sendBeacon()', chaineLitterale(n.arguments[0]) ?? '(URL calculée)', estDynamique(n.arguments[0]));
        if (/importScripts$/.test(nom)) {
          // `importScripts(a, b, c)` charge TOUS ses arguments, pas seulement
          // le premier — un seul appel avec une source sûre en tête et une
          // source externe en second argument échappait entièrement à ce
          // constat avant cette boucle.
          for (const arg of n.arguments) {
            signaler(n, 'importScripts()', chaineLitterale(arg) ?? '(URL calculée)', estDynamique(arg));
          }
        }
      },
      NewExpression(n) {
        const nom = nomPointe(n.callee) || '';
        if (/^(WebSocket|EventSource)$/.test(nom)) {
          signaler(n, nom, chaineLitterale(n.arguments[0]) ?? '(URL calculée)', estDynamique(n.arguments[0]));
        }
      },
      ImportExpression(n) { importer(n, n.source, 'import() distant'); },
      ImportDeclaration(n) { importer(n, n.source, 'import statique'); },
      ExportAllDeclaration(n) { importer(n, n.source, 'export … from'); },
      ExportNamedDeclaration(n) { if (n.source) importer(n, n.source, 'export … from'); },
    });
  });

  return constats;
}

/** Les canaux par lesquels du code est chargé (et non une requête de données) : le constat le dit. */
const CANAUX_DE_CODE = new Set(['import() distant', 'import statique', 'export … from']);

const MENTION_GABARIT_RESSOURCE = 'dans un `<template>` : ne se charge et ne s\'active qu\'une fois le gabarit cloné puis inséré';
const precise = (texte, mention) => (mention ? `${texte} Précision : ${mention}.` : texte);
const jetons = (valeur) => (valeur ?? '').toLowerCase().split(/[\t\n\f\r ]+/).filter(Boolean);
const MENTION_SANS_EXECUTION = 'le navigateur demande ce fichier sans l\'exécuter (script jamais fermé, ou `src` d\'un script SVG ou MathML)';
// Ce que le navigateur charge vraiment : une URL `http:` ou `https:`, résolue
// depuis la base effective de la page (une `<base href>` externe fait charger
// chez un tiers un `src` relatif, et un `src` relatif sous une base relative
// se résout contre l'URL de la page). Les autres schémas ne chargent rien de tiers.
const cibleReseau = (url) => (url && /^https?:$/.test(url.protocol) ? url : null);

/** Ce qu'un `<link>` charge, par usage (voir `usageLien`) : libellé, sévérité de base et article du libellé. */
const USAGES_LIEN = {
  feuille: ['feuille de style', 'majeur', 'une'],
  icone: ['icône', 'mineur', 'une'],
  modulepreload: ['préchargement de module', 'majeur', 'un'],
  prefetch: ['préchargement (prefetch)', 'majeur', 'un'],
  prerender: ['préchargement (prerender)', 'majeur', 'un'],
  connexion: ['connexion anticipée', 'mineur', 'une'],
};
const PRECHARGE_PAR_AS = { script: 'majeur', style: 'majeur', fetch: 'majeur', track: 'majeur', font: 'mineur', image: 'mineur' };

/**
 * Pourquoi un `<link>` a la sévérité qu'il a, dit dans le constat : la note
 * suit ce que le navigateur en fait, pas le nom de la relation. Une icône, une
 * police, une image ou une connexion anticipée ne sont jamais exécutées ni
 * appliquées ; tout ce qu'une page peut exécuter, appliquer ou lire garde sa
 * sévérité, car on ne sait pas toujours ce qui s'en sert (un `onload` qui
 * passe `rel` à `stylesheet`, un chargeur calculé).
 */
const RAISON_LIEN_AFFICHAGE = "Ce lien ne récupère qu'une ressource d'affichage : le navigateur ne l'exécute ni ne l'applique jamais, mais le tiers y voit l'adresse IP et l'heure de chaque affichage.";
const RAISON_LIEN_CONNEXION = "Le navigateur n'exécute ni n'applique jamais rien de ce lien, qui n'ouvre qu'une connexion : le tiers y voit l'adresse IP (avec `preconnect`) et l'heure de chaque affichage.";
const RAISON_LIEN_EXECUTABLE = "Ce lien récupère de quoi la page peut exécuter, appliquer ou lire, sans que ce qui s'en sert soit toujours visible (un `onload` qui passe `rel` à `stylesheet`, un chargeur calculé) : faute de garantie, la sévérité n'est pas abaissée.";
const RAISON_LIEN_FEUILLE = "Une feuille de style tierce s'applique à la page : ses règles changent ce qui s'affiche, peuvent faire charger d'autres ressources et lire, par leurs sélecteurs, des valeurs présentes dans la page.";
const raisonDeLien = (usage, severite) => (usage.genre === 'feuille' ? RAISON_LIEN_FEUILLE : usage.genre === 'connexion' ? RAISON_LIEN_CONNEXION : severite === 'mineur' ? RAISON_LIEN_AFFICHAGE : RAISON_LIEN_EXECUTABLE);

/** Texte de la ligne `ligne` (à partir de 1) d'un fichier, sans le relire en entier à chaque constat. */
function ligneDe(f, ligne) {
  f.lignesCache ??= f.contenu.split('\n');
  return f.lignesCache[ligne - 1] ?? '';
}

/** Un chargement externe déclaré dans une page ou une feuille : C-EXFIL-04 (API Grist hors instance) ou C-EXFIL-03. */
function signalerChargementExterne(ctx, f, e) {
  const constats = [];
  const cible = cibleReseau(urlDe(e.url, e.baseBrute, f.chemin));
  if (!cible) return constats;                                      // data:, blob:, about:, file: … : rien n'est chargé chez un tiers
  const h = cible.hostname;
  if (estLocal(h)) return constats;                                 // relatif (widget.local) : pas une ressource tierce
  const gristPlugin = estGrist(h) && /grist-plugin-api\.js/.test(e.url);

  if (gristPlugin) {
    // Cas très fréquent et spécifique : charger l'API Grist depuis
    // docs.getgrist.com plutôt que depuis l'instance qui héberge le widget.
    constats.push(constat({
      regle: 'C-EXFIL-04', axe: 'C', severite: 'majeur', confiance: 'certain',
      titre: "L'API Grist est chargée depuis un domaine externe au lieu de l'instance hôte",
      fichier: f.chemin, ligne: e.ligne, extrait: e.balise,
      constat: precise(`\`grist-plugin-api.js\` est chargé depuis \`${h}\`.`, e.mention),
      impact: "Le widget hébergé sur une instance souveraine (grist.numerique.gouv.fr) va chercher son script pivot sur un domaine tiers. Cela crée une dépendance de disponibilité et de confiance envers ce domaine, envoie l'adresse IP de chaque agent à un tiers, et casse le widget si l'instance applique une CSP stricte ou fonctionne en réseau fermé.",
      remediation: "Charger l'API en relatif : `<script src=\"/grist-plugin-api.js\"></script>`. L'instance qui sert le widget sert aussi l'API ; c'est la forme attendue pour un hébergement sur instance officielle.",
      referentiels: [REF_GUIDE, 'Souveraineté numérique — DINUM'],
    }));
    return constats;
  }

  if (estGrist(h)) return constats;
  enregistrerDestination(ctx, h);

  const sri = e.protege;
  const bloquant = Boolean(e.code) && !sri;
  constats.push(constat({
    regle: 'C-EXFIL-03', axe: 'C',
    severite: bloquant ? 'critique' : e.severite,
    bloquant,
    confiance: e.confiance ?? 'certain',
    titre: `Ressource externe chargée depuis ${h} (${e.type})`,
    fichier: f.chemin, ligne: e.ligne, extrait: e.balise,
    constat: precise(e.connexion
      ? `Le widget prépare une connexion vers \`${h}\` (\`preconnect\` ou \`dns-prefetch\`) : le navigateur y résout le nom, et pour \`preconnect\` y ouvre une connexion, avant tout usage. Aucune ressource n'est demandée.${e.note ?? ''}`
      : `Le widget charge ${e.article ?? 'une'} ${e.type} depuis \`${h}\`${sri ? ' (avec attribut `integrity`)' : ' sans contrôle d\'intégrité (`integrity`)'}.${e.note ?? ''}`, e.mention),
    impact: e.code
      ? "Un script tiers s'exécute avec tous les privilèges du widget, donc avec l'accès que l'agent a accordé au document. Si ce domaine est compromis ou remplacé, le document entier l'est aussi. C'est le scénario type d'attaque par la chaîne d'approvisionnement."
      : e.connexion
        ? "Le tiers voit l'adresse IP de chaque agent et l'heure de l'affichage, sans que le widget n'ait besoin de lui demander quoi que ce soit."
        : "La ressource est récupérée sur un domaine tiers à chaque affichage : l'adresse IP et l'horodatage de chaque agent sont transmis à ce tiers, et la disponibilité du widget dépend de lui.",
    remediation: e.connexion
      ? "Retirer la connexion anticipée, ou la limiter à une origine que le widget utilise réellement et la documenter dans le README."
      : "Héberger la ressource dans le dépôt du widget (vendoring) et la servir en relatif. Si le chargement distant est réellement nécessaire, ajouter `integrity` et `crossorigin`, et documenter le domaine dans le README.",
    referentiels: [REF_ANSSI, 'OWASP Top 10 A08:2021 — Intégrité logicielle', REF_GUIDE],
  }));
  return constats;
}

/** Ce que lit `lireFeuille` dans une feuille de style, au format des chargements : une référence (`url`, `type`, `severite`, `note`, `confiance`) ou la borne atteinte (`borne`). */
function chargementsDeFeuille(f, feuille, entrees, position) {
  const sortie = [];
  for (const e of entrees) {
    const { ligne, decalage } = position(e);
    // Le fragment autour de la référence quand on sait où elle est ; sinon le début de sa ligne.
    const balise = decalage == null ? ligneDe(f, ligne).slice(0, 300) : extraitAutour(f.contenu, decalage);
    if (e.sorte === 'borne') {
      sortie.push({ borne: true, raison: e.raison, ligne, balise });
      continue;
    }
    const [type, severite] = e.sorte === 'url' ? ['ressource CSS', 'mineur'] : ['@import CSS', 'majeur'];
    const notes = [];
    if (feuille.modele) notes.push("Cette feuille est dans un `<template>` : elle ne s'applique qu'une fois le gabarit inséré dans la page.");
    if (e.apresRegle) notes.push("Cet `@import` suit une règle : le navigateur l'ignore si cette règle est valide, ce que l'analyse ne sait pas trancher.");
    if (e.sorte === 'url') notes.push("Le navigateur ne la demande que si la déclaration est valide et si la règle s'applique à un élément de la page (une police : si un texte l'utilise) ; l'analyse ne le tranche pas, la référence est écrite dans le code.");
    const note = notes.length ? ` ${notes.join(' ')}` : '';
    sortie.push({ url: e.url, type, severite, baseBrute: feuille.baseBrute, ligne, balise, protege: false, note, confiance: note ? 'probable' : 'certain' });
  }
  return sortie;
}

function constatBorne(f, e) {
  return constat({
    regle: 'C-EXFIL-03', axe: 'C', severite: 'info', confiance: 'certain', mesurePartielle: true,
    titre: 'Feuilles de style `data:` imbriquées : lecture arrêtée',
    fichier: f.chemin, ligne: e.ligne, extrait: e.balise,
    constat: `La lecture des feuilles de style \`data:\` imbriquées s'est arrêtée à sa borne de ${e.raison === 'profondeur' ? `profondeur (${LIMITES_CSS.profondeur} niveaux)` : `volume (${LIMITES_CSS.octets} octets)`} : ce qui se trouve au-delà n'a pas été audité.`,
    impact: "Un `@import` peut enchaîner des feuilles `data:` sans limite, chacune pouvant en charger une depuis un hôte externe. Le navigateur les suit toutes.",
    remediation: "Remplacer ces feuilles `data:` par un fichier CSS du dépôt, lu en une fois.",
    referentiels: [REF_ANSSI],
  });
}

// Élément HTML porteur d'une ressource → attribut d'URL, libellé, sévérité de base. `link` a sa propre lecture (`usageLien`).
const RESSOURCES = {
  iframe: { attr: 'src', type: 'iframe', article: 'une', severite: 'majeur' },
  img: { attr: 'src', type: 'image', article: 'une', severite: 'mineur' },
  object: { attr: 'data', type: 'objet (<object>)', article: 'un', severite: 'mineur' },
  embed: { attr: 'src', type: 'contenu embarqué (<embed>)', article: 'un', severite: 'mineur' },
};

/** Une URL vide (ou faite de blancs) ne charge rien : elle se résoudrait vers la page ou son `<base>`, où le navigateur ne demande pourtant rien. */
const urlVide = (url) => /^[\t\n\f\r ]*$/.test(url);

/**
 * Tout ce qu'un fichier HTML ou CSS fait charger, dans l'ordre du document :
 * chaque script à `src`, chaque élément porteur d'une ressource, puis le CSS
 * écrit dans la page. C'est ce que `analyserRessourcesExternes` transforme en
 * constats, sans rien filtrer : les URL locales y figurent, et les tests
 * comparent cette liste à ce que Chromium demande vraiment.
 *
 * `feuilleLibre` : le mode de la page qui charge une feuille `.css` n'est pas
 * connu ; une page en quirks dans le dépôt suffit à faire lire ses
 * `@import data:` de tout type MIME.
 */
export function chargementsDeFichier(f, { feuilleLibre = false } = {}) {
  const sortie = [];
  if (['.html', '.htm'].includes(f.ext)) {
    const { scripts, ressources, feuilles, position } = lirePage(f.contenu);
    // `protege` suit ce que `integrity` protège vraiment (un jeton bien
    // formé) : une valeur vide ou bidon laisse le navigateur charger
    // n'importe quoi, elle ne doit donc pas déclasser.
    // Dans l'ordre du document : chaque URL qu'un script demande (`code` : le navigateur exécute ce qu'il reçoit ; sinon il ne fait que le demander).
    for (const s of scripts) {
      for (const c of s.chargements) {
        sortie.push({
          url: c.valeur, type: c.execute ? 'script' : 'requête de script sans exécution', article: c.execute ? 'un' : 'une',
          severite: c.execute ? 'critique' : 'majeur', code: c.execute,
          protege: integriteProtege(s.attributs.get('integrity')), baseBrute: s.baseBrute, ligne: s.ligne, balise: s.balise,
          mention: mentionDe({ dansTemplate: s.dansTemplate, seulementStandard: c.seulementStandard }) ?? (c.execute ? null : MENTION_SANS_EXECUTION),
        });
      }
    }
    for (const r of ressources) {
      const protege = integriteProtege(r.attributs.get('integrity'));
      if (r.nom === 'link') {
        for (const u of r.usages) {
          const [type, severite, article] = u.genre === 'precharge' ? [`préchargement de ${u.as}`, PRECHARGE_PAR_AS[u.as], 'un'] : USAGES_LIEN[u.genre];
          for (const url of u.urls) sortie.push({ url, type, article, severite, connexion: u.genre === 'connexion', note: ` ${raisonDeLien(u, severite)}`, protege, baseBrute: r.baseBrute, ligne: r.ligne, balise: r.balise, mention: r.dansTemplate ? MENTION_GABARIT_RESSOURCE : null });
        }
        continue;
      }
      const meta = RESSOURCES[r.nom];
      const url = meta && r.attributs.get(meta.attr);
      if (url != null && !urlVide(url)) sortie.push({ url, type: meta.type, article: meta.article, severite: meta.severite, protege, baseBrute: r.baseBrute, ligne: r.ligne, balise: r.balise, mention: r.dansTemplate ? MENTION_GABARIT_RESSOURCE : null });
    }
    // CSS écrit dans la page : `<style>`, attributs `style`, `<link>` vers une feuille `data:`.
    const budget = nouveauBudgetCss();
    for (const feuille of feuilles) {
      sortie.push(...chargementsDeFeuille(f, feuille, lireFeuille(feuille, budget), (e) => position(feuille, e.debut, e.sorte === 'precharge')));
    }
  }
  // Fichier CSS : la même lecture que le CSS écrit dans une page. Une feuille que seul un `<template>` charge ne s'applique qu'une fois le gabarit inséré : ce qu'elle fait charger le dit aussi (`f.mention` est dite pour du code, une feuille n'en est pas).
  if (f.ext === '.css') {
    const feuille = { sorte: 'style', applique: true, precharge: false, modele: false, texte: f.contenu, mimeLibre: feuilleLibre, baseBrute: null };
    const mention = f.mention === mentionDe({ dansTemplate: true }) ? MENTION_GABARIT_RESSOURCE : f.mention;
    for (const e of chargementsDeFeuille(f, feuille, lireFeuille(feuille), (e) => ({ ligne: numeroLigne(f.contenu, e.debut), decalage: e.debut }))) sortie.push(e.borne || !mention ? e : { ...e, mention });
  }
  return sortie;
}

/** Ressources externes déclarées dans le HTML et le CSS. */
export function analyserRessourcesExternes(ctx) {
  const constats = [];
  const feuilleLibre = ctx.fichiers.some((g) => g.executee && !g.binaire && ['.html', '.htm'].includes(g.ext) && lirePage(g.contenu).quirks);

  for (const f of ctx.fichiers) {
    if (!f.executee || f.binaire) continue;

    for (const e of chargementsDeFichier(f, { feuilleLibre })) constats.push(...(e.borne ? [constatBorne(f, e)] : signalerChargementExterne(ctx, f, e)));

    // Import map (<script type="importmap">) : le contenu est du JSON, jamais
    // exécuté (voir `unitesJs`), donc invisible à toute règle qui lit du JS.
    // Une bibliothèque résolue par un import nu après une entrée d'import map
    // est chargée à l'exécution comme un <script src>, avec la même exigence
    // d'intégrité — les import maps prévoient une clé `integrity` de premier
    // niveau à cet effet (WHATWG).
    if (['.html', '.htm'].includes(f.ext)) for (const e of extraireImportMaps(f.contenu)) {
      const cible = cibleReseau(urlDeCarte(e.url, e.baseBrute, f.chemin));
      if (!cible) continue;
      const h = cible.hostname;
      if (estLocal(h) || estGrist(h)) continue;
      enregistrerDestination(ctx, h);
      constats.push(constat({
        regle: 'C-EXFIL-03', axe: 'C',
        severite: e.sri ? 'majeur' : 'critique', bloquant: !e.sri,
        confiance: 'certain',
        titre: `Import map : dépendance chargée depuis ${h} (${e.spec})`,
        fichier: f.chemin, ligne: numeroLigne(f.contenu, e.index), extrait: `"${e.spec}": "${e.url}"`,
        constat: precise(`L'import map fait résoudre \`${e.spec}\` vers \`${e.url}\`${e.sri ? " (couverte par la clé `integrity` de l'import map)" : ' sans empreinte `integrity` valide dans l\'import map'}.`, e.mention),
        impact: "Un import nu résolu par cette carte s'exécute avec tous les privilèges du widget, exactement comme une balise <script src> : si ce domaine est compromis ou remplacé, le document entier l'est aussi. C'est le scénario type d'attaque par la chaîne d'approvisionnement.",
        remediation: "Héberger la bibliothèque dans le dépôt (vendoring) et la faire résoudre vers un chemin relatif, ou ajouter une entrée `integrity` pour cette URL dans l'import map et documenter le domaine dans le README.",
        referentiels: [REF_ANSSI, 'OWASP Top 10 A08:2021 — Intégrité logicielle', REF_GUIDE],
      }));
    }
  }
  return constats;
}

// ---------------------------------------------------------------------------
// C-XSS — injection dans le DOM et exécution dynamique
// ---------------------------------------------------------------------------

const SINKS_HTML = /(innerHTML|outerHTML|insertAdjacentHTML|srcdoc)$/;

/** Partie littérale de tête d'une chaîne de `+` (`'data:...' + code` → `'data:...'`), ou d'un gabarit (son premier segment fixe). null si le nœud ne commence par rien de littéral. */
function prefixeConcatenationLitteral(noeud) {
  if (!noeud) return null;
  if (noeud.type === 'Literal' && typeof noeud.value === 'string') return noeud.value;
  if (noeud.type === 'TemplateLiteral') return noeud.quasis[0]?.value.cooked ?? null;
  if (noeud.type === 'BinaryExpression' && noeud.operator === '+') return prefixeConcatenationLitteral(noeud.left);
  return null;
}

/** Nom simple d'un appelé (`Worker`, `createObjectURL`…), sans se soucier d'un alias global de tête (`window.`, `self.`, `globalThis.`) : `nomPointe(noeud)` donne la chaîne pointée complète, on ne garde que son dernier segment. Un objet non lié à l'alias qui porte la même propriété (`monObjet.Worker`) matche aussi — un compromis déjà fait par ce fichier pour `eval`/`Function`/`document.write`, gardé ici pour la même raison : l'angle mort d'un nom réel manqué coûte plus qu'un faux positif rarissime. */
function nomFinal(noeud) {
  return (nomPointe(noeud) || '').split('.').pop();
}

/** Chaîne littérale résolue (ou son préfixe de concaténation/gabarit) qui commence par l'un des schémas donnés (`data:`, `blob:`, `javascript:`…), sans se soucier de la forme d'écriture. */
function debuteParSchema(noeud, ...schemas) {
  const texte = chaineLitterale(noeud) ?? prefixeConcatenationLitteral(noeud);
  if (texte === null) return false;
  const t = texte.trim();
  return schemas.some((s) => new RegExp(`^${s}:`, 'i').test(t));
}

/** Classe une chaîne littérale résolue (ou son préfixe) par son schéma. */
function classifierSchemaLitteral(texte) {
  const t = texte.trim();
  if (/^(data|blob):/i.test(t)) return 'code-en-chaine';
  if (/^https?:\/\//i.test(t)) return 'url-absolue';
  return 'chemin-local';
}

/**
 * Classe la source passée à `new Worker(...)`/`new SharedWorker(...)`.
 * Vérifié par l'exécution (vraie Chromium) : un `importScripts()` vers un
 * domaine externe, sans aucun en-tête CORS, s'exécute aussi bien depuis un
 * worker `blob:` que depuis un worker `data:` — ni l'un ni l'autre n'a de
 * mécanisme d'intégrité, et surtout ni l'un ni l'autre n'est un fichier que
 * l'audit peut lire. Reconnaît un alias global de tête (`window.Worker`,
 * `self.URL.createObjectURL`…) via `nomFinal()`.
 *
 * - 'chemin-local' : chemin relatif littéral (`./w.js`), ou
 *   `new URL('./w.js', <base quelconque>)` — déjà suivi par
 *   `referencesSortantes()` pour la surface exécutée, rien à signaler ici.
 *   C'est le SCHÉMA du premier argument de `new URL(...)` qui décide, jamais
 *   sa base : si ce premier argument résout en `data:`/`blob:`, l'URL
 *   obtenue l'est aussi quelle que soit la base (ces schémas s'auto-suffisent
 *   et ignorent la base par construction) ; s'il est relatif, le résultat
 *   est local quelle que soit la base — et si la base est elle-même une URL
 *   absolue externe écrite en dur, le résultat est une URL absolue externe,
 *   qui retombe dans le cas 'url-absolue' ci-dessous (mort par construction,
 *   donc sans risque réel) : rien de ce qu'une base peut faire ne rend ce
 *   raisonnement par le seul premier argument incorrect.
 * - 'url-absolue' : URL http(s) littérale — lève toujours une
 *   `SecurityError` synchrone (vérifié), donc jamais exécutée : rien à
 *   signaler (voir be1b5f4, C-EXFIL-07 retirée pour cette raison).
 * - 'code-en-chaine' : une URL `data:`/`blob:` littérale ou obtenue par
 *   concaténation/gabarit, ou tout appel à `createObjectURL(...)` (quel que
 *   soit son propre argument — Blob littéral, Blob depuis une variable, ou
 *   variable déjà porteuse d'un Blob/File : aucune de ces formes n'est un
 *   fichier que l'audit peut lire, la question de fond est la même dans
 *   tous les cas). Signalé quel que soit le CONTENU, au même titre qu'`eval()`
 *   est signalé quel que soit son argument : chercher une source de confiance
 *   dans ce contenu ne prouve rien, et ne pas le faire n'enlève rien à la
 *   question de fond, qui est la construction elle-même — récupérer un
 *   contenu (déjà vu par C-EXFIL-01/02 si le Blob vient d'un `fetch`) et
 *   l'exécuter comme du code sont deux faits distincts, comme un `eval()` de
 *   la réponse d'un `fetch` relève à la fois de C-EXFIL et d'`eval`.
 * - 'non-resolue' : tout le reste (variable, gabarit interpolé, expression
 *   calculée) — y compris une URL `blob:` assemblée dans une instruction
 *   précédente, que l'analyse d'une seule expression ne peut pas remonter.
 */
/**
 * Un préfixe littéral de tête (concaténation, gabarit interpolé) ne peut
 * décider QUE le cas `code-en-chaine` : une fois le schéma `data:`/`blob:`
 * confirmé en tête, aucune suite ne peut plus le changer. Il ne décide
 * jamais `chemin-local` : une suite inconnue (variable de sélection du
 * fichier) peut désigner n'importe quel fichier, que l'analyse ne peut pas
 * énumérer — ce cas reste `non-resolue`, pas un chemin réputé sûr.
 */
function estPrefixeCodeEnChaine(noeud) {
  const prefixe = prefixeConcatenationLitteral(noeud);
  return prefixe !== null && /^(data|blob):/i.test(prefixe.trim());
}

/**
 * Extrait le texte du code exécuté par un Worker/SharedWorker classé
 * `code-en-chaine`, quand il est ENTIÈREMENT littéral (data: littérale — y
 * compris en base64 — ou Blob dont TOUS les éléments du tableau sont des
 * littéraux). Retourne null si une partie est calculée (variable, `atob()`,
 * concaténation avec une variable) : ce contenu reste hors de portée, comme
 * avant — c'est là qu'est le vrai risque, pas dans un littéral qu'on peut lire.
 */
function decoderDataLitteral(lit) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(lit.trim());
  if (!m) return null;
  if (/;base64\s*$/i.test(m[1])) {
    try { return Buffer.from(m[2], 'base64').toString('utf8'); } catch { return null; }
  }
  try { return decodeURIComponent(m[2]); } catch { return m[2]; }
}

function extraireCodeLitteralWorker(arg) {
  // `plierLitteraux` (pas seulement `chaineLitterale`) : une URL data:/blob:
  // ou un élément de tableau assemblés par concaténation de CONSTANTES
  // (`'data:...,' + '...'`, `Blob(['a' + 'b'])`) sont tout aussi littéraux
  // qu'écrits en une seule chaîne — sans ce repli, ce cas précis retombait
  // à tort dans le texte « calculé à l'exécution : rien n'est lu », alors
  // qu'il n'y a rien de calculé (relevé par la coordination le 2026-09-28).
  const lit = plierLitteraux(arg);
  if (lit !== null) return decoderDataLitteral(lit);

  if (arg.type === 'CallExpression' && nomFinal(arg.callee) === 'createObjectURL') {
    const blob = arg.arguments[0];
    if (blob?.type === 'NewExpression' && nomFinal(blob.callee) === 'Blob' && blob.arguments[0]?.type === 'ArrayExpression') {
      // Chaque élément du tableau peut être un littéral direct, une
      // concaténation de constantes (`plierLitteraux`), OU lui-même encodé
      // (`atob(...)`, `String.fromCharCode(...)`) : un eval() équivalent
      // décode déjà ces deux formes (voir `traiterAppelExecution`), le même
      // contenu caché dans un Worker doit recevoir le même traitement, pas
      // rester à tort « pas entièrement littéral » (relevé par la
      // coordination le 2026-09-28).
      const morceaux = blob.arguments[0].elements.map((el) => plierLitteraux(el) ?? decoderAtobLitteral(el) ?? decoderFromCharCodeLitteral(el));
      if (morceaux.length && morceaux.every((m) => m !== null)) return morceaux.join('');
    }
  }

  // `new URL('data:...')` : classifierSourceWorker fait déjà dépendre la
  // classification du seul premier argument, quelle que soit la base
  // (voir sa documentation) — extraire le contenu suit le même
  // raisonnement, en ignorant `arg.arguments[1]` de la même façon. Sans
  // cette branche, ce cas précis retombait à tort dans le texte « contenu
  // pas entièrement littéral », alors qu'il l'est.
  if (arg.type === 'NewExpression' && nomFinal(arg.callee) === 'URL') {
    return extraireCodeLitteralWorker(arg.arguments[0]);
  }

  return null;
}

function classifierSourceWorker(arg) {
  if (!arg) return 'non-resolue';

  const lit = chaineLitterale(arg);
  if (lit !== null) return classifierSchemaLitteral(lit);
  if (estPrefixeCodeEnChaine(arg)) return 'code-en-chaine';

  if (arg.type === 'CallExpression' && nomFinal(arg.callee) === 'createObjectURL') {
    return 'code-en-chaine';
  }

  if (arg.type === 'NewExpression' && nomFinal(arg.callee) === 'URL') {
    const xLit = chaineLitterale(arg.arguments[0]);
    if (xLit !== null) return classifierSchemaLitteral(xLit);
    if (estPrefixeCodeEnChaine(arg.arguments[0])) return 'code-en-chaine';
  }

  return 'non-resolue';
}

const MAX_PROFONDEUR_CODE_IMBRIQUE = 5;

/**
 * Replie une concaténation de `+` entre littéraux/gabarits statiques en une
 * seule chaîne : `'al' + 'ert(1)'` vaut alors comme le littéral `'alert(1)'`,
 * pas comme une valeur « calculée à l'exécution » — le texte que produisait
 * `chaineLitterale` seul (qui ne traite pas `BinaryExpression`) était inexact
 * sur ce cas précis, relevé par la coordination le 2026-09-28 : une
 * concaténation de constantes n'est pas une inconnue, c'est un peu
 * d'arithmétique de chaînes qu'on peut faire soi-même à l'analyse. Retourne
 * null dès qu'une partie n'est pas entièrement littérale (variable, appel).
 */
function plierLitteraux(noeud) {
  if (!noeud) return null;
  const direct = chaineLitterale(noeud);
  if (direct !== null) return direct;
  if (noeud.type === 'BinaryExpression' && noeud.operator === '+') {
    const gauche = plierLitteraux(noeud.left);
    if (gauche === null) return null;
    const droite = plierLitteraux(noeud.right);
    if (droite === null) return null;
    return gauche + droite;
  }
  return null;
}

/** `atob(x)` retourne toujours une chaîne : si `x` est lui-même littéral (ou une concaténation qui se replie), son décodage est aussi peu une boîte noire qu'un littéral direct. */
function decoderAtobLitteral(noeud) {
  if (noeud?.type !== 'CallExpression' || nomFinal(noeud.callee) !== 'atob' || noeud.arguments.length !== 1) return null;
  const arg = plierLitteraux(noeud.arguments[0]);
  if (arg === null) return null;
  try { return Buffer.from(arg, 'base64').toString('utf8'); } catch { return null; }
}

/**
 * Un littéral NON-chaîne (`null`, un nombre, un booléen) a une valeur
 * entièrement déterminée à la lecture : `ToString()` la fixe sans ambiguïté
 * (`String(null) === 'null'`, `String(42) === '42'`…), exactement comme une
 * chaîne littérale directe. Exclut une regex littérale (`/x/`), dont la
 * valeur n'est pas un primitif simple à coercer ainsi. `null` retourné
 * signifie ici « n'est pas un tel littéral », pas « vaut null » — comme le
 * reste des fonctions `plierLitteraux`/`decoder*Litteral` de ce fichier.
 */
function coercerLitteralNonChaine(noeud) {
  if (noeud?.type !== 'Literal' || typeof noeud.value === 'string' || noeud.regex) return null;
  return String(noeud.value);
}

/**
 * Noms liés par un motif de paramètre ou de déclaration, récursivement
 * (`Identifier`, `AssignmentPattern` — valeur par défaut —, `ObjectPattern`,
 * `ArrayPattern`, `RestElement`) : un paramètre déstructuré ou à valeur par
 * défaut (`function f({code}) {}`, `function f(code = x) {}`) ou une
 * variable déstructurée (`const {code} = x`) LIE bien ce nom dans sa portée,
 * même si sa valeur n'est jamais résolvable par ce mécanisme — sans cette
 * liste, une telle liaison était invisible à la recherche de portée, qui ne
 * testait qu'`Identifier`, et laissait la portée continuer vers l'extérieur
 * jusqu'à masquer, par erreur, une déclaration homonyme sans rapport
 * (relevé par la coordination le 2026-09-28).
 */
function nomsLies(motif) {
  if (!motif) return [];
  if (motif.type === 'Identifier') return [motif.name];
  if (motif.type === 'AssignmentPattern') return nomsLies(motif.left);
  if (motif.type === 'RestElement') return nomsLies(motif.argument);
  if (motif.type === 'ObjectPattern') return motif.properties.flatMap((p) => nomsLies(p.type === 'RestElement' ? p : p.value));
  if (motif.type === 'ArrayPattern') return motif.elements.flatMap((e) => nomsLies(e));
  return [];
}

/** Déballe un export (`export function f() {}`, `export const x = …`, `export default function f() {}`) vers sa déclaration réelle : un export N'EST PAS une portée, juste une visibilité en plus, et une déclaration exportée doit être vue comme n'importe quelle autre par la marche de portée — sans ce déballage, `export function tick(){}` ou `export const code = "…"` étaient invisibles à `trouverLiaisonVisible` (relevé par la coordination le 2026-09-28). */
function declarationEffective(stmt) {
  if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) return stmt.declaration;
  if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration?.type === 'FunctionDeclaration' && stmt.declaration.id) return stmt.declaration;
  return stmt;
}

/**
 * Cherche, du site d'appel vers l'extérieur, la portée la plus proche qui
 * lie `nom` : un paramètre de fonction (y compris déstructuré/par défaut),
 * un paramètre de `catch`, la variable d'un `for`/`for…of`/`for…in`, une
 * déclaration `function`/`const`/`let`/`var` (exportée ou non) d'un bloc ou
 * du programme. Une seule marche d'ancêtres pour tous les cas : la portée JS
 * veut que la plus proche masque tout le reste, quelle que soit sa nature
 * (un paramètre masque une fonction homonyme du fichier, une variable de
 * bloc masque à son tour un paramètre plus extérieur) — les traiter
 * séparément avait laissé passer un paramètre déstructuré/par défaut/de
 * catch, ou une variable locale homonyme d'une fonction du fichier, relevé
 * par la coordination le 2026-09-28. `ancetres` vient de `walk.ancestor` sur
 * le site d'appel (le nœud lui-même en dernier élément).
 *
 * Un bloc est scanné EN ENTIER avant de conclure, jamais sur la première
 * correspondance dans l'ordre du texte. Une `var` n'appartient pas à son
 * bloc mais à la fonction (ou au programme) qui la contient : elle est
 * cherchée n'importe où dans cette fonction, hors fonctions imbriquées (voir
 * `declarateursVar`) — sans quoi `function f(){ if (x) { var code =
 * location.hash } eval(code) }` résolvait vers un `const code` extérieur.
 * Une fonction et une `var` du même nom partagent la même liaison : la `var`
 * écrite après la fonction est une écriture, que `estReaffecte` voit
 * (relevé par la coordination le 2026-09-28 : `function cb(){} var cb =
 * window.name;` résolvait vers la fonction). Une fonction déclarée dans un
 * bloc imbriqué d'une fonction est aussi une `var` de cette fonction (voir
 * `fonctionDeBlocHissee`). Un `with` rend tout nom potentiellement une
 * propriété de son objet : rien n'y est résolu.
 *
 * Retourne `null` si aucune portée visible ne lie ce nom (probablement une
 * globale, ou une déclaration d'une autre unité) ; sinon l'une des formes :
 *   - `{type:'parametre', fonction, index, parent}` : paramètre positionnel
 *     simple d'une fonction — seul cas où la valeur peut être prouvée (un
 *     exécuteur de Promise, voir `estExecuteurPromise`) ;
 *   - `{type:'fonction-nommee', fonction, portee}` : `function nom() {}`
 *     dans `portee`, le bloc ou le programme qui la déclare ;
 *   - `{type:'variable', kind, declarateur, portee}` : `const`/`let nom = …`
 *     du bloc `portee` ;
 *   - `{type:'variable', kind:'var', declarateurs, annexeB, portee}` : `var
 *     nom` de la fonction, du bloc static ou du programme `portee`, avec tous
 *     ses déclarateurs, et `annexeB` si une fonction d'un bloc imbriqué la
 *     déclare aussi ;
 *   - `{type:'nom-de-fonction', fonction}` : le nom propre d'une expression
 *     de fonction (`setTimeout(function boucle() { setTimeout(boucle) })`),
 *     une liaison que le langage rend non modifiable ;
 *   - `{type:'autre'}` : une liaison existe à ce niveau (paramètre
 *     déstructuré/par défaut, catch, boucle, variable déstructurée, classe,
 *     import, `with`) mais n'est jamais résolvable — la recherche s'arrête
 *     ici.
 */
function trouverLiaisonVisible(nom, ancetres) {
  for (let i = ancetres.length - 2; i >= 0; i--) {
    const n = ancetres[i];
    if (n.type === 'WithStatement') return { type: 'autre' };
    if (estFonction(n)) {
      for (let idx = 0; idx < n.params.length; idx++) {
        const p = n.params[idx];
        if (p.type === 'Identifier' && p.name === nom) return { type: 'parametre', fonction: n, index: idx, parent: ancetres[i - 1] ?? null };
        if (nomsLies(p).includes(nom)) return { type: 'autre' };
      }
      if (n.body.type === 'BlockStatement') {
        const declarateurs = declarateursVar(n.body, nom);
        const annexeB = fonctionDeBlocHissee(n.body, nom);
        if (declarateurs.length || annexeB) return { type: 'variable', kind: 'var', declarateurs, annexeB, portee: n };
      }
      if (n.type === 'FunctionExpression' && n.id?.name === nom) return { type: 'nom-de-fonction', fonction: n };
    }
    if ((n.type === 'ClassExpression' || n.type === 'ClassDeclaration') && n.id?.name === nom) return { type: 'autre' };
    if (n.type === 'CatchClause' && n.param && nomsLies(n.param).includes(nom)) return { type: 'autre' };
    // La déclaration d'un `for` classique est dans `init`, celle d'un
    // `for…of`/`for…in` dans `left` : ne lire que `left` laissait `for (let
    // code = r.Formule; ;) eval(code)` résoudre vers un `const code`
    // extérieur (relevé par la coordination le 2026-09-28).
    const teteDeBoucle = n.type === 'ForStatement' ? n.init : (n.type === 'ForOfStatement' || n.type === 'ForInStatement') ? n.left : null;
    if (teteDeBoucle?.type === 'VariableDeclaration') {
      for (const d of teteDeBoucle.declarations) if (nomsLies(d.id).includes(nom)) return { type: 'autre' }; // change à chaque itération : jamais un littéral fiable
    }
    const instructions = instructionsDePortee(n);
    if (instructions) {
      const liaison = liaisonDeBloc(nom, instructions, n);
      if (liaison) return liaison;
      if (n.type === 'Program' || n.type === 'StaticBlock') {
        const declarateurs = declarateursVar(n, nom);
        if (declarateurs.length) return { type: 'variable', kind: 'var', declarateurs, annexeB: false, portee: n };
      }
    }
  }
  return null;
}

/**
 * Vrai si le corps de fonction `corps` déclare `function nom() {}` dans un
 * bloc imbriqué (hors fonctions imbriquées). Hors mode strict, l'annexe B du
 * standard en fait aussi une `var` de la fonction, créée à son entrée même si
 * le bloc ne s'exécute jamais : le reste du corps lit et écrit alors cette
 * `var`, pas une liaison extérieure homonyme. Sans ce cas, `if (0) { function
 * cb() {} } cb = "…"; setTimeout(cb)` résolvait vers un `const cb = () => {}`
 * extérieur. Le mode strict n'est pas distingué : y voir une liaison de plus
 * ne fait que renoncer à une résolution.
 */
function fonctionDeBlocHissee(corps, nom) {
  let trouve = false;
  const neDescendPas = () => {};
  const visiteurs = {
    FunctionDeclaration(n) { if (n.id?.name === nom) trouve = true; },
    FunctionExpression: neDescendPas,
    ArrowFunctionExpression: neDescendPas,
  };
  for (const instruction of corps.body) {
    if (instruction.type !== 'FunctionDeclaration') acornWalk.recursive(instruction, null, visiteurs);
  }
  return trouve;
}

const estFonction = (n) => n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration';

/** Instructions d'un nœud qui ouvre une portée de bloc (un `switch` en ouvre une seule pour tous ses `case`), `null` sinon. */
function instructionsDePortee(n) {
  if (n.type === 'Program' || n.type === 'BlockStatement' || n.type === 'StaticBlock') return n.body;
  if (n.type === 'SwitchStatement') return n.cases.flatMap((c) => c.consequent);
  return null;
}

/** Liaison de portée de bloc (`let`, `const`, `class`, `function`, `import`) de `nom` parmi `instructions`, `null` si aucune. */
function liaisonDeBloc(nom, instructions, portee) {
  let fonction = null;
  let lexicale = null;
  let autre = false;
  for (const brut of instructions) {
    if (brut.type === 'ImportDeclaration' && brut.specifiers.some((s) => s.local.name === nom)) autre = true;
    const stmt = declarationEffective(brut);
    if (stmt.type === 'FunctionDeclaration' && stmt.id?.name === nom) fonction = stmt;
    else if (stmt.type === 'ClassDeclaration' && stmt.id?.name === nom) autre = true;
    else if (stmt.type === 'VariableDeclaration' && stmt.kind !== 'var') {
      for (const d of stmt.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === nom) lexicale = { kind: stmt.kind, declarateur: d };
        else if (nomsLies(d.id).includes(nom)) autre = true;
      }
    }
  }
  if (autre || (fonction && lexicale)) return { type: 'autre' };
  if (fonction) return { type: 'fonction-nommee', fonction, portee };
  if (lexicale) return { type: 'variable', ...lexicale, portee };
  return null;
}

/**
 * Déclarateurs `var nom` n'importe où sous `racine`, hors fonctions et blocs
 * `static` imbriqués (qui ont leur propre portée de `var`) : une `var`
 * appartient à la fonction ou au programme qui la contient, quel que soit
 * le bloc où elle est écrite.
 */
function declarateursVar(racine, nom) {
  const trouves = [];
  const neDescendPas = () => {};
  const visiteurs = {
    FunctionDeclaration: neDescendPas,
    FunctionExpression: neDescendPas,
    ArrowFunctionExpression: neDescendPas,
    StaticBlock: neDescendPas,
    VariableDeclaration(n, st, c) {
      for (const d of n.declarations) {
        if (n.kind === 'var' && nomsLies(d.id).includes(nom)) trouves.push(d);
        if (d.init) c(d.init, st);
      }
    },
  };
  for (const depart of racine.type === 'StaticBlock' ? racine.body : [racine]) acornWalk.recursive(depart, null, visiteurs);
  return trouves;
}

/**
 * Vrai si `fonction` est l'exécuteur passé DIRECTEMENT à `new Promise(...)`
 * et `index` désigne son premier (`resolve`) ou second (`reject`)
 * paramètre : le langage GARANTIT que ce sont des fonctions au moment de
 * l'appel, quel que soit leur nom — le seul cas où l'analyse peut être
 * catégorique sans lire une déclaration plus haut dans la portée.
 * `setTimeout(resolve, délai)` dans un exécuteur de Promise est l'idiome
 * d'attente le plus courant en JS : le signaler comme non résolu noierait
 * la quasi-totalité du code honnête sous du bruit (mesuré par la
 * coordination le 2026-09-28 : widget-exemple axe C 95→83, global 92→89
 * pour ce seul motif, sans lui la moindre trace de contenu caché). Ne
 * couvre PAS la réaffectation de ce paramètre (`resolve = r.Formule`) :
 * l'appelant doit toujours vérifier `estReaffecte` en plus (relevé par la
 * coordination le 2026-09-28 : une réaffectation avant l'appel rendait
 * cette exemption exploitable).
 */
function estExecuteurPromise(fonction, parent, index) {
  return index <= 1 && parent?.type === 'NewExpression' && nomFinal(parent.callee) === 'Promise' && parent.arguments[0] === fonction;
}

/**
 * Motifs d'appel dont le paramètre reçoit une DONNÉE parvenue au widget —
 * un enregistrement Grist, une réponse réseau, un message reçu — jamais du
 * code écrit par son auteur. Reconnus par la seule forme du site d'appel
 * (même principe qu'`estExecuteurPromise`), sans suivi de valeur au-delà
 * d'un paramètre. Décision prise avec la coordination le 2026-09-28, après
 * mesure sur 31 widgets honnêtes : `setTimeout(r.Formule, 0)` en clair
 * notait CONFORME 87 avec un simple « à vérifier », quand `eval(r.Formule)`
 * est NON CONFORME 72 pour la même donnée — un widget malveillant gagnait à
 * préférer la première forme. Les deux doivent désormais recevoir le même
 * traitement (calculé à l'exécution, critique et bloquant).
 */
function estParametreDonneeGrist(fonction, parent, index) {
  return index === 0 && parent?.type === 'CallExpression' && /(^|\.)grist\.onRecords?$/.test(nomPointe(parent.callee) || '') && parent.arguments[0] === fonction;
}

/** Le paramètre d'un `.then(...)` enchaîné directement sur un appel réseau (`fetch`, `fetchTable`, `fetchSelectedTable`) reçoit la réponse — une donnée externe, jamais du code du widget. */
function estParametreReponseReseau(fonction, parent, index) {
  if (index !== 0 || parent?.type !== 'CallExpression' || nomFinal(parent.callee) !== 'then') return false;
  const objet = parent.callee.type === 'MemberExpression' ? parent.callee.object : null;
  return objet?.type === 'CallExpression' && /^(fetchTable|fetchSelectedTable|fetch)$/.test(nomFinal(objet.callee)) && parent.arguments[0] === fonction;
}

/** Le premier paramètre du gestionnaire d'un `addEventListener('message', …)` reçoit l'événement d'un message reçu — son contenu (`.data`) n'est jamais garanti par le widget lui-même. */
function estParametreMessageRecu(fonction, parent, index) {
  return index === 0 && parent?.type === 'CallExpression' && nomFinal(parent.callee) === 'addEventListener' &&
    chaineLitterale(parent.arguments[0]) === 'message' && parent.arguments[1] === fonction;
}

function estParametreDonneeWidget(fonction, parent, index) {
  return estParametreDonneeGrist(fonction, parent, index) || estParametreReponseReseau(fonction, parent, index) || estParametreMessageRecu(fonction, parent, index);
}

/**
 * Ce qu'est la valeur d'un accès à `location` (`location`, `window.location`,
 * `self.location`, quel que soit l'alias global de tête), lue sur le nom de
 * la propriété : `'chaine'` pour les neuf propriétés de texte (`href`,
 * `origin`, `protocol`, `host`, `hostname`, `port`, `pathname`, `search`,
 * `hash`), fournies par qui ouvre la page, jamais par le widget ; `'nombre'`
 * pour leur `length` ; `'fonction'` pour `assign`, `replace`, `reload` et
 * `toString` ; `null` pour tout autre accès, dont l'analyse ne sait rien.
 * Seule une chaîne se compile en code : un rappel de fonction ou un nombre
 * passé à un minuteur n'exécute jamais rien de ce qu'un lien fixe.
 */
function typeAccesLocation(noeud) {
  if (noeud?.type !== 'MemberExpression') return null;
  const nom = nomPointe(noeud) || '';
  if (/(^|\.)location\.(?:href|origin|protocol|host|hostname|port|pathname|search|hash)$/.test(nom)) return 'chaine';
  if (/(^|\.)location\.(?:href|origin|protocol|host|hostname|port|pathname|search|hash)\.length$/.test(nom)) return 'nombre';
  if (/(^|\.)location\.(?:assign|replace|reload|toString)$/.test(nom)) return 'fonction';
  return null;
}

/** `location.hash`, `window.location.search`… : une chaîne que n'importe quel lien peut fixer. */
function estAccesLocation(noeud) {
  return typeAccesLocation(noeud) === 'chaine';
}

/** `localStorage.getItem(...)`/`sessionStorage.getItem(...)` : une donnée déposée par n'importe quel script ayant tourné sur cette origine, jamais garantie par le widget. */
function estLectureStockageLocal(noeud) {
  return noeud?.type === 'CallExpression' && /(^|\.)(localStorage|sessionStorage)\.getItem$/.test(nomPointe(noeud.callee) || '');
}

/**
 * Vrai si `noeud` — l'argument d'un minuteur, ou la base d'un accès de
 * membre sur cet argument (`r.Formule`) — provient d'une donnée reçue par
 * le widget : un paramètre reconnu par `estParametreDonneeWidget`
 * (directement, ou via un seul accès de membre dessus), un accès à
 * `location`, ou une lecture de `localStorage`/`sessionStorage`. Ne suit
 * qu'un seul niveau depuis le site d'appel : la base d'un accès de membre
 * doit être l'identifiant lui-même, pas une expression plus profonde — un
 * choix délibérément conservateur, cohérent avec le reste de cette
 * résolution (voir `resoudreArgument`) : plus sûr de manquer une donnée
 * réattribuée à travers plusieurs variables que de suivre un flux que
 * l'analyse ne peut pas garantir.
 */
function estSourceDonneeWidget(noeud, ancetres) {
  if (estAccesLocation(noeud) || estLectureStockageLocal(noeud)) return true;
  const base = noeud?.type === 'MemberExpression' ? noeud.object : noeud;
  if (base?.type !== 'Identifier') return false;
  const liaison = trouverLiaisonVisible(base.name, ancetres);
  return liaison?.type === 'parametre' && estParametreDonneeWidget(liaison.fonction, liaison.parent, liaison.index);
}

/**
 * Vrai si la fonction `fonction` lie elle-même `nom` pour tout son corps :
 * par un paramètre, par son propre nom (expression de fonction nommée), par
 * une déclaration `function nom` au premier niveau de son corps, ou par une
 * `var nom` n'importe où dans son corps hors fonctions imbriquées (une `var`
 * remonte à la fonction qui la contient). Une déclaration `function nom` dans
 * un bloc imbriqué n'en fait pas partie : elle ne lie `nom` que dans ce bloc
 * en mode strict, et `portionsOmbragees` la traite comme tel.
 */
function lieDansSaPorteeDeFonction(fonction, nom) {
  if (fonction.params.some((p) => nomsLies(p).includes(nom))) return true;
  if (fonction.type === 'FunctionExpression' && fonction.id?.name === nom) return true;
  if (fonction.body.type !== 'BlockStatement') return false;
  if (fonction.body.body.some((s) => { const d = declarationEffective(s); return d.type === 'FunctionDeclaration' && d.id?.name === nom; })) return true;
  return declarateursVar(fonction.body, nom).length > 0;
}

/**
 * Plages (`[début, fin[` en positions du source) des sous-arbres de `portee`
 * où `nom` désigne une AUTRE liaison que celle qu'on vérifie : une fonction
 * imbriquée qui lie ce nom pour tout son corps (voir
 * `lieDansSaPorteeDeFonction`), un `catch` qui le lie, une boucle
 * `for (let|const nom …)`, un bloc, un `switch` ou un bloc `static` imbriqué
 * qui déclare son propre `nom`. Une écriture dans une telle plage vise
 * l'homonyme, jamais la liaison vérifiée. Sans cette exclusion, les `r++` de
 * quatre boucles `for (let r = 0; …)` sans rapport désarmaient l'exemption de
 * `await new Promise(r => setTimeout(r, …))` (whackacell, relevé par la
 * coordination le 2026-09-28). `portee` elle-même n'est jamais exclue : c'est
 * elle qui porte la liaison vérifiée. Une `var` n'ouvre pas de portée de
 * bloc : elle n'est une plage d'exclusion que dans sa propre fonction.
 */
function portionsOmbragees(nom, portee, walkAcorn) {
  const plages = [];
  const lie = (declaration) => declaration?.type === 'VariableDeclaration' && declaration.kind !== 'var' && declaration.declarations.some((d) => nomsLies(d.id).includes(nom));
  const fonction = (n) => { if (n !== portee && lieDansSaPorteeDeFonction(n, nom)) plages.push([n.start, n.end]); };
  const bloc = (n) => {
    if (n === portee) return;
    if (liaisonDeBloc(nom, instructionsDePortee(n), n) || (n.type === 'StaticBlock' && declarateursVar(n, nom).length)) plages.push([n.start, n.end]);
  };
  walkAcorn.simple(portee, {
    FunctionDeclaration: fonction,
    FunctionExpression: fonction,
    ArrowFunctionExpression: fonction,
    CatchClause(n) { if (n.param && nomsLies(n.param).includes(nom)) plages.push([n.start, n.end]); },
    ForStatement(n) { if (lie(n.init)) plages.push([n.start, n.end]); },
    ForOfStatement(n) { if (lie(n.left)) plages.push([n.start, n.end]); },
    ForInStatement(n) { if (lie(n.left)) plages.push([n.start, n.end]); },
    BlockStatement: bloc,
    SwitchStatement: bloc,
    StaticBlock: bloc,
  });
  return plages;
}

/**
 * Vrai si la liaison `nom` de `portee` peut être écrite depuis `portee`.
 * Dans une portée de fonction ou de bloc, le langage ne permet que ces
 * écritures, toutes visibles dans le texte : une affectation directe,
 * composée ou déstructurée (`nom = …`, `nom += …`, `({nom} = …)`,
 * `[nom] = […]`), une mise à jour (`nom++`), la variable d'un `for…of`/
 * `for…in` sans déclaration ou en `var` (réaffectée à chaque itération), une
 * redéclaration `var nom = …` (même liaison qu'un paramètre ou une `var`
 * de la même fonction), et un `eval()` direct, qui exécute du code dans
 * cette même portée. La coordination a mesuré plusieurs détournements de la
 * seule forme `nom = …` (2026-09-28) : déstructuration, boucle sans
 * déclaration, écriture par un eval imbriqué. Bornée à la portée qui porte
 * la liaison, homonymes imbriqués exclus (voir `portionsOmbragees`) : une
 * recherche par nom dans tout le fichier confondait des liaisons sans
 * rapport entre elles (les `r++` de boucles sans rapport sur whackacell).
 * `sauf` est le déclarateur `var nom = …` qui initialise la liaison, qui
 * n'est pas une écriture de plus (voir `valeurGarantie`). Rend `'ecriture'`
 * si le texte écrit la liaison, sinon `'eval'` si seul un eval() direct peut
 * l'écrire, sinon `null`.
 */
function estReaffecte(nom, portee, walkAcorn, sauf = null) {
  const plages = portionsOmbragees(nom, portee, walkAcorn);
  const vise = (n) => !plages.some(([debut, fin]) => n.start >= debut && n.start < fin);
  const varDeclare = (d) => d?.type === 'VariableDeclaration' && d.kind === 'var' && d.declarations.some((x) => nomsLies(x.id).includes(nom));
  let ecriture = false;
  let evalDirect = false;
  walkAcorn.simple(portee, {
    AssignmentExpression(n) {
      if (!vise(n)) return;
      if (n.left.type === 'Identifier' && n.left.name === nom) ecriture = true;
      else if ((n.left.type === 'ObjectPattern' || n.left.type === 'ArrayPattern') && nomsLies(n.left).includes(nom)) ecriture = true;
    },
    UpdateExpression(n) { if (vise(n) && n.argument.type === 'Identifier' && n.argument.name === nom) ecriture = true; },
    ForOfStatement(n) { if (vise(n) && ((n.left.type === 'Identifier' && n.left.name === nom) || varDeclare(n.left) || (n.left.type !== 'VariableDeclaration' && nomsLies(n.left).includes(nom)))) ecriture = true; },
    ForInStatement(n) { if (vise(n) && ((n.left.type === 'Identifier' && n.left.name === nom) || varDeclare(n.left) || (n.left.type !== 'VariableDeclaration' && nomsLies(n.left).includes(nom)))) ecriture = true; },
    VariableDeclaration(n) { if (vise(n) && n.kind === 'var' && n.declarations.some((d) => d !== sauf && d.init && nomsLies(d.id).includes(nom))) ecriture = true; },
    CallExpression(n) { if (vise(n) && n.callee.type === 'Identifier' && n.callee.name === 'eval') evalDirect = true; },
  });
  if (ecriture) return 'ecriture';
  return evalDirect ? 'eval' : null;
}

/** Formes qui produisent toujours une chaîne, quel que soit leur contenu : littéral, gabarit, concaténation avec `+`, `atob()`, `String.fromCharCode()`. */
function produitToujoursUneChaine(noeud) {
  return (noeud?.type === 'Literal' && typeof noeud.value === 'string') || noeud?.type === 'TemplateLiteral' ||
    (noeud?.type === 'BinaryExpression' && noeud.operator === '+') ||
    (noeud?.type === 'CallExpression' && (nomFinal(noeud.callee) === 'atob' || /(^|\.)String\.fromCharCode$/.test(nomPointe(noeud.callee) || '')));
}

/**
 * Écritures de la liaison `nom` de `portee` (initialisation ou affectation
 * visible dans `portee`) qui y placent une chaîne (voir
 * `produitToujoursUneChaine`) ou une donnée reçue par le widget (voir
 * `estSourceDonneeWidget`) ; `null` s'il n'y en a aucune. Un minuteur sur une
 * telle liaison exécute une chaîne dont l'analyse ne peut pas garantir le
 * contenu : sans ce contrôle, `let code = "fetch(…)"; setTimeout(code, 0)`
 * ne donnait qu'une information sans pénalité, quand `setTimeout("fetch(…)",
 * 0)` est audité (une liaison `let` n'est plus jamais résolue vers sa
 * valeur). `litteraux` rend les chaînes littérales écrites, pour que leur
 * contenu soit audité comme du code à leur propre emplacement. `ancetres`
 * sont ceux du site d'appel, dont `portee` fait partie : ils complètent ceux
 * de chaque écriture pour résoudre une donnée comme `r.Formule` depuis
 * l'endroit où elle est écrite.
 */
function ecrituresSuspectes(nom, portee, ancetres, walkAcorn) {
  const plages = portionsOmbragees(nom, portee, walkAcorn);
  const vise = (n) => !plages.some(([debut, fin]) => n.start >= debut && n.start < fin);
  const exterieurs = ancetres.slice(0, Math.max(0, ancetres.indexOf(portee)));
  let suspecte = false;
  const litteraux = [];
  const examiner = (valeur, ancetresEcriture) => {
    if (!valeur) return;
    if (produitToujoursUneChaine(valeur)) {
      suspecte = true;
      const texte = plierLitteraux(valeur) ?? decoderAtobLitteral(valeur) ?? decoderFromCharCodeLitteral(valeur);
      if (texte !== null) litteraux.push({ noeud: valeur, valeur: texte });
    } else if (estSourceDonneeWidget(valeur, [...exterieurs, ...ancetresEcriture, valeur])) {
      suspecte = true;
    }
  };
  walkAcorn.ancestor(portee, {
    VariableDeclarator(n, _etat, anc) { if (vise(n) && n.id.type === 'Identifier' && n.id.name === nom) examiner(n.init, anc); },
    AssignmentExpression(n, _etat, anc) { if (vise(n) && n.left.type === 'Identifier' && n.left.name === nom) examiner(n.right, anc); },
  });
  return suspecte ? { litteraux } : null;
}

/**
 * Vrai si `fonction` — un exécuteur `function(resolve, reject) {…}` (jamais
 * une fléchée, qui n'a pas son propre `arguments`) — référence `arguments`
 * n'importe où dans son corps. En mode non strict, `arguments[0] = x`
 * réaffecte silencieusement le paramètre nommé correspondant, contournant
 * toute vérification qui ne regarde que le nom `resolve`/`reject` lui-même
 * (relevé par la coordination le 2026-09-28). Conservateur à dessein : toute
 * référence, même une simple lecture, désarme l'exemption plutôt que
 * d'essayer de distinguer une lecture innocente d'une écriture, ou un
 * `arguments` imbriqué dans une fonction interne qui a le sien.
 */
function executeurUtiliseArguments(fonction, walkAcorn) {
  if (fonction.type !== 'FunctionExpression') return false;
  let trouve = false;
  walkAcorn.simple(fonction, { Identifier(n) { if (n.name === 'arguments') trouve = true; } });
  return trouve;
}

/**
 * Décode le contenu littéral d'un initialisateur, quelle que soit sa forme
 * (chaîne directe, concaténation de constantes, `atob(...)`,
 * `String.fromCharCode(...)`, ou un littéral non-chaîne comme `null`/un
 * nombre — voir `coercerLitteralNonChaine`). Partagé entre la résolution
 * `const` d'eval()/Function() et celle, plus large, d'un minuteur.
 */
function decoderInitialisateur(init) {
  return plierLitteraux(init) ?? decoderAtobLitteral(init) ?? decoderFromCharCodeLitteral(init) ?? coercerLitteralNonChaine(init);
}

/**
 * Vrai si seul le texte de `portee` peut écrire une liaison qu'elle déclare :
 * toute portée sauf le premier niveau d'un script classique. Là, une
 * fonction ou une `var` est une propriété de l'objet global, que tout autre
 * script de la page remplace sans écrire son nom (`window[k] = v`, un alias
 * de `window`, `Object.assign(window, …)`), et un `let` s'écrit depuis tout
 * autre script : la vérification « aucun autre fichier ne l'écrit » ne peut
 * pas le garantir. Seul un `const` y reste garanti. Le premier niveau d'un
 * module est local à ce module (vérifié dans Chromium par la coordination le
 * 2026-09-28) : un importeur ne peut pas écrire ce qu'il importe.
 */
const estPorteeLocale = (portee, estModule) => portee.type !== 'Program' || estModule;

/**
 * Valeur d'une liaison que le langage garantit au moment de l'appel
 * (décision de la coordination le 2026-09-28) :
 *   - un `const` initialisé par une expression de fonction ou un littéral
 *     (pliage compris, voir `decoderInitialisateur`) : aucune écriture, d'où
 *     qu'elle vienne, ne change sa valeur ;
 *   - un `let` ou une `var` d'une portée locale (voir `estPorteeLocale`)
 *     initialisé de même, par un seul déclarateur, et jamais écrit dans sa
 *     portée (mêmes écritures qu'`estReaffecte`, eval direct compris) : une
 *     telle liaison ne s'écrit que depuis le texte de sa portée. Avant son
 *     initialisation, elle vaut `undefined` (`var`) ou ne se lit pas
 *     (`let`) : ni l'un ni l'autre n'exécute de code. Le code transpilé en
 *     ES5, où tout `const` devient `var`, retrouve ainsi le traitement du
 *     `const` qu'il était.
 * Sinon, `motif` dit pourquoi : `partagee` (premier niveau d'un script
 * classique), `annexeB` (voir `fonctionDeBlocHissee`), `plusieurs`
 * déclarateurs initialisés, `illisible` (valeur initiale qui n'est ni une
 * fonction ni un littéral), `ecriture` ou `eval` (voir `estReaffecte`).
 * @returns {{fonction:true} | {litteral:string, init:object} | {motif:string}}
 */
function valeurGarantie(nom, liaison, { walkAcorn, estModule }) {
  let init;
  let sauf = null;
  if (liaison.kind === 'const') init = liaison.declarateur.init;
  else if (!estPorteeLocale(liaison.portee, estModule)) return { motif: 'partagee' };
  else if (liaison.kind === 'let') init = liaison.declarateur.init;
  else {
    if (liaison.annexeB) return { motif: 'annexeB' };
    const initialises = liaison.declarateurs.filter((d) => d.init);
    if (initialises.length > 1) return { motif: 'plusieurs' };
    if (!initialises.length || initialises[0].id.type !== 'Identifier') return { motif: 'illisible' };
    [sauf] = initialises;
    init = sauf.init;
  }
  const fonction = init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression';
  const litteral = fonction ? null : decoderInitialisateur(init);
  if (!fonction && litteral === null) return { motif: 'illisible' };
  const ecriture = liaison.kind === 'const' ? null : estReaffecte(nom, liaison.portee, walkAcorn, sauf);
  if (ecriture) return { motif: ecriture };
  return fonction ? { fonction: true } : { litteral, init };
}

const RAISON_PROPRIETE_GLOBALE = "est déclaré au premier niveau d'un script classique, comme une propriété de l'objet global que tout autre script de la page peut remplacer sans écrire son nom (`window[…] = …`, `Object.assign(window, …)`)";

/** Pourquoi une variable n'a pas de valeur garantie, selon le motif de `valeurGarantie`. */
function raisonVariable(kind, motif) {
  switch (motif) {
    case 'partagee': return kind === 'let' ? "est déclaré en `let` au premier niveau d'un script classique, où tout autre script de la page peut le réaffecter" : RAISON_PROPRIETE_GLOBALE;
    case 'annexeB': return 'est aussi le nom d\'une fonction déclarée dans un bloc imbriqué, qui en fait une `var` de la fonction englobante hors mode strict';
    case 'plusieurs': return 'est une variable `var` qui reçoit une valeur à plusieurs déclarations';
    case 'ecriture': return `est une variable \`${kind}\` que sa portée réécrit`;
    case 'eval': return `est une variable \`${kind}\` qu'un eval() direct de sa portée peut réécrire, puisqu'il y exécute son code`;
    default: return kind === 'const' ? 'est une constante dont la valeur ne se lit pas dans le code' : `est une variable \`${kind}\` dont la valeur initiale ne se lit pas dans le code`;
  }
}

/**
 * Résout un identifiant passé à un minuteur (`setTimeout`/`setInterval`), ou
 * à eval()/Function() quand il n'a pas de littéral garanti, vers l'une de
 * ces issues : une fonction garantie (jamais signalée), un littéral garanti
 * (audité comme le reste du code), une liaison qui reçoit une chaîne ou une
 * donnée ailleurs dans le code (`chaine-non-garantie`, traitée comme un
 * eval() dont l'argument ne peut pas être garanti), ou une valeur inconnue.
 * `raison` dit pourquoi la valeur n'est pas garantie, `motif` le résume
 * (voir `valeurGarantie`) pour choisir la remédiation.
 * Décision de la coordination le 2026-09-28, après plusieurs détournements
 * de l'ancienne approche fondée sur « pas de réaffectation détectée » : n'est
 * résolu que ce dont le LANGAGE garantit la valeur au moment de l'appel.
 *   - un `const`, ou un `let`/une `var` locale jamais écrite (voir
 *     `valeurGarantie`) ;
 *   - une déclaration de fonction seule de son nom dans une portée locale
 *     (voir `trouverLiaisonVisible`), sans aucune écriture possible dans
 *     cette portée (`estReaffecte`, eval direct compris) ;
 *   - le `resolve`/`reject` d'un exécuteur de Promise, aux mêmes conditions,
 *     plus l'absence d'`arguments` dans un exécuteur `function` (voir
 *     `executeurUtiliseArguments`).
 */
function resoudreArgument(noeud, { walkAcorn, ancetres, estModule }) {
  if (!noeud) return { type: 'inconnue' };
  if (noeud.type === 'ArrowFunctionExpression' || noeud.type === 'FunctionExpression') return { type: 'fonction' };
  if (noeud.type !== 'Identifier') return { type: 'autre' };

  // Une liaison non garantie qui reçoit une chaîne ou une donnée exécute un
  // contenu inconnu : même traitement qu'un eval() dont l'argument ne peut
  // pas être garanti (voir `ecrituresSuspectes`).
  const nonGarantie = (portee, raison, motif = null) => {
    const ecritures = ecrituresSuspectes(noeud.name, portee, ancetres, walkAcorn);
    return { type: ecritures ? 'chaine-non-garantie' : 'inconnue', litteraux: ecritures?.litteraux ?? [], raison, motif };
  };

  const liaison = trouverLiaisonVisible(noeud.name, ancetres);
  if (!liaison) return nonGarantie(ancetres[0], "n'est déclaré dans aucune portée visible de ce fichier");
  if (liaison.type === 'autre') return { type: 'inconnue', raison: 'est lié par une forme que l\'analyse ne suit pas (paramètre déstructuré, variable de boucle, `catch`, classe, import ou `with`)' };

  if (liaison.type === 'parametre') {
    const executeur = estExecuteurPromise(liaison.fonction, liaison.parent, liaison.index);
    // Toute la fonction, paramètres compris : la valeur par défaut d'un
    // troisième paramètre (`function (resolve, reject, x = (resolve = …))`)
    // s'évalue avant le corps et peut réécrire `resolve`.
    if (executeur && !estReaffecte(noeud.name, liaison.fonction, walkAcorn) && !executeurUtiliseArguments(liaison.fonction, walkAcorn)) return { type: 'fonction' };
    return nonGarantie(liaison.fonction, executeur
      ? "est le paramètre d'un exécuteur de Promise, mais peut être réécrit avant l'appel"
      : "est un paramètre, dont la valeur dépend de l'appelant");
  }

  // Seul un eval() direct du corps peut encore y déclarer une `var`
  // homonyme qui masque ce nom : `estReaffecte` le voit.
  if (liaison.type === 'nom-de-fonction') {
    if (!estReaffecte(noeud.name, liaison.fonction.body, walkAcorn)) return { type: 'fonction' };
    return nonGarantie(liaison.fonction.body, 'est le nom d\'une expression de fonction, mais un eval() de son corps peut le masquer');
  }

  if (liaison.type === 'fonction-nommee') {
    if (!estPorteeLocale(liaison.portee, estModule)) return nonGarantie(liaison.portee, RAISON_PROPRIETE_GLOBALE, 'partagee');
    const ecriture = estReaffecte(noeud.name, liaison.portee, walkAcorn);
    if (!ecriture) return { type: 'fonction' };
    return nonGarantie(liaison.portee, ecriture === 'eval'
      ? "est une fonction déclarée qu'un eval() direct de sa portée peut réécrire, puisqu'il y exécute son code"
      : 'est une fonction déclarée, mais réécrite dans sa portée', ecriture);
  }

  const valeur = valeurGarantie(noeud.name, liaison, { walkAcorn, estModule });
  if (valeur.fonction) return { type: 'fonction' };
  if (!valeur.motif) return { type: 'litteral', valeur: valeur.litteral, init: valeur.init };
  return nonGarantie(liaison.portee, raisonVariable(liaison.kind, valeur.motif), valeur.motif);
}

/**
 * `String.fromCharCode(...)` retourne toujours une chaîne : si tous ses
 * arguments sont des codes numériques littéraux, son résultat est aussi peu
 * une boîte noire qu'un littéral direct — comme `atob()`. La comparaison
 * tolère un alias global de tête (`window.String.fromCharCode`,
 * `self.String.fromCharCode`…), comme le fait déjà `nomFinal` ailleurs dans
 * ce fichier pour `eval`/`Function`/`document.write` : une correspondance
 * exacte manquait cette forme pourtant courante en code minifié/empaqueté
 * (relevé par la coordination le 2026-09-28).
 */
function decoderFromCharCodeLitteral(noeud) {
  if (noeud?.type !== 'CallExpression' || !/(^|\.)String\.fromCharCode$/.test(nomPointe(noeud.callee) || '') || !noeud.arguments.length) return null;
  const codes = [];
  for (const a of noeud.arguments) {
    if (a.type !== 'Literal' || typeof a.value !== 'number') return null;
    codes.push(a.value);
  }
  return String.fromCharCode(...codes);
}

/**
 * Cœur du modèle « littéral audité, pas puni » (revu avec la coordination le
 * 2026-09-28 : `Function("return this")`, l'idiome lodash bundlé par l'API
 * Grist officielle elle-même, ne justifiait aucune sanction — C-CSP-01
 * épargne déjà `'unsafe-eval'` pour cette API, et C-EXFIL-04 recommande
 * justement de l'embarquer). Si `texteBrut` se parse comme du JS valide, il
 * devient un fichier de PLUS dans la surface réellement auditée
 * (`ctx.fichiers`, pas une copie isolée) : chaque règle de l'axe C s'y
 * applique à sa propre sévérité (un eval() imbriqué y redevient critique),
 * ET les règles qui portent sur le WIDGET ENTIER (C-GRIST, qui agrège
 * `usagesGrist` sur tout `ctx.fichiers`, ou C-STOCK-01, dont la sévérité
 * dépend du README présent dans `ctx.fichiers`) le voient exactement comme
 * n'importe quel autre fichier — sans traitement spécial, donc sans
 * incitation inversée à cacher un appel dangereux dans une chaîne.
 *
 * Le fichier synthétique porte son PROPRE nom (« … (code littéral, ligne
 * N) ») et sa propre numérotation de ligne : un constat trouvé dedans
 * rapporte SA ligne dans le texte décodé, jamais une ligne recalculée par
 * rapport au fichier source — c'est le point précis que corrige cette
 * réécriture (l'ancien `analyserSiCodeLitteral` remappait
 * `ligne + c.ligne - 1`, faux dès que le littéral décodé ne correspond pas
 * ligne à ligne au texte source, par exemple un contenu base64 décodé).
 * Marqué `vendorise: true` : ni l'auteur du widget ni un tiers ne l'ont écrit
 * comme du code source à relire tel quel, donc hors du jugement de qualité
 * (axe A) et de lisibilité (axe B) — même raisonnement déjà appliqué au code
 * tiers embarqué. `litteralImbrique: true` l'exclut en plus des deux
 * endroits où « vendorise » aurait un sens différent du voulu : E-DEP-02 (ce
 * n'est pas une bibliothèque tierce à documenter) et F-ECO-01 (son poids est
 * déjà compté dans le fichier source qui le contient ; le compter une
 * deuxième fois gonflerait le poids réseau rapporté sans rapport avec la
 * réalité).
 *
 * Bornée en profondeur (`profondeur`) : un widget malveillant pourrait
 * sinon empiler des littéraux emboîtés pour épuiser l'analyse plutôt que
 * pour échapper à une détection précise.
 *
 * Retourne `{ constats, fichier? }` — `fichier` est le fichier synthétique
 * créé (utile à l'appelant pour poursuivre l'extraction en profondeur),
 * absent quand l'argument est calculé ou ne se parse pas.
 */
function traiterSiteConstruction(ctx, { fichierOrigine, ligneAppel, colonneAppel, extrait, texteBrut, profondeur, regle, titreConstruction, texteConstruction, remediationSupprimer, impactConstruction, referentielsSupp = [], motifNonGaranti = "L'analyse statique ne peut pas garantir la valeur de son argument au moment de l'appel : ce qui sera réellement exécuté n'est pas lu." }) {
  const constatCalculeOuIllisible = (motif) => constat({
    regle, axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
    titre: titreConstruction, fichier: fichierOrigine, ligne: ligneAppel, extrait,
    constat: `${texteConstruction} ${motif}`,
    impact: impactConstruction,
    remediation: remediationSupprimer,
    referentiels: ['CWE-95', REF_ANSSI, 'OWASP Top 10 A03:2021', ...referentielsSupp],
  });

  if (texteBrut === null) {
    return { constats: [constatCalculeOuIllisible(motifNonGaranti)] };
  }

  if (profondeur >= MAX_PROFONDEUR_CODE_IMBRIQUE) {
    return { constats: [constat({
      regle: 'C-XSS-03', axe: 'C', severite: 'majeur', bloquant: false, confiance: 'a_verifier',
      titre: 'Imbrication de code littéral trop profonde pour être auditée',
      fichier: fichierOrigine, ligne: ligneAppel,
      constat: `Ce code contient une chaîne exécutable elle-même imbriquée au-delà de ${MAX_PROFONDEUR_CODE_IMBRIQUE} niveaux.`,
      impact: "Aucune raison légitime à ce niveau d'imbrication ; peut viser à épuiser l'analyse automatique plutôt qu'à échapper à une détection précise.",
      remediation: 'Supprimer cette construction en cascade.',
      referentiels: ['CWE-95'],
    })] };
  }

  if (!parser(texteBrut)) {
    return { constats: [constatCalculeOuIllisible("Son contenu littéral ne se parse pas comme du JS valide : l'analyse ne peut pas l'auditer comme le reste du code.")] };
  }

  // La colonne du site d'appel désambiguïse deux constructions distinctes sur
  // la MÊME ligne (courant en code minifié/empaqueté) : sans elle, deux
  // fichiers synthétiques sans rapport entre eux portaient le même chemin —
  // relevé par la coordination le 2026-09-28.
  const chemin = `${fichierOrigine} (code littéral, ligne ${ligneAppel}${colonneAppel ? `, colonne ${colonneAppel}` : ''})`;
  const fichier = {
    chemin, contenu: texteBrut, lignes: texteBrut.split('\n'), ext: '.js',
    binaire: false, executee: true, vendorise: true, litteralImbrique: true,
    // Origine réelle (fichier + ligne du site d'appel qui a produit ce
    // fichier synthétique) : sert à deux choses hors de cette fonction — ne
    // pas compter deux fois, dans une règle qui scanne le TEXTE brut (comme
    // F-SOUV-01), une référence déjà visible en clair dans le fichier
    // d'origine (un littéral direct la reproduit textuellement) ; et donner
    // aux formats d'export (SARIF) une localisation qui correspond à un
    // fichier réel du dépôt, plutôt qu'un chemin synthétique introuvable.
    origineReelle: { chemin: fichierOrigine, ligne: ligneAppel },
    taille: Buffer.byteLength(texteBrut, 'utf8'),
  };
  ctx.fichiers.push(fichier);

  return {
    fichier,
    constats: [constat({
      regle, axe: 'C', severite: 'mineur', bloquant: false, confiance: 'certain',
      titre: `${titreConstruction} (contenu littéral, audité comme du code du dépôt)`,
      fichier: fichierOrigine, ligne: ligneAppel, extrait,
      constat: `${texteConstruction} Son contenu est un littéral qui a pu être analysé comme le reste du code : chaque règle de sécurité s'y applique déjà, à sa propre sévérité (voir \`${chemin}\`).`,
      impact: "Reste un obstacle inutile à une politique de sécurité de contenu stricte, et une source de confusion en relecture, mais le contenu lui-même est audité comme n'importe quel autre fichier du dépôt.",
      remediation: remediationSupprimer,
      referentiels: ['CWE-95', ...referentielsSupp],
    })],
  };
}

const IMPACT_EXECUTION_CHAINE = "Toute donnée qui atteint cet appel devient du code exécuté avec l'accès du widget au document. C'est rédhibitoire pour un hébergement sur instance officielle, et cela empêche toute politique de sécurité de contenu stricte.";

const litterauxMaterialises = new WeakSet();

/**
 * Matérialise les chaînes littérales écrites dans une liaison que l'analyse
 * ne peut pas garantir (voir `ecrituresSuspectes`), chacune à son propre
 * emplacement : le constat critique du site d'appel dit que la valeur
 * exécutée n'est pas garantie, jamais que ces contenus échappent à l'audit.
 * Leur rappel mineur est omis, le constat critique le couvre. Plusieurs
 * sites d'appel peuvent lire la même liaison : chaque littéral n'est
 * matérialisé qu'une fois (le chemin synthétique est celui du littéral), et
 * n'est marqué qu'une fois matérialisé, pour qu'un texte qui ne se parse
 * qu'en corps de fonction (`return …`, lu par Function) le soit encore
 * après un eval() qui l'a lu en vain.
 */
function materialiserLitterauxEcrits(ctx, { unite, ligneDe, litteraux, profondeur, envelopper = false }) {
  for (const { noeud, valeur } of litteraux) {
    if (litterauxMaterialises.has(noeud)) continue;
    const { fichier } = traiterSiteConstruction(ctx, {
      fichierOrigine: unite.chemin, ligneAppel: ligneDe(noeud), colonneAppel: colonneDans(unite, noeud), extrait: extraireSource(unite.source, noeud),
      texteBrut: envelopper ? `(function(){${valeur}})` : valeur, profondeur, regle: 'C-XSS-03', titreConstruction: '', texteConstruction: '', remediationSupprimer: '', impactConstruction: '',
    });
    if (fichier) litterauxMaterialises.add(noeud);
  }
}

/**
 * Où déclarer une liaison du premier niveau d'un script classique pour que
 * le langage garantisse sa valeur (voir `estPorteeLocale`), en minuscule
 * initiale : le texte appelant dit ce qu'on y gagne.
 */
function ouDeclarer(nomArg, { fonction = false } = {}) {
  return `déclarer \`${nomArg}\` en \`const\`${fonction ? ` (\`const ${nomArg} = () => …\`)` : ''}, ou dans une fonction englobante ou un module (un \`<script type="module">\` écrit dans la page, ou un fichier qui contient un \`import\` ou un \`export\` ; sans l'un ni l'autre, un fichier peut toujours être chargé comme script classique)`;
}

/**
 * Pour une chaîne exécutée depuis une liaison non garantie : où la déclarer
 * pour que son contenu soit garanti et audité en place, `null` si le motif
 * n'y change rien. Un eval() direct peut réécrire toute liaison de sa portée
 * sauf un `const` : c'est alors la seule déclaration qui garantisse.
 */
function declarationQuiGarantit(nomArg, motif, { evalDirect = false } = {}) {
  if (motif === 'eval' || (motif === 'partagee' && evalDirect)) return `déclarer \`${nomArg}\` en \`const\``;
  if (motif === 'partagee') return ouDeclarer(nomArg);
  return null;
}

/** Pourquoi la valeur d'un identifiant passé à eval()/Function() ou à un minuteur n'est pas garantie, à la suite du texte de la construction. */
const motifIdentifiantNonGaranti = (nomArg, raison) => `L'analyse statique ne peut pas garantir la valeur de son argument au moment de l'appel : \`${nomArg}\` ${raison}.`;

/**
 * eval()/Function() (directs ou indirects). `envelopper` corrige la
 * sémantique de `Function`/`new Function` : leur corps s'exécute comme
 * l'intérieur d'une fonction (où `return` est valide), contrairement à
 * `eval()` ou au script d'un worker, qui s'exécutent en portée de script.
 * Un identifiant n'est résolu que si le langage garantit sa valeur au site
 * d'appel (voir `valeurGarantie`) : `const code = "…"; eval(code)` est audité
 * comme le littéral écrit en place ; tout autre identifiant reste une valeur
 * que l'analyse ne peut pas garantir, et le constat dit pourquoi. Les chaînes
 * littérales écrites dans une telle liaison restent auditées (voir
 * `materialiserLitterauxEcrits`).
 */
function traiterAppelExecution(ctx, { unite, ligneDe, n, argument, walkAcorn, ancetres, estModule, profondeur, titreConstruction, texteConstruction, remediationSupprimer, envelopper = false }) {
  let brut = decoderInitialisateur(argument);
  let motifNonGaranti;
  let remediation = remediationSupprimer;
  if (brut === null && argument?.type === 'Identifier') {
    const resolution = resoudreArgument(argument, { walkAcorn, ancetres, estModule });
    if (resolution.type === 'litteral') brut = resolution.valeur;
    else {
      if (resolution.type === 'chaine-non-garantie') materialiserLitterauxEcrits(ctx, { unite, ligneDe, litteraux: resolution.litteraux, profondeur, envelopper });
      if (resolution.raison) motifNonGaranti = motifIdentifiantNonGaranti(argument.name, resolution.raison);
      const declaration = declarationQuiGarantit(argument.name, resolution.motif, { evalDirect: n.callee.type === 'Identifier' && n.callee.name === 'eval' });
      if (declaration) remediation = `${remediationSupprimer} Si ce code doit rester, ${declaration} : son contenu est alors garanti, et audité comme du code écrit en place.`;
    }
  }
  const texteAnalyse = brut !== null && envelopper ? `(function(){${brut}})` : brut;
  return traiterSiteConstruction(ctx, {
    fichierOrigine: unite.chemin, ligneAppel: ligneDe(n), colonneAppel: colonneDans(unite, n), extrait: extraireSource(unite.source, n),
    texteBrut: texteAnalyse, profondeur, regle: 'C-XSS-03',
    titreConstruction, texteConstruction, remediationSupprimer: remediation, motifNonGaranti,
    impactConstruction: IMPACT_EXECUTION_CHAINE,
  }).constats;
}

/**
 * Sévérité du palier « source non résolue » de `constatMinuteurNonResolu`,
 * gardée à cet unique endroit : décision de la coordination du 2026-09-28,
 * mesurée sur 31 widgets honnêtes (25 widgets officiels de Grist et leurs
 * sous-modules, plus les dépôts de référence) — un « à vérifier » en majeur
 * ajoutait du bruit sur du code entièrement honnête (paramètres de callback,
 * polyfills, minifiés), jusqu'à 35 constats supplémentaires sur les gros
 * bundles. Ramené en simple signal pour la relecture humaine, sans pénalité ;
 * si Antoine choisit de pénaliser ce palier, ce seul mot change.
 */
const SEVERITE_MINUTEUR_NON_RESOLU = 'info';

/**
 * Palier « à vérifier » d'un minuteur. Sa remédiation dépend de la raison :
 * une fonction déclarée au premier niveau d'un script classique EST déjà une
 * fonction, « passer une fonction » n'y voudrait rien dire (relevé par la
 * coordination le 2026-09-28 sur printlabels.js) ; il faut la déclarer là où
 * le langage garantit sa valeur. Ailleurs, une fonction écrite sur place qui
 * appelle la valeur échoue si elle n'est pas une fonction, au lieu de
 * l'exécuter comme du code.
 */
function constatMinuteurNonResolu({ unite, ligneDe, n, nom, motif, nomArg = null, partagee = false }) {
  const remediation = partagee
    ? `${ouDeclarer(nomArg, { fonction: true }).replace(/^d/, 'D')}. Le langage garantit alors qu'aucun autre script ne la remplace.`
    : `Passer à \`${nom}\` une fonction écrite sur place (\`${nom}(() => ${nomArg ? `${nomArg}()` : '…'}, délai)\`) : une valeur qui ne serait pas une fonction y provoque une erreur au lieu d'être exécutée comme du code. À défaut, documenter dans le README la provenance de cette valeur.`;
  return constat({
    regle: 'C-XSS-04', axe: 'C', severite: SEVERITE_MINUTEUR_NON_RESOLU, bloquant: false, confiance: 'a_verifier',
    titre: `Source de ${nom} non résolue par l'analyse statique`,
    fichier: unite.chemin, ligne: ligneDe(n), extrait: extraireSource(unite.source, n),
    constat: motif,
    impact: "Si cette expression contient une chaîne au moment de l'appel, elle est évaluée comme du code, avec les mêmes conséquences qu'eval(). L'analyse statique ne peut ni le confirmer ni l'exclure depuis ce seul fichier.",
    remediation,
    referentiels: ['CWE-95', REF_GUIDE],
  });
}

/** Vrai si un opérande d'une concaténation `+` est lui-même toujours une chaîne : le résultat l'est alors, quel que soit l'autre opérande. */
function operandeChaine(noeud) {
  if (noeud?.type === 'BinaryExpression' && noeud.operator === '+') return operandeChaine(noeud.left) || operandeChaine(noeud.right);
  return produitToujoursUneChaine(noeud);
}

/**
 * Ce que le constat d'un minuteur affirme de son premier argument, selon ce
 * que l'analyse en sait vraiment. « Est une chaîne » n'est vrai que d'une
 * forme qui en produit toujours une : une donnée reçue (`r.Formule`) a un
 * type inconnu, une concaténation peut donner un nombre, un littéral non
 * chaîne est converti (relevé par la coordination le 2026-09-28).
 */
function formeArgumentMinuteur(nom, forme, nomArg, arg = null) {
  switch (forme) {
    case 'litteral': return {
      titre: `Littéral passé à ${nom} à la place d'une fonction (équivalent à eval)`,
      texte: `Le premier argument de \`${nom}\` est un littéral, pas une fonction : il est converti en chaîne, puis exécuté comme du code.`,
    };
    case 'concatenation': return {
      titre: `Concaténation passée à ${nom} (équivalent à eval)`,
      texte: operandeChaine(arg)
        ? `Le premier argument de \`${nom}\` est une concaténation dont un opérande est une chaîne : le résultat est toujours une chaîne, exécutée comme du code.`
        : `Le premier argument de \`${nom}\` est une concaténation, jamais une fonction : si l'un de ses opérandes est une chaîne au moment de l'appel, le résultat est une chaîne, exécutée comme du code.`,
    };
    case 'donnee':
      if (estAccesLocation(arg)) return {
        titre: `Adresse de la page passée à ${nom} (équivalent à eval)`,
        texte: `Le premier argument de \`${nom}\`, \`${nomPointe(arg)}\`, est lu dans l'adresse de la page, que n'importe quel lien peut fixer : c'est toujours une chaîne, exécutée comme du code.`,
      };
      if (estLectureStockageLocal(arg)) return {
        titre: `Valeur du stockage local passée à ${nom} (équivalent à eval)`,
        texte: `Le premier argument de \`${nom}\` est lu dans le stockage local, que n'importe quel script de cette origine peut remplir : c'est une chaîne (ou null), exécutée comme du code.`,
      };
      return {
        titre: `Donnée reçue par le widget passée à ${nom} (équivalent à eval)`,
        texte: `Le premier argument de \`${nom}\` provient d'une donnée reçue par le widget, dont le type n'est pas connu : si c'est une chaîne, elle est exécutée comme du code.`,
      };
    case 'liaison': return {
      titre: `Valeur qui peut être une chaîne passée à ${nom} (équivalent à eval)`,
      texte: `Le premier argument de \`${nom}\`, \`${nomArg}\`, reçoit une chaîne ou une donnée ailleurs dans le code : si c'en est une au moment de l'appel, elle est exécutée comme du code.`,
    };
    default: return {
      titre: `Chaîne de caractères passée à ${nom} (équivalent à eval)`,
      texte: `Le premier argument de \`${nom}\` est une chaîne, pas une fonction.`,
    };
  }
}

function traiterSiteConstructionMinuteur(ctx, { unite, ligneDe, n, nom, texteBrut, profondeur, forme = 'chaine', nomArg = null, raison = null, motif = null, arg = null }) {
  const { titre, texte } = formeArgumentMinuteur(nom, forme, nomArg, arg);
  const remediation = `Passer une fonction : \`${nom}(() => …, délai)\`.`;
  const declaration = declarationQuiGarantit(nomArg, motif);
  return traiterSiteConstruction(ctx, {
    fichierOrigine: unite.chemin, ligneAppel: ligneDe(n), colonneAppel: colonneDans(unite, n), extrait: extraireSource(unite.source, n),
    texteBrut, profondeur, regle: 'C-XSS-04',
    titreConstruction: titre,
    texteConstruction: texte,
    remediationSupprimer: declaration ? `${remediation} Si cette chaîne doit rester, ${declaration} : son contenu est alors garanti, et audité comme du code écrit en place.` : remediation,
    motifNonGaranti: raison ? motifIdentifiantNonGaranti(nomArg, raison) : undefined,
    impactConstruction: IMPACT_EXECUTION_CHAINE,
  }).constats;
}

/**
 * `setTimeout`/`setInterval` : Chromium compile en code TOUT argument qui
 * évalue en une chaîne, quelle que soit la syntaxe qui la produit
 * (`atob`, `String.fromCharCode`, concaténation, gabarit interpolé) — un
 * texte de chaîne, pas seulement quelques formes syntaxiques reconnues.
 * Une fonction manifeste (fléchée, ou un identifiant qui en résout une —
 * déclarée dans ce fichier, ou paramètre `resolve`/`reject` d'un exécuteur
 * de `new Promise(...)`, garanti par le langage) n'est jamais signalée.
 * Un identifiant qui résout vers une chaîne littérale ailleurs dans le
 * fichier est audité comme si elle était écrite en place. Tout le reste
 * (identifiant non résolu, appel de fonction, accès de membre, ternaire…)
 * reçoit un palier « à vérifier » plutôt que le silence d'avant :
 * `setTimeout(String.fromCharCode(...))`, `setTimeout(f())`,
 * `setTimeout(obj.m)` restaient muets (relevé par la coordination le
 * 2026-09-28) faute d'appartenir aux trois formes syntaxiques reconnues. Ce
 * palier est resté en simple info sans pénalité (voir
 * `SEVERITE_MINUTEUR_NON_RESOLU`) SAUF quand l'analyse reconnaît que la
 * valeur provient d'une donnée reçue par le widget (`estSourceDonneeWidget`)
 * : dans ce cas précis, elle est traitée exactement comme un eval() calculé
 * — critique et bloquant — sans quoi cacher `eval(r.Formule)` derrière
 * `setTimeout(r.Formule, 0)` notait mieux que l'écrire en clair (décision de
 * la coordination le 2026-09-28, après mesure sur 31 widgets honnêtes).
 */
function traiterMinuteur(ctx, { unite, ligneDe, n, nom, arg, ast, walkAcorn, ancetres, estModule, profondeur }) {
  if (!arg) return [];

  if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') return [];

  // `setTimeout(location.reload, 0)` passe une fonction, `setTimeout(location.hash.length)` un nombre : ni l'un ni l'autre ne se compile en code.
  if (['fonction', 'nombre'].includes(typeAccesLocation(arg))) return [];

  if (estSourceDonneeWidget(arg, ancetres)) {
    return traiterSiteConstructionMinuteur(ctx, { unite, ligneDe, n, nom, texteBrut: null, profondeur, forme: 'donnee', arg });
  }

  // Un identifiant est le seul cas où « inconnu » veut dire : peut-être une
  // fonction (le motif `setTimeout(callback, delai)`, très courant) — d'où
  // le palier « à vérifier », pas une critique systématique.
  if (arg.type === 'Identifier') {
    const resolution = resoudreArgument(arg, { walkAcorn, ancetres, estModule });
    if (resolution.type === 'fonction') return [];
    if (resolution.type === 'litteral') {
      return traiterSiteConstructionMinuteur(ctx, { unite, ligneDe, n, nom, texteBrut: resolution.valeur, profondeur, forme: coercerLitteralNonChaine(resolution.init) === null ? 'chaine' : 'litteral' });
    }
    if (resolution.type === 'chaine-non-garantie') {
      materialiserLitterauxEcrits(ctx, { unite, ligneDe, litteraux: resolution.litteraux, profondeur });
      return traiterSiteConstructionMinuteur(ctx, { unite, ligneDe, n, nom, texteBrut: null, profondeur, forme: 'liaison', nomArg: arg.name, raison: resolution.raison, motif: resolution.motif });
    }
    return [constatMinuteurNonResolu({
      unite, ligneDe, n, nom, nomArg: arg.name, partagee: resolution.motif === 'partagee',
      motif: `Le premier argument de \`${nom}\`, \`${arg.name}\`, ${resolution.raison} : l'analyse statique ne peut pas garantir qu'il s'agit encore d'une fonction au moment de l'appel.`,
    })];
  }

  // Un opérateur binaire AUTRE que `+` (soustraction, comparaison,
  // bit-à-bit…) ne produit JAMAIS de chaîne, quels que soient ses opérandes
  // (coercion numérique ou booléenne garantie par la spécification) : même
  // non résolu (`a - b` où ni `a` ni `b` n'est connu), le résultat ne peut
  // être qu'un nombre ou un booléen, jamais du texte attaquable. Le traiter
  // comme un candidat « chaîne garantie » produisait un faux bloquant sur
  // `setTimeout(a - b, …)` (relevé par la coordination le 2026-09-28) :
  // provablement sûr, donc aucun constat, pas même une information.
  if (arg.type === 'BinaryExpression' && arg.operator !== '+') return [];

  // Un littéral NON-chaîne (null, nombre, booléen) a une valeur ENTIÈREMENT
  // connue à la lecture — `ToString()` la détermine de façon déterministe,
  // ce n'est pas moins un littéral qu'une chaîne. `setTimeout(null, 1)` et
  // `setTimeout(0)` ressortaient à tort en critique+bloquant avec le texte
  // « calculé à l'exécution », alors que rien n'est calculé (relevé par la
  // coordination le 2026-09-28). Audité comme le reste du modèle du
  // littéral : mineur, jamais un faux bloquant.
  const nonChaineLitterale = coercerLitteralNonChaine(arg);
  if (nonChaineLitterale !== null) {
    return traiterSiteConstructionMinuteur(ctx, { unite, ligneDe, n, nom, texteBrut: nonChaineLitterale, profondeur, forme: 'litteral' });
  }

  // Formes qui produisent TOUJOURS une chaîne, quel que soit leur contenu
  // (littéral, gabarit, concaténation avec `+`, atob()/String.fromCharCode())
  // : si le contenu ne se replie pas en littéral, il est réellement
  // « calculé à l'exécution », au même titre qu'un eval() à argument calculé
  // — pas une simple inconnue à vérifier, `traiterSiteConstruction`
  // (texteBrut===null) s'en charge.
  if (produitToujoursUneChaine(arg)) {
    const texteBrut = plierLitteraux(arg) ?? decoderAtobLitteral(arg) ?? decoderFromCharCodeLitteral(arg);
    return traiterSiteConstructionMinuteur(ctx, { unite, ligneDe, n, nom, texteBrut, profondeur, forme: texteBrut === null && arg.type === 'BinaryExpression' ? 'concatenation' : 'chaine', arg });
  }

  // Le reste (accès de membre, appel de fonction quelconque, ternaire…) n'a
  // pas la garantie de produire une chaîne : ni le silence d'avant, ni une
  // critique systématique, le même palier « à vérifier » qu'un identifiant
  // non résolu — `setTimeout(f())`, `setTimeout(obj.m)` restaient muets
  // (relevé par la coordination le 2026-09-28).
  return [constatMinuteurNonResolu({
    unite, ligneDe, n, nom,
    motif: `Le premier argument de \`${nom}\` n'est ni une fonction ni une chaîne littérale reconnue : son contenu réel n'est connu qu'à l'exécution.`,
  })];
}

/** `new Worker(...)`/`new SharedWorker(...)` construit depuis du code en chaîne (voir `classifierSourceWorker`). */
function traiterWorker(ctx, { unite, ligneDe, n, profondeur }) {
  const nomWorker = nomFinal(n.callee);
  const categorie = classifierSourceWorker(n.arguments[0]);

  if (categorie === 'code-en-chaine') {
    return traiterSiteConstruction(ctx, {
      fichierOrigine: unite.chemin, ligneAppel: ligneDe(n), colonneAppel: colonneDans(unite, n), extrait: extraireSource(unite.source, n),
      texteBrut: extraireCodeLitteralWorker(n.arguments[0]), profondeur, regle: 'C-XSS-07',
      titreConstruction: `${nomWorker} construit depuis du code assemblé en chaîne dans le dépôt`,
      texteConstruction: `Le code exécuté par ce ${nomWorker} est fourni sous forme de chaîne écrite dans le dépôt (\`Blob\` ou URL \`data:\`), pas comme un fichier séparé.`,
      remediationSupprimer: `Déplacer ce code dans un fichier de worker séparé, chargé par \`new ${nomWorker}('./chemin/local.js')\` : il redevient un fichier du dépôt, lisible et audité comme le reste du widget.`,
      impactConstruction: "Équivalent fonctionnel d'eval() : ce code s'exécute avec les privilèges réseau du widget dès la construction du worker, et rien de son contenu — par exemple un appel vers un domaine externe — n'est lu par l'analyse statique, qui ne lit que des fichiers.",
    }).constats;
  }

  if (categorie === 'non-resolue') {
    return [constat({
      regle: 'C-XSS-07', axe: 'C', severite: 'majeur', bloquant: false, confiance: 'a_verifier',
      titre: `Source de ${nomWorker} non résolue par l'analyse statique`,
      fichier: unite.chemin, ligne: ligneDe(n), extrait: extraireSource(unite.source, n),
      constat: `La source passée à ${nomWorker} n'est ni un chemin de fichier littéral ni un motif reconnu : elle peut provenir d'une variable construite ailleurs dans le code.`,
      impact: "L'analyse statique ne lit que des fichiers déclarés en clair : une source calculée peut pointer vers du code jamais vu par aucune règle, y compris une URL blob: ou data: assemblée dans une instruction précédente.",
      remediation: `Utiliser un chemin de fichier littéral (\`new ${nomWorker}('./chemin/local.js')\`), ou documenter dans le README la provenance exacte de cette source.`,
      referentiels: [REF_GUIDE, 'CWE-95'],
    })];
  }

  return [];
}

/**
 * Matérialise en tête de l'axe C (premier élément de `reglesC`, avant même
 * `analyserAccesGrist`) tout code littéral fourni en chaîne — à
 * `eval`/eval indirect/`Function()`/`new Function()`/`setTimeout`/
 * `setInterval`/`new Worker(...)` — comme des fichiers de plus dans
 * `ctx.fichiers`, avant que la moindre autre règle de cet axe (ou de l'axe B)
 * ne s'exécute. Itère à profondeur croissante (un littéral peut lui-même
 * contenir un eval()) jusqu'à `MAX_PROFONDEUR_CODE_IMBRIQUE`.
 */
export function preparerCodeExecuteEnChaine(ctx) {
  const constats = [];
  let frontiere = ctx.fichiers.filter((f) => f.executee && !f.binaire);
  let profondeur = 0;

  // `<=` et non `<` : le dernier passage, à `profondeur === MAX`, ne
  // matérialise plus rien (voir le garde-fou dans `traiterSiteConstruction`)
  // mais scanne quand même la dernière frontière pour émettre le constat
  // « imbrication trop profonde » — sans ce passage, un littéral qui
  // dépasse la limite serait tronqué en silence plutôt que signalé.
  while (frontiere.length && profondeur <= MAX_PROFONDEUR_CODE_IMBRIQUE) {
    const nouveaux = [];
    for (const f of frontiere) {
      pourChaqueUniteJs({ fichiers: [f] }, {}, ({ ast, ligneDe, walk: walkAcorn, unite }) => {
        if (!ast) return;
        const avant = ctx.fichiers.length;
        // Le premier niveau d'un module n'est pas partagé avec les autres
        // scripts de la page (voir `estPorteeLocale`) : seul le langage en
        // décide, par la syntaxe du fichier ou l'élément qui le contient.
        const estModule = unite.module || syntaxeDeModule(ast);
        // `ancestor` (pas `simple`) : `traiterMinuteur` et `traiterAppelExecution`
        // ont besoin de la chaîne des ancêtres du site d'appel pour résoudre un
        // identifiant vers la liaison la plus proche qui le lie, quelle que
        // soit sa nature (voir `trouverLiaisonVisible`).
        walkAcorn.ancestor(ast, {
          CallExpression(n, _state, ancetres) {
            const nom = nomPointe(n.callee) || '';
            if (/(^|\.)eval$/.test(nom)) {
              constats.push(...traiterAppelExecution(ctx, {
                unite, ligneDe, n, argument: n.arguments[0], ast, walkAcorn, ancetres, estModule, profondeur,
                titreConstruction: 'Exécution de code arbitraire via eval()',
                texteConstruction: '`eval()` est appelé dans le code exécuté du widget.',
                remediationSupprimer: "Supprimer l'appel. Pour interpréter des données, utiliser `JSON.parse` ; pour une logique configurable, un interpréteur restreint écrit explicitement.",
              }));
            } else if (n.callee.type === 'SequenceExpression' && n.callee.expressions.at(-1)?.type === 'Identifier' && n.callee.expressions.at(-1).name === 'eval') {
              constats.push(...traiterAppelExecution(ctx, {
                unite, ligneDe, n, argument: n.arguments[0], ast, walkAcorn, ancetres, estModule, profondeur,
                titreConstruction: 'Exécution de code arbitraire via eval() indirect',
                texteConstruction: "La forme `(0, eval)(...)` (ou équivalente) appelle `eval` indirectement.",
                remediationSupprimer: "Supprimer l'appel. Pour interpréter des données, utiliser `JSON.parse` ; pour une logique configurable, un interpréteur restreint écrit explicitement.",
              }));
            }

            if (nom.split('.').pop() === 'Function') {
              constats.push(...traiterAppelExecution(ctx, {
                unite, ligneDe, n, argument: n.arguments.at(-1), ast, walkAcorn, ancetres, estModule, profondeur, envelopper: true,
                titreConstruction: 'Construction de code à la volée via Function() (sans new)',
                texteConstruction: '`Function(...)` sans `new` compile une chaîne en fonction exécutable, exactement comme `new Function(...)` : l\'appel fonctionne dans les deux cas.',
                remediationSupprimer: 'Supprimer cet usage.',
              }));
            }

            if (/^(setTimeout|setInterval)$/.test(nom.split('.').pop())) {
              constats.push(...traiterMinuteur(ctx, { unite, ligneDe, n, nom, arg: n.arguments[0], ast, walkAcorn, ancetres, estModule, profondeur }));
            }
          },
          NewExpression(n, _state, ancetres) {
            if (nomFinal(n.callee) === 'Function') {
              constats.push(...traiterAppelExecution(ctx, {
                unite, ligneDe, n, argument: n.arguments.at(-1), ast, walkAcorn, ancetres, estModule, profondeur, envelopper: true,
                titreConstruction: 'Construction de code à la volée via new Function()',
                texteConstruction: '`new Function(...)` compile une chaîne en fonction exécutable.',
                remediationSupprimer: 'Supprimer cet usage.',
              }));
            }
            if (/^(Worker|SharedWorker)$/.test(nomFinal(n.callee))) {
              constats.push(...traiterWorker(ctx, { unite, ligneDe, n, profondeur }));
            }
          },
        });
        // Tout fichier ajouté pendant ce passage (par traiterSiteConstruction,
        // via traiterAppelExecution/traiterMinuteur/traiterWorker) entre dans
        // la frontière du niveau suivant, pour détecter un eval() imbriqué
        // dans un eval() déjà littéral.
        for (let i = avant; i < ctx.fichiers.length; i++) nouveaux.push(ctx.fichiers[i]);
      });
    }
    frontiere = nouveaux;
    profondeur++;
  }

  return constats;
}

export function analyserInjections(ctx) {
  const constats = [];
  // Les affectations de HTML *constant* ne sont pas un risque d'injection : on
  // les compte pour les restituer en une seule ligne d'information, au lieu de
  // noyer les vraies injections sous des dizaines de constats sans enjeu.
  const htmlConstant = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite, fichier }) => {
    if (!ast) return;

    walk.simple(ast, {
      AssignmentExpression(n) {
        if (n.left.type !== 'MemberExpression') return;
        const nom = nomPointe(n.left) || '';

        if (/^(href|src|action|formaction)$/i.test(nom.split('.').pop()) && debuteParSchema(n.right, 'javascript')) {
          constats.push(constat({
            regle: 'C-XSS-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
            titre: 'Exécution de code arbitraire via une URL javascript:',
            fichier: unite.chemin, ligne: ligneDe(n), extrait: extraireSource(unite.source, n),
            constat: `Le code affecte à \`${nom}\` une URL de schéma \`javascript:\`.`,
            impact: "Une URL `javascript:` exécute son contenu comme du code dès la navigation (ou immédiatement pour `location`) — même risque qu'`eval()`, sous un déguisement qui échappe à une recherche de texte sur `eval(`.",
            remediation: "Supprimer cette URL. Utiliser un gestionnaire d'évènement (`addEventListener('click', ...)`) plutôt qu'un lien `javascript:`.",
            referentiels: ['CWE-95', REF_ANSSI, 'OWASP Top 10 A03:2021'],
          }));
          return;
        }

        if (!SINKS_HTML.test(nom)) return;
        if (!estDynamique(n.right)) {
          htmlConstant.push({ fichier: unite.chemin, ligne: ligneDe(n) });
          return;
        }
        constats.push(constat({
          regle: 'C-XSS-01', axe: 'C', severite: 'majeur', confiance: 'probable',
          titre: `Écriture de HTML dynamique dans le DOM (${nom.split('.').pop()})`,
          fichier: unite.chemin, ligne: ligneDe(n),
          extrait: extraireSource(unite.source, n),
          constat: `Le code affecte à \`${nom}\` une valeur construite à l'exécution.`,
          impact: "Si la valeur provient d'une cellule Grist, un agent qui saisit `<img src=x onerror=...>` dans une cellule fait exécuter du code dans le widget — donc avec l'accès au document que l'agent lui a accordé. Dans un document partagé, cela permet à un contributeur d'attaquer ses collègues.",
          remediation: "Utiliser `textContent` pour du texte, ou construire les nœuds avec `document.createElement`. Si du HTML riche est indispensable, passer par un assainisseur (DOMPurify) embarqué dans le dépôt, et le documenter.",
          referentiels: ['OWASP Top 10 A03:2021 — Injection', 'CWE-79'],
        }));
      },
      CallExpression(n) {
        const nom = nomPointe(n.callee) || '';

        if (/insertAdjacentHTML$/.test(nom) && estDynamique(n.arguments[1])) {
          constats.push(constat({
            regle: 'C-XSS-01', axe: 'C', severite: 'majeur', confiance: 'probable',
            titre: 'Insertion de HTML dynamique via insertAdjacentHTML',
            fichier: unite.chemin, ligne: ligneDe(n), extrait: extraireSource(unite.source, n),
            constat: 'Le second argument est construit à l\'exécution.',
            impact: "Même risque que `innerHTML` : une donnée de cellule interprétée comme du balisage devient du code exécuté dans le widget.",
            remediation: "Utiliser `textContent` pour du texte, ou construire les nœuds avec `document.createElement`. Si du HTML riche est indispensable, passer par un assainisseur (DOMPurify) embarqué dans le dépôt, et le documenter.",
            referentiels: ['OWASP Top 10 A03:2021', 'CWE-79'],
          }));
        }

        if (/(^|\.)document\.write(ln)?$/.test(nom)) {
          constats.push(constat({
            regle: 'C-XSS-02', axe: 'C', severite: 'majeur', confiance: 'certain',
            titre: 'Usage de document.write()',
            fichier: unite.chemin, ligne: ligneDe(n),
            constat: '`document.write()` écrit directement dans le flux du document.',
            impact: "Interprète son argument comme du balisage, bloque l'analyse de la page et est incompatible avec une politique de sécurité de contenu stricte.",
            remediation: "Injecter le contenu voulu au chargement avec `document.createElement` / `textContent` sur un conteneur déjà présent dans le HTML, plutôt qu'en réécrivant le flux du document.",
            referentiels: ['CWE-79'],
          }));
        }

        // eval()/eval indirect/Function()/new Function()/setTimeout/setInterval/
        // new Worker(code en chaîne) : détectés et matérialisés en tête de
        // l'axe C par `preparerCodeExecuteEnChaine`, avant que cette règle ne
        // s'exécute — voir sa documentation pour le raisonnement (le widget
        // entier doit voir ce code, pas seulement un fragment isolé).

        if (/(^|\.)createContextualFragment$/.test(nom) && estDynamique(n.arguments[0])) {
          constats.push(constat({
            regle: 'C-XSS-01', axe: 'C', severite: 'majeur', confiance: 'probable',
            titre: 'Fragment HTML construit depuis une chaîne dynamique (createContextualFragment)',
            fichier: unite.chemin, ligne: ligneDe(n), extrait: extraireSource(unite.source, n),
            constat: "Le code construit un fragment HTML depuis une chaîne calculée à l'exécution.",
            impact: "Une fois ce fragment inséré dans le document (`appendChild`, etc.), tout balisage qu'il contient s'exécute comme du HTML natif : même risque qu'une affectation dynamique à `innerHTML`.",
            remediation: "Construire les nœuds avec `document.createElement`/`textContent`, ou passer par un assainisseur (DOMPurify) avant d'appeler `createContextualFragment`.",
            referentiels: ['OWASP Top 10 A03:2021', 'CWE-79'],
          }));
        }

        if (/(^|\.)setAttribute$/.test(nom) && n.callee.type === 'MemberExpression' &&
            /^(href|src|action|formaction)$/i.test(chaineLitterale(n.arguments[0]) || '') &&
            debuteParSchema(n.arguments[1], 'javascript')) {
          constats.push(constat({
            regle: 'C-XSS-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
            titre: 'Exécution de code arbitraire via une URL javascript:',
            fichier: unite.chemin, ligne: ligneDe(n), extrait: extraireSource(unite.source, n),
            constat: `Le code appelle \`setAttribute\` pour donner à un attribut de navigation une URL de schéma \`javascript:\`.`,
            impact: "Une URL `javascript:` exécute son contenu comme du code dès la navigation — même risque qu'`eval()`, sous un déguisement qui échappe à une recherche de texte sur `eval(`.",
            remediation: "Supprimer cette URL. Utiliser un gestionnaire d'évènement (`addEventListener('click', ...)`) plutôt qu'un lien `javascript:`.",
            referentiels: ['CWE-95', REF_ANSSI, 'OWASP Top 10 A03:2021'],
          }));
        }

        // jQuery .html(x) avec argument dynamique
        if (/\.html$/.test(nom) && n.arguments.length === 1 && estDynamique(n.arguments[0])) {
          constats.push(constat({
            regle: 'C-XSS-05', axe: 'C', severite: 'mineur', confiance: 'probable',
            titre: 'Appel .html() avec une valeur dynamique (motif jQuery)',
            fichier: unite.chemin, ligne: ligneDe(n),
            constat: 'Un appel `.html(valeur)` reçoit une valeur construite à l\'exécution.',
            impact: 'Si l\'objet est un objet jQuery, la valeur est interprétée comme du balisage.',
            remediation: 'Utiliser `.text()` pour du texte.',
            referentiels: ['CWE-79'],
          }));
        }
      },
    });

  });

  if (htmlConstant.length) {
    const fichiers = [...new Set(htmlConstant.map((e) => e.fichier))];
    constats.push(constat({
      regle: 'C-XSS-06', axe: 'C', severite: 'info', confiance: 'certain',
      titre: `${htmlConstant.length} écriture(s) de HTML constant via innerHTML`,
      fichier: fichiers[0], ligne: htmlConstant[0].ligne,
      constat: `Le code affecte du balisage littéral à \`innerHTML\` à ${htmlConstant.length} endroit(s), répartis sur ${fichiers.length} fichier(s).`,
      impact: "Aucun risque d'injection tant que le contenu reste littéral. Mentionné pour mémoire : ces emplacements deviennent dangereux le jour où une variable y est interpolée, et ils sont donc à surveiller en revue.",
      remediation: "Aucune action requise. Si une valeur dynamique doit un jour y entrer, basculer sur `textContent` ou `createElement` à ce moment-là.",
      preuve: { emplacements: htmlConstant },
    }));
  }

  return constats;
}

/** Une `<meta http-equiv="Content-Security-Policy">` telle que Chromium la lit : nom de l'en-tête insensible à la casse (sans rogner d'espaces). */
const estMetaCsp = (b) => b.nom === 'meta' && b.ns === 'html' && (b.attributs.get('http-equiv') ?? '').toLowerCase() === 'content-security-policy';

/** Vrai si la balise déclare au moins une directive : sans attribut `content`, ou avec un contenu qui n'en a aucune (`""`, `" "`, `";"`), Chromium n'applique aucune politique. */
const aUneDirective = (b) => (b.attributs.get('content') ?? '').split(';').some((partie) => partie.trim() !== '');

/** Pourquoi Chromium n'applique pas cette balise CSP, dit au lecteur. */
function raisonMetaCspInerte(b) {
  if (b.dansTemplate) return 'elle est dans un `<template>`';
  if (!b.dansTete) return "elle n'est plus dans `<head>` (après `</head>`, `<body>` ou du contenu)";
  return b.attributs.has('content') ? "son attribut `content` ne déclare aucune directive" : "elle n'a pas d'attribut `content`";
}

/** Gestionnaires d'événements inline et attributs dangereux dans le HTML. */
export function analyserHtmlDangereux(ctx) {
  const constats = [];
  for (const f of ctx.fichiers) {
    if (!f.executee || f.binaire || !['.html', '.htm'].includes(f.ext)) continue;
    const { balises, ressources } = lirePage(f.contenu);
    const mention = (e) => (e.dansTemplate ? MENTION_GABARIT_RESSOURCE : null);

    for (const a of balises) {
      if (a.nom !== 'a' || (a.attributs.get('target') ?? '').toLowerCase() !== '_blank') continue;
      const rel = jetons(a.attributs.get('rel'));
      if (rel.includes('noopener') || rel.includes('noreferrer')) continue;      // noreferrer implique noopener
      constats.push(constat({
        regle: 'C-DOM-01', axe: 'C', severite: 'mineur', confiance: 'certain',
        titre: 'Lien ouvrant un nouvel onglet sans rel="noopener"',
        fichier: f.chemin, ligne: a.ligne, extrait: a.balise,
        constat: precise('Un lien `target="_blank"` ne porte pas `rel="noopener noreferrer"`.', mention(a)),
        impact: "La page ouverte obtient une référence `window.opener` vers le widget et peut le rediriger (détournement d'onglet).",
        remediation: 'Ajouter `rel="noopener noreferrer"`.',
        referentiels: ['OWASP — Reverse tabnabbing'],
      }));
    }

    for (const r of ressources) {
      if (r.nom !== 'iframe' || r.attributs.has('sandbox')) continue;
      constats.push(constat({
        regle: 'C-DOM-02', axe: 'C', severite: 'majeur', confiance: 'certain',
        titre: 'Iframe imbriquée sans attribut sandbox',
        fichier: f.chemin, ligne: r.ligne, extrait: r.balise,
        constat: precise('Le widget insère une iframe sans restreindre ses capacités.', mention(r)),
        impact: "Le contenu embarqué s'exécute sans confinement supplémentaire à l'intérieur du widget.",
        remediation: 'Ajouter `sandbox` avec le minimum de permissions nécessaires.',
        referentiels: [REF_ANSSI],
      }));
    }

    if (ctx.entrees.includes(f.chemin)) {
      const metas = balises.filter(estMetaCsp);
      if (metas.some((m) => m.dansTete && aUneDirective(m))) continue;   // une CSP que Chromium applique (`dansTete` exclut déjà un `<template>`)
      const inerte = metas[0];
      constats.push(constat({
        regle: 'C-CSP-01', axe: 'C', severite: 'mineur', confiance: 'certain',
        titre: 'Aucune politique de sécurité de contenu (CSP) déclarée',
        fichier: f.chemin,
        constat: precise("Le point d'entrée ne déclare pas de balise `<meta http-equiv=\"Content-Security-Policy\">`.",
          inerte && `une telle balise existe ligne ${inerte.ligne}, mais Chromium ne l'applique pas : ${raisonMetaCspInerte(inerte)}`),
        impact: "Sans CSP, rien n'empêche l'exécution d'un script injecté ni une requête sortante imprévue. La CSP est le filet de sécurité qui limite les dégâts quand une autre défense cède.",
        remediation: "Ajouter une CSP restrictive, par exemple : `default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors *` (le widget devant rester encadrable par Grist). La déclarer côté serveur est préférable, la balise `<meta>` est un repli acceptable pour un widget statique.",
        referentiels: [REF_ANSSI, 'OWASP — Content Security Policy Cheat Sheet'],
      }));
    }
  }
  return constats;
}

// ---------------------------------------------------------------------------
// C-CSP-02 — CSP présente mais permissive (graduation de C-CSP-01)
// ---------------------------------------------------------------------------

/**
 * C-CSP-01 (ci-dessus) sanctionne l'absence de CSP, mais une CSP décorative
 * (`default-src *`) la satisfait tout aussi bien qu'une CSP stricte : défaut
 * classique d'un contrôle de présence, qui peut être « satisfait » sans
 * apporter de protection réelle. Deux signaux seulement, choisis pour leur
 * faible taux de faux positif : un joker `*` non qualifié, et
 * `'unsafe-inline'` en `script-src`. `'unsafe-eval'` n'est volontairement
 * pas sanctionné ici : légitime pour la négociation `grain-rpc` de
 * `grist-plugin-api.js`, le sanctionner pénaliserait le respect de
 * l'intégration Grist officielle.
 */
export function analyserCspPermissive(ctx) {
  const constats = [];
  for (const f of ctx.fichiers) {
    if (!f.executee || f.binaire || !ctx.entrees.includes(f.chemin)) continue;
    const meta = lirePage(f.contenu).balises.find((b) => estMetaCsp(b) && b.dansTete && aUneDirective(b));
    if (!meta) continue; // absence (ou balise que Chromium n'applique pas) déjà couverte par C-CSP-01
    const contenuAttr = [null, null, meta.attributs.get('content')];
    if (contenuAttr[2] == null) continue;

    const directives = {};
    for (const part of contenuAttr[2].split(';')) {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (tokens.length) directives[tokens[0].toLowerCase()] = tokens.slice(1);
    }
    const directiveEffective = directives['script-src'] ? 'script-src' : 'default-src';
    const valeurs = directives[directiveEffective];
    if (!valeurs) continue;

    const ligne = meta.ligne;
    if (valeurs.includes('*')) {
      constats.push(constat({
        regle: 'C-CSP-02', axe: 'C', severite: 'mineur', confiance: 'certain',
        titre: 'La CSP déclarée autorise un joker non qualifié',
        fichier: f.chemin, ligne, extrait: meta.balise,
        constat: `La directive \`${directiveEffective}\` contient \`*\`, qui autorise le chargement de script depuis n'importe quel domaine.`,
        impact: "Une CSP qui accepte tout domaine ne filtre rien : elle donne l'apparence d'une protection sans en apporter la moindre. Un lecteur pressé (ou un contrôle automatisé binaire) la compte comme un point acquis alors qu'elle ne bloque aucune des attaques que la CSP est censée limiter.",
        remediation: "Remplacer le joker par la liste explicite des domaines réellement nécessaires : l'instance Grist elle-même, et les CDN documentés dans le README.",
        referentiels: [REF_ANSSI, 'OWASP — Content Security Policy Cheat Sheet'],
      }));
    }
    if (valeurs.includes("'unsafe-inline'")) {
      constats.push(constat({
        regle: 'C-CSP-02', axe: 'C', severite: 'mineur', confiance: 'certain',
        titre: "La CSP déclarée autorise le script inline ('unsafe-inline')",
        fichier: f.chemin, ligne, extrait: meta.balise,
        constat: `La directive \`${directiveEffective}\` contient \`'unsafe-inline'\`.`,
        impact: "`'unsafe-inline'` neutralise la protection anti-XSS de la CSP : un script injecté (voir les règles C-XSS-*) s'exécute normalement, exactement comme en l'absence de CSP.",
        remediation: "Retirer `'unsafe-inline'` et déplacer le JavaScript inline vers des fichiers externes, ou utiliser un nonce/hash par script si l'inline est indispensable.",
        referentiels: [REF_ANSSI, 'OWASP — Content Security Policy Cheat Sheet'],
      }));
    }
  }
  return constats;
}

// ---------------------------------------------------------------------------
// C-PM / C-STOCK / C-SECRET
// ---------------------------------------------------------------------------

/** Écoute de postMessage sans vérification d'origine. */
export function analyserPostMessage(ctx) {
  const constats = [];
  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      CallExpression(n) {
        const nom = nomPointe(n.callee) || '';
        if (!/addEventListener$/.test(nom)) return;
        if (chaineLitterale(n.arguments[0]) !== 'message') return;

        const corps = extraireSource(unite.source, n.arguments[1]);
        const verifie = /\.origin\b/.test(corps) || /\.source\b/.test(corps);
        if (verifie) return;

        constats.push(constat({
          regle: 'C-PM-01', axe: 'C', severite: 'majeur', confiance: 'probable',
          titre: "Écoute de messages inter-fenêtres sans vérification de l'origine",
          fichier: unite.chemin, ligne: ligneDe(n),
          constat: "Un gestionnaire `message` est installé sans que `event.origin` ne soit testé dans son corps.",
          impact: "N'importe quelle page capable d'obtenir une référence vers la fenêtre du widget peut lui envoyer un message forgé. Si ce message pilote une écriture dans le document, un site tiers peut agir sur les données de l'agent.",
          remediation: "Comparer `event.origin` à l'origine attendue de l'instance Grist avant tout traitement, et ignorer le message sinon.",
          referentiels: ['CWE-346', 'OWASP — HTML5 Security Cheat Sheet'],
        }));
      },
    });
  });
  return constats;
}

/** Vrai si le README à la racine mentionne au moins un des mécanismes donnés (présence, pas qualité — même principe que B-DOC-04). */
function readmeMentionneMecanisme(ctx, mecanismes) {
  const readme = ctx.fichiers?.find((f) => /^readme(\.md|\.txt)?$/i.test(path.basename(f.chemin)) && !f.chemin.includes('/'));
  if (!readme) return false;
  const texte = readme.contenu.toLowerCase();
  return mecanismes.some((m) => texte.includes(m.toLowerCase()));
}

/** Stockage persistant hors de Grist. */
export function analyserStockage(ctx) {
  const constats = [];
  const emplacements = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      CallExpression(n) {
        const nom = nomPointe(n.callee) || '';
        if (/(localStorage|sessionStorage)\.setItem$/.test(nom)) {
          emplacements.push({ fichier: unite.chemin, ligne: ligneDe(n), mecanisme: nom.split('.').slice(-2)[0], cle: chaineLitterale(n.arguments[0]) });
        }
        if (/indexedDB\.open$/.test(nom)) emplacements.push({ fichier: unite.chemin, ligne: ligneDe(n), mecanisme: 'IndexedDB', cle: chaineLitterale(n.arguments[0]) });
      },
      AssignmentExpression(n) {
        const nom = nomPointe(n.left) || '';
        if (/document\.cookie$/.test(nom)) emplacements.push({ fichier: unite.chemin, ligne: ligneDe(n), mecanisme: 'cookie', cle: null });
      },
    });
  });

  if (emplacements.length) {
    const p = emplacements[0];
    const mecanismesUniques = [...new Set(emplacements.map((e) => e.mecanisme))];
    const mecanismes = mecanismesUniques.join(', ');
    const cles = [...new Set(emplacements.map((e) => e.cle).filter(Boolean))];
    // Le mécanisme lui-même étant nommé dans le README (même grossièrement,
    // sans juger si la justification est bonne — même principe que
    // B-DOC-04), le lecteur sait déjà que ce stockage existe : ce que la
    // règle demande dans sa propre remédiation pour le cas « préférence
    // d'affichage ». Le constat reste (le mécanisme mérite d'être vérifié à
    // chaque évolution), mais à titre d'information plutôt que de majeur.
    const documente = readmeMentionneMecanisme(ctx, mecanismesUniques);
    constats.push(constat({
      regle: 'C-STOCK-01', axe: 'C', severite: documente ? 'mineur' : 'majeur', confiance: 'certain',
      titre: `Données conservées hors de Grist (${mecanismes})`,
      fichier: p.fichier, ligne: p.ligne,
      constat: `${emplacements.length} écriture(s) de stockage persistant détectée(s)${cles.length ? ` — clés : ${cles.slice(0, 8).join(', ')}` : ''}.`,
      impact: "Le guide de contribution demande qu'aucune donnée utilisateur ne soit stockée hors de Grist. Les données écrites ici survivent à la fermeture du document, échappent aux droits d'accès Grist, ne sont pas couvertes par les sauvegardes, et ne disparaissent pas quand l'agent perd l'accès au document. Si elles contiennent des données personnelles, cela constitue un traitement non déclaré.",
      remediation: documente
        ? "Le mécanisme est déjà nommé dans le README : vérifier que les clés effectivement écrites correspondent bien à ce qui y est décrit (préférence d'affichage) et non à du contenu issu du document."
        : "Distinguer les deux cas. Préférences d'affichage (thème, colonne triée) : acceptable, à documenter dans le README. Contenu issu du document : à replacer dans une table Grist, ou à ne pas persister du tout.",
      referentiels: ['Guide de contribution Grist.Gouv — « no storage of user data outside of Grist »', 'RGPD art. 5'],
      preuve: { emplacements, documente },
    }));
  }
  return constats;
}

/** Secrets en dur. Les motifs sont volontairement spécifiques pour éviter le bruit. */
const MOTIFS_SECRETS = [
  [/\bAKIA[0-9A-Z]{16}\b/g, 'clé d\'accès AWS'],
  [/\bghp_[A-Za-z0-9]{36}\b/g, 'jeton personnel GitHub'],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, 'jeton personnel GitHub (format récent)'],
  [/\bsk-[A-Za-z0-9]{32,}\b/g, 'clé d\'API de type OpenAI'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'jeton Slack'],
  [/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, 'clé privée'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jeton JWT'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'clé d\'API Google'],
  [/(?:api[_-]?key|apikey|secret|token|password|passwd|motdepasse)\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/gi, 'identifiant en dur'],
];

const LEURRES = /^(x{4,}|\.{3,}|<[^>]+>|\$\{|process\.env|votre|your|example|placeholder|changeme|todo|null|undefined|test|demo|lorem)/i;

export function analyserSecrets(ctx) {
  const constats = [];
  for (const f of ctx.fichiers) {
    if (f.binaire || !f.contenu) continue;
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f.chemin)) continue;

    for (const [re, libelle] of MOTIFS_SECRETS) {
      for (const m of f.contenu.matchAll(re)) {
        const valeur = m[1] ?? m[0];
        if (LEURRES.test(valeur)) continue;
        if (/^[a-z]+(\.[a-z]+)+$/i.test(valeur)) continue;   // ressemble à un chemin, pas à un secret
        // Un fichier synthétique (`litteralImbrique`) qui reproduit
        // TEXTUELLEMENT un secret déjà visible dans son fichier d'origine (un
        // littéral direct, non obfusqué) ne doit pas le compter une deuxième
        // fois : préexistant à ce commit, mais corrigé au passage par le même
        // mécanisme que F-SOUV-01 (voir plus bas), déjà en place pour cette
        // matérialisation.
        if (f.litteralImbrique && f.origineReelle) {
          const origine = ctx.fichiers.find((of) => of.chemin === f.origineReelle.chemin);
          if (origine?.contenu?.includes(m[0])) continue;
        }
        constats.push(constat({
          regle: 'C-SECRET-01', axe: 'C', severite: 'critique', bloquant: true, confiance: 'probable',
          titre: `Secret potentiel versionné dans le dépôt (${libelle})`,
          fichier: f.chemin, ligne: numeroLigne(f.contenu, m.index),
          extrait: masquer(m[0]),
          constat: `Une valeur correspondant au format d'un ${libelle} est présente dans un fichier versionné.`,
          impact: "Un secret dans un dépôt public est compromis dès sa publication, et le reste après suppression du fichier : il demeure dans l'historique Git. Pour un widget, un secret est en outre livré au navigateur de chaque agent.",
          remediation: "Révoquer immédiatement le secret côté fournisseur, puis le retirer de l'historique. Un widget est du code exécuté côté client : il ne peut pas détenir de secret. Toute opération nécessitant un secret doit passer par un service tiers, hors du widget.",
          referentiels: ['ANSSI — Guide d\'hygiène informatique', 'CWE-798', 'OWASP Top 10 A07:2021'],
        }));
      }
    }
  }
  return constats;
}

/** Aléa non cryptographique utilisé pour ce qui ressemble à un identifiant de sécurité. */
export function analyserAlea(ctx) {
  const constats = [];
  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite, }) => {
    if (!ast) return;
    walk.ancestor(ast, {
      CallExpression(n, _state, ancetres) {
        if ((nomPointe(n.callee) || '') !== 'Math.random') return;
        // On ne signale que si le résultat alimente quelque chose de sensible :
        // un Math.random() pour une couleur ou une animation n'est pas un défaut.
        const contexte = ancetres.slice(-6).map((a) => extraireSource(unite.source, a)).join(' ');
        if (!/\b(token|jeton|secret|key|cle|clé|password|mot_?de_?passe|nonce|salt|uuid|session|csrf|id_unique)\b/i.test(contexte)) return;
        constats.push(constat({
          regle: 'C-CRYPTO-01', axe: 'C', severite: 'majeur', confiance: 'probable',
          titre: 'Math.random() employé pour générer une valeur à usage de sécurité',
          fichier: unite.chemin, ligne: ligneDe(n),
          constat: "`Math.random()` alimente une variable dont le nom évoque un jeton, une clé ou un identifiant de session.",
          impact: "`Math.random()` est prévisible : sa graine est déductible à partir de quelques tirages. Une valeur de sécurité qui en découle est devinable.",
          remediation: 'Utiliser `crypto.getRandomValues()` ou `crypto.randomUUID()`.',
          referentiels: ['CWE-338', 'ANSSI — Guide de sélection d\'algorithmes cryptographiques'],
        }));
      },
    });
  });
  return constats;
}

// ---------------------------------------------------------------------------
// C-FINGERPRINT — contournement de l'audit par empreinte d'environnement
// ---------------------------------------------------------------------------

/** Un widget qui teste navigator.webdriver peut rester sage sous l'audit (Chromium automatisé de l'axe D) et se comporter différemment une fois installé chez l'agent. */
export function analyserEmpreinteAutomatisation(ctx) {
  const constats = [];
  const vus = new Set();

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      MemberExpression(n) {
        const nom = nomPointe(n) || '';
        if (!/(^|\.)navigator\.webdriver$/.test(nom)) return;
        const cle = `${unite.chemin}:${ligneDe(n)}`;
        if (vus.has(cle)) return;
        vus.add(cle);
        constats.push(constat({
          regle: 'C-FINGERPRINT-01', axe: 'C', severite: 'majeur', confiance: 'probable',
          titre: 'Le widget teste navigator.webdriver',
          fichier: unite.chemin, ligne: ligneDe(n),
          extrait: extraireSource(unite.source, n),
          constat: "Le code lit `navigator.webdriver`, la propriété que les navigateurs pilotés par automatisation (Playwright, Puppeteer, Selenium — dont le Chromium de l'axe D de cet outil) exposent à `true`.",
          impact: "Ce test permet au widget de distinguer un audit automatisé d'une exécution réelle chez l'agent, et donc de rester sage pendant l'audit tout en agissant différemment une fois installé : c'est un contournement direct du contrôle en condition réelle, pas seulement un défaut de qualité.",
          remediation: "Documenter dans le README la raison précise de ce test s'il en existe une légitime (par exemple désactiver une animation coûteuse en environnement de test). En l'absence de justification écrite, le retirer : un widget Grist n'a aucune raison fonctionnelle d'adapter son comportement à la présence d'automatisation.",
          referentiels: ['OWASP — Anti-automation / evasion techniques', 'CWE-696'],
        }));
      },
    });
  });

  return constats;
}

// ---------------------------------------------------------------------------
// C-PERSIST — persistance au-delà du retrait du widget
// ---------------------------------------------------------------------------

/** Service Worker et Cache API : deux mécanismes absents de la couverture actuelle, plus durables qu'un simple stockage local (voir C-STOCK-01). */
export function analyserPersistanceHorsWidget(ctx) {
  const constats = [];
  const emplacements = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      CallExpression(n) {
        const nom = nomPointe(n.callee) || '';
        if (/serviceWorker\.register$/.test(nom)) {
          emplacements.push({ fichier: unite.chemin, ligne: ligneDe(n), mecanisme: 'Service Worker', cible: chaineLitterale(n.arguments[0]) });
        }
        if (/(^|\.)caches\.open$/.test(nom)) {
          emplacements.push({ fichier: unite.chemin, ligne: ligneDe(n), mecanisme: 'Cache API', cible: chaineLitterale(n.arguments[0]) });
        }
      },
    });
  });

  if (emplacements.length) {
    const p = emplacements[0];
    const mecanismes = [...new Set(emplacements.map((e) => e.mecanisme))].join(' et ');
    constats.push(constat({
      regle: 'C-PERSIST-01', axe: 'C', severite: 'majeur', confiance: 'certain',
      titre: `Le widget met en place une persistance qui survit à son retrait (${mecanismes})`,
      fichier: p.fichier, ligne: p.ligne,
      constat: `${emplacements.length} appel(s) détecté(s) enregistrant un(e) ${mecanismes.toLowerCase()}.`,
      impact: "Un Service Worker enregistré continue de s'exécuter et peut intercepter des requêtes réseau même après que l'agent a retiré le widget du document, jusqu'à une désinscription explicite (`unregister()`) que rien ne garantit. La Cache API permet de faire survivre du code ou des données au-delà de la durée de vie affichée du widget, par un canal que l'agent ne pense pas à vider en retirant le widget de son document Grist.",
      remediation: "Documenter dans le README la raison du Service Worker ou du cache, sa portée exacte, et le mécanisme de désinscription. Si l'usage n'est pas indispensable au fonctionnement (par exemple une simple mise en cache d'assets), le retirer : un widget Grist n'a normalement pas besoin de fonctionner hors ligne ni de persister au-delà de la session.",
      referentiels: ['Guide de contribution Grist.Gouv — « no storage of user data outside of Grist »', 'MDN — Service Worker API', 'CWE-459'],
      preuve: { emplacements },
    }));
  }

  return constats;
}

// ---------------------------------------------------------------------------
// C-PM-02 — émission de postMessage sans origine de destination précise
// ---------------------------------------------------------------------------

/**
 * Un relais générique de transport (le `grain-rpc` de `grist-plugin-api.js`,
 * mais aussi tout protocole RPC similaire) prend la forme
 * `(msg) => cible.postMessage(msg, '*')` : le message envoyé est exactement,
 * sans transformation, un paramètre reçu tel quel de la fonction qui
 * l'englobe — cette fonction ne construit ni ne choisit aucune donnée, elle
 * relaie un envelope opaque produit ailleurs. Une fuite réelle, elle,
 * construit ou sélectionne au point d'appel la donnée envoyée (`{secret:
 * x}`, `document.cookie`, une valeur extraite du DOM…) : elle ne se
 * contente jamais de relayer un paramètre reçu tel quel.
 *
 * On reconnaît ce motif plutôt qu'un nom de fichier précis
 * (`grist-plugin-api.js`) : contrairement à une exclusion par chemin, il
 * survit à un renommage, une minification ou un empaquetage dans un plus
 * gros fichier — le cas courant d'une vraie intégration, pas l'exception.
 */
function estRelaisTransparent(argMessage, ancetres) {
  if (argMessage?.type !== 'Identifier') return false;
  for (let i = ancetres.length - 2; i >= 0; i--) {
    const a = ancetres[i];
    if (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression' || a.type === 'FunctionDeclaration') {
      return a.params.some((p) => p.type === 'Identifier' && p.name === argMessage.name);
    }
  }
  return false;
}

/** Pendant, côté émission, de C-PM-01 (qui ne couvre que l'écoute). */
export function analyserEmissionPostMessage(ctx) {
  const constats = [];
  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.ancestor(ast, {
      CallExpression(n, _state, ancetres) {
        const nom = nomPointe(n.callee) || '';
        if (!/(^|\.)postMessage$/.test(nom)) return;
        if (n.arguments.length < 2) return; // pas de targetOrigin renseigné : rien à évaluer ici
        if (chaineLitterale(n.arguments[1]) !== '*') return;
        if (estRelaisTransparent(n.arguments[0], ancetres)) return;

        constats.push(constat({
          regle: 'C-PM-02', axe: 'C', severite: 'majeur', confiance: 'certain',
          titre: "Émission de postMessage avec targetOrigin '*'",
          fichier: unite.chemin, ligne: ligneDe(n),
          extrait: extraireSource(unite.source, n),
          constat: "Un appel `postMessage(message, '*')` envoie le message à n'importe quelle origine, quelle que soit la fenêtre effectivement destinataire.",
          impact: "Si une autre page parvient à s'interposer dans la relation entre le widget et sa fenêtre parente (redirection, cadre imbriqué détourné), elle reçoit le message. Si celui-ci transporte une donnée du document ou un jeton, cette donnée fuit vers un tiers qui a simplement su se placer au bon endroit.",
          remediation: "Remplacer `'*'` par l'origine exacte attendue (celle de l'instance Grist hôte), par exemple `window.parent.postMessage(message, new URL(document.referrer).origin)` après validation de cette origine.",
          referentiels: ['CWE-346', 'OWASP — HTML5 Security Cheat Sheet'],
        }));
      },
    });
  });
  return constats;
}

// ---------------------------------------------------------------------------
// C-CLIP-01 — accès au presse-papiers
// ---------------------------------------------------------------------------

/** Le presse-papiers dépasse le périmètre du document Grist : c'est une donnée de l'appareil, pas du document. */
// Une lecture du presse-papiers derrière un geste explicite de l'agent (clic
// sur un bouton « Coller », touche dédiée) est le cas d'usage recommandé de
// l'API — c'est même sa seule utilisation raisonnable côté widget. Une
// lecture qui ne dépend d'aucune interaction (au chargement, sur une minuterie,
// en réaction à un événement Grist) n'a pas cette excuse : elle peut aspirer
// le presse-papiers sans qu'aucune action de l'agent ne l'ait déclenchée.
const EVENEMENTS_GESTE = /^(click|pointerdown|pointerup|mousedown|mouseup|touchstart|touchend|keydown|keyup)$/i;
const PROPRIETES_GESTE = /^on(click|pointerdown|pointerup|mousedown|mouseup|touchstart|touchend|keydown|keyup)$/i;

function estDansGestionnaireInteraction(ancetres) {
  for (let i = ancetres.length - 2; i >= 0; i--) {
    const a = ancetres[i];
    if (a.type !== 'FunctionExpression' && a.type !== 'ArrowFunctionExpression' && a.type !== 'FunctionDeclaration') continue;
    const parent = ancetres[i - 1];
    if (!parent) return false;
    if (parent.type === 'CallExpression') {
      const nom = nomPointe(parent.callee) || '';
      if (/(^|\.)addEventListener$/.test(nom) && EVENEMENTS_GESTE.test(chaineLitterale(parent.arguments[1]) || chaineLitterale(parent.arguments[0]) || '')) return true;
    }
    if (parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression' && !parent.left.computed
        && PROPRIETES_GESTE.test(parent.left.property.name || '')) return true;
    return false; // la première fonction englobante trouvée tranche la question
  }
  return false;
}

export function analyserPressePapiers(ctx) {
  const constats = [];
  const vus = new Set();

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.ancestor(ast, {
      CallExpression(n, _state, ancetres) {
        const nom = nomPointe(n.callee) || '';
        if (!/(^|\.)clipboard\.(read|readText)$/.test(nom)) return;
        const cle = `${unite.chemin}:${ligneDe(n)}`;
        if (vus.has(cle)) return;
        vus.add(cle);

        const gate = estDansGestionnaireInteraction(ancetres);
        const appel = nom.split('.').slice(-2).join('.');

        constats.push(constat({
          regle: 'C-CLIP-01', axe: 'C',
          severite: gate ? 'mineur' : 'majeur', confiance: gate ? 'probable' : 'certain',
          titre: gate
            ? 'Le widget lit le presse-papiers derrière un geste explicite de l\'agent'
            : 'Le widget lit le presse-papiers sans geste explicite identifiable',
          fichier: unite.chemin, ligne: ligneDe(n),
          extrait: extraireSource(unite.source, n),
          constat: gate
            ? `\`${appel}()\` est appelé depuis un gestionnaire d'événement d'interaction (clic, touche, pointeur) : la forme correspond à un bouton « Coller » ou équivalent.`
            : `\`${appel}()\` donne au widget accès au contenu actuel du presse-papiers du système, sans qu'aucun gestionnaire d'événement d'interaction n'encadre cet appel dans le code environnant.`,
          impact: "Le presse-papiers peut contenir une donnée sans aucun rapport avec le document Grist (mot de passe copié dans un gestionnaire, extrait d'un autre document). Cet accès dépasse donc le périmètre du document que l'agent a autorisé au widget, et touche l'appareil de l'agent plutôt que ses seules données Grist.",
          remediation: gate
            ? "Vérifier que cette lecture reste ponctuelle (déclenchée par l'action, pas répétée en arrière-plan) et documenter-la brièvement dans le README (ex. « bouton Coller »)."
            : "Documenter dans le README pourquoi cette lecture est nécessaire et à quel moment elle se déclenche. Si elle n'est pas liée à une action explicite de l'agent (bouton « Coller » ou équivalent), la restreindre à ce cas.",
          referentiels: ['W3C — Clipboard API and events', 'RGPD art. 5 (minimisation)'],
        }));
      },
    });
  });

  return constats;
}

// ---------------------------------------------------------------------------
// C-EXFIL-05 — chargement de script par création dynamique d'un <script>
// ---------------------------------------------------------------------------

/**
 * `analyserRessourcesExternes` ne lit que les balises `<script src>` déclarées
 * dans le HTML. Un script créé et pointé vers une source distante depuis le
 * JavaScript (`document.createElement('script')` puis `.src = …`) y échappe
 * entièrement, et peut en plus être déclenché tardivement (après un délai, une
 * interaction), hors de la fenêtre d'observation initiale de l'axe D.
 */
export function analyserScriptDynamique(ctx) {
  const constats = [];
  const vus = new Set();

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;

    // nom de variable -> 'script' | 'link'. Un <link> créé dynamiquement
    // (feuille de style, préchargement…) et pointé vers un domaine externe
    // porte le même défaut de traçabilité qu'un <script> — une source lue nulle
    // part dans le HTML statique — par les deux mêmes voies : affectation de
    // propriété (`.src`/`.href`) ou `setAttribute`.
    const variablesElement = new Map();
    walk.ancestor(ast, {
      CallExpression(n, _state, ancetres) {
        const nom = nomPointe(n.callee) || '';
        if (!/(^|\.)createElement$/.test(nom)) return;
        const balise = (chaineLitterale(n.arguments[0]) || '').toLowerCase();
        if (balise !== 'script' && balise !== 'link') return;
        const parent = ancetres[ancetres.length - 2];
        if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') variablesElement.set(parent.id.name, balise);
        if (parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier') variablesElement.set(parent.left.name, balise);
      },
    });
    if (!variablesElement.size) return;

    // Un `integrity` assigné sur le même élément — avant ou après la source,
    // par affectation ou par `setAttribute`, peu importe l'ordre ou la forme
    // — est le même signal d'atténuation que C-EXFIL-03 reconnaît déjà pour
    // une balise statique : la sévérité ne doit pas dépendre du style
    // d'écriture mais de cette propriété de sécurité réelle.
    const variablesAvecIntegrite = new Set();
    walk.simple(ast, {
      AssignmentExpression(n) {
        if (n.left.type !== 'MemberExpression' || n.left.computed) return;
        if (n.left.property.name !== 'integrity') return;
        if (n.left.object.type !== 'Identifier' || !variablesElement.has(n.left.object.name)) return;
        variablesAvecIntegrite.add(n.left.object.name);
      },
      CallExpression(n) {
        if (!/(^|\.)setAttribute$/.test(nomPointe(n.callee) || '')) return;
        if (n.callee.type !== 'MemberExpression' || n.callee.object.type !== 'Identifier') return;
        if (!variablesElement.has(n.callee.object.name)) return;
        if ((chaineLitterale(n.arguments[0]) || '').toLowerCase() !== 'integrity') return;
        variablesAvecIntegrite.add(n.callee.object.name);
      },
    });

    function signaler(noeud, nomVariable, valeurNoeud) {
      const type = variablesElement.get(nomVariable);
      const nomBalise = type === 'script' ? '<script>' : '<link>';
      const attribut = type === 'script' ? 'src' : 'href';

      const valeur = chaineLitterale(valeurNoeud);
      const dynamique = estDynamique(valeurNoeud);
      const h = hote(valeur ?? '');
      if (!dynamique && (estLocal(h) || estGrist(h))) return;

      const cle = `${unite.chemin}:${ligneDe(noeud)}:${nomVariable}`;
      if (vus.has(cle)) return;
      vus.add(cle);
      if (!dynamique) enregistrerDestination(ctx, h);

      const protege = !dynamique && variablesAvecIntegrite.has(nomVariable);
      // Un <script> injecté exécute du code avec tous les privilèges du widget ;
      // un <link> externe n'atteint « que » l'exfiltration par sélecteurs CSS ou
      // un contenu non garanti d'une visite à l'autre — un risque réel mais
      // d'une autre nature, donc un cran de sévérité en dessous, jamais bloquant.
      const severite = type === 'script' ? (dynamique ? 'majeur' : 'critique') : (dynamique ? 'mineur' : 'majeur');
      const bloquant = type === 'script' && !dynamique && !protege;

      constats.push(constat({
        regle: 'C-EXFIL-05', axe: 'C', severite, bloquant,
        confiance: dynamique ? 'a_verifier' : 'certain',
        titre: dynamique
          ? `Élément ${nomBalise} créé dynamiquement, avec un ${attribut} calculé à l'exécution`
          : `Élément ${nomBalise} créé dynamiquement et pointé vers un service externe : ${h}${protege ? ' (intégrité vérifiée)' : ''}`,
        fichier: unite.chemin, ligne: ligneDe(noeud),
        extrait: extraireSource(unite.source, noeud),
        constat: dynamique
          ? `Le code crée un élément \`${nomBalise}\` par \`createElement('${type}')\` puis lui donne un ${attribut} construit à l'exécution (affectation ou \`setAttribute\`) : la lecture du code seule ne permet pas de savoir quelle ressource sera réellement chargée.`
          : `Le code crée un élément \`${nomBalise}\` par \`createElement('${type}')\` et l'attache à \`${h}\`, un service extérieur à l'instance Grist${protege ? ', avec un attribut `integrity` assigné sur le même élément' : " sans contrôle d'intégrité (`integrity`)"}.`,
        impact: type === 'script'
          ? "Un script inséré de cette façon échappe à l'analyse statique du HTML (qui ne lit que les balises `<script src>` déjà présentes dans le document), et peut être déclenché après un délai ou une interaction de l'agent, hors de la fenêtre d'observation d'un audit ponctuel. Une fois exécuté, ce script a tous les privilèges du widget, donc l'accès que l'agent lui a accordé au document."
          : "Une feuille de style ou une ressource préchargée insérée de cette façon échappe à l'analyse statique du HTML : elle peut exfiltrer des données affichées via des sélecteurs d'attribut CSS, ou changer de contenu d'une visite à l'autre sans qu'aucune revue ne le revoie.",
        remediation: dynamique
          ? `Restreindre ${attribut} à une liste blanche de constantes, et documenter dans le README la liste exhaustive des ressources chargées dynamiquement.`
          : protege
            ? `Ce chargement vérifie déjà l'intégrité de la ressource récupérée depuis \`${h}\` : il suffit de documenter ce choix dans le README.`
            : `Ajouter un attribut \`integrity\` (et \`crossorigin\`) sur l'élément avant de l'attacher au document, ou déclarer cette ressource directement dans le HTML, ou documenter dans le README pourquoi le chargement dynamique vers \`${h}\` est nécessaire.`,
        referentiels: [REF_GUIDE, 'OWASP Top 10 A08:2021 — Intégrité logicielle', 'CWE-829'],
      }));
    }

    walk.simple(ast, {
      AssignmentExpression(n) {
        if (n.left.type !== 'MemberExpression' || n.left.computed) return;
        if (n.left.object.type !== 'Identifier') return;
        const type = variablesElement.get(n.left.object.name);
        if (!type) return;
        if (n.left.property.name !== (type === 'script' ? 'src' : 'href')) return;
        signaler(n, n.left.object.name, n.right);
      },
      CallExpression(n) {
        if (!/(^|\.)setAttribute$/.test(nomPointe(n.callee) || '')) return;
        if (n.callee.type !== 'MemberExpression' || n.callee.object.type !== 'Identifier') return;
        const type = variablesElement.get(n.callee.object.name);
        if (!type) return;
        if ((chaineLitterale(n.arguments[0]) || '').toLowerCase() !== (type === 'script' ? 'src' : 'href')) return;
        signaler(n, n.callee.object.name, n.arguments[1]);
      },
    });
  });

  return constats;
}

// ---------------------------------------------------------------------------
// C-EXFIL-06 — import() dont la source est calculée à l'exécution
// ---------------------------------------------------------------------------

/**
 * `analyserSortiesReseau` (C-EXFIL-01) ne signale un `import()` que si sa
 * source est un littéral distant : un `import()` dont la source est calculée
 * (concaténation, variable, template avec expression) n'est actuellement
 * signalé par aucune règle — contrairement à `fetch()`/XHR/WebSocket, qui ont
 * chacun leur variante « source calculée ». C'est précisément le chargement
 * différé (déclenché après un délai ou une interaction) que la méthodologie
 * identifie comme hors de la fenêtre d'observation d'un audit ponctuel.
 */
/**
 * `import(`./chemin/${variable}.js`)` — un template littéral dont la partie
 * fixe commence par `./` ou `../` et dont aucun segment fixe ne contient
 * `http(s):` ni `//` — est le découpage de code recommandé par les bundlers
 * (webpack, Vite) pour le chargement à la demande : le chemin est local par
 * construction, seul le nom de fichier varie. Ne s'applique qu'aux
 * `TemplateLiteral` : une source `Identifier`/`CallExpression` ne porte
 * aucune partie littérale sur laquelle raisonner et reste signalée.
 */
function indiceLocalCertain(noeud) {
  if (noeud.type !== 'TemplateLiteral') return false;
  const premier = noeud.quasis[0]?.value.cooked ?? '';
  if (!/^\.\.?\//.test(premier)) return false;
  const texteFixe = noeud.quasis.map((q) => q.value.cooked ?? '').join('');
  return !/https?:|\/\//i.test(texteFixe);
}

export function analyserImportDynamique(ctx) {
  const constats = [];
  const vus = new Set();

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      ImportExpression(n) {
        if (chaineLitterale(n.source) !== null) return;         // littéral : déjà couvert par C-EXFIL-01
        if (!estDynamique(n.source)) return;                     // ni littéral ni dynamique reconnu (rare) : rien à affirmer
        if (indiceLocalCertain(n.source)) return;                // découpage de code local recommandé : pas un signal

        const cle = `${unite.chemin}:${ligneDe(n)}`;
        if (vus.has(cle)) return;
        vus.add(cle);

        constats.push(constat({
          regle: 'C-EXFIL-06', axe: 'C', severite: 'majeur', confiance: 'a_verifier',
          titre: "import() dynamique dont la source est calculée à l'exécution",
          fichier: unite.chemin, ligne: ligneDe(n),
          extrait: extraireSource(unite.source, n),
          constat: "Le code appelle `import(...)` avec une source construite à l'exécution (variable, concaténation) plutôt qu'un chemin littéral : la lecture du code seule ne permet pas de savoir quel module sera réellement chargé, ni depuis où.",
          impact: "Un module chargé de cette façon peut être différé (après un délai, une interaction de l'agent) au-delà de la fenêtre d'observation d'un audit ponctuel, et échappe à toute vérification d'intégrité statique. Une fois exécuté, il a tous les privilèges du widget.",
          remediation: "Restreindre la source à une liste blanche de constantes littérales, et documenter dans le README la liste exhaustive des modules chargés dynamiquement et les conditions de leur chargement.",
          referentiels: [REF_GUIDE, 'OWASP Top 10 A08:2021 — Intégrité logicielle', 'CWE-829'],
        }));
      },
    });
  });

  return constats;
}

// ---------------------------------------------------------------------------
// Utilitaires locaux
// ---------------------------------------------------------------------------

// Les sauts de ligne d'un contenu, calculés une fois : `contenu.slice(0, index).split('\n')` recopiait tout le début du fichier à chaque constat (40 000 références dans un `.css` de 2 Mio : 26 s).
const SAUTS_DE_LIGNE = new Map();
const TAILLE_SAUTS = 8;

/** Le numéro (à partir de 1) de la ligne qui porte le caractère `index` de `contenu`. */
export function numeroLigne(contenu, index) {
  let sauts = SAUTS_DE_LIGNE.get(contenu);
  if (!sauts) {
    sauts = [];
    for (let i = contenu.indexOf('\n'); i !== -1; i = contenu.indexOf('\n', i + 1)) sauts.push(i);
    if (SAUTS_DE_LIGNE.size >= TAILLE_SAUTS) SAUTS_DE_LIGNE.clear();
    SAUTS_DE_LIGNE.set(contenu, sauts);
  }
  let a = 0;
  let b = sauts.length;
  while (a < b) {
    const milieu = (a + b) >> 1;
    if (sauts[milieu] < index) a = milieu + 1;
    else b = milieu;
  }
  return a + 1;
}

/**
 * Le fragment de `contenu` autour de `decalage` (60 caractères avant, 236 après, sans sortir de la ligne, un `…` là où
 * la ligne continue : le tout tient dans les 300 caractères d'un `extrait`) : jamais la ligne entière, qui tient sur
 * plusieurs Mio dans une feuille minifiée et ne montrerait pas la référence.
 */
export function extraitAutour(contenu, decalage) {
  const debut = Math.max(0, decalage - 60);
  const fin = Math.min(contenu.length, decalage + 236);
  const fenetre = contenu.slice(debut, fin);
  const relatif = decalage - debut;
  const saut = fenetre.lastIndexOf('\n', relatif - 1);
  const suite = fenetre.indexOf('\n', relatif);
  const a = saut + 1;
  const b = suite === -1 ? fenetre.length : fenetre[suite - 1] === '\r' ? suite - 1 : suite;
  return `${saut === -1 && debut > 0 ? '…' : ''}${fenetre.slice(a, b)}${suite === -1 && fin < contenu.length ? '…' : ''}`;
}

function extraireSource(source, noeud) {
  if (!noeud || noeud.start == null) return '';
  return source.slice(noeud.start, Math.min(noeud.end, noeud.start + 600));
}
function masquer(s) {
  const t = String(s);
  return t.length <= 12 ? '***' : `${t.slice(0, 6)}…${t.slice(-4)} (${t.length} caractères)`;
}

export const reglesC = [
  // En tête : matérialise tout code littéral fourni en chaîne (eval,
  // Function, setTimeout/setInterval, Worker) comme des fichiers de plus de
  // `ctx.fichiers`, AVANT `analyserAccesGrist` — pour que les règles qui
  // portent sur le widget entier (C-GRIST) ou qui consultent d'autres
  // fichiers (C-STOCK-01 et le README) le voient comme n'importe quel autre
  // fichier du dépôt, sans angle mort ni traitement spécial.
  preparerCodeExecuteEnChaine,
  analyserAccesGrist, analyserSortiesReseau, analyserRessourcesExternes,
  analyserInjections, analyserHtmlDangereux, analyserCspPermissive, analyserPostMessage,
  analyserStockage, analyserSecrets, analyserAlea,
  analyserEmpreinteAutomatisation, analyserPersistanceHorsWidget,
  analyserEmissionPostMessage, analyserPressePapiers, analyserScriptDynamique,
  analyserImportDynamique,
];
