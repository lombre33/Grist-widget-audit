# Architecture V2 — audit hébergé (esquisse)

## Statut de ce document

Conception et outillage, pas de déploiement : rien de ce qui suit n'a tourné
sur l'infrastructure d'Antoine, et rien ici ne touche son VPS. En revanche
l'image d'exécution et le proxy de sortie **se construisent et sont vérifiés
par GitHub Actions** (`.github/workflows/image-v2.yml`, scénarios dans
`docker/ci/verifier.sh`, rejouables à la main sur toute machine Docker sous
Linux) : audit réel dans le conteneur durci, bac à sable de Chromium, réseau
fermé, liste blanche du proxy, plafond de durée, limite mémoire. Ce que cela
prouve, et ce qui ne se prouve que sur le VPS, est dans
`docker/README-V2-VERIFICATIONS.md`. Cette construction a corrigé des défauts
que la relecture n'avait pas vus (voir le constat 3 ci-dessous et le §7).

## 1. Ce qui change de fond en comble

La V1 est un outil que **le développeur lance sur son propre code, sur sa
propre machine** : la confiance est déjà là avant même que l'outil
démarre. La V2 inverse cette hypothèse — c'est **un inconnu qui soumet un
code qu'il n'a pas écrit**, exécuté sur l'infrastructure d'Antoine, sous
son identité de service, pour que d'autres décident de l'installer ou non.
Tout ce que la V1 a pu se permettre parce que « c'est moi qui tape la
commande » doit être revu avec cette hypothèse inversée.

Pour ancrer cette esquisse dans du réel plutôt que dans des généralités de
sécurité, une revue automatisée croisée (recherche indépendante + relecture
de vérification systématique du fichier cité, pour chaque point) a confirmé
le 2026-09-19, dans le code d'alors, 15 constats bruts regroupés ici en 12
écarts distincts entre ce que le code fait et ce qu'exige ce changement de
contexte de confiance. Aucun n'était un défaut de la V1 en tant que tel —
c'était un outil qui faisait ce qu'on lui demandait, pour l'usage auquel il
était destiné.

**Statut vérifié le 2026-09-20**, trois fois, en relisant le code du dépôt
public à mesure des correctifs — aux commits `b3c372f`, `1f5840d` puis
`c31d6fb` — pas seulement rapporté. Le compte a changé à chaque relecture ;
ce qui suit est la dernière, à jour.

### Corrigés

| # | Constat (état au 2026-09-19) | Fichier | Correction vérifiée |
|---|---|---|---|
| 1 | `git clone` recevait l'URL soumise sans résolution d'hôte ni liste blanche — SSRF | `bin/gwaudit.js` | `resoudreCible()` appelle `validerHoteClone()` avant tout clonage : résolution DNS puis rejet des adresses privées/loopback/lien-local/métadonnées cloud, refus du `http://` non chiffré. **Ce correctif avait lui-même un trou**, trouvé par revue adversariale le 2026-09-20 et corrigé au commit `19c0134` : `new URL()` normalise un `\` littéral en `/` avant de chercher la limite `userinfo@hôte`, alors que git/libcurl (RFC 3986) ne le font pas — une cible comme `https://hote-public.example\@CIBLE-INTERNE/x` passait la validation (hôte calculé : le domaine public) pendant que git se connectait réellement à `CIBLE-INTERNE`. Reproduit avec un vrai `git ls-remote`, fermé en rejetant tout `\` littéral et tout userinfo explicite avant la résolution DNS, non-régression prouvée par un test qui écoute réellement sur un port local (`tests/ssrf.test.mjs`). Toujours pas de protection anti-DNS-rebinding entre la vérification et la connexion — laissé au proxy de sortie V2 (§4), qui n'a structurellement pas ce type de trou : voir §4. |
| 2 | `npm audit` héritait tout `process.env` et lisait le `.npmrc` du dépôt audité | `src/regles/e-dependances.js` | `npmAudit()` copie seulement `package.json`/`package-lock.json` dans un dossier neutre, avec un environnement dédié (`HOME` isolé, `npm_config_userconfig` pointé sur un `.npmrc` vide, `npm_config_registry` figé sur `registry.npmjs.org`, proxy d'entreprise transmis explicitement) : le `.npmrc` du dépôt audité n'est jamais lu. |
| 3 | Chromium était lancé avec `--no-sandbox` | `src/runtime/dynamique.js` | ~~Sandbox natif actif par défaut ; `--no-sandbox` seulement si `GWAUDIT_CHROMIUM_SANS_SANDBOX=1` est positionnée explicitement.~~ **Faux, rectifié le 2026-09-29** : Playwright ajoute lui-même `--no-sandbox` tant que `chromiumSandbox: true` n'est pas passé à `launch()`/`launchServer()`, ce que rien ne faisait — vu dans les arguments du vrai processus Chromium, sous `pwuser` dans le conteneur. Le widget audité tournait donc toujours sans bac à sable, en V1 comme en V2. **Corrigé et vérifié le 2026-09-29** : le bac à sable est demandé par défaut partout (`chromiumSandbox: true`) ; la seule dérogation est `GWAUDIT_CHROMIUM_SANS_SANDBOX=1`, explicite, et l'axe D pose alors le marqueur d'information `D-INDISPONIBLE-BAC-A-SABLE` (JSON et HTML, sans effet sur le verdict). Quand Chromium ne peut pas démarrer avec son bac à sable (root, espaces de noms utilisateur interdits, AppArmor, profil seccomp par défaut de Docker), `D-INDISPONIBLE` nomme cette cause précise et donne les deux issues (corriger l'environnement, ou déroger en sachant ce que ça expose) ; ce conseil n'est donné que pour cette cause. **Dans l'image V2 la dérogation est refusée** : `entrypoint.sh` échoue si la variable est posée. Éprouvé en conteneur : voir §4. |
| 4 | Aucun hash de commit rattaché au rapport | `bin/gwaudit.js` | `commitDepot()` (`git rev-parse HEAD`) inclus dans `meta.commit` ; identité du dépôt tirée de l'URL réelle. |
| 8 | Le passe-droit réseau « local » ne comparait que le *hostname* | `src/runtime/dynamique.js` | Compare désormais l'origine exacte (`urlOrigine === origine`, protocole + hôte + port), pas seulement le hostname. |
| 9 | Aucun plafond de fichiers/octets cumulés pendant l'inventaire | `src/contexte/inventaire.js` | `MAX_FICHIERS` (20 000) et `MAX_OCTETS_LUS_CUMULES` (200 Mo), avec troncature explicite plutôt que crash, signalée dans `ctx.tronque`. |
| 10a | Aucun timeout global sur l'axe D après le chargement initial | `src/runtime/dynamique.js` | Tout le scénario (chargement + évaluations + a11y) est couru contre `DELAI_GLOBAL_AXE_D_MS` (45 s par défaut) via `avecDelai()`, qui lève le constat `D-TIMEOUT-01` en cas de dépassement. |
| 10b | Aucune limite de temps CPU sur le processus Chromium | `src/runtime/dynamique.js` | Chromium est lancé via un script qui pose `ulimit -t` (RLIMIT_CPU) avant un `exec` (donc sans changer de PID : les processus que Chromium fait naître — zygote, rendu, GPU — héritent la même limite dès leur création), fixée à `DELAI_GLOBAL_AXE_D_MS` + 30 s. **Mesuré le 2026-09-20 (commit `e99aba0`) : ce plafond n'a structurellement pas l'occasion de s'exercer en usage réel.** Un widget qui bloque le thread principal dès le chargement fait expirer le timeout propre de Playwright (30 s) et ferme Chromium en ~1 s, bien avant les 75 s du plafond ; un widget qui charge normalement puis sature tous les cœurs en arrière-plan (Web Workers) ne retarde aucune étape qui gouverne la durée du scénario — l'audit se termine en quelques secondes, sans processus survivant. Les deux formes de widget hostile testées : dans aucune, le plafond CPU n'est le mécanisme qui a mis fin à l'exécution. **Reste un filet de sécurité en profondeur pour un cas non encore rencontré, pas la protection qui agit en pratique** — même verdict que pour la mémoire (constat 10c) : la vraie limite CPU par job en V2 viendra du conteneur (cgroups v2 via Docker, §4), pas d'un réglage de lancement dans le process. |
| 5 | WebSocket hors de portée de `route()` — aucune trace dans le rapport, passe-droit `127.0.0.1`/`localhost` sans vérification d'origine | `src/runtime/dynamique.js` | **Requalifié en deux temps le 2026-09-20.** D'abord vérifié à l'exécution (un vrai Chromium avec `--host-resolver-rules`, face à un vrai écouteur TCP) : cette couche bloquait déjà toute cible externe réelle, nom d'hôte ou IP littérale — contrairement à l'hypothèse initiale par analogie avec WebRTC (constat 6), dont le sous-système ICE/UDP séparé ne consulte pas le même résolveur. Restait un trou plus étroit : le passe-droit Chromium vers `127.0.0.1`/`localhost` (nécessaire pour le harnais) n'a pas de restriction de port, et la vérification d'origine exacte (constat 8) n'existe que dans `context.route()` — aveugle à WebSocket. Fermé au commit `670df9d` : `contexte.routeWebSocket('**/*', ...)` enregistre chaque tentative dans `brut.requetes` (remontée en `D-RESEAU-01`, même pipeline que le HTTP) et ferme la connexion sans jamais appeler `connectToServer()` — une route WebSocket enregistrée ne se connecte par défaut jamais au serveur réel, donc ce seul geste neutralise n'importe quelle destination sans exception, `127.0.0.1` compris (le harnais RPC parle par `postMessage`, jamais par WebSocket : aucun besoin de passe-droit ici, contrairement au HTTP). Non-régression prouvée par un test qui écoute réellement sur un port local et vérifie qu'aucune connexion n'y arrive (`tests/dynamique-websocket.test.mjs`), exécuté ici avec succès. |
| 12 | `git clone` sans timeout, dossier temporaire jamais supprimé | `bin/gwaudit.js` | `timeout: 120_000` sur le clone ; `main()` dans un `try/finally` qui purge systématiquement. |

### Atténués, mais pas structurellement fermés

Ces deux-là gardent la même limite qu'avant au niveau de l'API Playwright
(`context.route()` ne les voit toujours pas), et une nouvelle couche
ajoutée en même temps que le reste réduit le risque réel en pratique :
`chromium.launch()` reçoit désormais `--host-resolver-rules=MAP *
0.0.0.0,EXCLUDE 127.0.0.1,EXCLUDE localhost` et `--proxy-server=direct://`
(avec les variables `*_PROXY` retirées de l'environnement du process
Chromium), qui coupent la résolution de tout nom de domaine réel — y
compris pour du trafic que `route()` ne voit pas. Le WebSocket (constat 5,
ci-dessus) est passé en corrigé après vérification empirique de cette
couche puis fermeture applicative du passe-droit local restant ; WebRTC
reste structurellement différent, son sous-système ICE/UDP séparé ne
consultant pas ce même résolveur pour une cible IP littérale.

| # | Constat | Ce que la nouvelle couche change | Ce qui reste ouvert |
|---|---|---|---|
| 6 | WebRTC hors de portée de `route()` | Bloque un serveur STUN/TURN désigné par nom d'hôte | Une cible WebRTC désignée par adresse IP littérale contourne ce blocage : son sous-système ICE/UDP ne passe pas par `net::HostResolver`, donc aucune règle de résolution ne l'arrête — structurellement différent de WebSocket (constat 5, désormais corrigé), pas seulement pas encore testé |
| 7 | `serviceWorkers` laissé à `allow` | Les requêtes d'un Service Worker vers un nom d'hôte réel échouent aussi désormais | L'enregistrement du Service Worker lui-même reste possible (`newContext()` ne passe toujours pas `serviceWorkers: 'block'`) |

### Encore ouverts

| # | Constat | Fichier | Statut |
|---|---|---|---|
| 10c | Aucune limite de MÉMOIRE sur le processus Chromium | `src/runtime/dynamique.js` | Essayé et écarté, pas seulement pas encore fait : `ulimit -v` (RLIMIT_AS, mémoire virtuelle) est inutilisable avec Chromium, dont un renderer réserve normalement jusqu'à ~1,4 To d'espace d'adressage virtuel pour quelques dizaines de Mio réellement utilisés — une limite de 2 Gio, très au-dessus des ~200 Mio résidents d'un audit réel, empêche déjà Chromium de démarrer ; il n'y a pas de valeur intermédiaire qui fonctionne. Une vraie limite veut la mémoire **résidente**, donc des cgroups, donc la zone d'exécution V2 (§4) — un réglage de lancement ne peut structurellement pas la fournir. |
| 11 | Aucune limite de concurrence, pas de file d'attente | — | N'a pas de sens pour un outil en ligne de commande (un `gwaudit` = un process séquentiel). Propre à l'orchestration V2 (§5), qui n'existe pas encore. |

Sur les 12 écarts distincts d'origine (14 en comptant 10a/10b/10c
séparément, plus précis que de les garder groupés) : **10 sont corrigés, 2
sont atténués sans être structurellement fermés, 2 restent ouverts** — et
cette fois les deux qui restent ouverts le sont pour une bonne raison
documentée dans le code, pas par défaut de temps : la concurrence (11) n'a
pas de sens hors d'un service hébergé, et la limite mémoire (10c) demande
structurellement des cgroups qu'un outil en ligne de commande ne peut pas
s'auto-attribuer.

Autrement dit, comme avant : **il n'existe aujourd'hui aucun service
hébergé par Antoine à mettre en défaut** — la V2 n'est pas déployée, donc
rien ci-dessus n'est une faille exploitable en production. Ce sont des
comportements réels du code publié, que toute personne qui exécute
`gwaudit --dynamique` (actif par défaut) sur un widget auquel elle ne fait
pas encore confiance expose à sa propre machine — dans l'usage même que la
V1 est censée couvrir, désormais nettement réduit par les correctifs
ci-dessus.

**Ce qui n'a pas besoin de changer** : les axes A, B, C et F restent de
l'analyse statique par AST (`acorn`), qui ne fait qu'analyser du texte sans
jamais l'exécuter — aucun de ces axes n'ouvre de surface nouvelle en V2. Le
point dur restant est concentré dans l'axe D (navigateur : limite mémoire,
canaux WebRTC/Service Worker) et dans l'orchestration multi-utilisateurs
(concurrence) que seule la V2 introduira.

## 2. Principe : deux zones de confiance étanches

- **Zone « site »** (confiance normale — l'infrastructure qui existe déjà
  sur le VPS d'Antoine) : quotas, file d'attente, base des résultats.
  Le formulaire de soumission, l'affichage des tests en cours et la page
  d'audit ne sont **pas** un front web écrit pour la V2 : c'est
  l'interface de `gwaudit` lui-même (`src/interface/`), le même code
  utilisé dans les 3 environnements (local, CI, VPS), possédée par le fil
  « Fonctionnalités de l'outil ». Le périmètre V2 se limite à la faire
  tourner en sécurité autour de cette interface partagée — isolation (§4),
  mise en file (§5), quotas et anti-abus (§5) — jamais à en écrire une
  version distincte. Cette zone **n'exécute jamais** de code audité.
- **Zone « exécution »** (confiance zéro — la deuxième instance Docker
  qu'Antoine évoque) : c'est là que `gwaudit` tourne réellement sur le code
  soumis. Elle n'a aucun accès entrant depuis l'extérieur ; elle consomme
  des jobs depuis la file et publie un résultat, rien d'autre. **C'est le
  même code que la V1** — un seul `gwaudit`, portable, pensé pour tourner
  identiquement en local (Windows/Linux/macOS) et empaqueté tel quel dans
  cette image : pas de variante ni de fork « serveur ».

Règles non négociables pour que la séparation soit réelle et pas seulement
nominale :
- Jamais le socket Docker (`/var/run/docker.sock`) monté dans la zone
  d'exécution — c'est l'erreur la plus commune qui annule tout le reste
  d'une isolation par conteneurs.
- Aucun secret, jeton ou identifiant du site (base de données, mailer,
  API…) n'est accessible depuis la zone d'exécution.
- La zone d'exécution ne conserve rien après un job : voir §4.
- Le conteneur d'un job ne partage jamais l'espace de noms réseau d'un
  autre processus ou conteneur (pas de `network_mode: host` ni équivalent)
  — c'est cette règle, pas une propriété de `gwaudit`, qui confine
  `127.0.0.1`/`localhost` au harnais de ce job et à rien d'autre. Voir §4.

## 3. Cycle de vie d'un audit

1. **Soumission** (zone site) : l'utilisateur donne une URL de dépôt.
   Validation de forme, quota (§5), mise en file.
2. Un worker de la zone d'exécution prend un job et démarre un conteneur
   **jetable, dédié à ce job et à lui seul**.
3. Dans ce conteneur, dans l'ordre :
   - clonage contrôlé — schéma restreint à `https://`, résolution DNS
     vérifiée puis re-vérifiée juste avant la connexion (anti-rebinding),
     plages privées/loopback/link-local rejetées, timeout, plafond de
     taille, cible dans une allowlist de forges si possible ;
   - inventaire avec plafonds explicites (nombre de fichiers, taille
     cumulée lue) ;
   - analyse statique (axes A, B, C, E-partie-statique, F) — déjà sûre,
     inchangée ;
   - analyse dynamique (axe D) durcie : sandbox Chromium natif demandé par
     défaut (`chromiumSandbox: true`, constat 3) ; dérogation explicite et
     dite dans le rapport,
     `routeWebSocket()` ajouté à côté de `route()`,
     `serviceWorkers: 'block'`, politique de désactivation WebRTC,
     comparaison à l'origine exacte du harnais (pas au seul hostname) pour
     le passe-droit local, timeout global forcé, plafonds CPU/mémoire/pids
     au niveau conteneur ;
   - `npm audit` (axe E) avec configuration forcée côté serveur
     (`--userconfig` dédié, registre figé, environnement du process
     restreint — sans hériter des secrets du worker) ;
   - calcul du hash de commit **réellement** audité, rattaché au rapport.
4. Le conteneur publie **uniquement le résultat** (JSON) sur le canal
   retour, puis est détruit — jamais réutilisé pour un autre job.
5. Zone site : le résultat est stocké indexé par
   `(URL normalisée, commit SHA, version de gwaudit)`, affiché à
   l'utilisateur avec cette identité explicite (« audité le <date>, commit
   `<sha>` »). Si le HEAD distant du dépôt change après coup, le verdict
   affiché doit se marquer périmé plutôt que de rester valide pour une URL
   dont le contenu a changé — c'est exactement le principe que l'outil
   applique déjà à un `package-lock.json` (règle `E-DEP-04` : *« L'audit qui
   a été fait ne vaut alors que pour l'instant où il a été fait »*),
   appliqué cette fois à sa propre sortie plutôt qu'à ce qu'il audite.

## 4. Isolation technique de la zone d'exécution

C'est le point dur, et celui qu'aucune validation locale ne peut
entièrement remplacer — à éprouver sur le VPS d'Antoine.

- **Conteneur** : utilisateur non root, `cap_drop: ALL` (pas d'ajout sauf
  strictement nécessaire), `no-new-privileges`, rootfs en lecture seule
  avec un `tmpfs` borné en taille pour l'espace de travail du job,
  `pids_limit`, limites CPU/mémoire, pas de `docker.sock`.
- **Chromium** : son bac à sable natif (espaces de noms utilisateur, seccomp)
  doit être actif — et il ne l'est pas par défaut : Playwright ajoute
  `--no-sandbox` de lui-même (constat 3, §1). Éprouvé en conteneur : sous le
  profil seccomp par défaut de Docker, Chromium refuse de démarrer avec son
  bac à sable (« No usable sandbox! ») ; avec le profil de Playwright
  (`docker/execution/seccomp-chromium.json`, qui autorise la création
  d'espaces de noms utilisateur) il abandonne encore sur `chroot()` faute de
  `CAP_SYS_CHROOT` dans l'ensemble borné ; avec le profil **et**
  `cap_add: SYS_CHROOT`, `chrome://sandbox` répond « You are adequately
  sandboxed » (couche 1 : espaces de noms, seccomp-BPF). Pour `pwuser` (non
  root) la capacité ajoutée reste hors de l'ensemble effectif : le noyau refuse
  toujours `chroot()` hors de l'espace de noms de Chromium. Ces deux réglages
  sont dans le compose ; le bac à sable lui-même est demandé par gwaudit par
  défaut, et l'image refuse la dérogation (`entrypoint.sh`) ; **qui déploie l'image
  sans ce compose doit les reproduire** (voir « Ce que l'image exige » plus
  bas). Le bon réflexe si un hôte ne le permet pas reste de ne pas céder et
  remettre `--no-sandbox` : c'est d'ajouter une deuxième couche d'isolation
  indépendante de Chromium (conteneur jetable + réseau fermé, voire microVM de
  type Firecracker/gVisor si le volume le justifie un jour), pour que le
  sandbox Chromium ne soit jamais la seule barrière.
- **Réseau pendant l'exécution du navigateur** : interdiction par défaut de
  toute sortie réelle (seule la boucle locale vers le harnais de la V1
  doit passer, sur l'origine exacte, pas sur un hostname générique). Ceci
  **complète**, sans les remplacer, les correctifs applicatifs Playwright
  ci-dessus — la revue a montré trois angles morts différents de `route()`
  (WebSocket, WebRTC, Service Worker) : la défense doit exister aux deux
  niveaux.
- **Ce n'est pas le proxy CONNECT ci-dessous qui ferme le trou
  WebSocket.** Question posée le 2026-09-20 par l'étude d'exhaustivité, par
  analogie avec la fermeture de la divergence de parseur d'URL (constat 1,
  §1) : le proxy CONNECT en liste blanche décrit au point suivant est-il
  structurellement immunisé contre le trou WebSocket de `route()` (constat
  5, §1), comme il l'est déjà contre cette divergence de parseur ? Non — les
  deux n'ont rien à voir. Ce proxy n'existe que pour `git clone` et `npm
  audit`, deux étapes qui ne passent jamais par un navigateur : le trafic
  du navigateur pendant l'axe D ne le traverse à aucun moment, qu'il
  s'agisse de HTTP(S) intercepté par `route()` ou de WebSocket qui y
  échappe. C'est le mécanisme du point précédent
  (`--host-resolver-rules` + `--proxy-server=direct://`) qui protège ce
  trafic-là, et il est structurellement différent : pas une liste blanche
  de destinations autorisées consultée requête par requête, mais un refus
  par défaut de toute résolution de nom réel à l'échelle du navigateur —
  vérifié à l'exécution pour WebSocket au constat 5.
- **Ce que devient `127.0.0.1`/`localhost` en conteneur, une fois le trou
  WebSocket fermé côté V1 (`670df9d`, §1 constat 5).** Le trou lui-même
  n'existe plus : `routeWebSocket('**/*', ...)` neutralise désormais toute
  destination sans exception, y compris `127.0.0.1`. Reste une question
  différente, posée le 2026-09-20 après cette fermeture : le passe-droit
  Chromium `EXCLUDE 127.0.0.1,EXCLUDE localhost` (nécessaire pour le HTTP
  du harnais, voir plus haut) reste-t-il, en exécution conteneurisée, aussi
  étroit qu'il l'est sur un poste de développeur — ou une boucle locale
  partagée entre services (l'`egress-proxy` de l'esquisse, un futur autre
  job) l'élargit-elle ? Non : Docker isole par défaut la boucle locale de
  chaque conteneur, tant qu'aucun ne tourne en `network_mode: host` ni ne
  partage autrement son espace de noms réseau (règle ajoutée au §2) — ce
  que l'esquisse (`docker-compose.v2-execution.yml`) ne fait déjà pas.
  `127.0.0.1` vu depuis Chromium dans `execution-audit` ne peut donc
  atteindre ni `egress-proxy` (un service Compose distinct, joignable
  seulement par nom sur le réseau), ni un autre conteneur de job, ni le VPS
  hôte : seulement ce qui tourne **dans ce même conteneur**, et
  `src/runtime/serveur.js` confirme que le harnais s'y limite déjà
  (`serveur.listen(0, '127.0.0.1', ...)`, dans le même process `gwaudit`
  que Chromium). **Le risque n'est donc pas plus sérieux en V2 : il y est
  structurellement plus étroit qu'en V1** — un poste de développeur héberge
  souvent d'autres services en boucle locale (base de données, autre
  serveur de dev…) qu'un widget hostile pourrait chercher à atteindre, alors
  qu'un conteneur de job ne fait tourner que ce job et rien d'autre à
  portée de `127.0.0.1`.
- **Réseau pour le clonage git et `npm audit`** : ces deux étapes ont
  besoin d'une vraie sortie réseau. La faire passer par un **proxy de
  sortie à liste blanche** (GitHub, GitLab, `registry.npmjs.org`…) qui
  refait sa propre résolution DNS et rejette lui-même les plages privées —
  en défense en profondeur, indépendante de la validation faite côté
  `gwaudit`, qui peut avoir un trou. Pas une hypothèse d'école : la
  validation d'hôte de `gwaudit` (constat 1, §1) avait un trou réel,
  trouvé et corrigé le 2026-09-20 (commit `19c0134`) — un `\` littéral
  dans l'URL soumise faisait calculer à `new URL()` un hôte différent de
  celui que git contactait réellement. Un validateur d'URL ne vaut que
  s'il coupe l'autorité au même endroit que le client qui exécutera la
  requête ; deux parseurs différents (ici Node vs. libcurl) peuvent
  légitimement diverger sur ce point. Le proxy CONNECT décrit plus bas
  n'a structurellement pas ce défaut : il voit et valide l'hôte:port que
  git a **réellement** demandé en `CONNECT` (ce que le client a résolu),
  pas une valeur re-dérivée par un second parseur d'une URL — la classe
  de bug qui vient d'être fermée dans `gwaudit` ne peut pas s'y reproduire
  de la même façon.
- **Un job = un conteneur à usage unique.** Un pool de conteneurs vierges
  pré-chauffés peut réduire la latence, mais aucun ne doit survivre à un
  second job.
- **Plafond de durée du job, au niveau du conteneur.** Ajouté le
  2026-09-28 après qu'une revue a trouvé, dans une règle de l'axe F
  (`F-RGAA-05`), une expression régulière à retour arrière catastrophique
  qui a bloqué un audit reproductible sur un widget officiel Grist. La
  règle elle-même se reprend ailleurs (hors périmètre de ce document) : un
  premier correctif (`d4a2e39`) prenait encore 302 s sur une page piégée
  de 3 Mio, mesure faite par la coordination ; celui vérifié par
  l'exécution est `8643599` (une seule passe du découpeur HTML). La classe
  de bug reste : `analyseStatique()` (`src/moteur/statique.js`)
  exécute les axes A/B/C/F en JavaScript synchrone, et un thread
  Node bloqué par du retour arrière ne peut structurellement pas exécuter
  le moindre `setTimeout` interne pour s'auto-interrompre (le clonage git
  et `npm audit` ont déjà chacun leur propre plafond en sous-processus,
  120 s ; l'axe D a le sien, ~90 s ; l'analyse du code a désormais le sien,
  posé de l'extérieur : voir « Analyse du code dans un enfant à limite »
  ci-dessous — elle ne tourne plus dans le processus de l'outil).
  Seul un mécanisme externe au process peut couper un blocage de cette
  nature, et le plafond du conteneur reste le filet de tout ce que l'enfant
  ne couvre pas : `docker/execution/entrypoint.sh` enveloppe désormais tout
  l'audit dans `timeout -k 10 480 node bin/gwaudit.js …` — 480 s de marge
  au-dessus de la somme des plafonds internes déjà connus, pour ne jamais
  couper un audit légitime tout en bornant ce que la file d'attente qui
  sérialise les jobs (constat 11, §5) peut rester bloquée par un seul job
  pathologique. Vérifié hors conteneur avec une vraie boucle Node
  synchrone sans gestionnaire de signal : un simple SIGTERM suffit à la
  tuer immédiatement, le repli `-k` en SIGKILL n'a même pas été
  nécessaire ; confirmé ensuite en conteneur réel : la destruction du
  process 1 du conteneur (`timeout`, lui-même remplacé par `exec`) entraîne
  bien celle d'un Chromium orphelin, par arrêt de l'espace de noms PID
  (`bash docker/ci/verifier.sh plafond`, voir
  `docker/README-V2-VERIFICATIONS.md`).
- **Analyse du code dans un enfant à limite de mémoire et de temps
  (`src/isolement`).** Ajouté le 2026-09-30. Un widget peut faire mourir le
  processus qui l'analyse sans lever la moindre exception : un tas de V8
  épuisé est un abandon (SIGABRT, code 134), le noyau qui manque de mémoire
  dans le conteneur tue par SIGKILL (137), et (jusqu'à `b3d12ba`) l'abandon du
  compilateur d'expressions régulières sur une pile presque pleine ne se
  rattrapait dans aucun fil. Avant ce changement, ces fins ne laissaient ni rapport ni
  verdict, et ressemblaient à une panne de l'outil alors que c'est le widget
  qui les provoque ; elles laissent maintenant le rapport que le widget a
  voulu empêcher.
  - **Ce qui tourne où.** `bin/gwaudit.js` lance `src/isolement/enfant-travail.mjs`
    dans un processus à part (`node --max-old-space-size=<tas>`, son propre
    groupe de processus) ; l'enfant y fait tourner, dans un Worker dont la pile
    se règle, la construction du contexte puis `analyseStatique`. Il écrit dans
    un dossier de travail privé l'étape en cours, un résumé du contexte dès
    qu'il est construit (racine, entrées, fichiers utiles aux rapports), et le
    résultat d'un bloc, avec un marqueur de fin : un résultat sans marqueur,
    illisible ou absent n'est jamais pris pour un résultat. Le parent joue l'axe
    D, note et écrit les rapports comme avant. Comparé avant/après sur les 32
    cibles du corpus `gristlabs/grist-widget@6a773b2` (`scripts/comparer-avant-apres.mjs`),
    les constats sont identiques ; `tests/isolement-equivalence.test.mjs` garde,
    sur des widgets du dépôt, des constats et des rapports (HTML, JSON, Markdown,
    SARIF) identiques que l'on rende le contexte entier ou le résumé qui en sort.
  - **Ce qui se passe quand l'enfant ne rend pas de résultat.** Le parent dit
    pourquoi (cause `tas`, `pile`, `abandon`, `noyau`, `delai`, `exception`,
    `incomplet` ou `sortie`, avec la dernière étape annoncée et la fin de la
    sortie d'erreur) et écrit un rapport de repli (`src/isolement/repli.js`, sans
    toucher au moteur ni au rapport existants) : un constat critique bloquant
    `C-SURFACE-03`, cause `interruption`, qui empêche les axes A, B, C, E et F
    (notés 0, « mesure empêchée » : ce qu'un widget qui empêche la lecture de son
    code ne doit jamais gagner). L'axe D est joué si le résumé du contexte a été
    écrit avant la fin de l'enfant (il ne lit que la racine et les entrées) ; sinon
    il est `D-INDISPONIBLE`, hors du calcul, et le rapport le dit.
  - **Code de sortie et intégrateur.** Le repli est un verdict : code **2**
    (« au moins un bloquant »), rapport écrit, JSON et SARIF compris. Ce n'est pas
    une panne, et le rejouer donnerait le même résultat (même code, mêmes limites) :
    l'intégrateur le traite comme n'importe quel NON CONFORME avec bloquant, le
    présente comme un niveau de risque, et ne relance pas. Le code **3** est réservé
    à l'outil : l'enfant n'a pas pu être lancé (fork refusé, environnement trop
    gros) ou est mort avant d'avoir annoncé sa première étape (il n'a rien lu du
    widget : rien à en dire) ; là, pas de rapport, et l'intégrateur peut relancer
    une fois avant d'alerter l'exploitant. `124` et `137` gardent le sens
    ci-dessous : en phase d'analyse du code, le délai de l'enfant est plus petit que
    le plafond et l'enfant est la victime désignée du noyau, donc un widget qui
    ne fait que consommer de la mémoire ou du temps d'analyse ne provoque plus ces
    codes ; le clonage, l'axe D et l'outil lui-même restent couverts par eux.
  - **Limites.** Tas de l'enfant : la limite du groupe de contrôle (`mem_limit`)
    moins 210 Mio (`RESERVE_HORS_TAS_MO` : le parent, qui écrit le repli et joue
    l'axe D, tient en environ 70 Mo ; l'enfant occupe hors tas 60 à 100 Mo de
    plus : jeune génération, code, contenu des fichiers lus), au moins 128 Mio —
    soit 558 Mio sous 768 Mio. Le repli ne sert à rien si le noyau tue le parent
    avant l'enfant : l'enfant relève son propre `oom_score_adj` (1000) pour être
    la victime, et un abandon (134), un SIGKILL du noyau ou un résultat incomplet
    donnent chacun leur repli (`tests/isolement-enfant.test.mjs`,
    `tests/isolement-repli.test.mjs`, `tests/isolement-cli.test.mjs`, aucun ne
    dépend de la machine : le tas est petit, le SIGKILL est envoyé, le résultat
    tronqué est écrit par un double). Durée : `GWAUDIT_DELAI_ANALYSE_S`, **240 s
    posées par l'image** (elles laissent, sous les 480 s du plafond, le clonage
    120 s au plus, l'axe D 90 s et les rapports) ; sur un poste (V1) il n'y en a
    pas par défaut. Pile du Worker : celle de Node par défaut (4 Mio),
    `GWAUDIT_PILE_ANALYSE_MO` la règle (à figer avec la table de profondeur de
    l'analyse « illisible » ; ce qu'elle change est mesuré ci-dessous). Surchargeables pour un essai :
    `GWAUDIT_MEMOIRE_ANALYSE_MO` (≥ 64), `GWAUDIT_PILE_ANALYSE_MO`,
    `GWAUDIT_DELAI_ANALYSE_S` ; une valeur inutilisable est dite et ignorée. Le
    dossier de travail et ce que l'enfant a lancé (un `npm audit`) disparaissent
    avec lui, y compris quand le parent est tué sans préavis.
  - **Trouvaille qui compte pour la limite.** Mesuré sur Node 22.22.2,
    `resourceLimits.maxOldGenerationSizeMb` d'un Worker **seul ne borne pas le
    tas** (30 millions d'objets sous « 64 Mio » : 4,6 Go) ; c'est l'option de
    ligne de commande du processus qui l'applique, et le Worker la reprend.
    L'enfant est lancé avec l'option ; `tests/isolement-enfant.test.mjs` le garde
    (un tas doublé, plafonné à 1 Go, doit finir bien en dessous).
  - **La pile pleine : fermée à la source, gardée en défense.** Un `app.js` de
    « x=>{ » imbriqués puis refermés faisait sortir l'audit en 134 sans rapport, dès
    440 niveaux (2,4 Kio ; relevé sur `0c741ce`, reproduit sur `a3b342e`) : le
    rattrapage de pile d'acorn testait le message de l'erreur par une expression
    régulière que V8 compile à cet instant, au bord de la pile, et V8 abandonne
    (`FATAL ERROR: RegExpCompiler Allocation failed - process out of memory`, où le
    mot « memory » n'a rien à voir avec la mémoire). L2 seul contenait cet abandon
    dans l'enfant : rapport de repli, cause `pile`, 12 fois sur 12 à 20 000 niveaux
    sur une page minimale et 10 fois sur 10 derrière les fichiers de `widget-exemple`
    (mesuré sur `6c3c77b`). `b3d12ba` ferme l'abandon à la source (`LecteurAcorn`,
    `src/moteur/analyse-js.js` : le dépassement de pile est rattrapé sans expression
    régulière) : le piège est lu et dit `profondeur` (C-SURFACE-03, critique bloquant,
    code 2, une demi-seconde), dans le fil principal comme dans le Worker de
    l'enfant (0 abandon sur 30 dans chacun, mesuré dans le message de `b3d12ba`) ; l'audit
    ne s'interrompt plus et le repli n'intervient pas. L'essai de la suite
    (`tests/isolement-cli.test.mjs`) et le scénario 4/5 de l'image
    (`bash docker/ci/verifier.sh interruption`) gardent cela avec 20 000 niveaux,
    trois lancements chacun, dans le régime de l'enfant.
    Le classement `pile` du repli reste, comme défense : si V8 abandonnait encore ainsi
    ailleurs (une autre expression régulière compilée au bord de la pile), l'enfant le
    contiendrait. Il est éprouvé par un enfant factice
    (`tests/aide-isolement/abandon.mjs`, `tests/isolement-enfant.test.mjs`), non par un
    piège réel : il n'y en a plus. Le message de V8 contient « Allocation failed » comme
    celui d'un tas épuisé : avant d'y regarder, le classement disait ce cas « mémoire
    épuisée », avec la remédiation des fichiers trop gros, ce qui était faux ; il est dit
    `pile`, avec sa raison, sa remédiation (découper l'expression trop imbriquée ou
    publier les sources non minifiées) et sans désigner de fichier, et le message fatal
    est gardé en tête de `finDeLaSortieDErreur` (la trace native, dessous, le noyait).
    Une pile qui déborde en exception, sans que V8 abandonne, n'est pas du ressort du
    repli : l'analyse isolée la rend à l'audit, qui la dit lui-même (constat « illisible »
    de la notation, cause `profondeur` ; les profondeurs de chaque construction :
    `scripts/mesurer-profondeur.mjs`).
  - **Le seuil, mesuré.** Ce qui fait tomber l'analyse dans le repli n'est pas la
    taille d'un fichier en soi mais ce que son arbre d'analyse coûte en mémoire, et
    la densité de l'arbre par octet de source varie du simple au double : un seuil
    ne se cite qu'avec le code qui l'a donné. Tas plafonné à 558-560 Mio (celui de
    l'image sous 768 Mio), un seul fichier de code : du code minifié synthétique
    dense (`scripts/lib/code-synthetique.mjs`) passe à 5 Mio, tombe à 6 Mio
    (pic résident de l'enfant 627 puis 635 Mo) ; de vrais paquets (`chart` et
    `timeline` de `gristlabs/grist-widget`, enveloppés en un fichier) passent à
    8,7 Mio (pic 625 Mo), tombent à 9,5 Mio et à 11,3 Mio, un fichier de 10,9 Mio
    d'une densité moindre passe (629 Mo) : **le seuil par fichier est entre 5 et
    11 Mio selon la densité, celui d'un code réel dense autour de 9 Mio.** Le
    total, lui, n'est pas ce qui épuise le tas : 171 fichiers d'environ 1,1 Mio
    (193 Mio en tout, presque le plafond de 200 Mio lus) passent, pic résident 583 Mo,
    en 139 s. Les cibles honnêtes, mesurées sur `6c3c77b` avec ce même chemin
    (une exécution par point, `--sans-dynamique`) : `chart` (16 fichiers, 6,1 Mio de
    code, le plus lourd du corpus) échoue à 400 et à 424 Mio de tas et passe à 448,
    496 et 528 ; la racine de `gristlabs/grist-widget@6a773b2` (le recueil, 353
    fichiers inventoriés) échoue à 448 et à 472 et passe à 496 et à 528. Les
    quatre échecs sont `tas`, à l'étape `inventaire`, en 5 à 7 s. Le besoin est
    donc entre 424 et 448 Mio pour `chart`, entre 472 et 496 pour le recueil : la
    limite retenue (558) laisse **au moins 110 Mio à `chart`, au moins 62 Mio
    (11 %) au recueil**, c'est étroit pour ce dernier (une seule exécution par
    point). Le besoin de tas est fixé par l'inventaire, avant toute règle : le seul
    levier est `mem_limit` (le tas suit), et l'analyse unique, prévue en version
    suivante, est ce qui élargira la marge. Un recueil de cette taille n'est pas une
    soumission attendue ; s'il dépasse, il sort en `interruption` (mémoire), critique
    bloquant, jamais en conforme. Le pic résident dépasse le
    tas de 60 à 100 Mo : c'est la mesure à comparer à `mem_limit`, pas le tas. À
    rejouer : `node scripts/mesurer-seuil-memoire.mjs --mio 5 [--fichiers 1]
    [--tas 558] [--sources a.js,b.js]` (code fabriqué) ou
    `node scripts/mesurer-seuil-memoire.mjs --cible <dossier> --tas 448` (le
    dossier d'un vrai widget), par le chemin réel (`analyserEnEnfant`).
  - **Ce que coûte le plafond de 16 Mio par fichier** (relevé de 4 à 16 Mio pour
    que les paquets légitimes soient lus, `chart` : 6,08 Mio). Un fichier de 16 Mio
    ne se lit pas sous 768 Mio : le tas est épuisé avant la fin, et c'est
    exactement ce que le repli rend, avec le bloquant et la cause dite ; ce n'est
    plus un audit qui meurt en silence. Côté durée, `chart` demande environ 70 s,
    et le temps suit la quantité de code dense : au-delà d'une vingtaine de Mio de
    code dense en tout (extrapolé du rythme de `chart`, non mesuré : la vitesse
    varie du simple au décuple avec la densité, 171 fichiers légers d'environ
    1,1 Mio passent en 139 s), c'est le délai de 240 s qui tranche, avec le même
    repli.
    Aucun de ces deux cas n'est un widget honnête connu ; un intégrateur qui veut
    lire de plus gros paquets donne plus de mémoire au conteneur (le tas suit) et
    plus de temps à l'enfant, dans cet ordre, en gardant le plafond du conteneur
    au-dessus de la somme.
  - **Hors de l'image** (un poste, la V1, ou un conteneur sans limite de mémoire).
    Sans limite de groupe de contrôle et sans `GWAUDIT_MEMOIRE_ANALYSE_MO`, l'enfant
    est lancé sans `--max-old-space-size` : son tas est celui que Node choisit (8 240 Mio
    sur la machine de ces mesures, qui a 16 Go), et sans `GWAUDIT_DELAI_ANALYSE_S` rien ne
    borne le temps. Ce qui borne l'analyse est alors la machine, pas l'outil : un
    fichier qui épuiserait ce tas ferait encore mourir l'enfant, et le repli dirait
    l'`interruption` de la même façon, mais un tas de plusieurs Go, cela se compte en
    minutes. Mesuré sur `e42a8a6` avec L2, sur le fichier le plus coûteux que Règles ait
    chronométré (un `app.js` d'accents graves à la suite, le « point 4 » de son message :
    linéaire à constante haute, mesuré jusqu'à 800 Kio, extrapolé par lui au plafond
    de 16 Mio par fichier). Les tailles, une exécution par case, sauf la ligne de
    1,6 Mio (la sonde a ci-dessous : trois lancements, l'intervalle) :

    | fichier | hors de l'image (tas de Node, pas de délai) | dans l'image, 768 Mio |
    |---|---|---|
    | 800 Kio | lu jusqu'au bout, 22 s, pic de l'enfant 1 177 Mo | non mesuré |
    | 1,6 Mio | lu jusqu'au bout, 37 à 38 s, 2 017 à 2 187 Mo | lu jusqu'au bout, 60 à 103 s, 627 à 645 Mo |
    | 16 Mio (le plafond) | lu jusqu'au bout, 730 s (12 min), 6 796 Mo | `interruption` (tas), à l'inventaire, en 6 s |

    Les lignes « lu jusqu'au bout » donnent le constat C-SURFACE-03 de cause
    `profondeur` (« le code est imbriqué plus profondément que ce que l'outil sait
    parcourir : la pile déborde quand une règle le parcourt »), que l'enfant attrape lui-même :
    pas de repli, pas d'`interruption`, code 2 comme pour tout NON CONFORME. La
    réponse à « un fichier de 1,6 Mio d'accents graves donne-t-il un repli ? » est
    donc non, hors de l'image comme dedans : le tas de 558 Mio y suffit (le tas
    plafonné oblige le ramasse-miettes à travailler : 627 à 645 Mo de pic contre plus de
    2 000 sans plafond), et c'est au plafond de 16 Mio que l'image le rend `interruption`
    en 6 s, là où l'hôte calcule douze minutes et 6,8 Go. L'extrapolation de Règles
    (de trois à six minutes et plus de dix Go) ne se retrouve pas ici : 730 s et
    6,8 Go, sur une autre machine.

    Les quatre sondes de la coordination, trois lancements chacune, l'axe D joué, `index.html`
    de 77 octets qui charge un `app.js` d'accents graves (`docker/ci/fabriquer-widget-accents-graves.mjs`
    les reproduit octet pour octet, un essai en garde l'empreinte) : **a**, 1 677 722
    accents graves à la suite (sha256 `41f5b291…`) ; **b**, « coupe », 838 860 accents graves,
    un « ; », 838 860 accents graves (1 677 721 octets, `f7d29165…`) ; **b'**, « milieu »,
    838 840 accents graves, `;fetch("https://temoin-coeur.invalid/c");`, 838 840 accents
    graves (1 677 721 octets, `70e13a3c…`) ; **c**, 3 355 443 accents graves (`715a8944…`),
    un nombre impair : le dernier ne se ferme pas, le fichier est une erreur de syntaxe. Chaque
    cellule dit les issues, la note, la durée et le pic de l'enfant (pour « sans L2 », celui
    du processus, qui analyse lui-même). « Sans L2 » est `e42a8a6` seul, lancé avec
    `node --max-old-space-size=558 bin/gwaudit.js` (le tas de l'image) ; « avec L2, tas
    de l'image » est L2 hors de l'image avec `GWAUDIT_MEMOIRE_ANALYSE_MO=558` et
    `GWAUDIT_DELAI_ANALYSE_S=240`, les limites de l'image sans Docker ; « sans limite » n'en
    pose aucune.

    | sonde | sans L2, tas de 558 Mio | avec L2 dans l'image (768 Mio) | avec L2, tas de l'image | avec L2, sans limite |
    |---|---|---|---|---|
    | a | un rapport 3 sur 3, `profondeur`, 21/100 ; 63 à 64 s ; 632 à 647 Mo | un rapport 3 sur 3, `profondeur`, 21/100 ; 60 à 103 s ; 627 à 645 Mo | 3 sur 3, `profondeur`, 21/100 ; 56 à 59 s ; 645 à 650 Mo | 3 sur 3, `profondeur`, 21/100 ; 37 à 38 s ; 2 017 à 2 187 Mo |
    | b | un rapport 3 sur 3, `profondeur`, 21/100 ; 62 à 66 s ; 633 à 644 Mo | 3 sur 3, `profondeur`, 21/100 ; 52 à 54 s ; 636 à 666 Mo | 3 sur 3, `profondeur`, 21/100 ; 60 à 63 s ; 638 à 664 Mo | 3 sur 3, `profondeur`, 21/100 ; 37 s ; 2 112 à 2 207 Mo |
    | b' | **un abandon sur 3** (SIGABRT, code 134, « Reached heap limit », sortie vide, pas de rapport), deux rapports `profondeur`, 21/100 | 3 sur 3, `profondeur`, 21/100 ; 50 à 52 s ; 643 à 659 Mo | 3 sur 3, 21/100 : deux `profondeur`, **un `interruption`** (tas, à l'étape des règles) ; 56 à 64 s ; 641 à 643 Mo | 3 sur 3, `profondeur`, 21/100 ; 32 à 33 s ; 1 936 à 2 141 Mo |
    | c | **trois abandons sur 3** (même message, dès l'inventaire, pas de rapport) | 3 sur 3, `interruption` (tas, à l'inventaire), **0/100**, axe D hors du calcul ; 4 à 5 s ; 639 à 645 Mo | 3 sur 3, `interruption` (tas, à l'inventaire), 0/100 ; 4 à 5 s ; 636 à 643 Mo | 3 sur 3, `syntaxe` (à la lecture), 21/100 ; 10 à 11 s ; 2 125 à 2 133 Mo |

    Ce que le tableau dit. Avec L2, 36 lancements sur 36 ont écrit un rapport (code 2, NON CONFORME,
    C-SURFACE-03) ; sans L2, au tas de l'image, 4 lancements sur 12 sont morts sans rien dire (b' une
    fois, c trois fois). La sonde a ne régresse pas : même issue, même note (21/100), même cause qu'avant.
    Le fichier de la sonde b' porte en son milieu un appel réseau que personne ne lit : aucun des 9
    lancements avec L2 ne l'a relevé (aucun C-EXFIL-01), et chacun a dit C-SURFACE-03, bloquant :
    jamais ni l'un ni l'autre. L'abandon est intermittent (b : aucun sur trois lancements ici) ; avec L2
    il devient un repli quand il a lieu (b' une fois). La même sonde c note 0/100 dans l'image (l'enfant meurt
    avant d'avoir écrit le résumé du contexte : pas d'axe D) et 21/100 sans limite (le parseur
    finit, la syntaxe est fautive, l'axe D est joué) : la limite ne rend jamais une meilleure note que
    son absence. Ce que cela veut dire pour l'exploitant : **ce sont les limites de l'image, pas
    l'algorithme, qui bornent le coût d'un fichier hostile** ; hors de l'image, un poste le paie
    en temps et en mémoire (2 Go ici, 6,8 Go au plafond de 16 Mio), et un intégrateur qui lancerait
    l'outil sans l'image doit poser `GWAUDIT_MEMOIRE_ANALYSE_MO` et `GWAUDIT_DELAI_ANALYSE_S`
    lui-même. Que la V1 ne pose ni l'un ni l'autre par défaut est un choix de produit, à confirmer.
    À rejouer : `node docker/ci/fabriquer-widget-accents-graves.mjs <dossier> <octets> [--coupe |
    --temoin]` fabrique le widget (819200, 1677722 et 16777216 octets pour les tailles ci-dessus ;
    1677722 pour la sonde a, avec `--coupe` pour b, avec `--temoin` pour b' ; 3355443 pour c) ; dans
    l'image, `bash docker/ci/mesurer-pics.sh <dossier> --image <image> --memoire 768m` ; hors de
    l'image, le même audit lancé directement : `GWAUDIT_PICS_SORTIE=<sortie> node -r
    ./docker/ci/pics.cjs bin/gwaudit.js <dossier> --json --sortie <sortie>` (précédé de
    `GWAUDIT_MEMOIRE_ANALYSE_MO=558 GWAUDIT_DELAI_ANALYSE_S=240` pour les limites de l'image, de rien
    pour « sans limite » ; sous root, avec `GWAUDIT_CHROMIUM_SANS_SANDBOX=1` et `GWAUDIT_CHROMIUM_PATH`
    pour l'axe D), puis `node docker/ci/resumer-pics.cjs <sortie> <code de sortie> <secondes> aucune`.
    L'issue se lit dans `<sortie>/rapport.json` : `verdict`, `scoreGlobal`, et dans les constats de
    l'axe C le `C-SURFACE-03` avec sa `preuve` (`cause`, `genre`, `etape`). Sans L2 : `e42a8a6` et
    `node --max-old-space-size=558 bin/gwaudit.js <dossier> --json --sortie <sortie>`.
  - **La marge dans l'image**, mesurée avec L2 : `bash
    docker/ci/mesurer-pics.sh <cible> --image <image> [--memoire 768m]
    [--statique]` lance l'audit réel de la cible dans le conteneur (sans réseau,
    lecture seule, mêmes limites que l'intégrateur, axe D joué) et dit le pic du
    groupe de contrôle, celui de l'enfant et celui du parent. Sous 768 Mio, sur
    `6c3c77b` : `chart`, pic du groupe de contrôle de 614 à 673 Mo sur cinq
    exécutions (dont une sans axe D), pic de l'enfant de 613 à 615 Mo ; le recueil,
    de 629 à 632 Mo sur quatre exécutions, enfant de 629 à 634 Mo. Refaits dans
    l'image construite sur `0949868` (l'inventaire compris) puis sur `1055f99`
    (C-SECRET-01 compris), avec L2, trois exécutions chacun : `chart` 614 à
    619 Mo au groupe de contrôle, 613 à 618 à l'enfant ; le recueil 629 à 638 Mo,
    629 à 638 à l'enfant. Refaits enfin sur `e42a8a6` (les correctifs de l'inventaire
    et des secrets compris), trois exécutions chacun : `chart` 613 à 630 Mo au
    groupe de contrôle, 613 à 615 à l'enfant, 173 à 175 au parent, en 78 à 80 s ;
    le recueil 628 à 649 Mo, 630 à 633 à l'enfant, 179 à 180 au parent, en 90 à
    94 s. Aucun refus de mémoire, aucun repli, pas de constat
    C-SURFACE-03 d'interruption. La marge sous 768 est donc d'au moins 95 Mio
    (12 %) pour `chart` (le pire pic est celui de `6c3c77b`) et 119 Mio (15 %) pour
    le recueil (649 Mo sur `e42a8a6`) ; le groupe de contrôle compte aussi
    le cache de pages, qui explique peut-être les valeurs hautes de `chart`
    (non vérifié). Le pic du parent (171 à 182 Mo avec l'axe D, 106 sans) est
    celui de l'axe D : l'enfant est mort à ce moment-là. Le corpus (les 31
    dossiers et la racine) et l'étalonnage (3 cibles) passent tous sous un tas de
    558 Mio sans `interruption` : 35 cibles sur 35 sur `6c3c77b`, et sur `1055f99`,
    `9a6fe07` puis `e42a8a6` (hors conteneur, avec `GWAUDIT_MEMOIRE_ANALYSE_MO=558` ;
    sur `e42a8a6` aussi avec le tas par défaut de Node) les mêmes constats et les
    mêmes notes qu'avec l'outil sans L2, cible par cible
    (`scripts/comparer-avant-apres.mjs`). Ces
    nombres se refont à chaque changement de l'inventaire ou de l'analyse.
  - **Éprouvé dans l'image**, sous `mem_limit: 768m` (`bash docker/ci/verifier.sh
    interruption`, dans `image-v2.yml`) : un widget de code au-dessus du seuil est
    audité, le tas de l'enfant est épuisé, le rapport de repli est écrit, code 2,
    aucun `OOMKilled`, la mort de l'enfant par le noyau (limite d'enfant au-dessus du
    conteneur), le délai, le piège de la pile pleine, et un widget honnête sous le
    seuil se note comme avant.

### Proposition concrète pour le VPS d'Antoine (Debian 13)

Antoine a confirmé le 2026-09-20 que le VPS tourne sous **Debian 13
« trixie »**. Ce qui suit est écrit **de mémoire**, pas vérifié dans cette
session contre une documentation à jour pour cette version précise : deux
tentatives de consultation de la documentation officielle ont été bloquées
côté permissions dans cet environnement, et la première adresse encore
accessible pointait vers Debian 11 (bullseye), pas trixie — une version
insuffisamment proche sur ce qui compte ici (noyau, systemd, cgroups) pour
servir de vérification. Chaque point ci-dessous reste donc **à confirmer
par Antoine sur sa propre machine**, la seule qui compte réellement :

- **Docker Engine** : installer depuis le dépôt officiel Docker
  (`download.docker.com/linux/debian`) plutôt que le paquet `docker.io` de
  Debian — versions plus récentes et correctifs de sécurité plus rapides.
  *À vérifier sur le VPS* : si `trixie` n'est pas encore listée dans ce
  dépôt au moment de l'installation, l'entrée `bookworm` est généralement
  utilisable en attendant (compatibilité glibc/systemd suffisante en
  pratique pour Docker), mais ça se confirme au moment de l'installation,
  pas ici.
- **cgroups v2 et la limite mémoire (constat 10c)** : Debian, depuis
  plusieurs versions déjà, active cgroups v2 (hiérarchie unifiée) par
  défaut — ce que confirme `docker info | grep -i cgroup` une fois Docker
  installé. C'est ce qui referme structurellement 10c : une limite Docker
  (`mem_limit`/`--memory`) s'appuie sur `memory.max` du cgroup, qui compte
  la mémoire **résidente** réellement utilisée — pas la mémoire **virtuelle
  adressée** que compte `ulimit -v` (RLIMIT_AS), et qui est précisément ce
  qui rend `ulimit -v` inutilisable avec Chromium (constat 10c, ci-dessus).
  Éprouvé sur un runner GitHub (cgroups v2) : face à un widget qui alloue
  sans fin, le noyau tue le processus le plus gros (le rendu de Chromium), la
  mémoire du conteneur reste sous la limite (`OOMKilled` à vrai) et l'audit
  conclut quand même par un verdict — pas de plantage silencieux, pas de
  dépassement. `memswap_limit` égal à `mem_limit` interdit en plus de
  compenser par du swap. *À refaire sur le VPS*, dont le noyau et la version
  de Docker peuvent différer : `bash docker/ci/verifier.sh memoire`.
- **Durcissement du conteneur, par priorité** :
  1. Ce qui est déjà dans l'esquisse ci-dessous (`cap_drop: ALL`,
     `no-new-privileges`, rootfs en lecture seule + `tmpfs` borné,
     `pids_limit`, `mem_limit`, `cpus`) — coût nul, à faire dès le premier
     conteneur.
  2. Un profil seccomp : celui de Docker par défaut ne suffit **pas** ici (il
     interdit les espaces de noms utilisateur dont le bac à sable de Chromium
     a besoin) ; le profil de Playwright, repris tel quel, est celui du
     compose. Un profil plus restrictif n'est à envisager que si un besoin
     précis apparaît à l'usage.
  3. `userns-remap` dans `/etc/docker/daemon.json` sur l'hôte, en
     défense en profondeur : remappe l'UID root du conteneur vers un UID
     non privilégié côté VPS, pour qu'une évasion de conteneur n'atterrisse
     pas root sur la machine. Connu pour ajouter de la friction (montages,
     certains volumes) — à activer une fois le reste stabilisé, pas dans la
     première itération, et à valider sur la version de Docker réellement
     installée.
  4. Docker rootless complet (dockerd en mode rootless) n'est **pas**
     recommandé en première itération pour ce cas précis : un seul VPS
     mono-tenant, où `cap_drop` + `no-new-privileges` + `userns-remap`
     couvre déjà l'essentiel du gain pour l'effort. Rootless redevient
     intéressant si le VPS héberge un jour plusieurs services à des
     niveaux de confiance différents.
- **Proxy de sortie** (remplace le `image: à-définir` de l'esquisse) : un
  proxy CONNECT explicite (tinyproxy ou squid), avec une liste blanche par
  nom d'hôte limitée à `github.com`/`gitlab.com`/`registry.npmjs.org`,
  consommé via `HTTP_PROXY`/`HTTPS_PROXY` côté `git`/`npm` dans le
  conteneur d'exécution. Un proxy CONNECT n'a pas besoin de terminer TLS
  (git et npm ouvrent un tunnel CONNECT puis parlent TLS de bout en bout à
  travers) donc pas de rupture de certificate pinning ni de MITM à gérer.
  Le proxy doit résoudre lui-même le DNS du nom demandé et rejeter les
  plages privées/loopback/lien-local **avant** d'autoriser le `CONNECT`
  (anti-SSRF, anti-DNS-rebinding), indépendamment de la validation déjà
  faite côté `gwaudit` — voir plus haut. *À vérifier* : la syntaxe exacte
  du filtre par domaine de l'outil choisi n'a pas été confirmée dans cette
  session contre sa documentation actuelle.

Une esquisse de `docker-compose` pour cette zone est dans
[`docker/docker-compose.v2-execution.yml`](../docker/docker-compose.v2-execution.yml)
— non testée ici pour la même raison que le reste de `docker/`.

### Ce que l'image exige de qui la déploie

L'image seule ne suffit pas : les réglages ci-dessous sont dans
`docker/docker-compose.v2-execution.yml`, qui est la référence ; qui l'exécute
autrement (autre orchestrateur, `docker run`, Kubernetes) doit tous les
reproduire, sans quoi soit l'audit échoue, soit — pire — il tourne avec moins
d'isolation sans le dire.

| Réglage | Pourquoi | Sans lui |
|---|---|---|
| utilisateur `pwuser` (par l'image), `read_only`, `tmpfs` `/tmp` avec `exec` | rien d'écrit hors du travail du job ; l'axe D exécute un lanceur de Chromium sous `/tmp` | `noexec` (défaut Docker du tmpfs) : axe D en `EACCES` |
| `cap_drop: ALL`, `no-new-privileges`, `pids_limit`, `mem_limit` + `memswap_limit` égaux, `cpus` | enveloppe de base | — |
| `seccomp=execution/seccomp-chromium.json` + `cap_add: SYS_CHROOT` | bac à sable de Chromium (voir §4) | Chromium ne démarre pas avec son bac à sable, ou sans lui |
| ne **pas** poser `GWAUDIT_CHROMIUM_SANS_SANDBOX` | le bac à sable est actif par défaut ; la dérogation est refusée par `entrypoint.sh` (l'audit ne démarre pas) | — |
| réseau `internal: true` + `HTTP_PROXY`/`HTTPS_PROXY` vers `egress-proxy` | seule sortie : le proxy à liste blanche | pas de sortie du tout, ou une sortie ouverte |
| `GWAUDIT_RESOLUTION_PAR_PROXY=1` | le réseau interne n'a pas de DNS : le proxy résout et refuse les adresses internes ; un littéral IP (IPv6 compris) et un nom que `NO_PROXY` fait joindre sans proxy restent vérifiés dans le conteneur | tout audit d'URL échoue (code 4, « Résolution DNS impossible ») |
| `/out` inscriptible par l'uid 1000 (`pwuser`) | le rapport y est écrit | pas de rapport |

Contrat de sortie du conteneur : `0` CONFORME ; `1` SOUS RÉSERVE ou NON
CONFORME sans bloquant ; `2` au moins un bloquant (un verdict, pas une panne) ;
`3` erreur interne de gwaudit ; `4` cible refusée ou inaccessible (URL refusée
par la validation ou par le proxy de sortie, clonage impossible : une soumission
refusée, dite en clair et sans pile, pas une panne) ; `124` (ou `137`) coupé par le plafond de durée
(`GWAUDIT_PLAFOND_S`, 480 s par défaut : ne pas la poser en production) ;
`137` avec `OOMKilled` si le noyau a tué le processus principal pour cause de
mémoire. Un code 124 ou 137 ne laisse aucune garantie sur les rapports écrits.

## 5. File d'attente, quotas, anti-abus

**Précision de périmètre, tranchée par Antoine le 2026-09-28** : ce dépôt
public livre la brique — le contenu de l'image d'exécution
(`docker/execution/`) et du proxy de sortie (`docker/egress-proxy/`).
« On se concentre sur la mise à dispo sur le dépôt de l'audit, tout ce qui
est autour c'est de l'intégration liée à un projet spécifique donc pas sur
le dépôt général de l'audit. » La file d'attente, les quotas, l'appel du
conteneur avec l'URL soumise et l'intégration à `src/interface/` sont donc
un travail du projet qui déploiera sur son VPS, **pas un livrable de ce
dépôt** — ce qui suit reste comme documentation du besoin que cette
intégration doit couvrir, pas comme code à écrire ici.

Ce qui reste ouvert sur ce registre (constats 10c et 11, §1) se résume à
une seule cause commune : le code de la V1 suppose implicitement **un seul
audit à la fois, lancé par une personne de confiance**, et ne peut pas
s'auto-attribuer une vraie limite de mémoire résidente. Pour un service
public, il faut explicitement :

**Un point de conception que la mesure du 2026-09-20 (constat 10b) rend
concret** : un widget hostile ne cherche pas à faire durer son propre
audit — il consomme des ressources *pendant* qu'il tourne, et l'audit se
termine normalement, dans son délai habituel, qu'il y ait eu saturation
CPU en arrière-plan ou non. L'exposition réelle n'est donc pas « un audit
qui dure trop longtemps » (déjà borné, 10a) mais **le nombre d'audits
simultanés** qui consomment chacun leur part de CPU/mémoire en même temps
sur la même machine — ce qui renforce, plutôt qu'il ne l'assouplit, le
besoin d'une vraie limite de concurrence (constat 11, ci-dessous).

- un nombre maximal de jobs simultanés (aujourd'hui : aucun, puisqu'un
  `gwaudit` = un process séquentiel — voir constat 11) ;
- un quota de soumissions par IP et/ou par compte ;
- une taille maximale de dépôt acceptée (déjà vérifiée côté inventaire
  depuis le 2026-09-20 — constat 9, corrigé) ;
- une limite de mémoire résidente par job au niveau conteneur (cgroups) —
  le temps CPU et la durée sont déjà bornés depuis le 2026-09-20 (constats
  10a et 10b, corrigés), mais aucun réglage de lancement ne peut fournir
  une vraie limite mémoire à Chromium (constat 10c, encore ouvert, voir
  §1 pour pourquoi) ;
- une purge garantie de tout l'espace de travail à la fin d'un job — le
  `tmpfs` jetable du §4 couvre ce point par construction si le conteneur
  est bien détruit après chaque job (l'équivalent local, la purge du
  dossier de clone, est corrigé depuis le 2026-09-20 — constat 12).

Une conséquence positive à ne pas manquer : indexer les résultats par
`(URL, commit SHA)` (§3) permet aussi un **cache** — une soumission déjà
auditée pour ce commit exact répond immédiatement sans consommer de
worker, ce qui réduit d'autant la surface d'abus par soumissions répétées.

## 6. Ce qui reste à trancher avec Antoine

1. ~~Soumission par des visiteurs anonymes avec quotas, ou faut-il un
   compte ?~~ **Tranché le 2026-09-28 : anonyme, sans compte.** Antoine :
   « user non loggé, donc être très vigilant sur les liens qu'ils vont
   envoyer. » Aucune identité soumissionnaire à laquelle faire confiance —
   toute URL passe par `resoudreCible()`/`validerHoteClone()` (constat 1,
   §1) puis par le proxy CONNECT à liste blanche (§4) avant toute
   connexion réelle ; les deux existent déjà pour cette raison précise, et
   c'est le trou de parseur du 2026-09-20 sur le premier qui a rappelé que
   ces deux couches doivent rester indépendantes. Reste à concevoir côté
   zone « site » (§5, pas encore écrit) : quotas par IP faute de compte,
   et l'affichage doit dire clairement à l'utilisateur que rien ne
   garantit qui a soumis quoi.
2. ~~Le verdict doit-il être figé sur un hash de commit précis, avec
   invalidation automatique si le mainteneur pousse du nouveau code sous
   la même URL (§3) ?~~ **Tranché le 2026-09-28.** Antoine : « oui l'audit
   c'est forcément figé à l'instant t. Pas de solution miracle à ce
   sujet. » Confirme ce que §3 supposait déjà — pas d'invalidation
   automatique à construire, le verdict porte le commit examiné et se
   présente comme périmé si le dépôt a bougé depuis.
3. ~~Volume attendu — Docker durci ou microVM ?~~ **Tranché le
   2026-09-28 : volume faible, avec mise en attente si deux jobs arrivent
   en même temps.** Ferme la question en faveur du Docker durci (§4), pas
   d'une isolation plus forte dès le départ — cohérent avec ce que
   l'analyse d'exposition avait déjà établi (§1, §5) : le plafond CPU ne
   s'exerce jamais en pratique (`page.goto()` coupe à 30 s, bien avant),
   donc l'exposition réelle est le nombre d'audits **simultanés**, pas
   leur durée. Une file qui sérialise à un job à la fois répond
   littéralement à sa demande et ferme cette exposition du même geste —
   son code revient au projet qui déploiera (périmètre précisé le
   2026-09-28, voir §5), pas à ce dépôt.
4. ~~Le score/verdict doit-il seulement informer l'utilisateur avant
   installation, ou doit-il pouvoir bloquer techniquement une
   installation en dessous d'un certain seuil ?~~ **Tranché le
   2026-09-28 : informer, jamais bloquer.** Antoine : « on ne peut pas
   bloquer quoi que ce soit, les gens installeront les widgets sur leur
   Grist. On est juste là pour informer. Et un widget peut être non
   conforme et tout à fait fonctionnel, et c'est ok sur des données non
   sensibles par exemple. » Ne change rien à l'isolation (§4) : aucun
   mécanisme de blocage à construire côté V2. La deuxième phrase dépasse
   le choix technique — le verdict mesure un risque, il ne prononce pas
   une sentence, et ne veut rien dire sans l'usage qu'en fait celui qui
   décide. Ça concerne la présentation du rapport (ton, formulation), pas
   l'enveloppe V2 — hors du périmètre de ce document, propriété du fil
   qui possède `src/rapport/`.

## 7. Prochaines étapes concrètes

- Fait : les constats 1, 2, 3, 4, 5, 8, 9, 10a, 10b et 12 (§1) sont
  corrigés dans le moteur ; les constats 6 et 7 restent substantiellement
  atténués par le durcissement réseau ajouté en même temps.
- Fait et **construit, vérifié par GitHub Actions** (2026-09-29) :
  `docker/execution/Dockerfile` (+ `entrypoint.sh`) et
  `docker/egress-proxy/Dockerfile` (+ `squid.conf`), référencés par
  `docker-compose.v2-execution.yml`. « Écrit et relu » ne valait pas
  « construit et éprouvé » : la première vraie construction a trouvé un
  compose qui ne pouvait pas construire (contexte de construction), un chemin
  de Chromium faux, un `/tmp` en `noexec` qui empêchait l'axe D de démarrer, un
  audit d'URL qui échouait dès la première étape dans la zone fermée (le réseau
  interne n'a aucune résolution DNS, or `validerHoteClone()` en faisait une :
  corrigé par `GWAUDIT_RESOLUTION_PAR_PROXY=1`, la résolution et le refus des
  adresses internes revenant alors au proxy), et un Chromium qui tournait sans
  bac à sable (constat 3). Reste ce que seul le VPS peut dire :
  `docker/README-V2-VERIFICATIONS.md`.
- Limite de mémoire résidente par job (constat 10c) : déjà dans l'esquisse
  (`mem_limit: 768m`, §4) — reste à valider sur le VPS (cgroups v2), pas à
  concevoir.
- File d'attente qui sérialise les jobs (constat 11) : décidée en principe
  le 2026-09-28 (un job à la fois). Son code — la file, son intégration à
  `src/interface/`, le passage de l'URL soumise au conteneur
  `execution-audit` — **n'est pas un livrable de ce dépôt**, précisé par
  Antoine le même jour (voir §5) : ce dépôt fournit la brique, le projet
  qui déploiera construit l'orchestration autour.
- Ajouté le 2026-09-28, à la demande d'Antoine (« ne pas oublier de
  préciser quand il faudra régénérer l'image ») : un contrôle quotidien
  automatisé (routine « Fraîcheur image Docker V2 ») compare `main` à un
  hash de commit consigné en tête de `docker/execution/Dockerfile` sur les
  seuls chemins que l'image copie (`bin/`, `src/`, `ressources/`,
  `package.json`, `package-lock.json`) et prévient dans ce fil quand l'un
  d'eux a bougé, avant de faire avancer ce hash. Ne construit ni ne
  déploie rien — détecte et prévient seulement.
- Ajouté le 2026-09-28, après le blocage trouvé sur `F-RGAA-05` (§4) :
  `docker/execution/entrypoint.sh` enveloppe tout l'audit dans
  `timeout -k 10 480 …`, plafond au niveau du conteneur qui ne dépend
  d'aucune limite interne à l'outil. Éprouvé en conteneur réel : un `gwaudit`
  de substitution qui lance Chromium puis boucle en synchrone est coupé au
  plafond (code 124) et aucun Chromium ne survit à la destruction du
  conteneur (`bash docker/ci/verifier.sh plafond`).
- Publication (`.github/workflows/image-v2.yml`) : le job qui construit et
  éprouve les images (il exécute du code de widget de test, hostile compris) n'a
  que `contents: read`. Il met les deux images de côté (empreinte et
  identifiants relevés), un job à blanc les recharge et rejoue `publier.sh` sur
  un registre local, et sur une étiquette `v*` un dernier job, **seul à avoir
  `packages: write`**, recharge les mêmes images, vérifie qu'elles ont
  l'empreinte et les identifiants relevés, et les pousse — il n'en exécute
  aucune.
- Images de base : celle d'exécution (`mcr.microsoft.com/playwright`, version
  et empreinte dans le Dockerfile) et celle du proxy (`debian:bookworm-slim`)
  sont épinglées par empreinte, pas par étiquette ; la CI le vérifie
  (`tests/images-epinglees.test.mjs`). Conséquence : les correctifs de sécurité
  d'une image de base n'arrivent que par un changement d'empreinte, décidé et
  éprouvé par la CI. Ce changement ne se voit pas de lui-même : `node
  docker/ci/derive-empreintes.mjs` compare, pour chaque `FROM` épinglé des deux
  Dockerfile, l'empreinte épinglée à celle que son étiquette désigne aujourd'hui
  au registre (code 0 : aucune dérive ; 1 : l'image de base a été republiée depuis
  l'épinglage, des correctifs attendent ; 2 : registre injoignable ou réponse
  inexploitable, ce qui n'est jamais dit « à jour »). Il constate et ne modifie
  rien ; à lancer périodiquement, il n'est pas dans la CI d'une poussée. Le
  paquet `squid` du proxy, lui, est celui de bookworm au
  moment de la construction. Le `docker-compose.yml` de validation manuelle d'un
  widget (hors image V2) garde volontairement le Grist du jour.
- Profil seccomp : `docker/execution/seccomp-chromium.json` est identique au
  fichier `utils/docker/seccomp_profile.json` de `microsoft/playwright` au
  commit `1b025d7e20a026371cd5f98ba0cdce48892737c8` (étiquette `v1.63.0`, la
  version de l'image de base) ; l'empreinte est épinglée dans
  `seccomp-chromium.sha256` et vérifiée par la CI avant chaque construction, la licence
  Apache-2.0 et le NOTICE de Playwright sont joints. Chacun des deux réglages de
  l'enveloppe (profil, `SYS_CHROOT`) a son témoin : retiré seul, il fait
  échouer la sonde du bac à sable.
- Faire rejouer sur le VPS d'Antoine, une fois l'image construite ou tirée :
  `bash docker/ci/verifier.sh tout` (les mêmes scénarios que la CI ; il
  faut Linux, Docker avec cgroups v2, et un accès à github.com et
  registry.npmjs.org). Ce qui peut différer du runner : le noyau (espaces de
  noms utilisateur, AppArmor), la version de Docker, le swap. Détail dans
  `docker/README-V2-VERIFICATIONS.md`.
