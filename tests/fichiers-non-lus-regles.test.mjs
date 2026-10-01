import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditer } from './aide-surface.mjs';
import { NOMS_DE_FICHIERS_NON_LUS, widgetAvecFichierNonLu } from '../scripts/lib/pieges.mjs';

/**
 * Un fichier que l'inventaire ne lit pas (au-delà du plafond de lecture par fichier, ici ramené à 400 octets ; une extension de binaire) ne fait échouer
 * aucune règle. `statique.js` n'attrape rien : une règle qui lit le texte d'un fichier sans vérifier qu'il existe fait lever une exception, l'analyse
 * s'arrête, le programme sort sans rapport. C'était le cas du README et de la licence : un widget qui empêche la mesure ne doit pas noter mieux que
 * s'il la laissait se faire, et une analyse qui s'arrête sans rapport est pire qu'un mauvais verdict.
 *
 * Chaque fichier de la table (`scripts/lib/pieges.mjs`) est essayé sous trois formes : seul, chargé par une balise `<script>`, créé comme `Worker`.
 * `scripts/balayer-fichiers-non-lus.mjs` joue la table entière (quatorze formes) sur n'importe quelle version de l'outil.
 *
 * Ces essais gardent une famille de défauts, pas une ligne : aucun mutant n'est posé pour eux (`scripts/mutants-licence.mjs` et
 * `scripts/mutants-readme.mjs` ont les leurs). Sur le code d'avant le correctif de la licence, ils échouent pour chaque nom de licence et pour le témoin.
 */

const PLAFOND = 400;
const FORMES = ['seul', 'script', 'worker'];
const BINAIRE = /\.(pdf|png|wasm|woff2)$/;

for (const nom of NOMS_DE_FICHIERS_NON_LUS) {
  test(`un fichier « ${nom} » que l'inventaire ne lit pas ne fait échouer aucune règle`, async () => {
    for (const forme of FORMES) {
      for (const nature of BINAIRE.test(nom) ? ['texte', 'binaire'] : ['texte']) {
        const fichiers = widgetAvecFichierNonLu(nom, forme, nature, PLAFOND + 1);
        await assert.doesNotReject(auditer(fichiers, { plafonds: { maxOctetsFichier: PLAFOND } }), `${nom}, ${forme}, ${nature}`);
      }
    }
  });
}

test('témoin : le fichier que la table donne n\'est pas lu par l\'inventaire (sans quoi les essais ci-dessus ne prouvent rien)', async () => {
  // Un dossier que l'inventaire n'explore pas (`vendor/`, `dist/`) ne donne un fichier que si une page le charge : sous la forme « seul », il n'y en a pas.
  for (const [nom, forme] of [['README.md', 'seul'], ['LICENSE', 'seul'], ['package.json', 'seul'], ['app.js', 'seul'], ['vendor/lib.js', 'script'], ['dist/bundle.js', 'script']]) {
    const a = await auditer(widgetAvecFichierNonLu(nom, forme, 'texte', PLAFOND + 1), { plafonds: { maxOctetsFichier: PLAFOND } });
    const f = a.fichier(nom);
    assert.equal(f.contenu, undefined, nom);
    assert.equal(f.binaire, true, nom);
  }
  const a = await auditer(widgetAvecFichierNonLu('LICENSE.pdf', 'seul', 'binaire', PLAFOND + 1), { plafonds: { maxOctetsFichier: PLAFOND } });
  assert.equal(a.fichier('LICENSE.pdf').contenu, undefined);
  const lu = await auditer(widgetAvecFichierNonLu('LICENSE', 'seul', 'texte', PLAFOND), { plafonds: { maxOctetsFichier: PLAFOND } });
  assert.equal(typeof lu.fichier('LICENSE').contenu, 'string', 'au plafond exact, le fichier est lu : le balayage joue un octet de plus');
});
