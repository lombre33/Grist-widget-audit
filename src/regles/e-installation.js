/**
 * Ce que `npm install` lance et d'où il télécharge : les scripts d'installation et le fichier de verrouillage.
 *
 * Quiconque installe un dépôt (le relecteur qui le clone pour l'auditer, la chaîne d'intégration) exécute ce que ses scripts d'installation disent, et ceux de chacune
 * de ses dépendances : c'est le canal des vers qui se propagent de paquet en paquet. Et le fichier de verrouillage dit d'où chaque paquet est téléchargé et ce qu'il
 * doit valoir : une adresse hors du registre officiel, un téléchargement sans TLS ou une empreinte absente laissent le contenu installé à qui contrôle l'adresse.
 *
 *  - E-INSTALL-01 : le `package.json` du dépôt déclare `preinstall`, `install` ou `postinstall`. Majeur si la commande télécharge ou exécute du texte (`curl`, `wget`,
 *    `| sh`, `node -e`, `eval`, `base64`, une adresse, PowerShell), mineur sinon (`node scripts/setup.js` : le fichier que la commande lance s'exécute sur le poste de
 *    qui installe). Jamais bloquant : un script d'installation est un choix de construction, souvent honnête.
 *  - E-INSTALL-02 : des dépendances du verrou déclarent un script d'installation (`hasInstallScript`). Information, sans pénalité : `esbuild` ou `puppeteer` en ont.
 *    `npm install --ignore-scripts` ne les lance pas.
 *  - E-VERROU-01 : un paquet du verrou est téléchargé par `http://` (sans TLS : majeur), ou depuis une adresse hors du registre officiel, dont un dépôt git (mineur).
 *  - E-VERROU-02 : un paquet téléchargé du registre n'a pas d'empreinte (`integrity`). Mineur : le contenu installé n'est pas contrôlé.
 * Seul le `package-lock.json` de la racine est lu (versions 1 à 3) : ni `yarn.lock` ni `pnpm-lock.yaml`.
 */
import { constat } from '../moteur/modele.js';
import { citer } from '../moteur/texte-du-widget.js';

const SCRIPTS_D_INSTALLATION = ['preinstall', 'install', 'postinstall'];
const LONGUEUR_DE_COMMANDE = 200;
/** Une commande qui télécharge ou exécute du texte : à lire avant d'installer. Le texte d'une commande, non du JavaScript : des mots, pas un arbre. */
export const COMMANDE_QUI_TELECHARGE = /\b(?:curl|wget|iwr|invoke-webrequest|powershell|pwsh|certutil|bitsadmin|eval|base64)\b|\|\s*(?:sh|bash|zsh)\b|\bnode\s+(?:-e|--eval)\b|https?:\/\//i;
const REGISTRES_OFFICIELS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
const MAX_PAQUETS_LUS = 200_000;
const MAX_NOMS_DITS = 8;
const MAX_NOMS_EN_PREUVE = 50;

const ligneDe = (f, motif) => {
  const i = f?.lignes?.findIndex((l) => l.includes(motif)) ?? -1;
  return i === -1 ? null : i + 1;
};

function scriptsDInstallation(ctx) {
  const scripts = ctx.paquet?.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  return SCRIPTS_D_INSTALLATION.filter((nom) => typeof scripts[nom] === 'string').map((nom) => ({ nom, commande: scripts[nom] }));
}

/** Les paquets du `package-lock.json` (versions 2 et 3 : `packages` ; version 1 : `dependencies`, imbriquées) : `{ nom, chemin, resolved, integrity, hasInstallScript }`. */
function paquetsDuVerrou(json) {
  const paquets = [];
  if (json?.packages && typeof json.packages === 'object') {
    for (const [chemin, p] of Object.entries(json.packages)) {
      if (chemin === '' || !p || typeof p !== 'object' || p.link || p.inBundle || typeof p.version !== 'string') continue;
      paquets.push({ nom: p.name ?? chemin.split('node_modules/').pop(), chemin, resolved: p.resolved, integrity: p.integrity, hasInstallScript: p.hasInstallScript === true });
      if (paquets.length >= MAX_PAQUETS_LUS) break;
    }
  } else if (json?.dependencies && typeof json.dependencies === 'object') {
    const pile = [[json.dependencies, '']];
    while (pile.length && paquets.length < MAX_PAQUETS_LUS) {
      const [dependances, parent] = pile.pop();
      for (const [nom, p] of Object.entries(dependances)) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.version === 'string' && !p.bundled) paquets.push({ nom, chemin: `${parent}node_modules/${nom}`, resolved: p.resolved, integrity: p.integrity, hasInstallScript: false });
        if (p.dependencies && typeof p.dependencies === 'object') pile.push([p.dependencies, `${parent}node_modules/${nom}/`]);
      }
    }
  }
  return paquets;
}

/** D'où le verrou dit télécharger un paquet : `registre` (l'officiel, en TLS), `http` (sans TLS), `ailleurs` (une autre adresse, un dépôt git, un fichier), ou `aucune`. */
function origineDe(resolved) {
  if (typeof resolved !== 'string' || resolved === '') return 'aucune';
  let url;
  try { url = new URL(resolved); } catch { return 'ailleurs'; }
  if (url.protocol === 'http:') return 'http';
  return url.protocol === 'https:' && REGISTRES_OFFICIELS.has(url.hostname) ? 'registre' : 'ailleurs';
}

const dits = (noms) => `${noms.slice(0, MAX_NOMS_DITS).join(', ')}${noms.length > MAX_NOMS_DITS ? `… (${noms.length} paquets)` : ''}`;

export function analyserInstallation(ctx) {
  const constats = [];
  const racine = ctx.fichiers.find((f) => f.chemin === 'package.json');

  for (const { nom, commande } of scriptsDInstallation(ctx)) {
    const risquee = COMMANDE_QUI_TELECHARGE.test(commande.slice(0, 2000));
    constats.push(constat({
      regle: 'E-INSTALL-01', axe: 'E', severite: risquee ? 'majeur' : 'mineur', confiance: 'certain',
      titre: `Le dépôt lance un script à l'installation (${nom})`,
      fichier: 'package.json', ligne: ligneDe(racine, `"${nom}"`) ?? undefined, extrait: `"${nom}": ${JSON.stringify(commande.slice(0, LONGUEUR_DE_COMMANDE))}`,
      constat: `\`package.json\` déclare le script \`${nom}\`, que \`npm install\` lance : ${citer(commande.slice(0, LONGUEUR_DE_COMMANDE))}${risquee ? ' Cette commande télécharge ou exécute du texte.' : ''}`,
      impact: "Quiconque installe le dépôt (le relecteur qui le clone pour l'auditer, la chaîne d'intégration) exécute cette commande sur son poste, avec ses droits, avant d'avoir lu le code : c'est le canal des attaques qui visent ceux qui relisent.",
      remediation: "Retirer le script d'installation, ou le faire lancer à la main (`npm run`). Auditer un dépôt avec `npm install --ignore-scripts`.",
      referentiels: ['OWASP — Supply Chain', 'CWE-829'],
      preuve: { script: nom, commande: commande.slice(0, LONGUEUR_DE_COMMANDE), telecharge: risquee },
    }));
  }

  const verrou = ctx.fichiers.find((f) => f.chemin === 'package-lock.json' && typeof f.contenu === 'string');
  let json = null;
  if (verrou) { try { json = JSON.parse(verrou.contenu); } catch { json = null; } }
  if (!json) return constats;
  const paquets = paquetsDuVerrou(json);

  const avecScript = paquets.filter((p) => p.hasInstallScript);
  if (avecScript.length) {
    const noms = [...new Set(avecScript.map((p) => p.nom))];
    constats.push(constat({
      regle: 'E-INSTALL-02', axe: 'E', severite: 'info', confiance: 'certain',
      titre: `${noms.length} dépendance(s) lancent un script à l'installation`,
      fichier: 'package-lock.json', ligne: ligneDe(verrou, `"${avecScript[0].chemin}"`) ?? undefined,
      constat: `Le fichier de verrouillage marque ${noms.length} paquet(s) \`hasInstallScript\` : ${dits(noms)}.`,
      impact: "Ces paquets exécutent du code sur le poste de qui installe le dépôt. Beaucoup le font honnêtement (compilation, téléchargement d'un binaire) : c'est aussi le canal par lequel une dépendance compromise se propage.",
      remediation: "Installer avec `npm install --ignore-scripts` pour un audit ou une chaîne d'intégration, et n'autoriser que les scripts dont on a besoin.",
      referentiels: ['OWASP — Supply Chain', 'CWE-829'],
      preuve: { total: noms.length, noms: noms.slice(0, MAX_NOMS_EN_PREUVE) },
    }));
  }

  const parOrigine = { http: [], ailleurs: [] };
  const sansEmpreinte = [];
  for (const p of paquets) {
    const origine = origineDe(p.resolved);
    if (origine === 'http' || origine === 'ailleurs') parOrigine[origine].push(p);
    if (origine === 'registre' && !p.integrity) sansEmpreinte.push(p);
  }
  for (const [origine, liste] of Object.entries(parOrigine)) {
    if (!liste.length) continue;
    const noms = [...new Set(liste.map((p) => p.nom))];
    const http = origine === 'http';
    constats.push(constat({
      regle: 'E-VERROU-01', axe: 'E', severite: http ? 'majeur' : 'mineur', confiance: 'certain',
      titre: http ? `${noms.length} paquet(s) téléchargés sans TLS` : `${noms.length} paquet(s) téléchargés hors du registre officiel`,
      fichier: 'package-lock.json', ligne: ligneDe(verrou, `"${liste[0].chemin}"`) ?? undefined,
      constat: http
        ? `Le fichier de verrouillage donne une adresse \`http://\` pour : ${dits(noms)}.`
        : `Le fichier de verrouillage donne une adresse hors de registry.npmjs.org (un autre registre, une archive, un dépôt git) pour : ${dits(noms)}.`,
      impact: http
        ? "Un téléchargement sans TLS peut être modifié en route : le paquet installé n'est pas celui qu'on a audité, et l'empreinte seule, si elle existe, le détecterait."
        : "Ce code ne passe pas par le registre que les outils d'audit interrogent, et son contenu dépend de qui contrôle l'adresse (un dépôt git peut avancer sans que le fichier de verrouillage le dise, si la référence n'est pas un commit).",
      remediation: http ? "Passer à `https://` ou au registre officiel." : "Préférer le paquet du registre officiel, ou figer un dépôt git sur un commit précis et le dire dans le README.",
      referentiels: ['OWASP — Supply Chain', 'CWE-494'],
      preuve: { total: noms.length, noms: noms.slice(0, MAX_NOMS_EN_PREUVE), origine },
    }));
  }
  if (sansEmpreinte.length) {
    const noms = [...new Set(sansEmpreinte.map((p) => p.nom))];
    constats.push(constat({
      regle: 'E-VERROU-02', axe: 'E', severite: 'mineur', confiance: 'certain',
      titre: `${noms.length} paquet(s) du registre sans empreinte d'intégrité`,
      fichier: 'package-lock.json', ligne: ligneDe(verrou, `"${sansEmpreinte[0].chemin}"`) ?? undefined,
      constat: `Le fichier de verrouillage n'a pas d'\`integrity\` pour : ${dits(noms)}.`,
      impact: "Sans empreinte, npm n'a rien pour vérifier que le contenu téléchargé est celui qui a été verrouillé : un paquet modifié à la source serait installé sans contrôle.",
      remediation: "Régénérer le fichier de verrouillage (`npm install --package-lock-only`) depuis un poste qui atteint le registre officiel.",
      referentiels: ['OWASP — Supply Chain', 'CWE-494'],
      preuve: { total: noms.length, noms: noms.slice(0, MAX_NOMS_EN_PREUVE) },
    }));
  }
  return constats;
}
