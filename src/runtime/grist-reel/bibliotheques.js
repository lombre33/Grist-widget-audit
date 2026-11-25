/**
 * Les bibliothèques que le widget déclare (esm.sh, CDN…), téléchargées par l'OUTIL avant les essais et servies depuis la machine au navigateur,
 * qui reste coupé d'Internet. Sans cela, un widget qui a besoin d'une bibliothèque pour s'afficher ne s'affiche pas, et un essai qui ne voit
 * rien ne prouve rien.
 *
 * Ce que l'outil télécharge, et rien d'autre :
 *  - les adresses que le code du widget DÉCLARE (balise `<script src>`, import map, `import` à adresse littérale : celles que l'axe E signale
 *    déjà E-DEP-01), jamais une adresse que le widget calculerait à l'exécution (une donnée du document ne peut donc pas sortir par ce canal) ;
 *  - puis, pour un module, les modules qu'il importe EN CLAIR (analyse par AST), chez le même hôte seulement ;
 *  - en https seulement, sur le port habituel, vers un nom public (jamais une adresse IP, ni un nom qui résout vers une adresse interne),
 *    sans identifiants, sans cookies, et avec des plafonds (nombre, taille, durée, profondeur) ;
 *  - du JavaScript seulement ; chaque fichier est consigné avec son empreinte SHA-256.
 * Ce qui n'a pas pu être téléchargé reste coupé : l'audit le sait (voir `dependancesNonResolues`) et ne conclut pas à la place du widget.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { analyserDependancesDistantes } from '../../regles/e-dependances.js';
import { estAdresseInterne } from '../../contexte/adresses-internes.js';

export const LIMITES = {
  racines: 40, fichiers: 300, octets: 40 * 1024 * 1024, octetsParFichier: 8 * 1024 * 1024,
  profondeur: 8, redirections: 5, delaiRequeteMs: 15_000, delaiTotalMs: 90_000,
};

const TYPES_JS = new Set(['text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript', 'application/ecmascript']);

/** Pourquoi cette adresse ne sera pas téléchargée, ou null si elle peut l'être. */
async function refus(url, lookup) {
  if (url.protocol !== 'https:') return 'adresse non chiffrée (seul https est téléchargé)';
  if (url.username || url.password) return "identifiants dans l'adresse";
  if (url.port && url.port !== '443') return 'port non standard';
  const hote = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(hote)) return 'adresse IP littérale';
  if (hote === 'localhost' || hote.endsWith('.localhost') || !hote.includes('.')) return 'nom interne';
  const adresses = (await lookup(hote).catch(() => [])).map((a) => a.address);
  if (!adresses.length) return 'résolution DNS impossible';
  if (adresses.some(estAdresseInterne)) return 'résout vers une adresse interne';
  return null;
}

/**
 * Les adresses de bibliothèques que le widget déclare, telles que l'axe E les relève, et pour chacune si l'axe E la juge protégée par une
 * empreinte (`integrity`) : c'est ce que l'essai d'altération (voir `alterer`) vérifie dans un vrai navigateur.
 * @returns {Map<string, boolean>} adresse → protégée par une empreinte selon l'analyse statique
 */
function adressesDeclarees(ctx) {
  const vues = new Map();
  for (const c of analyserDependancesDistantes(ctx)) {
    if (c.regle !== 'E-DEP-01' || !c.preuve?.adresse) continue;
    try { const u = new URL(c.preuve.adresse); u.hash = ''; vues.set(u.href, (vues.get(u.href) ?? true) && c.bloquant === false); } catch { /* adresse illisible : pas téléchargée */ }
  }
  return vues;
}

/** Les modules qu'un module importe en clair (`import`, `export … from`, `import('…')` à littéral), résolus contre son adresse. Un script classique : aucun. */
export function liensDuModule(code, base) {
  let arbre;
  try { arbre = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); } catch { return []; }
  const liens = new Set();
  const noter = (specifieur) => {
    if (typeof specifieur !== 'string' || !/^(\.{0,2}\/|https?:)/.test(specifieur)) return;      // un nom nu n'a de sens qu'avec une import map
    try { const u = new URL(specifieur, base); if (/^https?:$/.test(u.protocol)) { u.hash = ''; liens.add(u.href); } } catch { /* ignoré */ }
  };
  walk.simple(arbre, {
    ImportDeclaration: (n) => noter(n.source.value),
    ExportAllDeclaration: (n) => noter(n.source.value),
    ExportNamedDeclaration: (n) => { if (n.source) noter(n.source.value); },
    ImportExpression: (n) => { if (n.source.type === 'Literal') noter(n.source.value); },
  });
  return [...liens];
}

async function lireBorne(reponse, max) {
  const lecteur = reponse.body?.getReader();
  if (!lecteur) return Buffer.alloc(0);
  const morceaux = []; let total = 0;
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    total += value.length;
    if (total > max) { await lecteur.cancel().catch(() => {}); throw new Error(`fichier de plus de ${Math.round(max / 1048576)} Mo`); }
    morceaux.push(value);
  }
  return Buffer.concat(morceaux);
}

/**
 * @param {object} ctx contexte construit par construireContexte()
 * @param {{journal?: Function, deps?: {fetch?: Function, lookup?: Function}, limites?: object}} [options] `deps` : pour les tests
 * @returns {Promise<{servies: Map<string, object>, resume: object}>}
 */
export async function resoudreBibliotheques(ctx, options = {}) {
  const journal = options.journal ?? (() => {});
  const limites = { ...LIMITES, ...options.limites };
  const chercher = options.deps?.fetch ?? fetch;
  const lookup = options.deps?.lookup ?? ((h) => dns.lookup(h, { all: true }));
  const protegees = adressesDeclarees(ctx);
  const racines = [...protegees.keys()];
  const servies = new Map();
  const chargees = []; const refusees = [];
  const resume = { declarees: racines.length, chargees, refusees, octets: 0, tronque: false };
  if (!racines.length) return { servies, resume };

  const fin = Date.now() + limites.delaiTotalMs;
  const file = racines.slice(0, limites.racines).map((href) => ({ href, profondeur: 0 }));
  if (racines.length > limites.racines) { resume.tronque = true; refusees.push({ url: `${racines.length - limites.racines} autre(s) adresse(s)`, raison: `plus de ${limites.racines} bibliothèques déclarées` }); }
  const vus = new Set();

  while (file.length) {
    const { href, profondeur } = file.shift();
    if (vus.has(href)) continue;
    vus.add(href);
    if (Date.now() > fin || servies.size >= limites.fichiers || resume.octets >= limites.octets) { resume.tronque = true; refusees.push({ url: href, raison: 'plafond atteint (nombre, taille ou durée)' }); continue; }
    try {
      let courante = new URL(href);
      let reponse;
      for (let saut = 0; ; saut++) {
        const interdit = await refus(courante, lookup);
        if (interdit) throw new Error(interdit);
        reponse = await chercher(courante.href, {
          redirect: 'manual', credentials: 'omit', headers: { accept: '*/*', 'user-agent': 'gwaudit' },
          signal: AbortSignal.timeout(limites.delaiRequeteMs),
        });
        if (reponse.status >= 300 && reponse.status < 400 && reponse.headers.get('location')) {
          if (saut >= limites.redirections) throw new Error('trop de redirections');
          const suivante = new URL(reponse.headers.get('location'), courante); suivante.hash = '';
          servies.set(courante.href, { status: reponse.status, location: suivante.href });
          await reponse.body?.cancel().catch(() => {});
          courante = suivante;
          continue;
        }
        break;
      }
      if (reponse.status !== 200) throw new Error(`réponse ${reponse.status}`);
      const type = (reponse.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!TYPES_JS.has(type)) throw new Error(`type « ${type || 'inconnu'} » : seul du JavaScript est téléchargé`);
      const corps = await lireBorne(reponse, limites.octetsParFichier);
      resume.octets += corps.length;
      servies.set(courante.href, { status: 200, type, corps });
      chargees.push({ url: courante.href, sha256: crypto.createHash('sha256').update(corps).digest('hex'), taille: corps.length, protegee: profondeur === 0 && protegees.get(href) === true });
      if (profondeur < limites.profondeur) {
        for (const lien of liensDuModule(corps.toString('utf8'), courante.href)) {
          if (new URL(lien).hostname === courante.hostname) file.push({ href: lien, profondeur: profondeur + 1 });
        }
      }
    } catch (e) {
      refusees.push({ url: href.slice(0, 300), raison: String(e?.message ?? e).slice(0, 200) });
    }
  }
  journal(`  Bibliothèques du widget : ${chargees.length} fichier(s) téléchargé(s) (${Math.round(resume.octets / 1024)} Ko)${refusees.length ? `, ${refusees.length} non téléchargé(s)` : ''}.`);
  return { servies, resume };
}

/**
 * L'essai d'altération : les mêmes bibliothèques, servies à la même adresse, avec une ligne de plus à la fin. Cette ligne ne fait que
 * consigner un identifiant dans une variable globale (`__gw_altere`) : elle ne lit rien, n'envoie rien. Si le widget l'exécute, rien n'a
 * vérifié que le fichier reçu est celui qu'on attendait (pas d'empreinte `integrity`, ou une empreinte qui ne joue pas son rôle) ; si le
 * navigateur le refuse, l'empreinte fait son travail. Ce que ferait un vrai code malveillant avec les droits du widget est mesuré à part (essais 8 et 9).
 * @returns {{servies: Map<string, object>, marqueurs: Map<string, string>}} marqueurs : identifiant posé → adresse du fichier
 */
export function alterer(servies) {
  const alterees = new Map(); const marqueurs = new Map();
  for (const [url, fichier] of servies) {
    if (fichier.status !== 200 || !fichier.corps) { alterees.set(url, fichier); continue; }
    const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 8);
    marqueurs.set(id, url);
    const marque = `\n;(globalThis.__gw_altere||(globalThis.__gw_altere=[])).push(${JSON.stringify(id)});\n`;
    alterees.set(url, { ...fichier, corps: Buffer.concat([fichier.corps, Buffer.from(marque)]) });
  }
  return { servies: alterees, marqueurs };
}
