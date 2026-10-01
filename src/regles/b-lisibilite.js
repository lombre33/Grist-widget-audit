/**
 * Axe B — Lisibilité et maintenabilité par un humain.
 *
 * C'est l'axe le plus spécifique au guide Grist.Gouv, qui pose une exigence
 * inhabituelle : « le code doit être lisible par un développeur humain sans
 * avoir besoin d'un outil d'IA pour le comprendre », et met explicitement en
 * garde contre la verbosité typique du code généré.
 *
 * On ne peut pas mesurer « la compréhension ». On mesure donc ses conditions :
 * des noms qui portent du sens, une documentation d'entrée, une densité de
 * commentaires cohérente avec la complexité, et l'absence des marqueurs qui
 * signalent une production non relue.
 */
import path from 'node:path';
import { constat } from '../moteur/modele.js';
import { pourChaqueUniteJs } from '../moteur/analyse-js.js';
import { numeroLigne } from '../moteur/lignes.js';
import { mesurerLignes, NOTE_LIGNES_APPROCHEES } from '../moteur/lignes-de-code.js';

const REF_GUIDE_LISIBILITE = 'Guide de contribution Grist.Gouv — « The code is readable by a human developer without needing an AI tool to understand it »';

/** Noms d'identifiants non descriptifs. */
const NOMS_PAUVRES = /^(a|b|c|d|e|f|x|y|z|i2|tmp|temp|val|val2|data\d?|obj|arr|foo|bar|baz|res2|ret|thing|stuff|truc|machin|toto)$/;
const TOLERES_BOUCLE = /^(i|j|k|n|e|x|y|_)$/;

export function analyserNommage(ctx) {
  const constats = [];
  const pauvres = [];

  pourChaqueUniteJs(ctx, { surfaceSeulement: true, ignorerVendorise: true }, ({ ast, ligneDe, walk, unite }) => {
    if (!ast) return;
    walk.simple(ast, {
      VariableDeclarator(n) {
        if (n.id.type !== 'Identifier') return;
        if (!NOMS_PAUVRES.test(n.id.name)) return;
        if (TOLERES_BOUCLE.test(n.id.name)) return;
        pauvres.push({ fichier: unite.chemin, ligne: ligneDe(n), nom: n.id.name });
      },
      FunctionDeclaration(n) {
        if (n.id && n.id.name.length <= 2) pauvres.push({ fichier: unite.chemin, ligne: ligneDe(n), nom: n.id.name });
      },
    });
  });

  if (pauvres.length > 3) {
    constats.push(constat({
      regle: 'B-NOM-01', axe: 'B', severite: 'mineur', confiance: 'probable',
      titre: `${pauvres.length} identifiants au nom non descriptif`,
      fichier: pauvres[0].fichier, ligne: pauvres[0].ligne,
      constat: `Noms relevés : ${[...new Set(pauvres.map((p) => p.nom))].slice(0, 10).join(', ')}.`,
      impact: "Le guide demande des noms « explicites et descriptifs ». Un nom comme `data` ou `tmp` oblige le relecteur à remonter la chaîne d'affectations pour savoir ce que la variable contient.",
      remediation: 'Renommer en décrivant le contenu, pas le type : `lignesSelectionnees` plutôt que `data`.',
      referentiels: [REF_GUIDE_LISIBILITE],
      preuve: { emplacements: pauvres },
    }));
  }
  return constats;
}

/**
 * Le nom d'un README à la racine d'un dépôt : `README` ou `LISEZMOI` (`LISEZ-MOI`, `LISEZ_MOI`), une langue facultative (deux lettres : `.fr`, `_en`,
 * `-fr-CA` ; trois lettres seulement avant une extension : `README.fra.md`, car `README.png` n'est pas le README « png »), une extension de texte
 * facultative (`.md`, `.rst`, `.adoc`, `.txt`…). `README.fr.md` est le README d'un widget français : le prendre pour l'absence de README ferait
 * lever un bloquant sur un dépôt qui en a un. Le motif est ancré aux deux bouts et n'accepte aucun séparateur de dossier : `docs/README.md` n'est
 * pas le README du dépôt (le guide le veut à la racine).
 */
const NOM_DE_README = /^(?:readme|lisez[-_]?moi)(?:[._-](?:[a-z]{2}|[a-z]{3}(?=\.))(?:[-_][a-z0-9]{2,8})?)?(?:\.(?:md|mdx|markdown|mdown|mkd|txt|text|rst|adoc|asciidoc|org|textile|html?))?$/i;

/** `README.md` d'abord (le nom que le guide demande), puis les autres dans l'ordre des codes de leurs noms : le constat cite toujours le même fichier. */
const rangDeReadme = (f) => (f.chemin.toLowerCase() === 'readme.md' ? 0 : 1);

/** README : présence et couverture des trois points exigés par le guide. */
export function analyserReadme(ctx) {
  const constats = [];
  const readmes = ctx.fichiers
    .filter((f) => NOM_DE_README.test(f.chemin))
    .sort((a, b) => rangDeReadme(a) - rangDeReadme(b) || (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0));

  if (!readmes.length) {
    constats.push(constat({
      regle: 'B-DOC-01', axe: 'B', severite: 'majeur', bloquant: true, confiance: 'certain',
      titre: 'Aucun README à la racine du dépôt',
      constat: "Le dépôt ne contient pas de fichier README à sa racine.",
      impact: "Le guide en fait une exigence de recevabilité : sans README, personne ne peut savoir ce que fait le widget, comment le configurer, ni de quoi il dépend. La contribution est irrecevable en l'état.",
      remediation: "Créer un `README.md` décrivant : ce que fait le widget, comment le configurer dans Grist (niveau d'accès demandé, colonnes attendues), et ses dépendances.",
      referentiels: ['Guide de contribution Grist.Gouv — « A README.md file accompanies the widget »'],
    }));
    return constats;
  }

  // Les rubriques se cherchent dans tous les README de la racine (`README.md` et `README.fr.md` : une information dite dans l'un est dite). Un README
  // dont aucun texte n'est lu (un fichier trop gros, le plafond de lecture cumulé atteint, une lecture refusée) est reconnu comme présent, mais son contenu
  // n'est pas jugé : lire `undefined` faisait échouer toute l'analyse, sans rapport.
  const lisibles = readmes.filter((f) => typeof f.contenu === 'string');
  if (!lisibles.length) return constats;
  const readme = lisibles[0];
  const texte = lisibles.map((f) => f.contenu).join('\n').toLowerCase();
  const attendus = [
    // `[^\S\n]*` et non `\s*` : un début de ligne suivi d'un mot de rubrique, sans que le blanc franchisse la
    // fin de ligne. Le résultat est le même (la dernière fin de ligne d'une suite de blancs est un départ qui
    // convient), mais `\s*` relisait toute la suite de lignes vides depuis chacune : quadratique.
    // Un titre se marque par `#` (Markdown), `=` (AsciiDoc, reStructuredText), `*` (Org) ou n'est que le début d'une ligne.
    { cle: 'role', libelle: 'ce que fait le widget', motifs: /(^|#|=|\*|\n)[^\S\n]*(à quoi|a quoi|description|présentation|presentation|what|objectif|fonctionnalit|usage|utilisation)/i },
    { cle: 'config', libelle: 'comment le configurer', motifs: /(configur|installation|install|paramétr|parametr|mise en place|setup|requiredaccess|niveau d'accès|colonnes)/i },
    { cle: 'deps', libelle: 'ses dépendances', motifs: /(dépendance|dependance|dependenc|prérequis|prerequis|requirements|librairie|bibliothèque|aucune dépendance)/i },
  ];
  const manquants = attendus.filter((a) => !a.motifs.test(texte));

  if (manquants.length) {
    constats.push(constat({
      regle: 'B-DOC-02', axe: 'B', severite: 'mineur', confiance: 'probable',
      titre: `README incomplet : ${manquants.map((m) => m.libelle).join(', ')}`,
      fichier: readme.chemin,
      constat: `Le guide impose trois rubriques ; ${manquants.length} ne sont pas repérées : ${manquants.map((m) => m.libelle).join(', ')}.`,
      impact: "La rubrique « configuration » est celle que l'équipe Grist.Gouv lit en premier : c'est là que doit figurer le niveau d'accès demandé au document et sa justification.",
      remediation: 'Ajouter les rubriques manquantes, même brèves. « Aucune dépendance externe » est une réponse valable et utile.',
      referentiels: ['Guide de contribution Grist.Gouv — section Readability and maintainability'],
    }));
  }

  // Le niveau d'accès demandé doit être documenté : c'est le point de contrôle
  // du relecteur sécurité, et l'agent doit savoir ce qu'il accorde.
  const acces = ctx.usagesGrist?.acces?.[0]?.niveau;
  if (acces && !/requiredaccess|niveau d'accès|acc[eè]s (complet|full|lecture)|read table|full/i.test(texte)) {
    constats.push(constat({
      regle: 'B-DOC-03', axe: 'B', severite: 'majeur', confiance: 'certain',
      titre: `Le niveau d'accès \`${acces}\` demandé au document n'est pas documenté dans le README`,
      fichier: readme.chemin,
      constat: `Le code demande \`requiredAccess: '${acces}'\` mais le README n'explique nulle part ce que le widget fait de cet accès.`,
      impact: "L'agent qui installe le widget voit passer une demande d'accès sans pouvoir la justifier, et le relecteur sécurité doit reconstruire l'information depuis le code. C'est le premier motif de renvoi d'une contribution.",
      remediation: `Ajouter une rubrique « Accès au document » indiquant : le niveau demandé (\`${acces}\`), les tables lues, les tables écrites, et pourquoi un niveau inférieur ne suffit pas.`,
      referentiels: ['Guide de contribution Grist.Gouv — Code review process / Security'],
    }));
  }

  // Le guide l'interdit explicitement : « Safe: no requests to undocumented
  // external services ». L'axe C relève les hôtes externes réellement
  // contactés (ctx.destinationsExternes) ; on vérifie ici qu'ils sont au
  // moins nommés dans le README, sans juger si la justification est bonne.
  const destinations = [...(ctx.destinationsExternes ?? [])];
  const nonDocumentees = destinations.filter((h) => !texte.includes(h.toLowerCase()));
  if (nonDocumentees.length) {
    constats.push(constat({
      regle: 'B-DOC-04', axe: 'B', severite: 'majeur', confiance: 'certain',
      titre: `Service(s) externe(s) contacté(s) sans mention dans le README (${nonDocumentees.join(', ')})`,
      fichier: readme.chemin,
      constat: `Le code contacte ${nonDocumentees.length} hôte(s) externe(s) qu'aucun passage du README ne nomme : ${nonDocumentees.join(', ')}.`,
      impact: "Sans cette mention, ni l'agent qui installe le widget ni le relecteur sécurité ne peuvent savoir que ce flux existe sans lire tout le code source.",
      remediation: `Ajouter au README, pour chacun, ce qui lui est envoyé et pourquoi : ${nonDocumentees.join(', ')}.`,
      referentiels: ['Guide de contribution Grist.Gouv — « Safe: no requests to undocumented external services »'],
      preuve: { hotes: nonDocumentees },
    }));
  }
  return constats;
}

/** Densité de commentaires rapportée à la complexité du fichier : les lignes de commentaire seul pour les lignes de code (voir `mesurerLignes`). */
export function analyserCommentaires(ctx) {
  const constats = [];
  for (const f of ctx.fichiers) {
    if (!f.executee || f.vendorise || f.dossierExclu || !['.js', '.mjs'].includes(f.ext) || !f.contenu) continue;
    const { code, commentaire, exacte } = mesurerLignes(f);
    if (code < 200) continue;

    const densite = commentaire / Math.max(1, code);
    if (densite >= 0.04) continue;

    constats.push(constat({
      regle: 'B-COM-01', axe: 'B', severite: 'mineur', confiance: 'probable',
      titre: `Fichier de ${code} lignes quasiment sans commentaire : ${f.chemin}`,
      fichier: f.chemin,
      constat: `${commentaire} ligne(s) de commentaire pour ${code} lignes de code (${Math.round(densite * 100)} %).${exacte ? '' : NOTE_LIGNES_APPROCHEES}`,
      impact: "Sur un fichier de cette taille, l'absence de commentaire oblige le relecteur à reconstituer l'intention à partir du code seul — exactement ce que le guide cherche à éviter.",
      remediation: "Documenter l'intention, pas la mécanique : pourquoi ce traitement existe, quels cas limites il couvre, quelles hypothèses il fait sur les données Grist.",
      referentiels: [REF_GUIDE_LISIBILITE],
    }));
  }
  return constats;
}

/**
 * Un blanc qui ne franchit pas une fin de ligne : `\s` moins \n, \r, U+2028 et U+2029
 * (donc l'espace insécable et la marque d'ordre des octets, que `[ \t]` ne couvre pas).
 * `\s*` traversait les fins de ligne : `^\s*` courait d'une ligne vide à la suivante
 * (temps quadratique sur un fichier de lignes vides) et un `//` de fin de ligne se
 * rattachait au texte de la ligne d'après (un constat qu'aucune ligne ne contient).
 */
const BLANC = '[^\\S\\r\\n\\u2028\\u2029]';

/** Le nombre d'occurrences d'un motif dans un contenu et l'indice de la première (`-1` s'il n'y en a pas). */
const compter = (re) => (contenu) => {
  let n = 0;
  let premier = -1;
  for (const m of contenu.matchAll(re)) if (n++ === 0) premier = m.index;
  return { n, premier };
};

/** Écart maximal, en caractères, entre l'ouverture `/**` et `@param`, et longueur maximale du type entre accolades, d'un JSDoc générique. */
const PORTEE_JSDOC = 200;
const PARAM_GENERIQUE = new RegExp(`@param\\s+\\{[^}]{0,${PORTEE_JSDOC}}\\}\\s+\\w+\\s+-\\s+The\\s`, 'gi');

/**
 * Les JSDoc génériques en anglais : un `@param {type} nom - The …` dans les 200
 * caractères qui suivent l'ouverture `/**` d'un commentaire, un seul par commentaire
 * (le texte d'une occurrence est consommé : le `@param` suivant du même commentaire ne
 * compte pas). On cherche le `@param` d'abord, puis l'ouverture dans la fenêtre qui le
 * précède : partir de chaque `/**` et laisser un quantificateur paresseux chercher plus
 * loin relisait la même fenêtre pour chacune (quadratique sur `/** @param {` répété).
 */
function jsdocGeneriques(contenu) {
  let n = 0;
  let premier = -1;
  let fin = 0;
  for (const m of contenu.matchAll(PARAM_GENERIQUE)) {
    const debutFenetre = Math.max(fin, m.index - PORTEE_JSDOC - 3);
    const ouverture = contenu.slice(debutFenetre, m.index).indexOf('/**');
    if (ouverture === -1) continue;
    if (n++ === 0) premier = debutFenetre + ouverture;
    fin = m.index + m[0].length;
  }
  return { n, premier };
}

const MOTIFS_GENERATION = [
  [compter(new RegExp(`^${BLANC}*//${BLANC}*(Step|Étape|Etape)${BLANC}*\\d+${BLANC}*[:\\-]`, 'gim')), 'commentaires numérotés « Étape N »'],
  [compter(/\b(As an AI|I'm an AI|En tant qu'(IA|assistant)|Voici le code|Here's the (code|implementation)|Note: This (code|implementation))\b/gi), "formules d'assistant conversationnel"],
  [compter(new RegExp(`^${BLANC}*\`\`\``, 'gm')), 'délimiteurs de bloc de code Markdown laissés dans un fichier source'],
  [compter(new RegExp(`//${BLANC}*(Ajout|Added|Modification|Changed|Suppression|Removed) (de|du|of|the) `, 'gi')), 'commentaires de journal de modification dans le code'],
  [jsdocGeneriques, 'JSDoc générique en anglais dans un code par ailleurs francophone'],
  [compter(new RegExp(`//${BLANC}*(Vérifier si|Check if|Boucle sur|Loop through|Retourne|Returns) (le|la|les|the)?${BLANC}*\\w+${BLANC}*$`, 'gim')), 'commentaires paraphrasant la ligne suivante'],
];

/**
 * Marqueurs de production générée sans relecture.
 *
 * Aucun de ces signaux ne prouve quoi que ce soit isolément — un développeur
 * humain écrit aussi « Étape 1 ». C'est leur accumulation qui est parlante, et
 * le constat est formulé comme une question à poser au contributeur, pas comme
 * une accusation : le guide autorise l'usage de l'IA, il interdit le dépôt
 * de sortie non relue.
 */
export function analyserSignauxGeneration(ctx) {
  const constats = [];
  const signaux = [];

  for (const f of ctx.fichiers) {
    if (!f.contenu || f.binaire || f.vendorise || f.dossierExclu || !['.js', '.mjs', '.html'].includes(f.ext)) continue;
    if (f.chemin.endsWith('.md')) continue;
    for (const [trouver, libelle] of MOTIFS_GENERATION) {
      const { n, premier } = trouver(f.contenu);
      if (n > 0) signaux.push({ fichier: f.chemin, libelle, occurrences: n, ligne: numeroLigne(f.contenu, premier) });
    }
  }

  const total = signaux.reduce((s, x) => s + x.occurrences, 0);
  const familles = new Set(signaux.map((s) => s.libelle));

  if (familles.size >= 2 && total >= 8) {
    constats.push(constat({
      regle: 'B-IA-01', axe: 'B', severite: 'mineur', confiance: 'a_verifier',
      titre: 'Marqueurs évoquant du code généré puis peu retouché',
      fichier: signaux[0].fichier, ligne: signaux[0].ligne,
      constat: `${total} occurrence(s) réparties sur ${familles.size} familles de marqueurs : ${[...familles].join(' ; ')}.`,
      impact: "Le guide autorise explicitement l'aide d'un outil d'IA, mais refuse la sortie brute non relue, et demande que le contributeur puisse défendre chaque partie du code en revue. Ces marqueurs sont le signal que le relecteur regardera en priorité.",
      remediation: "Relire les fichiers concernés : supprimer les commentaires qui paraphrasent le code, garder ceux qui expliquent une intention. Aucun de ces signaux n'est disqualifiant en soi ; ce sont les endroits où la relecture humaine doit être démontrable.",
      referentiels: ['Guide de contribution Grist.Gouv — « A note on AI-generated contributions »'],
      preuve: { signaux },
    }));
  }
  return constats;
}

/** Verbosité : le code est-il lisible « en une seule fois » ? */
export function analyserVerbosite(ctx) {
  const constats = [];
  const surface = ctx.fichiers.filter((f) => f.executee && !f.vendorise && !f.dossierExclu && ['.js', '.mjs'].includes(f.ext));
  const loc = surface.reduce((s, f) => s + (f.contenu ? mesurerLignes(f).code : 0), 0);
  const html = ctx.fichiers.filter((f) => f.executee && ['.html', '.htm'].includes(f.ext))
    .reduce((s, f) => s + (f.locSignificatives ?? 0), 0);

  const seuil = 4000;
  if (loc + html > seuil) {
    constats.push(constat({
      regle: 'B-VERB-01', axe: 'B', severite: loc + html > 12000 ? 'majeur' : 'mineur', confiance: 'certain',
      titre: `${loc + html} lignes de code exécuté : le widget dépasse ce qu'une revue bénévole absorbe`,
      constat: `${surface.length} fichier(s) JavaScript pour ${loc} lignes de code, plus ${html} lignes de HTML.`,
      impact: "Le guide demande un périmètre fonctionnel « clairement défini et raisonnablement étroit », et prévient : « si votre widget semble faire plusieurs métiers différents, envisagez de le découper ». Un volume de cet ordre allonge la revue de plusieurs jours et réduit mécaniquement la profondeur de l'examen sécurité.",
      remediation: "Deux voies : réduire le périmètre fonctionnel, ou découper en plusieurs widgets partageant un module commun. À défaut, fournir dans le README une carte du code (quel fichier fait quoi, par où commencer) pour guider le relecteur.",
      referentiels: ['Guide de contribution Grist.Gouv — « clearly defined and reasonably narrow functional scope »'],
    }));
  }
  return constats;
}

/** Cohérence linguistique du code et des commentaires. */
export function analyserLangue(ctx) {
  const constats = [];
  let fr = 0, en = 0;
  for (const f of ctx.fichiers) {
    if (!f.executee || f.vendorise || f.dossierExclu || !['.js', '.mjs'].includes(f.ext) || !f.contenu) continue;
    for (const l of f.lignes) {
      const t = l.trim();
      if (!/^(\/\/|\*)/.test(t) || t.length < 20) continue;
      if (/\b(le|la|les|des|une|est|pour|dans|avec|sur|par|qui|que|sont|cette|afin|donc)\b/i.test(t)) fr++;
      else if (/\b(the|and|for|with|this|that|from|when|which|should|will|does)\b/i.test(t)) en++;
    }
  }
  const total = fr + en;
  if (total > 25 && Math.min(fr, en) / total > 0.25) {
    constats.push(constat({
      regle: 'B-LANG-01', axe: 'B', severite: 'mineur', confiance: 'probable',
      titre: 'Commentaires rédigés dans deux langues',
      constat: `${fr} ligne(s) de commentaire en français, ${en} en anglais.`,
      impact: "Le mélange ralentit la lecture et signale souvent des strates de code d'origines différentes, dont certaines n'ont pas été relues.",
      remediation: "Choisir une langue et s'y tenir. Le guide accepte les deux, y compris pour les messages de commit.",
      referentiels: ['Guide de contribution Grist.Gouv — Conventions'],
    }));
  }
  return constats;
}

export const reglesB = [
  analyserNommage, analyserReadme, analyserCommentaires,
  analyserSignauxGeneration, analyserVerbosite, analyserLangue,
];
