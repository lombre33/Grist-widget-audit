# Archive — audit hébergé « V2 » (VPS), mis de côté

## Statut

Le projet d'héberger l'audit sur un serveur (Debian 13, Docker) pour que des
inconnus soumettent le lien d'un widget n'ira pas plus loin : l'outil n'est
utilisé qu'en local, sous Windows 11. Le code et la documentation de ce projet
ont été **retirés de `main`** le 2026-11-25, et ce document dit ce qui existait,
ce qui était prouvé, et comment tout retrouver pour une reprise éventuelle.

La brique avait été conçue, construite et vérifiée par GitHub Actions, **jamais
déployée ni lancée sur un VPS**. Rien de ce qui suit n'a donc tourné en
production.

## Retrouver le code

Tout est dans l'historique git, au dernier commit qui le contient :
**`c738e1a`** (dernier commit de `main` avant le retrait).

```powershell
git show c738e1a:docs/ARCHITECTURE-V2.md            # le document de conception complet (46 Ko)
git show c738e1a:docker/README-V2-VERIFICATIONS.md  # ce que la CI prouve, ce qui reste au VPS
git ls-tree -r --name-only c738e1a docker           # tous les fichiers du dossier docker/ d'alors

# Remettre toute la brique dans l'arbre de travail (sans toucher au reste) :
git restore --source=c738e1a -- docker docs/ARCHITECTURE-V2.md .github/workflows/image-v2.yml .dockerignore
```

Ne restent dans `docker/` que `README.md` et `docker-compose.yml` : l'essai
manuel d'un widget dans un vrai Grist (Docker Desktop), qui n'a rien à voir avec
l'hébergement.

## Ce qui existait

| Chemin (à `c738e1a`) | Rôle |
|---|---|
| `docs/ARCHITECTURE-V2.md` | conception : deux zones de confiance, cycle de vie d'un audit, isolation, quatorze écarts du moteur recensés (état de chaque correction), décisions d'Antoine |
| `docker/execution/Dockerfile`, `entrypoint.sh` | image d'exécution : image Playwright officielle épinglée par empreinte, utilisateur `pwuser`, un conteneur = un audit, plafond de durée de 480 s (`timeout -k 10`), refus de la dérogation au bac à sable |
| `docker/execution/seccomp-chromium.json` (+ `.md`, `.sha256`, licence et NOTICE Apache-2.0) | profil seccomp de Playwright v1.63.0 repris à l'identique (empreinte épinglée), qui autorise les espaces de noms utilisateur dont le bac à sable de Chromium a besoin |
| `docker/egress-proxy/Dockerfile`, `squid.conf` | proxy de sortie Squid : tunnels CONNECT seulement vers `github.com`, `gitlab.com`, `registry.npmjs.org`, refus des adresses privées après résolution, pas de cache ni de journal |
| `docker/docker-compose.v2-execution.yml` | l'enveloppe : réseau `internal`, rootfs en lecture seule, `cap_drop: ALL`, limites (voir plus bas) |
| `docker/ci/verifier.sh` | les scénarios de vérification, rejouables sur toute machine Linux avec Docker : `build`, `audit`, `securite`, `proxy`, `plafond`, `memoire`, `publication`, `tout` |
| `docker/ci/publier.sh`, `.github/workflows/image-v2.yml` | publication sur `ghcr.io` (`gwaudit-execution`, `gwaudit-egress-proxy`) sur une étiquette `v*`, en quatre jobs dont un seul avec le droit d'écrire des paquets |
| `docker/ci/derive-empreintes.mjs`, `lib-images.mjs` | contrôle périodique : l'étiquette d'une image de base désigne-t-elle encore l'empreinte épinglée ? |
| `docker/ci/verifier-rapport.mjs`, `sonde-reseau.mjs`, `sonde-sandbox.mjs` | contrôle du rapport JSON produit dans le conteneur, sonde « le réseau est fermé », sonde `chrome://sandbox` |
| `tests/images-epinglees.test.mjs`, `derive-empreintes.test.mjs`, `orphelin-pgrep.test.mjs` | tests de ces fichiers (faux registre local compris) |
| `scripts/mutants-images.mjs`, `mutants-derive-empreintes.mjs`, `mutants-orphelin.mjs` | mutants de ces tests |
| `.dockerignore` | contexte de construction réduit à `bin/`, `src/`, `ressources/`, `package*.json` |

Gardés, parce qu'ils servent sous Windows : `scripts/verifier-windows.mjs` et
`scripts/integrite-chrome.ps1` (ex-`docker/ci/`), la preuve que le bac à sable de
Chromium est actif sous Windows (niveau d'intégrité des processus de rendu).

## L'architecture, en bref

**Deux zones étanches.** La zone « site » (quotas, file d'attente, base des
résultats, formulaire) n'exécute jamais de code audité ; la zone « exécution »
(confiance zéro) fait tourner `gwaudit` tel quel, sans fork « serveur », dans un
conteneur jetable : un job, un conteneur, détruit ensuite, qui ne rend que le
rapport JSON. Jamais de `docker.sock` ni de secret du site dans la zone
d'exécution, jamais de `network_mode: host`.

**Enveloppe du conteneur** (référence : le compose ; qui déploie autrement doit
tout reproduire, sinon l'audit échoue ou tourne avec moins d'isolation sans le
dire) :

| Réglage | Pourquoi |
|---|---|
| utilisateur `pwuser`, `read_only`, `tmpfs` `/tmp` **avec `exec`** | rien d'écrit hors du travail du job ; l'axe D exécute un lanceur de Chromium sous `/tmp` (en `noexec`, il échoue en `EACCES`) |
| `cap_drop: ALL`, `no-new-privileges`, `pids_limit: 128`, `mem_limit` = `memswap_limit` = 768 Mo, `cpus: 1.0` | enveloppe de base ; la limite mémoire est la seule vraie limite de mémoire **résidente** (un `ulimit -v` est inutilisable avec Chromium) |
| `seccomp=seccomp-chromium.json` + `cap_add: SYS_CHROOT` | sans les deux, Chromium ne démarre pas avec son bac à sable (« No usable sandbox! », puis `sys_chroot`) ; chacun a son témoin en CI |
| ne pas poser `GWAUDIT_CHROMIUM_SANS_SANDBOX` | la dérogation est refusée par `entrypoint.sh` ; si Chromium ne démarre pas, on ajoute une couche d'isolation indépendante, on ne remet jamais `--no-sandbox` |
| réseau `internal: true` + `HTTP(S)_PROXY` vers `egress-proxy` | seule sortie : le proxy à liste blanche, qui résout lui-même le nom et refuse les plages privées (anti-rebinding), indépendamment de la validation faite dans `gwaudit` |
| `GWAUDIT_RESOLUTION_PAR_PROXY=1` | le réseau fermé n'a pas de DNS : la résolution et le refus des adresses internes reviennent au proxy (voir « Code retiré du moteur ») |
| `/out` inscriptible par l'uid 1000 | le rapport y est écrit |

**Cycle de vie** : soumission (validation de forme, quota, file) ; conteneur
dédié ; clonage contrôlé (https seulement, hôte résolu et vérifié, plafond de
durée) ; inventaire plafonné ; axes statiques ; axe D durci ; `npm audit` dans un
dossier neutre ; hash du commit réellement audité rattaché au rapport ; résultat
indexé par `(URL, commit, version de gwaudit)`, présenté comme figé et périmé si
le dépôt a bougé depuis.

**Contrat de sortie du conteneur** : `0` conforme ; `1` sous réserve ou non
conforme sans bloquant ; `2` au moins un bloquant (un verdict, pas une panne) ;
`3` erreur interne ; `4` cible refusée ou inaccessible ; `124`/`137` coupé par le
plafond de durée (`GWAUDIT_PLAFOND_S`, 480 s) ; `137` avec `OOMKilled` si le
noyau a tué le processus pour cause de mémoire.

**Pourquoi un plafond de durée au niveau du conteneur** : une expression
régulière à retour arrière catastrophique (règle `F-RGAA-05`, corrigée depuis)
avait bloqué un audit ; or un thread Node bloqué ne peut pas s'interrompre
lui-même, seul un mécanisme extérieur au processus le coupe.

## Ce qui était prouvé, et ce qui ne l'était pas

Prouvé par GitHub Actions (runner Linux, cgroups v2) : construction des deux
images ; audit réel de `fixtures/widget-exemple` dans le conteneur durci, axe D
compris, Chromium **sans** `--no-sandbox` (arguments du vrai processus relevés) ;
non-root, aucune capacité, rootfs en lecture seule, réseau fermé (avec témoin sur
réseau ouvert) ; `chrome://sandbox` « adequately sandboxed », avec les deux
réglages nécessaires prouvés par deux témoins qui échouent ; proxy : hôte autorisé
joint, hôtes hors liste et nom autorisé fixé à `127.0.0.1` refusés par le proxy,
SSH sans route ; plafond de durée et aucun Chromium orphelin ; widget qui alloue
sans fin contenu (`OOMKilled`) ; publication à blanc sur un registre local.

La première vraie construction a corrigé cinq défauts invisibles à la relecture :
un compose dont le contexte de construction ne pouvait pas marcher, un mauvais
chemin de Chromium, un `/tmp` en `noexec`, un audit d'URL qui échouait dans la
zone fermée (pas de DNS), et un Chromium qui tournait sans bac à sable parce que
Playwright ajoute lui-même `--no-sandbox`. « Écrit et relu » ne valait pas
« construit et éprouvé ».

**Jamais prouvé** : tout ce qui est propre au VPS (noyau, espaces de noms
utilisateur, AppArmor, version de Docker, swap) ; les droits du jeton
`packages: write` et la visibilité du paquet sur `ghcr.io` (aucune étiquette `v*`
n'a jamais été poussée, rien n'est publié) ; la file d'attente, l'appel du
conteneur avec l'URL soumise et le montage de `/out`, jamais écrits (périmètre
tranché : ce dépôt devait livrer la brique, l'intégration revenait au projet qui
déploierait).

## Décisions prises avec Antoine (2026-09-28)

- Soumission **anonyme**, sans compte : donc toute URL passe par la validation de
  `gwaudit` puis par le proxy, deux couches qui doivent rester indépendantes.
- Verdict **figé à l'instant t** (commit audité), présenté comme périmé si le
  dépôt a bougé ; pas d'invalidation automatique.
- Volume **faible**, file qui sérialise un job à la fois : Docker durci plutôt
  qu'une microVM ; l'exposition réelle est le nombre d'audits simultanés, pas leur
  durée.
- **Informer, jamais bloquer** : le verdict mesure un risque, il ne prononce pas
  de sentence.

## Ce qui est resté dans le moteur, et ce qui en est sorti

Les quatorze écarts du moteur que la conception avait fait ressortir (en comptant
10a, 10b, 10c à part) : **dix corrigés, deux atténués, deux ouverts**, et les
correctifs sont restés dans l'outil parce qu'ils valent aussi en local :

- validation de l'hôte à cloner (`bin/gwaudit.js`, `validerHoteClone`) : adresses
  internes refusées, `\` et userinfo refusés (le parseur d'URL de Node et libcurl
  ne coupent pas l'autorité au même endroit), IPv6 entre crochets ; clone avec
  délai, dossier temporaire sous `os.tmpdir()` et toujours purgé ;
- `npm audit` / `npm view` dans un dossier neutre, `HOME` isolé, `.npmrc` du dépôt
  audité jamais lu (`src/regles/npm-isole.js`) ;
- bac à sable de Chromium demandé par défaut (`chromiumSandbox: true`) ;
  dérogation explicite `GWAUDIT_CHROMIUM_SANS_SANDBOX=1`, dite dans le rapport
  (`D-INDISPONIBLE-BAC-A-SABLE`) ;
- hash du commit audité dans le rapport ; plafonds d'inventaire (fichiers,
  octets) ; délai global de l'axe D ; origine exacte du harnais ; WebSocket
  neutralisé (`routeWebSocket`) ; `--host-resolver-rules` et
  `--proxy-server=direct://`.

Atténués seulement : WebRTC par adresse IP littérale (son sous-système ICE/UDP ne
passe pas par le résolveur) et l'enregistrement d'un Service Worker. **Ouverts
parce qu'ils n'ont de sens que pour un service hébergé** : une vraie limite de
mémoire résidente par job (demande des cgroups) et une limite de concurrence.

### Code retiré du moteur (spécifique à l'hébergement)

Retiré de `bin/gwaudit.js` au moment du retrait ; à remettre si la brique revient.
Dans `validerHoteClone`, juste avant la résolution locale :

```js
if (resolutionParProxy() && !net.isIP(hote) && !contourneLeProxy(hote)) {
  if (/^git@/i.test(cible)) {
    throw new CibleRefusee(`Clonage refusé : une URL SSH (git@) ne peut pas passer par le proxy de sortie de la zone d'exécution — utiliser une URL https:// : ${cible}`);
  }
  return; // le proxy résout le nom et refuse l'adresse interne, à la connexion
}
```

```js
// Actif seulement si l'appelant l'a demandé ET qu'un proxy est réellement configuré.
function resolutionParProxy() {
  return process.env.GWAUDIT_RESOLUTION_PAR_PROXY === '1' && Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);
}

// NO_PROXY / no_proxy fait joindre cet hôte sans proxy : la résolution locale redevient exigée.
function contourneLeProxy(hote) {
  const nom = hote.toLowerCase();
  for (const cle of ['NO_PROXY', 'no_proxy']) {
    for (const brute of String(process.env[cle] ?? '').split(',')) {
      const entree = brute.trim().toLowerCase().replace(/:\d+$/, '').replace(/^\./, '');
      if (!entree) continue;
      if (entree === '*' || nom === entree || nom.endsWith(`.${entree}`)) return true;
    }
  }
  return false;
}
```

Et dans `expliquerEchecClonage`, un message dédié quand le proxy de sortie répond 403
(`CONNECT tunnel failed, response 403`, hôte hors liste ou nom résolu vers une
adresse interne). Les tests de ce mode étaient dans `tests/ssrf.test.mjs` (un faux
proxy qui note les `CONNECT`) et les mutants dans `scripts/mutants-ssrf.mjs` ;
retrouver les deux à `c738e1a`. Sorti aussi de `src/interface/serveur.js` : la
variable `GWAUDIT_INTERFACE_HOTE`, qui permettait de lier l'interface web à autre
chose que `127.0.0.1` « derrière l'isolation d'un conteneur ». L'interface n'écoute
plus que sur `127.0.0.1`.

## Reprendre un jour

1. Restaurer les fichiers (commande plus haut), puis remettre le code retiré du
   moteur ci-dessus et les tests de `tests/ssrf.test.mjs` du mode proxy.
2. **Rafraîchir les empreintes** : l'image de base du proxy (`debian:bookworm-slim`)
   et celle de l'exécution (`mcr.microsoft.com/playwright:v1.63.0-jammy`) sont
   épinglées à la date de septembre 2026 ; `node docker/ci/derive-empreintes.mjs`
   dit si une étiquette a été republiée. Garder la version de Playwright de l'image
   alignée sur `package.json`.
3. Rejouer `docker/ci/verifier.sh` sur le VPS (`bash docker/ci/verifier.sh tout` :
   Linux, Docker, cgroups v2, accès à `github.com` et `registry.npmjs.org`). À y
   regarder en premier : le bac à sable
   de Chromium (noyau, AppArmor), la limite mémoire (`docker info | grep -i cgroup`,
   swap), le chemin relatif du profil seccomp dans le compose selon la version de
   Docker.
4. Écrire ce qui n'a jamais existé : la file qui sérialise les jobs, l'appel du
   conteneur avec l'URL soumise, le montage de `/out`, les quotas par IP.
5. Premier `v*` : vérifier la visibilité du paquet sur `ghcr.io` (privé par défaut ;
   `publier.sh` dit quoi cliquer).
6. Points relevés par l'étude RSSI de l'époque, à ne pas perdre : le filtre de
   domaine de Squid (`.github.com` est un suffixe ancré sur les frontières de
   labels, `registry.npmjs.org` exclut ses sous-domaines) ; `reseau-ferme` ferme
   tout protocole, SSH compris, par absence de route, pas par un réglage de client ;
   `pids_limit: 128` peut faire échouer la création d'un seul processus de rendu et
   laisser un rapport d'apparence complète (à éprouver : un dépassement doit donner
   un échec franc) ; `entrypoint.sh` choisit `chrome-linux*/chrome` par `head -n1`
   sans signaler qu'il y en aurait deux.
7. Une routine de fraîcheur de l'image (« Fraîcheur image Docker V2 ») prévenait
   quand `bin/`, `src/`, `ressources/` ou `package*.json` avaient bougé depuis la
   dernière construction : sans image, elle n'a plus d'objet.
