/**
 * C-SECRET-02 : un secret retiré du code, resté dans l'historique Git.
 *
 * Retirer une clé d'un fichier ne la retire pas du dépôt : quiconque clone l'historique la lit dans le commit qui l'a introduite. Un attaquant équipé
 * d'une IA balaie l'historique des dépôts publics à la recherche de ces clés, y compris de celles que leur auteur croyait effacées.
 *
 * La règle lit les lignes AJOUTÉES de chaque commit (`git log --all -p -U0`) et y cherche les formats de fournisseur de C-SECRET-01, ceux-là seuls : un
 * format est une preuve, un « nom = valeur » ne l'est pas hors de son contexte. Une valeur encore présente dans les fichiers actuels est le constat de
 * C-SECRET-01, non de celle-ci. Une clé que son fournisseur publie pour une page (Google, Stripe, Mapbox, JWT anonyme) n'est pas un secret, ni ici ni là.
 * Le constat est un majeur non bloquant : le format dit la forme d'une clé, non qu'elle ouvre encore quelque chose. Il demande de la révoquer.
 *
 * Ce que la règle ne lit pas, elle le dit (un constat d'information, sans pénalité) : dépôt peu profond (`git clone --depth`), git qui refuse ou échoue,
 * délai ou taille dépassés (le début de l'historique, le plus récent, est lu), plafond de valeurs. Un dossier qui n'est pas un dépôt Git n'a pas
 * d'historique : rien n'est dit. L'absence de constat ne vaut jamais absence de secret dans l'historique.
 *
 * Le dépôt audité est une donnée hostile : git est lancé sans le moindre programme que sa configuration nommerait (`core.fsmonitor`, pagineur, conversion
 * de texte, programme de comparaison externe), les lignes d'un diff ne se lisent que par le décompte que l'en-tête de chaque bloc donne (une ligne ajoutée
 * qui ressemble à un en-tête n'en est pas un), et le travail est borné (temps, octets, nombre de valeurs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { constat } from '../moteur/modele.js';
import { numeroLigne } from '../moteur/lignes.js';
import { formatsDans, masquer } from './c-secrets.js';

const DELAI_DE_LECTURE = 60_000;
const OCTETS_LUS = 64 * 1024 * 1024;
const PLAFOND_DE_VALEURS = 50;
const LONGUEUR_DU_COMMIT = 12;
/** Un fichier de verrouillage porte des empreintes, non du code : il n'est pas lu. */
const VERROUS = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

/** Git ne lance rien de ce que le dépôt audité nomme dans sa configuration, ne pagine pas, ne convertit pas, ne compare pas par un programme externe. */
const OPTIONS_DE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.quotepath=false', '-c', 'log.showSignature=false'];
/** Le dépôt est celui que `-C` nomme, non celui qu'une variable de l'appelant désignerait (un lancement depuis un crochet de git en pose). */
const ENVIRONNEMENT = Object.fromEntries(Object.entries({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' })
  .filter(([nom]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_EXTERNAL_DIFF', 'GIT_NAMESPACE'].includes(nom.toUpperCase())));

function git(racine, args, options = {}) {
  return spawnSync('git', [...OPTIONS_DE_GIT, '-C', racine, ...args], { encoding: 'utf8', env: ENVIRONNEMENT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
}

/**
 * Les valeurs au format d'un fournisseur que les lignes ajoutées de la sortie de `git log -p -U0` portent : `Map(valeur → { format, fichier, ligne, commit, commits })`.
 * `fichier`, `ligne` et `commit` sont ceux de la dernière trouvaille, donc, l'historique étant lu du plus récent au plus ancien, du commit qui a introduit la valeur.
 */
export function valeursDansLeDiff(sortie, { plafond = PLAFOND_DE_VALEURS } = {}) {
  const vues = new Map();
  let plafonne = false;
  let commit = null;
  let fichier = null;
  let bloc = null; // { debut, plus, moins, lignes } : un bloc de modifications, lu par ses décomptes

  const fermer = () => {
    if (bloc && bloc.lignes.length && fichier !== null && !VERROUS.test(fichier)) examiner(bloc);
    bloc = null;
  };
  const examiner = ({ debut, lignes }) => {
    const texte = lignes.join('\n');
    for (const { format, valeur, index, lu } of formatsDans(texte)) {
      if (format.publique || lu?.publique) continue;
      const trouve = { format, fichier, ligne: debut + numeroLigne(texte, index) - 1, commit, commits: 1 };
      const connu = vues.get(valeur);
      if (connu) vues.set(valeur, { ...trouve, commits: connu.commits + 1 });
      else if (vues.size >= plafond) plafonne = true;
      else vues.set(valeur, trouve);
    }
  };

  for (const ligne of sortie.split('\n')) {
    if (bloc && (bloc.plus > 0 || bloc.moins > 0)) {
      // Dans un bloc, une ligne est ce que ses décomptes disent qu'elle est, quoi qu'elle ressemble : `+++ b/x` est une ligne ajoutée qui commence par `++ b/x`.
      if (ligne.startsWith('+') && bloc.plus > 0) { bloc.plus--; bloc.lignes.push(ligne.slice(1)); continue; }
      if (ligne.startsWith('-') && bloc.moins > 0) { bloc.moins--; continue; }
      if (ligne.startsWith('\\')) continue; // « \ No newline at end of file »
    }
    if (ligne.startsWith('@@COMMIT ')) { fermer(); commit = ligne.slice(9, 9 + LONGUEUR_DU_COMMIT); fichier = null; continue; }
    if (ligne.startsWith('diff --git ')) { fermer(); fichier = null; continue; }
    if (ligne.startsWith('+++ ') && bloc === null) {
      const chemin = ligne.slice(4).replace(/\t.*$/s, '');
      fichier = chemin.startsWith('"b/') ? chemin.slice(3, -1) : chemin.startsWith('b/') ? chemin.slice(2) : null;
      continue;
    }
    const entete = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(ligne);
    if (entete) {
      fermer();
      bloc = { debut: Number(entete[2]), moins: entete[1] === undefined ? 1 : Number(entete[1]), plus: entete[3] === undefined ? 1 : Number(entete[3]), lignes: [] };
      // Un décompte nul d'ajouts : la ligne qui suit n'est pas une ligne ajoutée.
    }
  }
  fermer();
  return { vues, plafonne };
}

const nonLu = (cause) => constat({
  regle: 'C-SECRET-02', axe: 'C', severite: 'info', confiance: 'certain',
  titre: "Historique Git non lu en entier : un secret retiré du code peut y rester",
  constat: `L'outil n'a pas lu tout l'historique Git du dépôt : ${cause}`,
  impact: "Un secret ajouté puis retiré d'un fichier reste dans les commits que l'outil n'a pas lus : l'absence de constat sur l'historique ne vaut pas absence de secret.",
  remediation: "Auditer un clone complet (`git clone` sans `--depth`, ou `git fetch --unshallow` dans le clone), ou lancer l'audit sur l'adresse du dépôt.",
});

export function analyserHistorique(ctx) {
  const racine = ctx.racine;
  if (!racine || !fs.existsSync(path.join(racine, '.git'))) return []; // pas un dépôt Git : pas d'historique

  const profondeur = git(racine, ['rev-parse', '--is-shallow-repository'], { timeout: 15_000 });
  if (profondeur.error?.code === 'ENOENT') return [nonLu("git n'est pas installé sur ce poste.")];
  if (profondeur.status !== 0) return [nonLu('git a refusé de lire le dépôt (propriétaire différent, dépôt abîmé).')];
  if (profondeur.stdout.trim() === 'true') return [nonLu("le dépôt est peu profond (un clone `--depth` ne garde que les derniers commits) : l'historique a été coupé à son clonage.")];

  const lecture = git(racine, ['log', '--all', '--no-color', '--no-textconv', '--no-ext-diff', '--no-renames', '--diff-filter=AM', '-p', '-U0', '--format=@@COMMIT %H'], { timeout: DELAI_DE_LECTURE, maxBuffer: OCTETS_LUS });
  const coupe = lecture.error?.code === 'ETIMEDOUT' ? `le délai de ${DELAI_DE_LECTURE / 1000} secondes est dépassé` : lecture.error?.code === 'ENOBUFS' ? `la taille lue dépasse ${OCTETS_LUS / 1024 / 1024} Mio` : null;
  if (lecture.error && !coupe) return [nonLu("git n'a pas pu lire l'historique.")];
  if (!coupe && lecture.status !== 0) return [nonLu('git a échoué en lisant l\'historique.')];

  let sortie = lecture.stdout ?? '';
  if (coupe) sortie = sortie.slice(0, sortie.lastIndexOf('\n') + 1); // la dernière ligne, coupée, n'est pas lue
  const { vues, plafonne } = valeursDansLeDiff(sortie);

  const constats = [];
  for (const [valeur, { format, fichier, ligne, commit, commits }] of vues) {
    if (ctx.fichiers.some((f) => typeof f.contenu === 'string' && f.contenu.includes(valeur))) continue; // encore dans le code : C-SECRET-01 le dit
    constats.push(constat({
      regle: 'C-SECRET-02', axe: 'C', severite: 'majeur', confiance: 'probable', fichier, ligne,
      extrait: format.extrait ? format.extrait(valeur) : masquer(valeur),
      titre: `Secret retiré du code mais encore dans l'historique Git (${format.libelle})`,
      constat: `Une valeur au format reconnu « ${format.libelle} » a été versionnée dans le commit ${commit} (${fichier}, ligne ${ligne}) et n'est plus dans les fichiers actuels. L'historique du dépôt la porte toujours : quiconque le clone la lit dans ce commit${commits > 1 ? ` (elle figure dans ${commits} commits)` : ''}.`,
      impact: "Retirer une clé d'un fichier ne la retire pas du dépôt. Un attaquant équipé d'une IA balaie l'historique des dépôts publics à la recherche de ces clés, y compris de celles qu'on croyait effacées : tant qu'elle n'est pas révoquée, elle ouvre ce qu'elle ouvrait.",
      remediation: "Révoquer la clé chez le fournisseur sans attendre : c'est la seule mesure qui compte, réécrire l'historique (`git filter-repo`) ne reprend pas ce que des tiers ont déjà cloné. Un widget est du code exécuté côté client : il ne peut pas détenir de secret.",
      referentiels: ['CWE-798', 'CWE-540'],
      preuve: { forme: 'historique', fournisseur: format.id, longueur: valeur.length, commit, commits },
    }));
  }
  if (coupe) constats.push(nonLu(`${coupe} : seuls les commits les plus récents ont été lus.`));
  else if (plafonne) constats.push(nonLu(`plus de ${PLAFOND_DE_VALEURS} valeurs distinctes au format d'une clé : les ${PLAFOND_DE_VALEURS} premières seulement sont dites.`));
  return constats;
}
