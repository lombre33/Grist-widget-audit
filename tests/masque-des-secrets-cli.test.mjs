/**
 * Les sorties du binaire `gwaudit` ne redisent pas un jeton qu'une règle a recopié (voir `tests/masque-des-secrets.test.mjs`, qui le prouve
 * sur les générateurs de rapports) : le rapport Markdown, le JSON, la page HTML, le SARIF, ce que la console écrit et la comparaison
 * `--diff` de deux rapports. Le binaire est lancé pour de vrai, sans l'axe D ni le réseau.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { masquer } from '../src/regles/c-secrets.js';
import { tirer, ALNUM, jeton as jwt, EMETTEURS_HOSTILES, TEXTE_ANONYME, dirAvecEmetteur, echapperHtml, INVISIBLES } from './aide-secrets.mjs';

const BIN = path.join(import.meta.dirname, '../bin/gwaudit.js');
const lancer = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 90_000 });
const ghp = () => `gh${'p_'}${tirer(36, ALNUM)}`;
const PAGE = '<!doctype html><html lang="fr"><head><title>t</title></head><body><script src="app.js"></script></body></html>';

function ecrireWidget(parent, nom, code) {
  const racine = path.join(parent, nom);
  fs.mkdirSync(racine, { recursive: true });
  fs.writeFileSync(path.join(racine, 'index.html'), PAGE);
  fs.writeFileSync(path.join(racine, 'app.js'), code);
  return racine;
}

test('le binaire ne dit un jeton recopié par une règle dans aucune de ses sorties : rapports Markdown, JSON, HTML et SARIF, console, comparaison', () => {
  const jetons = [ghp(), ghp(), ghp()];
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-masque-'));
  try {
    const avec = ecrireWidget(parent, 'avec', [
      `fetch('https://api.example.com/x?t=${jetons[0]}');`,
      `eval("var t = '${jetons[1]}'");`,
      `import('https://a.example/m.js?t=${jetons[2]}');`,
    ].join('\n') + '\n');
    const sans = ecrireWidget(parent, 'sans', 'var x = 1;\n');
    const options = ['--sans-dynamique', '--sans-reseau'];

    const a = lancer(avec, ...options, '--json', '--sarif', '--sortie', path.join(parent, 'sortie-avec'));
    const b = lancer(sans, ...options, '--json', '--sortie', path.join(parent, 'sortie-sans'));
    for (const r of [a, b]) assert.ok([0, 1, 2].includes(r.status), `le binaire s'est arrêté en erreur (${r.status}) : ${r.stderr.slice(-300)}`);
    const diff = lancer('--diff', path.join(parent, 'sortie-avec', 'rapport.json'), path.join(parent, 'sortie-sans', 'rapport.json'));
    assert.ok([0, 1, 2].includes(diff.status), `la comparaison s'est arrêtée en erreur (${diff.status}) : ${diff.stderr.slice(-300)}`);

    const sorties = {
      'rapport.md': fs.readFileSync(path.join(parent, 'sortie-avec', 'rapport.md'), 'utf8'),
      'rapport.json': fs.readFileSync(path.join(parent, 'sortie-avec', 'rapport.json'), 'utf8'),
      'rapport.html': fs.readFileSync(path.join(parent, 'sortie-avec', 'rapport.html'), 'utf8'),
      'rapport.sarif': fs.readFileSync(path.join(parent, 'sortie-avec', 'rapport.sarif'), 'utf8'),
      'sortie standard': a.stdout,
      'sortie d\'erreur': a.stderr,
      'comparaison, sortie standard': diff.stdout,
      'comparaison, sortie d\'erreur': diff.stderr,
    };
    for (const [nom, texte] of Object.entries(sorties)) {
      for (const [k, jeton] of jetons.entries()) {
        assert.ok(!texte.includes(jeton), `${nom} : le jeton ${k + 1} est dit en entier`);
        assert.ok(!texte.includes(jeton.slice(5, -5)), `${nom} : le milieu du jeton ${k + 1} est dit`);
      }
    }
    // L'essai ne réussit pas faute d'avoir trouvé quoi que ce soit : le JSON dit les trois jetons masqués, la comparaison dit les constats corrigés.
    for (const jeton of jetons) assert.ok(sorties['rapport.json'].includes(masquer(jeton)), `le JSON ne dit pas ${masquer(jeton)}`);
    assert.match(diff.stdout, /C-EXFIL-01|Corrigé|corrigé/, 'la comparaison ne dit aucun constat corrigé');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('le binaire ne laisse passer l\'émetteur hostile d\'un JWT de rôle anonyme ni dans la console, ni dans les rapports, ni dans la comparaison : aucun caractère de contrôle, aucune balise, aucun Markdown', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-emetteur-'));
  try {
    const options = ['--sans-dynamique', '--sans-reseau'];
    // La console n'écrit aujourd'hui aucun texte de constat (elle dit le verdict et les comptes) : l'essai garde qu'aucun caractère de contrôle ne sort de ce que le binaire écrit, le jour où il en écrirait un.
    // Un fichier par jeton, trois jetons par widget : la page HTML regroupe les constats d'une même règle au-delà de quatre et ne dit plus le texte de chacun.
    const groupes = [EMETTEURS_HOSTILES.slice(0, 3), EMETTEURS_HOSTILES.slice(3)];
    const dossiers = [];
    groupes.forEach((groupe, g) => {
      const racine = path.join(parent, `hostile-${g}`);
      fs.mkdirSync(racine, { recursive: true });
      fs.writeFileSync(path.join(racine, 'index.html'), PAGE.replace('<script src="app.js"></script>', groupe.map((_, k) => `<script src="j${k}.js"></script>`).join('')));
      groupe.forEach(({ iss }, k) => fs.writeFileSync(path.join(racine, `j${k}.js`), `var cle = '${jwt({ iss, role: 'anon' })}';\n`));
      const sortie = path.join(parent, `sortie-${g}`);
      const r = lancer(racine, ...options, '--json', '--sarif', '--sortie', sortie);
      assert.ok([0, 1, 2].includes(r.status), `le binaire s'est arrêté en erreur (${r.status}) : ${r.stderr.slice(-300)}`);
      dossiers.push({ groupe, sortie, console: { 'sortie standard': r.stdout, 'sortie d\'erreur': r.stderr } });
    });
    const propre = ecrireWidget(parent, 'propre', 'var x = 1;\n');
    const b = lancer(propre, ...options, '--json', '--sortie', path.join(parent, 'sortie-propre'));
    assert.ok([0, 1, 2].includes(b.status), `le binaire s'est arrêté en erreur (${b.status}) : ${b.stderr.slice(-300)}`);

    for (const [g, { groupe, sortie, console: consoleDuBinaire }] of dossiers.entries()) {
      const diff = lancer('--diff', path.join(sortie, 'rapport.json'), path.join(parent, 'sortie-propre', 'rapport.json'));
      assert.ok([0, 1, 2].includes(diff.status), `la comparaison s'est arrêtée en erreur (${diff.status}) : ${diff.stderr.slice(-300)}`);
      const texte = (nom) => fs.readFileSync(path.join(sortie, nom), 'utf8');
      const markdown = texte('rapport.md');
      const html = texte('rapport.html');
      const json = texte('rapport.json');
      const sarif = texte('rapport.sarif');
      // Ce que la console écrit, et la comparaison : aucun caractère de contrôle (hors retour à la ligne), quoi que le widget ait choisi.
      for (const [nom, sortieDuBinaire] of Object.entries({ ...consoleDuBinaire, 'comparaison, sortie standard': diff.stdout, 'comparaison, sortie d\'erreur': diff.stderr })) {
        assert.ok(!INVISIBLES.test(sortieDuBinaire.replace(/\n/g, '')), `widget ${g}, ${nom} : un caractère de contrôle ou invisible traverse`);
      }
      const lignes = markdown.split('\n');
      const resultats = JSON.parse(sarif).runs[0].results;
      const constats = Object.values(JSON.parse(json).axes).flatMap((a) => a.constats).filter((c) => c.regle === 'C-SECRET-01');
      assert.equal(constats.length, groupe.length, `widget ${g} : un constat par jeton`);
      for (const { nom, cite, dansLeHtml, pasAuDebutDeLigne } of groupe) {
        const dit = dirAvecEmetteur(cite);
        assert.equal(lignes.filter((l) => l === dit).length, 1, `${nom} : le Markdown ne dit pas le texte sur une ligne à lui`);
        for (const debut of pasAuDebutDeLigne) assert.ok(!lignes.some((l) => l.startsWith(debut)), `${nom} : une ligne du Markdown commence par « ${debut} »`);
        assert.ok(html.includes(`<p>${echapperHtml(TEXTE_ANONYME)} Son émetteur (champ iss) : ${dansLeHtml}.</p>`), `${nom} : la page HTML ne dit pas le texte échappé`);
        assert.ok(constats.some((c) => c.constat === dit), `${nom} : le JSON ne dit pas le texte`);
        assert.ok(resultats.some((r) => r.message.text.includes(dit)), `${nom} : le SARIF ne dit pas le texte`);
      }
      assert.ok(!html.includes('<b>x</b>') && !html.includes('<!-- z') && !html.includes('--> y'), `widget ${g} : la page HTML rend du balisage ou un commentaire de l'émetteur`);
      for (const [nom, rapport] of Object.entries({ 'rapport.md': markdown, 'rapport.html': html, 'rapport.json': json, 'rapport.sarif': sarif })) {
        assert.ok(!INVISIBLES.test(rapport.replace(/\n/g, '')), `widget ${g}, ${nom} : un caractère de contrôle ou invisible traverse`);
      }
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
