import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyserReadme } from '../src/regles/b-lisibilite.js';

/**
 * Un README se reconnaît à son nom, à la racine du dépôt : `README.md`, mais aussi `README.fr.md`, `README.rst`, `LISEZMOI.md`… Le guide demande
 * un `README.md` ; un dépôt qui porte son README sous un autre nom en a un, et le prendre pour l'absence de README lève un bloquant (B-DOC-01)
 * qui fausse le verdict d'un widget français. Ces essais fixent les noms reconnus, ceux qui ne le sont pas, et ce que les autres règles du
 * README (B-DOC-02, B-DOC-03, B-DOC-04) font de plusieurs README ou d'un README qu'aucun texte ne porte.
 */

const COMPLET = '# Mon widget\n\n## Description\nAffiche des cartes.\n\n## Configuration\nColonnes attendues : titre.\n\n## Dépendances\nAucune dépendance.\n';

const fichier = (chemin, contenu = COMPLET) => ({ chemin, contenu, lignes: contenu.split('\n'), ext: chemin.slice(chemin.lastIndexOf('.')), binaire: false, executee: false, vendorise: false });
const constatsDe = (fichiers, extra = {}) => analyserReadme({ fichiers, ...extra });
const regles = (fichiers, extra) => constatsDe(fichiers, extra).map((c) => c.regle);

const RECONNUS = [
  'README', 'README.md', 'readme.md', 'Readme.MD', 'README.txt', 'README.rst', 'README.markdown', 'README.mdx', 'README.adoc', 'README.org',
  'README.mdown', 'README.mkd', 'README.text', 'README.asciidoc', 'README.textile', 'README.html', 'README.htm',
  'README.fr.md', 'README.en.md', 'README_fr.md', 'README-fr.md', 'README.en-US.md', 'README.pt_BR.md', 'README.fr', 'README.fra.md', 'README.fr-latn1234.md',
  'LISEZMOI', 'LISEZMOI.md', 'LISEZ-MOI.md', 'lisez_moi.txt', 'Lisezmoi.rst',
];
for (const nom of RECONNUS) {
  test(`B-DOC-01 : ${nom} à la racine est un README`, () => assert.deepEqual(regles([fichier(nom)]), []));
}

const IGNORES = [
  ['un README dans un dossier (le guide le veut à la racine)', 'docs/README.md'],
  ['un README du dossier .github', '.github/README.md'],
  ['un nom qui n\'est pas celui d\'un README', 'READMEFIRST.md'],
  ['un README renommé en sauvegarde', 'README.md.bak'],
  ['un fichier qui parle de README', 'mon-readme.md'],
  ['une région de plus de huit caractères', 'README.fr-latn12345.md'],
  ['une région de plus de huit caractères (onze)', 'README.fr-francophone.md'],
  ['une région d\'un seul caractère', 'README.fr-x.md'],
  ['un suffixe qui n\'est ni une langue ni une extension de texte', 'README-assets.md'],
  ['une image qui s\'appelle README', 'README.png'],
  ['un exécutable qui s\'appelle README', 'readme.exe'],
  ['un PDF qui s\'appelle README', 'README.pdf'],
  ['un code de langue de trois lettres sans extension', 'README.fra'],
  ['un code de langue d\'une seule lettre', 'README.f.md'],
];
for (const [nom, chemin] of IGNORES) {
  test(`B-DOC-01 : ${nom} (${chemin}) n'est pas le README du dépôt : il n'y en a pas`, () => {
    const [c, ...autres] = constatsDe([fichier(chemin)]);
    assert.equal(autres.length, 0);
    assert.equal(c.regle, 'B-DOC-01');
    assert.equal(c.bloquant, true);
  });
}

test('B-DOC-01 : sans aucun fichier, aucun README : majeur et bloquant, comme avant', () => {
  const [c, ...autres] = constatsDe([]);
  assert.equal(autres.length, 0);
  assert.deepEqual([c.regle, c.severite, c.bloquant, c.confiance], ['B-DOC-01', 'majeur', true, 'certain']);
  assert.equal(c.titre, 'Aucun README à la racine du dépôt');
});

test('B-DOC-02 : un README d\'un autre nom est jugé comme README.md, et le constat le cite', () => {
  const [c, ...autres] = constatsDe([fichier('LISEZMOI.md', '# Titre\nRien d\'autre.\n')]);
  assert.equal(autres.length, 0);
  assert.equal(c.regle, 'B-DOC-02');
  assert.equal(c.fichier, 'LISEZMOI.md');
  assert.match(c.titre, /^README incomplet : ce que fait le widget, comment le configurer, ses dépendances$/);
});

test('B-DOC-02 : les rubriques se cherchent dans tous les README de la racine : une rubrique dite dans l\'un est dite', () => {
  const anglais = '# My widget\n\n## Description\nShows cards.\n';
  const francais = '# Mon widget\n\n## Configuration\nColonnes attendues : titre.\n\n## Dépendances\nAucune dépendance.\n';
  assert.deepEqual(regles([fichier('README.md', anglais), fichier('README.fr.md', francais)]), []);
  assert.deepEqual(regles([fichier('README.md', anglais)]), ['B-DOC-02'], 'témoin : le seul README anglais est incomplet');
  assert.deepEqual(regles([fichier('README.fr.md', francais)]), ['B-DOC-02'], 'témoin : le seul README français est incomplet');
});

test('B-DOC-02 : deux README se joignent par une fin de ligne : le titre du second, en tête de fichier, est un titre', () => {
  const [premier, second] = ['# Titre\nConfiguration : colonnes.', 'Description\nAffiche des cartes. Aucune dépendance.'];   // aucun des deux ne finit par une fin de ligne
  assert.deepEqual(regles([fichier('README.md', premier), fichier('README.rst', second)]), []);
});

test('B-DOC-02 : README.md est le fichier cité quand il est là, sinon le premier dans l\'ordre des noms', () => {
  const vide = '# Titre\n';
  assert.equal(constatsDe([fichier('README.fr.md', vide), fichier('README.md', vide), fichier('README.en.md', vide)])[0].fichier, 'README.md');
  assert.equal(constatsDe([fichier('README.fr.md', vide), fichier('README.en.md', vide)])[0].fichier, 'README.en.md');
  assert.equal(constatsDe([fichier('LISEZMOI.md', vide), fichier('README.rst', vide)])[0].fichier, 'LISEZMOI.md');
});

const ROLE = (contenu) => constatsDe([fichier('README.md', `${contenu}\nConfiguration : colonnes. Dépendances : aucune dépendance.\n`)]).filter((c) => c.regle === 'B-DOC-02').length;
const RUBRIQUES_DE_ROLE = [
  ['un titre Markdown', '## Description\nAffiche des cartes.'],
  ['un titre de ligne', 'Description\nAffiche des cartes.'],
  ['un titre AsciiDoc', '== Description\nAffiche des cartes.'],
  ['un titre Org', '* Description\nAffiche des cartes.'],
  ['un titre souligné (reStructuredText) après un titre de document', 'Mon widget\n==========\n\nDescription\n-----------\nAffiche des cartes.'],
  ['le premier mot du fichier', 'Présentation du widget : il affiche des cartes.'],
  ['un titre de ligne qui n\'est pas en tête du fichier', 'Mon widget\n\nDescription\nAffiche des cartes.'],
];
for (const [nom, contenu] of RUBRIQUES_DE_ROLE) {
  test(`B-DOC-02 : « ce que fait le widget » est reconnu sous ${nom}`, () => assert.equal(ROLE(contenu), 0));
}
test('B-DOC-02 : un mot de rubrique au milieu d\'une phrase n\'est pas un titre', () => {
  assert.equal(ROLE('Le widget affiche des cartes et une description des colonnes.'), 1);
});

test('B-DOC-03 : le niveau d\'accès se cherche dans tous les README, et le constat cite le principal', () => {
  const sansAcces = '# W\n## Description\nx\n## Configuration\ny\n## Dépendances\nz\n';
  const avecAcces = '## Accès au document\nrequiredAccess: full, pour lire toutes les tables.\n';
  const ctx = { usagesGrist: { acces: [{ niveau: 'full' }] } };
  assert.deepEqual(regles([fichier('README.md', sansAcces)], ctx), ['B-DOC-03']);
  assert.deepEqual(regles([fichier('README.md', sansAcces), fichier('README.fr.md', avecAcces)], ctx), []);
  assert.equal(constatsDe([fichier('README.fr.md', sansAcces), fichier('README.md', sansAcces)], ctx).find((c) => c.regle === 'B-DOC-03').fichier, 'README.md');
});

test('B-DOC-04 : un hôte externe nommé dans l\'un des README est documenté', () => {
  const ctx = { destinationsExternes: new Set(['api.example.org']) };
  assert.deepEqual(regles([fichier('README.md'), fichier('LISEZMOI.md', 'Le widget appelle api.example.org pour les cartes.')], ctx), []);
  assert.deepEqual(regles([fichier('README.md')], ctx), ['B-DOC-04']);
  assert.deepEqual(regles([fichier('README.md', `${COMPLET}\nAppelle API.Example.ORG.\n`)], ctx), [], 'un nom d\'hôte se lit sans égard à la casse');
});

test('un README dont l\'inventaire n\'a lu aucun texte (fichier trop gros, plafond cumulé atteint, lecture refusée) est présent, et son contenu n\'est pas jugé : ni B-DOC-01, ni constat inventé', () => {
  const sansTexte = { chemin: 'README.md', ext: '.md', taille: 17_000_000, binaire: true, nonLu: { cause: 'taille' }, executee: false, vendorise: false };
  assert.deepEqual(regles([sansTexte]), []);
  assert.deepEqual(regles([sansTexte], { usagesGrist: { acces: [{ niveau: 'full' }] }, destinationsExternes: new Set(['api.example.org']) }), []);
  // Le README qu'on lit est jugé, celui qu'on ne lit pas n'ôte rien et n'est pas cité.
  const [c, ...autres] = constatsDe([sansTexte, fichier('README.fr.md', '# Titre\n')]);
  assert.equal(autres.length, 0);
  assert.deepEqual([c.regle, c.fichier], ['B-DOC-02', 'README.fr.md']);
});

test('un README vide est un README : il manque ses trois rubriques', () => {
  const [c, ...autres] = constatsDe([fichier('README.md', '')]);
  assert.equal(autres.length, 0);
  assert.equal(c.regle, 'B-DOC-02');
});
