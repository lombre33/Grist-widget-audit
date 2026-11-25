/**
 * Une « phase » : le widget chargé par un vrai Grist, dans un Chromium neuf, à un niveau d'accès donné.
 * Le module ne juge rien : il rend ce qui a été observé (voir essais.js pour ce que cela veut dire).
 *
 * Confinement, comme l'axe D de la V1 : mêmes arguments de lancement (DNS coupé sauf boucle locale,
 * bac à sable natif, aucun proxy), et `context.route()` qui répond lui-même à toute requête qui ne va
 * ni vers l'instance Grist ni vers le serveur du widget : rien ne sort, mais tout est consigné.
 *
 * Observations passives posées sur chaque phase :
 *  - les échanges RPC du widget avec Grist : appels vus par la page Grist, réponses vues dans le cadre
 *    du widget (acceptés ou refusés par Grist selon le niveau) ;
 *  - ce que Grist a transmis au widget (un canari est-il arrivé ?) ;
 *  - les requêtes sortantes, avec la recherche des canaris dans l'adresse et le corps ;
 *  - les navigations du cadre parent, fenêtres ouvertes, boîtes de dialogue, téléchargements ;
 *  - la sonde de la charge XSS (voir donnees.js), lue dans le cadre du widget ;
 *  - le kit de la dépendance piégée (voir kit.js), joué dans le cadre du widget une fois l'observation terminée, si `kit` est fourni.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  avecDelai, construireArgsChromium, bacASableChromium, envChromiumSansProxy, cheminChromium,
} from '../dynamique.js';
import { estGrist } from '../../contexte/hotes-grist.js';
import { trouverCanari } from './donnees.js';
import { kitDependancePiegee, kitCanaux, kitEcritures, kitDroits, kitPollution, kitStockage, kitMessagesForges, kitApiInstance, poserSurfaceDeClic } from './kit.js';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE_OUTIL = path.resolve(ICI, '../../..');
const API_LOCALE = path.join(RACINE_OUTIL, 'ressources/grist-plugin-api/grist-plugin-api.js');

export async function lancerChromium(chromium) {
  return chromium.launch({
    args: construireArgsChromium(),
    env: envChromiumSansProxy(),
    executablePath: cheminChromium(chromium),
    chromiumSandbox: bacASableChromium(),
  });
}

/** Posé dans tous les cadres avant leur propre code. Page Grist : appels du widget. Cadre du widget : réponses et données reçues de Grist. */
function sondeInitiale({ prefixe, valeurs }) {
  const g = (window.__gw = window.__gw || { appels: [], reponses: [], canariRecu: false, hostileRecu: false, forgeRecu: 0 });
  const court = (x) => { try { return JSON.stringify(x).slice(0, 300); } catch { return String(x).slice(0, 300); } };
  if (window === window.top) {
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && typeof d === 'object' && d.mtype === 1 && typeof d.iface === 'string') {
        g.appels.push({ iface: d.iface, meth: d.meth, args: court(d.args), reqId: d.reqId });
      }
    }, true);
  } else {
    window.addEventListener('message', (e) => {
      // Message venu d'un cadre à l'origine opaque (« null ») : seul l'essai 4 en envoie, depuis un cadre voisin sans droit.
      if (e.origin === 'null') g.forgeRecu += 1;
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.mtype === 2 || d.mtype === 3) g.reponses.push({ mtype: d.mtype, reqId: d.reqId, mesg: typeof d.mesg === 'string' ? d.mesg.slice(0, 200) : undefined });
      // Grist transmet les données soit par un appel (mtype 1), soit en réponse à la lecture du widget (mtype 2).
      if (!g.hostileRecu && (d.mtype === 1 || d.mtype === 2)) { try { if (JSON.stringify(d).includes('gwaudit_pollue')) g.hostileRecu = true; } catch { /* message non sérialisable */ } }
      if (!g.canariRecu && (d.mtype === 1 || d.mtype === 2)) {
        try { const t = JSON.stringify(d); if (t.includes(prefixe) || t.includes('__gw_xss') || valeurs.some((v) => t.includes(JSON.stringify(v).slice(1, -1)))) g.canariRecu = true; } catch { /* message non sérialisable */ }
      }
    }, true);
  }
}

/** Ce que le widget a gardé dans le navigateur (voir kitStockage) et les cookies de son origine, vus par le navigateur : les canaris y sont cherchés, rien d'autre n'est rendu que des noms et des nombres. */
async function jouerStockage(contexte, cadre, origineWidget, jeu) {
  const dansCadre = await cadre.evaluate(kitStockage, { prefixe: jeu.prefixe, valeurs: jeu.valeursCherchees.slice(0, 60) });
  // Tous les cookies du contexte, filtrés par l'hôte du widget : `cookies([adresse])` écarte les cookies « Secure » d'une adresse http, alors que Chromium les accepte sur 127.0.0.1.
  const hote = hoteDe(origineWidget);
  const cookies = (await contexte.cookies()).filter((c) => String(c.domain).replace(/^\./, '') === hote).slice(0, 30).map((c) => ({ nom: String(c.name).slice(0, 60), httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, duree: c.expires === -1 ? 'session' : 'persistant', canari: !!trouverCanari(`${c.name} ${c.value}`, jeu) }));
  return { ...dansCadre, cookies };
}

/** Les droits du navigateur donnés au cadre, avec un vrai clic dans le widget et la relecture du presse-papier depuis la page Grist (voir kitDroits). */
async function jouerDroits(page, cadre, prefixe) {
  const marqueur = `${prefixe}-PRESSE-PAPIER-ECRIT-PAR-LE-CADRE`;
  const sentinelle = `${prefixe}-PRESSE-PAPIER-AVANT`;
  const relire = (attendu) => page.evaluate(async (a) => { try { return (await navigator.clipboard.readText()) === a ? 'attendu' : 'autre'; } catch (e) { return `erreur : ${String((e && e.message) || e).slice(0, 100)}`; } }, attendu);
  const sortie = {
    attributs: await page.evaluate(() => { const f = document.querySelector('iframe.custom_view'); return f ? { allow: f.getAttribute('allow'), sandbox: f.getAttribute('sandbox') } : null; }).catch(() => null),
    pagePosee: await page.evaluate(async (s) => { try { await navigator.clipboard.writeText(s); return true; } catch { return false; } }, sentinelle).catch(() => false),
  };
  sortie.pageRelit = sortie.pagePosee ? (await relire(sentinelle)) === 'attendu' : false;
  await cadre.evaluate(poserSurfaceDeClic);
  const element = await cadre.frameElement();
  await element.scrollIntoViewIfNeeded().catch(() => {});
  const boite = await element.boundingBox();
  sortie.clic = false;
  if (boite && boite.width >= 14 && boite.height >= 14) { await page.mouse.click(boite.x + 6, boite.y + 6); sortie.clic = true; }
  sortie.cadre = await cadre.evaluate(kitDroits, { marqueur });
  sortie.relu = sortie.pageRelit ? await relire(marqueur) : null; // « attendu » : le texte écrit par le cadre est dans le presse-papier
  return sortie;
}

/** En-têtes de sécurité de la page Grist elle-même (réponse du document), lus tels que le navigateur les a reçus. */
const ENTETES_SUIVIS = ['content-security-policy', 'x-frame-options', 'referrer-policy', 'x-content-type-options'];
async function entetesDe(reponse) {
  try {
    const h = await reponse.allHeaders();
    return { statut: reponse.status(), entetes: Object.fromEntries(ENTETES_SUIVIS.filter((k) => h[k] !== undefined).map((k) => [k, String(h[k]).slice(0, 500)])) };
  } catch { return null; }
}

/**
 * Essai 14 : une pièce jointe HTML du document, servie par l'instance, s'exécute-t-elle sur l'origine de Grist ? Si oui, un widget qu'on y logerait lirait
 * la page Grist qui l'encadre (`window.parent.document`) et en contournerait les niveaux d'accès. La charge ne fait que noter l'origine où elle s'exécute.
 * Les en-têtes sont lus par une requête de l'outil ; le comportement, par un vrai navigateur muni de la session.
 */
export const PAGE_PIEGE_PIECE_JOINTE = '<!doctype html><meta charset="utf-8"><title>gwaudit</title><h1>gwaudit</h1><script>window.__gw_exec = location.origin;</script>';
export async function jouerPieceJointe({ navigateur, base, cookies, docId, pieceId, delaiMs = 20_000 }) {
  const url = `${base}/o/docs/api/docs/${docId}/attachments/${pieceId}/download`;
  const sortie = { origineGrist: origineDe(base), statut: null, entetes: {}, telechargement: false, executeDans: null, affichee: false, erreur: null };
  try {
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const r = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(10_000) });
    sortie.statut = r.status;
    for (const k of ['content-type', 'content-disposition', 'content-security-policy', 'x-content-type-options']) { const v = r.headers.get(k); if (v) sortie.entetes[k] = v.slice(0, 300); }
  } catch (e) { sortie.erreur = String(e?.message ?? e).slice(0, 200); return sortie; }
  const contexte = await navigateur.newContext({ locale: 'fr-FR' });
  try {
    await contexte.addCookies(cookies.map((c) => ({ ...c, url: base })));
    const page = await contexte.newPage();
    page.on('download', (d) => { sortie.telechargement = true; d.cancel().catch(() => {}); });
    try { await page.goto(url, { waitUntil: 'load', timeout: delaiMs }); sortie.affichee = true; }
    catch (e) { if (/Download is starting/i.test(String(e?.message))) sortie.telechargement = true; else sortie.erreur = String(e?.message ?? e).slice(0, 200); }
    if (sortie.affichee) { await page.waitForTimeout(1000); sortie.executeDans = await page.evaluate(() => (typeof window.__gw_exec === 'string' ? window.__gw_exec : null)).catch(() => null); }
  } finally { await contexte.close().catch(() => {}); }
  return sortie;
}

const hoteDe = (url) => { try { return new URL(url).hostname; } catch { return null; } };
const origineDe = (url) => { try { return new URL(url).origin; } catch { return null; } };
const urlSansAncre = (url) => { try { const u = new URL(url); u.hash = ''; return u.href; } catch { return url; } };

/**
 * @param {object} p
 * @param {import('playwright').Browser} p.navigateur
 * @param {string} p.base          origine de l'instance Grist (http://localhost:<port>)
 * @param {Array<{name: string, value: string}>} p.cookies  session de l'utilisateur par défaut
 * @param {string} p.chemin        chemin de la page du document
 * @param {string} p.origineWidget origine du serveur du widget
 * @param {Map<string, object>} [p.servies]  bibliothèques du widget téléchargées par l'outil (voir bibliotheques.js), servies à la place de l'Internet coupé
 * @param {object} p.jeu           voir donnees.js
 * @param {boolean} [p.lireMarqueurs]  lit dans le cadre du widget les marqueurs que posent les bibliothèques altérées (voir `alterer` dans bibliotheques.js)
 * @param {object} [p.canaux]     paramètres du kit des canaux de sortie (voir kitCanaux) : s'il est fourni, il est joué dans le cadre du widget
 * @param {{docId: string, table: string}} [p.apiInstance]  joue l'essai 20 (voir kitApiInstance) : l'API de l'instance appelée avec la session, depuis le cadre du widget puis, comme témoin, depuis la page Grist
 * @param {object} [p.messages]  `{hote, marqueur}` : joue l'essai 4 (voir kitMessagesForges), des messages forgés envoyés au widget par un cadre voisin
 * @param {boolean} [p.stockage]  lit dans le cadre ce que le widget a gardé dans le navigateur, et ses cookies (voir kitStockage), avant les autres kits
 * @param {object} [p.pollution]  clés cherchées dans `Object.prototype` (voir kitPollution) : si fourni, joué dans le cadre du widget ; les lignes hostiles doivent être déjà dans la table (voir `ajouterDonneesHostiles`)
 * @param {boolean} [p.droits]    joue le kit des droits du navigateur donnés au cadre (voir kitDroits), avec un vrai clic de l'audit dans le widget ; l'écriture du presse-papier est accordée à la page Grist, comme le fait un Chrome ordinaire pour l'onglet actif
 * @param {object} [p.ecritures]  identifiants des tables sacrifiées (voir kitEcritures) : si fourni, le kit des écritures est joué dans le cadre du widget, en tout dernier
 * @param {object} [p.kit]         paramètres du kit de la dépendance piégée (voir kit.js) : s'il est fourni, il est joué dans le cadre du widget
 * @param {number} [p.delaiMs]
 */
export async function jouerPhase({ navigateur, base, cookies, chemin, origineWidget, jeu, servies, kit, canaux, ecritures, droits, pollution, stockage, messages, apiInstance, lireMarqueurs, delaiMs = 45_000 }) {
  const obs = {
    charge: false, appelsRpc: [], configure: null, canariRecu: false, texteDuCadre: '',
    xss: { executions: 0, lu: null, refus: null, erreur: null },
    requetesExternes: [], apiSubstituee: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], bibliothequesServies: 0, dependancesNonResolues: [], kit: null, alteration: null, canaux: null, ecritures: null, droits: null, pollution: null, stockage: null, messages: null, apiInstance: null, hostileRecu: false, entetesPage: null,
    consoles: [], erreursPage: [], erreur: null,
  };
  const origineGrist = origineDe(base);
  let apiDeInstance;
  const contexte = await navigateur.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
  let page;
  try {
    await contexte.addCookies(cookies.map((c) => ({ ...c, url: base })));
    // Un Chrome ordinaire accorde l'écriture au presse-papier à la page de l'onglet actif (et, par délégation, au cadre que Grist y autorise) ; Playwright, non : on le lui accorde pour la page Grist seule, jamais pour l'origine du widget.
    if (droits) await contexte.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: origineGrist });
    await contexte.addInitScript(sondeInitiale, { prefixe: jeu.prefixe, valeurs: jeu.valeursCherchees.slice(0, 40) });

    const notifier = (p) => {
      p.on('dialog', (d) => { obs.dialogues.push({ type: d.type(), message: d.message().slice(0, 200) }); d.dismiss().catch(() => {}); });
      p.on('download', (d) => { obs.telechargements.push({ nom: d.suggestedFilename() }); d.cancel().catch(() => {}); });
    };

    await contexte.route('**/*', async (route) => {
      const req = route.request(); const url = req.url(); const o = origineDe(url);
      if (/\/grist-plugin-api\.js(\?|$)/i.test(url) && o !== origineGrist && o !== origineWidget) {
        // Le widget charge l'API depuis un hôte Grist ou tiers : on lui sert celle de l'instance (la vraie, de cette version), pour que le scénario continue.
        if (!estGrist(hoteDe(url))) obs.apiSubstituee.push({ url, methode: req.method() });
        try {
          apiDeInstance ??= await fetch(`${base}/grist-plugin-api.js`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))));
          return route.fulfill({ status: 200, contentType: 'text/javascript', body: apiDeInstance });
        } catch { return route.fulfill({ path: API_LOCALE, contentType: 'text/javascript' }); }
      }
      if (o === origineGrist || o === origineWidget) return route.continue();
      // Une bibliothèque que le widget déclare et que l'outil a téléchargée avant les essais : servie telle quelle, rien n'a quitté la machine pendant l'essai.
      const servie = req.method() === 'GET' ? servies?.get(urlSansAncre(url)) : null;
      if (servie) {
        obs.bibliothequesServies += 1;
        const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
        return route.fulfill(servie.status === 200
          ? { status: 200, contentType: servie.type, body: servie.corps, headers: cors }
          : { status: servie.status, headers: { ...cors, location: servie.location } });
      }
      let provenance = 'grist';
      try {
        const f = req.frame();
        if (f.page() !== page) provenance = 'fenetre';
        else if (f !== page.mainFrame()) provenance = 'widget';
      } catch { provenance = 'inconnue'; }
      const corps = req.method() !== 'GET' ? (req.postData() ?? '').slice(0, 2000) : null;
      if (req.resourceType() === 'script' && provenance === 'widget' && obs.dependancesNonResolues.length < 20) obs.dependancesNonResolues.push({ url: url.slice(0, 300), hote: hoteDe(url) });
      const enregistrement = {
        url: url.slice(0, 2000), methode: req.method(), hote: hoteDe(url), type: req.resourceType(), provenance,
        canari: trouverCanari(`${url} ${corps ?? ''}`, jeu),
      };
      if (corps) enregistrement.corps = corps.slice(0, 300);
      obs.requetesExternes.push(enregistrement);
      if (req.isNavigationRequest() && provenance !== 'fenetre') {
        try { if (req.frame() === page.mainFrame()) obs.navigations.push({ url: url.slice(0, 500) }); } catch { /* cadre disparu */ }
      }
      return route.fulfill({ status: 204, body: '' });
    });
    // Passe des canaux de sortie : les WebSocket ne sont pas interceptées, l'interception de Playwright (une WebSocket factice dans la page) échappe à la CSP et fausserait la mesure.
    if (!canaux) await contexte.routeWebSocket((u) => { const o = origineDe(u.href.replace(/^ws/, 'http')); return o !== origineGrist && o !== origineWidget; }, (ws) => {
      obs.requetesExternes.push({ url: ws.url().slice(0, 500), methode: 'WEBSOCKET', hote: hoteDe(ws.url().replace(/^ws/, 'http')), type: 'websocket', provenance: 'widget', canari: null });
      ws.close({ code: 1008, reason: "Connexion neutralisée par l'audit" });
    });

    page = await contexte.newPage();
    notifier(page);
    contexte.on('page', (p) => { if (p === page) return; notifier(p); obs.popups.push({ url: p.url().slice(0, 300) }); setTimeout(() => p.close().catch(() => {}), 1500); });
    page.on('console', (m) => {
      const t = m.text().slice(0, 500);
      obs.consoles.push({ type: m.type(), texte: t });
      if (/Unsafe (JavaScript )?attempt to initiate navigation/i.test(t)) obs.navigationsRefusees.push(t.slice(0, 300));
    });
    // Ressources du widget que son propre serveur n'a pas trouvées (ex. `/grist-plugin-api.js` demandé à la racine) : la raison la plus courante d'un widget qui n'échange rien avec Grist.
    page.on('response', (r) => { try { if (r.status() >= 400 && origineDe(r.url()) === origineWidget && obs.introuvables.length < 10) obs.introuvables.push({ chemin: new URL(r.url()).pathname.slice(0, 120), statut: r.status() }); } catch { /* réponse sans adresse exploitable */ } });
    page.on('pageerror', (e) => obs.erreursPage.push(String(e?.message ?? e).slice(0, 500)));

    const travail = (async () => {
      const reponsePage = await page.goto(base + chemin, { waitUntil: 'load', timeout: Math.max(5000, delaiMs - 15_000) });
      obs.entetesPage = reponsePage ? await entetesDe(reponsePage) : null;
      try { await page.waitForSelector('iframe.custom_view', { state: 'attached', timeout: 20_000 }); obs.charge = true; }
      catch { obs.erreur = "La page du document s'est chargée mais aucun cadre de widget n'y est apparu."; return; }

      // Attendre que les échanges RPC se calment (au plus ~12 s), puis laisser une charge asynchrone aboutir.
      let dernier = -1; let stable = 0;
      for (let i = 0; i < 24 && stable < 4; i++) {
        const n = await page.evaluate(() => window.__gw?.appels.length ?? 0).catch(() => -1);
        stable = (n === dernier && n > 0) ? stable + 1 : 0; dernier = n;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(2000);

      const appels = await page.evaluate(() => window.__gw?.appels ?? []).catch(() => []);
      const cadre = page.frames().find((f) => f !== page.mainFrame() && origineDe(f.url()) === origineWidget);
      let dansCadre = null;
      if (cadre) {
        dansCadre = await cadre.evaluate(() => ({
          reponses: window.__gw?.reponses ?? [], canariRecu: !!window.__gw?.canariRecu, hostileRecu: !!window.__gw?.hostileRecu,
          xss: window.__gw_xss || 0, lu: window.__gw_lu ?? null, refus: window.__gw_refus ?? null, erreur: window.__gw_err ?? null,
          texte: (document.documentElement?.innerText ?? '').slice(0, 20000),
        })).catch(() => null);
      }
      const reponses = new Map((dansCadre?.reponses ?? []).map((r) => [r.reqId, r]));
      obs.appelsRpc = appels.map((a) => {
        const r = a.reqId !== undefined ? reponses.get(a.reqId) : undefined;
        return { interface: a.iface, methode: a.meth, args: a.args, issue: !r ? 'sans_reponse' : (r.mtype === 3 ? 'refuse' : 'accepte'), ...(r?.mtype === 3 ? { erreur: r.mesg } : {}) };
      });
      const conf = appels.find((a) => a.iface === 'CustomSectionAPI' && a.meth === 'configure');
      if (conf) { try { obs.configure = JSON.parse(conf.args)?.[0] ?? null; } catch { obs.configure = { illisible: true }; } }
      if (dansCadre) {
        obs.canariRecu = dansCadre.canariRecu || !!trouverCanari(dansCadre.texte, jeu);
        obs.hostileRecu = dansCadre.hostileRecu;
        obs.texteDuCadre = dansCadre.texte.slice(0, 500);
        obs.xss = { executions: dansCadre.xss, lu: dansCadre.lu, refus: dansCadre.refus, erreur: dansCadre.erreur };
      }
      if (lireMarqueurs && cadre) obs.alteration = { executees: await cadre.evaluate(() => (Array.isArray(globalThis.__gw_altere) ? globalThis.__gw_altere.slice(0, 300).map(String) : [])).catch(() => []) };
      if (stockage && cadre) obs.stockage = await jouerStockage(contexte, cadre, origineWidget, jeu).catch((e) => ({ erreur: String(e?.message ?? e).slice(0, 200) }));
      if (droits && cadre) obs.droits = await jouerDroits(page, cadre, jeu.prefixe).catch((e) => ({ erreur: String(e?.message ?? e).slice(0, 200) }));
      if (pollution && cadre) obs.pollution = await cadre.evaluate(kitPollution, pollution).catch((e) => ({ erreur: String(e?.message ?? e).slice(0, 200) }));
      if (apiInstance && cadre) {
        const parametres = { base, docId: apiInstance.docId, table: apiInstance.table, prefixe: jeu.prefixe };
        const temoin = await page.evaluate(kitApiInstance, parametres).catch((e) => ({ erreur: String(e?.message ?? e).slice(0, 200) }));
        const widget = await cadre.evaluate(kitApiInstance, parametres).catch((e) => ({ erreur: String(e?.message ?? e).slice(0, 200) }));
        obs.apiInstance = { temoin, widget };
      }
      if (messages && cadre) {
        const avant = obs.requetesExternes.length;
        const envoi = await page.evaluate(kitMessagesForges, messages).catch((e) => ({ erreur: String(e?.message ?? e).slice(0, 200) }));
        await page.waitForTimeout(1500);
        // Le widget a pu naviguer ailleurs en obéissant au message : la lecture du cadre échoue alors, les requêtes vues suffisent.
        const apres = await cadre.evaluate(() => ({ executions: window.__gw_msg || 0, forgeRecu: window.__gw?.forgeRecu || 0 })).catch(() => ({ cadreIllisible: true }));
        obs.messages = { ...envoi, ...apres, requetes: obs.requetesExternes.slice(avant).filter((r) => r.hote === messages.hote).length };
      }
      if (canaux && cadre) obs.canaux = await cadre.evaluate(kitCanaux, canaux).catch((e) => ({ erreur: String(e?.message ?? e).slice(0, 200) }));
      // En tout dernier : l'écriture d'une règle d'accès fait recharger la page par Grist, le cadre disparaît (l'échec d'`evaluate` qui s'ensuit est attendu).
      if (ecritures && cadre) obs.ecritures = await cadre.evaluate(kitEcritures, ecritures).catch((e) => ({ erreur: String(e?.message ?? e).slice(0, 200), cadreRecharge: /detached|destroyed|navigation/i.test(String(e?.message ?? e)) }));
      if (kit && cadre) obs.kit = await cadre.evaluate(kitDependancePiegee, kit).catch((e) => ({ erreur: String(e?.message ?? e).slice(0, 200) }));
      try { if (origineDe(page.url()) !== origineGrist) obs.navigations.push({ url: page.url().slice(0, 500) }); } catch { /* page fermée */ }
    })();
    travail.catch(() => {}); // si le délai gagne, la fin tardive de ce travail (contexte fermé) ne doit pas remonter
    await avecDelai(travail, delaiMs, 'phase');
  } catch (e) {
    obs.erreur = String(e?.message ?? e).replace(/^DELAI_DEPASSE:/, 'délai dépassé : ').slice(0, 300);
  } finally {
    await contexte.close().catch(() => {});
  }
  return obs;
}
