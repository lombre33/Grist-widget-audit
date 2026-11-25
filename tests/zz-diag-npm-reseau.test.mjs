// SONDE JETABLE (branche diag, jamais fusionnée) : le npm isolé atteint-il vraiment le registre sous Windows ?
import test from 'node:test';
import { creerNpmIsole } from '../src/regles/npm-isole.js';
import { interrogerRegistre } from '../src/regles/e-registre.js';
import { archiveDuRegistre } from '../src/regles/e-identique.js';

test('diag npm réseau', async () => {
  console.log('DIAG node', process.version, process.platform, process.execPath);
  const lus = await interrogerRegistre(['lodash', 'zzz-paquet-qui-nexiste-pas-9f3']);
  console.log('DIAG registre', JSON.stringify([...lus].map(([n, v]) => [n, v.erreur ?? `${Object.keys(v.time).length} versions, latest ${v.latest}`])));
  const npm = creerNpmIsole();
  try {
    const v = await npm.lancer(['--version']);
    console.log('DIAG version', String(v.stdout).trim());
    const tgz = await archiveDuRegistre(npm, 'jquery', '3.6.0');
    console.log('DIAG pack', tgz ? `${tgz.length} octets` : 'null');
  } finally { npm.nettoyer(); }
});
