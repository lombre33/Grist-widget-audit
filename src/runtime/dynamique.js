/**
 * Orchestration de l'axe D — audit dynamique en condition réelle.
 *
 * Charge le widget réellement, dans un vrai Chromium, avec un hôte Grist qui
 * parle le protocole RPC réel (voir harnais/hote.js et le client
 * grist-plugin-api vendu dans ressources/). Ce que ce module observe n'est
 * pas déduit du code : c'est ce qui s'est effectivement produit à
 * l'exécution — d'où la confiance `prouve` sur ces constats.
 *
 * Quatre vérifications, dans l'ordre de priorité de l'axe C qu'elles
 * viennent confirmer ou infirmer :
 *   1. Trafic réseau réellement émis (confronté aux constats C-EXFIL-*)
 *   2. Exécution effective d'une charge XSS placée dans une cellule
 *   3. Accessibilité (axe-core) dans le DOM réellement rendu
 *   4. Erreurs console / échecs d'exécution
 *
 * Sécurité de l'audit lui-même : aucune requête sortante n'est laissée
 * aboutir vers un domaine tiers réel. Chaque requête est interceptée ; celles
 * qui visent l'origine locale du harnais passent normalement, les autres
 * sont enregistrées puis court-circuitées par une réponse neutre. Un widget
 * qui exfiltre réellement des données ne les fait donc jamais sortir
 * pendant l'audit.
 */
import path from 'node:path';
import fs from 'node:fs';
import * as esbuild from 'esbuild';
import { demarrerServeur } from './serveur.js';
import { constat } from '../moteur/modele.js';

const ICI = path.dirname(new URL(import.meta.url).pathname);
const RACINE_OUTIL = path.resolve(ICI, '../..');

const CHARGE_XSS = '<img src=x onerror="window.parent.__poc_xss_exec=(window.parent.__poc_xss_exec||0)+1">';

/** Document de test minimal, avec une charge utile d'injection dans un champ texte plausible. */
function documentDeTest() {
  return {
    tableId: 'Contacts',
    nom: 'Document de test — audit dynamique',
    colonnes: {
      id: [1, 2, 3],
      Nom: ['Alice Dupont', 'Bernard Martin', CHARGE_XSS],
      Email: ['alice.dupont@exemple.gouv.fr', 'bernard.martin@exemple.gouv.fr', 'test@exemple.gouv.fr'],
      Montant: [125.5, 42, 0],
      Commentaire: ['RAS', CHARGE_XSS, 'Dossier clos'],
    },
  };
}

async function construireHarnais(dossierTravail) {
  const harnaisRacine = path.join(dossierTravail, 'harnais');
  fs.mkdirSync(harnaisRacine, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(RACINE_OUTIL, 'src/runtime/harnais/hote.js')],
    bundle: true, format: 'iife', globalName: 'Harnais', platform: 'browser', target: 'es2020',
    outfile: path.join(harnaisRacine, 'hote.js'), logLevel: 'silent',
  });
  fs.copyFileSync(path.join(RACINE_OUTIL, 'src/runtime/harnais/page-hote.html'), path.join(harnaisRacine, 'page-hote.html'));

  const clientGrist = path.join(RACINE_OUTIL, 'ressources/grist-plugin-api/grist-plugin-api.js');
  if (!fs.existsSync(clientGrist)) {
    throw new Error("ressources/grist-plugin-api/grist-plugin-api.js est absent — lancer `node scripts/construire-grist-plugin-api.mjs` une première fois.");
  }
  fs.copyFileSync(clientGrist, path.join(harnaisRacine, 'grist-plugin-api.js'));
  fs.copyFileSync(path.join(RACINE_OUTIL, 'node_modules/axe-core/axe.min.js'), path.join(harnaisRacine, 'axe.min.js'));

  return harnaisRacine;
}

/** Cherche dans le HTML d'entrée l'URL (relative ou absolue) du script grist-plugin-api. */
function urlScriptGrist(contenuHtml) {
  const m = contenuHtml.match(/<script[^>]+src\s*=\s*["']([^"']*grist-plugin-api\.js)["']/i);
  return m ? m[1] : null;
}

/**
 * @param {object} ctx        contexte construit par construireContexte()
 * @param {object} [options]
 * @param {number} [options.delaiMs]     temps laissé au widget pour réagir après chaque événement
 * @param {boolean} [options.capturesEcran]
 * @returns {Promise<{constats: Array, brut: object}>}
 */
export async function auditDynamique(ctx, options = {}) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch {
    return {
      constats: [constat({
        regle: 'D-INDISPONIBLE', axe: 'D', severite: 'info', confiance: 'certain',
        titre: "Analyse dynamique non exécutée : Playwright n'est pas installé",
        constat: "Le paquet optionnel `playwright` n'est pas présent dans les dépendances installées.",
        impact: "Les constats de l'axe D (comportement réel du widget : réseau, XSS à l'exécution, accessibilité rendue) ne peuvent pas être produits. Ce n'est pas une absence de risque, c'est une absence de mesure.",
        remediation: 'Installer les dépendances optionnelles : `npm install` puis relancer avec `--dynamique`.',
      })],
      brut: null,
      nonExecute: true,
    };
  }

  const entree = ctx.entrees[0];
  if (!entree) {
    return {
      constats: [constat({
        regle: 'D-INDISPONIBLE', axe: 'D', severite: 'info', confiance: 'certain',
        titre: "Analyse dynamique non exécutée : aucun point d'entrée HTML trouvé",
        constat: "L'inventaire du dépôt n'a identifié aucun fichier HTML chargeable.",
        impact: "Aucune mesure en condition réelle n'a pu être faite.",
        remediation: "Vérifier qu'un fichier index.html existe à la racine du widget ou est référencé par un manifest.json.",
      })],
      brut: null, nonExecute: true,
    };
  }

  const dossierTravail = fs.mkdtempSync(path.join(RACINE_OUTIL, '.tmp-'));
  const constats = [];
  const brut = { requetes: [], requetesLocales: [], substitutionApiGrist: [], consoles: [], erreursPage: [], journalHote: null, a11y: null };
  let navigateur, page, arreterServeur;

  try {
    const harnaisRacine = await construireHarnais(dossierTravail);
    const { origine, fermer } = await demarrerServeur({ widgetRacine: ctx.racine, harnaisRacine });
    arreterServeur = fermer;

    // Le bac à sable natif de Chromium reste actif par défaut : c'est
    // justement du code non fiable qu'on exécute ici. Ne le désactiver que
    // si l'environnement l'exige (ex. conteneur sans espaces de noms
    // utilisateur non privilégiés) et en connaissance de cause.
    const args = process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX === '1' ? ['--no-sandbox'] : [];
    navigateur = await chromium.launch({
      args,
      // Chromium préinstallé de l'environnement : évite un téléchargement
      // réseau si la version de Playwright installée localement en attend
      // une révision différente (voir README de déploiement).
      executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
        ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
    });
    const contexte = await navigateur.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    page = await contexte.newPage();

    page.on('console', (m) => brut.consoles.push({ type: m.type(), texte: m.text().slice(0, 500) }));
    page.on('pageerror', (e) => brut.erreursPage.push(String(e?.message ?? e).slice(0, 500)));

    // Interception réseau : voir l'en-tête du module pour la justification.
    await contexte.route('**/*', (route) => {
      const req = route.request();
      const url = req.url();
      let h; try { h = new URL(url).hostname; } catch { h = null; }
      const local = h === '127.0.0.1' || h === 'localhost';

      if (/\/grist-plugin-api\.js(\?|$)/i.test(url) && !local) {
        // Substitution intentionnelle : le widget croit charger l'API depuis
        // le domaine externe déclaré dans son HTML (déjà signalé par
        // C-EXFIL-04 en analyse statique) ; on lui sert la vraie API pour que
        // le reste du scénario s'exécute normalement. Ce n'est pas une fuite
        // de données à faire remonter une deuxième fois côté axe D.
        brut.substitutionApiGrist.push({ url, methode: req.method() });
        return route.fulfill({ path: path.join(harnaisRacine, 'grist-plugin-api.js'), contentType: 'text/javascript' });
      }
      if (local) { brut.requetesLocales.push({ url, methode: req.method() }); return route.continue(); }

      brut.requetes.push({
        url, methode: req.method(), hote: h,
        ressourceType: req.resourceType(),
        corps: req.method() !== 'GET' ? (req.postData() ?? '').slice(0, 300) : null,
      });
      // Court-circuit : le widget « croit » avoir reçu une réponse, mais rien n'a quitté le bac à sable.
      return route.fulfill({ status: 204, body: '' });
    });

    const contenuEntree = ctx.fichiers.find((f) => f.chemin === entree)?.contenu ?? '';
    const scriptGrist = urlScriptGrist(contenuEntree);

    await page.addInitScript(({ doc, widgetUrl }) => {
      window.__CONFIG_DOC__ = doc;
      window.__WIDGET_URL__ = widgetUrl;
      window.__REGLAGE__ = { niveauAccorde: 'full' };
    }, { doc: documentDeTest(), widgetUrl: `${origine}/widget/${entree}` });

    await page.goto(`${origine}/harnais/page-hote.html`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__hotePret === true, { timeout: 20000 }).catch(() => {});

    brut.journalHote = await page.evaluate(() => window.__hoteJournal ?? null).catch(() => null);
    const erreurHote = await page.evaluate(() => window.__hoteErreur ?? null).catch(() => null);
    const xssExecutes = await page.evaluate(() => window.__poc_xss_exec ?? 0).catch(() => 0);

    // Accessibilité : axe-core injecté et exécuté dans le cadre du widget lui-même.
    try {
      const frame = page.frames().find((f) => f !== page.mainFrame());
      if (frame) {
        // `url` plutôt que `path` : Playwright injecterait sinon le contenu du
        // fichier comme script INLINE, que la CSP `script-src 'self'` d'un
        // widget bien conçu refuse à raison (voir C-CSP-01 / test 1 ci-dessus).
        // Une balise `<script src=…>` de même origine reste, elle, couverte
        // par `'self'`.
        await frame.addScriptTag({ url: `${origine}/harnais/axe.min.js` });
        brut.a11y = await frame.evaluate(async () => {
          const r = await window.axe.run(document, { resultTypes: ['violations'] });
          return r.violations.map((v) => ({
            id: v.id, impact: v.impact, description: v.description, aide: v.help, url: v.helpUrl,
            occurrences: v.nodes.length,
            exemples: v.nodes.slice(0, 3).map((n) => n.html?.slice(0, 200)),
          }));
        });
      }
    } catch (e) { brut.a11yErreur = String(e?.message ?? e); }

    // --- Constats ---

    if (erreurHote) {
      constats.push(constat({
        regle: 'D-ERR-00', axe: 'D', severite: 'majeur', confiance: 'prouve',
        titre: "Le widget n'a pas pu être chargé dans l'hôte de test",
        constat: `Erreur : ${erreurHote}`,
        impact: "Aucune des autres vérifications dynamiques n'a pu s'exécuter normalement. Les constats de l'axe D ci-dessous sont partiels.",
        remediation: "Vérifier que le widget appelle bien grist.ready() sans dépendre d'une fonctionnalité Grist non simulée par ce harnais léger (voir méthodologie).",
      }));
    }

    constats.push(...constatsReseau(brut.requetes, brut.substitutionApiGrist));
    constats.push(...constatsXss(xssExecutes));
    constats.push(...constatsA11y(brut.a11y));
    constats.push(...constatsConsole(brut.consoles, brut.erreursPage, brut.requetes.length));
    constats.push(...constatsNegociationAcces(brut.journalHote));

  } finally {
    await page?.close().catch(() => {});
    await navigateur?.close().catch(() => {});
    await arreterServeur?.().catch(() => {});
    fs.rmSync(dossierTravail, { recursive: true, force: true });
  }

  return { constats, brut };
}

function constatsReseau(requetes, substitutionApiGrist = []) {
  const constats = [];
  if (substitutionApiGrist.length) {
    constats.push(constat({
      regle: 'D-RESEAU-02', axe: 'D', severite: 'info', confiance: 'prouve',
      titre: 'Chargement de grist-plugin-api.js depuis un domaine externe confirmé à l\'exécution',
      constat: `${substitutionApiGrist.length} requête(s) vers \`${new URL(substitutionApiGrist[0].url).hostname}\` observée(s) pendant le chargement, servie(s) par le harnais pour permettre au scénario de continuer.`,
      impact: "Confirme à l'exécution le constat statique C-EXFIL-04 : ce chargement est réel, pas seulement présent dans le code mort ou un chemin conditionnel jamais atteint.",
      remediation: 'Voir C-EXFIL-04.',
    }));
  }
  if (!requetes.length) {
    constats.push(constat({
      regle: 'D-RESEAU-00', axe: 'D', severite: 'info', confiance: 'prouve',
      titre: 'Aucune requête vers un domaine tiers observée à l\'exécution',
      constat: "En dehors du chargement de l'API Grist elle-même, le widget n'a émis, pendant le scénario joué (chargement, réception de données, modification simulée), aucune requête réseau vers un domaine tiers.",
      impact: "Sur ce scénario précis, les constats C-EXFIL-02 (destination calculée à l'exécution) éventuels sont infirmés : ils ne se sont pas déclenchés. Un scénario plus long ou une autre action de l'agent pourrait en déclencher d'autres — cette vérification n'est pas exhaustive.",
      remediation: 'Rien à corriger sur ce point.',
    }));
    return constats;
  }
  const parHote = new Map();
  for (const r of requetes) (parHote.get(r.hote) ?? parHote.set(r.hote, []).get(r.hote)).push(r);

  constats.push(...[...parHote.entries()].map(([hote, liste]) => constat({
    regle: 'D-RESEAU-01', axe: 'D', severite: 'critique', bloquant: true, confiance: 'prouve',
    titre: `Requête réseau confirmée à l'exécution vers ${hote ?? '(hôte inconnu)'}`,
    constat: `${liste.length} requête(s) effectivement émise(s) pendant le scénario de test : ${liste.slice(0, 5).map((r) => `${r.methode} ${r.url}`).join(' ; ')}.`,
    impact: "Ceci n'est plus une hypothèse d'analyse statique : la requête a réellement quitté le widget pendant l'exécution. Elle a été interceptée et neutralisée par le harnais d'audit ; en usage réel, elle aurait atteint ce domaine avec les données que le widget y a placées.",
    remediation: "Confirmer ou infirmer avec le contributeur ce que cette requête transporte, et l'autoriser explicitement (documentation, liste blanche) ou la supprimer.",
    referentiels: ['OWASP Top 10 A10:2021'],
    preuve: { requetes: liste.slice(0, 10) },
  })));
  return constats;
}

function constatsXss(nb) {
  if (!nb) return [];
  return [constat({
    regle: 'D-XSS-01', axe: 'D', severite: 'critique', bloquant: true, confiance: 'prouve',
    titre: 'Injection HTML exécutée à partir d\'une valeur de cellule (preuve d\'exécution)',
    constat: `Le widget a rendu une valeur de cellule contenant \`<img onerror=…>\` de façon à exécuter le gestionnaire d'événement : ${nb} déclenchement(s) mesuré(s).`,
    impact: "Preuve directe, pas une heuristique : une donnée de cellule ordinaire devient du code exécuté dans le widget, avec l'accès que l'agent a accordé au document. N'importe quel contributeur du document peut viser n'importe quel agent qui ouvre ce widget.",
    remediation: "Localiser le point d'affichage de cette colonne (recherche de `innerHTML` sur les colonnes « Nom » ou « Commentaire » dans le code) et échapper la valeur ou la rendre en texte (`textContent`).",
    referentiels: ['OWASP Top 10 A03:2021 — Injection', 'CWE-79'],
  })];
}

function constatsA11y(violations) {
  if (violations == null) return [];
  if (!violations.length) {
    return [constat({
      regle: 'D-RGAA-00', axe: 'F', severite: 'info', confiance: 'prouve',
      titre: 'Aucune violation axe-core détectée sur le DOM rendu',
      constat: "Le contrôleur axe-core n'a signalé aucune violation sur l'état du widget après chargement des données de test.",
      impact: "Couvre une partie du RGAA sur l'état observé (chargement initial avec des données simulées). Ne couvre pas les interactions ultérieures (ouverture de menus, formulaires dynamiques) ni les critères qui demandent un jugement humain.",
      remediation: 'Rien à corriger sur ce point.',
    })];
  }
  const gravite = { critical: 'critique', serious: 'majeur', moderate: 'mineur', minor: 'mineur' };
  return violations.map((v) => constat({
    regle: `D-RGAA-${v.id}`, axe: 'F',
    severite: gravite[v.impact] ?? 'mineur', confiance: 'prouve',
    titre: `Violation d'accessibilité confirmée à l'exécution : ${v.aide}`,
    constat: `${v.description} (${v.occurrences} occurrence(s)). Exemple : ${v.exemples[0] ?? ''}`,
    impact: "Constat obtenu par exécution réelle du moteur de règles axe-core sur le DOM effectivement rendu par le widget, pas par lecture du code source.",
    remediation: `Voir la documentation de la règle : ${v.url}`,
    referentiels: ['RGAA 4.1', 'WCAG 2.1', 'axe-core (Deque Systems)'],
    preuve: { regleAxe: v.id, exemples: v.exemples },
  }));
}

const MOTIF_ERREUR_IMPORT_NEUTRALISE = /Failed to load module script|net::ERR_FAILED|Failed to fetch dynamically imported module/i;

function constatsConsole(consoles, erreursPage, nbRequetesNeutralisees) {
  const constats = [];
  const toutesErreurs = consoles.filter((c) => c.type === 'error');
  // Une requête vers un domaine tiers est neutralisée pendant l'audit (voir
  // en-tête du module) : un widget qui importe un module ES depuis un CDN
  // voit alors cet import échouer, ce qui est un artefact du bac à sable,
  // pas un défaut du widget. On les sépare pour ne pas accuser le widget
  // d'une erreur que l'audit lui-même a provoquée.
  const bruitDuSandbox = nbRequetesNeutralisees > 0
    ? toutesErreurs.filter((c) => MOTIF_ERREUR_IMPORT_NEUTRALISE.test(c.texte))
    : [];
  const erreurs = toutesErreurs.filter((c) => !bruitDuSandbox.includes(c));

  if (bruitDuSandbox.length) {
    constats.push(constat({
      regle: 'D-CONSOLE-02', axe: 'D', severite: 'info', confiance: 'certain',
      titre: `${bruitDuSandbox.length} erreur(s) de chargement liée(s) à la neutralisation réseau de l'audit`,
      constat: "Des imports de modules vers un domaine tiers ont échoué parce que l'audit a neutralisé la requête (voir D-RESEAU-01/02) — pas parce que le widget est défaillant.",
      impact: "Sans rapport avec la qualité du widget. Avec un accès réseau réel, ces imports auraient abouti (ou échoué pour d'autres raisons, propres à l'environnement de l'agent).",
      remediation: "Aucune action liée à ce constat. Réduire plutôt la dépendance à des imports distants — voir E-DEP-01.",
    }));
  }
  if (erreurs.length || erreursPage.length) {
    constats.push(constat({
      regle: 'D-CONSOLE-01', axe: 'D', severite: 'mineur', confiance: 'prouve',
      titre: `${erreurs.length + erreursPage.length} erreur(s) JavaScript pendant l'exécution`,
      constat: [...erreurs.map((e) => e.texte), ...erreursPage].slice(0, 8).join(' | '),
      impact: "Une erreur non gérée pendant un scénario aussi simple qu'un chargement de document suggère que le widget suppose une forme de données plus stricte que ce que Grist peut fournir en pratique (cellule vide, type inattendu).",
      remediation: 'Ajouter des gardes sur les données manquantes ou de type inattendu.',
      preuve: { erreurs: erreurs.slice(0, 10), erreursPage: erreursPage.slice(0, 10) },
    }));
  }
  return constats;
}

function constatsNegociationAcces(journal) {
  if (!journal) return [];
  const constats = [];
  if (!journal.configureRecu) {
    constats.push(constat({
      regle: 'D-GRIST-01', axe: 'D', severite: 'majeur', confiance: 'prouve',
      titre: "Le widget n'a pas négocié son niveau d'accès pendant le scénario de test",
      constat: "Aucun appel à CustomSectionAPI.configure() n'a été reçu par l'hôte de test — c'est l'appel que produit grist.ready().",
      impact: "Si ce constat se confirme dans une vraie instance Grist, l'agent n'a jamais vu l'écran de consentement décrivant l'accès demandé par le widget.",
      remediation: 'Vérifier que grist.ready() est bien atteint sans exception avant ce point (voir D-ERR-00 et D-CONSOLE-01 si présents).',
    }));
  }
  return constats;
}
