/**
 * C-SECRET-01 ne dit jamais « secret » d'une valeur qui se voit fausse, ni d'un exemple, ni d'un libellé (relevé de la coordination,
 * v23 : des leurres qui avaient la forme d'une clé donnaient un critique bloquant).
 *
 *  - Un leurre manifeste : un seul caractère répété, une suite, ou des mots joints dont l'un est un mot de remplacement (`your-bot-token`),
 *    derrière le préfixe d'une clé (`ghp_xxxx…`, `AKIAXXXX…`, `sk_test_xxxx…`) ou seul (trente-deux `0`, l'UUID nul). Il passe avant le
 *    format et avant l'allure générée, et ne blanchit pas une clé pour sa seule forme (`tests/c-secret-hasard.test.mjs` : des mots joints
 *    sans mot de remplacement n'en sont pas ; la limite qui reste est dite par le dernier essai de ce fichier). Un leurre en préfixe, suivi d'une valeur tirée au hasard (`fake_…`, `test_…`), n'absout rien :
 *    c'est `tests/c-secret.test.mjs`.
 *  - Un fichier de configuration d'exemple (`.env.example`, `.sample`, `.template`) : seuls un format à corps aléatoire et l'allure générée
 *    y comptent ; un mot seul y est un exemple, dans un vrai fichier il reste « à vérifier ». Jamais un script : son nom est le choix de son
 *    auteur, et la page qui le charge l'exécute.
 *  - Un libellé de traduction (`Passwort`, `Contraseña`, `API-Schlüssel`) : un mot de langue à capitale initiale, sans chiffre ni
 *    symbole, n'est pas un mot de passe choisi ; `Soleil2024!` reste « à vérifier » dans un vrai `.env` comme dans du JS.
 *
 * Chaque essai a son mutant dans `scripts/mutants-c-secret.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditer } from './aide-surface.mjs';
import { FORMATS, MOTS_DE_LEURRE, formatsDans, jugerValeur, estGeneree, estCorpsDeLeurre, estLibelle, estFichierDExemple } from '../src/regles/c-secrets.js';
import { tirer, generee, ALNUM, BASE32, HEX, PREFIXES_DE_CLE, LEURRES } from './aide-secrets.mjs';

const C_SECRET = (a) => a.de('C-SECRET-01');
const etat = (c) => `${c.severite}${c.bloquant ? ' bloquant' : ''}`;
const dit = (a) => C_SECRET(a).map((c) => `${c.fichier}:${c.ligne} ${etat(c)}`);
const juge = (nom, valeur, options) => { const { verdict, pourquoi } = jugerValeur(nom, valeur, options); return `${verdict} ${pourquoi}`; };

// --- Ce qui se voit faux ----------------------------------------------------------------------------------------------

test('estCorpsDeLeurre : un caractère répété, une suite ou des mots joints, d\'au moins huit caractères', () => {
  const vrai = [
    ['un caractère répété', 'x'.repeat(16)],
    ['huit caractères, la borne', 'x'.repeat(8)],
    ['des zéros', '0'.repeat(20)],
    ['des morceaux répétés que des tirets séparent', 'xxxxxxxx-0000-yyyyyyyy'],
    ['des morceaux répétés que des soulignés séparent', 'xxxxxxxx_0000_yyyyyyyy'],
    ['des morceaux répétés que des points séparent', 'xxxxxxxx.0000.yyyyyyyy'],
    ['des morceaux répétés que des blancs séparent', 'xxxxxxxx 0000 yyyyyyyy'],
    ['deux morceaux répétés', 'xxxxxxxx-0000'],
    ['une suite de lettres', 'abcdefghijkl'],
    ['une suite de chiffres', '123456789012'],
    ['une suite hexadécimale', '0123456789abcdef'],
    ['des mots joints', 'your-bot-token'],
    ['des mots joints en majuscules', 'YOUR_TOKEN_HERE'],
    ['des mots joints par la casse', 'YourTokenHere'],
    ['des mots joints et un nombre', 'your-token-2024'],
    ['des mots joints dont un seul est un mot de remplacement (les autres, non : ce n\'est pas « tous »)', 'my-workspace-token'],
    ['un mot de remplacement en tête, des mots qui n\'en sont pas derrière', 'replace-with-my-workspace-key'],
    ['des morceaux répétés, des séparateurs en tête et en queue', '-xxxxxxxx-0000-'],
    ['un caractère répété, un séparateur en queue', 'xxxxxxxx-'],
    ['huit pas sur dix : le seuil d\'une suite', 'abcdefghi#%'],
  ];
  for (const [nom, corps] of vrai) assert.equal(estCorpsDeLeurre(corps), true, `${nom} : ${corps}`);
  const faux = [
    ['sept caractères répétés : sous la borne', 'x'.repeat(7)],
    ['une valeur tirée au hasard', generee(36)],
    ['une valeur tirée au hasard en base 32', tirer(16, BASE32)],
    ['un mot seul, sans séparation', 'yourtokenhere'],
    ['un caractère répété, puis du hasard', `${'x'.repeat(8)}${generee(8)}`],
    ['du hasard, puis un caractère répété', `${generee(20)}-${'a'.repeat(12)}`],
    ['un morceau d\'un seul caractère dans des morceaux répétés', 'xxxx-yyyy-z-zzzz'],
    ['des mots dont un n\'a pas de voyelle', 'your-xkcd-token'],
    ['des mots joints dont aucun n\'est un mot de remplacement : une phrase de passe n\'est pas un leurre', 'correct-horse-battery-staple'],
    ['des mots qui ne sont que le début ou la fin d\'un mot de remplacement', 'yourx-tokenx-herex'],
    ['des mots dont le mot de remplacement est le morceau d\'un autre', 'xyour-xtoken-xhere'],
    ['des mots de remplacement de trois lettres : la liste n\'en compte pas (un morceau de trois lettres d\'une clé tirée au hasard en est un trop souvent)', 'foo-bar-baz'],
    ['sept pas sur dix : sous le seuil d\'une suite', 'abcdefghkp2'],
    ['des caractères répétés deux à deux ne font pas une suite', 'aabbccddeeffgghh'],
    ['des pas de deux ne font pas une suite', 'acegikmoqsuwy'],
  ];
  for (const [nom, corps] of faux) assert.equal(estCorpsDeLeurre(corps), false, `${nom} : ${corps}`);
});

test('les mots de remplacement : chacun fait des mots joints un leurre, en minuscules, à capitale initiale ou en majuscules ; un mot dont il n\'est que le début ou la fin, non', () => {
  // La liste de la règle, écrite ici pour qu'on ne l'élargisse pas sans le dire : chaque mot a quatre lettres au moins (un morceau de trois lettres d'une clé tirée au
  // hasard est trop souvent un mot), des lettres ASCII minuscules et une voyelle (sans elle, `motsDeLaValeur` ne le lirait pas comme un mot).
  const MOTS = [
    'your', 'yours', 'this', 'here', 'insert', 'enter', 'paste', 'fill', 'replace', 'change', 'example', 'sample', 'test', 'demo', 'dummy', 'fake', 'mock', 'stub', 'placeholder',
    'lorem', 'redacted', 'hidden', 'removed', 'todo', 'fixme', 'none', 'null', 'empty', 'unset', 'undefined', 'blank',
    'token', 'secret', 'password', 'passwd', 'pass', 'private', 'client', 'access',
    'votre', 'jeton', 'passe', 'remplacer', 'remplacez', 'exemple', 'essai', 'bidon',
    'dein', 'deine', 'hier', 'geheim', 'passwort', 'clave', 'aqui', 'secreto', 'jouw', 'sleutel', 'wachtwoord',
  ];
  assert.deepEqual([...MOTS_DE_LEURRE].sort(), [...MOTS].sort(), 'la liste de la règle est celle de l\'essai');
  for (const mot of MOTS) {
    assert.ok(mot.length >= 4 && /^[a-z]+$/.test(mot) && /[aeiouy]/.test(mot), `${mot} : quatre lettres ASCII minuscules au moins, une voyelle`);
    for (const forme of [mot, `${mot[0].toUpperCase()}${mot.slice(1)}`, mot.toUpperCase()]) {
      assert.equal(estCorpsDeLeurre(`${forme}-${forme}-${forme}`), true, `${forme} : un mot de remplacement`);
      // Une lettre de plus, de la même casse que la fin du mot (la casse couperait `YOURSx` en `YOUR` et `Sx`).
      const proche = `${forme}${forme === forme.toUpperCase() ? 'X' : 'x'}`;
      assert.equal(estCorpsDeLeurre(`${proche}-${proche}-${proche}`), false, `${proche} n'est pas ${forme}`);
    }
    // Un mot collé derrière une lettre en minuscules (la casse couperait `xYour` en `x` et `Your`).
    assert.equal(estCorpsDeLeurre(`x${mot}-x${mot}-x${mot}`), false, `x${mot} n'est pas ${mot}`);
  }
  // Un mot de remplacement suffit parmi d'autres mots ; des mots qui n'en sont pas ne suffisent pas.
  assert.equal(estCorpsDeLeurre('my-workspace-token'), true);
  assert.equal(estCorpsDeLeurre('my-workspace-label'), false);
});

test('le leurre passe avant l\'allure hexadécimale : trente-deux 0, trente-deux f, l\'UUID nul et une suite ne sont pas une valeur générée', () => {
  for (const [nom, valeur] of [
    ['trente-deux 0', '0'.repeat(32)],
    ['trente-deux f', 'f'.repeat(32)],
    ['quarante 0', '0'.repeat(40)],
    ['l\'UUID nul', '00000000-0000-0000-0000-000000000000'],
    ['un UUID de f', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
    ['un UUID de chiffres répétés par morceaux', '11111111-2222-3333-4444-555555555555'],
    ['une suite hexadécimale', '0123456789abcdef'.repeat(2)],
    ['un faux UUID en suites', '12345678-1234-1234-1234-123456789012'],
  ]) {
    assert.equal(estGeneree(valeur), false, nom);
    assert.equal(juge('apiKey', valeur), 'aucun suite', `${nom} : rien, une valeur qui se voit fausse`);
  }
  // Une valeur hexadécimale ou un UUID tirés au hasard restent d'allure générée.
  assert.equal(estGeneree(tirer(32, HEX)), true, 'trente-deux signes hexadécimaux tirés au hasard');
  assert.equal(estGeneree(`${tirer(8, HEX)}-${tirer(4, HEX)}-${tirer(4, HEX)}-${tirer(4, HEX)}-${tirer(12, HEX)}`), true, 'un UUID tiré au hasard');
  assert.equal(juge('apiKey', tirer(32, HEX)), 'generee generee');
  // Trente et un `0` n'ont pas l'alphabet d'une valeur générée (trente-deux signes au moins) : le même verdict, par la suite.
  assert.equal(juge('apiKey', '0'.repeat(31)), 'aucun suite');
  // Des morceaux dont un seul n'est pas un caractère répété ne sont pas un leurre.
  assert.equal(juge('apiKey', `${'0'.repeat(8)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${tirer(12, HEX)}`), 'generee generee', 'un UUID dont le dernier morceau est tiré au hasard n\'est pas nul');
  assert.equal(juge('apiKey', `${tirer(8, HEX)}-0000-0000-0000-000000000000`), 'generee generee', 'ni celui dont le premier morceau l\'est');
});

test('derrière le préfixe d\'une clé, ce qui se voit faux est un leurre : chaque préfixe que l\'outil connaît, avant le format comme avant l\'allure générée', () => {
  for (const prefixe of PREFIXES_DE_CLE) {
    assert.equal(juge('apiKey', `${prefixe}${'x'.repeat(12)}`), 'aucun leurre', `${prefixe} et des x`);
    assert.equal(juge('apiKey', `${prefixe}${'0'.repeat(32)}`), 'aucun leurre', `${prefixe} et des 0`);
    assert.equal(juge('apiKey', `${prefixe}abcdefghijklmnop`), 'aucun leurre', `${prefixe} et une suite`);
    const tire = jugerValeur('apiKey', `${prefixe}${generee(32)}`);
    assert.equal(tire.verdict, 'generee', `${prefixe} et une valeur tirée au hasard : une clé`);
  }
  assert.equal(juge('apiKey', `xo${'xb-'}your-bot-token`), 'aucun leurre', 'des mots joints derrière le préfixe de Slack');
  assert.equal(juge('apiKey', `sk${'-'}your-api-key-here`), 'aucun leurre', 'des mots joints derrière sk-');
  assert.equal(juge('apiKey', `AK${'IA'}ABCDEFGHIJKLMNOP`), 'aucun leurre', 'une suite derrière AKIA');
  assert.equal(juge('apiKey', `gh${'p_'}${'x'.repeat(18)}${generee(18)}`), 'generee generee', 'un début répété, puis du hasard : pas un leurre');
  // Le test porte sur TOUT ce qui suit le préfixe, et le préfixe est au début de la valeur.
  assert.equal(juge('apiKey', `${generee(20)}-${'a'.repeat(12)}`), 'generee generee', 'un morceau répété derrière du hasard : du hasard');
  assert.equal(juge('apiKey', `mon-${'sk-'}${'x'.repeat(12)}`), 'a_verifier a_verifier', 'un préfixe qui n\'est pas au début n\'est pas retiré');
  assert.equal(juge('apiKey', `${'y'.repeat(8)}${'sk-'}${'y'.repeat(8)}`), 'a_verifier a_verifier', 'ni au milieu, même si ce qui reste, une fois le préfixe retiré, serait un leurre');
  assert.equal(juge('apiKey', `tk_test_${'x'.repeat(12)}`), 'a_verifier a_verifier', 'un préfixe que l\'outil ne connaît pas n\'est pas retiré');
  assert.equal(juge('apiKey', `SK${'_'}${'x'.repeat(12)}`), 'a_verifier a_verifier', 'les préfixes s\'écrivent comme les fournisseurs les émettent');
  // Borne : huit caractères derrière le préfixe, pas sept.
  assert.equal(juge('apiKey', `sk${'-'}${'x'.repeat(8)}`), 'aucun leurre', 'huit caractères');
  assert.equal(juge('apiKey', `sk${'-'}${'x'.repeat(7)}`), 'a_verifier a_verifier', 'sept caractères : sous la borne');
  assert.equal(juge('apiKey', `sk${'-'}`), 'aucun court', 'le préfixe seul n\'est pas une valeur : huit caractères au moins');
  // Avant l'allure générée : des mots joints derrière un préfixe qui n'est pas un mot (`ghp`) ont, à trois classes de caractères, l'allure d'une valeur tirée au hasard si le leurre n'est pas retiré d'abord.
  const mots = `gh${'p_'}Your_Token_Here_Now`;
  assert.equal(estGeneree(mots), true, 'prémisse : sans le leurre, cette valeur est d\'allure générée');
  assert.equal(juge('apiKey', mots), 'aucun leurre');
});

test('un format de fournisseur dont la partie tirée au hasard se voit fausse n\'est pas une clé ; le même format tiré au hasard l\'est', () => {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const leurres = [
    ['aws', `AK${'IA'}${'X'.repeat(16)}`],
    ['aws', `AK${'IA'}ABCDEFGHIJKLMNOP`],
    ['aws', `AK${'IA'}${'0'.repeat(16)}`],
    ['github', `gh${'p_'}${'x'.repeat(36)}`],
    ['github', `gh${'p_'}${'0'.repeat(36)}`],
    ['github', `gh${'p_'}${ALPHABET.slice(0, 36)}`],
    ['github-pat', `github${'_pat_'}${'x'.repeat(50)}`],
    ['github-pat', `github${'_pat_'}${'0'.repeat(22)}_${'0'.repeat(59)}`],
    ['openai', `sk${'-'}${ALPHABET}`],
    ['slack', `xo${'xb-'}your-bot-token`],
    ['slack', `xo${'xb-'}YOUR-TOKEN-HERE`],
    ['slack', `xo${'xb-'}${'x'.repeat(12)}-${'x'.repeat(12)}-${'x'.repeat(24)}`],
    ['slack', `xo${'xb-'}${'0'.repeat(10)}-${'0'.repeat(10)}-${'x'.repeat(8)}`],
    ['google', `AI${'za'}${'x'.repeat(35)}`],
    ['stripe', `pk${'_test_'}${'x'.repeat(24)}`],
    ['stripe', `pk${'_live_'}${'0'.repeat(24)}`],
  ];
  for (const [id, valeur] of leurres) {
    assert.deepEqual(formatsDans(valeur), [], `${id} : ${valeur}`);
    assert.deepEqual(formatsDans(`La clé ${valeur} de l'exemple.`), [], `${id} dans une phrase`);
  }
  // Les mêmes formats, tirés au hasard : reconnus.
  const secrets = [
    ['aws', `AK${'IA'}${tirer(16, BASE32)}`], ['github', `gh${'p_'}${generee(36)}`], ['github-pat', `github${'_pat_'}${generee(22)}_${generee(59)}`],
    ['openai', `sk${'-'}${generee(48)}`], ['slack', `xo${'xb-'}1234567890-1234567890123-${generee(24)}`],
    ['google', `AI${'za'}${tirer(35, ALNUM)}`], ['stripe', `pk${'_live_'}${generee(24)}`],
  ];
  for (const [id, valeur] of secrets) assert.deepEqual(formatsDans(valeur).map((t) => t.format.id), [id], valeur.slice(0, 6));
  // Un début qui se voit faux, puis du hasard, reste une clé : le leurre est la partie entière, non son début.
  assert.deepEqual(formatsDans(`AK${'IA'}${'X'.repeat(8)}${tirer(8, BASE32)}`).map((t) => t.format.id), ['aws']);
  assert.deepEqual(formatsDans(`gh${'p_'}${'x'.repeat(18)}${generee(18)}`).map((t) => t.format.id), ['github']);
  // Tous les formats dont le corps est tiré au hasard déclarent leur préfixe : un format qui l'oublierait ne verrait pas ses leurres.
  assert.deepEqual(FORMATS.filter((f) => f.aleatoire).map((f) => f.id), ['aws', 'github', 'github-pat', 'openai', 'slack', 'google', 'stripe']);
  assert.deepEqual(FORMATS.filter((f) => !f.aleatoire).map((f) => f.id), ['pem', 'jwt', 'mapbox'], 'une clé privée, un JWT et un jeton Mapbox ont une structure, non un corps tiré au hasard');
  assert.ok(FORMATS.every((f) => typeof f.indice === 'string' && f.indice.length > 0), 'chaque format a son indice');
});

test('l\'indice d\'un format est ce que toute valeur du format contient : un texte qui ne le porte pas n\'est pas lu, un qui le porte l\'est', () => {
  for (const f of FORMATS) {
    const exemples = { aws: `AK${'IA'}${tirer(16, BASE32)}`, github: `gh${'p_'}${generee(36)}`, 'github-pat': `github${'_pat_'}${generee(81)}`, openai: `sk${'-'}${generee(48)}`, slack: `xo${'xb-'}1234567890-${generee(24)}`, pem: `-----BEGIN PRIVATE ${'KEY-----'}\n${tirer(64, ALNUM)}`, jwt: `eyJ${tirer(17, ALNUM)}.eyJ${tirer(40, ALNUM)}.${tirer(43, ALNUM)}`, google: `AI${'za'}${tirer(35, ALNUM)}`, stripe: `pk${'_live_'}${generee(24)}`, mapbox: `pk.${'eyJ1Ijoi'}${tirer(30, ALNUM)}.${tirer(22, ALNUM)}` };
    const valeur = exemples[f.id];
    assert.ok(valeur.includes(f.indice), `${f.id} : la valeur contient l'indice ${f.indice}`);
    assert.equal(formatsDans(valeur, [f]).length, 1, `${f.id} : reconnu`);
    assert.equal(formatsDans(valeur.replace(f.indice, f.indice.slice(0, -1) + '#'), [f]).length, 0, `${f.id} : sans son indice, le texte n'est pas lu`);
  }
});

// --- Les huit leurres de la coordination, de bout en bout --------------------------------------------------------------

test('les huit leurres de la coordination ne disent rien : dans .env, .env.example, un script, un JSON, un README', async () => {
  const fichiers = {};
  for (const { champ, valeur } of LEURRES) {
    fichiers['.env'] = `${fichiers['.env'] ?? ''}${champ}=${valeur}\n`;
    fichiers['.env.example'] = `${fichiers['.env.example'] ?? ''}${champ}=${valeur}\n`;
    fichiers['config.js'] = `${fichiers['config.js'] ?? 'const c = {};\n'}c.${champ} = '${valeur}';\n`;
    fichiers['config.json'] = `${fichiers['config.json'] ?? ''}{ "${champ}": "${valeur}" }\n`;
    fichiers['README.md'] = `${fichiers['README.md'] ?? '# Widget\n\n'}Mettez ${valeur} dans ${champ}.\n`;
  }
  const a = await auditer(fichiers);
  assert.deepEqual(dit(a), [], 'aucun constat, aucun des huit');
  // Un par un, pour que chacun soit jugé seul.
  for (const { nom, champ, valeur } of LEURRES) {
    const seul = await auditer({ '.env.example': `${champ}=${valeur}\n`, 'app.js': `var x = { ${champ}: '${valeur}' };\n` });
    assert.deepEqual(dit(seul), [], nom);
  }
});

test('les mêmes formes, tirées au hasard, restent des secrets critiques et bloquants : dans .env.example comme ailleurs', async () => {
  const secrets = [
    ['GITHUB_TOKEN', `gh${'p_'}${generee(36)}`], ['SLACK_BOT_TOKEN', `xo${'xb-'}1234567890-1234567890123-${generee(24)}`], ['AWS_ACCESS_KEY_ID', `AK${'IA'}${tirer(16, BASE32)}`],
    ['OPENAI_API_KEY', `sk${'-'}${generee(48)}`], ['STRIPE_SECRET_KEY', `sk${'_test_'}${generee(24)}`], ['API_SECRET', tirer(32, HEX)],
    ['SESSION_SECRET', `${tirer(8, HEX)}-${tirer(4, HEX)}-${tirer(4, HEX)}-${tirer(4, HEX)}-${tirer(12, HEX)}`],
  ];
  for (const [champ, valeur] of secrets) {
    for (const fichier of ['.env', '.env.example', 'app.js']) {
      const contenu = fichier === 'app.js' ? `var c = { ${champ}: '${valeur}' };\n` : `${champ}=${valeur}\n`;
      const a = await auditer({ [fichier]: contenu });
      assert.deepEqual(dit(a), [`${fichier}:1 critique bloquant`], `${champ} dans ${fichier}`);
    }
  }
});

// --- Un fichier d'exemple ------------------------------------------------------------------------------------------------

test('estFichierDExemple : le mot example, sample, template ou exemple, entier dans le nom du fichier', () => {
  const oui = ['.env.example', '.env.sample', '.env.template', '.env.exemple', 'sous/dossier/.env.example', 'config.example.json', 'config.sample.yml', 'settings.template.toml',
    'exemple.env', 'example.env', 'env.example', 'my_example.env', 'my-sample.json', '.ENV.EXAMPLE', 'Config.Example.JSON', 'example', 'app.example.js', 'template.json', 'sample.yml',
    'example_config.js', 'example-config.js', 'sample_data.json', 'template-v2.yml'];
  const non = ['.env', '.env.local', '.env.production', 'config.json', 'app.js', 'examples.json', 'counterexample.env', 'sampleData.json', 'templates.yml', 'exemples.env',
    'example/.env', 'examples/config.json', 'sample/app.js', 'template/.env.local', 'conf.examplejson', 'x.samples', 'secret.json',
    // Le mot est cherché dans le nom du fichier, non dans le chemin : un dossier qui en porte un ne fait pas un fichier d'exemple.
    'example.d/config.json', 'sample-data/app.js', 'template_v2/app.js', 'sous/example.d/app.js'];
  const fiche = (chemin) => ({ chemin });
  for (const chemin of oui) assert.equal(estFichierDExemple(fiche(chemin)), true, chemin);
  for (const chemin of non) assert.equal(estFichierDExemple(fiche(chemin)), false, chemin);
});

test('dans un fichier d\'exemple, un mot seul ne dit rien ; dans un vrai fichier, il reste « à vérifier »', async () => {
  const lignes = 'DB_PASSWORD=password\nPOSTGRES_PASSWORD=postgres\nJWT_SECRET=supersecret\nREDIS_PASSWORD=redispass\nADMIN_PASSWORD=Soleil2024!\nAPI_TOKEN=admin123\n';
  for (const fichier of ['.env.example', '.env.sample', '.env.template', 'config.example.json', '.env.exemple']) {
    const contenu = fichier.endsWith('.json') ? '{\n  "DB_PASSWORD": "password",\n  "POSTGRES_PASSWORD": "postgres",\n  "JWT_SECRET": "supersecret",\n  "REDIS_PASSWORD": "redispass",\n  "ADMIN_PASSWORD": "Soleil2024!",\n  "API_TOKEN": "admin123"\n}\n' : lignes;
    assert.deepEqual(dit(await auditer({ [fichier]: contenu })), [], fichier);
  }
  const reel = await auditer({ '.env': lignes });
  assert.deepEqual(dit(reel), ['.env:1 majeur', '.env:2 majeur', '.env:3 majeur', '.env:4 majeur', '.env:5 majeur', '.env:6 majeur'], 'le vrai .env : « à vérifier »');
  for (const c of C_SECRET(reel)) assert.equal(c.confiance, 'a_verifier');
  // Un script n'a pas cette règle, quel que soit son nom : le nom d'un fichier est le choix de son auteur, et un script que la page charge est du code que le
  // navigateur exécute. `config.example.js` se juge comme `config.js` ; `estFichierDExemple` dit pourtant oui à son nom (essai plus haut), c'est la règle qui ne le demande pas.
  const code = 'module.exports = { password: "postgres", apiKey: "supersecret" };\n';
  assert.deepEqual(dit(await auditer({ 'config.example.js': code })), ['config.example.js:1 majeur', 'config.example.js:1 majeur']);
  assert.deepEqual(dit(await auditer({ 'config.js': code })), ['config.js:1 majeur', 'config.js:1 majeur']);
  assert.deepEqual(dit(await auditer({ 'index.html': '<!doctype html><title>t</title><script src="config.sample.js"></script>', 'config.sample.js': code })), ['config.sample.js:1 majeur', 'config.sample.js:1 majeur'], 'un script de la page');
  assert.deepEqual(dit(await auditer({ 'index.html': `<!doctype html><title>t</title><script>${code}</script>` })), ['index.html:1 majeur', 'index.html:1 majeur'], 'un script dans la page');
  // Un dossier d'exemple ne fait pas un fichier d'exemple : c'est le nom du fichier.
  assert.deepEqual(dit(await auditer({ 'example/.env': 'DB_PASSWORD=postgres\n' })), ['example/.env:1 majeur']);
});

test('dans un fichier d\'exemple, une valeur d\'allure générée et un format de fournisseur restent des secrets critiques et bloquants', async () => {
  const a = await auditer({
    '.env.example': `API_SECRET=${tirer(32, HEX)}\nJWT_SECRET=${generee(40)}\nGITHUB_TOKEN=gh${'p_'}${generee(36)}\nDB_PASSWORD=postgres\n`,
    'config.sample.json': `{ "apiKey": "${generee(40)}" }\n`,
  });
  assert.deepEqual(dit(a), ['.env.example:1 critique bloquant', '.env.example:2 critique bloquant', '.env.example:3 critique bloquant', 'config.sample.json:1 critique bloquant']);
});

test('jugerValeur : fichierDExemple ne change que le « à vérifier »', () => {
  const dans = { fichierDExemple: true };
  assert.equal(juge('password', 'postgres', dans), 'aucun fichier-exemple');
  assert.equal(juge('password', 'postgres'), 'a_verifier a_verifier');
  assert.equal(juge('password', 'postgres', { fichierDExemple: false }), 'a_verifier a_verifier');
  assert.equal(juge('apiKey', generee(30), dans), 'generee generee');
  assert.equal(juge('apiKey', 'changeme', dans), 'aucun remplacement', 'la raison de ne rien dire qui précède reste celle qu\'on donne');
  assert.equal(juge('apiKey', 'abc', dans), 'aucun court');
});

// --- Un libellé de traduction ----------------------------------------------------------------------------------------------

test('estLibelle : un mot de langue à capitale initiale ou un sigle, en lettres seules, tirets permis ; ni chiffre ni symbole ni blanc', () => {
  const oui = ['Passwort', 'Zugangstoken', 'API-Schlüssel', 'Contraseña', 'Contraseña', 'Wachtwoord', 'Toegangstoken', 'Password', 'Mot-de-passe', 'Sunshine',
    'Пароль', 'Contraseña-temporal', 'パスワードを入力してください', 'كلمة', 'पासवर्ड', 'ABCDE-Xyz', 'AB-Xyz', 'Éléphant',
    // Les lettres qu'une marque combinante suit (l'écriture décomposée) : avant un tiret, dans un mot après un tiret.
    'Contrasen\u0303a', 'Passwort-Contrasen\u0303a', 'Mot-de-Contrasen\u0303a'];
  const non = ['postgres', 'supersecret', 'wachtwoord', 'SUPERSECRET', 'SECRETKEYS', 'ABCDEF-Xyz', 'A-Xyz', 'Passw0rd', 'Soleil2024!', 'Hunter2', 'Pass word', 'Pass_word', 'API-', '-Abc', 'Abc-',
    'Mot-de-passe-2024', 'L’utilisateur', 'Abc.def', 'Abc9', '9Abc', 'aBcDeFgH', 'Abc--def', 'Abc-9', '', 'a'];
  for (const valeur of oui) assert.equal(estLibelle(valeur), true, valeur);
  for (const valeur of non) assert.equal(estLibelle(valeur), false, valeur);
});

test('un libellé de traduction (de, es, nl, en, ru, ja) ne dit rien : dans un JSON de langue et dans un dictionnaire JS', async () => {
  const a = await auditer({
    'locales/de.json': '{ "password": "Passwort", "accessToken": "Zugangstoken", "apiKey": "API-Schlüssel" }\n',
    'locales/es.json': '{ "password": "Contraseña" }\n',
    'locales/nl.json': '{ "password": "Wachtwoord", "accessToken": "Toegangstoken" }\n',
    'locales/en.json': '{ "password": "Password", "secret": "Confidential" }\n',
    'locales/ru.json': '{ "password": "Пароль" }\n',
    'locales/ja.json': '{ "password": "パスワードを入力してください" }\n',
    'i18n.js': "const T = { de: { password: 'Passwort' }, es: { password: 'Contraseña' }, nl: { accessToken: 'Toegangstoken' } };\n",
  });
  assert.deepEqual(dit(a), []);
});

test('ce qui n\'est pas un libellé reste « à vérifier » : un mot de passe en minuscules, avec un chiffre ou un symbole, en majuscules', async () => {
  const a = await auditer({
    '.env': 'DB_PASSWORD=postgres\nADMIN_PASSWORD=Soleil2024!\nROOT_PASSWORD=Passw0rd\nAPP_SECRET=SUPERSECRET\nMAIL_PASSWORD=wachtwoord\n',
    'app.js': "const c = { password: 'Soleil2024!', apiKey: 'hunter2hunter2', token: 'supersecret' };\n",
    'locales/nl.json': '{ "password": "wachtwoord" }\n',
  });
  assert.deepEqual(dit(a), ['.env:1 majeur', '.env:2 majeur', '.env:3 majeur', '.env:4 majeur', '.env:5 majeur', 'app.js:1 majeur', 'app.js:1 majeur', 'app.js:1 majeur', 'locales/nl.json:1 majeur']);
  assert.equal(juge('password', 'Soleil2024!'), 'a_verifier a_verifier');
  assert.equal(juge('password', 'Passwort'), 'aucun libelle');
  assert.equal(juge('password', 'パスワードを入力してください'), 'aucun libelle');
});

test('un libellé est jugé après l\'allure générée : une valeur tirée au hasard n\'est jamais un libellé', () => {
  assert.equal(juge('apiKey', generee(30)), 'generee generee');
  // Un mot de quarante lettres, une capitale puis des minuscules, n'a ni chiffre ni symbole : libellé (le test porte sur la forme, pas sur la longueur).
  assert.equal(juge('password', 'a'.repeat(40)), 'aucun suite', 'un caractère répété se voit avant tout');
  assert.equal(juge('password', `Z${'a'.repeat(39)}`), 'aucun libelle', 'une capitale puis des minuscules : un mot');
  assert.equal(juge('password', 'Donaudampfschifffahrtsgesellschaft'), 'aucun libelle');
  // Quatre mille caractères, un chiffre au bout : pas un libellé (le temps de cette lecture est chronométré dans `scripts/chronometrer-pieges.mjs`, non ici).
  assert.equal(estLibelle(`A${'b'.repeat(4094)}9`), false);
  assert.equal(estLibelle(`A${'b'.repeat(4095)}`), true);
});
