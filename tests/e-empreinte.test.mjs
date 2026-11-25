/**
 * E-FIGE-01 : l'empreinte de ce qui a été audité, et `gwaudit --verifier` qui la compare à ce que la cible est aujourd'hui.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { empreinteDuDepot, comparerEmpreintes, constatEmpreinte } from '../src/regles/e-empreinte.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/gwaudit.js');
const dossier = (fichiers) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-empreinte-'));
  ecrire(d, fichiers);
  return d;
};
const ecrire = (d, fichiers) => {
  for (const [nom, contenu] of Object.entries(fichiers)) {
    fs.mkdirSync(path.dirname(path.join(d, nom)), { recursive: true });
    fs.writeFileSync(path.join(d, nom), contenu);
  }
};

test("l'empreinte ne dépend que des contenus : la même copie ailleurs la donne, un octet change tout, .git et node_modules ne comptent pas", () => {
  const fichiers = { 'index.html': '<p>a</p>', 'js/app.js': 'let a = 1;\n', 'css/a.css': 'a{}' };
  const a = dossier(fichiers);
  const b = dossier({ 'css/a.css': 'a{}', 'js/app.js': 'let a = 1;\n', 'index.html': '<p>a</p>' });   // même contenu, autre ordre de création, autre dossier
  const ea = empreinteDuDepot(a);
  assert.equal(ea.empreinte, empreinteDuDepot(b).empreinte);
  assert.equal(ea.fichiers, 3);
  assert.match(ea.empreinte, /^[0-9a-f]{64}$/);
  // Un octet de plus, un fichier de plus, un fichier renommé : une autre empreinte.
  ecrire(b, { 'js/app.js': 'let a = 2;\n' });
  assert.notEqual(empreinteDuDepot(b).empreinte, ea.empreinte);
  const c = dossier({ ...fichiers, 'nouveau.txt': 'x' });
  assert.notEqual(empreinteDuDepot(c).empreinte, ea.empreinte);
  const d = dossier({ 'index.html': '<p>a</p>', 'js/autre.js': 'let a = 1;\n', 'css/a.css': 'a{}' });
  assert.notEqual(empreinteDuDepot(d).empreinte, ea.empreinte);
  // Ce que l'empreinte ne lit pas : l'historique git et les paquets installés.
  ecrire(a, { '.git/HEAD': 'ref: refs/heads/main', 'node_modules/x/index.js': 'x' });
  assert.equal(empreinteDuDepot(a).empreinte, ea.empreinte);
});

test("comparerEmpreintes nomme les fichiers modifiés, ajoutés et retirés, et dit quand sa liste est coupée", () => {
  const a = dossier({ 'a.js': '1', 'b.js': '2', 'c.js': '3' });
  const avant = empreinteDuDepot(a);
  assert.deepEqual(comparerEmpreintes({ empreinte: avant.empreinte, liste: avant.liste, fichiers: avant.fichiers }, avant), { identique: true, modifies: [], ajoutes: [], retires: [], partiel: false });
  ecrire(a, { 'b.js': '22', 'd.js': '4' });
  fs.rmSync(path.join(a, 'c.js'));
  const ecart = comparerEmpreintes({ empreinte: avant.empreinte, liste: avant.liste, fichiers: avant.fichiers }, empreinteDuDepot(a));
  assert.deepEqual({ ...ecart }, { identique: false, modifies: ['b.js'], ajoutes: ['d.js'], retires: ['c.js'], partiel: false });
  // Un rapport qui compte plus de fichiers qu'il n'en détaille : la liste est dite partielle.
  assert.equal(comparerEmpreintes({ empreinte: 'autre', liste: avant.liste, fichiers: avant.fichiers + 5 }, avant).partiel, true);
});

test("le constat E-FIGE-01 est une information, garde l'empreinte entière, et avertit d'une branche qui bouge seulement pour une cible clonée", () => {
  const d = dossier({ 'index.html': '<p>a</p>' });
  execFileSync('git', ['init', '-q', '-b', 'main', d]);
  execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'add', '-A']);
  execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'm']);
  const lue = empreinteDuDepot(d);
  assert.match(lue.commit, /^[0-9a-f]{40}$/);
  assert.equal(lue.branche, 'main');
  const cloné = constatEmpreinte(lue, { cible: 'https://github.com/o/r' });
  assert.equal(`${cloné.severite} ${cloné.bloquant ? 'bloquant' : 'non bloquant'} ${cloné.confiance}`, 'info non bloquant certain');
  assert.ok(cloné.constat.includes(lue.empreinte), "l'empreinte entière, non masquée comme un secret");
  assert.match(cloné.constat, /branche « main ».*pointe de cette branche : elle avance à chaque envoi/);
  assert.equal(cloné.preuve.brancheMobile, true);
  const local = constatEmpreinte(lue);
  assert.doesNotMatch(local.constat, /elle avance à chaque envoi/);
  assert.equal(local.preuve.brancheMobile, false);
});

test("gwaudit --verifier : identique (code 0), modifié (code 2, fichiers nommés), rapport sans empreinte (3), dossier non dit pour un audit local (1)", () => {
  const d = dossier({ 'index.html': '<p>a</p>', 'app.js': 'let a = 1;\n' });
  const rapportChemin = path.join(dossier({}), 'rapport.json');
  const constat = constatEmpreinte(empreinteDuDepot(d));
  fs.writeFileSync(rapportChemin, JSON.stringify({ cible: null, axes: { E: { constats: [constat] } } }));
  const lancer = (...args) => spawnSync(process.execPath, [BIN, '--verifier', ...args], { encoding: 'utf8', timeout: 60_000 });

  const identique = lancer(rapportChemin, d);
  assert.equal(identique.status, 0, identique.stderr);
  assert.match(identique.stdout, /Identique à ce qui a été audité/);

  ecrire(d, { 'app.js': 'let a = 2;\n', 'ajoute.txt': 'x' });
  fs.rmSync(path.join(d, 'index.html'));
  const modifie = lancer(rapportChemin, d);
  assert.equal(modifie.status, 2, modifie.stderr);
  assert.match(modifie.stdout, /MODIFIÉ depuis l'audit/);
  assert.match(modifie.stdout, /Fichiers modifiés \(1\) : app\.js/);
  assert.match(modifie.stdout, /Fichiers ajoutés \(1\) : ajoute\.txt/);
  assert.match(modifie.stdout, /Fichiers retirés \(1\) : index\.html/);

  const sansEmpreinte = path.join(path.dirname(rapportChemin), 'ancien.json');
  fs.writeFileSync(sansEmpreinte, JSON.stringify({ axes: { E: { constats: [] } } }));
  assert.equal(lancer(sansEmpreinte, d).status, 3);
  assert.equal(lancer(rapportChemin).status, 1, "un rapport d'un dossier local ne dit pas où le comparer");
});
