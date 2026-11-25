/**
 * C-SECRET-02 : un secret retiré du code, resté dans l'historique Git. La règle lit les lignes ajoutées de chaque commit et y cherche les formats de
 * fournisseur de C-SECRET-01 : une clé retirée est signalée (majeur, non bloquant : « à révoquer »), une clé encore présente ne l'est qu'une fois
 * (par C-SECRET-01), une clé publique par conception ou un leurre n'est rien. Ce que la règle ne lit pas, elle le dit : dépôt peu profond. Un dossier
 * qui n'est pas un dépôt Git n'a pas d'historique : rien n'est dit. Le dépôt est une donnée hostile : git n'y lance aucun programme que sa configuration nomme.
 *
 * Aucun secret n'est écrit ici : chaque valeur est assemblée à l'exécution (un hébergeur refuse de recevoir un dépôt qui en contient un).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { construireContexte } from '../src/contexte/inventaire.js';
import { analyseStatique } from '../src/moteur/statique.js';
import { valeursDansLeDiff } from '../src/regles/c-historique.js';
import { tirer, ALNUM, URL64 } from './aide-secrets.mjs';

const git = (racine, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', '-C', racine, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Un dépôt dont chaque étape est un commit : `{ nom: contenu }` écrit un fichier, `{ nom: null }` le supprime. */
function depot(racine, etapes) {
  fs.mkdirSync(racine, { recursive: true });
  git(racine, 'init', '-q', '-b', 'main');
  for (const [i, fichiers] of etapes.entries()) {
    for (const [nom, contenu] of Object.entries(fichiers)) {
      if (contenu === null) fs.rmSync(path.join(racine, nom), { force: true });
      else { fs.mkdirSync(path.dirname(path.join(racine, nom)), { recursive: true }); fs.writeFileSync(path.join(racine, nom), contenu); }
    }
    git(racine, 'add', '-A');
    git(racine, 'commit', '-q', '-m', `étape ${i + 1}`);
  }
}

async function avecDepot(etapes, suite) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-historique-'));
  try {
    const racine = path.join(parent, 'widget');
    depot(racine, etapes);
    return await suite(racine, parent);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

const auditerLeDepot = async (racine) => (await analyseStatique(construireContexte(racine)));
const C_SECRET_02 = (constats) => constats.filter((c) => c.regle === 'C-SECRET-02');
const C_SECRET_01 = (constats) => constats.filter((c) => c.regle === 'C-SECRET-01');
const PAGE = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>t</title></head><body><script src="app.js"></script></body></html>\n';

test('une clé ajoutée puis retirée est dans l\'historique : majeur non bloquant, avec le commit, le fichier et la ligne où elle a été ajoutée, sans la redire', async () => {
  const cle = `sk${'-ant-api03-'}${tirer(93, URL64)}`;
  await avecDepot([
    { 'index.html': PAGE, 'app.js': `// widget\nconst a = 1;\nconst MA_CLE = '${cle}';\n` },
    { 'app.js': '// widget\nconst a = 1;\n' },
  ], async (racine) => {
    const constats = await auditerLeDepot(racine);
    assert.deepEqual(C_SECRET_01(constats), [], 'la clé n\'est plus dans les fichiers actuels');
    const [c, ...autres] = C_SECRET_02(constats);
    assert.equal(autres.length, 0);
    assert.equal(`${c.severite} ${c.bloquant} ${c.fichier}:${c.ligne}`, 'majeur false app.js:3');
    assert.match(c.constat, /commit [0-9a-f]{12} \(app\.js, ligne 3\)/);
    assert.equal(c.preuve.fournisseur, 'anthropic');
    assert.ok(!JSON.stringify(c).includes(cle.slice(10, 50)), 'le constat ne redit pas la clé');
  });
});

test('une clé encore dans le code n\'est dite que par C-SECRET-01 ; une clé publique par conception, un leurre et un fichier de verrouillage ne disent rien', async () => {
  const presente = `gh${'p_'}${tirer(36, ALNUM)}`;
  const publique = `AI${'za'}${tirer(35, URL64)}`;
  const leurre = `gh${'p_'}${'x'.repeat(36)}`;
  const verrou = `sk${'-'}${tirer(48, ALNUM)}`;
  await avecDepot([
    { 'index.html': PAGE, 'app.js': `const a = 1;\n`, 'package-lock.json': `{ "x": "${verrou}" }\n` },
    { 'app.js': `const a = 1;\nconst k = '${presente}';\nconst g = '${publique}';\nconst l = '${leurre}';\n` },
    { 'package-lock.json': null },
  ], async (racine) => {
    const constats = await auditerLeDepot(racine);
    assert.equal(C_SECRET_01(constats).filter((c) => c.severite === 'critique').length, 1, 'la clé présente : C-SECRET-01');
    assert.deepEqual(C_SECRET_02(constats), []);
  });
});

test('valeursDansLeDiff : une ligne ajoutée qui ressemble à un en-tête de fichier ou de bloc n\'en est pas un ; la valeur est attribuée au commit qui l\'a introduite', () => {
  const cle = `xo${'xb-'}1234567890-1234567890123-${tirer(24, ALNUM)}`;
  const ancien = '1111111111111111111111111111111111111111';
  const recent = '2222222222222222222222222222222222222222';
  const diff = [
    `@@COMMIT ${recent}`, 'diff --git a/b.js b/b.js', 'index 1..2 100644', '--- a/b.js', '+++ b/b.js', '@@ -0,0 +1,3 @@',
    '+++ b/faux.js', '+@@ -1 +1 @@', `+const k = '${cle}';`,
    `@@COMMIT ${ancien}`, 'diff --git a/a.js b/a.js', 'new file mode 100644', 'index 0..3', '--- /dev/null', '+++ b/a.js', '@@ -0,0 +4 @@', `+${cle}`, '',
  ].join('\n');
  const { vues } = valeursDansLeDiff(diff);
  assert.equal(vues.size, 1);
  const [{ fichier, ligne, commit, commits }] = vues.values();
  assert.deepEqual([fichier, ligne, commit, commits], ['a.js', 4, ancien.slice(0, 12), 2], 'le dernier lu (le plus ancien) l\'a introduite, dans a.js ligne 4 ; elle figure dans deux commits');
});

test('un dépôt peu profond dit qu\'il n\'a pas été lu en entier ; un dossier qui n\'est pas un dépôt Git ne dit rien', async () => {
  const cle = `hf${'_'}${tirer(34, ALNUM)}`;
  await avecDepot([
    { 'index.html': PAGE, 'app.js': `const k = '${cle}';\n` },
    { 'app.js': `const a = 1;\n` },
  ], async (racine, parent) => {
    const clone = path.join(parent, 'clone');
    execFileSync('git', ['clone', '-q', '--depth', '1', pathToFileURL(racine).href, clone], { stdio: 'ignore' });
    const [info, ...autres] = C_SECRET_02(await auditerLeDepot(clone));
    assert.equal(autres.length, 0);
    assert.equal(`${info.severite} ${info.bloquant}`, 'info false');
    assert.match(info.constat, /peu profond/);
    // Le même dépôt, complet : la clé retirée est trouvée.
    assert.equal(C_SECRET_02(await auditerLeDepot(racine)).map((c) => c.severite).join(), 'majeur');
    // Sans `.git` : pas d'historique, rien n'est dit.
    fs.rmSync(path.join(clone, '.git'), { recursive: true, force: true });
    assert.deepEqual(C_SECRET_02(await auditerLeDepot(clone)), []);
  });
});

test('un dépôt hostile ne lance rien par la lecture de son historique : ni conversion de texte, ni vérification de signature que sa configuration nomme', async () => {
  const cle = `gsk${'_'}${tirer(52, ALNUM)}`;
  await avecDepot([{ 'index.html': PAGE, 'app.js': `const k = '${cle}';\n`, '.gitattributes': '* diff=piege\n' }, { 'app.js': 'const a = 1;\n' }], async (racine, parent) => {
    const marque = path.join(parent, 'marque.txt');
    const programme = path.join(parent, 'piege.cjs');
    fs.writeFileSync(programme, `require('node:fs').appendFileSync(${JSON.stringify(marque)}, 'lancé\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`);
    const commande = `"${process.execPath.split(path.sep).join('/')}" "${programme.split(path.sep).join('/')}"`;
    // Dans un fichier de configuration de git, un guillemet délimite : pour que le shell reçoive les guillemets (un chemin avec une espace, « Program Files »), on les échappe.
    const valeur = commande.replaceAll('"', '\\"');
    fs.appendFileSync(path.join(racine, '.git', 'config'), `[diff "piege"]\n\ttextconv = ${valeur}\n[log]\n\tshowSignature = true\n[gpg]\n\tprogram = ${valeur}\n`);
    // Le piège existe : le git de l'utilisateur, lancé sans précaution, l'exécute.
    execFileSync('git', ['-C', racine, 'log', '-p', '-U0', '--all'], { stdio: 'ignore' });
    assert.ok(fs.existsSync(marque), 'le piège se déclenche avec un git sans précaution');
    fs.rmSync(marque);
    const constats = C_SECRET_02(await auditerLeDepot(racine));
    assert.equal(constats.map((c) => c.severite).join(), 'majeur', 'l\'historique est lu');
    assert.ok(!fs.existsSync(marque), 'aucun programme du dépôt n\'a été lancé');
  });
});
