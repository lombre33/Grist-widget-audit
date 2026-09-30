/**
 * C-SECRET-01 : un secret en dur dans le dépôt.
 *
 * Un secret versionné dans un dépôt public est compromis dès sa publication, et un widget, exécuté chez le client, ne
 * peut pas en détenir un. La règle ne dit « secret » que sur une preuve, et dit « à vérifier » quand elle n'en a pas :
 *
 *  1. Un FORMAT DE FOURNISSEUR (clé d'accès AWS, jeton GitHub, clé privée…) dans le texte de n'importe quel fichier, carte
 *     de sources et README compris : le format est la preuve (critique, bloquant). Une clé que son fournisseur publie pour
 *     être embarquée dans une page (Google, Stripe, Mapbox) est une information, non un secret : un widget s'exécute chez
 *     le client. La clé d'exemple de la documentation d'AWS n'est rien.
 *  2. « NOM = VALEUR » : un nom qui évoque un secret (`apiKey`, `password`…) qui reçoit un littéral. Lu dans l'arbre d'un
 *     fichier JS (déclaration, propriété, affectation : le texte d'un message qui cite `token: 'ma-cle'` n'est pas une
 *     affectation), et ligne à ligne dans les fichiers de configuration (`.env`, `.json`, `.yml`, `.ini`…). Jamais dans
 *     une carte de sources ni un README, qui citent du code sans en être. La valeur est jugée, dans cet ordre :
 *       a. allure d'une valeur générée : critique, bloquant ;
 *       b. valeur de remplacement ou phrase : rien ;
 *       c. autre chose (un mot de passe choisi à la main, une clé d'essai) : majeur « à vérifier », non bloquant.
 *
 * Aucun constat, aucun extrait, aucune preuve ne redit la valeur en entier : l'extrait est masqué, la preuve garde le
 * nom, la longueur et les mesures qui ont fait juger la valeur.
 */
import { constat } from '../moteur/modele.js';
import { pourChaqueUniteJs, chaineLitterale } from '../moteur/analyse-js.js';
import { numeroLigne } from '../moteur/lignes.js';

/**
 * Le début d'une suite de caractères de base64 URL. Les formats dont la queue est une suite longue ne se cherchent qu'à son
 * début : un départ à chaque `eyJ` d'une suite `eyJ-eyJ-eyJ-…` relirait la suite entière à chaque fois, quadratique sur un
 * dépôt qui n'a qu'à répéter le motif (V2 : un quadratique est un déni de service).
 */
const DEBUT_DE_SUITE = '(?<![A-Za-z0-9_-])';

/**
 * Chaque suite gloutonne de ces motifs a une borne haute. L'analyseur d'expressions régulières de V8 garde un état par caractère d'une
 * suite gloutonne, et sa pile déborde (`RangeError: Maximum call stack size exceeded`) à quelques millions de caractères : 16 Mio de
 * base64 URL, plus grand que tout jeton, feraient échouer toute la règle, et avec elle les secrets du reste du dépôt. Un jeton opaque
 * tient en moins de 512 caractères ; un segment de JWT tient dans un en-tête HTTP (16 384 caractères, la taille que Node accepte).
 * Au-delà, la suite n'est pas un jeton : c'est une donnée.
 *
 * Les formats que les fournisseurs émettent. `publique` : une clé que le fournisseur publie pour être embarquée dans une
 * page, protégée par une restriction côté fournisseur et non par son secret. `exemple` : une valeur du format que la
 * documentation du fournisseur publie, qui n'ouvre rien. `valide` : ce que le motif ne dit pas et que le format garantit
 * (une clé tirée au hasard n'est pas un mot). `extrait` : ce qu'on montre de la valeur, quand la masquer ne dit rien.
 */
export const FORMATS = [
  { id: 'aws', libelle: "clé d'accès AWS", re: /\bAKIA[0-9A-Z]{16}\b/g, exemple: (t) => /EXAMPLE$/.test(t) },
  { id: 'github', libelle: 'jeton personnel GitHub', re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { id: 'github-pat', libelle: 'jeton personnel GitHub (format récent)', re: /\bgithub_pat_[A-Za-z0-9_]{50,512}\b/g },
  // `sk-` suivi d'une suite alphanumérique (les clés d'origine) ou d'un type (`sk-proj-`, `sk-svcacct-`, `sk-admin-`) puis d'une suite à tirets et soulignés (les clés actuelles).
  // Une clé tirée au hasard a des minuscules, des majuscules et des chiffres : `sk-` suivi d'un long mot en casse mixte n'en est pas une.
  { id: 'openai', libelle: "clé d'API de type OpenAI", re: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,512}|[A-Za-z0-9]{32,512})\b/g, valide: (t) => classesDe(t.replace(/^sk-(?:(?:proj|svcacct|admin)-)?/, '')) >= 3 },
  { id: 'slack', libelle: 'jeton Slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,512}\b/g },
  // L'en-tête seul n'est pas une clé : une bibliothèque qui lit des clés PEM le cite. Le corps (une suite de base64 que l'en-tête annonce, d'au plus 120 caractères de séparation : retours à la ligne, échappés ou non, guillemets, concaténation) est la preuve.
  { id: 'pem', libelle: 'clé privée', extrait: (t) => `${t} (corps non reproduit)`, re: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) )?PRIVATE KEY(?: BLOCK)?-----(?=[\s\S]{0,120}?[A-Za-z0-9+/]{40})/g },
  { id: 'jwt', libelle: 'jeton JWT', re: new RegExp(`${DEBUT_DE_SUITE}eyJ[A-Za-z0-9_-]{10,16384}\\.[A-Za-z0-9_-]{10,16384}\\.[A-Za-z0-9_-]{10,16384}\\b`, 'g') },
  { id: 'google', libelle: "clé d'API Google", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, publique: true },
  { id: 'stripe', libelle: 'clé publique Stripe', re: /\bpk_(?:live|test)_[A-Za-z0-9]{16,512}\b/g, publique: true },
  { id: 'mapbox', libelle: 'jeton public Mapbox', re: /\bpk\.eyJ[A-Za-z0-9_-]{10,16384}\.[A-Za-z0-9_-]{10,16384}\b/g, publique: true },
];

/** Les valeurs d'un texte qui ont le format d'un fournisseur : `{ format, valeur, index }`, dans l'ordre du texte. */
export function formatsDans(texte) {
  const trouves = [];
  for (const format of FORMATS) {
    for (const m of texte.matchAll(format.re)) {
      if (format.exemple?.(m[0]) || format.valide?.(m[0]) === false) continue;
      trouves.push({ format, valeur: m[0], index: m.index });
    }
  }
  return trouves.sort((a, b) => a.index - b.index);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Le nom : évoque-t-il un secret ?                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Un nom se juge sur ses quatre-vingts derniers caractères (son dernier mot décide), une valeur lue dans un fichier de configuration sur ses 4 096 premiers : le travail et la mémoire d'une trouvaille sont bornés, quelle que soit sa taille. */
const LONGUEUR_DE_NOM = 80;
const LONGUEUR_DE_VALEUR = 4096;

const estMajuscule = (c) => c >= 65 && c <= 90;
const estMinuscule = (c) => c >= 97 && c <= 122;
const estChiffre = (c) => c >= 48 && c <= 57;

/**
 * Les morceaux d'un texte, coupés à tout caractère qui n'est ni une lettre ASCII ni un chiffre et à chaque changement de casse :
 * `clientSecret`, `CLIENT_SECRET`, `client-secret` donnent `client`, `secret` (à la casse près), `XMLHttpRequest` donne `XML`,
 * `Http`, `Request`. `chiffres` coupe aussi entre une minuscule et un chiffre (`token2`). Un seul parcours : des expressions
 * régulières qui coupent aux majuscules relisent chaque suite de majuscules à chaque départ, quadratiques sur une suite de
 * 4 096 lettres ou sur un identifiant de 16 Mio (V2 : un quadratique est un déni de service).
 */
function morceauxDe(texte, chiffres) {
  const morceaux = [];
  let debut = -1;
  for (let i = 0; i <= texte.length; i++) {
    const c = texte.charCodeAt(i); // NaN après le dernier caractère : ni lettre ni chiffre, le dernier morceau se ferme
    const lettreOuChiffre = estMajuscule(c) || estMinuscule(c) || estChiffre(c);
    if (!lettreOuChiffre) {
      if (debut !== -1) morceaux.push(texte.slice(debut, i));
      debut = -1;
      continue;
    }
    if (debut !== -1) {
      // `avant` est une lettre ou un chiffre (le morceau en cours n'a pas d'autre caractère) : une majuscule coupe après une minuscule ou un chiffre, et après une majuscule quand elle commence un mot (`HTMLToken`).
      const avant = texte.charCodeAt(i - 1);
      const coupe = estMajuscule(c)
        ? !estMajuscule(avant) || estMinuscule(texte.charCodeAt(i + 1))
        : chiffres && estChiffre(c) && estMinuscule(avant);
      if (coupe) { morceaux.push(texte.slice(debut, i)); debut = i; }
    } else debut = i;
  }
  return morceaux;
}

/** Les mots d'un nom : `clientSecret`, `CLIENT_SECRET`, `client-secret`, `client.secret` donnent `client`, `secret`. */
export function motsDuNom(nom) {
  return morceauxDe(String(nom ?? ''), true).map((m) => m.toLowerCase());
}

const MOTS_DE_SECRET = new Set(['secret', 'token', 'password', 'passwd', 'passphrase', 'motdepasse', 'apikey', 'secretkey', 'privatekey', 'accesskey', 'authkey', 'masterkey', 'signingkey', 'encryptionkey']);
/** Ce qui qualifie `key` : `key` seul est partout (`sortKey`, `keyCode`), `apiKey` ou `privateKey` est un secret. */
const QUALIFIE_KEY = new Set(['api', 'secret', 'private', 'access', 'auth', 'master', 'signing', 'encryption']);

/**
 * Un nom évoque un secret quand son DERNIER mot (hors chiffres) en est un : `apiKey`, `DB_PASSWORD`, `accessToken`,
 * `_authToken`, `mot_de_passe`. Le dernier mot, parce que `tokenUrl`, `passwordLabel` ou `secretName` disent ce que la
 * valeur décrit, non ce qu'elle est.
 */
export function nomEvoqueUnSecret(nom) {
  const mots = motsDuNom(String(nom ?? '').slice(-LONGUEUR_DE_NOM)).filter((m) => !/^[0-9]+$/.test(m));
  const dernier = mots.at(-1);
  if (MOTS_DE_SECRET.has(dernier)) return true;
  if (dernier === 'key') return QUALIFIE_KEY.has(mots.at(-2));
  if (dernier === 'passe') return mots.at(-2) === 'de' && mots.at(-3) === 'mot';
  return false;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* La valeur : quelle allure a-t-elle ?                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Ce qu'on lit d'une valeur pour la juger : un secret tient en quelques centaines de caractères, le reste est de la donnée. */
const APERCU = 4096;
const LONGUEUR_GENEREE = 20;
const CLASSES_GENEREES = 3;
const ENTROPIE_GENEREE = 4;
const LONGUEUR_MINIMALE = 8;

/** Le nombre de classes de caractères d'une valeur : minuscules, majuscules, chiffres, autres. */
export function classesDe(valeur) {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(valeur)).length;
}

/** L'entropie de Shannon d'une valeur, en bits par caractère. */
export function entropieDe(valeur) {
  const comptes = new Map();
  for (const c of valeur) comptes.set(c, (comptes.get(c) ?? 0) + 1);
  const n = [...comptes.values()].reduce((s, k) => s + k, 0);
  let h = 0;
  for (const k of comptes.values()) h -= (k / n) * Math.log2(k / n);
  return h;
}

const HEXADECIMAL = /^[0-9a-f]{32,}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Les mots d'une valeur, si elle n'est faite que de mots (lettres) joints par `_`, `-`, un point, un blanc ou la casse, avec
 * au plus un nombre de quatre chiffres au bout : `SECRET_DO_NOT_PASS_THIS`, `my-access-token`, `ma-cle-2024`. Une suite de
 * lettres coupées à chaque changement de casse (`xKjQpLmNoPq…`) n'en est pas : ses morceaux sont trop courts pour être des
 * mots, et des groupes sans voyelle n'en sont pas non plus.
 */
export function motsDeLaValeur(valeur) {
  const morceaux = morceauxDe(valeur, false);
  if (morceaux.length < 2) return null;
  const mots = morceaux.filter((m) => /^[A-Za-z]+$/.test(m));
  const nombres = morceaux.filter((m) => /^[0-9]{1,4}$/.test(m));
  if (mots.length + nombres.length !== morceaux.length || nombres.length > 1) return null;
  if (mots.join('').length / mots.length < 3) return null;
  // Un mot de trois lettres ou plus a une voyelle : des groupes de lettres tirées au hasard (`KJQPL-XWZRT-…`, la forme d'une clé de licence) n'en ont pas tous.
  if (mots.some((m) => m.length >= 3 && !/[aeiouy]/i.test(m))) return null;
  return mots;
}

/** Une valeur qui se voit fausse : un seul caractère répété, ou une suite (`abcdef…`, `123456…`). */
function suiteManifeste(valeur) {
  if (/^(.)\1+$/.test(valeur)) return true;
  let pas = 0;
  for (let i = 1; i < valeur.length; i++) if (Math.abs(valeur.charCodeAt(i) - valeur.charCodeAt(i - 1)) === 1) pas++;
  return pas / (valeur.length - 1) >= 0.8;
}

const ADRESSE = /^[a-z][a-z0-9+.-]*:\/\//i;
const CHEMIN = /^(?:\.{0,2}|~)\/[\w.@~-]+(?:\/[\w.@~-]+)*\/?$/;
const IDENTIFIANT_POINTE = /^[a-z]+(\.[a-z]+)+$/i;

/**
 * L'allure d'une valeur générée : au moins 20 caractères sans blanc, qui ne sont ni une adresse, ni un chemin, ni une
 * suite manifeste, ni des mots joints, et qui ont au moins trois classes de caractères ou au moins 4 bits d'entropie par
 * caractère. Une chaîne hexadécimale de 32 caractères ou plus, ou un UUID, compte comme générée : son alphabet de 16
 * signes plafonne l'entropie à 4 bits.
 */
export function estGeneree(valeur) {
  if (HEXADECIMAL.test(valeur) || UUID.test(valeur)) return true;
  if (valeur.length < LONGUEUR_GENEREE || /\s/.test(valeur)) return false;
  if (ADRESSE.test(valeur) || CHEMIN.test(valeur) || suiteManifeste(valeur) || motsDeLaValeur(valeur)) return false;
  return classesDe(valeur) >= CLASSES_GENEREES || entropieDe(valeur) >= ENTROPIE_GENEREE;
}

/** Les clés d'exemple de la documentation d'AWS (la clé d'accès finit par `EXAMPLE`, la clé secrète par `EXAMPLEKEY`) : publiées, elles n'ouvrent rien. */
const EXEMPLE_AWS = /EXAMPLE(?:KEY)?$/;

/** Ce qu'on met à la place d'un secret : vide, `YOUR_…`, `xxxx`, `<…>`, `${…}`, `changeme`, `example`… (les préfixes de l'ancienne liste). */
const REMPLACEMENT = /^(x{4,}|\*{3,}|\.{3,}|<[^>]+>|\$\{|\$[A-Za-z_]|\{\{|process\.env|votre|your|example|placeholder|change[_-]?me|replace[_-]?me|todo|tbd|none|null|undefined|empty|test|demo|lorem)/i;
/**
 * Ce qu'un développeur écrit pour dire qu'une valeur est fausse : `stub-token`, `fake_key`, `dummyPassword`, `mock123`. Le mot
 * ouvre la valeur et s'arrête là (séparateur, chiffre, majuscule du mot suivant, fin) : `mockingbird` n'en est pas un. Il ne
 * vaut qu'après l'allure générée : une valeur tirée au hasard derrière `fake_` reste une valeur tirée au hasard.
 */
const MOT_DE_REMPLACEMENT = /^(?:stub|dummy|fake|mock|sample|fixture|foobar|foo|bar|baz)(?![a-z])/;
const minusculesSeparees = (valeur) => valeur.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const normaliser = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * La valeur ne dit que ce que dit son nom (`token = 'TOKEN'`, `apiKey = 'api_key'`). Un nom de plus de `APERCU` caractères n'est pas
 * comparé : la valeur, jugée sur ses `APERCU` premiers caractères, ne peut pas le reprendre, et normaliser un identifiant de plusieurs
 * Mio coûte trois copies de la chaîne (le temps et la mémoire d'un ramasse-miettes qui n'a rien à ramasser).
 */
const reprendLeNom = (valeur, nom) => nom.length <= APERCU && normaliser(valeur) === normaliser(nom);

/**
 * Ce que la valeur d'un nom qui évoque un secret dit d'elle : `{ verdict, pourquoi, classes, entropie }`.
 * `verdict` : `generee` (critique, bloquant), `a_verifier` (majeur), `aucun` (rien, `pourquoi` dit la raison).
 * L'ordre est celui de la décision : l'allure générée d'abord, pour qu'un préfixe de remplacement (`test_…`) n'absolve pas
 * une valeur tirée au hasard ; puis le remplacement ; puis le reste.
 */
export function jugerValeur(nom, valeur) {
  const v = valeur.slice(0, APERCU);
  if (v === '') return { verdict: 'aucun', pourquoi: 'vide' };
  if (EXEMPLE_AWS.test(v)) return { verdict: 'aucun', pourquoi: 'exemple' };
  if (estGeneree(v)) return { verdict: 'generee', pourquoi: 'generee', classes: classesDe(v), entropie: Number(entropieDe(v).toFixed(2)) };
  if (REMPLACEMENT.test(v) || MOT_DE_REMPLACEMENT.test(minusculesSeparees(v))) return { verdict: 'aucun', pourquoi: 'remplacement' };
  if (reprendLeNom(v, nom)) return { verdict: 'aucun', pourquoi: 'nom' };
  if (suiteManifeste(v) && v.length >= LONGUEUR_MINIMALE) return { verdict: 'aucun', pourquoi: 'suite' };
  if (ADRESSE.test(v) || CHEMIN.test(v) || IDENTIFIANT_POINTE.test(v)) return { verdict: 'aucun', pourquoi: 'adresse' };
  if ((motsDeLaValeur(v)?.length ?? 0) >= 3) return { verdict: 'aucun', pourquoi: 'phrase' };
  if (/\s/.test(v)) return { verdict: 'aucun', pourquoi: 'blancs' };
  if (v.length < LONGUEUR_MINIMALE) return { verdict: 'aucun', pourquoi: 'court' };
  return { verdict: 'a_verifier', pourquoi: 'a_verifier', classes: classesDe(v), entropie: Number(entropieDe(v).toFixed(2)) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Les constats                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Ce qu'on montre d'une valeur : assez pour la reconnaître dans le fichier, pas pour l'employer. Quatre caractères de chaque
 * côté à partir de vingt caractères, deux de treize à dix-neuf, aucun en dessous : un mot de passe de quatorze caractères dont
 * on en montre dix est montré.
 */
export function masquer(valeur) {
  const t = String(valeur);
  const visibles = t.length >= 20 ? 4 : t.length >= 13 ? 2 : 0;
  return visibles ? `${t.slice(0, visibles)}…${t.slice(-visibles)} (${t.length} caractères)` : `*** (${t.length} caractères)`;
}

const IMPACT = "Un secret dans un dépôt public est compromis dès sa publication, et le reste après suppression du fichier : il demeure dans l'historique Git. Pour un widget, un secret est en outre livré au navigateur de chaque agent.";
const REMEDIATION = "Révoquer immédiatement le secret côté fournisseur, puis le retirer de l'historique. Un widget est du code exécuté côté client : il ne peut pas détenir de secret. Toute opération nécessitant un secret doit passer par un service tiers, hors du widget.";
const REFERENTIELS = ["ANSSI — Guide d'hygiène informatique", 'CWE-798', 'OWASP Top 10 A07:2021'];

function constatDeFormat(f, index, { format, valeur }) {
  const base = { regle: 'C-SECRET-01', axe: 'C', fichier: f.chemin, ligne: numeroLigne(f.contenu, index), extrait: format.extrait ? format.extrait(valeur) : masquer(valeur), referentiels: ['CWE-798'] };
  if (format.publique) {
    return constat({
      ...base, severite: 'info', confiance: 'certain',
      titre: `Clé publique par conception dans le code (${format.libelle})`,
      constat: `Une valeur au format d'une ${format.libelle} est présente. Son fournisseur la publie pour être embarquée dans une page : ce n'est pas un secret, et elle donne accès au quota et aux droits de son compte.`,
      impact: "Quiconque ouvre le widget lit la clé et peut l'employer depuis un autre site : sa seule protection est la restriction que le fournisseur lui applique (domaines autorisés, API permises, plafond de facturation), jamais son secret.",
      remediation: "Vérifier chez le fournisseur que la clé est restreinte aux domaines du widget et aux seules API qu'il appelle, et que son quota est plafonné.",
      preuve: { forme: 'fournisseur', fournisseur: format.id, publique: true, longueur: valeur.length },
    });
  }
  return constat({
    ...base, severite: 'critique', bloquant: true, confiance: 'probable', referentiels: REFERENTIELS,
    titre: `Secret potentiel versionné dans le dépôt (${format.libelle})`,
    constat: `Une valeur correspondant au format d'un ${format.libelle} est présente dans un fichier versionné.`,
    impact: IMPACT, remediation: REMEDIATION,
    preuve: { forme: 'fournisseur', fournisseur: format.id, publique: false, longueur: valeur.length },
  });
}

const POURQUOI = {
  generee: (j) => `${j.classes} classes de caractères, ${j.entropie} bits d'entropie par caractère : l'allure d'une valeur tirée au hasard, non d'un mot ou d'une phrase`,
};

function constatDeNomValeur(f, ligne, forme, nomLu, valeur, jugement) {
  const generee = jugement.verdict === 'generee';
  // Un identifiant de plusieurs Mio ne se recopie pas dans chaque texte du constat : on en garde la fin, où est le mot qui a décidé.
  const nom = nomLu.length > LONGUEUR_DE_NOM ? `…${nomLu.slice(-LONGUEUR_DE_NOM)}` : nomLu;
  const base = {
    regle: 'C-SECRET-01', axe: 'C', fichier: f.chemin, ligne, extrait: `${nom} = ${masquer(valeur)}`,
    preuve: { forme, nom, longueur: valeur.length, classes: jugement.classes, entropie: jugement.entropie },
  };
  if (generee) {
    return constat({
      ...base, severite: 'critique', bloquant: true, confiance: 'probable', referentiels: REFERENTIELS,
      titre: `Secret potentiel versionné dans le dépôt (valeur d'allure générée dans « ${nom} »)`,
      constat: `« ${nom} » reçoit un littéral de ${valeur.length} caractères qui a l'allure d'une valeur générée (${POURQUOI.generee(jugement)}).`,
      impact: IMPACT, remediation: REMEDIATION,
    });
  }
  return constat({
    ...base, severite: 'majeur', confiance: 'a_verifier', referentiels: REFERENTIELS,
    titre: `Valeur en dur dans « ${nom} » : un secret ou un exemple ? (à vérifier)`,
    constat: `« ${nom} » reçoit un littéral de ${valeur.length} caractères qui n'a pas l'allure d'une valeur générée, ni d'un texte de remplacement (vide, YOUR_…, changeme…) : un mot de passe ou une clé choisis à la main le sont aussi.`,
    impact: "Si la valeur est réelle, c'est un secret versionné : il est lisible par quiconque voit le dépôt et par le navigateur de chaque agent. Si c'est un exemple, il invite à copier le même schéma avec une vraie valeur.",
    remediation: "Retirer la valeur du dépôt. Un widget est du code exécuté côté client : il ne peut pas détenir de secret. S'il s'agit d'un exemple, l'écrire comme tel (`YOUR_API_KEY`).",
  });
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Où chercher                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Un nom qui évoque un secret, où que ce soit dans un texte : le filtre qui évite de lire ce qui n'en parle pas. */
const MOTIF_DE_SECRET = /secret|token|passw(?:or)?d|passphrase|mot[_-]?de[_-]?passe|api[_-]?key|(?:private|access|auth|master|signing|encryption)[_-]?key/i;
const MOTIF_DE_SECRET_GLOBAL = new RegExp(MOTIF_DE_SECRET.source, 'gi');

const VERROUS = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const EXTENSIONS_DE_CONFIGURATION = new Set(['.json', '.yml', '.yaml', '.ini', '.properties', '.toml', '.env']);

/** `.env`, `.env.local`, `.npmrc`, `.json`, `.yml`, `.yaml`, `.ini`, `.properties`, `.toml`. Jamais une carte de sources, jamais un README. */
export function estFichierDeConfiguration(f) {
  const nom = f.chemin.split('/').pop().toLowerCase();
  return EXTENSIONS_DE_CONFIGURATION.has(f.ext) || nom === '.env' || nom.startsWith('.env.') || nom === '.npmrc';
}

const CARACTERES_DE_NOM = new Uint8Array(128);
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-') CARACTERES_DE_NOM[c.charCodeAt(0)] = 1;
const estDeNom = (texte, i) => CARACTERES_DE_NOM[texte.charCodeAt(i)] === 1;
const estBlanc = (texte, i) => texte.charCodeAt(i) <= 32;

/** `abc,` `abc}}` `[abc]` : ce qui ferme la ligne ou l'objet qui porte la valeur n'en fait pas partie. À la main : `/[,;}\]]+$/` relit une suite de virgules à chaque départ. Avant le premier caractère, `texte[-1]` vaut `undefined`, que `includes` ne trouve pas : la boucle s'arrête. */
function sansPonctuationFinale(texte) {
  let fin = texte.length;
  while (',;}]'.includes(texte[fin - 1])) fin--;
  return texte.slice(0, fin);
}

/**
 * Les « nom = valeur » d'un fichier de configuration (`KEY=valeur`, `"clé": "valeur"`, `clé: valeur`, `clé = "valeur"`) :
 * `{ index, nom, valeur }`, rendus un à un (un fichier de plusieurs Mio peut en porter des millions, et la règle n'a pas à les
 * garder). Chaque occurrence d'un mot de secret est prise comme centre d'un nom, que l'on étend à la main
 * de quelques dizaines de caractères de chaque côté, puis on lit l'affectation qui le suit : le travail de chaque
 * occurrence est borné, donc le total est linéaire, quelle que soit la longueur de la ligne (un JSON minifié tient sur une
 * seule). Une expression régulière à nom libre ferait relire la suite entière à chaque départ.
 */
export function* affectationsDeConfiguration(texte) {
  let dernierFin = -1;
  for (const m of texte.matchAll(MOTIF_DE_SECRET_GLOBAL)) {
    if (m.index < dernierFin) continue;
    let debut = m.index;
    while (m.index - debut < LONGUEUR_DE_NOM && estDeNom(texte, debut - 1)) debut--;
    let fin = m.index + m[0].length;
    while (fin - m.index < LONGUEUR_DE_NOM && estDeNom(texte, fin)) fin++;
    dernierFin = fin;
    const nom = texte.slice(debut, fin);
    if (!nomEvoqueUnSecret(nom)) continue;
    let i = fin;
    if (texte[i] === '"' || texte[i] === "'") i++;
    while (texte[i] === ' ' || texte[i] === '\t') i++;
    if (texte[i] !== ':' && texte[i] !== '=') continue;
    i++;
    while (texte[i] === ' ' || texte[i] === '\t') i++;
    const guillemet = texte[i];
    let valeur;
    if (guillemet === '"' || guillemet === "'" || guillemet === '`') {
      let j = i + 1;
      while (j - i <= LONGUEUR_DE_VALEUR && texte[j] !== guillemet && texte[j] !== '\n') j++;
      if (texte[j] !== guillemet) continue;
      valeur = texte.slice(i + 1, j);
      dernierFin = j;
    } else {
      let j = i;
      while (j - i < LONGUEUR_DE_VALEUR && !estBlanc(texte, j)) j++;
      valeur = sansPonctuationFinale(texte.slice(i, j));
      dernierFin = j;
    }
    yield { index: m.index, nom, valeur };
  }
}

/**
 * Le nom qu'une clé de propriété, de champ ou de membre donne à ce qu'il reçoit : son identifiant (`apiKey`), ou son texte quand c'est une chaîne
 * (`'api-key'`). Une clé calculée par une variable ou un calcul (`[apiKey]`, `config[token]`) n'a pas de nom lisible : `null`.
 */
function nomDeCle(cle, calculee) {
  if (cle.type === 'Literal') return String(cle.value);
  return calculee ? null : cle.name;
}
/** Le nom de ce que reçoit une affectation : un identifiant (`token = …`) ou un membre (`config.token = …`, `config['api-key'] = …`). */
function nomDeMembre(noeud) {
  if (noeud.type === 'Identifier') return noeud.name;
  return noeud.type === 'MemberExpression' ? nomDeCle(noeud.property, noeud.computed) : null;
}

/**
 * Chaque affectation d'un littéral à un nom : déclaration (`const apiKey = '…'`), propriété (`{ apiKey: '…' }`, clé
 * identifiant ou chaîne), affectation (`config.token = '…'`), valeur par défaut (`(token = '…') =>`), champ de classe. Ce
 * qui est dans une chaîne (le message d'erreur qui cite `token: 'ma-cle'`) n'est pas une affectation : il n'est pas dans
 * l'arbre.
 */
function affectationsDeCode(ast, walk) {
  const trouvees = [];
  // `nom` est `undefined` ou `null` quand l'arbre ne donne pas de nom lisible (un motif de déstructuration, une clé calculée) : `nomEvoqueUnSecret` dit non.
  const voir = (noeud, nom, valeur) => {
    if (!nomEvoqueUnSecret(nom)) return;
    const texte = chaineLitterale(valeur);
    if (texte !== null) trouvees.push({ noeud, nom, valeur: texte });
  };
  walk.simple(ast, {
    VariableDeclarator(n) { voir(n, n.id.name, n.init); },
    Property(n) { voir(n, nomDeCle(n.key, n.computed), n.value); },
    AssignmentExpression(n) { if (n.operator === '=') voir(n, nomDeMembre(n.left), n.right); },
    AssignmentPattern(n) { voir(n, n.left.name, n.right); },
    PropertyDefinition(n) { voir(n, nomDeCle(n.key, n.computed), n.value); },
  });
  return trouvees;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* La règle                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export function analyserSecrets(ctx) {
  const parChemin = new Map(ctx.fichiers.map((f) => [f.chemin, f]));
  const trouvailles = new Map();
  // `decalage` : la place de la trouvaille dans le fichier, pour que deux constats d'une même ligne sortent dans l'ordre du fichier.
  const noter = (f, ligne, decalage, c) => {
    if (!trouvailles.has(f)) trouvailles.set(f, []);
    trouvailles.get(f).push({ ligne, decalage, c });
  };
  const aLire = [];

  for (const f of ctx.fichiers) {
    if (f.binaire || !f.contenu || VERROUS.test(f.chemin)) continue;

    // 1. Les formats de fournisseur, dans tout texte.
    for (const trouve of formatsDans(f.contenu)) {
      // Un fichier synthétique (`litteralImbrique`) qui reproduit TEXTUELLEMENT un secret déjà visible dans son fichier
      // d'origine (un littéral direct, non obfusqué) ne le compte pas une deuxième fois.
      if (f.litteralImbrique && f.origineReelle && parChemin.get(f.origineReelle.chemin)?.contenu?.includes(trouve.valeur)) continue;
      noter(f, numeroLigne(f.contenu, trouve.index), trouve.index, constatDeFormat(f, trouve.index, trouve));
    }

    // 2. « nom = valeur » : en configuration, ligne à ligne ; en JS, par l'arbre (plus bas).
    if (estFichierDeConfiguration(f)) {
      for (const { index, nom, valeur } of affectationsDeConfiguration(f.contenu)) {
        const jugement = jugerValeur(nom, valeur);
        if (jugement.verdict === 'aucun' || formatsDans(valeur).length) continue; // rien à dire, ou dit par le format
        const ligne = numeroLigne(f.contenu, index);
        noter(f, ligne, index, constatDeNomValeur(f, ligne, 'configuration', nom, valeur, jugement));
      }
    }
    if (MOTIF_DE_SECRET.test(f.contenu)) aLire.push(f);
  }

  // Seuls les fichiers qui parlent d'un secret (un mot de secret dans le texte) sont lus par l'arbre : c'est le même résultat,
  // sans relire les autres. Les lectures refusées se disent là où les autres règles les disent (`releverDans`).
  pourChaqueUniteJs({ fichiers: aLire }, { releverDans: ctx }, ({ ast, walk, ligneDe, fichier, unite }) => {
    for (const { noeud, nom, valeur } of affectationsDeCode(ast, walk)) {
      const jugement = jugerValeur(nom, valeur);
      if (jugement.verdict === 'aucun' || formatsDans(valeur).length) continue; // rien à dire, ou dit par le format
      const ligne = ligneDe(noeud);
      // Dans un script de page, `debut` est celui de la balise : le décalage est approché (la longueur de la balise ouvrante près), il suffit à ranger deux trouvailles d'une même ligne.
      const decalage = unite.inline ? unite.debut + noeud.start : noeud.start;
      noter(fichier, ligne, decalage, constatDeNomValeur(fichier, ligne, 'code', nom, valeur, jugement));
    }
  });

  const constats = [];
  for (const f of ctx.fichiers) {
    const liste = trouvailles.get(f);
    if (!liste) continue;
    liste.sort((a, b) => a.ligne - b.ligne || a.decalage - b.decalage);
    for (const { c } of liste) constats.push(c);
  }
  return constats;
}
