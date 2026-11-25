/**
 * Petit client REST de l'instance jetable : tout ce que gwaudit demande à Grist passe ici, pour qu'un
 * changement de route ou de format entre deux versions de Grist se corrige à un seul endroit.
 *
 * Le jeu d'appels a été vérifié contre Grist Desktop 0.3.17 (voir grist-desktop.json). Le cookie de
 * session est celui que l'instance pose au premier passage sur `/` (GRIST_DESKTOP_AUTH=none).
 */
export class ErreurGrist extends Error {
  constructor(message, statut) { super(message); this.statut = statut; }
}

export function creerClient(base) {
  let cookies = '';
  const noter = (r) => {
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const nom = kv.slice(0, i); const val = kv.slice(i + 1);
      if (/Expires=Thu, 01 Jan 1970/i.test(c) || !val) continue;
      cookies = cookies.split('; ').filter((x) => x && !x.startsWith(`${nom}=`)).concat(`${nom}=${val}`).join('; ');
    }
  };
  async function appeler(methode, chemin, corps) {
    let url = chemin.startsWith('http') ? chemin : base + chemin;
    let m = methode; let c = corps;
    for (let saut = 0; saut < 6; saut++) {
      const r = await fetch(url, {
        method: m, redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { ...(cookies ? { cookie: cookies } : {}), ...(c ? { 'content-type': 'application/json' } : {}) },
        body: c ? JSON.stringify(c) : undefined,
      });
      noter(r);
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), url).href; m = 'GET'; c = undefined; continue; }
      const texte = await r.text();
      let corpsRendu; try { corpsRendu = JSON.parse(texte); } catch { corpsRendu = texte; }
      if (!r.ok) throw new ErreurGrist(`${methode} ${chemin} → ${r.status} ${String(texte).slice(0, 200)}`, r.status);
      return corpsRendu;
    }
    throw new ErreurGrist(`${methode} ${chemin} : trop de redirections`, 0);
  }

  const api = {
    /** Le cookie de la session de l'utilisateur par défaut, pour le navigateur (nom, valeur). */
    cookiesNavigateur() {
      return cookies.split('; ').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1) }; });
    },
    async ouvrirSession() { await appeler('GET', '/'); },
    async espaces() { return appeler('GET', '/o/docs/api/orgs/current/workspaces'); },
    async creerDocument(espaceId, nom) { return appeler('POST', `/o/docs/api/workspaces/${espaceId}/docs`, { name: nom }); },
    async creerTable(docId, id, colonnes) {
      return appeler('POST', `/o/docs/api/docs/${docId}/tables`, { tables: [{ id, columns: colonnes.map((c) => ({ id: c.id, fields: { type: c.type } })) }] });
    },
    async ajouterLignes(docId, tableId, lignes) {
      return appeler('POST', `/o/docs/api/docs/${docId}/tables/${tableId}/records`, { records: lignes.map((fields) => ({ fields })) });
    },
    async sql(docId, requete, args = []) { return appeler('POST', `/o/docs/api/docs/${docId}/sql`, { sql: requete, args }); },
    async actions(docId, listeActions) { return appeler('POST', `/o/docs/api/docs/${docId}/apply`, listeActions); },
    /** Dépose une pièce jointe dans le document (Grist exige l'en-tête `X-Requested-With` pour ce dépôt) ; rend son identifiant. */
    async televerser(docId, nom, type, contenu) {
      const formulaire = new FormData();
      formulaire.append('upload', new Blob([contenu], { type }), nom);
      const r = await fetch(`${base}/o/docs/api/docs/${docId}/attachments`, { method: 'POST', headers: { cookie: cookies, 'x-requested-with': 'XMLHttpRequest' }, body: formulaire, signal: AbortSignal.timeout(20_000) });
      const texte = await r.text();
      if (!r.ok) throw new ErreurGrist(`dépôt de pièce jointe → ${r.status} ${texte.slice(0, 200)}`, r.status);
      const id = JSON.parse(texte)?.[0];
      if (!Number.isInteger(id)) throw new ErreurGrist(`dépôt de pièce jointe : réponse inattendue ${texte.slice(0, 100)}`, 0);
      return id;
    },
    /** Les documents que l'instance connaît (verrou : doit être vide au départ). */
    async documentsConnus() {
      const espaces = await api.espaces();
      return espaces.flatMap((e) => (e.docs ?? []).map((d) => d.id));
    },
  };
  return api;
}
