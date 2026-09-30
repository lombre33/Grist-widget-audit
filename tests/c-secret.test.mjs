/**
 * C-SECRET-01 : un secret en dur dans le dépôt. La règle ne dit « secret » (critique, bloquant) que sur une preuve : le
 * format d'un fournisseur, ou la valeur d'allure générée d'un nom qui évoque un secret. Une clé que son fournisseur publie
 * pour une page est une information, la clé d'exemple d'AWS n'est rien, une valeur de remplacement ou une phrase ne dit
 * rien, le reste est « à vérifier » (majeur, non bloquant). Un « nom = valeur » se lit dans l'arbre d'un fichier JS et ligne à
 * ligne dans les fichiers de configuration ; jamais dans un message, un commentaire, une carte de sources ni un README.
 * Aucun constat ne redit la valeur. Chaque essai a son mutant dans `scripts/mutants-c-secret.mjs`.
 *
 * Aucun secret n'est écrit ici : chaque valeur est assemblée à l'exécution (un hébergeur refuse de recevoir un dépôt qui
 * en contient un, et l'outil le signalerait sur lui-même).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extname } from 'node:path';
import { auditer, page } from './aide-surface.mjs';
import {
  FORMATS, formatsDans, motsDuNom, nomEvoqueUnSecret, motsDeLaValeur, classesDe, entropieDe, estGeneree, jugerValeur,
  estFichierDeConfiguration, affectationsDeConfiguration, analyserSecrets, masquer,
} from '../src/regles/c-secrets.js';

// Des valeurs tirées au hasard, mais les mêmes à chaque lancement (mulberry32).
function graine(n) {
  let x = n >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hasard = graine(20260930);
const tirer = (n, alphabet) => Array.from({ length: n }, () => alphabet[Math.floor(hasard() * alphabet.length)]).join('');
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const URL64 = `${ALNUM}_-`;
const BASE64 = `${ALNUM}+/`;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const HEX = '0123456789abcdef';
const generee = (n = 40) => tirer(n, ALNUM);

/** Les sept formats de fournisseur qui sont des secrets (OpenAI sous ses deux formes : sans type et à type), assemblés à l'exécution. */
const SECRETS = [
  { id: 'aws', libelle: "clé d'accès AWS", valeur: `AK${'IA'}${tirer(16, BASE32)}` },
  { id: 'github', libelle: 'jeton personnel GitHub', valeur: `gh${'p_'}${tirer(36, ALNUM)}` },
  { id: 'github-pat', libelle: 'jeton personnel GitHub (format récent)', valeur: `github${'_pat_'}${tirer(22, ALNUM)}_${tirer(59, ALNUM)}` },
  { id: 'openai', libelle: "clé d'API de type OpenAI", valeur: `sk${'-'}${tirer(48, ALNUM)}` },
  { id: 'openai', libelle: "clé d'API de type OpenAI", valeur: `sk${'-proj-'}${tirer(120, URL64)}` },
  { id: 'slack', libelle: 'jeton Slack', valeur: `xo${'xb-'}1234567890-1234567890123-${tirer(24, ALNUM)}` },
  { id: 'pem', libelle: 'clé privée', valeur: `-----BEGIN RSA PRIVATE ${'KEY-----'}\\n${tirer(64, BASE64)}\\n-----END RSA PRIVATE KEY-----` },
  { id: 'jwt', libelle: 'jeton JWT', valeur: `eyJ${tirer(17, URL64)}.eyJ${tirer(40, URL64)}.${tirer(43, URL64)}` },
];
const PUBLIQUES = [
  { id: 'google', libelle: "clé d'API Google", valeur: `AI${'za'}${tirer(35, URL64)}` },
  { id: 'stripe', libelle: 'clé publique Stripe', valeur: `pk_${'live_'}${tirer(24, ALNUM)}` },
  { id: 'mapbox', libelle: 'jeton public Mapbox', valeur: `pk.${'eyJ1Ijoi'}${tirer(30, URL64)}.${tirer(22, URL64)}` },
];
/** Les clés d'exemple de la documentation d'AWS. */
const EXEMPLE_CLE = `AKIA${'IOSFODNN7'}EXAMPLE`;
const EXEMPLE_SECRET = `wJalrXUtnFEMI/K7MDENG/bPxRfiCY${'EXAMPLEKEY'}`;

const C_SECRET = (a) => a.de('C-SECRET-01');
const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''}`;
/** Le milieu d'une valeur : assez long pour n'être pas un hasard, sans l'échappement d'un retour à la ligne. */
const milieu = (v) => v.slice(Math.floor(v.length / 2) - 8, Math.floor(v.length / 2) + 8);
/** Ni un constat, ni son extrait, ni sa preuve ne redit une valeur en entier ou en partie (son milieu). */
function sansFuite(a, valeurs) {
  const texte = JSON.stringify(C_SECRET(a));
  for (const v of valeurs) {
    assert.ok(!texte.includes(v), `le constat redit la valeur ${v.slice(0, 6)}…`);
    if (v.length >= 20) assert.ok(!texte.includes(milieu(v)), `le constat redit le milieu de la valeur ${v.slice(0, 6)}…`);
  }
}

// --- Les formats de fournisseur -------------------------------------------------------------------------------------

test('chaque format de fournisseur est un critique bloquant qui dit son fichier et sa ligne, et ne redit jamais la valeur', async () => {
  for (const { id, libelle, valeur } of SECRETS) {
    const a = await auditer({ 'app.js': `var x = 1;\nvar valeur = '${valeur}';\n` });
    const cs = C_SECRET(a);
    assert.equal(cs.length, 1, `${id} : un constat, non ${cs.length}`);
    const [c] = cs;
    assert.equal(etat(c), 'critique bloquant', id);
    assert.equal(c.axe, 'C');
    assert.equal(c.confiance, 'probable');
    assert.equal(c.fichier, 'app.js');
    assert.equal(c.ligne, 2, `${id} : la ligne`);
    assert.equal(c.titre, `Secret potentiel versionné dans le dépôt (${libelle})`);
    assert.equal(c.extrait, id === 'pem' ? '-----BEGIN RSA PRIVATE KEY----- (corps non reproduit)' : masquer(valeur), `${id} : l'extrait est masqué`);
    assert.deepEqual(c.preuve, { forme: 'fournisseur', fournisseur: id, publique: false, longueur: id === 'pem' ? '-----BEGIN RSA PRIVATE KEY-----'.length : valeur.length }, `${id} : la valeur reconnue d'une clé PEM est son en-tête`);
    assert.deepEqual(c.referentiels, ["ANSSI — Guide d'hygiène informatique", 'CWE-798', 'OWASP Top 10 A07:2021']);
    assert.ok(c.impact && c.remediation);
    sansFuite(a, [valeur]);
  }
});

test('le format vaut dans tout texte : carte de sources, README, JSON, .env, fichier que rien n\'exécute', async () => {
  const cle = SECRETS[0].valeur;
  const a = await auditer({
    'app.js.map': `{"version":3,"sourcesContent":["var k = '${cle}'"]}`,
    'README.md': `# Widget\n\nUtilisez la clé ${cle} pour l'essai.\n`,
    'data.json': `{\n  "a": "${cle}"\n}\n`,
    '.env': `DEBUG=1\nAWS=${cle}\n`,
    'scripts/deploy.js': `// déploiement\nconst k = '${cle}';\n`,
    'notes.txt': `${cle}\n`,
  });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.fichier}:${c.ligne}`).sort(), ['.env:2', 'README.md:3', 'app.js.map:1', 'data.json:2', 'notes.txt:1', 'scripts/deploy.js:2']);
  assert.ok(C_SECRET(a).every((c) => etat(c) === 'critique bloquant'));
  sansFuite(a, [cle]);
});

test('une clé publique par conception (Google, Stripe, Mapbox) est une information : ni critique, ni bloquante, et sans secret à révoquer', async () => {
  for (const { id, libelle, valeur } of PUBLIQUES) {
    const a = await auditer({ 'app.js': `var cle = '${valeur}';\n` });
    const cs = C_SECRET(a);
    assert.equal(cs.length, 1, `${id} : un constat, non ${cs.length}`);
    const [c] = cs;
    assert.equal(etat(c), 'info', id);
    assert.equal(c.confiance, 'certain');
    assert.equal(c.titre, `Clé publique par conception dans le code (${libelle})`);
    assert.match(c.constat, /ce n'est pas un secret/);
    assert.match(c.remediation, /restreinte aux domaines du widget/);
    assert.deepEqual(c.preuve, { forme: 'fournisseur', fournisseur: id, publique: true, longueur: valeur.length });
    assert.equal(c.extrait, masquer(valeur));
    sansFuite(a, [valeur]);
  }
});

test('une clé publique sous un nom qui évoque un secret reste une information : le format décide avant l\'allure', async () => {
  const [google, stripe, mapbox] = PUBLIQUES.map((p) => p.valeur);
  const a = await auditer({ 'app.js': `var mapboxAccessToken = '${mapbox}';\nvar stripeKey = '${stripe}';\nvar apiKey = '${google}';\n` });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.ligne} ${etat(c)}`), ['1 info', '2 info', '3 info']);
});

test('les clés d\'exemple de la documentation d\'AWS ne sont pas des secrets, où qu\'elles soient', async () => {
  const a = await auditer({
    'app.js': `var cle = '${EXEMPLE_CLE}';\nvar secretAccessKey = '${EXEMPLE_SECRET}';\n`,
    '.env': `AWS_ACCESS_KEY_ID=${EXEMPLE_CLE}\nAWS_SECRET_ACCESS_KEY=${EXEMPLE_SECRET}\n`,
    'credentials.ini': `[default]\naws_access_key_id = ${EXEMPLE_CLE}\naws_secret_access_key = ${EXEMPLE_SECRET}\n`,
  });
  assert.deepEqual(C_SECRET(a), []);
});

test('une clé AWS qui ne finit pas par EXAMPLE est un secret, même si elle en contient le mot', async () => {
  const cle = `AKIA${tirer(6, BASE32)}EXAMPLE${tirer(3, BASE32)}`;
  assert.equal(cle.length, 20);
  const a = await auditer({ 'app.js': `var cle = '${cle}';\n` });
  assert.equal(C_SECRET(a).length, 1);
});

test('un en-tête de clé privée n\'est pas une clé : il en faut le corps (une bibliothèque qui lit des clés PEM cite l\'en-tête)', async () => {
  const corps = tirer(64, BASE64);
  const a = await auditer({
    'lib/pem.js': "var DEBUT = '-----BEGIN RSA PRIVATE KEY-----', FIN = '-----END RSA PRIVATE KEY-----';\nvar ENTETES = ['-----BEGIN PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----'];\n",
    'cle.pem': `-----BEGIN PRIVATE KEY-----\n${corps}\n${corps}\n-----END PRIVATE KEY-----\n`,
    'chiffree.pem': `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${corps}\n-----END ENCRYPTED PRIVATE KEY-----\n`,
    'dsa.pem': `-----BEGIN DSA PRIVATE KEY-----\n${corps}\n-----END DSA PRIVATE KEY-----\n`,
    'ssh.key': `-----BEGIN OPENSSH PRIVATE KEY-----\n${corps}\n-----END OPENSSH PRIVATE KEY-----\n`,
    'ec.key': `-----BEGIN EC PRIVATE KEY-----\n${corps}\n-----END EC PRIVATE KEY-----\n`,
    'pgp.asc': `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: Essai 1.0\n\n${corps}\n-----END PGP PRIVATE KEY BLOCK-----\n`,
    'public.pem': `-----BEGIN PUBLIC KEY-----\n${corps}\n-----END PUBLIC KEY-----\n`,
    'certificat.pem': `-----BEGIN CERTIFICATE-----\n${corps}\n-----END CERTIFICATE-----\n`,
    'concatene.js': `var cle = "-----BEGIN RSA PRIVATE KEY-----\\n" + "${corps}" + "\\n-----END RSA PRIVATE KEY-----";\n`,
  });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.fichier}:${c.ligne}`).sort(), ['chiffree.pem:1', 'cle.pem:1', 'concatene.js:1', 'dsa.pem:1', 'ec.key:1', 'pgp.asc:1', 'ssh.key:1']);
  sansFuite(a, [corps]);
});

test('une clé OpenAI actuelle (sk-proj-…) est reconnue, une classe CSS ou un identifiant long à tirets ne l\'est pas', async () => {
  const cas = {
    'trop-court.js': `var a = 'sk-${tirer(31, ALNUM)}';\n`,
    'assez-long.js': `var a = 'sk-${tirer(32, ALNUM)}';\n`,
    'projet-court.js': `var a = 'sk-proj-${tirer(39, URL64)}';\n`,
    'projet.js': `var a = 'sk-proj-${tirer(40, URL64)}';\n`,
    'compte.js': `var a = 'sk-svcacct-${tirer(60, URL64)}';\n`,
    'admin.js': `var a = 'sk-admin-${tirer(60, URL64)}';\n`,
    'classe.css': '.sk-circle-rotating-spinner-with-a-very-long-descriptive-class-name { color: red; }\n',
    'mot.js': "var a = 'sk-circleRotatingSpinnerWithAVeryLongDescriptiveClassName';\n",
  };
  const a = await auditer(cas);
  assert.deepEqual(C_SECRET(a).map((c) => c.fichier).sort(), ['admin.js', 'assez-long.js', 'compte.js', 'projet.js']);
});

test('un jeton à deux segments n\'est pas un JWT ; un jeton d\'un fournisseur de cartes n\'est qu\'une information, pas aussi un JWT', async () => {
  const deux = `eyJ${tirer(17, URL64)}.${tirer(40, URL64)}`;
  const court = `eyJ${tirer(17, URL64)}.eyJ${tirer(40, URL64)}.${tirer(9, URL64)}`;
  const mapbox = PUBLIQUES[2].valeur;
  const a = await auditer({ 'deux.js': `var t = '${deux}';\n`, 'court.js': `var t = '${court}';\n`, 'carte.js': `var t = '${mapbox}';\n` });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.fichier} ${etat(c)}`), ['carte.js info']);
});

test('un secret d\'un littéral que le code exécute (eval, Function) n\'est compté qu\'une fois : à son fichier d\'origine quand il y est en clair', async () => {
  const pat = SECRETS[1].valeur;
  const cle = generee();
  const a = await auditer({
    'index.html': page('<script src="app.js"></script>'),
    'app.js': `eval('var x = "${pat}";');\neval('var apiKey = "${cle}";');\n`,
  });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.fichier} ${c.ligne} ${c.preuve.forme}`), ['app.js 1 fournisseur', 'app.js (code littéral, ligne 2, colonne 1) 1 code']);
  sansFuite(a, [pat, cle]);
});

test('un fichier de verrous de paquets n\'est pas lu', async () => {
  const cle = SECRETS[0].valeur;
  const a = await auditer({ 'package-lock.json': `{ "a": "${cle}" }\n`, 'yarn.lock': `${cle}\n`, 'pnpm-lock.yaml': `${cle}\n`, 'sous/package-lock.json': `${cle}\n` });
  assert.deepEqual(C_SECRET(a), []);
});

// --- « nom = valeur » dans le code ---------------------------------------------------------------------------------

test('un nom qui évoque un secret reçoit une valeur d\'allure générée : critique bloquant, sous toutes les formes d\'affectation d\'un littéral', async () => {
  const v = Array.from({ length: 12 }, () => generee());
  const source = [
    `const apiKey = '${v[0]}';`,                          // 1 déclaration
    'const config = {',                                    // 2
    `  secret: '${v[1]}',`,                                // 3 propriété, clé identifiant
    `  'client-secret': "${v[2]}",`,                       // 4 propriété, clé chaîne
    `  ["x-api-key"]: \`${v[3]}\`,`,                       // 5 clé calculée, gabarit sans expression
    '};',                                                  // 6
    `config.accessToken = '${v[4]}';`,                     // 7 affectation à un membre
    `headers['x-auth-token'] = '${v[5]}';`,                // 8 affectation à un membre calculé
    `function appeler(token = '${v[6]}') {}`,              // 9 valeur par défaut
    `const rappel = (motDePasse = '${v[7]}') => motDePasse;`, // 10
    `class Client { static password = '${v[8]}'; #privateKey = '${v[9]}'; }`, // 11 champs de classe
    `let jetonSecret; jetonSecret = '${v[10]}';`,          // 12 affectation à un identifiant
    `const { passphrase = '${v[11]}' } = config;`,         // 13 défaut d'un motif
  ].join('\n');
  const a = await auditer({ 'app.js': `${source}\n` });
  const lignes = C_SECRET(a).map((c) => `${c.ligne} ${c.preuve.nom}`);
  assert.deepEqual(lignes, ['1 apiKey', '3 secret', '4 client-secret', '5 x-api-key', '7 accessToken', '8 x-auth-token', '9 token', '10 motDePasse', '11 password', '11 privateKey', '12 jetonSecret', '13 passphrase']);
  for (const c of C_SECRET(a)) {
    assert.equal(etat(c), 'critique bloquant');
    assert.equal(c.confiance, 'probable');
    assert.equal(c.preuve.forme, 'code');
    assert.equal(c.titre, `Secret potentiel versionné dans le dépôt (valeur d'allure générée dans « ${c.preuve.nom} »)`);
    assert.equal(c.fichier, 'app.js');
  }
  const [premier] = C_SECRET(a);
  assert.equal(premier.extrait, `apiKey = ${masquer(v[0])}`);
  assert.deepEqual({ ...premier.preuve, entropie: typeof premier.preuve.entropie }, { forme: 'code', nom: 'apiKey', longueur: 40, classes: premier.preuve.classes, entropie: 'number' });
  assert.ok(premier.preuve.classes >= 3);
  assert.match(premier.constat, /« apiKey » reçoit un littéral de 40 caractères/);
  sansFuite(a, v);
});

test('un script de page est lu comme un fichier JS, à sa ligne dans la page', async () => {
  const cle = generee(30);
  const a = await auditer({ 'index.html': page(`<p>x</p>\n<script>\n  var clientSecret = '${cle}';\n</script>`) });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.fichier}:${c.ligne}`), ['index.html:3']);
  sansFuite(a, [cle]);
});

test('ce qu\'un message, un commentaire, une carte de sources ou un README citent n\'est pas une affectation', async () => {
  const cle = generee();
  const a = await auditer({
    'app.js': [
      `// const apiKey = '${cle}';`,
      `/* token: '${cle}' */`,
      "var message = \"Il manque mapboxAccessToken: 'my-access-token' dans la configuration\";",
      `var texte = "const password = '${cle}'";`,
      'var url = "access_token=" + (o || Y.ACCESS_TOKEN || "");',
      `var modele = \`apiKey = '\${x}'\`;`,
    ].join('\n') + '\n',
    'app.js.map': `{"version":3,"sourcesContent":["const apiKey = '${cle}'; var token = '${cle}';"]}`,
    'README.md': `# Widget\n\n\`\`\`js\nconst apiKey = '${cle}';\n\`\`\`\n\nAPI_KEY=${cle}\n`,
    'notes.txt': `password=${cle}\n`,
    'page.html': page(`<p>const apiKey = '${cle}'</p><input name="token" value="${cle}">`),
  });
  assert.deepEqual(C_SECRET(a), []);
});

test('une valeur de remplacement, une phrase ou une adresse ne dit rien ; un littéral que rien n\'explique est « à vérifier » : majeur, non bloquant', async () => {
  const source = [
    "const apiKey = 'YOUR_API_KEY';",
    "const token = 'xxxxxxxxxxxx';",
    "const secret = '<secret>';",
    "const password = 'changeme';",
    "const motDePasse = '';",
    "const jeton = { token: '${TOKEN}' };",
    "const ReactPropTypesSecret = 'SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED';",
    "const accessToken = 'my-access-token';",
    "const tokenLabel = 'Jeton d\\'accès';",
    "const passwordHint = 'Au moins douze caractères';",
    "const passwd = 'Mot de passe oublié';",
    "const tokenUrl = 'https://exemple.test/oauth/token';",
    "const authToken = '/api/auth/token';",
    "const apiToken = process.env.API_TOKEN;",
    "const secretName = 'mon-secret-de-prod-2024-ab12';",
    "const sortKey = 'ab12cd34ef56gh78ij90kl12';",
    "const token2 = 'abc';",
    "const hunter = { password: 'hunter2hunter2' };",
    "const doublure = { token: 'stub-token', baseUrl: 'http://localhost/api/docs/stub' };",
    "const oiseau = { password: 'mockingbird' };",
  ].join('\n');
  const a = await auditer({ 'app.js': `${source}\n` });
  const cs = C_SECRET(a);
  assert.deepEqual(cs.map((c) => `${c.ligne} ${etat(c)} ${c.confiance}`), ['18 majeur a_verifier', '20 majeur a_verifier']);
  assert.equal(cs[0].titre, 'Valeur en dur dans « password » : un secret ou un exemple ? (à vérifier)');
  assert.match(cs[0].constat, /« password » reçoit un littéral de 14 caractères qui n'a pas l'allure d'une valeur générée/);
  assert.match(cs[0].remediation, /YOUR_API_KEY/);
  assert.equal(cs[0].preuve.forme, 'code');
  assert.equal(cs[0].extrait, 'password = hu…r2 (14 caractères)');
  sansFuite(a, ['hunter2hunter2']);
});

test('un fichier que l\'arbre ne lit pas (TypeScript) n\'est lu que par les formats de fournisseur : la limite est dite, non cachée', async () => {
  const cle = generee();
  const pat = SECRETS[1].valeur;
  const a = await auditer({
    'src/app.ts': `const apiKey: string = '${cle}';\nconst depot: string = '${pat}';\n`,
  });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.fichier}:${c.ligne} ${c.preuve.forme}`), ['src/app.ts:2 fournisseur']);
});

test('un fichier qui ne parle pas d\'un secret n\'est pas lu par l\'arbre : même résultat, sans lecture de plus', async () => {
  const { lire } = await import('../src/moteur/analyse-js.js');
  assert.equal(typeof lire, 'function');
  const a = await auditer({ 'app.js': `const nom = 'x'.repeat(40);\nconst apiKey = '${generee()}';\n`, 'autre.js': "const z = 1;\n" });
  assert.deepEqual(C_SECRET(a).map((c) => c.fichier), ['app.js']);
});

// --- « nom = valeur » dans la configuration ------------------------------------------------------------------------

test('un fichier de configuration est lu ligne à ligne : .env, .json, .yml, .yaml, .ini, .properties, .toml, .npmrc', async () => {
  const v = Array.from({ length: 10 }, () => generee(36));
  const fichiers = {
    '.env': `# configuration\nDEBUG=1\nAPI_KEY=${v[0]}\n`,
    '.env.local': `# configuration\nDEBUG=1\nexport DB_PASSWORD="${v[1]}"\n`,
    'production.env': `# configuration\nDEBUG=1\nCLIENT_SECRET='${v[2]}'\n`,
    'config.json': `{\n  "name": "x",\n  "apiKey": "${v[3]}",\n  "tokenUrl": "https://x.example/t"\n}\n`,
    'config.yml': `name: x\nversion: 1\napi_key: ${v[4]}\n`,
    'config.yaml': `name: x\nversion: 1\n- token: "${v[5]}"\n`,
    'reglages.ini': `[principal]\nnom = x\napi_key = ${v[6]}\n`,
    'app.properties': `nom=x\nversion=1\nspring.datasource.password=${v[7]}\n`,
    'config.toml': `nom = "x"\nversion = 1\nsecret_key = "${v[8]}"\n`,
    '.npmrc': `registry=https://registry.npmjs.org/\nalways-auth=true\n//registry.npmjs.org/:_authToken=${v[9]}\n`,
  };
  const a = await auditer(fichiers);
  assert.deepEqual(C_SECRET(a).map((c) => `${c.fichier}:${c.ligne}`), Object.keys(fichiers).sort().map((f) => `${f}:3`));
  for (const c of C_SECRET(a)) {
    assert.equal(etat(c), 'critique bloquant');
    assert.equal(c.preuve.forme, 'configuration');
  }
  assert.deepEqual(C_SECRET(a).map((c) => c.preuve.nom), ['.env', '.env.local', '.npmrc', 'app.properties', 'config.json', 'config.toml', 'config.yaml', 'config.yml', 'production.env', 'reglages.ini'].map((f) => ({
    '.env': 'API_KEY', '.env.local': 'DB_PASSWORD', '.npmrc': '_authToken', 'app.properties': 'spring.datasource.password', 'config.json': 'apiKey',
    'config.toml': 'secret_key', 'config.yaml': 'token', 'config.yml': 'api_key', 'production.env': 'CLIENT_SECRET', 'reglages.ini': 'api_key',
  })[f]));
  sansFuite(a, v);
});

test('les mêmes lignes dans un README, un texte, une carte de sources ou une donnée ne sont pas lues', async () => {
  const cle = generee(36);
  const lignes = `# configuration\nDEBUG=1\nAPI_KEY=${cle}\n"apiKey": "${cle}"\n`;
  const a = await auditer({ 'README.md': lignes, 'notes.txt': lignes, 'app.js.map': lignes, 'donnees.csv': lignes, 'page.html': page(`<pre>${lignes}</pre>`) });
  assert.deepEqual(C_SECRET(a), []);
});

test('une valeur de remplacement, vide ou qui renvoie à l\'environnement ne dit rien en configuration', async () => {
  const a = await auditer({
    '.env.example': 'API_KEY=\nDB_PASSWORD=your_password_here\nSECRET_TOKEN=changeme\nCLIENT_SECRET=<votre secret>\nAUTH_TOKEN=${TOKEN}\nREFRESH_TOKEN=$TOKEN\nTOKEN_URL=https://exemple.test/t\n',
    'config.json': '{\n  "password": null,\n  "token": "",\n  "apiKey": "YOUR_API_KEY",\n  "secret": "${SECRET}",\n  "tokenType": "Bearer"\n}\n',
    'config.yml': 'password: !secret mot_de_passe\ntoken: ~\nsecret: "xxxxxxxxxxxx"\n',
  });
  assert.deepEqual(C_SECRET(a), []);
});

test('un JSON minifié tient sur une ligne : chaque affectation est lue, la valeur qui a le format d\'un fournisseur n\'est dite qu\'une fois', async () => {
  const v = [generee(36), generee(36), SECRETS[1].valeur];
  const a = await auditer({ 'config.json': `{"apiKey":"${v[0]}","nom":"x","token":"${v[1]}","jetonGithubToken":"${v[2]}","passwordHash":"${generee(36)}"}\n` });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.ligne} ${c.preuve.forme} ${c.preuve.nom ?? c.preuve.fournisseur}`), ['1 configuration apiKey', '1 configuration token', '1 fournisseur github']);
  sansFuite(a, v);
});

test('une valeur entre guillemets qui s\'étend sur plusieurs lignes ou qui n\'est jamais fermée n\'est pas une affectation lue', async () => {
  const a = await auditer({ 'config.json': `{\n  "apiKey": "${generee(36)}\n  ,"token": '${generee(36)}\n}\n` });
  assert.deepEqual(C_SECRET(a), []);
});

test('les constats d\'un fichier sortent dans l\'ordre de ses lignes, le format d\'un fournisseur et un « nom = valeur » mêlés', async () => {
  const a = await auditer({
    'app.js': `var a = 1;\nvar apiKey = '${generee()}';\nvar b = 2;\nvar c = 3;\nvar d = '${SECRETS[0].valeur}';\nvar e = 4;\nvar token = '${generee()}';\n`,
    'Z.js': `var motDePasse = '${generee()}';\n`,
  });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.fichier}:${c.ligne}`), ['Z.js:1', 'app.js:2', 'app.js:5', 'app.js:7']);
});

// --- Les mesures et les décisions, une à une ----------------------------------------------------------------------------------

test('FORMATS : sept secrets et trois clés publiques, chacun avec son identifiant', () => {
  assert.deepEqual(FORMATS.map((f) => `${f.id}${f.publique ? ' (publique)' : ''}`), ['aws', 'github', 'github-pat', 'openai', 'slack', 'pem', 'jwt', 'google (publique)', 'stripe (publique)', 'mapbox (publique)']);
  for (const { id, valeur } of [...SECRETS, ...PUBLIQUES]) assert.equal(formatsDans(`x ${valeur} y`).map((t) => t.format.id).join(), id, id);
});

test('formatsDans : dans l\'ordre du texte, la valeur et sa position', () => {
  const [aws, pat] = [SECRETS[0].valeur, SECRETS[1].valeur];
  const trouves = formatsDans(`${pat} puis ${aws}`);
  assert.deepEqual(trouves.map((t) => [t.format.id, t.valeur, t.index]), [['github', pat, 0], ['aws', aws, pat.length + 6]]);
  assert.deepEqual(formatsDans(`${EXEMPLE_CLE}`), []);
  assert.deepEqual(formatsDans(''), []);
});

test('motsDuNom : camelCase, majuscules, tirets, points, chiffres', () => {
  assert.deepEqual(motsDuNom('clientSecret'), ['client', 'secret']);
  assert.deepEqual(motsDuNom('CLIENT_SECRET'), ['client', 'secret']);
  assert.deepEqual(motsDuNom('client-secret'), ['client', 'secret']);
  assert.deepEqual(motsDuNom('client.secret'), ['client', 'secret']);
  assert.deepEqual(motsDuNom('APIKey'), ['api', 'key']);
  assert.deepEqual(motsDuNom('HTMLToken'), ['html', 'token']);
  assert.deepEqual(motsDuNom('password2'), ['password', '2']);
  assert.deepEqual(motsDuNom('base64Token'), ['base', '64', 'token']);
  assert.deepEqual(motsDuNom('_authToken'), ['auth', 'token']);
  assert.deepEqual(motsDuNom('myTOKEN'), ['my', 'token'], 'une suite de majuscules après une minuscule est un mot');
  assert.deepEqual(motsDuNom('base64TOKEN'), ['base', '64', 'token'], 'une majuscule après un chiffre coupe, même quand une majuscule la suit');
  assert.deepEqual(motsDuNom('APIKEY'), ['apikey'], 'une suite de majuscules est un mot'); 
  assert.deepEqual(motsDuNom('tokenZ'), ['token', 'z'], 'Z est une majuscule');
  assert.deepEqual(motsDuNom('token9'), ['token', '9'], '9 est un chiffre');
  assert.deepEqual(motsDuNom('aZ9'), ['a', 'z9'], 'un chiffre après une majuscule ne coupe pas');
  assert.deepEqual(motsDuNom('tokenURL2'), ['token', 'url2']);
  assert.deepEqual(motsDuNom(''), []);
  assert.deepEqual(motsDuNom(undefined), []);
});

test('nomEvoqueUnSecret : le dernier mot décide, `key` seul ne dit rien', () => {
  for (const nom of ['apiKey', 'API_KEY', 'x-api-key', 'apikey', 'clientSecret', 'secret', 'accessToken', 'token', '_authToken', 'password', 'PASSWORD', 'passwd',
    'passphrase', 'mot_de_passe', 'motDePasse', 'motdepasse', 'secretKey', 'privateKey', 'PRIVATE_KEY', 'accessKey', 'authKey', 'masterKey', 'signingKey', 'encryptionKey',
    'token2', 'password1', 'spring.datasource.password', 'ReactPropTypesSecret', 'mapboxAccessToken', 'secretkey', 'privatekey', 'accesskey', 'authkey', 'myTOKEN',
    'X_AUTH_TOKEN', 'api-key']) {
    assert.ok(nomEvoqueUnSecret(nom), `${nom} évoque un secret`);
  }
  for (const nom of ['key', 'sortKey', 'keyCode', 'primaryKey', 'storageKey', 'tokenUrl', 'tokenType', 'tokenCount', 'passwordLabel', 'passwordHash', 'secretName', 'secretary',
    'tokenizer', 'tokens', 'id', 'name', 'mot_de_passe_oublie', 'passe', 'de_passe', '', '123', 'mot_passe', 'mot_x_passe', 'tokenZ', 'token-url', 'token2url']) {
    assert.ok(!nomEvoqueUnSecret(nom), `${nom} n'évoque pas un secret`);
  }
  assert.ok(nomEvoqueUnSecret(`${'x'.repeat(200)}_token`), 'un nom de plus de quatre-vingts caractères se juge sur sa fin');
  assert.ok(!nomEvoqueUnSecret(`token_${'x'.repeat(200)}`), 'et son dernier mot décide');
  assert.ok(!nomEvoqueUnSecret(undefined) && !nomEvoqueUnSecret(null));
});

test('masquer : jamais plus de quatre caractères de chaque côté, deux de treize à dix-neuf, aucun en dessous', () => {
  assert.equal(masquer('a'.repeat(40)), 'aaaa…aaaa (40 caractères)');
  assert.equal(masquer('abcdefghijklmnopqrst'), 'abcd…qrst (20 caractères)');
  assert.equal(masquer('abcdefghijklmnopqrs'), 'ab…rs (19 caractères)');
  assert.equal(masquer('abcdefghijklm'), 'ab…lm (13 caractères)');
  assert.equal(masquer('abcdefghijkl'), '*** (12 caractères)');
  assert.equal(masquer('abc'), '*** (3 caractères)');
  assert.equal(masquer(''), '*** (0 caractères)');
});

test('classesDe et entropieDe', () => {
  assert.equal(classesDe('abc'), 1);
  assert.equal(classesDe('abcDEF'), 2);
  assert.equal(classesDe('abcDEF123'), 3);
  assert.equal(classesDe('abcDEF123-_'), 4);
  assert.equal(classesDe('123'), 1);
  assert.equal(classesDe('-_.'), 1);
  assert.equal(entropieDe('aaaa'), 0);
  assert.equal(entropieDe('abab'), 1);
  assert.equal(entropieDe('abcd'), 2);
  assert.equal(entropieDe('abcdefgh'), 3);
  assert.equal(entropieDe('éé'), 0);
  assert.equal(entropieDe('aab').toFixed(4), '0.9183', 'des comptes inégaux : chaque caractère compte pour le nombre de ses occurrences');
  assert.equal(entropieDe('hunter2hunter2').toFixed(2), '2.81');
  assert.equal(entropieDe(''), 0);
});

test('motsDeLaValeur : des mots joints, non des lettres tirées au hasard', () => {
  assert.deepEqual(motsDeLaValeur('my-access-token'), ['my', 'access', 'token']);
  assert.deepEqual(motsDeLaValeur('SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED'), ['SECRET', 'DO', 'NOT', 'PASS', 'THIS', 'OR', 'YOU', 'WILL', 'BE', 'FIRED']);
  assert.deepEqual(motsDeLaValeur('ma-cle-secrete-2024'), ['ma', 'cle', 'secrete']);
  assert.equal(motsDeLaValeur('ma-cle-2024'), null, 'deux mots de deux ou trois lettres : trop courts pour des mots');
  assert.deepEqual(motsDeLaValeur('maCleSecrete'), ['ma', 'Cle', 'Secrete']);
  assert.deepEqual(motsDeLaValeur('Mot de passe'), ['Mot', 'de', 'passe']);
  assert.equal(motsDeLaValeur('secret'), null, 'un seul morceau');
  assert.equal(motsDeLaValeur('ma-cle-2024-2025'), null, 'deux nombres');
  assert.equal(motsDeLaValeur('ma-cle-12345'), null, 'un nombre de cinq chiffres');
  assert.equal(motsDeLaValeur('xKjQpLmNoPqRsTuVwXyZ'), null, 'des morceaux trop courts');
  assert.equal(motsDeLaValeur('KJQPL-XWZRT-BNMCD-FGHJK'), null, 'des groupes sans voyelle');
  assert.equal(motsDeLaValeur('abc-d3f-ghi'), null, 'un morceau mêlé de chiffres');
  assert.equal(motsDeLaValeur('ab-cd-ef'), null, 'des mots de deux lettres : trop courts');
  assert.deepEqual(motsDeLaValeur('mon-secret'), ['mon', 'secret'], 'deux morceaux suffisent');
  assert.equal(motsDeLaValeur('mon-nth-secret'), null, 'un mot de trois lettres sans voyelle n\'est pas un mot');
  assert.deepEqual(motsDeLaValeur('my-gym-secret'), ['my', 'gym', 'secret'], 'y est une voyelle');
  assert.deepEqual(motsDeLaValeur('ab-xz-secret'), ['ab', 'xz', 'secret'], 'un mot de deux lettres n\'a pas besoin d\'une voyelle');
  assert.equal(motsDeLaValeur('mon-secret-12345'), null, 'un nombre de cinq chiffres n\'est pas un nombre de fin de phrase');
  assert.deepEqual(motsDeLaValeur('mon-secret-2024'), ['mon', 'secret'], 'quatre chiffres : une année');
  assert.equal(motsDeLaValeur('mon-secret-2024-2025'), null, 'deux nombres');
  assert.equal(motsDeLaValeur('secret-key2'), null, 'un chiffre collé à des lettres fait un morceau qui n\'est pas un mot');
});

test('estGeneree : vingt caractères, trois classes ou quatre bits, hexadécimal de trente-deux, UUID ; ni mots, ni adresse, ni suite', () => {
  const vrai = (v, pourquoi) => assert.ok(estGeneree(v), `${pourquoi} : ${v}`);
  const faux = (v, pourquoi) => assert.ok(!estGeneree(v), `${pourquoi} : ${v}`);
  vrai(generee(20), 'vingt caractères tirés au hasard');
  faux(generee(19), 'dix-neuf caractères');
  vrai('aB3dE5gH7jK9mN1pQ3rS', 'vingt caractères, quatre classes (majuscules, minuscules, chiffres : trois)');
  faux('ab12ab12ab12ab12ab12', 'vingt caractères, deux classes, peu d\'entropie');
  vrai('abqnzxkwpdlmeyvtrcsohgfj', 'une classe, 4,58 bits : l\'entropie suffit');
  faux('abababababababababab', 'une classe, un bit');
  vrai('ab3de5gh7jk9mn1pq3r-s', 'trois classes avec un signe, vingt et un caractères');
  vrai(tirer(32, HEX), 'hexadécimal de trente-deux');
  vrai(tirer(32, HEX).toUpperCase(), 'hexadécimal majuscule de trente-deux');
  vrai(tirer(64, HEX), 'hexadécimal de soixante-quatre');
  faux(tirer(31, HEX), 'hexadécimal de trente et un : moins de vingt caractères d\'entropie, non généré');
  vrai('3f2b8a1c-9d4e-4f6a-b2c3-1a2b3c4d5e6f', 'UUID');
  vrai('3F2B8A1C-9D4E-4F6A-B2C3-1A2B3C4D5E6F', 'UUID majuscule');
  vrai('faceface-face-face-face-facefaceface', 'UUID sans chiffre fait de mots : la règle de l\'UUID passe avant celle des mots joints');
  vrai('bcdfbcdf-bcdf-bcdf-bcdf-bcdfbcdfbcdf', 'UUID sans chiffre ni voyelle : deux classes et deux bits, seule la règle de l\'UUID le dit généré');
  vrai('BCDFBCDF-BCDF-BCDF-BCDF-BCDFBCDFBCDF', 'UUID majuscule sans chiffre ni voyelle');
  faux('bcdfbcdf-bcdf-bcdf-bcdf-bcdfbcdfbcdfb', 'un caractère de trop : ce n\'est pas un UUID');
  faux('bcdfbcdf-bcdf-bcdf-bcdfbcdf-bcdf', 'quatre et huit au lieu de quatre, quatre : ce n\'est pas un UUID');
  faux('gcdfbcdf-bcdf-bcdf-bcdf-bcdfbcdfbcdf', 'un g n\'est pas hexadécimal : ce n\'est pas un UUID');
  faux(`${generee(12)} ${generee(12)}`, 'un blanc');
  faux('Une phrase sans fin mais avec des espaces', 'des blancs');
  faux('https://exemple.test/chemin?x=1&y=2', 'une adresse');
  faux('/opt/application/configuration/secrets.json', 'un chemin');
  faux('./dossier/sous-dossier/fichier.json', 'un chemin relatif');
  faux('SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED', 'des mots joints');
  faux('my-super-secret-token-value-123', 'des mots joints et un nombre');
  faux('abcdefghijklmnopqrstuvwxyz0123456789', 'une suite');
  faux('aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'un seul caractère');
  vrai('KJQPL-XWZRT-BNMCD-FGHJK-LQWRT', 'des groupes de lettres sans voyelle');
  vrai('xKjQpLmNoPqRsTuVwXyZ', 'des lettres mêlées, morceaux trop courts pour des mots');
  vrai('aB1'.repeat(7), 'trois classes exactement, même avec une entropie de moins de deux bits');
  vrai('kxqzjvwhbmfytdpn'.repeat(2), 'une classe et quatre bits exactement : seize lettres, chacune deux fois');
  faux('aqzwsxed'.repeat(3), 'une classe et trois bits');
  vrai('abqnzxkwpdlmeyvtrcsohgfj2', 'un chiffre collé aux lettres ne coupe pas le morceau : une seule suite, non des mots');
  faux('0a'.repeat(16) + 'zz', 'de l\'hexadécimal suivi d\'autre chose');
  faux('zz' + '0a'.repeat(16), 'de l\'hexadécimal précédé d\'autre chose');
  faux('zzbcdfbcdf-bcdf-bcdf-bcdf-bcdfbcdfbcdf', 'un UUID précédé d\'autre chose');
  faux('HTTPS://exemple.test/jeton', 'le schéma d\'une adresse peut être en majuscules');
  vrai('aB3dE5gH!https://exemple.test/x', 'une adresse qui ne commence pas la valeur n\'en est pas une');
  vrai('aB3dE5gH7jK9mN1pQ3rS:tU4', 'un mot suivi de deux-points n\'est pas une adresse : il faut les deux barres');
  faux('../Dossier2/Sous-Dossier3/Fichier4.json', 'un chemin qui remonte d\'un dossier');
  faux('/Dossier2/Sous-Dossier3/Fichier4.json', 'un chemin de quatre classes de caractères');
  faux('/Sous-Dossier3/Dossier2/Fichier4.json', 'un tiret dans le premier élément d\'un chemin');
  faux('/Dossier2/Sous-Dossier3/Fichier4/', 'un chemin qui finit par une barre oblique');
  vrai('Ab3/Dossier2/Sous-Dossier3/Fichier4.json', 'un chemin commence par une barre oblique : ceci n\'en est pas un');
});

test('jugerValeur : une valeur qui reprend son nom ne dit rien, sauf sous un nom de plus de 4 096 caractères, que la valeur ne peut pas reprendre et qu\'on ne normalise pas', () => {
  const valeur = 'qzxwvjkpmnb';
  const nom = (n) => `${'_'.repeat(n - valeur.length)}${valeur}`;
  assert.equal(jugerValeur(nom(valeur.length), valeur).pourquoi, 'nom', 'le nom même');
  assert.equal(jugerValeur(nom(4096), valeur).pourquoi, 'nom', 'un nom de 4 096 caractères');
  assert.equal(jugerValeur(nom(4097), valeur).pourquoi, 'a_verifier', 'un nom de 4 097 caractères n\'est pas comparé');
  assert.equal(jugerValeur(nom(5_000_000), valeur).pourquoi, 'a_verifier', 'ni celui de plusieurs Mio');
  assert.equal(jugerValeur('autreNom', valeur).pourquoi, 'a_verifier', 'une valeur qui n\'est pas le nom');
});

test('jugerValeur : l\'allure générée avant le remplacement, puis chaque raison de ne rien dire, puis « à vérifier »', () => {
  const v = (nom, valeur) => jugerValeur(nom, valeur);
  assert.equal(v('apiKey', generee()).verdict, 'generee');
  assert.equal(v('apiKey', `test_${generee(30)}`).verdict, 'generee', 'un préfixe de remplacement n\'absout pas une valeur tirée au hasard');
  assert.equal(v('apiKey', `your_${generee(30)}`).verdict, 'generee');
  assert.deepEqual(v('apiKey', ''), { verdict: 'aucun', pourquoi: 'vide' });
  assert.deepEqual(v('secretAccessKey', EXEMPLE_SECRET), { verdict: 'aucun', pourquoi: 'exemple' });
  assert.deepEqual(v('secretAccessKey', `${generee(30)}EXAMPLEKEY`), { verdict: 'aucun', pourquoi: 'exemple' });
  assert.deepEqual(v('apiKey', `${generee(20)}EXAMPLE`), { verdict: 'aucun', pourquoi: 'exemple' });
  assert.equal(v('apiKey', `EXAMPLE${generee(30)}`).verdict, 'generee', 'EXAMPLE n\'excuse que la fin d\'une valeur');
  for (const valeur of ['xxxx', 'XXXXXXXXXXXX', '***', '*****', '...', '.....', '<secret>', '<votre clé>', '${TOKEN}', '$TOKEN', '$ma_cle', '{{ secret }}', 'process.env.TOKEN',
    'votre clé', 'Votre_cle', 'your_key_here', 'YOUR_API_KEY', 'example', 'Example-Key', 'placeholder', 'PLACEHOLDER_VALUE', 'changeme', 'change_me', 'change-me', 'replace_me', 'replace-me',
    'todo', 'TODO', 'tbd', 'none', 'None', 'null', 'NULL', 'undefined', 'empty', 'test', 'test-token', 'demo', 'demo_value', 'lorem ipsum',
    'stub-token', 'fake_key', 'dummyPassword', 'DummyPassword', 'mock123', 'Sample', 'fixture_value', 'FAKE_TOKEN', 'foobar123', 'foo123', 'bar-baz', 'baz_key', 'stub']) {
    const j = v('apiKey', valeur);
    assert.deepEqual([valeur, j.verdict, j.pourquoi], [valeur, 'aucun', 'remplacement']);
  }
  assert.deepEqual(v('password', 'password'), { verdict: 'aucun', pourquoi: 'nom' });
  assert.deepEqual(v('apiKey', 'API_KEY'), { verdict: 'aucun', pourquoi: 'nom' });
  assert.deepEqual(v('api-key', 'apikey'), { verdict: 'aucun', pourquoi: 'nom' });
  assert.deepEqual(v('motDePasse', 'mot de passe'), { verdict: 'aucun', pourquoi: 'nom' });
  assert.deepEqual(v('token', 'abcdefgh'), { verdict: 'aucun', pourquoi: 'suite' });
  assert.deepEqual(v('token', '12345678'), { verdict: 'aucun', pourquoi: 'suite' });
  assert.deepEqual(v('token', 'aaaaaaaa'), { verdict: 'aucun', pourquoi: 'suite' });
  assert.deepEqual(v('token', 'https://exemple.test/jeton'), { verdict: 'aucun', pourquoi: 'adresse' });
  assert.deepEqual(v('token', '/api/jeton'), { verdict: 'aucun', pourquoi: 'adresse' });
  assert.deepEqual(v('token', './secrets/jeton.json'), { verdict: 'aucun', pourquoi: 'adresse' });
  assert.deepEqual(v('token', '~/secrets/jeton'), { verdict: 'aucun', pourquoi: 'adresse' });
  assert.deepEqual(v('token', 'config.secrets.jeton'), { verdict: 'aucun', pourquoi: 'adresse' });
  assert.deepEqual(v('token', 'my-access-token'), { verdict: 'aucun', pourquoi: 'phrase' });
  assert.deepEqual(v('secret', 'SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED'), { verdict: 'aucun', pourquoi: 'phrase' });
  assert.deepEqual(v('token', 'Mot de passe oublié'), { verdict: 'aucun', pourquoi: 'phrase' });
  assert.deepEqual(v('token', 'deux mots'), { verdict: 'aucun', pourquoi: 'blancs' });
  assert.deepEqual(v('token', 'a b'), { verdict: 'aucun', pourquoi: 'blancs' });
  assert.deepEqual(v('token', 'abc'), { verdict: 'aucun', pourquoi: 'court' });
  assert.deepEqual(v('token', 'abcd12X'), { verdict: 'aucun', pourquoi: 'court' });
  const a = v('password', 'hunter2hunter2');
  assert.deepEqual([a.verdict, a.pourquoi, a.classes], ['a_verifier', 'a_verifier', 2]);
  assert.equal(typeof a.entropie, 'number');
  assert.equal(v('password', 'admin123').verdict, 'a_verifier', 'huit caractères : assez pour un mot de passe');
  assert.equal(v('password', 'super_secret').verdict, 'a_verifier', 'deux mots joints ne font pas une phrase');
  assert.equal(v('password', 'Passwort').verdict, 'a_verifier');
  for (const valeur of ['mockingbird', 'stubborn99', 'barcelona1985', 'football2024', 'fakery123', 'samples-2024', 'fooling99', 'bazaar2024', 'mockup-2024']) {
    assert.equal(v('password', valeur).verdict, 'a_verifier', `${valeur} : un mot qui commence comme un mot de remplacement n'en est pas un`);
  }
  assert.equal(v('password', `fake_${generee(30)}`).verdict, 'generee', 'un mot de remplacement n\'absout pas une valeur tirée au hasard');
  assert.equal(v('password', `stubToken${generee(30)}`).verdict, 'generee');
  assert.equal(v('password', `${'a'.repeat(3000)}${'B3'.repeat(2000)}`).verdict, 'generee', 'une valeur très longue est jugée sur son début');
  assert.ok(v('password', `${'x'.repeat(5000)}`).verdict === 'aucun');
  // Une valeur est jugée sur ses 4 096 premiers caractères, ni un de moins ni un de plus, et non en entier.
  assert.deepEqual(v('password', `${'z'.repeat(4095)}Q3`), { verdict: 'a_verifier', pourquoi: 'a_verifier', classes: 2, entropie: 0 }, 'le dernier caractère jugé est le 4 096e');
  assert.deepEqual(v('password', `${'z'.repeat(4096)}Q`), { verdict: 'aucun', pourquoi: 'suite' }, 'le 4 097e n\'est pas lu');
  assert.deepEqual(v('password', `${'z'.repeat(4096)} q`), { verdict: 'aucun', pourquoi: 'suite' }, 'ni ce qui le suit');
  // Les mesures dites sont à deux décimales.
  assert.deepEqual(v('apiKey', 'aB1'.repeat(7)), { verdict: 'generee', pourquoi: 'generee', classes: 3, entropie: 1.58 });
  assert.deepEqual(v('password', 'hunter2hunter2'), { verdict: 'a_verifier', pourquoi: 'a_verifier', classes: 2, entropie: 2.81 });
  // Les raisons de ne rien dire, aux bornes.
  assert.deepEqual(v('token', 'HTTPS://exemple.test/jeton'), { verdict: 'aucun', pourquoi: 'adresse' }, 'le schéma d\'une adresse peut être en majuscules');
  assert.deepEqual(v('token', 'Config.Secrets.Jeton'), { verdict: 'aucun', pourquoi: 'adresse' }, 'un identifiant pointé peut avoir des majuscules');
  assert.deepEqual(v('token', '../secrets/jeton'), { verdict: 'aucun', pourquoi: 'adresse' }, 'un chemin remonte d\'un dossier');
  assert.deepEqual(v('token', 'abcdefghizz'), { verdict: 'aucun', pourquoi: 'suite' }, 'huit pas sur dix : une suite');
  assert.equal(v('token', 'abcdefghzzz').verdict, 'a_verifier', 'sept pas sur dix : pas une suite');
  assert.equal(v('token', 'aabbccddeeffgghh1').verdict, 'a_verifier', 'un caractère répété n\'est pas un pas de la suite');
  assert.equal(v('secret', 'supertestvalue9').verdict, 'a_verifier', 'test au milieu d\'une valeur n\'est pas un mot de remplacement');
  assert.equal(v('secret', 'hunter2-dummy-x9').verdict, 'a_verifier', 'dummy au milieu d\'une valeur n\'est pas un mot de remplacement');
});

test('estFichierDeConfiguration : les noms et extensions que la règle lit ligne à ligne, jamais une carte de sources ni un README', () => {
  const oui = ['.env', '.env.local', '.env.production', '.ENV', 'sous/.env', 'prod.env', 'a.json', 'a.yml', 'a.yaml', 'a.ini', 'a.properties', 'a.toml', '.npmrc', 'sous/.npmrc', 'A.JSON'];
  const non = ['a.js', 'a.js.map', 'a.map', 'README.md', 'notes.txt', 'a.csv', 'a.html', 'env', 'a.env.js', 'npmrc', 'a.jsonl', 'environment.md', '.envrc'];
  const fiche = (chemin) => ({ chemin, ext: extname(chemin).toLowerCase() }); // l'extension que l'inventaire donne : un fichier dont le nom commence par un point n'en a pas
  for (const chemin of oui) assert.ok(estFichierDeConfiguration(fiche(chemin)), `${chemin} est de la configuration`);
  for (const chemin of non) assert.ok(!estFichierDeConfiguration(fiche(chemin)), `${chemin} n'est pas de la configuration`);
});

test('affectationsDeConfiguration : chaque forme d\'affectation, la valeur entre guillemets ou jusqu\'au blanc', () => {
  const lire = (texte) => [...affectationsDeConfiguration(texte)].map((t) => [t.nom, t.valeur]);
  assert.deepEqual(lire('API_KEY=abc123'), [['API_KEY', 'abc123']]);
  assert.deepEqual(lire('export API_KEY="abc 123"'), [['API_KEY', 'abc 123']]);
  assert.deepEqual(lire("password: 'abc'"), [['password', 'abc']]);
  assert.deepEqual(lire('"apiKey": "abc",'), [['apiKey', 'abc']]);
  assert.deepEqual(lire("'apiKey' : 'abc'"), [['apiKey', 'abc']]);
  assert.deepEqual(lire('token = abc'), [['token', 'abc']]);
  assert.deepEqual(lire('token=abc,'), [['token', 'abc']]);
  assert.deepEqual(lire('{"token":"abc"}'), [['token', 'abc']]);
  assert.deepEqual(lire('{"token":123}'), [['token', '123']]);
  assert.deepEqual(lire('token: abc # un commentaire'), [['token', 'abc']]);
  assert.deepEqual(lire('token: abc#def'), [['token', 'abc#def']]);
  assert.deepEqual(lire('a.b.token=abc'), [['a.b.token', 'abc']]);
  assert.deepEqual(lire('//registry.npmjs.org/:_authToken=abc'), [['_authToken', 'abc']]);
  assert.deepEqual(lire('token=\n'), [['token', '']]);
  assert.deepEqual(lire('token="\n"'), []);
  assert.deepEqual(lire('token="abc'), []);
  assert.deepEqual(lire('tokenUrl=abc'), []);
  assert.deepEqual(lire('token abc'), []);
  assert.deepEqual(lire('le token est expiré'), []);
  assert.deepEqual(lire('API_KEY=a\nDB_PASSWORD=b\n'), [['API_KEY', 'a'], ['DB_PASSWORD', 'b']]);
  assert.deepEqual(lire('API_KEY=a DB_PASSWORD=b'), [['API_KEY', 'a'], ['DB_PASSWORD', 'b']]);
  assert.deepEqual(lire(`${'a'.repeat(200)}token=abc`), [], 'un nom de plus de quatre-vingts caractères est coupé : son dernier mot n\'est plus celui du nom');
  assert.deepEqual(lire('token="' + 'a'.repeat(5000) + '"'), [], 'une valeur entre guillemets de plus de 4 096 caractères n\'est pas lue');
  assert.equal(lire(`token=${'a'.repeat(4096)}`)[0][1].length, 4096, 'jusqu\'à 4 096 caractères');
  assert.equal(lire(`token=${'a'.repeat(5000)}`)[0][1].length, 4096, 'au-delà, la valeur est coupée');
  assert.equal(lire(`token="${'a'.repeat(4096)}"`)[0][1].length, 4096);
  assert.deepEqual(lire(`token="${'a'.repeat(4097)}"`), []);
  assert.deepEqual(lire('secret=a\nsecret=b\nsecret=c').map((t) => t[1]), ['a', 'b', 'c']);
  assert.deepEqual([...affectationsDeConfiguration('x\nx\nAPI_KEY=abc')].map((t) => t.index), [4]);
  // Les blancs, les guillemets et la ponctuation qui ferme.
  assert.deepEqual(lire('token\t= abc'), [['token', 'abc']], 'une tabulation avant le séparateur');
  assert.deepEqual(lire('token=\tabc'), [['token', 'abc']], 'une tabulation après le séparateur');
  assert.deepEqual(lire('token=`abc def`'), [['token', 'abc def']], 'l\'apostrophe inversée ouvre une valeur');
  assert.deepEqual(lire('token=ab!cd'), [['token', 'ab!cd']], 'un point d\'exclamation n\'est pas un blanc');
  assert.deepEqual(lire('token=abc;'), [['token', 'abc']]);
  assert.deepEqual(lire('token=abc]'), [['token', 'abc']]);
  assert.deepEqual(lire('token=abc}}'), [['token', 'abc']]);
  assert.deepEqual(lire('token=,;]}'), [['token', '']], 'une valeur qui n\'est que ponctuation est vide');
  // Ce qui est dans une valeur déjà lue n'est pas relu ; un nom qui en contient un autre n'est lu qu'une fois.
  assert.deepEqual(lire('{"token":"token=abc"}'), [['token', 'token=abc']]);
  assert.deepEqual(lire('token=token=abc'), [['token', 'token=abc']]);
  assert.deepEqual(lire('client_secret_token=abc'), [['client_secret_token', 'abc']]);
  // Un nom est lu en entier : `token-url` et `token1_url` disent ce que la valeur décrit.
  assert.deepEqual(lire('token-url: abc'), []);
  assert.deepEqual(lire('token1_url=abc'), []);
  assert.deepEqual(lire('x-auth-token=abc'), [['x-auth-token', 'abc']]);
  assert.deepEqual(lire('token2=abc'), [['token2', 'abc']], 'un chiffre à la fin fait partie du nom');
  assert.deepEqual(lire('2token=abc'), [], 'un chiffre au début aussi : « 2token » n\'est pas « token »');
  // Les bornes du nom : quatre-vingts caractères de chaque côté du mot de secret.
  assert.deepEqual(lire(`token${'_'.repeat(75)}=abc`), [[`token${'_'.repeat(75)}`, 'abc']], 'un nom de quatre-vingts caractères est lu');
  assert.deepEqual(lire(`token${'_'.repeat(76)}=abc`), [], 'un de plus : le séparateur n\'est plus celui du nom');
  assert.equal(lire(`${'a'.repeat(200)}_token=abc`)[0][0].length, 85, 'quatre-vingts caractères à gauche du mot de secret');
  assert.deepEqual(lire(`token${'_'.repeat(80)}secret=abc`), [[`${'_'.repeat(80)}secret`, 'abc']], 'un nom trop long n\'avale pas le mot de secret qui le suit : celui-ci est lu à part');
  // Une valeur que la borne coupe n'empêche pas de lire le nom qui la suit.
  assert.deepEqual(lire(`token=${'a'.repeat(4095)},secret=zzzzzzzz`), [['token', 'a'.repeat(4095)], ['secret', 'zzzzzzzz']]);
});

// --- Les bornes des formats, à l'unité près ----------------------------------------------------------------------------------

test('chaque format a ses bornes : la longueur minimale à l\'unité près, la frontière avant, et après quand la longueur est fixe', () => {
  const vus = (texte) => formatsDans(texte).map((t) => `${t.format.id} ${t.valeur}`);
  /** Reconnue seule ou après une espace, jamais collée à une lettre qui précède. */
  const reconnu = (id, valeur, pourquoi) => {
    assert.deepEqual(vus(valeur), [`${id} ${valeur}`], `${pourquoi}`);
    assert.deepEqual(vus(` ${valeur}`), [`${id} ${valeur}`], `${pourquoi}, après une espace`);
    assert.deepEqual(vus(`x${valeur}`), [], `${pourquoi}, collée à une lettre qui précède : ce n'est pas le début d'un jeton`);
  };
  const ignore = (valeur, pourquoi) => assert.deepEqual(vus(valeur), [], pourquoi);
  const a = (n) => tirer(n, ALNUM);
  /** n caractères de trois classes (minuscules, majuscules, chiffres) : une clé tirée au hasard, non un mot. */
  const trois = (n) => `aB3${tirer(n - 3, ALNUM)}`;

  const aws = (n) => `AKIA${tirer(n, BASE32)}`;
  reconnu('aws', aws(16), 'AKIA et seize caractères');
  ignore(aws(15), 'AKIA et quinze caractères');
  ignore(aws(17), 'AKIA et dix-sept caractères : la clé ne finit pas où le jeton finit');

  reconnu('github', `ghp_${a(36)}`, 'ghp_ et trente-six caractères');
  ignore(`ghp_${a(35)}`, 'ghp_ et trente-cinq caractères');
  ignore(`ghp_${a(37)}`, 'ghp_ et trente-sept caractères');

  reconnu('github-pat', `github_pat_${a(50)}`, 'github_pat_ et cinquante caractères');
  reconnu('github-pat', `github_pat_${a(51)}`, 'github_pat_ et cinquante et un caractères');
  ignore(`github_pat_${a(49)}`, 'github_pat_ et quarante-neuf caractères');

  reconnu('openai', `sk-${trois(32)}`, 'sk- et trente-deux caractères');
  ignore(`sk-${trois(31)}`, 'sk- et trente et un caractères');
  reconnu('openai', `sk-proj-${trois(40)}`, 'sk-proj- et quarante caractères');
  ignore(`sk-proj-${trois(39)}`, 'sk-proj- et trente-neuf caractères');
  ignore(`sk-proj-${tirer(40, 'abcdefghijklmnopqrstuvwxyz0123456789')}`, 'sk-proj- et deux classes de caractères : le type ne compte pas dans les classes de la clé');
  ignore(`sk-proj-circleRotatingSpinnerWithAVeryLongDescriptiveClassName`, 'sk-proj- et un mot en casse mixte');
  ignore(`sk-${tirer(40, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')}`, 'sk- et deux classes de caractères');
  ignore(`task-${trois(40)}`, 'un mot qui finit par sk');

  for (const c of 'baprs') reconnu('slack', `xox${c}-${tirer(10, '0123456789')}`, `xox${c}- et dix caractères`);
  ignore(`xoxb-${tirer(9, '0123456789')}`, 'xoxb- et neuf caractères');
  ignore(`xoxc-${tirer(20, '0123456789')}`, 'xoxc- n\'est pas un format de jeton Slack');

  reconnu('stripe', `pk_live_${a(16)}`, 'pk_live_ et seize caractères');
  reconnu('stripe', `pk_test_${a(16)}`, 'pk_test_ et seize caractères');
  ignore(`pk_live_${a(15)}`, 'pk_live_ et quinze caractères');
  ignore(`pk_test_${a(15)}`, 'pk_test_ et quinze caractères');

  reconnu('google', `AIza${a(35)}`, 'AIza et trente-cinq caractères');
  ignore(`AIza${a(34)}`, 'AIza et trente-quatre caractères');
  ignore(`AIza${a(36)}`, 'AIza et trente-six caractères');

  const jwt = (en, charge, signature) => `eyJ${a(en)}.${a(charge)}.${a(signature)}`;
  reconnu('jwt', jwt(10, 10, 10), 'un en-tête, une charge utile et une signature de dix caractères');
  ignore(jwt(9, 10, 10), 'un en-tête de neuf caractères');
  ignore(jwt(10, 9, 10), 'une charge utile de neuf caractères');
  ignore(jwt(10, 10, 9), 'une signature de neuf caractères');

  const mapbox = (en, signature) => `pk.eyJ${a(en)}.${a(signature)}`;
  reconnu('mapbox', mapbox(10, 10), 'un en-tête et une signature de dix caractères');
  ignore(mapbox(9, 10), 'un en-tête de neuf caractères');
  ignore(mapbox(10, 9), 'une signature de neuf caractères');
});

test('chaque suite d\'un format a une borne haute : à la borne le jeton est lu, au-delà c\'est une donnée', () => {
  const dit = (texte) => formatsDans(texte).map((t) => `${t.format.id} ${t.valeur.length}`);
  const a = (n) => tirer(n, ALNUM);
  const trois = (n) => `aB3${tirer(n - 3, ALNUM)}`;
  /** Un jeton dont la suite variable a exactement `max` caractères est reconnu ; avec un de plus, ce n'est plus un jeton. */
  const borne = (id, max, fabrique, pourquoi) => {
    const jeton = fabrique(max);
    assert.deepEqual(dit(jeton), [`${id} ${jeton.length}`], `${pourquoi} : ${max} caractères`);
    assert.deepEqual(dit(fabrique(max + 1)), [], `${pourquoi} : ${max + 1} caractères`);
  };
  borne('github-pat', 512, (n) => `github_pat_${a(n)}`, 'github_pat_');
  borne('openai', 512, (n) => `sk-proj-${trois(n)}`, 'sk-proj-');
  borne('openai', 512, (n) => `sk-${trois(n)}`, 'sk-');
  borne('slack', 512, (n) => `xoxb-${tirer(n, '0123456789')}`, 'xoxb-');
  borne('stripe', 512, (n) => `pk_live_${a(n)}`, 'pk_live_');
  borne('jwt', 16384, (n) => `eyJ${a(n)}.${a(10)}.${a(10)}`, 'l\'en-tête d\'un JWT');
  borne('jwt', 16384, (n) => `eyJ${a(10)}.${a(n)}.${a(10)}`, 'la charge utile d\'un JWT');
  borne('jwt', 16384, (n) => `eyJ${a(10)}.${a(10)}.${a(n)}`, 'la signature d\'un JWT');
  borne('mapbox', 16384, (n) => `pk.eyJ${a(n)}.${a(10)}`, 'l\'en-tête d\'un jeton Mapbox');
  borne('mapbox', 16384, (n) => `pk.eyJ${a(10)}.${a(n)}`, 'la signature d\'un jeton Mapbox');
});

test('une suite de plusieurs millions de caractères d\'un format ne fait échouer ni la lecture du texte ni la règle', () => {
  // Une suite gloutonne sans borne haute fait déborder la pile de retour arrière de l'analyseur d'expressions régulières de V8
  // (`RangeError: Maximum call stack size exceeded`, à quelques millions de caractères) : la règle échouait, et avec elle les secrets
  // de tous les autres fichiers. Une donnée de 16 Mio (une image en base64, une carte de sources) suffit à la provoquer.
  const N = 8 * 1048576;
  // Chaque quantificateur a sa suite : les trois segments d'un JWT, les deux d'un jeton Mapbox.
  const suites = [
    ['github_pat_', 'a'], ['sk-proj-', 'a'], ['sk-', 'a'], ['xoxb-', '-'], ['pk_live_', 'a'],
    ['eyJ', '-'], ['eyJaaaaaaaaaa.', 'a'], ['eyJaaaaaaaaaa.aaaaaaaaaa.', 'a'],
    ['pk.eyJ', '-'], ['pk.eyJaaaaaaaaaa.', 'a'],
  ];
  for (const [debut, c] of suites) {
    const texte = `${debut}${c.repeat(N)}`;
    assert.deepEqual(formatsDans(texte), [], `${debut} puis ${N} caractères`);
    assert.deepEqual(analyser(fichier('donnee.txt', texte)).constats, [], `${debut} puis ${N} caractères, dans la règle`);
  }
});

test('un jeton JWT commence une suite de base64 URL : jamais collé à un de ses caractères, sans quoi un motif répété relirait la suite à chaque départ', () => {
  const j = `eyJ${tirer(17, ALNUM)}.eyJ${tirer(40, ALNUM)}.${tirer(43, ALNUM)}`;
  const vus = (texte) => formatsDans(texte).map((t) => t.valeur);
  for (const avant of ['=', ' ', '.', '"', ':', '(', '\n']) assert.deepEqual(vus(`${avant}${j}`), [j], `après « ${JSON.stringify(avant)} »`);
  for (const avant of ['A', 'z', '9', '_', '-']) assert.deepEqual(vus(`${avant}${j}`), [], `collé à « ${avant} » : une suite de base64 URL qui ne commence pas par eyJ`);
  assert.deepEqual(vus(`${j}- x`), [j], 'un tiret qui suit la signature n\'en fait pas partie quand rien ne le prolonge');
  assert.deepEqual(vus(`${j}\n`), [j]);
  assert.deepEqual(vus(`${j}.`), [j]);
});

test('un en-tête de clé privée est une clé quand son corps le suit à au plus 120 caractères, et que ce corps est d\'au moins 40 caractères de base64', () => {
  const entete = '-----BEGIN RSA PRIVATE KEY-----';
  const vus = (texte) => formatsDans(texte).map((t) => t.valeur);
  assert.deepEqual(vus(`${entete}${'\n'.repeat(120)}${tirer(40, ALNUM)}`), [entete], 'à cent vingt caractères du corps');
  assert.deepEqual(vus(`${entete}${'\n'.repeat(121)}${tirer(40, ALNUM)}`), [], 'à cent vingt et un');
  assert.deepEqual(vus(`${entete}\n${tirer(40, ALNUM)}`), [entete], 'un corps de quarante caractères');
  assert.deepEqual(vus(`${entete}\n${tirer(39, ALNUM)}`), [], 'un corps de trente-neuf');
  assert.deepEqual(vus(`${entete}\n${'+'.repeat(40)}`), [entete], 'le plus fait partie du base64');
  assert.deepEqual(vus(`${entete}\n${'/'.repeat(40)}`), [entete], 'la barre oblique aussi');
  assert.deepEqual(vus(`${entete}\n${'+/'.repeat(20)}`), [entete]);
  assert.deepEqual(vus(`${entete}\n${'A'.repeat(40)}`), [entete], 'les majuscules aussi');
  assert.deepEqual(vus(`${entete}\n${'-'.repeat(40)}`), [], 'un tiret n\'en fait pas partie');
  assert.deepEqual(vus(`${entete}\n${'é'.repeat(40)}`), []);
  for (const debut of ['-----BEGIN PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----', '-----BEGIN PGP PRIVATE KEY BLOCK-----']) {
    assert.deepEqual(vus(`${debut}\n${tirer(40, ALNUM)}`), [debut], debut);
  }
  assert.deepEqual(vus(`----BEGIN RSA PRIVATE KEY-----\n${tirer(40, ALNUM)}`), [], 'quatre tirets au début');
  assert.deepEqual(vus(`-----BEGIN RSA PRIVATE KEY----\n${tirer(40, ALNUM)}`), [], 'quatre tirets à la fin');
  assert.deepEqual(vus(`-----BEGIN RSA PRIVATE KEZ-----\n${tirer(40, ALNUM)}`), []);
  assert.deepEqual(vus(`-----BEGINRSA PRIVATE KEY-----\n${tirer(40, ALNUM)}`), []);
});

// --- La règle sur un contexte à la main : ce que l'inventaire ne produit pas toujours ---------------------------------------

/** Un fichier tel que l'inventaire le décrit, au strict nécessaire. */
const fichier = (chemin, contenu, plus = {}) => ({ chemin, ext: extname(chemin).toLowerCase(), contenu, binaire: false, executee: true, ...plus });
const analyser = (...fichiers) => { const ctx = { fichiers }; return { ctx, constats: analyserSecrets(ctx) }; };
const cle = () => `AK${'IA'}${tirer(16, BASE32)}`;
/** Ce que dit un constat de sa forme : « fournisseur aws », « code apiKey », « configuration token ». */
const forme = (c) => `${c.preuve.forme} ${c.preuve.nom ?? c.preuve.fournisseur}`;

test('un fichier binaire, ou qui n\'a pas de texte, n\'est pas lu, même quand il en porte un', () => {
  const pat = SECRETS[1].valeur;
  assert.deepEqual(analyser(fichier('image.dat', `x ${pat}`, { binaire: true })).constats, []);
  assert.deepEqual(analyser(fichier('image.dat', undefined)).constats, []);
  assert.deepEqual(analyser(fichier('vide.js', '')).constats, []);
  assert.equal(analyser(fichier('texte.dat', `x ${pat}`)).constats.length, 1, 'le même texte, non binaire, est lu');
});

test('un littéral imbriqué qui reproduit le secret de son fichier d\'origine ne le double pas ; dans tout autre cas le secret est dit', () => {
  const pat = SECRETS[1].valeur;
  const nomImbrique = 'app.js (code littéral, ligne 1, colonne 1)';
  const imbrique = (plus = {}) => fichier(nomImbrique, `var x = "${pat}";\n`, { litteralImbrique: true, origineReelle: { chemin: 'app.js' }, ...plus });
  const fichiers = ({ constats }) => constats.map((c) => c.fichier);
  assert.deepEqual(fichiers(analyser(fichier('app.js', `var cle = '${pat}';\n`), imbrique())), ['app.js'], 'déjà dit à l\'origine');
  assert.deepEqual(fichiers(analyser(fichier('app.js', 'var cle = 1;\n'), imbrique())), [nomImbrique], 'absent de l\'origine : dit ici');
  assert.deepEqual(fichiers(analyser(imbrique())), [nomImbrique], 'origine hors du dépôt : dit ici');
  assert.deepEqual(fichiers(analyser(fichier('app.js', undefined, { binaire: true }), imbrique())), [nomImbrique], 'origine sans texte : dit ici');
  assert.deepEqual(fichiers(analyser(imbrique({ origineReelle: undefined }))), [nomImbrique], 'sans origine : dit ici');
  assert.deepEqual(fichiers(analyser(fichier('app.js', `var cle = '${pat}';\n`), fichier('autre.js', `var x = "${pat}";\n`, { origineReelle: { chemin: 'app.js' } }))), ['app.js', 'autre.js'],
    'un fichier qui n\'est pas un littéral imbriqué est dit même quand il a une origine');
});

test('un fichier que l\'arbre ne lit pas est dit là où les autres règles le disent : dans le contexte', () => {
  const ctx = { fichiers: [fichier('casse.js', 'var token = ;\n')] };
  assert.deepEqual(analyserSecrets(ctx), []);
  assert.equal(ctx.illisibles?.size, 1);
  const [lecture] = [...ctx.illisibles.values()];
  assert.deepEqual([lecture.chemin, lecture.etape, lecture.surface], ['casse.js', 'lecture', true]);
});

test('deux constats d\'une même ligne sortent dans l\'ordre du fichier, ceux du texte, de l\'arbre et de la configuration mêlés', () => {
  const [a1, a2, g1, g2] = [cle(), cle(), generee(), generee()];
  const ordre = (...fichiers) => analyser(...fichiers).constats.map(forme);
  assert.deepEqual(ordre(fichier('une-ligne.js', `var a = '${a1}'; var apiKey = '${g1}'; var b = '${a2}'; var token = '${g2}';\n`)),
    ['fournisseur aws', 'code apiKey', 'fournisseur aws', 'code token'], 'un fichier JavaScript');
  assert.deepEqual(ordre(fichier('une-ligne.json', `{"a":"${a1}","apiKey":"${g1}","b":"${a2}","token":"${g2}"}\n`)),
    ['fournisseur aws', 'configuration apiKey', 'fournisseur aws', 'configuration token'], 'un fichier de configuration');
  // Un script de page : la place d'une trouvaille de l'arbre est approchée (la balise ouvrante près) ; elle range deux trouvailles d'une même ligne.
  const remplissage = '<i>x</i>'.repeat(50);
  assert.deepEqual(ordre(fichier('index.html', `${remplissage}<p>${a1}</p><script>var apiKey = '${g1}'; var k = '${a2}'; var token = '${g2}';</script>\n`)),
    ['fournisseur aws', 'code apiKey', 'fournisseur aws', 'code token'], 'une page qui a un script');
  // Ni l'approximation ni la ligne ne se confondent : un secret d'une ligne ne passe jamais après un autre d'une ligne suivante, même quand la balise est longue.
  const balise = '<script type="text/javascript" nonce="abcdefghijklmnopqrstuvwxyz0123456789">';
  const { constats } = analyser(fichier('index.html', `<!doctype html>\n${balise}\nvar a = '${a1}';\nvar apiKey = '${g1}';\n</script>\n`));
  assert.deepEqual(constats.map((c) => `${c.ligne} ${forme(c)}`), ['3 fournisseur aws', '4 code apiKey']);
});

test('chaque mot qui évoque un secret fait lire le fichier, en JavaScript comme en configuration, avec ou sans séparateur', () => {
  const noms = ['secret', 'token', 'password', 'passwd', 'passphrase', 'mot_de_passe', 'mot-de-passe', 'motdepasse', 'api_key', 'api-key', 'apikey',
    'private_key', 'private-key', 'privatekey', 'access_key', 'access-key', 'accesskey', 'auth_key', 'auth-key', 'authkey',
    'master_key', 'master-key', 'masterkey', 'signing_key', 'signing-key', 'signingkey', 'encryption_key', 'encryption-key', 'encryptionkey'];
  const valeur = generee(36);
  const fichiers = noms.flatMap((nom, i) => [
    fichier(`js-${i}.js`, `var c = { '${nom}': '${valeur}' };\n`),
    fichier(`cfg-${i}.env`, `${nom}=${valeur}\n`),
  ]);
  const dit = new Set(analyser(...fichiers).constats.map((c) => c.fichier));
  const manque = fichiers.map((f) => f.chemin).filter((chemin) => !dit.has(chemin));
  assert.deepEqual(manque, [], `des fichiers dont le nom évoque un secret n'ont pas été lus : ${manque.join(', ')}`);
});

test('ce qui n\'affecte pas un littéral à un nom lisible n\'est pas une affectation : clé ou membre calculé par une variable, champ calculé, opérateur composé', async () => {
  const v = Array.from({ length: 8 }, () => generee());
  const source = [
    `const a = { [apiKey]: '${v[0]}' };`,                 // 1 clé calculée par une variable
    `config[token] = '${v[1]}';`,                          // 2 membre calculé par une variable
    `class K { static [secret] = '${v[2]}'; }`,            // 3 champ calculé
    `token += '${v[3]}';`,                                 // 4 opérateur composé
    `token ||= '${v[4]}';`,                                // 5 opérateur logique
    `const b = { ['x']: '${v[5]}' };`,                     // 6 clé calculée d'un nom qui n'évoque rien
    `config['api-key'] = '${v[6]}';`,                      // 7 membre calculé par une chaîne : son nom
    `const c = { ['client-secret']: '${v[7]}' };`,         // 8 clé calculée par une chaîne : son nom
  ].join('\n');
  const a = await auditer({ 'app.js': `${source}\n` });
  assert.deepEqual(C_SECRET(a).map((c) => `${c.ligne} ${c.preuve.nom}`), ['7 api-key', '8 client-secret']);
});

test('un identifiant de plusieurs centaines de caractères n\'est pas recopié dans le constat : on en garde la fin, où est le mot qui a décidé', async () => {
  const nom = `${'x'.repeat(200)}Token`;
  const fin = `…${nom.slice(-80)}`;
  const valeur = generee();
  const a = await auditer({ 'app.js': `var ${nom} = '${valeur}';\nvar ${'y'.repeat(75)}Token = 'hunter2hunter2';\nvar ${'z'.repeat(76)}Token = 'hunter2hunter2';\n` });
  const [long, quatreVingts, quatreVingtUn] = C_SECRET(a);
  assert.equal(C_SECRET(a).length, 3);
  assert.equal(long.preuve.nom, fin);
  assert.equal(long.extrait, `${fin} = ${masquer(valeur)}`);
  assert.equal(long.titre, `Secret potentiel versionné dans le dépôt (valeur d'allure générée dans « ${fin} »)`);
  assert.ok(long.constat.startsWith(`« ${fin} » reçoit un littéral de 40 caractères`));
  assert.equal(quatreVingts.preuve.nom, `${'y'.repeat(75)}Token`, 'quatre-vingts caractères : le nom est dit en entier');
  assert.equal(quatreVingtUn.preuve.nom, `…${'z'.repeat(75)}Token`, 'quatre-vingt-un : la fin seulement');
  assert.ok(quatreVingtUn.titre.includes(`« …${'z'.repeat(75)}Token »`));
  assert.ok(JSON.stringify(long).length < 3000, 'le constat ne porte pas l\'identifiant entier');
});

test('seul un fichier de verrous de paquets dont le nom est exactement celui d\'un verrou n\'est pas lu', async () => {
  const pat = SECRETS[1].valeur;
  const a = await auditer({ 'package-lock.json.bak': `${pat}\n`, 'yarn.lock.old': `${pat}\n`, 'mon-package-lock.json': `${pat}\n`, 'pnpm-lock.yaml.txt': `${pat}\n` });
  assert.deepEqual(C_SECRET(a).map((c) => c.fichier).sort(), ['mon-package-lock.json', 'package-lock.json.bak', 'pnpm-lock.yaml.txt', 'yarn.lock.old']);
});

test('les référentiels que cite un constat suivent sa nature : un secret en cite trois, une clé publique un seul', async () => {
  const [google] = PUBLIQUES.map((p) => p.valeur);
  const complet = ["ANSSI — Guide d'hygiène informatique", 'CWE-798', 'OWASP Top 10 A07:2021'];
  const a = await auditer({ 'app.js': `var cle = '${google}';\nvar fournisseur = '${SECRETS[1].valeur}';\nvar apiKey = '${generee()}';\nvar password = 'hunter2hunter2';\n` });
  assert.deepEqual(C_SECRET(a).map((c) => c.referentiels), [['CWE-798'], complet, complet, complet]);
});
