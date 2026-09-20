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
 * qui visent l'origine exacte du harnais passent normalement, les autres
 * sont enregistrées puis court-circuitées par une réponse neutre. Un widget
 * qui exfiltre réellement des données ne les fait donc jamais sortir
 * pendant l'audit. En complément de cette interception au niveau page,
 * Chromium est lancé avec `--host-resolver-rules` : les services internes du
 * navigateur (mise à jour de composants, Safe Browsing…) qui parlent au
 * réseau en dehors de tout contexte de page, et échappent donc à
 * `context.route()`, ne peuvent résoudre aucun nom de domaine réel — voir
 * `construireArgsChromium()`.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { demarrerServeur } from './serveur.js';
import { constat } from '../moteur/modele.js';
import { analyserAccesAppat } from '../regles/d-perimetre.js';

// `new URL(import.meta.url).pathname` casse sur Windows : un chemin
// `file:///D:/...` donne un pathname `/D:/...` (barre oblique de tête que
// Windows ne reconnaît pas comme faisant partie de la lettre de lecteur, ce
// qui double ensuite le lecteur une fois passé à `path.resolve()`) et ne
// décode jamais le pourcentage-encodage (un espace dans le chemin du dépôt
// devient littéralement `%20`) — constaté avec Antoine : `mkdtemp
// 'D:\D:\Dev%20Grist\...'`. `fileURLToPath()` gère les deux correctement
// sur toutes les plateformes ; `bin/gwaudit.js` l'utilisait déjà pour son
// propre `RACINE_OUTIL`, seul ce fichier avait l'ancien motif.
const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE_OUTIL = path.resolve(ICI, '../..');

const CHARGE_XSS = '<img src=x onerror="window.parent.__poc_xss_exec=(window.parent.__poc_xss_exec||0)+1">';

/**
 * Identifiant d'une table « appât » du document de test : jamais montrée à
 * l'interface, jamais référencée par les colonnes que `grist.ready()`
 * déclare attendre, jamais la table sélectionnée (`GristView`). Un widget
 * honnête n'a aucune raison de la découvrir ; un widget qui la lit
 * (`fetchTable`/`applyUserActions` avec cet identifiant dans le journal RPC)
 * a nécessairement énuméré aveuglément tout le document plutôt que de se
 * limiter à ce que sa fonction déclarée justifie — c'est le signal, pas une
 * interprétation dessus. Exporté en constante pour que la règle de
 * détection (ailleurs) l'importe au lieu de dupliquer la chaîne : un
 * renommage ici ne doit jamais pouvoir désynchroniser silencieusement les
 * deux. Nom volontairement improbable pour qu'aucun widget réel ne puisse
 * le porter par coïncidence.
 */
export const TABLE_APPAT_ID = 'GwauditAppat_NeJamaisReferencer_8f2c14';

/**
 * Délai global du scénario joué dans le navigateur (chargement + évaluations
 * + a11y). Les timeouts déjà posés sur `goto` et `waitForFunction` ne
 * couvrent qu'eux-mêmes : un widget qui bloque le thread principal *après*
 * ces deux étapes (par exemple dans un gestionnaire déclenché par
 * `grist.onRecords`) peut sinon suspendre l'audit indéfiniment, puisque
 * `page.evaluate()` n'a pas de timeout propre.
 */
const DELAI_GLOBAL_AXE_D_MS = Number(process.env.GWAUDIT_DELAI_AXE_D_MS) || 45_000;

/** Course entre une promesse et un délai : rejette avec un message reconnaissable si le délai gagne. */
function avecDelai(promesse, ms, libelle) {
  let minuteur;
  const depasse = new Promise((_, reject) => {
    minuteur = setTimeout(() => reject(new Error(`DELAI_DEPASSE:${libelle}`)), ms);
  });
  return Promise.race([promesse, depasse]).finally(() => clearTimeout(minuteur));
}

/**
 * Arguments de lancement de Chromium qui coupent son trafic réseau propre
 * (mise à jour de composants, Safe Browsing, synchronisation…), en plus de
 * l'interception `context.route()` posée sur les pages. Deux couches,
 * volontairement redondantes :
 *  - `--host-resolver-rules` fait porter la coupure au niveau DNS : sans nom
 *    d'hôte résolvable, ce trafic échoue quel que soit le sous-système de
 *    Chromium qui l'a émis. Sans risque pour le harnais lui-même, dont
 *    l'origine est toujours une IP littérale (`127.0.0.1`), jamais un nom à
 *    résoudre.
 *  - `--proxy-server=direct://`, combiné à un environnement du process
 *    Chromium purgé des variables `*_PROXY`, empêche ce même trafic de
 *    contourner le blocage DNS en passant par un proxy HTTP(S) sortant : dans
 *    ce cas, c'est le proxy qui résoud le nom d'hôte, pas Chromium — la seule
 *    règle `--host-resolver-rules` ne suffit alors plus (constaté en
 *    testant : `www.google.com` continuait de sortir via le proxy de cet
 *    environnement cloud, alors que le nom n'aurait pas dû être résolu).
 */
function construireArgsChromium() {
  const argsReseau = [
    '--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE 127.0.0.1,EXCLUDE localhost',
    '--proxy-server=direct://',
    '--proxy-bypass-list=<-loopback>',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  // Le bac à sable natif de Chromium reste actif par défaut : c'est
  // justement du code non fiable qu'on exécute ici. Ne le désactiver que
  // si l'environnement l'exige (ex. conteneur sans espaces de noms
  // utilisateur non privilégiés) et en connaissance de cause.
  return process.env.GWAUDIT_CHROMIUM_SANS_SANDBOX === '1' ? [...argsReseau, '--no-sandbox'] : argsReseau;
}

/** Variables d'environnement à ne PAS transmettre au process Chromium — voir `construireArgsChromium()`. */
const VARS_PROXY = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];

function envChromiumSansProxy() {
  const env = { ...process.env };
  for (const cle of VARS_PROXY) delete env[cle];
  return env;
}

/**
 * Chemin réel du binaire Chromium à lancer : celui géré par Playwright
 * (`npx playwright install chromium`, voir README) par défaut.
 *
 * `GWAUDIT_CHROMIUM_PATH` permet de pointer explicitement vers un Chromium
 * déjà présent sur la machine (utile dans un environnement d'exécution qui
 * en fournit un et n'a pas d'accès réseau vers les serveurs de Playwright).
 * Ce n'était jusqu'ici pas un réglage mais un chemin d'un environnement de
 * développement précis écrit en dur dans le code (`/opt/pw-browsers/…`) —
 * absent, donc sans effet, sur la machine de tout autre utilisateur du
 * dépôt, mais qui, là où il existe, faisait tourner l'axe D sur un
 * Chromium potentiellement très différent de celui que Playwright aurait
 * réellement installé (constaté : Chromium 141 présent contre Chrome for
 * Testing 153 attendu par la version de Playwright fixée dans
 * `package-lock.json`), sans que rien ne le signale.
 */
function cheminChromium(chromium) {
  const impose = process.env.GWAUDIT_CHROMIUM_PATH;
  if (impose) {
    if (!fs.existsSync(impose)) {
      throw new Error(`GWAUDIT_CHROMIUM_PATH="${impose}" ne pointe vers aucun fichier.`);
    }
    return impose;
  }
  const chemin = chromium.executablePath();
  // `chromium.executablePath()` renvoie le chemin attendu SANS vérifier
  // qu'il existe : sur un environnement où un autre Chromium a été
  // pré-installé sous une révision différente de celle que ce
  // `playwright-core` attend (constaté : révision 1194 présente, révision
  // 1243 attendue), ce chemin ne mène nulle part. Sans ce contrôle,
  // l'erreur ne remonte qu'au moment de `launch()`, sous une forme
  // beaucoup plus vague (« Target page, context or browser has been
  // closed ») une fois passée par le script wrapper (`construireLanceurChromium`)
  // — lui-même bien réel, ce qui masque à Playwright l'absence du binaire
  // qu'il enveloppe. Un échec ici, avant tout lancement, est immédiat et lisible.
  if (!fs.existsSync(chemin)) {
    throw new Error(`Aucun Chromium trouvé à l'emplacement attendu par Playwright (${chemin}). Si un autre Chromium est déjà présent ailleurs sur cette machine (révision différente de celle installée par \`npx playwright install chromium\`), pointer dessus avec la variable d'environnement GWAUDIT_CHROMIUM_PATH. Sinon : \`npx playwright install chromium\`.`);
  }
  return chemin;
}

/** Plafond de temps CPU appliqué à Chromium — même valeur sur les deux plateformes (voir les deux fonctions ci-dessous). */
function limiteCpuSecondes() {
  return Math.ceil(DELAI_GLOBAL_AXE_D_MS / 1000) + 30;
}

/**
 * Enveloppe le binaire Chromium dans un script `/bin/sh` qui pose un
 * plafond de temps CPU (`ulimit -t`, RLIMIT_CPU) avant de l'exécuter avec
 * `exec` — donc sans changer de PID, si bien que tous les processus que
 * Chromium fait naître ensuite (zygote, rendu, GPU, réseau…) héritent la
 * même limite dès leur création, pas seulement le process principal.
 *
 * POSIX uniquement (Linux, macOS) : `ulimit` est une commande interne de
 * `/bin/sh`, absente de Windows — voir `imposerPlafondCpuWindows()` pour
 * l'équivalent utilisé là-bas.
 *
 * Une limite de MÉMOIRE (`ulimit -v`, RLIMIT_AS) a été essayée et écartée :
 * un renderer Chromium réserve, dès son démarrage normal, un espace
 * d'adressage virtuel de l'ordre du téraoctet (constaté ici : jusqu'à
 * ~1,4 To de VSZ pour quelques dizaines de Mio réellement utilisés), pour
 * des raisons internes à V8 sans rapport avec la mémoire physique
 * consommée. Aucune valeur de `ulimit -v` n'est à la fois assez basse pour
 * protéger la machine et assez haute pour laisser Chromium démarrer —
 * testé ici avec une limite de 2 Gio, largement au-dessus de ce qu'un
 * audit consomme normalement (~200 Mio résidents) : le lancement échoue
 * immédiatement. Une vraie limite mémoire demande un plafond sur la
 * mémoire RÉSIDENTE (cgroups), pas sur l'espace virtuel qu'un ulimit POSIX
 * peut poser — c'est le rôle des limites au niveau conteneur prévues pour
 * la V2 (docs/ARCHITECTURE-V2.md, §4), pas quelque chose qu'un simple
 * réglage de lancement peut fournir ici. Le délai global déjà posé plus
 * haut (`DELAI_GLOBAL_AXE_D_MS`) reste donc la seule protection contre un
 * widget qui consommerait la mémoire de la machine ; ce plafond CPU est un
 * filet complémentaire, pas un substitut.
 */
function construireLanceurChromium(dossierTravail, cheminReel) {
  const lanceur = path.join(dossierTravail, 'lancer-chromium.sh');
  fs.writeFileSync(
    lanceur,
    `#!/bin/sh\nulimit -t ${limiteCpuSecondes()} 2>/dev/null\nexec "${cheminReel}" "$@"\n`,
    { mode: 0o755 },
  );
  return lanceur;
}

/**
 * Script PowerShell (Windows PowerShell 5.1, présent par défaut sur
 * Windows 10/11 — pas besoin de PowerShell 7) qui pose, via l'API Win32
 * des Job Objects, un plafond de temps CPU cumulé (utilisateur, toutes les
 * générations de processus confondues) sur un process déjà démarré, dont
 * on ne connaît que le PID. Windows applique lui-même la coupure au
 * dépassement (tous les processus du job sont terminés) : ce script ne
 * fait qu'installer le plafond puis se termine, il n'a pas besoin de
 * rester actif pour que la limite continue à s'appliquer.
 *
 * Reçoit le PID en paramètre plutôt que de lancer Chromium lui-même : sur
 * Windows, `executablePath` doit être un exécutable natif (`CreateProcess`
 * n'interprète pas de shebang comme `/bin/sh` le fait), donc pas moyen d'y
 * glisser un script transparent comme le fait `construireLanceurChromium`
 * ci-dessus. Le contournement : Chromium est lancé normalement via
 * `chromium.launchServer()` (qui, à la différence de `chromium.launch()`,
 * expose le process réel et son PID), puis ce plafond lui est appliqué
 * après coup, avant de s'y connecter en client avec `chromium.connect()`.
 *
 * Non exécuté sur une vraie machine Windows depuis cet environnement de
 * développement (Linux) — voir le README, section Windows.
 */
const SCRIPT_PLAFOND_CPU_WINDOWS = `
param([int]$ProcessId, [double]$LimiteSecondes)
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class GwauditPlafondCpu {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, ref JOBOBJECT_BASIC_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
}
"@
# JOB_OBJECT_LIMIT_JOB_TIME = 0x4 : plafond cumulé (PerJobUserTimeLimit),
# en unités de 100 nanosecondes, sur tout le job — pas seulement le process
# principal : les processus enfants restent dans le même job par défaut.
$job = [GwauditPlafondCpu]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject a échoué" }
$info = New-Object GwauditPlafondCpu+JOBOBJECT_BASIC_LIMIT_INFORMATION
$info.PerJobUserTimeLimit = [long]($LimiteSecondes * 10000000)
$info.LimitFlags = 0x4
$taille = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
if (-not [GwauditPlafondCpu]::SetInformationJobObject($job, 2, [ref]$info, $taille)) { throw "SetInformationJobObject a échoué" }
$proc = Get-Process -Id $ProcessId
if (-not [GwauditPlafondCpu]::AssignProcessToJobObject($job, $proc.Handle)) { throw "AssignProcessToJobObject a échoué" }
`.trim();

/**
 * Applique le plafond CPU ci-dessus à un process Windows déjà démarré.
 * Ne lève jamais : un plafond de sécurité qui manque ne doit pas empêcher
 * l'audit de tourner, mais son échec doit être visible (voir l'appelant),
 * pas silencieux.
 */
function imposerPlafondCpuWindows(dossierTravail, pid, secondes) {
  const scriptPath = path.join(dossierTravail, 'plafond-cpu-windows.ps1');
  fs.writeFileSync(scriptPath, SCRIPT_PLAFOND_CPU_WINDOWS, 'utf8');
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath, '-ProcessId', String(pid), '-LimiteSecondes', String(secondes),
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 });
}

/**
 * Document de test injecté dans l'hôte simulé.
 *
 * `scenario`, s'il est fourni (voir --scenario, README § Personnaliser le
 * scénario de l'axe D), remplace la table et les colonnes par défaut — pour
 * tester avec des données représentatives du widget réellement audité
 * (mêmes noms de colonnes qu'il attend, plus de lignes, valeurs limites…).
 * Il ne retire jamais la sonde XSS : celle-ci est la seule vérification qui
 * PROUVE — plutôt que suppose — qu'une valeur de cellule peut s'exécuter
 * comme du code (voir constatsXss ci-dessous). Un scénario personnalisé
 * reçoit donc toujours sa propre colonne de sonde, en plus des siennes,
 * quelle que soit la forme fournie.
 */
/**
 * Table appât : jamais la table sélectionnée, jamais annoncée par un nom de
 * colonne attendu — voir TABLE_APPAT_ID ci-dessus pour le raisonnement.
 * Une fonction plutôt qu'une constante gelée : chaque audit doit repartir
 * d'un tableau de valeurs neuf, jamais partagé par référence entre deux
 * exécutions.
 */
function tableAppat() {
  return {
    tableId: TABLE_APPAT_ID,
    colonnes: {
      id: [1, 2],
      Libelle: [
        "Cette table n'est montrée à aucun widget honnête",
        'Sa lecture prouve une énumération du document au-delà du périmètre déclaré',
      ],
    },
  };
}

export function documentDeTest(scenario) {
  if (!scenario) {
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
      tablesAppats: [tableAppat()],
    };
  }
  const nbLignes = Math.max(1, ...Object.values(scenario.colonnes).map((c) => (Array.isArray(c) ? c.length : 1)));
  return {
    tableId: scenario.tableId || 'Contacts',
    nom: scenario.nom || 'Document de test — audit dynamique (scénario personnalisé)',
    colonnes: {
      ...scenario.colonnes,
      _GwauditSondeXss: Array.from({ length: nbLignes }, () => CHARGE_XSS),
    },
    tablesAppats: [tableAppat()],
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
 * @param {{tableId?: string, nom?: string, colonnes: object}} [options.scenario]
 *   remplace le document de test par défaut — voir documentDeTest() ci-dessous.
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

  const constats = [];
  const brut = { requetes: [], requetesLocales: [], substitutionApiGrist: [], consoles: [], erreursPage: [], journalHote: null, a11y: null };
  let navigateur, page, arreterServeur, serveurChromium, dossierTravail;

  try {
    // Dossier de scratch de l'axe D : sur le disque temporaire du système
    // (`os.tmpdir()`), jamais dans le dépôt lui-même. Quand l'outil tourne
    // depuis le dossier de projet partagé (monté en réseau, `fuse.rclone` —
    // constaté ~250-300ms par opération fichier contre ~10ms sur le disque
    // local), le serveur qui sert le harnais à Chromium à chaque requête de
    // page lisait ces fichiers depuis ce montage lent, plutôt exposé aux à-
    // coups de latence réseau que le disque local : plausible explication
    // des échecs intermittents de l'axe D observés par le fil protocole
    // (timeout de lancement ou de scénario selon le moment). `os.tmpdir()`
    // reste local sur les trois environnements cibles (`/tmp` sous
    // Linux/macOS, `%TEMP%` sous Windows) sans rien changer au reste.
    dossierTravail = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-axeD-'));
    const harnaisRacine = await construireHarnais(dossierTravail);
    const { origine, fermer } = await demarrerServeur({ widgetRacine: ctx.racine, harnaisRacine });
    arreterServeur = fermer;

    const cheminReel = cheminChromium(chromium);

    // `chromium.launch()`/`launchServer()` peut échouer avec un message
    // générique (« Target page, context or browser has been closed ») sans
    // rapport avec le widget audité : signalé par le fil protocole après une
    // quinzaine de lancements dans la même VM, premier réussi puis tous les
    // suivants en échec identique — un schéma qui évoque un incident
    // transitoire côté Chromium/hôte (le message ne dit rien de plus
    // précis) plutôt qu'une cause reproductible localement (38 lancements
    // d'affilée ici, aucun échec). Vu ce doute non tranché, une reprise
    // bornée est la mesure honnête : elle absorbe l'incident s'il est
    // transitoire, et si les deux tentatives échouent l'erreur remonte
    // telle quelle, sans la masquer.
    const TENTATIVES_LANCEMENT = 2;
    let erreurLancement;
    for (let tentative = 1; tentative <= TENTATIVES_LANCEMENT; tentative++) {
      try {
        if (process.platform === 'win32') {
          // Pas de wrapper transparent possible ici (voir imposerPlafondCpuWindows) :
          // `launchServer()` expose le PID réel, contrairement à `launch()`.
          serveurChromium = await chromium.launchServer({ args: construireArgsChromium(), env: envChromiumSansProxy(), executablePath: cheminReel });
          try {
            imposerPlafondCpuWindows(dossierTravail, serveurChromium.process().pid, limiteCpuSecondes());
          } catch (e) {
            console.error(`⚠ Plafond CPU inactif pour ce lancement de Chromium (Windows) : ${String(e?.message ?? e).split('\n')[0]}`);
          }
          navigateur = await chromium.connect(serveurChromium.wsEndpoint());
        } else {
          navigateur = await chromium.launch({
            args: construireArgsChromium(),
            env: envChromiumSansProxy(),
            executablePath: construireLanceurChromium(dossierTravail, cheminReel),
          });
        }
        erreurLancement = null;
        break;
      } catch (e) {
        erreurLancement = e;
        serveurChromium = undefined;
        navigateur = undefined;
        if (tentative < TENTATIVES_LANCEMENT) {
          console.error(`⚠ Échec du lancement de Chromium (tentative ${tentative}/${TENTATIVES_LANCEMENT}), nouvel essai : ${String(e?.message ?? e).split('\n')[0]}`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    if (erreurLancement) throw erreurLancement;
    const contexte = await navigateur.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
    page = await contexte.newPage();

    page.on('console', (m) => brut.consoles.push({ type: m.type(), texte: m.text().slice(0, 500) }));
    page.on('pageerror', (e) => brut.erreursPage.push(String(e?.message ?? e).slice(0, 500)));

    // Interception réseau : voir l'en-tête du module pour la justification.
    await contexte.route('**/*', (route) => {
      const req = route.request();
      const url = req.url();
      let h, urlOrigine;
      try { const u = new URL(url); h = u.hostname; urlOrigine = u.origin; } catch { h = null; urlOrigine = null; }
      // Comparaison à l'origine exacte du harnais (protocole + hôte + port),
      // pas au seul hostname : sur un poste où d'autres services écoutent en
      // boucle locale (base de données, autre serveur de dev…), un simple
      // `hostname === '127.0.0.1'` leur ouvrirait un passe-droit que rien ne
      // justifie — seule l'origine précise que l'outil vient de démarrer
      // doit passer.
      const local = urlOrigine === origine;

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

    // Le canal WebSocket échappe entièrement à `context.route()` ci-dessus,
    // qui n'intercepte que le trafic HTTP. `--host-resolver-rules` bloque
    // déjà une connexion WebSocket vers un domaine tiers réel, nom d'hôte
    // ou IP littérale (vérifié à l'exécution, voir docs/ARCHITECTURE-V2.md
    // §1 constat 5 — WebSocket passe par le même résolveur que le trafic
    // HTTP(S), contrairement à WebRTC) : le vrai trou n'est pas
    // l'exfiltration externe, mais (1) l'absence totale de trace dans le
    // rapport d'une tentative pourtant bloquée, et (2) le passe-droit
    // `127.0.0.1`/`localhost` (exclu du MAP par nécessité, pour le hôte de
    // test lui-même) qui n'a ici aucune vérification d'origine exacte
    // équivalente à celle de `context.route()` — un widget pourrait
    // atteindre un autre service local du même poste par ce biais. Une
    // route WebSocket enregistrée ne se connecte par défaut jamais au vrai
    // serveur tant que `connectToServer()` n'est pas appelé : ne jamais
    // l'appeler suffit à fermer ce dernier trou et à donner au rapport la
    // trace qui manquait, pour toute destination sans distinction.
    await contexte.routeWebSocket('**/*', (ws) => {
      const url = ws.url();
      let h;
      try { h = new URL(url).hostname; } catch { h = null; }
      brut.requetes.push({
        url, methode: 'WEBSOCKET', hote: h,
        ressourceType: 'websocket',
        corps: null,
      });
      ws.close({ code: 1008, reason: 'Connexion réseau neutralisée par l’audit' });
    });

    const contenuEntree = ctx.fichiers.find((f) => f.chemin === entree)?.contenu ?? '';
    const scriptGrist = urlScriptGrist(contenuEntree);

    await page.addInitScript(({ doc, widgetUrl }) => {
      window.__CONFIG_DOC__ = doc;
      window.__WIDGET_URL__ = widgetUrl;
      window.__REGLAGE__ = { niveauAccorde: 'full' };
    }, { doc: documentDeTest(options.scenario), widgetUrl: `${origine}/widget/${entree}` });

    // L'ensemble chargement + évaluations + a11y est couru contre un délai
    // global : `goto` et `waitForFunction` ont chacun leur propre timeout,
    // mais rien ne bornait ce qui suit — `page.evaluate()` n'a pas de
    // timeout propre et attendrait indéfiniment un widget qui bloque le
    // thread principal après le chargement initial.
    let delaiDepasse = false;
    try {
      await avecDelai((async () => {
        await page.goto(`${origine}/harnais/page-hote.html`, { waitUntil: 'load', timeout: 30000 });
        await page.waitForFunction(() => window.__hotePret === true, { timeout: 20000 }).catch(() => {});

        brut.journalHote = await page.evaluate(() => window.__hoteJournal ?? null).catch(() => null);
        brut.erreurHote = await page.evaluate(() => window.__hoteErreur ?? null).catch(() => null);
        brut.xssExecutes = await page.evaluate(() => window.__poc_xss_exec ?? 0).catch(() => 0);

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
      })(), DELAI_GLOBAL_AXE_D_MS, 'scenario-navigateur');
    } catch (e) {
      if (String(e?.message ?? '').startsWith('DELAI_DEPASSE:')) delaiDepasse = true;
      else throw e;
    }

    // --- Constats ---

    if (delaiDepasse) {
      constats.push(constat({
        regle: 'D-TIMEOUT-01', axe: 'D', severite: 'majeur', confiance: 'prouve',
        titre: `Le scénario de test n'a pas terminé dans le délai imparti (${Math.round(DELAI_GLOBAL_AXE_D_MS / 1000)}s)`,
        constat: "Le chargement et les vérifications de l'axe D n'ont pas pu se terminer dans le temps alloué : le widget occupe le navigateur au-delà de ce qu'un simple scénario de chargement justifie normalement.",
        impact: "Les vérifications de cet axe qui n'ont pas eu le temps de s'exécuter sont absentes du rapport ci-dessous — leur absence ne vaut pas conformité.",
        remediation: "Vérifier si le widget contient une boucle bloquante ou un traitement long au chargement. Si le widget a légitimement besoin de plus de temps, relancer avec la variable d'environnement GWAUDIT_DELAI_AXE_D_MS.",
      }));
    }

    if (brut.erreurHote) {
      constats.push(constat({
        regle: 'D-ERR-00', axe: 'D', severite: 'majeur', confiance: 'prouve',
        titre: "Le widget n'a pas pu être chargé dans l'hôte de test",
        constat: `Erreur : ${brut.erreurHote}`,
        impact: "Aucune des autres vérifications dynamiques n'a pu s'exécuter normalement. Les constats de l'axe D ci-dessous sont partiels.",
        remediation: "Vérifier que le widget appelle bien grist.ready() sans dépendre d'une fonctionnalité Grist non simulée par ce harnais léger (voir méthodologie).",
      }));
    }

    constats.push(...constatsReseau(brut.requetes, brut.substitutionApiGrist));
    constats.push(...constatsXss(brut.xssExecutes));
    constats.push(...constatsA11y(brut.a11y, brut.a11yErreur));
    constats.push(...constatsConsole(brut.consoles, brut.erreursPage, brut.requetes.length));
    constats.push(...constatsNegociationAcces(brut.journalHote));
    constats.push(...analyserAccesAppat(brut.journalHote));

  } catch (e) {
    // Filet générique : n'importe quelle erreur inattendue de l'axe D
    // (Chromium introuvable, dossier temporaire non créable, hôte de test
    // qui ne démarre pas…) dégrade cet axe en un simple constat au lieu de
    // faire sortir tout l'outil en erreur (code 3) — les cinq autres axes
    // n'ont rien à voir avec Chromium et ne doivent pas perdre leur rapport
    // pour autant. Constaté avec un vrai échec (chemin de dossier temporaire
    // invalide sous Windows) qui remontait jusqu'ici avant ce garde-fou.
    return {
      constats: [constat({
        regle: 'D-INDISPONIBLE', axe: 'D', severite: 'info', confiance: 'certain',
        titre: "Analyse dynamique non exécutée : l'axe D a échoué",
        constat: `${String(e?.message ?? e).split('\n')[0]}`,
        impact: "Les constats de l'axe D (comportement réel du widget : réseau, XSS à l'exécution, accessibilité rendue) ne peuvent pas être produits. Ce n'est pas une absence de risque, c'est une absence de mesure.",
        remediation: "Voir le message ci-dessus pour la cause. Si Chromium n'est pas installé : `npx playwright install chromium`. Si le message est « Target page, context or browser has been closed » (Chromium démarre puis se ferme aussitôt) dans un conteneur ou une VM, essayer `GWAUDIT_CHROMIUM_SANS_SANDBOX=1` — le bac à sable natif de Chromium est une source connue d'échecs de ce type dans ce genre d'environnement. Sinon, relancer avec `--sans-dynamique` pour ignorer cet axe en attendant.",
      })],
      brut: null,
      nonExecute: true,
    };
  } finally {
    await page?.close().catch(() => {});
    await navigateur?.close().catch(() => {});
    // Sur Windows, `navigateur` est un client `connect()` : `.close()` peut
    // se contenter de couper la connexion. `serveurChromium.close()` est ce
    // qui garantit que le process réel (et le job qui porte son plafond
    // CPU) se termine bien.
    await serveurChromium?.close().catch(() => {});
    await arreterServeur?.().catch(() => {});
    if (dossierTravail) fs.rmSync(dossierTravail, { recursive: true, force: true });
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
    preuve: { hote, requetes: liste.slice(0, 10) },
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

export function constatsA11y(violations, erreur) {
  if (violations == null) {
    // `erreur` vient du catch qui entoure l'injection/l'exécution d'axe-core
    // (CSP qui bloque addScriptTag, exception JS…) : jusqu'ici capturée dans
    // `brut.a11yErreur` puis jamais lue, ce qui laissait un rapport sans le
    // moindre constat d'accessibilité se présenter comme s'il n'y avait rien
    // à signaler plutôt que comme une mesure qui n'a pas eu lieu — même
    // défaut que E-VULN-00 pour `npm audit` en échec.
    if (erreur) {
      return [constat({
        regle: 'D-RGAA-INDISPONIBLE', axe: 'F', severite: 'info', confiance: 'certain',
        titre: "Vérification d'accessibilité non aboutie",
        constat: `axe-core n'a pas pu être exécuté sur le widget : ${erreur}`,
        impact: "Aucune conclusion ne peut être tirée sur l'accessibilité du widget pour ce scénario. L'absence de constat D-RGAA/F-RGAA dans ce rapport ne vaut pas absence de violation.",
        remediation: "Vérifier qu'une CSP éventuelle du widget n'empêche pas le chargement d'un script same-origin supplémentaire (voir C-CSP-01/02), puis relancer l'audit.",
        mesurePartielle: true,
      })];
    }
    return [];
  }
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

export function constatsNegociationAcces(journal) {
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
  // `journal.erreursRpc` vient du warn() de grain-rpc (méthode ou interface
  // inconnue, arguments invalides, destination de forwarding inconnue…) :
  // jusqu'ici capturé puis jamais lu, ce qui laissait un canal RPC en échec
  // partiel se présenter comme un axe D intégralement mesuré — même défaut
  // que E-VULN-00 pour `npm audit` en échec. Un appel qui échoue ainsi n'a
  // produit aucun des constats (D-PERIMETRE-01, D-GRIST-01…) qui dépendent
  // de ce qu'il aurait dû exécuter côté hôte.
  if (journal.erreursRpc?.length) {
    constats.push(constat({
      regle: 'D-GRIST-02', axe: 'D', severite: 'info', confiance: 'certain',
      titre: 'Un ou plusieurs appels RPC du widget ont échoué pendant le scénario de test',
      constat: `${journal.erreursRpc.length} erreur(s) rapportée(s) par le canal RPC : ${journal.erreursRpc.slice(0, 5).join(' ; ')}`,
      impact: "Les vérifications de l'axe D qui dépendent de l'appel en échec (négociation d'accès, table appât, etc.) n'ont pas pu s'exécuter pour cet appel précis. Leur absence de constat ne vaut pas absence de comportement à risque.",
      remediation: "Vérifier que l'hôte de test implémente bien l'interface que le widget appelle (voir src/runtime/harnais/hote.js) avant de conclure quoi que ce soit sur ce point.",
      mesurePartielle: true,
    }));
  }
  return constats;
}
