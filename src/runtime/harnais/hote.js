/**
 * Hôte Grist minimal, côté navigateur.
 *
 * Ce script joue le rôle que joue `WidgetFrame.ts` dans le vrai Grist : il
 * négocie avec le widget via `grain-rpc` (le même canal RPC par-dessus
 * `postMessage` que produit le vrai `grist-plugin-api.js`, bundlé sans
 * modification dans build/grist-plugin-api.js) et implémente les quatre
 * interfaces que le widget peut appeler : GristDocAPI, GristView, WidgetAPI,
 * CustomSectionAPI.
 *
 * Ce n'est pas une instance Grist complète (pas de serveur, pas de moteur de
 * calcul, pas d'authentification) : c'est un partenaire RPC protocolairement
 * exact, qui rejoue un document minimal et enregistre tout ce que le widget
 * lui demande. Cette trace — pas une supposition sur le code — est ce que
 * l'axe D restitue.
 */
import { Rpc } from 'grain-rpc';

/**
 * @param {HTMLIFrameElement} iframe
 * @param {object} doc  { tableId, colonnes: {nom: [...valeurs]}, options }
 * @param {object} reglage { niveauAccorde }
 */
export function creerHoteGrist(iframe, doc, reglage = {}) {
  const journal = { appelsRpc: [], erreursRpc: [], configureRecu: null };
  const niveauAccorde = reglage.niveauAccorde ?? 'full';

  const rpc = new Rpc({
    sendMessage: (msg) => iframe.contentWindow.postMessage(msg, '*'),
    logger: {
      info: () => {}, warn: (m) => journal.erreursRpc.push(String(m)),
    },
  });
  window.addEventListener('message', (e) => {
    if (e.source !== iframe.contentWindow) return;
    rpc.receiveMessage(e.data);
  });

  let options = doc.options ? { ...doc.options } : null;
  const tablesAppats = doc.tablesAppats ?? [];

  const enregistrer = (nomInterface, methodes) => {
    const enveloppe = {};
    for (const [nom, fn] of Object.entries(methodes)) {
      enveloppe[nom] = async (...args) => {
        const appel = { interface: nomInterface, methode: nom, args, t: Date.now() };
        journal.appelsRpc.push(appel);
        try {
          const r = await fn(...args);
          appel.resultatResume = resumer(r);
          return r;
        } catch (err) {
          appel.erreur = String(err?.message ?? err);
          throw err;
        }
      };
    }
    // `grist-plugin-api.js` obtient `docApi` via `rpc.getStub("GristDocAPI@grist", ...)` :
    // le suffixe `@grist` fait porter chaque appel avec `mdest: 'grist'`, ce
    // qui fait passer grain-rpc par `this._forwarders` plutôt que par
    // `this._implMap` (voir node_modules/grain-rpc/dist/lib/rpc.js,
    // `_onMessageCall` : `call.mdest` déclenché en priorité sur `call.iface`).
    // `registerImpl('GristDocAPI@grist', …)` n'était donc jamais atteint —
    // silencieux, puisque l'échec ne remonte que dans `journal.erreursRpc`,
    // jamais en constat : `docApi.fetchTable`, `listTables`,
    // `applyUserActions` et `getAccessToken`, appelés directement par un
    // widget (pas seulement via `grist.ready()`), échouaient tous avec
    // `RPC_UNKNOWN_FORWARD_DEST` sans que rien ne le signale. Trouvé en
    // câblant la table appât (elle en dépend directement). Un forwarder
    // vers un objet local qui appelle l'enveloppe directement (même invocation
    // que `registerImpl` ferait) résout ce cas à un seul saut, sans avoir à
    // simuler le relais à trois entités que ce suffixe sert dans le vrai Grist.
    const idx = nomInterface.indexOf('@');
    if (idx === -1) {
      rpc.registerImpl(nomInterface, enveloppe);
    } else {
      const destination = nomInterface.slice(idx + 1);
      rpc.registerForwarder(destination, {
        forwardCall: (c) => enveloppe[c.meth](...c.args),
        forwardMessage: () => {},
      });
    }
  };

  const colonnesActuelles = () => ({ id: doc.colonnes.id ?? doc.colonnes.id, ...doc.colonnes });

  enregistrer('GristDocAPI@grist', {
    async getDocName() { return doc.nom ?? 'Document de test'; },
    // Une table appât est bien listée (`full` révèle tout le document dans
    // le vrai Grist aussi) : ce n'est pas l'énumération qui est le signal,
    // c'est la lecture d'une table qu'aucune interface ni déclaration du
    // widget ne justifiait — voir TABLE_APPAT_ID dans dynamique.js.
    async listTables() { return [doc.tableId, ...tablesAppats.map((t) => t.tableId)]; },
    async fetchTable(tableId) {
      const appat = tablesAppats.find((t) => t.tableId === tableId);
      return appat ? { id: appat.colonnes.id ?? [], ...appat.colonnes } : colonnesActuelles();
    },
    async applyUserActions(actions) {
      journal.actionsAppliquees = (journal.actionsAppliquees ?? []).concat(actions);
      return { retValues: actions.map(() => null) };
    },
    async getAccessToken() { return { token: 'jeton-de-test', baseUrl: location.origin + '/api/docs/test', ttlMsecs: 300000 }; },
  });

  enregistrer('GristView', {
    async fetchSelectedTable() { return colonnesActuelles(); },
    async fetchSelectedRecord(rowId) {
      const i = (doc.colonnes.id ?? []).indexOf(rowId);
      const rec = {};
      for (const [c, vs] of Object.entries(doc.colonnes)) rec[c] = vs[i < 0 ? 0 : i];
      return rec;
    },
    async allowSelectBy() {},
    async setSelectedRows() {},
    async setCursorPos() {},
  });

  enregistrer('WidgetAPI', {
    async getOptions() { return options; },
    async setOptions(o) { options = { ...(options ?? {}), ...o }; },
    async clearOptions() { options = null; },
    async setOption(k, v) { options = { ...(options ?? {}), [k]: v }; },
    async getOption(k) { return options ? options[k] : undefined; },
  });

  enregistrer('CustomSectionAPI', {
    async configure(req) {
      journal.configureRecu = req;
      journal.niveauDemande = req?.requiredAccess ?? null;
      return;
    },
    async mappings() { return null; },
  });

  rpc.on('message', (msg) => { journal.messagesRecus = (journal.messagesRecus ?? []).concat(msg); });
  rpc.processIncoming();

  return {
    journal,
    /** Envoie le message d'amorçage : niveau accordé, thème, tableId, mappings vides. */
    async demarrer() {
      await rpc.postMessage({
        tableId: doc.tableId,
        dataChange: true,
        mappingsChange: false,
        theme: { appearance: 'light', name: 'GristLight', colors: {} },
        settings: { accessLevel: niveauAccorde, linking: { asTarget: null, asSource: false } },
        fromReady: true,
      });
    },
    /** Simule une modification de cellule côté document : redéclenche onRecords côté widget. */
    async notifierChangement() {
      await rpc.postMessage({ tableId: doc.tableId, dataChange: true });
    },
  };
}

function resumer(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 500 ? s.slice(0, 500) + '…' : s;
  } catch { return String(v); }
}
