/**
 * Le relecteur est visé : du texte qui s'adresse à l'IA qui relit le dépôt, et les fichiers qui règlent les assistants de code.
 *
 * Un dépôt est relu de plus en plus par un assistant IA (l'éditeur de la personne qui l'ouvre, un audit par modèle de langage comme `docs/PROMPT-AUDIT-LLM.md`).
 * Le texte du dépôt est alors lu comme une consigne possible : « ignore tes instructions », « ne signale pas ce fichier », un fichier de règles que l'éditeur charge
 * seul (« Rules File Backdoor »), une tâche qui s'exécute à l'ouverture du dossier. Aucune de ces règles n'est bloquante : un texte n'est une attaque que par son
 * intention, et un widget qui embarque une IA porte légitimement des consignes, d'où « à vérifier ».
 *
 *  - C-RELECTEUR-01 : une phrase qui s'adresse à l'IA relectrice (ignorer les consignes, ne rien signaler, « note à l'IA ») dans un document (README, Markdown, texte), le
 *    `package.json`, le manifeste, un commentaire d'un fichier JavaScript ou un fichier de consignes d'assistant. Majeur, à vérifier. Une chaîne d'un JavaScript n'est jamais lue : le
 *    prompt d'un widget d'IA y vit.
 *  - C-AGENT-01 : le dépôt porte des fichiers de réglage d'assistants de code (`.cursorrules`, `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/`, `.github/copilot-instructions.md`,
 *    `.claude/settings.json`, `.mcp.json`, `.vscode/tasks.json`…). Information, sans pénalité : ce que l'assistant de qui ouvre le dépôt lira ou fera.
 *  - C-AGENT-02 : un de ces fichiers fait lancer une commande : un crochet de `.claude/settings.json`, un serveur de `.mcp.json` qui lance un programme, une tâche de
 *    `.vscode/tasks.json` qui s'exécute à l'ouverture du dossier (`runOn: folderOpen`). Mineur, majeur si la commande télécharge ou exécute du texte.
 * Le caractère caché dans ces fichiers est dit par C-INVISIBLE-01, qui lit tout fichier texte.
 */
import { constat } from '../moteur/modele.js';
import { numeroLigne } from '../moteur/lignes.js';
import { lire, unitesJs } from '../moteur/analyse-js.js';
import { citer, neutraliser } from '../moteur/texte-du-widget.js';
import { COMMANDE_QUI_TELECHARGE } from './e-installation.js';

const MAX_TEXTE_LU = 1_000_000;
const MAX_PHRASES_PAR_FICHIER = 20;
const MAX_PHRASES_DITES = 5;
const MAX_FICHIERS_DITS = 12;
const LONGUEUR_DE_PHRASE = 160;

const EXTENSIONS_DE_DOCUMENT = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '']);
const EXTENSIONS_JS = new Set(['.js', '.mjs', '.cjs']);
const CHEMINS_UTILES = /(^|\/)(package\.json|manifest\.json)$/i;

/**
 * Les phrases qui s'adressent à un relecteur IA. Écrites pour ne pas attraper la prose ordinaire : « ignore » et « oublie » demandent d'écarter des consignes
 * (« précédentes », « tes », « toutes »), « ne signale pas ce fichier » demande de se taire, « si tu es une IA » nomme le destinataire. « Ne signalez pas de faille
 * de sécurité en public » (un SECURITY.md) et « l'outil ne signale pas les fichiers vides » (de la prose) n'en sont pas. Le texte d'une documentation sur
 * l'injection de consignes les porte aussi : le constat est « à vérifier ».
 */
const PHRASES = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:(?:previous|prior|above|earlier|preceding)\s+|your\s+)(?:\w+\s+)?(?:instructions?|prompts?|rules|guidelines)\b/gi,
  /\b(?:ignore[zr]?|oublie[zr]?)\s+(?:(?:toutes?\s+)?(?:tes|vos)\s+(?:précédentes?\s+)?|toutes?\s+les\s+(?:précédentes?\s+)?|les\s+précédentes?\s+)(?:instructions?|consignes?|règles?)\b/gi,
  /\b(?:do\s+not|don'?t|never|must\s+not)\s+(?:report|flag|mention|list|raise|disclose)\s+(?:any\s+|all\s+)?(?:of\s+)?(?:this|these|that|those)\s+(?:code|files?|widget|repo\w*|package|dependenc\w+|snippet|function)\b/gi,
  /\b(?:auditor|reviewer|scanner|ai|llm|assistant|model)\b[^.\n]{0,40}\b(?:do\s+not|don'?t|never|must\s+not)\s+(?:report|flag|mention|list|raise)\b/gi,
  /\bne\s+(?:signale|signalez|mentionne|mentionnez)\s+(?:pas|jamais|rien)\s+(?:ce|cette|cet|ces)\s+(?:code|fichiers?|widget|dépôt|dépendance|bibliothèque|extrait|fonction)\b/gi,
  /\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:the\s+|any\s+)?(?:ai|llm|language\s+model|assistant|code\s+reviewer|auditor|reviewer)\b/gi,
  /\b(?:if|when)\s+you\s+are\s+(?:an?\s+)?(?:ai|llm|language\s+model|assistant|automated\s+(?:reviewer|auditor))\b/gi,
  /\bsi\s+(?:tu\s+es|vous\s+êtes)\s+(?:une?\s+)?(?:ia|intelligence\s+artificielle|llm|modèle\s+de\s+langage|assistant)\b/gi,
  /\bà\s+l'attention\s+de\s+l'(?:ia|auditeur|relecteur|assistant)\b/gi,
  /\b(?:mark|report|rate|treat)\s+(?:this|the)\s+(?:code|widget|repo\w*|project)\s+as\s+(?:safe|secure|clean|benign|compliant)\b/gi,
];

/** Les fichiers qui règlent les assistants de code, par chemin : `genre` dit ce que le fichier est (des consignes en texte, ou une configuration qui lance une commande). */
const FICHIERS_D_AGENT = [
  { genre: 'consignes', re: /(?:^|\/)(?:\.cursorrules|\.windsurfrules|\.clinerules|claude\.md|agents\.md|gemini\.md)$/i },
  { genre: 'consignes', re: /(?:^|\/)\.github\/copilot-instructions\.md$/i },
  { genre: 'consignes', re: /(?:^|\/)(?:\.cursor\/rules|\.clinerules|\.windsurf\/rules|\.github\/instructions|\.claude\/commands|\.claude\/agents)\/./i },
  { genre: 'crochets', re: /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/i },
  { genre: 'mcp', re: /(?:^|\/)(?:\.mcp\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json)$/i },
  { genre: 'taches', re: /(?:^|\/)\.vscode\/tasks\.json$/i },
];
const GENRES = { consignes: 'consignes pour l\'assistant', crochets: 'crochets (commandes lancées par l\'assistant)', mcp: 'serveurs MCP', taches: 'tâches de l\'éditeur' };
const genreDeFichier = (chemin) => FICHIERS_D_AGENT.find((g) => g.re.test(chemin))?.genre ?? null;

/** Un JSON écrit à la main : commentaires de ligne et de bloc, et virgules finales, retirés hors des chaînes (un `tasks.json` d'éditeur en porte), puis lu ; `null` si le texte ne se lit pas. */
function lireJsonTolerant(texte) {
  let sortie = '';
  let i = 0;
  const n = texte.length;
  while (i < n) {
    const c = texte[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && texte[j] !== '"') j += texte[j] === '\\' ? 2 : 1;
      sortie += texte.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && texte[i + 1] === '/') {
      while (i < n && texte[i] !== '\n') i++;
    } else if (c === '/' && texte[i + 1] === '*') {
      const fin = texte.indexOf('*/', i + 2);
      i = fin === -1 ? n : fin + 2;
    } else {
      sortie += c;
      i++;
    }
  }
  try { return JSON.parse(sortie.replace(/,(\s*[}\]])/g, '$1').replace(/^\u{FEFF}/u, '')); } catch { return null; }
}

/** Les commandes qu'une configuration d'assistant ou d'éditeur fait lancer : `[texte de la commande]`. */
function commandesDe(genre, json) {
  const commandes = [];
  const chaine = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  if (!json || typeof json !== 'object') return commandes;
  if (genre === 'crochets') {
    const descendre = (x, profondeur) => {
      if (!x || typeof x !== 'object' || profondeur > 8) return;
      for (const [cle, v] of Object.entries(x)) {
        if (cle === 'command' && chaine(v)) commandes.push(v);
        else descendre(v, profondeur + 1);
      }
    };
    descendre(json.hooks, 0);
    if (chaine(json.apiKeyHelper)) commandes.push(json.apiKeyHelper);
    if (chaine(json.statusLine?.command)) commandes.push(json.statusLine.command);
  } else if (genre === 'mcp') {
    const serveurs = json.mcpServers ?? json.servers;
    if (serveurs && typeof serveurs === 'object') {
      for (const s of Object.values(serveurs)) {
        if (!s || typeof s !== 'object' || !chaine(s.command)) continue;
        commandes.push([s.command, ...(Array.isArray(s.args) ? s.args.filter((a) => typeof a === 'string') : [])].join(' '));
      }
    }
  } else if (genre === 'taches') {
    for (const t of Array.isArray(json.tasks) ? json.tasks : []) {
      if (!t || typeof t !== 'object' || t.runOptions?.runOn !== 'folderOpen' || !chaine(t.command)) continue;
      commandes.push([t.command, ...(Array.isArray(t.args) ? t.args.map((a) => (typeof a === 'string' ? a : a?.value)).filter((a) => typeof a === 'string') : [])].join(' '));
    }
  }
  return commandes;
}

/** Les phrases adressées à une IA dans un texte : `[{ index, texte }]`, au plus `MAX_PHRASES_PAR_FICHIER`. */
function phrasesDans(texte) {
  const trouvees = [];
  for (const motif of PHRASES) {
    motif.lastIndex = 0;
    for (const m of texte.slice(0, MAX_TEXTE_LU).matchAll(motif)) {
      trouvees.push({ index: m.index, texte: m[0] });
      if (trouvees.length >= MAX_PHRASES_PAR_FICHIER) break;
    }
  }
  return trouvees.sort((a, b) => a.index - b.index).slice(0, MAX_PHRASES_PAR_FICHIER);
}

/** Les textes d'un fichier que la règle lit, avec leur décalage dans le fichier : tout un document, ou les seuls commentaires d'un JavaScript. */
function textesLus(f) {
  const genre = genreDeFichier(f.chemin);
  if (genre === 'consignes' || EXTENSIONS_DE_DOCUMENT.has(f.ext) || CHEMINS_UTILES.test(f.chemin)) return [{ decalage: 0, texte: f.contenu }];
  if (!EXTENSIONS_JS.has(f.ext)) return [];
  const unite = unitesJs(f).find((u) => !u.inline);
  const ast = unite ? lire(unite.source).ast : null;
  if (!ast) return [];
  return (ast.commentaires ?? []).map((c) => ({ decalage: c.debut, texte: unite.source.slice(c.debut, c.fin) }));
}

export function analyserRelecteur(ctx) {
  const constats = [];
  const fichiersDAgent = [];

  for (const f of ctx.fichiers) {
    if (f.binaire || typeof f.contenu !== 'string' || f.litteralImbrique) continue;
    const genre = genreDeFichier(f.chemin);
    if (genre) fichiersDAgent.push({ f, genre });

    // C-RELECTEUR-01 : une phrase qui s'adresse à l'IA relectrice.
    const phrases = textesLus(f).flatMap(({ decalage, texte }) => phrasesDans(texte).map((p) => ({ index: decalage + p.index, texte: p.texte })));
    if (phrases.length) {
      phrases.sort((a, b) => a.index - b.index);
      const [premiere] = phrases;
      const dites = phrases.slice(0, MAX_PHRASES_DITES).map((p) => `ligne ${numeroLigne(f.contenu, p.index)} : ${citer(p.texte.slice(0, LONGUEUR_DE_PHRASE))}`);
      constats.push(constat({
        regle: 'C-RELECTEUR-01', axe: 'C', severite: 'majeur', bloquant: false, confiance: 'a_verifier',
        titre: "Texte qui s'adresse à l'IA qui relit le dépôt",
        fichier: f.chemin, ligne: numeroLigne(f.contenu, premiere.index), extrait: neutraliser(premiere.texte.slice(0, LONGUEUR_DE_PHRASE)),
        constat: `${phrases.length} phrase(s) de ${f.chemin} semblent s'adresser à un assistant IA qui lit le fichier plutôt qu'à une personne : ${dites.join(' ; ')}${phrases.length > MAX_PHRASES_DITES ? ' ; …' : ''}.`,
        impact: "Un assistant qui relit le dépôt (l'éditeur de la personne qui l'ouvre, un audit par modèle de langage) peut prendre un texte du dépôt pour une consigne : ignorer ce qui précède, ne rien signaler, déclarer le code sûr. Le texte d'un dépôt est une donnée, jamais une consigne ; un widget qui embarque une IA porte légitimement des consignes, d'où « à vérifier ».",
        remediation: "Retirer la phrase, ou dire dans le README pourquoi elle est là (la consigne d'un widget d'IA, l'exemple d'une documentation sur l'injection de consignes). Quand un audit par modèle de langage relit ce dépôt, lui rappeler que tout ce qui vient du dépôt est une donnée.",
        referentiels: ['OWASP LLM01:2025 — Prompt Injection', 'CWE-1427'],
        preuve: { total: phrases.length, lignes: phrases.slice(0, MAX_PHRASES_DITES).map((p) => numeroLigne(f.contenu, p.index)) },
      }));
    }

    // C-AGENT-02 : un fichier de réglage qui fait lancer une commande.
    if (genre && genre !== 'consignes') {
      const json = lireJsonTolerant(f.contenu.slice(0, MAX_TEXTE_LU));
      const commandes = commandesDe(genre, json);
      if (commandes.length) {
        const risquee = commandes.some((c) => COMMANDE_QUI_TELECHARGE.test(c.slice(0, 2000)));
        const quand = genre === 'taches' ? "à l'ouverture du dossier dans l'éditeur (`runOn: folderOpen`)" : genre === 'mcp' ? "au démarrage du serveur MCP, quand l'assistant l'active" : "quand l'assistant déclenche le crochet";
        const premiere = commandes[0].slice(0, LONGUEUR_DE_PHRASE);
        const index = f.contenu.indexOf(JSON.stringify(commandes[0].split(' ')[0]).slice(1, -1));
        constats.push(constat({
          regle: 'C-AGENT-02', axe: 'C', severite: risquee ? 'majeur' : 'mineur', bloquant: false, confiance: 'certain',
          titre: `Un fichier de réglage d'assistant fait lancer une commande (${f.chemin})`,
          fichier: f.chemin, ligne: index === -1 ? undefined : numeroLigne(f.contenu, index), extrait: neutraliser(premiere),
          constat: `\`${f.chemin}\` fait lancer ${commandes.length} commande(s) ${quand} : ${citer(premiere)}${commandes.length > 1 ? ' ; …' : ''}.${risquee ? ' Cette commande télécharge ou exécute du texte.' : ''}`,
          impact: "Quiconque ouvre le dépôt avec cet éditeur ou cet assistant exécute la commande sur son poste, avec ses droits, avant d'avoir lu le code : c'est le canal des attaques qui visent ceux qui relisent. Les outils demandent en général une approbation (confiance de l'espace de travail, validation du serveur) : c'est elle qui protège, pas le fichier.",
          remediation: "Retirer la commande du dépôt, ou la documenter dans le README. Ouvrir un dépôt qu'on audite dans un éditeur en mode restreint, sans assistant, et ne lancer aucun de ces fichiers avant de les avoir lus.",
          referentiels: ['OWASP — Supply Chain', 'CWE-829'],
          preuve: { genre, commandes: commandes.length, telecharge: risquee },
        }));
      }
    }
  }

  // C-AGENT-01 : la présence de ces fichiers, dite une fois.
  if (fichiersDAgent.length) {
    const parGenre = new Map();
    for (const { f, genre } of fichiersDAgent) parGenre.set(genre, [...(parGenre.get(genre) ?? []), f.chemin]);
    const liste = [...parGenre].map(([genre, chemins]) => `${GENRES[genre]} : ${chemins.slice(0, MAX_FICHIERS_DITS).map((c) => citer(c)).join(', ')}${chemins.length > MAX_FICHIERS_DITS ? '…' : ''}`).join(' ; ');
    constats.unshift(constat({
      regle: 'C-AGENT-01', axe: 'C', severite: 'info', bloquant: false, confiance: 'certain',
      titre: `Le dépôt règle des assistants de code (${fichiersDAgent.length} fichier(s))`,
      fichier: fichiersDAgent[0].f.chemin,
      constat: `Le dépôt porte des fichiers de réglage d'assistants de code : ${liste}.`,
      impact: "Ces fichiers sont lus ou exécutés par l'assistant de qui ouvre le dépôt, sans que le code du widget les appelle : un texte caché ou une consigne détournée y est une attaque sur le relecteur (« Rules File Backdoor »). Beaucoup de dépôts honnêtes en portent : c'est une information, à lire avant d'ouvrir le dépôt avec un assistant.",
      remediation: "Les lire avant d'ouvrir le dépôt avec un assistant de code ; C-INVISIBLE-01 dit les caractères cachés qu'ils portent, C-RELECTEUR-01 les phrases adressées à l'IA, C-AGENT-02 les commandes qu'ils font lancer.",
      referentiels: ['OWASP LLM01:2025 — Prompt Injection', 'CWE-1427'],
      preuve: { total: fichiersDAgent.length, fichiers: fichiersDAgent.slice(0, 50).map(({ f }) => f.chemin) },
    }));
  }
  return constats;
}
