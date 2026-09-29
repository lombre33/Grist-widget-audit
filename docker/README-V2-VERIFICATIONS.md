# Vérifications de l'image V2

L'image d'exécution (`docker/execution/`) et le proxy de sortie
(`docker/egress-proxy/`) se construisent et sont vérifiés par GitHub Actions
(`.github/workflows/image-v2.yml`, bouton « Run workflow » ou étiquette `v*`).
Chaque vérification est une commande de `docker/ci/verifier.sh`, qui échoue
au lieu de passer quand l'essai ne peut rien prouver : un blocage attendu a
toujours un témoin (la même commande sur un réseau ouvert, sous le profil par
défaut…) et une coupure n'est acceptée qu'après avoir constaté que la chose à
couper tournait.

Rejouer la même chose sur n'importe quelle machine Linux avec Docker (cgroups
v2, accès à github.com et registry.npmjs.org), depuis la racine du dépôt :

```bash
bash docker/ci/verifier.sh tout        # ou un seul : build | audit | securite | proxy | plafond | memoire | publication
```

## Ce que la CI éprouve

| Sous-programme | Ce qui est prouvé | Comment |
|---|---|---|
| `build` | les deux images se construisent depuis la racine du dépôt (le compose a un contexte de construction qui le permet) | `docker compose build` |
| `audit` | un vrai audit de `fixtures/widget-exemple` s'exécute dans le conteneur durci, **axe D compris**, sans axe non exécuté ni partiel ; Chromium y tourne **sans `--no-sandbox`** ; aucun Chromium ne survit ensuite (contrôle repris après l'audit d'une URL et après le widget qui alloue sans fin) | rapport JSON contrôlé par `docker/ci/verifier-rapport.mjs` ; arguments du vrai processus Chromium relevés pendant l'audit (`docker top`), échec s'il n'y en a aucun ou si `--no-sandbox` y figure |
| `securite` | non-root, aucune capacité effective, `no-new-privileges`, rootfs en lecture seule et `/tmp` inscriptible, réseau fermé (le conteneur n'atteint pas Internet) ; **le bac à sable de Chromium démarre** sous cette enveloppe ; la dérogation `GWAUDIT_CHROMIUM_SANS_SANDBOX` est **refusée** par l'image (l'audit ne démarre pas, aucun rapport) | `/proc/self/status` ; sonde `docker/ci/sonde-reseau.mjs` (témoin sur réseau ouvert) ; sonde `docker/ci/sonde-sandbox.mjs` qui lit `chrome://sandbox` (« adequately sandboxed ») et qui **échoue** sous le profil seccomp par défaut de Docker (témoin) |
| `proxy` | un hôte autorisé (github.com) se joint à travers le proxy ; deux hôtes hors liste blanche (dont un nom qui commence comme un hôte autorisé) sont refusés **par le proxy** (403) ; SSH n'ouvre pas de voie parallèle (échec par le réseau, pas par les identifiants : témoin sur réseau ouvert) ; un nom autorisé qui se résout vers 127.0.0.1 est refusé (anti-rebinding) ; l'audit d'une URL réelle va jusqu'au bout, clone et `npm audit` à travers le proxy | `git ls-remote`, proxy jetable avec `--add-host github.com:127.0.0.1`, audit de `lombre33/Grist_Table_structure_import` |
| `plafond` | un `gwaudit` bloqué en boucle synchrone, avec un Chromium lancé, est coupé au plafond de durée (code 124) et aucun Chromium ne survit à la destruction du conteneur ; le vrai audit d'un widget qui boucle sans fin conclut de lui-même, sans Chromium orphelin | `gwaudit` de substitution monté sur `bin/gwaudit.js` (vrai `entrypoint.sh`, vraie image), `GWAUDIT_PLAFOND_S=20`, `pgrep` sur l'hôte ensuite |
| `memoire` | un widget qui alloue sans fin est contenu : mémoire du conteneur sous la limite, `OOMKilled` à vrai (le noyau tue le rendu de Chromium), swap exclu ; l'audit conclut malgré tout par un verdict | `docker stats` échantillonné, `docker inspect` |
| `publication` | `docker/ci/publier.sh` : étiquette invalide refusée ; une version d'essai (`v1.2.3-rc1`) ne déplace pas `latest` ; une version finale le déplace, pour les deux images ; l'image publiée porte l'étiquette de source et la révision exacte | registre local, sans identifiants (à blanc : rien n'est publié) |

Sur ghcr.io, le premier `v*` publie vraiment, et `publier.sh` dit ensuite si le
paquet est public (tirable sans identifiants) ou privé (et alors quoi cliquer
dans GitHub : profil → Packages → le paquet → Package settings → Change
visibility). Ce que la publication à blanc ne peut pas voir : les droits du
jeton et la visibilité.

## Ce qui ne s'éprouve que sur le VPS

Le runner GitHub n'est pas le VPS : mêmes scénarios, autre noyau. À rejouer
(`bash docker/ci/verifier.sh tout`) sur le VPS, en regardant surtout :

- **Le bac à sable de Chromium** : il dépend du noyau (espaces de noms
  utilisateur non privilégiés autorisés, pas de restriction AppArmor
  qui les interdise) autant que du profil seccomp. Si `securite` échoue sur la
  sonde de bac à sable, ne jamais céder et remettre `--no-sandbox` : ajouter
  une couche d'isolation indépendante de Chromium (voir
  `docs/ARCHITECTURE-V2.md` §4).
- **La limite mémoire** : cgroups v2 confirmé sur le runner ; `docker info |
  grep -i cgroup` sur le VPS, et le swap (`memswap_limit` du compose l'exclut
  s'il est pris en charge).
- **La version de Docker** : le compose relit le profil seccomp par un chemin
  relatif à lui-même ; à confirmer sur la version installée.
- **L'usage réel** : ce dépôt livre la brique ; la file qui sérialise les jobs,
  l'appel du conteneur avec l'URL soumise et le montage de `/out` sont
  l'intégration (`docs/ARCHITECTURE-V2.md` §5). `/out` doit être inscriptible
  par l'uid 1000 (`pwuser`).

## Codes de sortie du conteneur

`0` CONFORME · `1` SOUS RÉSERVE ou NON CONFORME sans bloquant · `2` au moins un
bloquant (un verdict, pas une panne) · `3` erreur interne de gwaudit · `124`
(ou `137`) coupé par le plafond de durée (`GWAUDIT_PLAFOND_S`, 480 s par défaut) ·
`137` avec `OOMKilled` si le noyau a tué le processus principal pour cause de
mémoire. Un code 124 ou 137 ne garantit pas que les rapports ont été écrits.

## Ce que la CI a corrigé

Chacun de ces défauts était invisible à la relecture et est apparu à la
première exécution réelle : un compose qui ne pouvait pas construire (contexte
de construction), un chemin de Chromium faux, un `/tmp` en `noexec` qui
empêchait l'axe D de démarrer, un audit d'URL qui échouait dès la première
étape dans la zone fermée (pas de DNS : `GWAUDIT_RESOLUTION_PAR_PROXY=1`), et
un Chromium qui tournait sans bac à sable parce que Playwright ajoute
`--no-sandbox` de lui-même (gwaudit demande désormais le bac à sable par
défaut ; profil seccomp et `SYS_CHROOT` en conteneur). Le détail est dans `docs/ARCHITECTURE-V2.md` (constat 3 et §7).
