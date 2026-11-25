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
