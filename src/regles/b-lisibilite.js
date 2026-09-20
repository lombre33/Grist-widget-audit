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
      preuve: { emplacements: pauvres.slice(0, 25) },
    }));
  }
  return constats;
}

/** README : présence et couverture des trois points exigés par le guide. */
export function analyserReadme(ctx) {
  const constats = [];
  const readme = ctx.fichiers.find((f) => /^readme(\.md|\.txt)?$/i.test(path.basename(f.chemin)) && !f.chemin.includes(path.sep));

  if (!readme) {
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

  const texte = readme.contenu.toLowerCase();
  const attendus = [
    { cle: 'role', libelle: 'ce que fait le widget', motifs: /(#|\n)\s*(à quoi|a quoi|description|présentation|presentation|what|objectif|fonctionnalit|usage|utilisation)/i },
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
    }));
  }
  return constats;
}

/** Densité de commentaires rapportée à la complexité du fichier. */
export function analyserCommentaires(ctx) {
  const constats = [];
  for (const f of ctx.fichiers) {
    if (!f.executee || f.vendorise || !['.js', '.mjs'].includes(f.ext) || !f.contenu) continue;
    if ((f.locSignificatives ?? 0) < 200) continue;

    const lignesCommentees = f.lignes.filter((l) => /^\s*(\/\/|\/\*|\*)/.test(l)).length;
    const densite = lignesCommentees / Math.max(1, f.locSignificatives);
    if (densite >= 0.04) continue;

    constats.push(constat({
      regle: 'B-COM-01', axe: 'B', severite: 'mineur', confiance: 'probable',
      titre: `Fichier de ${f.locSignificatives} lignes quasiment sans commentaire : ${f.chemin}`,
      fichier: f.chemin,
      constat: `${lignesCommentees} ligne(s) de commentaire pour ${f.locSignificatives} lignes de code (${Math.round(densite * 100)} %).`,
      impact: "Sur un fichier de cette taille, l'absence de commentaire oblige le relecteur à reconstituer l'intention à partir du code seul — exactement ce que le guide cherche à éviter.",
      remediation: "Documenter l'intention, pas la mécanique : pourquoi ce traitement existe, quels cas limites il couvre, quelles hypothèses il fait sur les données Grist.",
      referentiels: [REF_GUIDE_LISIBILITE],
    }));
  }
  return constats;
}

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

  const motifs = [
    [/^\s*\/\/\s*(Step|Étape|Etape)\s*\d+\s*[:\-]/gim, 'commentaires numérotés « Étape N »'],
    [/\b(As an AI|I'm an AI|En tant qu'(IA|assistant)|Voici le code|Here's the (code|implementation)|Note: This (code|implementation))\b/gi, "formules d'assistant conversationnel"],
    [/^\s*```/gm, 'délimiteurs de bloc de code Markdown laissés dans un fichier source'],
    [/\/\/\s*(Ajout|Added|Modification|Changed|Suppression|Removed) (de|du|of|the) /gi, 'commentaires de journal de modification dans le code'],
    [/\/\*\*[\s\S]{0,200}?@param\s+\{[^}]*\}\s+\w+\s+-\s+The\s/gi, 'JSDoc générique en anglais dans un code par ailleurs francophone'],
    [/\/\/\s*(Vérifier si|Check if|Boucle sur|Loop through|Retourne|Returns) (le|la|les|the)?\s*\w+\s*$/gim, 'commentaires paraphrasant la ligne suivante'],
  ];

  for (const f of ctx.fichiers) {
    if (!f.contenu || f.binaire || f.vendorise || !['.js', '.mjs', '.html'].includes(f.ext)) continue;
    if (f.chemin.endsWith('.md')) continue;
    for (const [re, libelle] of motifs) {
      const occurrences = [...f.contenu.matchAll(re)];
      if (occurrences.length) {
        signaux.push({
          fichier: f.chemin, libelle, occurrences: occurrences.length,
          ligne: f.contenu.slice(0, occurrences[0].index).split('\n').length,
        });
      }
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
      preuve: { signaux: signaux.slice(0, 20) },
    }));
  }
  return constats;
}

/** Verbosité : le code est-il lisible « en une seule fois » ? */
export function analyserVerbosite(ctx) {
  const constats = [];
  const surface = ctx.fichiers.filter((f) => f.executee && !f.vendorise && ['.js', '.mjs'].includes(f.ext));
  const loc = surface.reduce((s, f) => s + (f.locSignificatives ?? 0), 0);
  const html = ctx.fichiers.filter((f) => f.executee && ['.html', '.htm'].includes(f.ext))
    .reduce((s, f) => s + (f.locSignificatives ?? 0), 0);

  const seuil = 4000;
  if (loc + html > seuil) {
    constats.push(constat({
      regle: 'B-VERB-01', axe: 'B', severite: loc + html > 12000 ? 'majeur' : 'mineur', confiance: 'certain',
      titre: `${loc + html} lignes de code exécuté : le widget dépasse ce qu'une revue bénévole absorbe`,
      constat: `${surface.length} fichier(s) JavaScript pour ${loc} lignes significatives, plus ${html} lignes de HTML.`,
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
    if (!f.executee || f.vendorise || !['.js', '.mjs'].includes(f.ext) || !f.contenu) continue;
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
