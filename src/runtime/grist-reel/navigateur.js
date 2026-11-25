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
import { kitDependancePiegee } from './kit.js';

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
  const g = (window.__gw = window.__gw || { appels: [], reponses: [], canariRecu: false });
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
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.mtype === 2 || d.mtype === 3) g.reponses.push({ mtype: d.mtype, reqId: d.reqId, mesg: typeof d.mesg === 'string' ? d.mesg.slice(0, 200) : undefined });
      // Grist transmet les données soit par un appel (mtype 1), soit en réponse à la lecture du widget (mtype 2).
      if (!g.canariRecu && (d.mtype === 1 || d.mtype === 2)) {
        try { const t = JSON.stringify(d); if (t.includes(prefixe) || t.includes('__gw_xss') || valeurs.some((v) => t.includes(JSON.stringify(v).slice(1, -1)))) g.canariRecu = true; } catch { /* message non sérialisable */ }
      }
    }, true);
  }
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
 * @param {object} [p.kit]         paramètres du kit de la dépendance piégée (voir kit.js) : s'il est fourni, il est joué dans le cadre du widget
 * @param {number} [p.delaiMs]
 */
export async function jouerPhase({ navigateur, base, cookies, chemin, origineWidget, jeu, servies, kit, delaiMs = 45_000 }) {
  const obs = {
    charge: false, appelsRpc: [], configure: null, canariRecu: false, texteDuCadre: '',
    xss: { executions: 0, lu: null, refus: null, erreur: null },
    requetesExternes: [], apiSubstituee: [], navigations: [], navigationsRefusees: [], popups: [], dialogues: [], telechargements: [], introuvables: [], bibliothequesServies: 0, dependancesNonResolues: [], kit: null,
    consoles: [], erreursPage: [], erreur: null,
  };
  const origineGrist = origineDe(base);
  let apiDeInstance;
  const contexte = await navigateur.newContext({ locale: 'fr-FR', viewport: { width: 1280, height: 900 } });
  let page;
  try {
    await contexte.addCookies(cookies.map((c) => ({ ...c, url: base })));
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
    await contexte.routeWebSocket((u) => { const o = origineDe(u.href.replace(/^ws/, 'http')); return o !== origineGrist && o !== origineWidget; }, (ws) => {
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
      await page.goto(base + chemin, { waitUntil: 'load', timeout: Math.max(5000, delaiMs - 15_000) });
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
          reponses: window.__gw?.reponses ?? [], canariRecu: !!window.__gw?.canariRecu,
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
        obs.texteDuCadre = dansCadre.texte.slice(0, 500);
        obs.xss = { executions: dansCadre.xss, lu: dansCadre.lu, refus: dansCadre.refus, erreur: dansCadre.erreur };
      }
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
