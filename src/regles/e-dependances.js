/**
 * Axe E — Chaîne d'approvisionnement et dépendances.
 *
 * Pour un widget, la question n'est pas seulement « une dépendance a-t-elle
 * une faille connue ». C'est d'abord : QUAND ce code tiers est-il récupéré, et
 * par qui ? Une dépendance npm de développement ne s'exécute jamais chez
 * l'agent. Une balise `<script src="https://cdn…">` s'exécute chez chaque
 * agent, à chaque affichage, avec l'accès au document — et son contenu peut
 * changer sans que le dépôt bouge d'une ligne.
 *
 * On classe donc les dépendances en trois anneaux :
 *   1. distantes à l'exécution  — risque maximal, non maîtrisé
 *   2. embarquées dans le dépôt — risque maîtrisé, à jour manuellement
 *   3. de développement         — risque limité au poste du contributeur
 */
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { constat } from '../moteur/modele.js';

const execFileAsync = promisify(execFile);

const CDN_CONNUS = /(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|code\.jquery\.com|ajax\.googleapis\.com|esm\.sh|skypack\.dev|jspm\.io|cdn\.skypack\.dev)/i;

/** Anneau 1 : code tiers chargé depuis un domaine distant au moment de l'exécution. */
export function analyserDependancesDistantes(ctx) {
  const constats = [];
  const distantes = [];

  for (const f of ctx.fichiers) {
    if (!f.executee || f.binaire || !['.html', '.htm'].includes(f.ext)) continue;
    for (const m of f.contenu.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
      const url = m[1];
      if (/grist-plugin-api\.js/.test(url)) continue;       // traité par l'axe C
      distantes.push({
        fichier: f.chemin,
        ligne: f.contenu.slice(0, m.index).split('\n').length,
        url,
        sri: /\bintegrity\s*=/.test(m[0]),
        versionFigee: /@\d+\.\d+\.\d+/.test(url) || /\/\d+\.\d+\.\d+\//.test(url),
        cdn: CDN_CONNUS.test(url),
        balise: m[0],
      });
    }
  }

  for (const d of distantes) {
    const problemes = [];
    if (!d.sri) problemes.push("aucun contrôle d'intégrité (`integrity`)");
    if (!d.versionFigee) problemes.push('version non figée dans l\'URL');
    constats.push(constat({
      regle: 'E-DEP-01', axe: 'E',
      severite: !d.sri ? 'critique' : 'majeur', bloquant: !d.sri,
      confiance: 'certain',
      titre: `Bibliothèque tierce chargée à l'exécution depuis ${hote(d.url)}`,
      fichier: d.fichier, ligne: d.ligne, extrait: d.balise,
      constat: `Le widget charge \`${d.url}\`${problemes.length ? ` — ${problemes.join(', ')}` : ''}.`,
      impact: "Ce code s'exécute chez chaque agent avec l'accès au document que le widget a obtenu. Le dépôt audité ne dit rien de ce qui sera réellement servi : le contenu peut changer à tout moment. Sans `integrity`, le navigateur accepte n'importe quel remplacement — c'est le scénario de compromission de CDN, et il ne laisse aucune trace dans l'historique Git.",
      remediation: "Embarquer la bibliothèque dans le dépôt (`vendor/`), la servir en relatif, et noter sa version et son origine dans le README. Si le chargement distant doit être conservé, figer la version dans l'URL et ajouter `integrity` et `crossorigin=\"anonymous\"`.",
      referentiels: ['OWASP Top 10 A08:2021 — Software and Data Integrity Failures', 'ANSSI — Recommandations pour la sécurisation des sites web', 'Guide de contribution Grist.Gouv — « no unnecessary dependencies »'],
    }));
  }
  return constats;
}

/**
 * Anneau 2 : code tiers recopié dans le dépôt, sans traçabilité.
 *
 * La détection (`f.vendorise`) est calculée une seule fois par fichier dans
 * `construireContexte` — c'est aussi elle que les axes A et B consultent
 * pour ne pas juger la qualité et la lisibilité d'un code que le
 * contributeur n'a pas écrit (voir `estVendorise` dans
 * `src/contexte/inventaire.js`). Un seul mécanisme de détection, deux usages.
 */
export function analyserDependancesEmbarquees(ctx) {
  const constats = [];
  const suspects = ctx.fichiers.filter((f) => f.vendorise);

  for (const f of suspects) {
    const version = (f.contenu.slice(0, 2000).match(/v?\d+\.\d+\.\d+/) || [])[0];
    const licence = /@license|MIT License|Apache License|BSD|\(c\)\s*\d{4}/i.test(f.contenu.slice(0, 2000));
    constats.push(constat({
      regle: 'E-DEP-02', axe: 'E',
      severite: version && licence ? 'info' : 'mineur', confiance: 'probable',
      titre: `Bibliothèque tierce embarquée : ${f.chemin}${version ? ` (version ${version})` : ' (version non identifiée)'}`,
      fichier: f.chemin,
      constat: `Fichier de ${Math.round(f.taille / 1024)} Ko qui présente les caractéristiques d'un code tiers recopié${version ? '' : ', sans numéro de version repérable dans l\'en-tête'}${licence ? '' : ', sans en-tête de licence'}.`,
      impact: "Embarquer une bibliothèque est la bonne pratique pour un widget — mais sans version ni origine notées, personne ne peut savoir si elle est affectée par une vulnérabilité publiée, ni la mettre à jour en connaissance de cause. Ce fichier est par ailleurs exclu des axes A (qualité) et B (lisibilité) : ils jugent la façon dont le contributeur écrit son propre code, pas le contenu d'une bibliothèque tierce qu'il n'a pas écrite. Il reste pleinement évalué en sécurité (axe C), en condition réelle (axe D) et pour le risque de dépendance (ici, axe E).",
      remediation: "Conserver l'en-tête d'origine du fichier (nom, version, licence, URL de provenance), ou tenir un fichier `vendor/SOURCES.md` listant chaque bibliothèque, sa version et la date de récupération.",
      referentiels: ['ANSSI — Maîtrise du code tiers', 'Décret n° 2021-1559 (code source et transparence)'],
    }));
  }
  return constats;
}

/** Anneau 3 : dépendances npm déclarées, verrouillage, et vulnérabilités connues. */
export async function analyserPaquetNpm(ctx, options = {}) {
  const constats = [];
  const paquet = ctx.paquet;
  if (!paquet) {
    constats.push(constat({
      regle: 'E-DEP-03', axe: 'E', severite: 'info', confiance: 'certain',
      titre: 'Aucun package.json : widget sans chaîne de construction npm',
      constat: "Le dépôt ne déclare pas de dépendances npm.",
      impact: "C'est plutôt favorable pour un widget : moins de code tiers, pas d'étape de construction à reproduire. À confirmer que les bibliothèques utilisées ne sont pas simplement chargées depuis un CDN (voir E-DEP-01).",
      remediation: 'Rien à corriger.',
    }));
    return constats;
  }

  const prod = Object.entries(paquet.dependencies ?? {});
  const dev = Object.entries(paquet.devDependencies ?? {});
  const lock = ctx.fichiers.some((f) => /^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f.chemin));

  if ((prod.length || dev.length) && !lock) {
    constats.push(constat({
      regle: 'E-DEP-04', axe: 'E', severite: 'majeur', confiance: 'certain',
      titre: 'Dépendances déclarées sans fichier de verrouillage',
      fichier: 'package.json',
      constat: `${prod.length} dépendance(s) de production et ${dev.length} de développement, sans \`package-lock.json\` versionné.`,
      impact: "Deux installations à deux dates différentes n'installent pas le même code. L'audit qui a été fait ne vaut alors que pour l'instant où il a été fait, et une version compromise publiée sous une plage `^` est installée automatiquement.",
      remediation: 'Versionner le fichier de verrouillage produit par `npm install`.',
      referentiels: ['ANSSI — Sécurisation de la chaîne de production logicielle'],
    }));
  }

  const flottantes = prod.filter(([, v]) => /^[\^~]|^\*$|^latest$|^>/.test(String(v)));
  if (flottantes.length) {
    const emplacements = flottantes.map(([n, v]) => ({ nom: n, version: v, ligne: ligneDansPackageJson(ctx, n) })).filter((e) => e.ligne);
    constats.push(constat({
      regle: 'E-DEP-05', axe: 'E', severite: 'mineur', confiance: 'certain',
      titre: `${flottantes.length} dépendance(s) de production à version non figée`,
      fichier: 'package.json', ligne: emplacements[0]?.ligne,
      constat: `Plages ouvertes : ${flottantes.slice(0, 8).map(([n, v]) => `${n}@${v}`).join(', ')}.`,
      impact: "Une plage `^` accepte toute version mineure future, publiée par un mainteneur dont le compte peut être compromis. C'est le vecteur des attaques par dépendance les plus répandues.",
      remediation: 'Figer les versions exactes en production et laisser le fichier de verrouillage faire foi ; mettre à jour de façon délibérée.',
      preuve: emplacements.length ? { emplacements } : null,
    }));
  }

  if (prod.length > 12) {
    constats.push(constat({
      regle: 'E-DEP-06', axe: 'E', severite: 'mineur', confiance: 'certain',
      titre: `${prod.length} dépendances de production pour un widget`,
      fichier: 'package.json',
      constat: `Dépendances directes : ${prod.map(([n]) => n).slice(0, 12).join(', ')}…`,
      impact: "Le guide demande « pas de dépendances inutiles ». Chaque dépendance directe en amène d'autres : la surface réellement auditée devient sans commune mesure avec le code écrit par le contributeur.",
      remediation: "Lister ce que chaque dépendance apporte. Pour un widget, beaucoup de besoins (requêtes, dates, sélecteurs) sont couverts par les API du navigateur.",
      referentiels: ['Guide de contribution Grist.Gouv — « Minimal: no unnecessary dependencies »'],
    }));
  }

  // Vulnérabilités connues : on délègue à `npm audit`, qui interroge la base
  // d'avis GitHub. Sans réseau, on le dit plutôt que de laisser croire que
  // l'absence de constat vaut absence de vulnérabilité.
  if (lock && options.reseau !== false) {
    const r = await npmAudit(ctx.racine);
    if (r.erreur) {
      constats.push(constat({
        regle: 'E-VULN-00', axe: 'E', severite: 'info', confiance: 'certain',
        titre: "Recherche de vulnérabilités connues non aboutie",
        constat: `\`npm audit\` n'a pas pu s'exécuter : ${r.erreur}`,
        impact: "Aucune conclusion ne peut être tirée sur les vulnérabilités publiées des dépendances. L'absence de constat dans cet axe ne vaut pas absence de vulnérabilité.",
        remediation: 'Relancer `npm audit` depuis un poste disposant d\'un accès au registre npm.',
      }));
    } else {
      for (const [nom, av] of Object.entries(r.avis ?? {})) {
        const sev = { critical: 'critique', high: 'critique', moderate: 'majeur', low: 'mineur', info: 'info' }[av.severity] ?? 'mineur';
        const prodTouchee = prod.some(([p]) => p === nom) || !av.isDirect;
        constats.push(constat({
          regle: 'E-VULN-01', axe: 'E',
          severite: prodTouchee ? sev : (sev === 'critique' ? 'majeur' : 'mineur'),
          bloquant: prodTouchee && sev === 'critique',
          confiance: 'certain',
          titre: `Vulnérabilité ${av.severity} connue : ${nom}`,
          fichier: 'package.json',
          constat: `${nom} (${av.range}) — ${(av.via ?? []).map((v) => (typeof v === 'string' ? v : v.title)).slice(0, 3).join(' ; ')}`,
          impact: prodTouchee
            ? "La dépendance est livrée au navigateur de l'agent : la vulnérabilité s'applique au widget en fonctionnement."
            : "Dépendance de développement : le risque porte sur le poste du contributeur et la chaîne de construction, pas sur l'agent.",
          remediation: av.fixAvailable ? `Mettre à jour (\`npm audit fix\`${av.fixAvailable?.isSemVerMajor ? ', changement de version majeure requis' : ''}).` : 'Aucun correctif publié : évaluer le remplacement de la dépendance.',
          referentiels: ['GitHub Advisory Database', 'OWASP Top 10 A06:2021 — Composants vulnérables'],
          preuve: { avis: { severity: av.severity, range: av.range } },
        }));
      }
      if (!Object.keys(r.avis ?? {}).length) {
        constats.push(constat({
          regle: 'E-VULN-02', axe: 'E', severite: 'info', confiance: 'certain',
          titre: 'Aucune vulnérabilité connue dans les dépendances npm',
          constat: '`npm audit` ne remonte aucun avis sur les versions verrouillées.',
          impact: "Résultat valable à la date de l'audit et pour les dépendances npm seulement : il ne couvre pas les bibliothèques embarquées à la main ni celles chargées depuis un CDN.",
          remediation: 'Rien à corriger.',
        }));
      }
    }
  }
  return constats;
}

/**
 * Lance `npm audit` dans un dossier neutre, isolé du dépôt audité — pas dans
 * `racine` directement. `npm` lit le `.npmrc` du dossier courant avant toute
 * option de ligne de commande : un dépôt hostile pourrait sinon y déclarer un
 * `registry` arbitraire et faire partir la requête (avec l'environnement du
 * process qui l'exécute, dont d'éventuels secrets) vers un hôte qu'il
 * contrôle plutôt que vers le registre npm réel (docs/ARCHITECTURE-V2.md,
 * constat 2). On ne copie que ce qu'il faut à l'audit — `package.json` et
 * `package-lock.json` — jamais le `.npmrc` du dépôt.
 */
async function npmAudit(racine) {
  const verrou = path.join(racine, 'package-lock.json');
  if (!fs.existsSync(verrou)) return { erreur: 'aucun package-lock.json' };

  const dossierIsole = fs.mkdtempSync(path.join(os.tmpdir(), 'gwaudit-npm-audit-'));
  try {
    fs.copyFileSync(verrou, path.join(dossierIsole, 'package-lock.json'));
    const paquetSrc = path.join(racine, 'package.json');
    if (fs.existsSync(paquetSrc)) {
      fs.copyFileSync(paquetSrc, path.join(dossierIsole, 'package.json'));
    } else {
      fs.writeFileSync(path.join(dossierIsole, 'package.json'), JSON.stringify({ name: 'gwaudit-audit-isole', version: '0.0.0', private: true }));
    }
    const npmrcVide = path.join(dossierIsole, '.npmrc-audit-gwaudit');
    fs.writeFileSync(npmrcVide, '');

    const envIsole = {
      PATH: process.env.PATH,
      HOME: dossierIsole,               // pas le HOME réel : pas de ~/.npmrc surprenant à hériter non plus
      npm_config_userconfig: npmrcVide, // écarte tout ~/.npmrc réel malgré HOME
      npm_config_registry: 'https://registry.npmjs.org/',
      // `npm audit` a, lui, réellement besoin d'atteindre le registre npm —
      // contrairement à l'axe D, dont tout le trafic est neutralisé par
      // construction. On transmet donc le proxy éventuel de l'environnement
      // (pas le reste : ni secrets, ni config surprenante), pour qu'un poste
      // derrière un proxy d'entreprise continue de fonctionner.
      ...Object.fromEntries(
        ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
          .filter((cle) => process.env[cle] !== undefined)
          .map((cle) => [cle, process.env[cle]])
      ),
    };

    const { stdout } = await execFileAsync('npm', ['audit', '--json', '--audit-level=info', '--registry', 'https://registry.npmjs.org/'], {
      cwd: dossierIsole, timeout: 120000, maxBuffer: 32 * 1024 * 1024, env: envIsole,
    }).catch((e) => ({ stdout: e.stdout || '' }));   // npm audit sort en code ≠ 0 dès qu'il trouve quelque chose
    if (!stdout.trim()) return { erreur: 'sortie vide' };
    const j = JSON.parse(stdout);
    return { avis: j.vulnerabilities ?? {} };
  } catch (e) {
    return { erreur: String(e.message ?? e).slice(0, 200) };
  } finally {
    fs.rmSync(dossierIsole, { recursive: true, force: true });
  }
}

/** Licence du dépôt : condition d'un fork par l'équipe Grist.Gouv. */
export function analyserLicence(ctx) {
  const constats = [];
  const licence = ctx.fichiers.find((f) => /^(LICEN[SC]E|COPYING)(\.[a-z]+)?$/i.test(path.basename(f.chemin)) && !f.chemin.includes(path.sep));
  if (!licence) {
    constats.push(constat({
      regle: 'E-LIC-01', axe: 'E', severite: 'majeur', bloquant: true, confiance: 'certain',
      titre: 'Aucun fichier de licence à la racine',
      constat: "Le dépôt ne contient pas de fichier LICENSE.",
      impact: "Sans licence explicite, le code reste sous droit d'auteur par défaut : l'équipe Grist.Gouv n'a juridiquement pas le droit de forker le dépôt, ce qui est pourtant le mode d'intégration décrit par le guide (« nous forkons les dépôts que nous jugeons pertinents »). La contribution est inexploitable en l'état.",
      remediation: "Ajouter une licence libre compatible avec l'écosystème Grist (MIT, Apache 2.0) ou avec la doctrine de l'État (EUPL 1.2, recommandée pour le secteur public).",
      referentiels: ['Loi pour une République numérique, art. 9', 'Politique de contribution open source de l\'État', 'EUPL 1.2'],
    }));
  } else {
    const t = licence.contenu.slice(0, 3000);
    const type = /MIT License/i.test(t) ? 'MIT'
      : /Apache License/i.test(t) ? 'Apache 2.0'
      : /EUROPEAN UNION PUBLIC LICENCE|EUPL/i.test(t) ? 'EUPL'
      : /GNU (AFFERO )?GENERAL PUBLIC/i.test(t) ? 'GPL/AGPL'
      : /BSD/i.test(t) ? 'BSD' : 'non identifiée';
    constats.push(constat({
      regle: 'E-LIC-02', axe: 'E', severite: type === 'non identifiée' ? 'mineur' : 'info', confiance: 'certain',
      titre: `Licence du dépôt : ${type}`,
      fichier: licence.chemin,
      constat: `Fichier de licence présent (${Math.round(licence.taille / 1024)} Ko), type détecté : ${type}.`,
      impact: type === 'GPL/AGPL'
        ? "Licence à effet contaminant : à vérifier avec l'équipe Grist.Gouv avant intégration, elle contraint la redistribution du reste de l'instance."
        : type === 'non identifiée'
        ? "Le type de licence n'a pas pu être déterminé automatiquement : à vérifier manuellement."
        : 'Licence compatible avec un fork par l\'équipe Grist.Gouv.',
      remediation: type === 'non identifiée' ? "Utiliser le texte standard non modifié d'une licence reconnue." : 'Rien à corriger.',
      referentiels: ['Politique de contribution open source de l\'État'],
    }));
  }
  return constats;
}

function hote(url) { try { return new URL(url).hostname; } catch { return url; } }

/** Ligne (1-based) où une dépendance est déclarée dans le package.json brut. */
function ligneDansPackageJson(ctx, nomPaquet) {
  const f = ctx.fichiers.find((x) => x.chemin === 'package.json');
  if (!f?.lignes) return null;
  const motif = new RegExp(`"${nomPaquet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
  const i = f.lignes.findIndex((l) => motif.test(l));
  return i === -1 ? null : i + 1;
}

export const reglesE = [
  analyserDependancesDistantes, analyserDependancesEmbarquees,
  analyserPaquetNpm, analyserLicence,
];
