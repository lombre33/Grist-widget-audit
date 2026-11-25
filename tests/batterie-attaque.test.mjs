/**
 * D-XSS-02 / D-XSS-03 : la batterie de charges d'attaque jouée dans Chromium, sur une page à part. Les premiers essais n'ont pas besoin de navigateur (le catalogue, le document, les
 * constats) ; les suivants jouent un vrai widget qui échappe mal, et un qui échappe bien.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { axeDNonExecute } from './aide-chromium.mjs';
import { construireContexte } from '../src/contexte/inventaire.js';
import { auditDynamique, documentDeTest } from '../src/runtime/dynamique.js';
import { documentDeBatterie, adresseDeBatterie, messagesDeBatterie, constatsBatterie, NOMBRE_DE_CHARGES, ENTREES } from '../src/runtime/batterie-attaque.js';

const executee = (entree, famille = 'attr-focus', declenchement = 'affichage') => ({ entree, famille, contexte: 'valeur d\'attribut', declenchement });
const libelle = (c) => `${c.regle} ${c.severite} ${c.bloquant ? 'bloquant' : 'non bloquant'} ${c.confiance}`;

test("le document de la batterie : une ligne par charge en tête de chaque colonne de texte, les nombres restent des nombres, toutes les colonnes ont la même longueur", () => {
  const base = documentDeTest(null);
  const doc = documentDeBatterie(base);
  const longueurs = new Set(Object.values(doc.colonnes).map((c) => c.length));
  assert.equal(longueurs.size, 1, 'une colonne plus courte que les autres décalerait les lignes');
  assert.equal([...longueurs][0], base.colonnes.Nom.length + NOMBRE_DE_CHARGES);
  assert.ok(doc.colonnes.Nom.slice(0, NOMBRE_DE_CHARGES).every((c) => typeof c === 'string' && c.includes('window.top.__poc_atq_cellule|=')), 'chaque ligne de tête porte sa charge');
  assert.ok(doc.colonnes.Montant.slice(0, NOMBRE_DE_CHARGES).every((v) => v === 0), 'une colonne de nombres garde des nombres');
  assert.equal(new Set(doc.colonnes.id).size, doc.colonnes.id.length, 'des identifiants de ligne uniques');
  assert.deepEqual(doc.colonnes._GwauditBatterieListe[0].slice(0, 1), ['L'], 'une colonne de liste, au format de Grist');
  // Les noms de colonne et les options sont aussi des charges, et la base n'est pas modifiée.
  assert.ok(Object.keys(doc.colonnes).some((nom) => nom.includes('window.top.__poc_atq_entete|=')));
  assert.ok(Object.values(doc.options).every((v) => v.includes('window.top.__poc_atq_options|=')));
  assert.equal(base.colonnes.Nom.length, 3);
  assert.equal(base.options, undefined);
});

test("chaque charge pose son propre bit, avec un code sans guillemet, sans chevron et sans espace ; l'adresse et les messages en portent aussi", () => {
  const doc = documentDeBatterie(documentDeTest(null));
  const bits = doc.colonnes._GwauditBatterie.slice(0, NOMBRE_DE_CHARGES).map((c) => Number(/__poc_atq_cellule\|=(\d+)/.exec(c)[1]));
  assert.equal(new Set(bits).size, NOMBRE_DE_CHARGES, 'un bit par famille');
  assert.ok(Math.max(...bits) < 2 ** 30, "tient dans l'entier de 32 bits qu'un |= manipule");
  for (const c of doc.colonnes._GwauditBatterie.slice(0, NOMBRE_DE_CHARGES)) assert.match(/window\.top\.__poc_atq_cellule\|=\d+/.exec(c)[0], /^[A-Za-z0-9_.|=]+$/);
  const adresse = adresseDeBatterie('http://127.0.0.1:1/widget/index.html');
  assert.match(adresse, /^http:\/\/127\.0\.0\.1:1\/widget\/index\.html\?q=.+&query=.+#.+/);
  assert.doesNotMatch(adresse.split('#')[0].split('?')[1], /[<>" ]/, 'encodée');
  const messages = messagesDeBatterie();
  assert.equal(messages.length, 4);
  assert.equal(typeof messages[0], 'string');
  assert.equal(typeof messages[1], 'object');
  assert.equal(JSON.parse(messages[2]).html, messages[1].html, 'le même objet, en JSON');
  assert.ok(Array.isArray(messages[3]));
});

test("un scénario à soi : ses colonnes gardent leur forme, une colonne qui n'est pas du texte reçoit sa première valeur", () => {
  const base = documentDeTest({ tableId: 'T', colonnes: { id: [1, 2], Nom: ['a', 'b'], Date: [['L', 'x'], ['L', 'y']], Total: [10, 20] } });
  const doc = documentDeBatterie(base);
  assert.equal(doc.tableId, 'T');
  assert.equal(new Set(Object.values(doc.colonnes).map((c) => c.length)).size, 1);
  assert.deepEqual(doc.colonnes.Date[0], ['L', 'x']);
  assert.equal(doc.colonnes.Total[0], 0);
  assert.ok(doc.colonnes._GwauditSondeXss, 'la sonde simple du scénario reste');
});

test("les constats : critique et bloquant par une cellule, un nom de colonne ou une option ; majeur par un message seul ; mineur par l'adresse seule ; information quand rien ne s'exécute", () => {
  const [critique] = constatsBatterie({ jouee: true, executees: [executee('cellule'), executee('options', 'html-img')], donneesLues: true });
  assert.equal(libelle(critique), 'D-XSS-02 critique bloquant prouve');
  assert.match(critique.titre, /2 entrées/);
  assert.match(critique.constat, /une valeur de cellule : valeur d'attribut, à l'affichage \| les options du widget/);
  const [apresGeste] = constatsBatterie({ jouee: true, executees: [executee('cellule', 'lien-javascript', 'clic')], donneesLues: true });
  assert.match(apresGeste.constat, /après un clic simulé/);
  assert.equal(libelle(constatsBatterie({ jouee: true, executees: [executee('message')], donneesLues: true })[0]), 'D-XSS-02 majeur non bloquant prouve');
  assert.equal(libelle(constatsBatterie({ jouee: true, executees: [executee('url')], donneesLues: true })[0]), 'D-XSS-02 mineur non bloquant prouve');
  assert.equal(libelle(constatsBatterie({ jouee: true, executees: [executee('url'), executee('message')], donneesLues: true })[0]), 'D-XSS-02 majeur non bloquant prouve', 'la plus haute des entrées');
  const [rien] = constatsBatterie({ jouee: true, executees: [], donneesLues: true });
  assert.equal(libelle(rien), 'D-XSS-03 info non bloquant certain');
  assert.match(rien.impact, /n'est pas une preuve d'absence/);
  assert.doesNotMatch(rien.constat, /aucune donnée du document/);
  assert.match(constatsBatterie({ jouee: true, executees: [], donneesLues: false })[0].constat, /n'a lu aucune donnée du document/);
  assert.match(constatsBatterie({ jouee: false, raison: 'delai' })[0].constat, /délai dépassé/);
  assert.deepEqual(constatsBatterie(null), []);
  assert.deepEqual(Object.keys(ENTREES), ['cellule', 'entete', 'options', 'url', 'message']);
});

/** Un widget d'essai : `app.js` est son code ; il lit les données (`onRecords`) et rend ce qu'il veut. */
function widget(t, app) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-batterie-'));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  fs.writeFileSync(path.join(racine, 'index.html'),
    '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Widget de test</title><script src="https://docs.getgrist.com/grist-plugin-api.js"></script></head>'
    + '<body><main id="app"></main><script src="app.js"></script></body></html>');
  fs.writeFileSync(path.join(racine, 'app.js'), app);
  return racine;
}

test("un widget qui échappe < et > mais pas les guillemets : la charge simple passe, la batterie l'attrape (D-XSS-02), et son trafic n'entre pas dans les constats réseau", async (t) => {
  const racine = widget(t, [
    "grist.ready({ requiredAccess: 'full' });",
    "const esc = (v) => String(v).replace(/</g, '&lt;').replace(/>/g, '&gt;');",
    "grist.onRecords((rows) => { document.getElementById('app').innerHTML = rows.map((r) => `<input value=\"${esc(r.Nom)}\">`).join(''); });",
  ].join('\n'));
  const { constats, brut, nonExecute } = await auditDynamique(construireContexte(racine), {});
  if (nonExecute) { axeDNonExecute(t, constats); return; }
  assert.equal(constats.some((c) => c.regle === 'D-XSS-01'), false, 'la charge simple, avec ses chevrons, est neutralisée');
  const d = constats.find((c) => c.regle === 'D-XSS-02');
  assert.ok(d, `D-XSS-02 attendu : ${constats.map((c) => c.regle).join(' ')}`);
  assert.equal(libelle(d), 'D-XSS-02 critique bloquant prouve');
  assert.match(d.constat, /une valeur de cellule : .*gestionnaire ajouté sans balise/);
  assert.equal(constats.some((c) => c.regle === 'D-RESEAU-01'), false);
  assert.equal(brut.requetes.length, 0);
});

test("un widget qui rend en HTML ses options, le texte d'un message, l'ancre de son adresse et les noms de colonnes : D-XSS-02 nomme les quatre entrées", async (t) => {
  const racine = widget(t, [
    "grist.ready({ requiredAccess: 'full' });",
    "const app = document.getElementById('app');",
    "grist.onOptions((options) => { if (options && options.title) app.innerHTML += options.title; });",
    "window.addEventListener('message', (e) => { if (typeof e.data === 'string') app.innerHTML += e.data; });",
    "app.innerHTML += decodeURIComponent(location.hash.slice(1));",
    "grist.onRecords((rows) => { app.innerHTML += Object.keys(rows[0] || {}).map((c) => `<th>${c}</th>`).join(''); });",
  ].join('\n'));
  const { constats, nonExecute } = await auditDynamique(construireContexte(racine), {});
  if (nonExecute) { axeDNonExecute(t, constats); return; }
  const d = constats.find((c) => c.regle === 'D-XSS-02');
  assert.ok(d, `D-XSS-02 attendu : ${constats.map((c) => c.regle).join(' ')}`);
  assert.match(d.constat, /les options du widget : texte HTML/);
  assert.match(d.constat, /un message envoyé par une autre fenêtre : texte HTML/);
  assert.match(d.constat, /l'adresse du widget \(paramètres ou ancre\) : texte HTML/);
  assert.match(d.constat, /un nom de colonne : texte HTML/);
  assert.equal(d.severite, 'critique', 'les options valent une cellule');
});

test("un widget qui ne croit que son parent refuse le message d'un cadre voisin : rien n'est dit de ce message", async (t) => {
  const racine = widget(t, [
    "grist.ready({ requiredAccess: 'full' });",
    "window.addEventListener('message', (e) => { if (e.source === window.parent && typeof e.data === 'string') document.getElementById('app').innerHTML = e.data; });",
  ].join('\n'));
  const { constats, nonExecute } = await auditDynamique(construireContexte(racine), {});
  if (nonExecute) { axeDNonExecute(t, constats); return; }
  assert.equal(constats.some((c) => c.regle === 'D-XSS-02'), false, "l'hôte n'est pas le cadre voisin : un contrôle de la source suffit");
  assert.ok(constats.some((c) => c.regle === 'D-XSS-03'));
});

test("un widget qui rend tout en texte : aucune charge ne s'exécute, D-XSS-03 dit ce qui a été joué", async (t) => {
  const racine = widget(t, [
    "grist.ready({ requiredAccess: 'full' });",
    "grist.onRecords((rows) => { document.getElementById('app').textContent = rows.map((r) => r.Nom).join(' / '); });",
    "grist.onOptions((options) => { document.title = String((options && options.title) || ''); });",
  ].join('\n'));
  const { constats, nonExecute } = await auditDynamique(construireContexte(racine), {});
  if (nonExecute) { axeDNonExecute(t, constats); return; }
  assert.equal(constats.some((c) => c.regle === 'D-XSS-02' || c.regle === 'D-XSS-01'), false);
  const info = constats.find((c) => c.regle === 'D-XSS-03');
  assert.ok(info, 'la batterie dit ce qu\'elle a joué');
  assert.match(info.titre, new RegExp(`${NOMBRE_DE_CHARGES} charges d'attaque jouée : aucune exécutée`));
  assert.equal(info.preuve.donneesLues, true);
});
