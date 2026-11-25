/**
 * E-DEP-12 : une bibliothèque embarquée dont le contenu est identique à un fichier du paquet publié au registre npm est reconnue (nom et version certains) ; une différence ne
 * produit rien. Aucun essai n'atteint le réseau : l'archive est un `.tgz` fabriqué ici, le registre une fonction d'essai.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { construireContexte } from '../src/contexte/inventaire.js';
import { bilanDependances } from '../src/regles/e-bilan.js';
import { cleDe } from '../src/regles/e-osv.js';
import { analyserDependancesEmbarquees } from '../src/regles/e-dependances.js';
import { empreintesDeLArchive, nomsProbables, reconnaitreLesBibliotheques, constatsIdentiques, archiveDuRegistre, identifierLesEmbarquees } from '../src/regles/e-identique.js';

/** Une archive au format de `npm pack` : des blocs de 512 octets (en-tête ustar puis contenu), le tout compressé. */
function tgz(entrees) {
  const blocs = [];
  const entete = (nom, taille, type) => {
    const h = Buffer.alloc(512);
    h.write(nom, 0, 100, 'utf8'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${taille.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.write('        ', 148);
    h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    h.write(`${[...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  const ajouter = (nom, donnee, type = '0') => { blocs.push(entete(nom.slice(0, 100), donnee.length, type), donnee, Buffer.alloc((512 - (donnee.length % 512)) % 512)); };
  for (const [nom, contenu] of Object.entries(entrees)) {
    const donnee = Buffer.from(contenu);
    if (nom.length > 100) {   // un chemin long : un en-tête étendu (pax) qui précède le fichier
      const ligne = ` path=${nom}\n`;
      let n = ligne.length + 1; while (String(n).length + ligne.length !== n) n = String(n).length + ligne.length;
      ajouter('PaxHeader', Buffer.from(`${n}${ligne}`), 'x');
    }
    ajouter(nom, donnee);
  }
  blocs.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocs));
}

const JQUERY = '/*! jQuery v3.6.0 | (c) OpenJS Foundation and other contributors | jquery.org/license */\n!function(e,t){"use strict"}(window);\n';
const depot = (fichiers) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-identique-'));
  for (const [nom, contenu] of Object.entries(fichiers)) { fs.mkdirSync(path.dirname(path.join(d, nom)), { recursive: true }); fs.writeFileSync(path.join(d, nom), contenu); }
  return d;
};
const lireFichiers = (d, chemins) => chemins.map((chemin) => ({ chemin, contenu: fs.readFileSync(path.join(d, chemin), 'utf8') }));

test("empreintesDeLArchive : un SHA-256 par fichier de l'archive, un chemin long lu dans son en-tête étendu, une archive abîmée rendue nulle", () => {
  const long = `package/${'dossier/'.repeat(15)}profond.js`;
  const m = empreintesDeLArchive(tgz({ 'package/package.json': '{"name":"x"}', 'package/dist/jquery.min.js': JQUERY, [long]: 'profond' }));
  assert.equal(m.size, 3);
  assert.equal(m.get('package/dist/jquery.min.js'), crypto.createHash('sha256').update(JQUERY).digest('hex'));
  assert.ok(m.has(long), 'le chemin de plus de cent caractères est lu dans l\'en-tête étendu');
  assert.equal(empreintesDeLArchive(Buffer.from('ceci n\'est pas une archive')), null);
  const brut = zlib.gunzipSync(tgz({ 'package/a.js': 'x'.repeat(2000) }));
  assert.equal(empreintesDeLArchive(zlib.gzipSync(brut.subarray(0, 700))), null, 'une archive coupée au milieu d\'un fichier ne se lit pas');
});

test("nomsProbables : le nom du fichier sans version ni suffixe, puis le mot qui précède la version dans l'en-tête", () => {
  assert.deepEqual(nomsProbables('vendor/jquery-3.6.0.min.js', JQUERY, '3.6.0'), ['jquery']);
  assert.deepEqual(nomsProbables('lib/chart.umd.js', '/*! Chart.js v4.4.0 */', '4.4.0'), ['chart', 'chart.js']);
  assert.deepEqual(nomsProbables('vendor/lib.js', JQUERY, '3.6.0'), ['lib', 'jquery']);
  assert.deepEqual(nomsProbables('vendor/x.js', '/*! v1.2.3 */', '1.2.3'), [], 'un nom d\'une lettre n\'est pas un nom');
  assert.deepEqual(nomsProbables('a/../$bad.js', '/*! ../etc v1.2.3 */', '1.2.3').filter((n) => /[^a-z0-9._~@/-]/.test(n)), [], 'jamais un nom qui ne serait pas un nom de paquet');
});

test("reconnaitreLesBibliotheques : un fichier identique à celui du paquet est reconnu, une copie retouchée ou sans version ne l'est pas, un registre muet ne fait rien", async () => {
  const d = depot({ 'vendor/jquery-3.6.0.min.js': JQUERY, 'vendor/retouche.js': JQUERY.replace('"use strict"', '"use strict";fetch("//x")'), 'vendor/sans-version.js': '!function(){}()', 'vendor/autre.js': JQUERY });
  const archives = [];
  const archive = async (nom, version) => { archives.push(`${nom}@${version}`); return nom === 'jquery' ? tgz({ 'package/dist/jquery.min.js': JQUERY, 'package/package.json': '{}' }) : null; };
  const fichiers = lireFichiers(d, ['vendor/jquery-3.6.0.min.js', 'vendor/retouche.js', 'vendor/sans-version.js', 'vendor/autre.js']);
  const reconnues = await reconnaitreLesBibliotheques(fichiers, d, archive);
  // `autre.js` porte le même contenu : le nom du fichier est faux (`autre`), c'est l'en-tête (`jQuery`) puis le contenu qui tranchent.
  assert.deepEqual(reconnues.map((r) => [r.fichier, r.nom, r.version, r.dans]), [['vendor/autre.js', 'jquery', '3.6.0', 'dist/jquery.min.js'], ['vendor/jquery-3.6.0.min.js', 'jquery', '3.6.0', 'dist/jquery.min.js']]);
  assert.ok(!archives.some((a) => a.includes('sans-version')), 'sans version lue, rien n\'est demandé au registre');
  assert.deepEqual(await reconnaitreLesBibliotheques(fichiers, d, async () => null), []);
  assert.deepEqual(await reconnaitreLesBibliotheques(fichiers, d, async () => { throw new Error('registre muet'); }), []);
  assert.deepEqual(await reconnaitreLesBibliotheques(fichiers, d, async () => Buffer.from('pas une archive')), []);
});

test("E-DEP-12 : information sur preuve, sans pénalité, qui ne dit jamais « trafiquée » ; rien quand rien n'est reconnu", () => {
  assert.deepEqual(constatsIdentiques([]), []);
  const [c] = constatsIdentiques([{ fichier: 'vendor/jquery.min.js', nom: 'jquery', version: '3.6.0', dans: 'dist/jquery.min.js' }]);
  assert.equal(`${c.regle} ${c.severite} ${c.confiance} ${c.bloquant ? 'bloquant' : 'non bloquant'}`, 'E-DEP-12 info prouve non bloquant');
  assert.match(c.constat, /vendor\/jquery\.min\.js = jquery@3\.6\.0 \(dist\/jquery\.min\.js\)/);
  assert.doesNotMatch(`${c.titre} ${c.constat}`, /trafiqu|piégé|malveillant/i);
});

test("archiveDuRegistre : le tgz du `npm pack`, un paquet introuvable rendu nul, et un registre qui ne répond pas n'est plus interrogé après deux essais", async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-pack-'));
  const appels = [];
  const npm = (reponse) => ({ dossier, lancer: async (args) => { appels.push(args[1]); return reponse(args); } });
  const ecrit = npm((args) => { fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], 'jquery-3.6.0.tgz'), tgz({ 'package/a.js': 'a' })); return { stdout: '[]' }; });
  assert.equal(empreintesDeLArchive(await archiveDuRegistre(ecrit, 'jquery', '3.6.0')).size, 1);
  assert.deepEqual(fs.readdirSync(dossier), [], 'le dossier de téléchargement est retiré');
  // Introuvable : le registre a répondu, il reste interrogé.
  const etat = { echecs: 0, reussites: 0 };
  const introuvable = npm(() => { throw Object.assign(new Error('Command failed'), { stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/zzz' }); });
  for (const n of ['a', 'b', 'c']) assert.equal(await archiveDuRegistre(introuvable, n, '1.0.0', etat), null);
  assert.equal(appels.length, 4);
  // Muet : après deux échecs sans réponse, plus d'appel.
  const e2 = { echecs: 0, reussites: 0 };
  const muet = npm(() => { throw Object.assign(new Error('Command failed'), { stderr: 'npm error code ENOTFOUND' }); });
  for (const n of ['a', 'b', 'c', 'd']) assert.equal(await archiveDuRegistre(muet, n, '1.0.0', e2), null);
  assert.equal(appels.length, 4 + 2, 'les deux derniers essais n\'ont pas attendu le registre');
});

test("identifierLesEmbarquees : ne lance rien quand aucun fichier ne porte de version, et nettoie son npm isolé", async () => {
  let crees = 0, nettoyes = 0;
  const creerNpm = () => { crees++; return { dossier: os.tmpdir(), lancer: async () => { throw new Error('non'); }, nettoyer: () => { nettoyes++; } }; };
  assert.deepEqual(await identifierLesEmbarquees([{ chemin: 'v/a.js', contenu: '!function(){}()' }], '/', creerNpm), []);
  assert.equal(crees, 0);
  assert.deepEqual(await identifierLesEmbarquees([{ chemin: 'v/jquery.js', contenu: JQUERY }], '/inexistant', creerNpm), []);
  assert.deepEqual([crees, nettoyes], [1, 1]);
});

test("dans le bilan : E-DEP-12 puis, nom et version désormais certains, l'avis OSV (E-VULN-03) ; --sans-reseau ne lance rien ; rien reconnu, rien de plus", async () => {
  const d = depot({ 'index.html': '<script src="vendor/jquery.min.js"></script>', 'vendor/jquery.min.js': JQUERY + '/* '.padEnd(40000, 'x') + ' */' });
  const ctx = construireContexte(d);
  const embarquee = analyserDependancesEmbarquees(ctx);
  assert.equal(embarquee.length, 1, 'le fichier est une bibliothèque embarquée (E-DEP-02)');
  const lire = async () => new Map();
  const reconnue = [{ fichier: 'vendor/jquery.min.js', nom: 'jquery', version: '3.6.0', dans: 'dist/jquery.min.js' }];
  const demandes = [];
  const GHSA = { id: 'GHSA-gxr4-xjj5-5px2', resume: 'Cross-site Scripting in jQuery', gravite: 'moderate', malveillant: false };
  const osv = async (paires) => { demandes.push(paires.map((p) => cleDe(p.nom, p.version))); return { erreur: null, lus: new Map([[cleDe('jquery', '3.6.0'), [GHSA]]]) }; };
  let lance = 0;
  const identifier = async (fichiers) => { lance++; assert.deepEqual(fichiers.map((f) => f.chemin), ['vendor/jquery.min.js']); return reconnue; };

  const r = await bilanDependances(ctx, embarquee, { reseau: true }, lire, osv, identifier);
  assert.deepEqual(r.map((c) => c.regle), ['E-DEP-07', 'E-DEP-12', 'E-VULN-03']);
  assert.deepEqual(demandes, [['jquery@3.6.0']]);
  const avis = r[2];
  assert.equal(`${avis.severite} ${avis.bloquant ? 'bloquant' : 'non bloquant'}`, 'majeur non bloquant');
  assert.match(avis.constat, /embarqué dans le dépôt, vendor\/jquery\.min\.js.*identique à celui du paquet publié \(E-DEP-12\)/);
  assert.match(avis.remediation, /Remplacer la copie embarquée/);
  assert.match(r[0].constat, /1 bibliothèque embarquée reconnue identique au paquet publié \(E-DEP-12\)/);
  assert.doesNotMatch(r[0].constat, /ne sont? vues? par aucune base d'avis/, 'une copie reconnue et interrogée est vue par OSV');
  assert.deepEqual(r[0].preuve.dependances.find((x) => x.anneau === 'embarquee').reconnue, 'jquery@3.6.0');

  const coupe = await bilanDependances(ctx, embarquee, { reseau: false }, lire, async () => { throw new Error('OSV ne doit pas être lu'); }, async () => { throw new Error('le registre ne doit pas être lu'); });
  assert.deepEqual(coupe.map((c) => c.regle), ['E-DEP-07']);
  assert.match(coupe[0].constat, /1 bibliothèque embarquée ou distante n'est vue par aucune base d'avis/);

  const rien = await bilanDependances(ctx, embarquee, { reseau: true }, lire, osv, async () => []);
  assert.deepEqual(rien.map((c) => c.regle), ['E-DEP-07'], 'une copie qui diffère ne produit aucun constat');
  assert.match(rien[0].constat, /1 bibliothèque embarquée ou distante n'est vue par aucune base d'avis/);
  assert.equal(lance, 1);

  // OSV ne répond pas : l'identité reste prouvée, la sûreté non mesurée.
  const muet = await bilanDependances(ctx, embarquee, { reseau: true }, lire, async () => ({ erreur: 'injoignable', lus: new Map() }), identifier);
  assert.deepEqual(muet.map((c) => c.regle), ['E-DEP-07', 'E-DEP-12']);
  assert.match(muet[0].constat, /OSV\.dev n'a pas répondu \(injoignable\)/);
});
