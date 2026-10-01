#!/usr/bin/env node
/**
 * gwaudit — audit automatisé de widgets Grist (qualité, lisibilité,
 * sécurité, dépendances, conformité Grist.Gouv).
 *
 * Usage :
 *   gwaudit <chemin-ou-url-du-widget> [options]
 *
 * Options :
 *   --sans-dynamique     n'exécute que l'analyse statique (axes A, B, C, E, F)
 *   --sans-reseau        n'interroge pas npm audit (axe E) : fonctionne hors-ligne
 *   --sortie <dossier>   dossier de sortie des rapports (défaut : ./rapport-<nom>)
 *   --json               écrit aussi rapport.json
 *   --sans-html          n'écrit pas rapport.html (écrit par défaut)
 *   --sarif              écrit aussi rapport.sarif (SARIF 2.1.0, intégration CI)
 *   --version            affiche la version et quitte
 *   --diff <a.json> <b.json>  compare deux rapports --json déjà générés,
 *                        sans lancer d'audit (voir README § Comparer deux audits)
 *   --scenario <fichier.json>  remplace les données de test de l'axe D par un
 *                        document personnalisé (voir README § Personnaliser
 *                        le scénario de l'axe D) ; ignoré si invalide
 *   --interface          lance l'interface web locale (lien du dépôt → suivi
 *                        en direct → page d'audit) au lieu d'un audit direct
 *   --port <n>            port de l'interface web (défaut : 4317)
 *
 * Codes de sortie : 0 conforme · 1 conforme sous réserve, ou non conforme sans
 * point bloquant · 2 au moins un point bloquant · 3 erreur interne de l'outil ·
 * 4 cible refusée ou inaccessible (URL refusée par la validation ou par le proxy
 * de sortie, clonage impossible, chemin introuvable).
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { constatAxeDIgnoreParOption } from '../src/runtime/dynamique.js';
import { analyserEnEnfant } from '../src/isolement/analyse-isolee.js';
import { auditerAxeD } from '../src/isolement/axe-d.js';
import { ErreurLancement } from '../src/isolement/enfant.js';
import { limitesDeLAnalyse } from '../src/isolement/limites.js';
import { noter } from '../src/moteur/notation.js';
import { genererMarkdown } from '../src/rapport/markdown.js';
import { genererJson } from '../src/rapport/json.js';
import { genererHtml } from '../src/rapport/html.js';
import { genererSarif } from '../src/rapport/sarif.js';
import { comparerRapports, genererDiffMarkdown } from '../src/rapport/diff.js';
import { validerScenario } from '../src/runtime/scenario.js';
import { demarrerInterface } from '../src/interface/serveur.js';

const RACINE_OUTIL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(RACINE_OUTIL, 'package.json'), 'utf8')).version;

async function main() {
  const argv = process.argv.slice(2);
  const cible = argv.find((a) => !a.startsWith('--'));
  const flag = (nom) => argv.includes(`--${nom}`);
  const valeur = (nom, def) => { const i = argv.indexOf(`--${nom}`); return i >= 0 ? argv[i + 1] : def; };

  if (flag('version')) {
    console.log(VERSION);
    process.exit(0);
  }

  if (flag('diff')) {
    diffRapports(argv);
    return;
  }

  if (flag('interface')) {
    await lancerInterface(valeur);
    return; // la promesse ne se résout qu'à l'arrêt du serveur (Ctrl+C)
  }

  if (!cible || flag('aide') || flag('help')) {
    console.log(`Usage : gwaudit <chemin-ou-url-du-widget> [--sans-dynamique] [--sans-reseau] [--sans-html] [--sarif] [--sortie <dossier>] [--json]`);
    console.log(`        gwaudit --diff <ancien-rapport.json> <nouveau-rapport.json> [--sortie <fichier.md>]`);
    console.log(`        gwaudit --interface [--port <n>]`);
    console.log(`        gwaudit --version`);
    // --aide/--help est une réussite (code 0) même sans cible : ce n'est une
    // erreur d'usage (code 1) que si ni l'un ni l'autre n'a été demandé.
    process.exit((flag('aide') || flag('help')) ? 0 : 1);
  }

  const { racine, temporaire, identite } = await resoudreCible(cible);
  try {
    const nomDepot = identite;
    const dossierSortie = path.resolve(valeur('sortie', `./rapport-${nomDepot}`));
    fs.mkdirSync(dossierSortie, { recursive: true });

    // L'inventaire et les règles statiques lisent le code du widget : elles tournent dans un enfant à limite
    // de mémoire (et de temps, si la brique en fixe une). Un widget qui les fait tomber ne fait pas tomber
    // l'audit : l'enfant mort donne un constat critique bloquant qui dit pourquoi (src/isolement/).
    const analyse = await analyserEnEnfant({ racine, reseau: !flag('sans-reseau'), limites: limitesDeLAnalyse() });
    const constats = analyse.constats;
    // Si l'enfant est mort avant la fin de l'inventaire il n'y a pas de contexte : les rapports lisent alors un contexte vide.
    const ctx = analyse.ctx ?? { racine, entrees: [], fichiersReels: 0, surface: { size: 0 }, tronque: null, fichiers: [] };
    if (!analyse.ok) console.error(`⚠ L'analyse du code s'est interrompue : ${analyse.interruption.raison}. Le rapport le dit (C-SURFACE-03) et note à 0 les axes qu'elle alimente.`);

    const axesNonExecutes = new Set();
    if (!flag('sans-dynamique')) {
      const scenario = analyse.ctx ? chargerScenario(valeur('scenario', null)) : null;
      if (analyse.ctx) console.error("→ Analyse dynamique en condition réelle (axe D)… (navigateur Chromium, hôte Grist de test)");
      else console.error("→ Analyse dynamique non exécutée (l'analyse du code s'est interrompue avant l'inventaire : pas de point d'entrée à ouvrir).");
      const { constats: constatsD, nonExecute } = await auditerAxeD(analyse, { scenario });
      constats.push(...constatsD);
      if (nonExecute) axesNonExecutes.add('D');
    } else {
      axesNonExecutes.add('D');
      constats.push(constatAxeDIgnoreParOption());
      console.error('→ Analyse dynamique ignorée (--sans-dynamique).');
    }

    const notation = noter(constats, axesNonExecutes);
    console.error(`→ Verdict : ${notation.verdict} (score global ${notation.global}/100, ${notation.bloquants.length} bloquant(s))`);

    const commit = commitDepot(racine);
    const meta = { version: VERSION, nomDepot, commit, cible: temporaire ? cible : null, tronque: ctx.tronque };
    const md = genererMarkdown({ ctx, notation, meta });
    fs.writeFileSync(path.join(dossierSortie, 'rapport.md'), md, 'utf8');
    console.error(`→ Rapport écrit : ${path.join(dossierSortie, 'rapport.md')}`);

    if (flag('json')) {
      fs.writeFileSync(path.join(dossierSortie, 'rapport.json'), genererJson({ ctx, notation, meta }), 'utf8');
      console.error(`→ Rapport écrit : ${path.join(dossierSortie, 'rapport.json')}`);
    }

    if (!flag('sans-html')) {
      const corps = genererHtml({ ctx, notation, meta });
      // Le générateur produit <title>/<style> puis le contenu visible à la
      // suite ; on les répartit ici entre <head> et <body> pour un document
      // HTML valide, sans dupliquer de logique de mise en page.
      const [tete, corpsVisible] = corps.split(/\n<div class="page"/);
      const html = `<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${tete}\n</head>\n<body>\n<div class="page"${corpsVisible}\n</body>\n</html>\n`;
      fs.writeFileSync(path.join(dossierSortie, 'rapport.html'), html, 'utf8');
      console.error(`→ Rapport écrit : ${path.join(dossierSortie, 'rapport.html')} (ouvrable directement dans un navigateur)`);
    }

    if (flag('sarif')) {
      fs.writeFileSync(path.join(dossierSortie, 'rapport.sarif'), genererSarif({ ctx, notation, meta }), 'utf8');
      console.error(`→ Rapport écrit : ${path.join(dossierSortie, 'rapport.sarif')} (SARIF 2.1.0, pour ingestion CI)`);
    }

    process.exitCode = notation.bloquants.length ? 2 : (notation.verdict === 'CONFORME' ? 0 : 1);
  } finally {
    // La cible clonée est temporaire par construction (mkdtempSync) : rien ne
    // doit en survivre à l'exécution, succès ou erreur confondus.
    if (temporaire) fs.rmSync(racine, { recursive: true, force: true });
  }
}

/** Démarre l'interface web locale et attend indéfiniment (jusqu'à Ctrl+C). */
async function lancerInterface(valeur) {
  const port = Number(valeur('port', 4317));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Port invalide : ${valeur('port')}`);
    process.exit(1);
  }
  let hote;
  try {
    ({ hote } = await demarrerInterface({ port }));
  } catch (e) {
    if (e?.code === 'EADDRINUSE') {
      console.error(`Le port ${port} est déjà utilisé — une autre interface gwaudit tourne peut-être déjà. Réessayer avec --port <n>.`);
      process.exit(1);
    }
    throw e;
  }
  console.error(`→ Interface disponible sur http://${hote}:${port} (Ctrl+C pour arrêter)`);
  await new Promise(() => {}); // le serveur tourne tant que le process vit
}

/**
 * Charge et valide un scénario d'axe D personnalisé (--scenario). Un
 * scénario invalide dégrade vers le scénario par défaut plutôt que de faire
 * échouer tout l'outil : cohérent avec le reste de l'axe D (voir
 * D-INDISPONIBLE dans dynamique.js), un garde-fou qui échoue se désactive et
 * le dit, il n'empêche jamais le reste du rapport de sortir.
 */
function chargerScenario(cheminScenario) {
  if (!cheminScenario) return null;
  try {
    return validerScenario(JSON.parse(fs.readFileSync(path.resolve(cheminScenario), 'utf8')));
  } catch (e) {
    console.error(`⚠ Scénario d'axe D ignoré (${cheminScenario}) : ${e.message} — le scénario par défaut est utilisé à la place.`);
    return null;
  }
}

/**
 * Compare deux rapports `--json` déjà générés, sans relancer d'audit — pour
 * suivre l'effet d'un correctif ou gater une CI sur l'absence de régression.
 * Quitte le process (ne retourne jamais) : code 2 si des constats nouveaux
 * sont apparus (utile pour faire échouer une étape CI dessus), sinon 0.
 */
function diffRapports(argv) {
  const i = argv.indexOf('--diff');
  const ancienChemin = argv[i + 1];
  const nouveauChemin = argv[i + 2];
  if (!ancienChemin || !nouveauChemin || ancienChemin.startsWith('--') || nouveauChemin.startsWith('--')) {
    console.error('Usage : gwaudit --diff <ancien-rapport.json> <nouveau-rapport.json> [--sortie <fichier.md>]');
    console.error("Les deux fichiers doivent avoir été générés avec l'option --json.");
    process.exit(1);
  }
  const valeur = (nom, def) => { const idx = argv.indexOf(`--${nom}`); return idx >= 0 ? argv[idx + 1] : def; };

  let ancien, nouveau;
  try {
    ancien = JSON.parse(fs.readFileSync(path.resolve(ancienChemin), 'utf8'));
    nouveau = JSON.parse(fs.readFileSync(path.resolve(nouveauChemin), 'utf8'));
  } catch (e) {
    console.error(`Erreur de lecture des rapports à comparer : ${e.message}`);
    process.exit(3);
  }

  const diff = comparerRapports(ancien, nouveau);
  const md = genererDiffMarkdown(diff, { ancienChemin, nouveauChemin });

  const sortie = valeur('sortie', null);
  if (sortie) {
    fs.writeFileSync(path.resolve(sortie), md, 'utf8');
    console.error(`→ Comparaison écrite : ${path.resolve(sortie)}`);
  } else {
    console.log(md);
  }
  process.exit(diff.nouveaux.length ? 2 : 0);
}

/** Résout la cible en chemin local à auditer, et indique si ce chemin est un clone temporaire à purger après usage. */
async function resoudreCible(cible) {
  if (!/^(https?:\/\/|git@)/.test(cible)) {
    const abs = path.resolve(cible);
    if (!fs.existsSync(abs)) throw new CibleRefusee(`chemin introuvable : ${abs}`);
    return { racine: abs, temporaire: false, identite: path.basename(abs.replace(/\/$/, '')) };
  }

  await validerHoteClone(cible);

  // Sur le disque temporaire du système (`os.tmpdir()`), jamais à côté de
  // l'outil lui-même : même raison que le dossier isolé de npm audit
  // (e-dependances.js) et celui de l'axe D (dynamique.js) — dans l'image V2
  // (docker/execution/Dockerfile), RACINE_OUTIL vaut /app, en lecture seule
  // (docker-compose.v2-execution.yml, seul /tmp est inscriptible), et une
  // soumission distante est toujours une URL à cloner.
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-clone-'));
  console.error(`→ Clonage de ${cible}…`);
  try {
    // La sortie d'erreur de git est captée pour pouvoir dire pourquoi le clonage
    // a échoué (un refus du proxy de sortie n'est pas une panne de l'outil) ;
    // elle est réaffichée telle quelle en cas d'échec.
    execFileSync('git', ['clone', '--depth', '1', cible, dest], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 120_000 });
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    if (e?.code === 'ENOENT') throw e; // git absent : une panne d'installation, pas une cible refusée
    throw new CibleRefusee(expliquerEchecClonage(cible, e));
  }
  return { racine: dest, temporaire: true, identite: identiteDepuisUrl(cible) };
}

/** Erreur attribuable à la cible (refusée, injoignable, chemin faux) et non à l'outil : sortie nette, sans pile, code 4. */
class CibleRefusee extends Error {}

/** Pourquoi `git clone` a échoué, dit sans la pile de Node : refus du proxy de sortie, délai, ou dernières lignes de git. */
function expliquerEchecClonage(cible, e) {
  const sortieGit = String(e?.stderr ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  const dernieres = sortieGit.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
  if (/CONNECT tunnel failed, response 403|\b403\b.*Forbidden|Received HTTP code 403 from proxy/i.test(sortieGit)) {
    return `le proxy de sortie a refusé la connexion (403) pour ${cible} : hôte hors de la liste autorisée, ou nom qui résout vers une adresse interne. Détail de git : ${dernieres}`;
  }
  if (e?.killed || e?.signal === 'SIGTERM' || e?.code === 'ETIMEDOUT') return `le clonage de ${cible} n'a pas abouti dans le délai de 120 s.`;
  return `le clonage de ${cible} a échoué (git a rendu le code ${e?.status ?? 'inconnu'})${dernieres ? ` : ${dernieres}` : ''}`;
}

/** Dernier segment significatif de l'URL (nom de dépôt), pour nommer le rapport et l'identifier — pas le nom du dossier temporaire de clone, qui n'a aucun sens pour l'utilisateur. */
function identiteDepuisUrl(cible) {
  const sansGit = cible.replace(/\.git$/i, '');
  const segments = sansGit.split(/[/:]/).filter(Boolean);
  return segments[segments.length - 1] || sansGit;
}

/** Hash du commit HEAD du dépôt audité, quand c'en est un — rattache le rapport à un état précis du code plutôt qu'à une URL qui peut changer de contenu après coup. */
function commitDepot(racine) {
  try {
    return execFileSync('git', ['-C', racine, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Écarte les cibles de clonage qui pointent vers une adresse interne
 * (boucle locale, réseau privé, lien-local, métadonnées cloud) plutôt
 * qu'une vraie forge — évite qu'une URL malveillante fasse cloner
 * silencieusement une ressource interne à la machine qui exécute gwaudit.
 * Ne protège pas d'un DNS rebinding entre cette vérification et la
 * connexion que `git` ouvrira lui-même : en usage V1 local et de confiance,
 * l'objectif est seulement d'écarter les cibles manifestement internes, pas
 * de fournir la garantie anti-rebinding qu'exigerait un service exposé —
 * celle-ci revient à un proxy de sortie dédié côté V2 (docs/ARCHITECTURE-V2.md, §4).
 */
/**
 * Un `\` littéral dans une URL https:// est normalisé en `/` par le
 * parseur WHATWG de `new URL()` (schéma « spécial ») AVANT que la limite
 * d'autorité (userinfo@hôte) ne soit recherchée — mais `git`/libcurl, qui
 * clonera réellement la cible juste après cette validation, suit RFC 3986
 * à la lettre et ne fait rien de tel : pour
 * `https://hote-public.example\@CIBLE-INTERNE/x`, Node calcule
 * `hostname === "hote-public.example"` (validé, externe) alors que git se
 * connecte réellement à `CIBLE-INTERNE` (`\` devient un caractère anodin du
 * userinfo côté curl, pas un séparateur de chemin). Reproduit et confirmé
 * ici avec un vrai `git ls-remote` : le message d'erreur cite explicitement
 * l'hôte interne visé, pas l'hôte public placé avant le `\`. Rejeter tout
 * `\` littéral, et tout userinfo (`user[:pass]@`) même sans `\`, ferme
 * cette divergence de parseur plutôt que de faire confiance à
 * `new URL(...).hostname` comme oracle de ce que git contactera vraiment.
 */
function contientUserinfoOuBackslash(cible) {
  if (cible.includes('\\')) return true;
  try {
    const u = new URL(cible);
    return Boolean(u.username || u.password);
  } catch {
    return false;
  }
}

async function validerHoteClone(cible) {
  if (contientUserinfoOuBackslash(cible)) {
    throw new CibleRefusee(`Clonage refusé : l'URL contient un caractère '\\' ou des identifiants (userinfo) — les deux permettent de tromper la validation de l'hôte cible : ${cible}`);
  }
  let hote;
  if (/^https:\/\//i.test(cible)) {
    // Un littéral IPv6 garde ses crochets dans `hostname` (« [::1] ») : sans
    // eux, `net.isIP` le prend pour un nom et le contrôle des adresses
    // internes ne le voit plus.
    hote = new URL(cible).hostname.replace(/^\[(.*)\]$/, '$1');
  } else if (/^http:\/\//i.test(cible)) {
    throw new CibleRefusee(`Clonage refusé (http non chiffré) : ${cible} — utiliser une URL https:// ou git@.`);
  } else if (/^git@/i.test(cible)) {
    hote = cible.match(/^git@([^:]+):/i)?.[1];
  }
  if (!hote) throw new CibleRefusee(`Impossible de déterminer l'hôte cible pour : ${cible}`);

  // Zone d'exécution V2 : le conteneur n'a AUCUNE résolution DNS externe
  // (réseau interne, seul egress-proxy sort, docker-compose.v2-execution.yml)
  // — dns.lookup() y échoue pour tout hôte, donc la résolution ci-dessous
  // refuserait toute URL (vu à la première exécution de bout en bout, en CI).
  // Le nom est alors résolu, et l'adresse obtenue refusée si elle est
  // interne, par le proxy lui-même (acl « dst » de squid.conf, éprouvée par
  // docker/ci/verifier.sh : un nom autorisé qui résout vers 127.0.0.1 est
  // refusé), au moment même de la connexion — ce qui ferme aussi le DNS
  // rebinding que cette vérification-ci ne peut pas fermer. Jamais activé
  // sans proxy configuré, ni par défaut : l'usage V1 local garde la
  // vérification complète. Une adresse IP littérale reste vérifiée ici, comme un
  // nom que NO_PROXY fait joindre sans proxy : git s'y connecterait alors
  // directement, et personne d'autre ne vérifierait l'adresse.
  if (resolutionParProxy() && !net.isIP(hote) && !contourneLeProxy(hote)) {
    if (/^git@/i.test(cible)) {
      throw new CibleRefusee(`Clonage refusé : une URL SSH (git@) ne peut pas passer par le proxy de sortie de la zone d'exécution — utiliser une URL https:// : ${cible}`);
    }
    return;
  }

  const adresses = net.isIP(hote) ? [hote] : (await dns.lookup(hote, { all: true }).catch(() => [])).map((a) => a.address);
  if (!adresses.length) throw new CibleRefusee(`Résolution DNS impossible pour l'hôte de clonage : ${hote}`);
  for (const adresse of adresses) {
    if (estAdresseInterne(adresse)) {
      throw new CibleRefusee(`Clonage refusé : l'hôte ${hote} résout vers une adresse interne (${adresse}).`);
    }
  }
}

/** Vrai seulement si l'appelant (compose V2) l'a demandé ET qu'un proxy de sortie est réellement configuré : sans proxy, personne d'autre ne vérifierait l'adresse. */
function resolutionParProxy() {
  return process.env.GWAUDIT_RESOLUTION_PAR_PROXY === '1' && Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);
}

/**
 * Vrai si NO_PROXY / no_proxy fait joindre cet hôte sans proxy. git (libcurl)
 * lit les deux écritures ; `*` désigne tout hôte, une entrée `exemple.org` ou
 * `.exemple.org` désigne l'hôte et ses sous-domaines, un éventuel `:port` est
 * ignoré. Dans le doute, l'hôte est tenu pour contourné : la résolution locale
 * est alors exigée, ce qui échoue franchement là où il n'y a pas de DNS.
 */
function contourneLeProxy(hote) {
  const nom = hote.toLowerCase();
  for (const cle of ['NO_PROXY', 'no_proxy']) {
    for (const brute of String(process.env[cle] ?? '').split(',')) {
      const entree = brute.trim().toLowerCase().replace(/:\d+$/, '').replace(/^\./, '');
      if (!entree) continue;
      if (entree === '*' || nom === entree || nom.endsWith(`.${entree}`)) return true;
    }
  }
  return false;
}

function estAdresseInterne(adresse) {
  if (net.isIPv4(adresse)) {
    const [a, b] = adresse.split('.').map(Number);
    return a === 127 || a === 10 || a === 0
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(adresse)) {
    const a = adresse.toLowerCase();
    // IPv4 inscrit dans une adresse IPv6 (::ffff:a.b.c.d) : l'analyseur d'URL le
    // réécrit en hexadécimal (::ffff:7f00:1), forme que l'ancien test textuel
    // « ::ffff:127. » ne reconnaissait pas. On décode les 32 derniers bits et on
    // juge l'adresse IPv4 obtenue.
    const inscrit = /^(?:0{0,4}:){0,5}(?:ffff:)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(a);
    if (inscrit) {
      const v4 = inscrit[1] ?? `${parseInt(inscrit[2], 16) >> 8}.${parseInt(inscrit[2], 16) & 255}.${parseInt(inscrit[3], 16) >> 8}.${parseInt(inscrit[3], 16) & 255}`;
      return estAdresseInterne(v4);
    }
    return a === '::1' || a === '::' || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a);
  }
  return true;
}

main().catch((e) => {
  // Une cible refusée ou inaccessible n'est pas une panne de l'outil : message
  // net, pas de pile, code 4 — l'appelant (V2, interface) distingue ainsi « la
  // soumission est refusée » de « gwaudit a planté » (3).
  if (e instanceof CibleRefusee) { console.error(`Cible refusée ou inaccessible : ${e.message}`); process.exitCode = 4; return; }
  // L'enfant d'analyse n'a pas pu être lancé : une panne de l'outil ou de son environnement, pas un fait du widget (code 3, sans pile).
  if (e instanceof ErreurLancement) { console.error(`Erreur : ${e.message}`); process.exitCode = 3; return; }
  console.error('Erreur :', e?.stack ?? e);
  process.exitCode = 3;
});
