/**
 * Interface web minimale : un formulaire (lien du dépôt à auditer), le
 * suivi en direct de l'audit, puis la page de rapport déjà produite par le
 * moteur.
 *
 * Cette interface ne réimplémente rien de l'audit lui-même : elle pilote
 * `bin/gwaudit.js` en sous-processus et relaie ce qu'il imprime déjà sur
 * stdout/stderr. C'est délibéré — consommer la sortie déjà existante de la
 * CLI ne touche ni `src/moteur/` ni `src/runtime/`, propriétés d'autres
 * fils, et réutilise sans les dupliquer les protections déjà en place côté
 * CLI (validation SSRF de l'hôte cloné, timeout de clonage…).
 *
 * Pensée pour un usage local mono-utilisateur (le modèle de confiance de la
 * V1) : aucune authentification, aucun compte, liée à 127.0.0.1 par défaut.
 * Le fil V2 est responsable d'envelopper cette même interface d'isolation,
 * d'authentification et de quotas pour un usage exposé publiquement — ne
 * jamais la lier à une interface réseau publique telle quelle.
 */
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const BIN_GWAUDIT = path.resolve(ICI, '../../bin/gwaudit.js');

/**
 * Seuls les liens de dépôt sont acceptés (https:// ou git@), jamais un
 * chemin local. `bin/gwaudit.js` traite toute chaîne qui ne ressemble pas à
 * une URL comme un chemin de fichier LOCAL à auditer (comportement CLI
 * normal et voulu, voir `resoudreCible`) — une interface HTTP qui
 * relaierait tel quel un texte de formulaire laisserait n'importe quel
 * visiteur faire auditer, donc lire, un dossier quelconque de la machine
 * qui héberge l'interface. Ce filtre est une exigence de sécurité, pas une
 * simple validation de confort ; il s'ajoute à la validation SSRF déjà
 * faite par la CLI (`validerHoteClone`), pas à sa place.
 */
const MOTIF_LIEN_DEPOT = /^(https:\/\/\S+|git@\S+:\S+)$/;

const TAILLE_MAX_CORPS_REQUETE = 10_000;

/** Au-delà, l'audit lancé depuis l'interface est tué : un déclencheur HTTP est plus exposé à l'abus qu'une commande tapée à la main. */
const DELAI_GLOBAL_INTERFACE_MS = 5 * 60 * 1000;

/** Au-delà, les audits terminés les plus anciens sont purgés (mémoire ET dossier de sortie) : un serveur local qu'on laisse tourner longtemps ne doit pas croître sans borne. */
const MAX_AUDITS_CONSERVES = 50;

const audits = new Map();
let auditEnCours = false;

function purgerAnciensAudits() {
  if (audits.size <= MAX_AUDITS_CONSERVES) return;
  for (const [id, etat] of audits) {
    if (audits.size <= MAX_AUDITS_CONSERVES) break;
    if (etat.statut === 'en-cours') continue; // ne jamais purger un audit encore actif
    audits.delete(id);
    fs.rmSync(etat.dossierSortie, { recursive: true, force: true });
  }
}

function envoyerSse(res, evenement, data) {
  res.write(`event: ${evenement}\ndata: ${JSON.stringify(data)}\n\n`);
}

function diffuser(etat, evenement, data) {
  for (const client of etat.clientsSse) envoyerSse(client, evenement, data);
}

function echapperHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Nom de fichier suggéré pour un téléchargement, dérivé du dépôt plutôt que de l'id opaque. */
export function nomFichierSuggere(cible, extension) {
  const segment = cible.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() || 'widget';
  const nom = segment.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'widget';
  return `gwaudit-${nom}.${extension}`;
}

/**
 * Tue tout l'arbre de processus issu de `enfant` (pas seulement lui) : le
 * sous-processus `node bin/gwaudit.js` que nous lançons ici lance lui-même
 * Chromium (axe D) comme SON PROPRE enfant, donc petit-enfant du serveur —
 * `enfant.kill()` seul ne l'atteint pas et le laisserait tourner après le
 * délai global. Sur POSIX, `detached: true` (voir l'appel à spawn()
 * ci-dessous) fait de `enfant` le meneur d'un nouveau groupe de processus ;
 * signaler le PID négatif signale tout le groupe. Windows n'a pas cette
 * notion : `taskkill /T` fait l'équivalent (tuer l'arbre par PID racine).
 */
function tuerArbreProcessus(enfant) {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(enfant.pid), '/T', '/F'], () => {});
  } else {
    try { process.kill(-enfant.pid, 'SIGKILL'); }
    catch { enfant.kill('SIGKILL'); }
  }
}

/** Lance un audit en sous-processus et renvoie immédiatement son état (rempli au fil de l'exécution). */
function lancerAudit(cible) {
  const id = crypto.randomUUID();
  const dossierSortie = path.resolve(`./rapport-interface/${id}`);
  fs.mkdirSync(dossierSortie, { recursive: true });

  const etat = { id, cible, statut: 'en-cours', lignes: [], codeSortie: null, dossierSortie, clientsSse: new Set() };
  audits.set(id, etat);
  purgerAnciensAudits();

  let enfant;
  try {
    // Pas de shell (`shell: true` volontairement absent) : `cible` vient
    // d'un formulaire HTTP, elle est passée comme argument de tableau,
    // jamais interpolée dans une chaîne de commande — aucune injection
    // possible quel que soit son contenu. `detached` sur POSIX seulement :
    // voir tuerArbreProcessus() ci-dessus.
    enfant = spawn(process.execPath, [BIN_GWAUDIT, cible, '--json', '--sortie', dossierSortie], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch (e) {
    audits.delete(id);
    fs.rmSync(dossierSortie, { recursive: true, force: true });
    auditEnCours = false;
    throw e; // remonte au try/catch du handler HTTP, qui répond 500
  }

  const minuteur = setTimeout(() => {
    const texte = "⚠ Délai global de l'interface dépassé — audit interrompu.";
    etat.lignes.push(texte);
    diffuser(etat, 'ligne', { texte });
    tuerArbreProcessus(enfant);
  }, DELAI_GLOBAL_INTERFACE_MS);

  const suivreFlux = (flux) => {
    let reste = '';
    flux.on('data', (morceau) => {
      reste += morceau.toString('utf8');
      const lignes = reste.split('\n');
      reste = lignes.pop();
      for (const ligne of lignes) {
        if (!ligne) continue;
        etat.lignes.push(ligne);
        diffuser(etat, 'ligne', { texte: ligne });
      }
    });
    // Une dernière ligne sans '\n' final (flux terminé abruptement, ex. tué
    // par le minuteur ci-dessus) resterait sinon bloquée dans `reste` et ne
    // serait jamais diffusée.
    return () => {
      if (reste) {
        etat.lignes.push(reste);
        diffuser(etat, 'ligne', { texte: reste });
        reste = '';
      }
    };
  };
  const purgerStdout = suivreFlux(enfant.stdout);
  const purgerStderr = suivreFlux(enfant.stderr);

  enfant.on('close', (code) => {
    clearTimeout(minuteur);
    purgerStdout();
    purgerStderr();
    etat.codeSortie = code;
    // 0/1/2 sont les trois verdicts normaux de la CLI (conforme, conforme
    // sous réserve, non conforme) : un rapport a été écrit dans les trois
    // cas. 3 (erreur outil) ou tout autre code (ex. tué par le minuteur
    // ci-dessus) signifie qu'aucun rapport exploitable n'existe.
    etat.statut = [0, 1, 2].includes(code) ? 'termine' : 'echec';
    auditEnCours = false;
    diffuser(etat, 'fin', { codeSortie: code, statut: etat.statut });
    for (const client of etat.clientsSse) client.end();
    etat.clientsSse.clear();
  });

  enfant.on('error', (e) => {
    clearTimeout(minuteur);
    const texte = `⚠ Impossible de lancer l'audit : ${e.message}`;
    etat.lignes.push(texte);
    etat.statut = 'echec';
    auditEnCours = false;
    diffuser(etat, 'ligne', { texte });
    diffuser(etat, 'fin', { codeSortie: null, statut: 'echec' });
    for (const client of etat.clientsSse) client.end();
    etat.clientsSse.clear();
  });

  return etat;
}

function lireCorpsJson(req) {
  return new Promise((resolve, reject) => {
    let corps = '';
    let taille = 0;
    req.on('data', (morceau) => {
      taille += morceau.length;
      if (taille > TAILLE_MAX_CORPS_REQUETE) { req.destroy(); reject(new Error('Corps de requête trop volumineux.')); return; }
      corps += morceau;
    });
    req.on('end', () => {
      try { resolve(corps ? JSON.parse(corps) : {}); }
      catch { reject(new Error('JSON invalide.')); }
    });
    req.on('error', reject);
  });
}

const PAGE_ACCUEIL = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gwaudit — audit d'un widget Grist</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  input[type=url] { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; }
  button { margin-top: .8rem; padding: .6rem 1.2rem; font-size: 1rem; cursor: pointer; }
  .erreur { color: #b00020; margin-top: .6rem; }
  p.aide { color: #555; font-size: .9rem; }
</style>
</head>
<body>
<h1>Audit d'un widget Grist</h1>
<p class="aide">Lien du dépôt à auditer (GitHub, GitLab… — <code>https://</code> ou <code>git@</code>).</p>
<form id="form-audit">
  <input type="url" id="cible" name="cible" placeholder="https://github.com/…/mon-widget" required>
  <button type="submit">Lancer l'audit</button>
</form>
<div id="erreur" class="erreur" hidden></div>
<script>
document.getElementById('form-audit').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const cible = document.getElementById('cible').value.trim();
  const zoneErreur = document.getElementById('erreur');
  zoneErreur.hidden = true;
  try {
    const rep = await fetch('/audits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cible }) });
    const corps = await rep.json();
    if (!rep.ok) throw new Error(corps.erreur || 'Erreur inattendue.');
    window.location.href = '/audits/' + corps.id;
  } catch (e) {
    zoneErreur.textContent = e.message;
    zoneErreur.hidden = false;
  }
});
</script>
</body>
</html>`;

function pageSuivi(etat) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Audit en cours — gwaudit</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; word-break: break-all; }
  pre { background: #f4f4f4; padding: 1rem; white-space: pre-wrap; word-break: break-word; max-height: 60vh; overflow-y: auto; }
  a.bouton { display: inline-block; margin-top: 1rem; margin-right: .6rem; padding: .6rem 1.2rem; background: #1a1a1a; color: #fff; text-decoration: none; }
  a.bouton.secondaire { background: #fff; color: #1a1a1a; border: 1px solid #1a1a1a; }
  a.lien-retour { display: inline-block; margin-bottom: 1rem; color: #555; text-decoration: none; font-size: .9rem; }
  a.lien-retour:hover { text-decoration: underline; }
</style>
</head>
<body>
<a class="lien-retour" href="/">← Nouvel audit</a>
<h1>Audit de <span id="cible">${echapperHtml(etat.cible)}</span></h1>
<p id="statut">En cours…</p>
<pre id="journal" aria-live="polite"></pre>
<div id="actions"></div>
<script>
  const journal = document.getElementById('journal');
  const statut = document.getElementById('statut');
  const actions = document.getElementById('actions');
  const source = new EventSource('/audits/${etat.id}/evenements');
  source.addEventListener('ligne', (ev) => {
    const { texte } = JSON.parse(ev.data);
    journal.textContent += texte + '\\n';
    journal.scrollTop = journal.scrollHeight;
  });
  source.addEventListener('fin', (ev) => {
    const { statut: s } = JSON.parse(ev.data);
    source.close();
    if (s === 'termine') {
      statut.textContent = 'Terminé.';
      const lien = document.createElement('a');
      lien.className = 'bouton';
      lien.href = '/audits/${etat.id}/rapport';
      lien.textContent = "Voir le rapport d'audit";
      actions.appendChild(lien);
      const lienRoadmap = document.createElement('a');
      lienRoadmap.className = 'bouton secondaire';
      lienRoadmap.href = '/audits/${etat.id}/roadmap';
      lienRoadmap.textContent = 'Par quoi commencer';
      actions.appendChild(lienRoadmap);
      const lienMd = document.createElement('a');
      lienMd.className = 'bouton secondaire';
      lienMd.href = '/audits/${etat.id}/rapport.md';
      lienMd.textContent = 'Télécharger en Markdown';
      actions.appendChild(lienMd);
      const lienJson = document.createElement('a');
      lienJson.className = 'bouton secondaire';
      lienJson.href = '/audits/${etat.id}/rapport.json';
      lienJson.textContent = 'Télécharger en JSON';
      actions.appendChild(lienJson);
    } else {
      statut.textContent = "Échec de l'audit — voir le journal ci-dessus.";
    }
  });
  source.onerror = () => { statut.textContent = 'Connexion perdue avec le serveur.'; };
</script>
</body>
</html>`;
}

/**
 * Page de rapport : une barre de navigation fixe (retour à l'accueil pour
 * auditer un autre widget, téléchargements) au-dessus du rapport lui-même
 * chargé dans un cadre — plutôt que d'injecter cette barre dans le HTML de
 * `rapport.html`, ce qui obligerait à connaître/modifier sa structure
 * (propriété du fil « Maquette HTML du rapport »). Le rapport reste sa
 * propre page, servie telle quelle par /rapport-brut.
 */
function pageRapport(etat) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rapport — gwaudit</title>
<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; }
  .barre { display: flex; align-items: center; gap: .3rem; padding: .6rem 1rem; background: #1a1a1a; color: #fff; flex-wrap: wrap; box-sizing: border-box; }
  .barre a { color: #fff; text-decoration: none; font-size: .85rem; padding: .35rem .7rem; border-radius: 4px; white-space: nowrap; }
  .barre a:hover { background: rgba(255,255,255,.15); }
  .barre a.retour { font-weight: 600; margin-right: .5rem; }
  .barre .sep { opacity: .35; margin: 0 .2rem; }
  iframe { width: 100%; height: calc(100% - 45px); border: 0; display: block; }
</style>
</head>
<body>
<div class="barre">
  <a class="retour" href="/">← Nouvel audit</a>
  <span class="sep">·</span>
  <a href="/audits/${etat.id}/roadmap">Par quoi commencer</a>
  <span class="sep">·</span>
  <a href="/audits/${etat.id}/rapport.md" download>Télécharger en Markdown</a>
  <a href="/audits/${etat.id}/rapport.json" download>Télécharger en JSON</a>
</div>
<iframe src="/audits/${etat.id}/rapport-brut" title="Rapport d'audit gwaudit"></iframe>
</body>
</html>`;
}

const LIBELLES_SEVERITE_ROADMAP = { critique: 'Critique', majeur: 'Majeur', mineur: 'Mineur', info: 'Info' };

/**
 * « Feuille de route » : le moteur (`noter()`, propriété du fil du
 * protocole) calcule déjà l'ordre — bloquants d'abord, puis par gain
 * réel estimé sur le score global — et l'expose tel quel sous
 * `rapport.json`.roadmap, sans mise en forme ni troncature. La mise en
 * forme lisible est ce qui manquait ; c'est elle qu'on écrit ici, sans
 * toucher à `src/rapport/` (propriété d'un autre fil).
 */
// Au-delà, les étapes suivantes sont repliées (sous <details>, jamais retirées ni
// tronquées : même bloc de données, juste pas ouvert par défaut) — sur un widget avec
// beaucoup de constats, la question « par quoi je commence » a sa réponse tout de suite
// à l'écran, sans faire défiler des dizaines de lignes pour la trouver.
const SEUIL_ETAPES_VISIBLES = 8;

function rendreEtapeRoadmap(item, rang) {
  const etiquettes = [
    item.bloquant ? '<span class="etq etq-bloquant">Bloquant</span>' : '',
    `<span class="etq etq-${echapperHtml(item.severite)}">${echapperHtml(LIBELLES_SEVERITE_ROADMAP[item.severite] ?? item.severite)}</span>`,
  ].join(' ');
  const nbFichiers = item.fichiers?.length ?? 0;
  const portee = item.occurrences > 1
    ? `${item.occurrences} occurrences${nbFichiers ? ` dans ${nbFichiers} fichier${nbFichiers > 1 ? 's' : ''}` : ''}`
    : (item.fichiers?.[0] ?? '');
  return `      <li class="etape">
        <span class="rang">${rang}</span>
        <div class="etape-corps">
          <p class="etape-titre">${etiquettes} ${echapperHtml(item.titre)}</p>
          <p class="etape-meta"><code class="regle">${echapperHtml(item.regle)}</code>${portee ? ' · ' + echapperHtml(portee) : ''}</p>
        </div>
      </li>`;
}

function pageRoadmap(etat, roadmap) {
  const visibles = roadmap.slice(0, SEUIL_ETAPES_VISIBLES);
  const repliees = roadmap.slice(SEUIL_ETAPES_VISIBLES);
  const lignesVisibles = visibles.map((item, i) => rendreEtapeRoadmap(item, i + 1)).join('\n');
  const lignesRepliees = repliees.map((item, i) => rendreEtapeRoadmap(item, SEUIL_ETAPES_VISIBLES + i + 1)).join('\n');

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Par quoi commencer — gwaudit</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 0 auto; padding: 0 1rem 3rem; color: #1a1a1a; }
  .barre { display: flex; align-items: center; gap: .3rem; padding: .8rem 0; flex-wrap: wrap; }
  .barre a { color: #1a1a1a; text-decoration: none; font-size: .85rem; padding: .35rem .3rem; }
  .barre a.retour { font-weight: 600; }
  .barre .sep { opacity: .35; margin: 0 .2rem; }
  h1 { font-size: 1.4rem; word-break: break-all; }
  p.aide { color: #555; font-size: .9rem; }
  ol.feuille { list-style: none; margin: 1.5rem 0 0; padding: 0; }
  li.etape { display: flex; gap: .8rem; padding: .9rem 0; border-top: 1px solid #e2e2e2; }
  li.etape:first-child { border-top: none; }
  .rang { flex: none; width: 1.8rem; height: 1.8rem; border-radius: 50%; background: #1a1a1a; color: #fff; font-size: .85rem; font-weight: 600; display: flex; align-items: center; justify-content: center; }
  .etape-corps { min-width: 0; }
  .etape-titre { margin: 0 0 .25rem; font-weight: 500; }
  .etape-meta { margin: 0; font-size: .8rem; color: #666; }
  .etape-meta code.regle { background: #f4f4f4; border-radius: 4px; padding: 1px 5px; }
  .etq { display: inline-block; font-size: .7rem; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; border-radius: 4px; padding: 1px 6px; margin-right: .3rem; color: #fff; white-space: nowrap; }
  .etq-bloquant { background: #b00020; }
  .etq-critique { background: #b00020; }
  .etq-majeur { background: #b36b00; }
  .etq-mineur { background: #6b6b6b; }
  .etq-info { background: #9a9a9a; }
  details.suite { margin-top: 0; }
  details.suite summary { cursor: pointer; padding: .9rem 0; border-top: 1px solid #e2e2e2; font-weight: 600; color: #1a1a1a; }
  details.suite ol.feuille { margin-top: 0; }
</style>
</head>
<body>
<div class="barre">
  <a class="retour" href="/">← Nouvel audit</a>
  <span class="sep">·</span>
  <a href="/audits/${etat.id}/rapport">Voir le rapport complet</a>
  <span class="sep">·</span>
  <a href="/audits/${etat.id}/rapport.md" download>Télécharger en Markdown</a>
  <a href="/audits/${etat.id}/rapport.json" download>Télécharger en JSON</a>
</div>
<h1>Par quoi commencer — <span>${echapperHtml(etat.cible)}</span></h1>
<p class="aide">Classé du problème qui compte le plus pour la note — les points bloquants d'abord — au moins urgent, pas juste par gravité brute.</p>
${roadmap.length ? `<ol class="feuille">
${lignesVisibles}
    </ol>${repliees.length ? `
    <details class="suite">
      <summary>Voir les ${repliees.length} étape${repliees.length > 1 ? 's' : ''} suivante${repliees.length > 1 ? 's' : ''}</summary>
      <ol class="feuille">
${lignesRepliees}
      </ol>
    </details>` : ''}` : '<p class="aide">Rien à corriger : aucun constat sur ce widget.</p>'}
</body>
</html>`;
}

/**
 * Démarre l'interface. Liée à 127.0.0.1 par défaut — voir l'en-tête du
 * module. `GWAUDIT_INTERFACE_HOTE` permet de changer cette liaison
 * (nécessaire par exemple derrière l'isolation d'un conteneur V2, qui
 * gère alors elle-même ce qui est réellement exposé) : volontairement une
 * variable d'environnement plutôt qu'un simple drapeau CLI, pour qu'un
 * usage local ordinaire ne l'active jamais par accident.
 */
export function demarrerInterface({ port = 4317, hote = process.env.GWAUDIT_INTERFACE_HOTE || '127.0.0.1' } = {}) {
  const serveur = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE_ACCUEIL);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/audits') {
        // Le verrou est posé ICI, de façon synchrone, avant tout `await` —
        // pas dans lancerAudit(). Deux requêtes concurrentes exécutent ce
        // gestionnaire de façon entrelacée mais jamais préemptée entre deux
        // lignes synchrones : la première à atteindre cette ligne voit
        // `auditEnCours` faux, le met à vrai, et rend la seconde requête
        // (même arrivée dans le même tick) certaine de voir vrai à son
        // tour. Le poser plus tard (ex. après le `await` de lireCorpsJson)
        // laissait une fenêtre où les deux requêtes passaient le contrôle
        // avant qu'aucune n'ait posé le verrou — trouvé par revue
        // adversariale et reproduit avec un timing réseau réaliste.
        if (auditEnCours) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ erreur: "Un audit est déjà en cours sur cette interface. Attendre sa fin avant d'en lancer un autre." }));
          return;
        }
        auditEnCours = true;
        let corps;
        try { corps = await lireCorpsJson(req); }
        catch (e) {
          auditEnCours = false;
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ erreur: e.message }));
          return;
        }
        const cible = String(corps?.cible ?? '').trim();
        if (!MOTIF_LIEN_DEPOT.test(cible)) {
          auditEnCours = false;
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ erreur: "Lien de dépôt invalide : une URL https:// ou git@ est attendue, pas un chemin local." }));
          return;
        }
        let etat;
        try { etat = lancerAudit(cible); }
        catch (e) {
          auditEnCours = false;
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ erreur: `Impossible de lancer l'audit : ${e.message}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ id: etat.id }));
        return;
      }

      const mAudit = url.pathname.match(/^\/audits\/([0-9a-f-]{36})$/);
      if (req.method === 'GET' && mAudit) {
        const etat = audits.get(mAudit[1]);
        if (!etat) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Audit inconnu.'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageSuivi(etat));
        return;
      }

      const mEvenements = url.pathname.match(/^\/audits\/([0-9a-f-]{36})\/evenements$/);
      if (req.method === 'GET' && mEvenements) {
        const etat = audits.get(mEvenements[1]);
        if (!etat) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Audit inconnu.'); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        for (const ligne of etat.lignes) envoyerSse(res, 'ligne', { texte: ligne });
        if (etat.statut !== 'en-cours') {
          envoyerSse(res, 'fin', { codeSortie: etat.codeSortie, statut: etat.statut });
          res.end();
          return;
        }
        etat.clientsSse.add(res);
        req.on('close', () => etat.clientsSse.delete(res));
        return;
      }

      const mRapport = url.pathname.match(/^\/audits\/([0-9a-f-]{36})\/rapport$/);
      if (req.method === 'GET' && mRapport) {
        const etat = audits.get(mRapport[1]);
        if (!etat) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Audit inconnu.'); return; }
        if (!fs.existsSync(path.join(etat.dossierSortie, 'rapport.html'))) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end("Rapport pas (encore) disponible — voir le journal de l'audit pour la cause.");
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageRapport(etat));
        return;
      }

      const mRapportBrut = url.pathname.match(/^\/audits\/([0-9a-f-]{36})\/rapport-brut$/);
      if (req.method === 'GET' && mRapportBrut) {
        const etat = audits.get(mRapportBrut[1]);
        if (!etat) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Audit inconnu.'); return; }
        const cheminRapport = path.join(etat.dossierSortie, 'rapport.html');
        // Lire avant d'écrire l'en-tête : `fs.existsSync` suivi d'un
        // `readFileSync` séparé est lui-même un TOCTOU (le fichier peut
        // disparaître entre les deux, ex. purgerAnciensAudits() en
        // concurrence) — en capturant l'erreur ici plutôt qu'en la
        // laissant remonter après un `writeHead(200)` déjà envoyé, ce qui
        // planterait la requête sans réponse HTTP valide.
        let contenu;
        try { contenu = fs.readFileSync(cheminRapport, 'utf8'); }
        catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end("Rapport pas (encore) disponible — voir le journal de l'audit pour la cause.");
          return;
        }
        // Défense en profondeur : le rapport HTML est généré par le moteur
        // à partir de données d'un dépôt tiers (nom du widget, README...) —
        // même si `src/rapport/` échappe déjà son propre HTML, ces en-têtes
        // limitent les dégâts d'un contenu échappé qui aurait un trou.
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(contenu);
        return;
      }

      const mTelechargement = url.pathname.match(/^\/audits\/([0-9a-f-]{36})\/rapport\.(md|json)$/);
      if (req.method === 'GET' && mTelechargement) {
        const [, id, extension] = mTelechargement;
        const etat = audits.get(id);
        if (!etat) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Audit inconnu.'); return; }
        const cheminFichier = path.join(etat.dossierSortie, `rapport.${extension}`);
        let contenu;
        try { contenu = fs.readFileSync(cheminFichier, 'utf8'); }
        catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Rapport .${extension} pas (encore) disponible — voir le journal de l'audit pour la cause.`);
          return;
        }
        const typeContenu = extension === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8';
        res.writeHead(200, {
          'Content-Type': typeContenu,
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename="${nomFichierSuggere(etat.cible, extension)}"`,
        });
        res.end(contenu);
        return;
      }

      const mRoadmap = url.pathname.match(/^\/audits\/([0-9a-f-]{36})\/roadmap$/);
      if (req.method === 'GET' && mRoadmap) {
        const etat = audits.get(mRoadmap[1]);
        if (!etat) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Audit inconnu.'); return; }
        let roadmap;
        try { roadmap = JSON.parse(fs.readFileSync(path.join(etat.dossierSortie, 'rapport.json'), 'utf8')).roadmap ?? []; }
        catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end("Feuille de route pas (encore) disponible — voir le journal de l'audit pour la cause.");
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageRoadmap(etat, roadmap));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Introuvable.');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ erreur: String(e?.message ?? e) }));
    }
  });

  return new Promise((resolve, reject) => {
    serveur.once('error', reject);
    serveur.listen(port, hote, () => resolve({ serveur, port, hote }));
  });
}
