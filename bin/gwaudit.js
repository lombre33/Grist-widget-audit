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
 */
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { auditDynamique } from '../src/runtime/dynamique.js';
import { noter } from '../src/moteur/notation.js';
import { genererMarkdown } from '../src/rapport/markdown.js';
import { genererJson } from '../src/rapport/json.js';
import { genererHtml } from '../src/rapport/html.js';

const RACINE_OUTIL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(RACINE_OUTIL, 'package.json'), 'utf8')).version;

async function main() {
  const argv = process.argv.slice(2);
  const cible = argv.find((a) => !a.startsWith('--'));
  const flag = (nom) => argv.includes(`--${nom}`);
  const valeur = (nom, def) => { const i = argv.indexOf(`--${nom}`); return i >= 0 ? argv[i + 1] : def; };

  if (!cible || flag('aide') || flag('help')) {
    console.log(`Usage : gwaudit <chemin-ou-url-du-widget> [--sans-dynamique] [--sans-reseau] [--sans-html] [--sortie <dossier>] [--json]`);
    // --aide/--help est une réussite (code 0) même sans cible : ce n'est une
    // erreur d'usage (code 1) que si ni l'un ni l'autre n'a été demandé.
    process.exit((flag('aide') || flag('help')) ? 0 : 1);
  }

  const { racine, temporaire, identite } = await resoudreCible(cible);
  try {
    const nomDepot = identite;
    const dossierSortie = path.resolve(valeur('sortie', `./rapport-${nomDepot}`));
    fs.mkdirSync(dossierSortie, { recursive: true });

    console.error(`→ Inventaire du dépôt : ${racine}`);
    const ctx = construireContexte(racine);
    console.error(`  ${ctx.fichiers.length} fichier(s), ${ctx.surface.size} dans la surface exécutée, point(s) d'entrée : ${ctx.entrees.join(', ') || '(aucun)'}`);
    if (ctx.tronque) {
      console.error(`  ⚠ Inventaire tronqué (dépôt anormalement volumineux) : ${ctx.tronque.fichiers ? `plus de ${ctx.tronque.maxFichiers} fichiers` : ''}${ctx.tronque.fichiers && ctx.tronque.octets ? ' et ' : ''}${ctx.tronque.octets ? `plus de ${Math.round(ctx.tronque.maxOctets / 1024 / 1024)} Mio de contenu lu` : ''} — le rapport porte sur une partie du dépôt seulement.`);
    }

    console.error('→ Analyse statique (axes A, B, C, E, F)…');
    const constats = await analyseStatique(ctx, { reseau: !flag('sans-reseau') });

    const axesNonExecutes = new Set();
    if (!flag('sans-dynamique')) {
      console.error("→ Analyse dynamique en condition réelle (axe D)… (navigateur Chromium, hôte Grist de test)");
      const { constats: constatsD, nonExecute } = await auditDynamique(ctx);
      constats.push(...constatsD);
      if (nonExecute) axesNonExecutes.add('D');
    } else {
      axesNonExecutes.add('D');
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

    process.exitCode = notation.bloquants.length ? 2 : (notation.verdict === 'CONFORME' ? 0 : 1);
  } finally {
    // La cible clonée est temporaire par construction (mkdtempSync) : rien ne
    // doit en survivre à l'exécution, succès ou erreur confondus.
    if (temporaire) fs.rmSync(racine, { recursive: true, force: true });
  }
}

/** Résout la cible en chemin local à auditer, et indique si ce chemin est un clone temporaire à purger après usage. */
async function resoudreCible(cible) {
  if (!/^(https?:\/\/|git@)/.test(cible)) {
    const abs = path.resolve(cible);
    if (!fs.existsSync(abs)) throw new Error(`Chemin introuvable : ${abs}`);
    return { racine: abs, temporaire: false, identite: path.basename(abs.replace(/\/$/, '')) };
  }

  await validerHoteClone(cible);

  const dest = fs.mkdtempSync(path.join(RACINE_OUTIL, '.tmp-clone-'));
  console.error(`→ Clonage de ${cible}…`);
  try {
    execFileSync('git', ['clone', '--depth', '1', cible, dest], { stdio: 'inherit', timeout: 120_000 });
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  return { racine: dest, temporaire: true, identite: identiteDepuisUrl(cible) };
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
async function validerHoteClone(cible) {
  let hote;
  if (/^https:\/\//i.test(cible)) {
    hote = new URL(cible).hostname;
  } else if (/^http:\/\//i.test(cible)) {
    throw new Error(`Clonage refusé (http non chiffré) : ${cible} — utiliser une URL https:// ou git@.`);
  } else if (/^git@/i.test(cible)) {
    hote = cible.match(/^git@([^:]+):/i)?.[1];
  }
  if (!hote) throw new Error(`Impossible de déterminer l'hôte cible pour : ${cible}`);

  const adresses = net.isIP(hote) ? [hote] : (await dns.lookup(hote, { all: true }).catch(() => [])).map((a) => a.address);
  if (!adresses.length) throw new Error(`Résolution DNS impossible pour l'hôte de clonage : ${hote}`);
  for (const adresse of adresses) {
    if (estAdresseInterne(adresse)) {
      throw new Error(`Clonage refusé : l'hôte ${hote} résout vers une adresse interne (${adresse}).`);
    }
  }
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
    return a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80:') || a.includes('::ffff:127.');
  }
  return true;
}

main().catch((e) => { console.error('Erreur :', e?.stack ?? e); process.exitCode = 3; });
