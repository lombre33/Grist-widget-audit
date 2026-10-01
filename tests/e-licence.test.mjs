import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserLicence } from '../src/regles/e-dependances.js';
import { auditer, page } from './aide-surface.mjs';

/**
 * La licence du dépôt, condition d'un fork par l'équipe Grist.Gouv : E-LIC-01 (aucun fichier de licence à la racine : majeur et bloquant) et
 * E-LIC-02 (le fichier est là : son type, d'après ses 3 000 premiers caractères). Ces essais fixent les noms reconnus, ceux qui ne le sont pas,
 * chaque type et l'ordre dans lequel on les reconnaît, la fenêtre lue et la taille dite ; et ce qu'on fait d'une licence dont l'outil n'a pas lu
 * le texte (`LICENSE.pdf`, un fichier trop gros) : elle est présente, son type n'est pas identifié, l'analyse ne s'arrête pas. Elle s'arrêtait,
 * sans rapport : `licence.contenu.slice` lisait `undefined`.
 */

const MIT = 'MIT License\n\nCopyright (c) 2026 Moi\n';
const extension = (chemin) => (chemin.includes('.') ? chemin.slice(chemin.lastIndexOf('.')) : '');
const lu = (chemin, contenu = MIT, taille = contenu.length) => ({ chemin, contenu, taille, ext: extension(chemin), binaire: false, executee: false, vendorise: false });
const nonLu = (chemin, nonLue = { cause: 'taille' }, taille = 17_000_000) => ({
  chemin, taille, ext: extension(chemin), binaire: true, ...(nonLue ? { nonLu: nonLue } : {}), executee: false, vendorise: false,
});
const constatsDe = (fichiers) => analyserLicence({ fichiers });
const types = (fichiers) => constatsDe(fichiers).map((c) => [c.regle, c.fichier, c.titre.replace('Licence du dépôt : ', '')]);

// E-LIC-01 : aucun fichier de licence ------------------------------------------------------------------------------------

test('E-LIC-01 : sans aucun fichier, aucune licence : majeur et bloquant, certain', () => {
  const [c, ...autres] = constatsDe([]);
  assert.equal(autres.length, 0);
  assert.deepEqual([c.regle, c.axe, c.severite, c.bloquant, c.confiance], ['E-LIC-01', 'E', 'majeur', true, 'certain']);
  assert.equal(c.titre, 'Aucun fichier de licence à la racine');
  assert.equal(c.fichier, null);
  assert.match(c.impact, /droit d'auteur par défaut/);
  assert.match(c.remediation, /EUPL 1\.2/);
});

const PAS_UNE_LICENCE = [
  ['une licence dans un dossier (le guide la veut à la racine)', 'docs/LICENSE'],
  ['un COPYING dans un dossier', 'src/COPYING'],
  ['un nom qui contient LICENSE sans commencer par lui', 'MYLICENSE'],
  ['un nom qui continue après LICENSE', 'LICENSEE'],
  ['une sauvegarde de licence', 'LICENSE.md.bak'],
  ['un autre fichier de la racine', 'README.md'],
];
for (const [nom, chemin] of PAS_UNE_LICENCE) {
  test(`E-LIC-01 : ${nom} (${chemin}) n'est pas la licence du dépôt : il n'y en a pas`, () => {
    const [c, ...autres] = constatsDe([lu(chemin)]);
    assert.equal(autres.length, 0);
    assert.equal(c.regle, 'E-LIC-01');
    assert.equal(c.bloquant, true);
  });
}

const NOMS_DE_LICENCE = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'license', 'License.TXT', 'COPYING', 'COPYING.md', 'Licence.Md'];
for (const chemin of NOMS_DE_LICENCE) {
  test(`E-LIC-02 : ${chemin} à la racine est la licence du dépôt`, () => {
    assert.deepEqual(types([lu(chemin)]), [['E-LIC-02', chemin, 'MIT']]);
  });
}

// E-LIC-02 : le type ---------------------------------------------------------------------------------------------------------

const TYPES = [
  ['MIT License\n\nPermission is hereby granted', 'MIT', 'info'],
  ['mit license', 'MIT', 'info'],
  ['Apache License\nVersion 2.0, January 2004', 'Apache 2.0', 'info'],
  ['apache license', 'Apache 2.0', 'info'],
  ['EUROPEAN UNION PUBLIC LICENCE v. 1.2', 'EUPL', 'info'],
  ['european union public licence', 'EUPL', 'info'],
  ['Licensed under the EUPL, Version 1.2 only', 'EUPL', 'info'],
  ['licensed under the eupl', 'EUPL', 'info'],
  ['GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007', 'GPL/AGPL', 'info'],
  ['GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3', 'GPL/AGPL', 'info'],
  ['gnu general public license', 'GPL/AGPL', 'info'],
  ['BSD 3-Clause License', 'BSD', 'info'],
  ['bsd license', 'BSD', 'info'],
  ['Tous droits réservés.', 'non identifiée', 'mineur'],
  ['', 'non identifiée', 'mineur'],
];
for (const [texte, type, severite] of TYPES) {
  test(`E-LIC-02 : « ${texte.split('\n')[0] || '(fichier vide)'} » est ${type}, ${severite}`, () => {
    const [c, ...autres] = constatsDe([lu('LICENSE', texte)]);
    assert.equal(autres.length, 0);
    assert.deepEqual([c.regle, c.axe, c.severite, c.confiance, c.fichier, c.titre], ['E-LIC-02', 'E', severite, 'certain', 'LICENSE', `Licence du dépôt : ${type}`]);
    assert.ok(!c.bloquant);
    assert.match(c.constat, new RegExp(`type détecté : ${type.replace('/', '\\/')}\\.$`));
    if (type === 'GPL/AGPL') assert.match(c.impact, /effet contaminant/);
    else if (type === 'non identifiée') assert.match(c.impact, /à vérifier manuellement/);
    else assert.match(c.impact, /compatible avec un fork/);
    assert.equal(c.remediation, type === 'non identifiée' ? "Utiliser le texte standard non modifié d'une licence reconnue." : 'Rien à corriger.');
  });
}

// Quand un texte porte plusieurs noms, le premier de la liste l'emporte, où que les noms soient dans le texte.
const PRIORITES = [
  ['MIT passe avant Apache', 'Apache License. MIT License.', 'MIT'],
  ['Apache passe avant EUPL', 'EUPL. Apache License.', 'Apache 2.0'],
  ['EUPL passe avant la GPL', 'GNU GENERAL PUBLIC LICENSE, ou EUPL.', 'EUPL'],
  ['la GPL passe avant BSD', 'BSD. GNU GENERAL PUBLIC LICENSE.', 'GPL/AGPL'],
];
for (const [nom, texte, type] of PRIORITES) {
  test(`E-LIC-02 : ${nom}`, () => assert.deepEqual(types([lu('LICENSE', texte)]), [['E-LIC-02', 'LICENSE', type]]));
}

test('E-LIC-02 : le type se lit dans les 3 000 premiers caractères, pas au-delà', () => {
  const apres = (n) => `${' '.repeat(n)}MIT License`;             // onze caractères
  assert.deepEqual(types([lu('LICENSE', apres(2989))]), [['E-LIC-02', 'LICENSE', 'MIT']], 'finit au caractère 2 999, le dernier lu');
  assert.deepEqual(types([lu('LICENSE', apres(2990))]), [['E-LIC-02', 'LICENSE', 'non identifiée']], 'finit au caractère 3 000, le premier non lu');
});

test('E-LIC-02 : la taille dite est celle du fichier en Ko, arrondie', () => {
  const taille = (octets) => constatsDe([lu('LICENSE', MIT, octets)])[0].constat;
  assert.match(taille(1500), /\(1 Ko\)/, '1,46 Ko');
  assert.match(taille(1536), /\(2 Ko\)/, '1,5 Ko');
  assert.match(taille(2048), /\(2 Ko\)/);
  assert.match(taille(100), /\(0 Ko\)/);
});

// Une licence dont l'outil n'a pas lu le texte ---------------------------------------------------------------------------------

const CAUSES = [
  ['un fichier trop gros', { cause: 'taille' }],
  ['le plafond de lecture cumulé atteint', { cause: 'cumul' }],
  ['une lecture refusée', { cause: 'lecture' }],
  ['une extension de binaire', undefined],
];
for (const chemin of ['LICENSE', 'LICENSE.pdf', 'COPYING.png']) {
  for (const [cause, nonLue] of CAUSES) {
    test(`E-LIC-02 : ${chemin} dont l'outil n'a pas lu le texte (${cause}) est présent, d'un type non identifié : ni E-LIC-01, ni échec`, () => {
      const [c, ...autres] = constatsDe([nonLu(chemin, nonLue)]);
      assert.equal(autres.length, 0);
      assert.deepEqual([c.regle, c.severite, c.confiance, c.fichier, c.titre], ['E-LIC-02', 'mineur', 'certain', chemin, 'Licence du dépôt : non identifiée']);
      assert.ok(!c.bloquant);
      assert.match(c.constat, /n'a pas lu le texte/);
      assert.doesNotMatch(c.constat, /Ko/, 'la taille d\'un fichier non lu n\'est pas dite : elle peut être inconnue');
      assert.match(c.impact, /à vérifier manuellement/);
      assert.match(c.remediation, /Fournir le texte de la licence dans un fichier texte/);
    });
  }
}

test('E-LIC-02 : une licence vide est lue (un fichier vide n\'est pas un fichier non lu)', () => {
  const [c] = constatsDe([lu('LICENSE', '')]);
  assert.match(c.constat, /type détecté : non identifiée/);
  assert.doesNotMatch(c.constat, /n'a pas lu/);
});

test('E-LIC-02 : plusieurs licences à la racine, on cite celle dont l\'outil a lu le texte, quel que soit l\'ordre de l\'inventaire', () => {
  const illisible = nonLu('COPYING.png');
  const lisible = lu('LICENSE', MIT);
  assert.deepEqual(types([illisible, lisible]), [['E-LIC-02', 'LICENSE', 'MIT']]);
  assert.deepEqual(types([lisible, illisible]), [['E-LIC-02', 'LICENSE', 'MIT']]);
});

test('E-LIC-02 : plusieurs licences à la racine, on cite la première dans l\'ordre des noms, quel que soit l\'ordre de l\'inventaire', () => {
  const gpl = lu('COPYING', 'GNU GENERAL PUBLIC LICENSE');
  const mit = lu('LICENSE', MIT);
  assert.deepEqual(types([gpl, mit]), [['E-LIC-02', 'COPYING', 'GPL/AGPL']]);
  assert.deepEqual(types([mit, gpl]), [['E-LIC-02', 'COPYING', 'GPL/AGPL']]);
  const pdf = nonLu('LICENSE.pdf');
  const png = nonLu('COPYING.png');
  assert.deepEqual(types([pdf, png]), [['E-LIC-02', 'COPYING.png', 'non identifiée']]);
  assert.deepEqual(types([png, pdf]), [['E-LIC-02', 'COPYING.png', 'non identifiée']]);
});

test('E-LIC-02 : l\'ordre des fichiers de l\'inventaire n\'est pas modifié', () => {
  const fichiers = [lu('LICENSE'), lu('COPYING'), lu('LICENCE')];
  constatsDe(fichiers);
  assert.deepEqual(fichiers.map((f) => f.chemin), ['LICENSE', 'COPYING', 'LICENCE']);
});

// Avec l'inventaire réel ------------------------------------------------------------------------------------------------------

const PAGE = page('<script src="app.js"></script>');
const SANS_RIEN = 'var a = 1;\n';
const PLAFOND = 400;
const GROS = 'x'.repeat(PLAFOND + 1);

test('un LICENSE.pdf dans le dépôt : l\'audit va à son terme, la licence est présente et son type n\'est pas identifié', async () => {
  const a = await auditer({ 'index.html': PAGE, 'app.js': SANS_RIEN, 'LICENSE.pdf': '%PDF-1.4\n\u0000\u0001' });
  assert.equal(a.fichier('LICENSE.pdf').contenu, undefined, 'témoin : l\'inventaire ne lit pas un PDF');
  assert.deepEqual(a.de('E-LIC-01'), []);
  const [c, ...autres] = a.de('E-LIC-02');
  assert.equal(autres.length, 0);
  assert.deepEqual([c.fichier, c.titre, c.severite], ['LICENSE.pdf', 'Licence du dépôt : non identifiée', 'mineur']);
});

test('un LICENSE de plus de 16 Mio (ici au-delà d\'un plafond ramené à 400 octets) : l\'audit va à son terme, la licence est présente et son type n\'est pas identifié', async () => {
  const a = await auditer({ 'index.html': PAGE, 'app.js': SANS_RIEN, LICENSE: GROS }, { plafonds: { maxOctetsFichier: PLAFOND } });
  assert.equal(a.fichier('LICENSE').contenu, undefined, 'témoin : le plafond de lecture s\'applique');
  assert.equal(a.fichier('LICENSE').binaire, true);
  assert.deepEqual(a.de('E-LIC-01'), []);
  const [c, ...autres] = a.de('E-LIC-02');
  assert.equal(autres.length, 0);
  assert.deepEqual([c.fichier, c.titre], ['LICENSE', 'Licence du dépôt : non identifiée']);
  assert.match(c.constat, /n'a pas lu le texte/);
});

test('un README.md au-delà du plafond : l\'audit va à son terme, ni B-DOC-01 ni B-DOC-02, et le rapport nomme le fichier non lu', async () => {
  const a = await auditer({ 'index.html': PAGE, 'app.js': SANS_RIEN, 'README.md': GROS }, { plafonds: { maxOctetsFichier: PLAFOND } });
  assert.equal(a.fichier('README.md').contenu, undefined, 'témoin : le plafond de lecture s\'applique');
  assert.deepEqual(a.de('B-DOC-01'), []);
  assert.deepEqual(a.de('B-DOC-02'), []);
  const [c, ...autres] = a.de('C-SURFACE-02');
  assert.equal(autres.length, 0);
  assert.match(c.constat, /README\.md/);
});
