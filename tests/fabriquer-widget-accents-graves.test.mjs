/**
 * Le fabricant des widgets du « point 4 » (`docker/ci/fabriquer-widget-accents-graves.mjs`) : les mesures de
 * `docs/ARCHITECTURE-V2.md` (« Hors de l'image ») et celles des messages de commit citent ces fichiers par leur empreinte, et un
 * fabricant qui change un octet mesurerait un autre fichier sans le dire. Ce qui est éprouvé : les quatre fichiers mesurés, octet
 * pour octet (leurs empreintes sha256 commencent comme celles que la coordination a relevées sur les siens : 41f5b291, f7d29165,
 * 70e13a3c et 715a8944), la page de 77 octets, et les refus, qui ne laissent aucun dossier derrière eux.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FABRIQUE = path.join(RACINE, 'docker', 'ci', 'fabriquer-widget-accents-graves.mjs');
const PAGE = '<!doctype html><html lang="fr"><title>t</title><script src="app.js"></script>';
const TEMOIN = 'fetch("https://temoin-coeur.invalid/c")';
const GRAVE = '`';
const empreinte = (tampon) => crypto.createHash('sha256').update(tampon).digest('hex');

/** Lance le fabricant dans un dossier neuf : ce qu'il a écrit (ou null), ce qu'il a dit, et s'il a créé le dossier. */
function fabriquer(...demande) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-essai-fabrique-'));
  const dossier = path.join(racine, 'widget');
  try {
    const r = spawnSync(process.execPath, [FABRIQUE, dossier, ...demande], { encoding: 'utf8', timeout: 30_000 });
    const lit = (nom) => (fs.existsSync(path.join(dossier, nom)) ? fs.readFileSync(path.join(dossier, nom)) : null);
    return { code: r.status, sortie: r.stdout, erreur: r.stderr, page: lit('index.html'), script: lit('app.js'), dossierCree: fs.existsSync(dossier) };
  } finally { fs.rmSync(racine, { recursive: true, force: true }); }
}

const SONDES = [
  {
    nom: 'a : une chaîne de 1 677 722 accents graves',
    demande: ['1677722'],
    contenu: GRAVE.repeat(1_677_722),
    sha256: '41f5b2913e617a5ed3649b3f59a73d3954b74fbdd05b20eff683e0c0f523ec56',
  },
  {
    nom: 'b : « coupe », 838 860 accents graves, un point-virgule, 838 860 accents graves (1 677 721 octets)',
    demande: ['1677722', '--coupe'],
    contenu: GRAVE.repeat(838_860) + ';' + GRAVE.repeat(838_860),
    sha256: 'f7d29165f1e86f9e43f430ae2b7c94a37177ea041f8b28248baeb94b17cc5707',
  },
  {
    nom: 'b\' : « milieu », un appel réseau entre deux points-virgules au cœur de 2 × 838 840 accents graves (1 677 721 octets)',
    demande: ['1677722', '--temoin'],
    contenu: GRAVE.repeat(838_840) + ';' + TEMOIN + ';' + GRAVE.repeat(838_840),
    sha256: '70e13a3c8f3a5308e78ce29f578c040f266c07839b2dab38fe29fb107ee3d3a1',
  },
  {
    nom: 'c : une chaîne de 3 355 443 accents graves',
    demande: ['3355443'],
    contenu: GRAVE.repeat(3_355_443),
    sha256: '715a8944b4f8019532c792886514d33309f05edabe5af06118245583397d9430',
  },
];

for (const sonde of SONDES) {
  test(`le fabricant reproduit la sonde ${sonde.nom}, octet pour octet`, () => {
    const r = fabriquer(...sonde.demande);
    assert.equal(r.code, 0, r.erreur);
    assert.equal(r.page?.toString('utf8'), PAGE, 'la page de 77 octets, qui charge app.js');
    assert.equal(r.page.length, 77);
    assert.ok(r.script, 'app.js est écrit');
    assert.equal(r.script.length, sonde.contenu.length, `la taille : ${r.script.length} octets`);
    assert.ok(Buffer.compare(r.script, Buffer.from(sonde.contenu, 'latin1')) === 0, 'le contenu est celui que la forme annonce');
    assert.equal(empreinte(r.script), sonde.sha256, 'l\'empreinte est celle des fichiers mesurés');
    assert.match(r.sortie, new RegExp(`app\\.js de ${sonde.contenu.length} octets`), 'il dit la taille qu\'il a écrite');
  });
}

test('le fabricant refuse sans rien écrire : pas d\'argument, une taille qui n\'en est pas une, deux formes à la fois, une option inconnue', () => {
  for (const demande of [[], ['0'], ['-5'], ['1.5'], ['beaucoup'], ['1677722', '--coupe', '--temoin'], ['1677722', '--inconnue']]) {
    const r = fabriquer(...demande);
    assert.equal(r.code, 2, `${JSON.stringify(demande)} : ${r.erreur}`);
    assert.match(r.erreur, /usage : fabriquer-widget-accents-graves/, JSON.stringify(demande));
    assert.equal(r.dossierCree, false, `${JSON.stringify(demande)} : le dossier ne se crée pas pour un refus`);
  }
});

test('le fabricant refuse une taille trop petite pour la forme demandée, et accepte la plus petite qui tienne', () => {
  for (const demande of [['1', '--coupe'], ['2', '--coupe'], ['40', '--temoin'], ['10', '--temoin']]) {
    const r = fabriquer(...demande);
    assert.equal(r.code, 2, `${JSON.stringify(demande)} : ${r.erreur}`);
    assert.match(r.erreur, /trop petit pour cette forme/, JSON.stringify(demande));
    assert.equal(r.dossierCree, false, JSON.stringify(demande));
  }
  const coupe = fabriquer('5', '--coupe');
  assert.equal(coupe.code, 0, coupe.erreur);
  assert.equal(coupe.script.toString('latin1'), '``;``', 'deux accents graves de chaque côté du point-virgule');
  const temoin = fabriquer('45', '--temoin');
  assert.equal(temoin.code, 0, temoin.erreur);
  assert.equal(temoin.script.toString('latin1'), '``;' + TEMOIN + ';``', 'l\'appel réseau est entre deux points-virgules, deux accents graves de chaque côté');
});
