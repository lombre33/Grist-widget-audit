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
import { constat } from '../moteur/modele.js';
import { pourChaqueUniteJs, nomPointe, chaineLitterale, estDynamique } from '../moteur/analyse-js.js';

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

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    const signaler = (n, canal, cible, dynamique) => {
      const h = hote(cible);
      if (estLocal(h) && !dynamique) return;                 // requête sur soi-même
      if (estGrist(h)) return;                               // API Grist : hors périmètre de ce constat
      const cle = `${unite.chemin}:${ligneDe(n)}:${canal}`;
      if (vus.has(cle)) return;
      vus.add(cle);
      if (!dynamique) enregistrerDestination(ctx, h);

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
          : `Le widget émet une requête ${canal} vers \`${h}\`, un service extérieur à l'instance Grist.`,
        impact: "Le widget a accès aux données du document. Toute requête sortante est un canal de sortie possible pour ces données, y compris à l'insu de l'agent. C'est le point qu'un RSSI regarde en premier, et le guide de contribution l'interdit explicitement pour les services non documentés.",
        remediation: dynamique
          ? "Restreindre la destination à une liste blanche de constantes, et documenter dans le README la liste exhaustive des hôtes appelés. L'axe D capture le trafic réellement émis et confirmera ou lèvera ce constat."
          : `Supprimer l'appel, ou documenter dans le README ce qui est envoyé à \`${h}\`, pourquoi, et sur quelle base juridique (RGPD) si des données personnelles transitent. Un hébergement sur instance officielle suppose une validation explicite de ce flux.`,
        referentiels: [REF_GUIDE, 'RGPD art. 5 (minimisation)', 'OWASP Top 10 A10:2021 — SSRF / flux sortants'],
      }));
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
        if (/importScripts$/.test(nom)) signaler(n, 'importScripts()', chaineLitterale(n.arguments[0]) ?? '(URL calculée)', estDynamique(n.arguments[0]));
      },
      NewExpression(n) {
        const nom = nomPointe(n.callee) || '';
        if (/^(WebSocket|EventSource)$/.test(nom)) {
          signaler(n, nom, chaineLitterale(n.arguments[0]) ?? '(URL calculée)', estDynamique(n.arguments[0]));
        }
      },
      ImportExpression(n) {
        const v = chaineLitterale(n.source);
        if (v && /^https?:/i.test(v)) signaler(n, 'import() distant', v, false);
      },
    });
  });

  return constats;
}

/** Ressources externes déclarées dans le HTML et le CSS. */
export function analyserRessourcesExternes(ctx) {
  const constats = [];
  for (const f of ctx.fichiers) {
    if (!f.executee || f.binaire) continue;
    if (!['.html', '.htm', '.css'].includes(f.ext)) continue;

    const motifs = [
      [/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, 'script', 'critique'],
      [/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, 'feuille de style ou préchargement', 'majeur'],
      [/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, 'iframe', 'majeur'],
      [/<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi, 'image', 'mineur'],
      [/@import\s+(?:url\()?["']?(https?:\/\/[^"')]+)/gi, '@import CSS', 'majeur'],
      [/url\(\s*["']?(https?:\/\/[^"')]+)/gi, 'ressource CSS', 'mineur'],
    ];

    for (const [re, type, severiteBase] of motifs) {
      for (const m of f.contenu.matchAll(re)) {
        const url = m[1];
        const h = hote(url);
        if (estLocal(h)) continue;
        const balise = m[0];
        const gristPlugin = estGrist(h) && /grist-plugin-api\.js/.test(url);

        if (gristPlugin) {
          // Cas très fréquent et spécifique : charger l'API Grist depuis
          // docs.getgrist.com plutôt que depuis l'instance qui héberge le widget.
          constats.push(constat({
            regle: 'C-EXFIL-04', axe: 'C', severite: 'majeur', confiance: 'certain',
            titre: "L'API Grist est chargée depuis un domaine externe au lieu de l'instance hôte",
            fichier: f.chemin, ligne: numeroLigne(f.contenu, m.index), extrait: balise,
            constat: `\`grist-plugin-api.js\` est chargé depuis \`${h}\`.`,
            impact: "Le widget hébergé sur une instance souveraine (grist.numerique.gouv.fr) va chercher son script pivot sur un domaine tiers. Cela crée une dépendance de disponibilité et de confiance envers ce domaine, envoie l'adresse IP de chaque agent à un tiers, et casse le widget si l'instance applique une CSP stricte ou fonctionne en réseau fermé.",
            remediation: "Charger l'API en relatif : `<script src=\"/grist-plugin-api.js\"></script>`. L'instance qui sert le widget sert aussi l'API ; c'est la forme attendue pour un hébergement sur instance officielle.",
            referentiels: [REF_GUIDE, 'Souveraineté numérique — DINUM'],
          }));
          continue;
        }

        if (estGrist(h)) continue;
        enregistrerDestination(ctx, h);

        const sri = /\bintegrity\s*=/.test(balise);
        constats.push(constat({
          regle: 'C-EXFIL-03', axe: 'C',
          severite: type === 'script' && !sri ? 'critique' : severiteBase,
          bloquant: type === 'script' && !sri,
          confiance: 'certain',
          titre: `Ressource externe chargée depuis ${h} (${type})`,
          fichier: f.chemin, ligne: numeroLigne(f.contenu, m.index), extrait: balise,
          constat: `Le widget charge une ${type} depuis \`${h}\`${sri ? ' (avec attribut `integrity`)' : ' sans contrôle d\'intégrité (`integrity`)'}.`,
          impact: type === 'script'
            ? "Un script tiers s'exécute avec tous les privilèges du widget, donc avec l'accès que l'agent a accordé au document. Si ce domaine est compromis ou remplacé, le document entier l'est aussi. C'est le scénario type d'attaque par la chaîne d'approvisionnement."
            : "La ressource est récupérée sur un domaine tiers à chaque affichage : l'adresse IP et l'horodatage de chaque agent sont transmis à ce tiers, et la disponibilité du widget dépend de lui.",
          remediation: "Héberger la ressource dans le dépôt du widget (vendoring) et la servir en relatif. Si le chargement distant est réellement nécessaire, ajouter `integrity` et `crossorigin`, et documenter le domaine dans le README.",
          referentiels: [REF_ANSSI, 'OWASP Top 10 A08:2021 — Intégrité logicielle', REF_GUIDE],
        }));
      }
    }
  }
  return constats;
}

// ---------------------------------------------------------------------------
// C-XSS — injection dans le DOM et exécution dynamique
// ---------------------------------------------------------------------------

const SINKS_HTML = /(innerHTML|outerHTML|insertAdjacentHTML|srcdoc)$/;

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

        if (/(^|\.)eval$/.test(nom)) {
          constats.push(constat({
            regle: 'C-XSS-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
            titre: 'Exécution de code arbitraire via eval()',
            fichier: unite.chemin, ligne: ligneDe(n), extrait: extraireSource(unite.source, n),
            constat: '`eval()` est appelé dans le code exécuté du widget.',
            impact: "Toute donnée qui atteint cet appel devient du code exécuté avec l'accès du widget au document. C'est rédhibitoire pour un hébergement sur instance officielle, et cela empêche toute politique de sécurité de contenu stricte.",
            remediation: "Supprimer l'appel. Pour interpréter des données, utiliser `JSON.parse` ; pour une logique configurable, un interpréteur restreint écrit explicitement.",
            referentiels: ['CWE-95', REF_ANSSI, 'OWASP Top 10 A03:2021'],
          }));
        }

        if (/^(setTimeout|setInterval)$/.test(nom.split('.').pop()) && n.arguments[0] &&
            (n.arguments[0].type === 'Literal' || n.arguments[0].type === 'TemplateLiteral' ||
             (n.arguments[0].type === 'BinaryExpression'))) {
          constats.push(constat({
            regle: 'C-XSS-04', axe: 'C', severite: 'majeur', confiance: 'certain',
            titre: `Chaîne de caractères passée à ${nom} (équivalent à eval)`,
            fichier: unite.chemin, ligne: ligneDe(n),
            constat: `Le premier argument de \`${nom}\` est une chaîne, pas une fonction.`,
            impact: 'Le moteur évalue cette chaîne comme du code, avec les mêmes conséquences que `eval()`.',
            remediation: 'Passer une fonction : `setTimeout(() => …, delai)`.',
            referentiels: ['CWE-95'],
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
      NewExpression(n) {
        if ((nomPointe(n.callee) || '').split('.').pop() === 'Function') {
          constats.push(constat({
            regle: 'C-XSS-03', axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
            titre: 'Construction de code à la volée via new Function()',
            fichier: unite.chemin, ligne: ligneDe(n),
            constat: '`new Function(...)` compile une chaîne en fonction exécutable.',
            impact: "Équivalent fonctionnel d'`eval()` : exécution de code arbitraire avec l'accès du widget au document.",
            remediation: "Supprimer cet usage.",
            referentiels: ['CWE-95', REF_ANSSI],
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

/** Gestionnaires d'événements inline et attributs dangereux dans le HTML. */
export function analyserHtmlDangereux(ctx) {
  const constats = [];
  for (const f of ctx.fichiers) {
    if (!f.executee || f.binaire || !['.html', '.htm'].includes(f.ext)) continue;

    for (const m of f.contenu.matchAll(/<a\b[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi)) {
      if (/\brel\s*=\s*["'][^"']*noopener/i.test(m[0])) continue;
      constats.push(constat({
        regle: 'C-DOM-01', axe: 'C', severite: 'mineur', confiance: 'certain',
        titre: 'Lien ouvrant un nouvel onglet sans rel="noopener"',
        fichier: f.chemin, ligne: numeroLigne(f.contenu, m.index), extrait: m[0],
        constat: 'Un lien `target="_blank"` ne porte pas `rel="noopener noreferrer"`.',
        impact: "La page ouverte obtient une référence `window.opener` vers le widget et peut le rediriger (détournement d'onglet).",
        remediation: 'Ajouter `rel="noopener noreferrer"`.',
        referentiels: ['OWASP — Reverse tabnabbing'],
      }));
    }

    for (const m of f.contenu.matchAll(/<iframe\b[^>]*>/gi)) {
      if (/\bsandbox\s*=/.test(m[0])) continue;
      constats.push(constat({
        regle: 'C-DOM-02', axe: 'C', severite: 'majeur', confiance: 'certain',
        titre: 'Iframe imbriquée sans attribut sandbox',
        fichier: f.chemin, ligne: numeroLigne(f.contenu, m.index), extrait: m[0],
        constat: 'Le widget insère une iframe sans restreindre ses capacités.',
        impact: "Le contenu embarqué s'exécute sans confinement supplémentaire à l'intérieur du widget.",
        remediation: 'Ajouter `sandbox` avec le minimum de permissions nécessaires.',
        referentiels: [REF_ANSSI],
      }));
    }

    const entree = ctx.entrees.includes(f.chemin);
    if (entree && !/<meta[^>]+http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(f.contenu)) {
      constats.push(constat({
        regle: 'C-CSP-01', axe: 'C', severite: 'mineur', confiance: 'certain',
        titre: 'Aucune politique de sécurité de contenu (CSP) déclarée',
        fichier: f.chemin,
        constat: "Le point d'entrée ne déclare pas de balise `<meta http-equiv=\"Content-Security-Policy\">`.",
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
    const balise = f.contenu.match(/<meta[^>]+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i);
    if (!balise) continue; // absence déjà couverte par C-CSP-01
    // Une valeur de CSP légitime contient elle-même des apostrophes ('self',
    // 'unsafe-inline'…) : une classe de caractères `[^"']` s'arrêterait à la
    // première d'entre elles. On capture donc jusqu'à la même citation que
    // celle qui a ouvert l'attribut, par rétro-référence.
    const contenuAttr = balise[0].match(/\bcontent\s*=\s*(["'])((?:(?!\1).)*)\1/i);
    if (!contenuAttr) continue;

    const directives = {};
    for (const part of contenuAttr[2].split(';')) {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (tokens.length) directives[tokens[0].toLowerCase()] = tokens.slice(1);
    }
    const directiveEffective = directives['script-src'] ? 'script-src' : 'default-src';
    const valeurs = directives[directiveEffective];
    if (!valeurs) continue;

    const ligne = numeroLigne(f.contenu, balise.index);
    if (valeurs.includes('*')) {
      constats.push(constat({
        regle: 'C-CSP-02', axe: 'C', severite: 'mineur', confiance: 'certain',
        titre: 'La CSP déclarée autorise un joker non qualifié',
        fichier: f.chemin, ligne, extrait: balise[0],
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
        fichier: f.chemin, ligne, extrait: balise[0],
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
    const mecanismes = [...new Set(emplacements.map((e) => e.mecanisme))].join(', ');
    const cles = [...new Set(emplacements.map((e) => e.cle).filter(Boolean))];
    constats.push(constat({
      regle: 'C-STOCK-01', axe: 'C', severite: 'majeur', confiance: 'certain',
      titre: `Données conservées hors de Grist (${mecanismes})`,
      fichier: p.fichier, ligne: p.ligne,
      constat: `${emplacements.length} écriture(s) de stockage persistant détectée(s)${cles.length ? ` — clés : ${cles.slice(0, 8).join(', ')}` : ''}.`,
      impact: "Le guide de contribution demande qu'aucune donnée utilisateur ne soit stockée hors de Grist. Les données écrites ici survivent à la fermeture du document, échappent aux droits d'accès Grist, ne sont pas couvertes par les sauvegardes, et ne disparaissent pas quand l'agent perd l'accès au document. Si elles contiennent des données personnelles, cela constitue un traitement non déclaré.",
      remediation: "Distinguer les deux cas. Préférences d'affichage (thème, colonne triée) : acceptable, à documenter dans le README. Contenu issu du document : à replacer dans une table Grist, ou à ne pas persister du tout.",
      referentiels: ['Guide de contribution Grist.Gouv — « no storage of user data outside of Grist »', 'RGPD art. 5'],
      preuve: { emplacements },
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

/** Pendant, côté émission, de C-PM-01 (qui ne couvre que l'écoute). */
export function analyserEmissionPostMessage(ctx) {
  const constats = [];
  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      CallExpression(n) {
        const nom = nomPointe(n.callee) || '';
        if (!/(^|\.)postMessage$/.test(nom)) return;
        if (n.arguments.length < 2) return; // pas de targetOrigin renseigné : rien à évaluer ici
        if (chaineLitterale(n.arguments[1]) !== '*') return;

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
export function analyserPressePapiers(ctx) {
  const constats = [];
  const vus = new Set();

  pourChaqueUniteJs(ctx, { surfaceSeulement: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      CallExpression(n) {
        const nom = nomPointe(n.callee) || '';
        if (!/(^|\.)clipboard\.(read|readText)$/.test(nom)) return;
        const cle = `${unite.chemin}:${ligneDe(n)}`;
        if (vus.has(cle)) return;
        vus.add(cle);

        constats.push(constat({
          regle: 'C-CLIP-01', axe: 'C', severite: 'majeur', confiance: 'certain',
          titre: 'Le widget lit le contenu du presse-papiers',
          fichier: unite.chemin, ligne: ligneDe(n),
          extrait: extraireSource(unite.source, n),
          constat: `\`${nom.split('.').slice(-2).join('.')}()\` donne au widget accès au contenu actuel du presse-papiers du système.`,
          impact: "Le presse-papiers peut contenir une donnée sans aucun rapport avec le document Grist (mot de passe copié dans un gestionnaire, extrait d'un autre document). Cet accès dépasse donc le périmètre du document que l'agent a autorisé au widget, et touche l'appareil de l'agent plutôt que ses seules données Grist.",
          remediation: "Documenter dans le README pourquoi cette lecture est nécessaire et à quel moment elle se déclenche (normalement suite à une action explicite de l'agent, par exemple un bouton « Coller »). Si elle n'est pas indispensable, la retirer.",
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

    const variablesScript = new Set();
    walk.ancestor(ast, {
      CallExpression(n, _state, ancetres) {
        const nom = nomPointe(n.callee) || '';
        if (!/(^|\.)createElement$/.test(nom)) return;
        if ((chaineLitterale(n.arguments[0]) || '').toLowerCase() !== 'script') return;
        const parent = ancetres[ancetres.length - 2];
        if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') variablesScript.add(parent.id.name);
        if (parent?.type === 'AssignmentExpression' && parent.left.type === 'Identifier') variablesScript.add(parent.left.name);
      },
    });
    if (!variablesScript.size) return;

    walk.simple(ast, {
      AssignmentExpression(n) {
        if (n.left.type !== 'MemberExpression' || n.left.computed) return;
        if (n.left.property.name !== 'src') return;
        if (n.left.object.type !== 'Identifier' || !variablesScript.has(n.left.object.name)) return;

        const valeur = chaineLitterale(n.right);
        const dynamique = estDynamique(n.right);
        const h = hote(valeur ?? '');
        if (!dynamique && (estLocal(h) || estGrist(h))) return;

        const cle = `${unite.chemin}:${ligneDe(n)}`;
        if (vus.has(cle)) return;
        vus.add(cle);
        if (!dynamique) enregistrerDestination(ctx, h);

        constats.push(constat({
          regle: 'C-EXFIL-05', axe: 'C', severite: dynamique ? 'majeur' : 'critique', bloquant: !dynamique,
          confiance: dynamique ? 'a_verifier' : 'certain',
          titre: dynamique
            ? "Élément <script> créé dynamiquement, avec une source calculée à l'exécution"
            : `Élément <script> créé dynamiquement et pointé vers un service externe : ${h}`,
          fichier: unite.chemin, ligne: ligneDe(n),
          extrait: extraireSource(unite.source, n),
          constat: dynamique
            ? "Le code crée un élément `<script>` par `createElement('script')` puis lui assigne une source construite à l'exécution : la lecture du code seule ne permet pas de savoir quel script sera réellement chargé."
            : `Le code crée un élément \`<script>\` par \`createElement('script')\` et l'attache à \`${h}\`, un service extérieur à l'instance Grist.`,
          impact: "Un script inséré de cette façon échappe à l'analyse statique du HTML (qui ne lit que les balises `<script src>` déjà présentes dans le document), et peut être déclenché après un délai ou une interaction de l'agent, hors de la fenêtre d'observation d'un audit ponctuel. Une fois exécuté, ce script a tous les privilèges du widget, donc l'accès que l'agent lui a accordé au document.",
          remediation: dynamique
            ? "Restreindre la source à une liste blanche de constantes, et documenter dans le README la liste exhaustive des scripts chargés dynamiquement."
            : `Déclarer ce script directement dans le HTML (\`<script src="…" integrity="…">\`) plutôt que de le créer par JavaScript, ou documenter dans le README pourquoi le chargement dynamique vers \`${h}\` est nécessaire.`,
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

function numeroLigne(contenu, index) {
  return contenu.slice(0, index).split('\n').length;
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
  analyserAccesGrist, analyserSortiesReseau, analyserRessourcesExternes,
  analyserInjections, analyserHtmlDangereux, analyserCspPermissive, analyserPostMessage,
  analyserStockage, analyserSecrets, analyserAlea,
  analyserEmpreinteAutomatisation, analyserPersistanceHorsWidget,
  analyserEmissionPostMessage, analyserPressePapiers, analyserScriptDynamique,
];
