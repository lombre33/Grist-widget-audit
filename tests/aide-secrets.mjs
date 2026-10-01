/**
 * Ce que les essais des secrets partagent (`c-secret-leurres`, `masque-des-secrets`) : des valeurs tirées au hasard, mais les mêmes à
 * chaque lancement (mulberry32), et les préfixes des clés de fournisseur. Aucun secret n'est écrit ici : chaque valeur est assemblée à
 * l'exécution (un hébergeur refuse de recevoir un dépôt qui en contient un, et l'outil le signalerait sur lui-même).
 */

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

export const tirer = (n, alphabet) => Array.from({ length: n }, () => alphabet[Math.floor(hasard() * alphabet.length)]).join('');
export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const URL64 = `${ALNUM}_-`;
export const BASE64 = `${ALNUM}+/`;
export const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const HEX = '0123456789abcdef';
/** Une valeur tirée au hasard : minuscules, majuscules et chiffres. */
export const generee = (n = 40) => tirer(n, ALNUM);

/** Les débuts de clé que l'outil connaît (les formats de fournisseur et les préfixes de clés qui n'en sont pas encore un), un par branche du préfixe. */
export const PREFIXES_DE_CLE = [
  `AK${'IA'}`, `AI${'za'}`, `gh${'p_'}`, `gh${'o_'}`, `gh${'u_'}`, `gh${'s_'}`, `gh${'r_'}`, `github${'_pat_'}`,
  `xo${'xb-'}`, `xo${'xa-'}`, `xo${'xp-'}`, `xo${'xr-'}`, `xo${'xs-'}`, `xa${'pp-'}`, `xa${'pp-1-'}`,
  `sk${'-'}`, `sk${'-proj-'}`, `sk${'-svcacct-'}`, `sk${'-admin-'}`, `sk${'-ant-'}`, `sk${'-ant-api03-'}`,
  `sk${'_live_'}`, `sk${'_test_'}`, `rk${'_live_'}`, `rk${'_test_'}`, `pk${'_live_'}`, `pk${'_test_'}`,
];

/** Les huit valeurs que la coordination a relevées comme de faux secrets critiques (v23) : chacune a la forme d'une clé et se voit fausse. */
export const LEURRES = [
  { nom: 'jeton GitHub de trente-six x', champ: 'GITHUB_TOKEN', valeur: `gh${'p_'}${'x'.repeat(36)}` },
  { nom: 'jeton Slack de mots', champ: 'SLACK_BOT_TOKEN', valeur: `xo${'xb-'}your-bot-token` },
  { nom: 'clé AWS de seize X', champ: 'AWS_ACCESS_KEY_ID', valeur: `AK${'IA'}${'X'.repeat(16)}` },
  { nom: 'clé de type OpenAI de quarante-huit x', champ: 'OPENAI_API_KEY', valeur: `sk${'-'}${'x'.repeat(48)}` },
  { nom: 'clé secrète Stripe d\'essai de vingt-quatre x', champ: 'STRIPE_SECRET_KEY', valeur: `sk${'_test_'}${'x'.repeat(24)}` },
  { nom: 'trente-deux 0', champ: 'API_SECRET', valeur: '0'.repeat(32) },
  { nom: 'trente-deux f', champ: 'API_SECRET', valeur: 'f'.repeat(32) },
  { nom: 'UUID nul', champ: 'SESSION_SECRET', valeur: '00000000-0000-0000-0000-000000000000' },
];

/** Les formats de fournisseur qui sont des secrets (OpenAI sous ses deux formes : sans type et à type), tirés au hasard. */
export const SECRETS = [
  { id: 'aws', valeur: `AK${'IA'}${tirer(16, BASE32)}` },
  { id: 'github', valeur: `gh${'p_'}${tirer(36, ALNUM)}` },
  { id: 'github-pat', valeur: `github${'_pat_'}${tirer(22, ALNUM)}_${tirer(59, ALNUM)}` },
  { id: 'openai', valeur: `sk${'-'}${tirer(48, ALNUM)}` },
  { id: 'openai', valeur: `sk${'-proj-'}${tirer(120, URL64)}` },
  { id: 'slack', valeur: `xo${'xb-'}1234567890-1234567890123-${tirer(24, ALNUM)}` },
  { id: 'pem', valeur: `-----BEGIN RSA PRIVATE ${'KEY-----'}\\n${tirer(64, BASE64)}\\n-----END RSA PRIVATE KEY-----` },
  { id: 'jwt', valeur: `eyJ${tirer(17, URL64)}.eyJ${tirer(40, URL64)}.${tirer(43, URL64)}` },
];
/** Les clés que leur fournisseur publie pour une page : ce ne sont pas des secrets. */
export const PUBLIQUES = [
  { id: 'google', valeur: `AI${'za'}${tirer(35, URL64)}` },
  { id: 'stripe', valeur: `pk_${'live_'}${tirer(24, ALNUM)}` },
  { id: 'mapbox', valeur: `pk.${'eyJ1Ijoi'}${tirer(30, URL64)}.${tirer(22, URL64)}` },
];

/** Un JWT dont la charge utile est `charge` (l'en-tête est celui de HS256, la signature est tirée au hasard). */
export function jeton(charge) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(charge)}.${tirer(43, URL64)}`;
}

/** Le texte du constat d'un JWT de rôle anonyme, écrit ici : sans émetteur, puis avec l'émetteur cité (`citer`, à la barre qu'il faut). */
export const TEXTE_ANONYME = "Un jeton JWT dont la charge utile dit « role: anon » est présent. C'est la clé que des fournisseurs (Supabase) publient pour être embarquée dans une page : ce n'est pas un secret, et elle donne les droits du rôle anonyme de son projet.";
export const dirAvecEmetteur = (cite) => `${TEXTE_ANONYME} Son émetteur (champ iss) : ${cite}.`;
/** L'échappement d'une page HTML, écrit ici à la main : le rapport a le sien, qu'un essai ne recalcule pas. */
export const echapperHtml = (texte) => texte.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Ce qu'on ne voit pas : un contrôle (retour à la ligne compris), un séparateur de ligne ou de paragraphe, un caractère de format (sens d'écriture, largeur nulle, marque d'ordre des octets). */
export const INVISIBLES = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Les six émetteurs que la coordination a demandés (v24) : du balisage, une barre verticale, un guillemet inversé, un saut de ligne, la fin d'un commentaire, un caractère
 * d'échappement. `cite` : le texte cité, tel que le disent le JSON, le Markdown et une console ; `dansLeHtml` : ce que la page HTML en écrit ; `pasAuDebutDeLigne` : ce que le
 * Markdown ne doit jamais commencer une ligne par.
 */
export const EMETTEURS_HOSTILES = [
  { nom: 'du balisage', iss: '<b>x</b>', cite: '`<b>x</b>`', dansLeHtml: '`&lt;b&gt;x&lt;/b&gt;`', pasAuDebutDeLigne: ['<b>'] },
  { nom: 'une barre verticale', iss: 'a | b | c', cite: '`a | b | c`', dansLeHtml: '`a | b | c`', pasAuDebutDeLigne: ['| b |'] },
  { nom: 'un guillemet inversé', iss: 'a`b', cite: '``a`b``', dansLeHtml: '``a`b``', pasAuDebutDeLigne: [] },
  { nom: 'un saut de ligne', iss: 'a\n# titre\n- x', cite: '`a\\u000a# titre\\u000a- x`', dansLeHtml: '`a\\u000a# titre\\u000a- x`', pasAuDebutDeLigne: ['# titre', '- x'] },
  { nom: 'la fin d\'un commentaire', iss: 'x --> y <!-- z', cite: '`x --> y <!-- z`', dansLeHtml: '`x --&gt; y &lt;!-- z`', pasAuDebutDeLigne: ['-->', '<!--'] },
  { nom: 'un caractère d\'échappement', iss: '\u001b[2J\u001b]0;pwned\u0007', cite: '`\\u001b[2J\\u001b]0;pwned\\u0007`', dansLeHtml: '`\\u001b[2J\\u001b]0;pwned\\u0007`', pasAuDebutDeLigne: [] },
];
