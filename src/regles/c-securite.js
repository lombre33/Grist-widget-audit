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
import { constat } from '../moteur/modele.js';
import { pourChaqueUniteJs, nomPointe, chaineLitterale, estDynamique, extraireImportMaps, parser } from '../moteur/analyse-js.js';

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
      // `cible` fait partie de la clé : `importScripts('./a.js', 'https://x')`
      // signale les deux arguments sur le même nœud, avec le même `canal` —
      // sans elle, le second argument serait pris pour un doublon du premier.
      const cle = `${unite.chemin}:${ligneDe(n)}:${canal}:${cible}`;
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
      [/<object\b[^>]*\bdata\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi, 'objet (<object>)', 'mineur'],
      [/<embed\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi, 'contenu embarqué (<embed>)', 'mineur'],
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

    // Import map (<script type="importmap">) : le contenu est du JSON, jamais
    // exécuté (voir `unitesJs`), donc invisible aux motifs ci-dessus comme à
    // toute règle qui lit du JS. Une bibliothèque résolue par un import nu
    // après une entrée d'import map est chargée à l'exécution comme un
    // <script src>, avec la même exigence d'intégrité — les import maps
    // prévoient une clé `integrity` de premier niveau à cet effet (WHATWG).
    for (const e of extraireImportMaps(f.contenu)) {
      const h = hote(e.url);
      if (estLocal(h) || estGrist(h)) continue;
      enregistrerDestination(ctx, h);
      constats.push(constat({
        regle: 'C-EXFIL-03', axe: 'C',
        severite: e.sri ? 'majeur' : 'critique', bloquant: !e.sri,
        confiance: 'certain',
        titre: `Import map : dépendance chargée depuis ${h} (${e.spec})`,
        fichier: f.chemin, ligne: numeroLigne(f.contenu, e.index), extrait: `"${e.spec}": "${e.url}"`,
        constat: `L'import map fait résoudre \`${e.spec}\` vers \`${e.url}\`${e.sri ? " (couverte par la clé `integrity` de l'import map)" : ' sans entrée `integrity`'}.`,
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
      const morceaux = blob.arguments[0].elements.map((el) => plierLitteraux(el));
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

/**
 * Cherche, du site d'appel vers l'extérieur, la portée la plus proche qui
 * lie `nom` : un paramètre de fonction (y compris déstructuré/par défaut),
 * un paramètre de `catch`, la variable d'un `for`/`for…of`/`for…in`, une
 * déclaration `function`/`const`/`let`/`var` d'un bloc ou du programme.
 * Une seule marche d'ancêtres pour tous les cas : la portée JS veut que la
 * plus proche masque tout le reste, quelle que soit sa nature (un paramètre
 * masque une fonction homonyme du fichier, une variable de bloc masque à
 * son tour un paramètre plus extérieur) — les traiter séparément avait
 * laissé passer un paramètre déstructuré/par défaut/de catch, ou une
 * variable locale homonyme d'une fonction du fichier (c-securite.js:522
 * avant cette révision ne voyait que les paramètres `Identifier` et
 * ignorait les portées de bloc et de `var`), relevé par la coordination le
 * 2026-09-28. `ancetres` vient de `walk.ancestor` sur le site d'appel (le
 * nœud lui-même en dernier élément).
 *
 * Retourne `null` si aucune portée visible ne lie ce nom (probablement une
 * globale, ou une déclaration d'une autre unité) ; sinon l'une des formes :
 *   - `{type:'parametre', fonction, index, parent}` : paramètre positionnel
 *     simple d'une fonction — seul cas où la valeur peut être prouvée (un
 *     exécuteur de Promise, voir `estExecuteurPromise`) ;
 *   - `{type:'fonction-nommee', fonction}` : `function nom() {}` ;
 *   - `{type:'variable', kind, declarateur}` : `const`/`let`/`var nom = …` ;
 *   - `{type:'autre'}` : une liaison existe à ce niveau (paramètre
 *     déstructuré/par défaut, catch, boucle, variable déstructurée) mais
 *     n'est jamais résolvable — la recherche s'arrête ici sans continuer
 *     vers l'extérieur.
 */
function trouverLiaisonVisible(nom, ancetres) {
  for (let i = ancetres.length - 2; i >= 0; i--) {
    const n = ancetres[i];
    if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') {
      for (let idx = 0; idx < n.params.length; idx++) {
        const p = n.params[idx];
        if (p.type === 'Identifier' && p.name === nom) return { type: 'parametre', fonction: n, index: idx, parent: ancetres[i - 1] ?? null };
        if (nomsLies(p).includes(nom)) return { type: 'autre' };
      }
    }
    if (n.type === 'CatchClause' && n.param && nomsLies(n.param).includes(nom)) return { type: 'autre' };
    if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement' || n.type === 'ForStatement') && n.left?.type === 'VariableDeclaration') {
      for (const d of n.left.declarations) if (nomsLies(d.id).includes(nom)) return { type: 'autre' }; // change à chaque itération : jamais un littéral fiable
    }
    if (n.type === 'BlockStatement' || n.type === 'Program') {
      for (const stmt of n.body) {
        if (stmt.type === 'FunctionDeclaration' && stmt.id?.name === nom) return { type: 'fonction-nommee', fonction: stmt };
        if (stmt.type !== 'VariableDeclaration') continue;
        for (const d of stmt.declarations) {
          if (d.id.type === 'Identifier' && d.id.name === nom) return { type: 'variable', kind: stmt.kind, declarateur: d };
          if (nomsLies(d.id).includes(nom)) return { type: 'autre' };
        }
      }
    }
  }
  return null;
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
 * Vrai si `nom` est réaffecté n'importe où dans `ast` : une affectation
 * directe ou composée (`nom = …`, `nom += …`), ou une mise à jour
 * (`nom++`). Une variable ou un paramètre réaffecté ne peut plus être
 * résolu de façon fiable vers sa valeur d'origine : elle peut avoir changé
 * entre la déclaration (ou le début de la fonction) et le site d'appel.
 * Recherche volontairement non bornée à la portée trouvée : plus
 * grossière, mais jamais moins sûre (un homonyme réaffecté ailleurs ne
 * peut, au pire, que faire traiter comme « inconnue » une liaison qui
 * aurait pu être résolue — jamais l'inverse). Relevé par la coordination le
 * 2026-09-28 : `let code = 'void 0'; code = r.Formule; eval(code)` restait
 * pris pour le littéral `'void 0'` sans ce garde-fou (axe D réel : NON
 * CONFORME 75 → CONFORME 89, alors qu'`eval(r.Formule)` en clair est NON
 * CONFORME 72).
 */
function estReaffecte(nom, ast, walkAcorn) {
  let trouve = false;
  walkAcorn.simple(ast, {
    AssignmentExpression(n) { if (n.left.type === 'Identifier' && n.left.name === nom) trouve = true; },
    UpdateExpression(n) { if (n.argument.type === 'Identifier' && n.argument.name === nom) trouve = true; },
  });
  return trouve;
}

/**
 * `estReaffecte`, complété par un compte des déclarations : une seconde
 * déclaration du même nom ailleurs dans le fichier (`var code = "<a>"; …;
 * var code = "1";`) équivaut, pour ce qui nous occupe, à une réaffectation
 * — la valeur lue à l'exécution n'est pas forcément celle du déclarateur
 * trouvé par `trouverLiaisonVisible`. Utilisé uniquement pour une liaison
 * `let`/`var` (jamais nécessaire pour un `const`, qui ne peut ni être
 * réaffecté ni redéclaré — la syntaxe l'interdit).
 */
function estReaffecteOuRedeclare(nom, ast, walkAcorn) {
  if (estReaffecte(nom, ast, walkAcorn)) return true;
  let compte = 0;
  walkAcorn.simple(ast, { VariableDeclarator(d) { if (d.id.type === 'Identifier' && d.id.name === nom) compte++; } });
  return compte > 1;
}

/**
 * Résout un argument dynamique (de `setTimeout`/`setInterval`, `eval`,
 * `Function`) vers l'une de trois issues : une fonction manifeste (jamais
 * signalée), une chaîne littérale (auditée comme le reste du code, y
 * compris via un nom de variable qui la porte), ou une valeur réellement
 * inconnue de l'analyse statique. Ne résout QUE vers une liaison visible
 * depuis le site d'appel (voir `trouverLiaisonVisible`) et jamais
 * réaffectée : un `const`, ou un `let`/`var` sans aucune affectation ni
 * redéclaration ailleurs dans le fichier — jamais une recherche globale
 * sans portée (l'ancienne approche, relevé par la coordination le
 * 2026-09-28, prenait pour argent comptant la première ou la dernière
 * déclaration homonyme trouvée n'importe où).
 */
function resoudreArgument(noeud, { ast, walkAcorn, ancetres }) {
  if (!noeud) return { type: 'inconnue' };
  if (noeud.type === 'ArrowFunctionExpression' || noeud.type === 'FunctionExpression') return { type: 'fonction' };
  if (noeud.type !== 'Identifier') return { type: 'autre' };

  const liaison = trouverLiaisonVisible(noeud.name, ancetres);
  if (!liaison || liaison.type === 'autre') return { type: 'inconnue' };

  if (liaison.type === 'parametre') {
    if (estExecuteurPromise(liaison.fonction, liaison.parent, liaison.index) && !estReaffecte(noeud.name, ast, walkAcorn)) {
      return { type: 'fonction' };
    }
    return { type: 'inconnue' };
  }

  if (liaison.type === 'fonction-nommee') {
    return estReaffecte(noeud.name, ast, walkAcorn) ? { type: 'inconnue' } : { type: 'fonction' };
  }

  // liaison.type === 'variable'
  if (estReaffecteOuRedeclare(noeud.name, ast, walkAcorn)) return { type: 'inconnue' };
  const init = liaison.declarateur.init;
  if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') return { type: 'fonction' };
  const litteral = plierLitteraux(init);
  return litteral !== null ? { type: 'litteral', valeur: litteral } : { type: 'inconnue' };
}

/** `String.fromCharCode(...)` retourne toujours une chaîne : si tous ses arguments sont des codes numériques littéraux, son résultat est aussi peu une boîte noire qu'un littéral direct — comme `atob()`. */
function decoderFromCharCodeLitteral(noeud) {
  if (noeud?.type !== 'CallExpression' || nomPointe(noeud.callee) !== 'String.fromCharCode' || !noeud.arguments.length) return null;
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
function traiterSiteConstruction(ctx, { fichierOrigine, ligneAppel, colonneAppel, extrait, texteBrut, profondeur, regle, titreConstruction, texteConstruction, remediationSupprimer, impactConstruction, referentielsSupp = [] }) {
  const constatCalculeOuIllisible = (motif) => constat({
    regle, axe: 'C', severite: 'critique', bloquant: true, confiance: 'certain',
    titre: titreConstruction, fichier: fichierOrigine, ligne: ligneAppel, extrait,
    constat: `${texteConstruction} ${motif}`,
    impact: impactConstruction,
    remediation: remediationSupprimer,
    referentiels: ['CWE-95', REF_ANSSI, 'OWASP Top 10 A03:2021', ...referentielsSupp],
  });

  if (texteBrut === null) {
    return { constats: [constatCalculeOuIllisible("Son argument est calculé à l'exécution : rien de ce qui sera réellement exécuté n'est lu par l'analyse statique.")] };
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

/**
 * eval()/Function() (directs ou indirects). `envelopper` corrige la
 * sémantique de `Function`/`new Function` : leur corps s'exécute comme
 * l'intérieur d'une fonction (où `return` est valide), contrairement à
 * `eval()` ou au script d'un worker, qui s'exécutent en portée de script.
 * `resoudreArgument` couvre le cas d'un identifiant qui porte une chaîne
 * littérale déclarée ailleurs dans le même fichier (`const code = "…";
 * eval(code)`) : sans lui, ce détour laissait ce contenu hors de portée de
 * l'analyse alors qu'il est parfaitement lisible (relevé par la
 * coordination le 2026-09-28) — et, comme pour `setTimeout`, seule une
 * liaison visible depuis le site d'appel et jamais réaffectée est résolue
 * (voir `resoudreArgument`) : `let code = 'void 0'; code = r.Formule;
 * eval(code)` doit être traité comme calculé à l'exécution, pas comme
 * `'void 0'` (relevé par la coordination le 2026-09-28).
 */
function traiterAppelExecution(ctx, { unite, ligneDe, n, argument, ast, walkAcorn, ancetres, profondeur, titreConstruction, texteConstruction, remediationSupprimer, envelopper = false }) {
  let brut = plierLitteraux(argument) ?? decoderAtobLitteral(argument);
  if (brut === null && argument?.type === 'Identifier') {
    const resolution = resoudreArgument(argument, { ast, walkAcorn, ancetres });
    if (resolution.type === 'litteral') brut = resolution.valeur;
  }
  const texteAnalyse = brut !== null && envelopper ? `(function(){${brut}})` : brut;
  return traiterSiteConstruction(ctx, {
    fichierOrigine: unite.chemin, ligneAppel: ligneDe(n), colonneAppel: (n.loc?.start?.column ?? 0) + 1, extrait: extraireSource(unite.source, n),
    texteBrut: texteAnalyse, profondeur, regle: 'C-XSS-03',
    titreConstruction, texteConstruction, remediationSupprimer,
    impactConstruction: IMPACT_EXECUTION_CHAINE,
  }).constats;
}

function constatMinuteurNonResolu({ unite, ligneDe, n, nom, motif }) {
  return constat({
    regle: 'C-XSS-04', axe: 'C', severite: 'majeur', bloquant: false, confiance: 'a_verifier',
    titre: `Source de ${nom} non résolue par l'analyse statique`,
    fichier: unite.chemin, ligne: ligneDe(n), extrait: extraireSource(unite.source, n),
    constat: motif,
    impact: "Si cette expression contient une chaîne au moment de l'appel, elle est évaluée comme du code, avec les mêmes conséquences qu'eval(). L'analyse statique ne peut ni le confirmer ni l'exclure depuis ce seul fichier.",
    remediation: `Passer directement une fonction à ${nom}, ou documenter dans le README la provenance de cette valeur.`,
    referentiels: ['CWE-95', REF_GUIDE],
  });
}

function traiterSiteConstructionMinuteur(ctx, { unite, ligneDe, n, nom, texteBrut, profondeur }) {
  return traiterSiteConstruction(ctx, {
    fichierOrigine: unite.chemin, ligneAppel: ligneDe(n), colonneAppel: (n.loc?.start?.column ?? 0) + 1, extrait: extraireSource(unite.source, n),
    texteBrut, profondeur, regle: 'C-XSS-04',
    titreConstruction: `Chaîne de caractères passée à ${nom} (équivalent à eval)`,
    texteConstruction: `Le premier argument de \`${nom}\` est une chaîne, pas une fonction.`,
    remediationSupprimer: `Passer une fonction : \`${nom}(() => …, délai)\`.`,
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
 * 2026-09-28) faute d'appartenir aux trois formes syntaxiques reconnues.
 */
function traiterMinuteur(ctx, { unite, ligneDe, n, nom, arg, ast, walkAcorn, ancetres, profondeur }) {
  if (!arg) return [];

  // Un identifiant est le seul cas où « inconnu » veut dire : peut-être une
  // fonction (le motif `setTimeout(callback, delai)`, très courant) — d'où
  // le palier « à vérifier », pas une critique systématique.
  if (arg.type === 'Identifier') {
    const resolution = resoudreArgument(arg, { ast, walkAcorn, ancetres });
    if (resolution.type === 'fonction') return [];
    if (resolution.type === 'litteral') {
      return traiterSiteConstructionMinuteur(ctx, { unite, ligneDe, n, nom, texteBrut: resolution.valeur, profondeur });
    }
    return [constatMinuteurNonResolu({
      unite, ligneDe, n, nom,
      motif: `Le premier argument de \`${nom}\` est un identifiant qui ne résout, dans ce fichier, ni vers une fonction ni vers une chaîne littérale : son contenu réel n'est connu qu'à l'exécution.`,
    })];
  }

  if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') return [];

  // Formes qui produisent TOUJOURS une chaîne, quel que soit leur contenu
  // (littéral, gabarit, concaténation, atob()/String.fromCharCode()) : si le
  // contenu ne se replie pas en littéral, il est réellement « calculé à
  // l'exécution », au même titre qu'un eval() à argument calculé — pas une
  // simple inconnue à vérifier, `traiterSiteConstruction` (texteBrut===null)
  // s'en charge.
  const estCandidat = arg.type === 'Literal' || arg.type === 'TemplateLiteral' || arg.type === 'BinaryExpression' ||
    (arg.type === 'CallExpression' && (nomFinal(arg.callee) === 'atob' || nomPointe(arg.callee) === 'String.fromCharCode'));

  if (estCandidat) {
    const texteBrut = plierLitteraux(arg) ?? decoderAtobLitteral(arg) ?? decoderFromCharCodeLitteral(arg);
    return traiterSiteConstructionMinuteur(ctx, { unite, ligneDe, n, nom, texteBrut, profondeur });
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
      fichierOrigine: unite.chemin, ligneAppel: ligneDe(n), colonneAppel: (n.loc?.start?.column ?? 0) + 1, extrait: extraireSource(unite.source, n),
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
        // `ancestor` (pas `simple`) : `traiterMinuteur` et `traiterAppelExecution`
        // ont besoin de la chaîne des ancêtres du site d'appel pour résoudre un
        // identifiant vers la liaison la plus proche qui le lie, quelle que
        // soit sa nature (voir `trouverLiaisonVisible`).
        walkAcorn.ancestor(ast, {
          CallExpression(n, _state, ancetres) {
            const nom = nomPointe(n.callee) || '';
            if (/(^|\.)eval$/.test(nom)) {
              constats.push(...traiterAppelExecution(ctx, {
                unite, ligneDe, n, argument: n.arguments[0], ast, walkAcorn, ancetres, profondeur,
                titreConstruction: 'Exécution de code arbitraire via eval()',
                texteConstruction: '`eval()` est appelé dans le code exécuté du widget.',
                remediationSupprimer: "Supprimer l'appel. Pour interpréter des données, utiliser `JSON.parse` ; pour une logique configurable, un interpréteur restreint écrit explicitement.",
              }));
            } else if (n.callee.type === 'SequenceExpression' && n.callee.expressions.at(-1)?.type === 'Identifier' && n.callee.expressions.at(-1).name === 'eval') {
              constats.push(...traiterAppelExecution(ctx, {
                unite, ligneDe, n, argument: n.arguments[0], ast, walkAcorn, ancetres, profondeur,
                titreConstruction: 'Exécution de code arbitraire via eval() indirect',
                texteConstruction: "La forme `(0, eval)(...)` (ou équivalente) appelle `eval` indirectement.",
                remediationSupprimer: "Supprimer l'appel. Pour interpréter des données, utiliser `JSON.parse` ; pour une logique configurable, un interpréteur restreint écrit explicitement.",
              }));
            }

            if (nom.split('.').pop() === 'Function') {
              constats.push(...traiterAppelExecution(ctx, {
                unite, ligneDe, n, argument: n.arguments.at(-1), ast, walkAcorn, ancetres, profondeur, envelopper: true,
                titreConstruction: 'Construction de code à la volée via Function() (sans new)',
                texteConstruction: '`Function(...)` sans `new` compile une chaîne en fonction exécutable, exactement comme `new Function(...)` : l\'appel fonctionne dans les deux cas.',
                remediationSupprimer: 'Supprimer cet usage.',
              }));
            }

            if (/^(setTimeout|setInterval)$/.test(nom.split('.').pop())) {
              constats.push(...traiterMinuteur(ctx, { unite, ligneDe, n, nom, arg: n.arguments[0], ast, walkAcorn, ancetres, profondeur }));
            }
          },
          NewExpression(n, _state, ancetres) {
            if (nomFinal(n.callee) === 'Function') {
              constats.push(...traiterAppelExecution(ctx, {
                unite, ligneDe, n, argument: n.arguments.at(-1), ast, walkAcorn, ancetres, profondeur, envelopper: true,
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
