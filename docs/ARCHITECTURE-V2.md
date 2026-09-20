# Architecture V2 — audit hébergé (esquisse)

## Statut de ce document

Conception et outillage, pas de déploiement : rien de ce qui suit n'a tourné
sur l'infrastructure d'Antoine, et rien ici ne touche son VPS. Comme pour
`docker/` en V1, la politique réseau de cet environnement cloud bloque
Docker Hub et empêche de valider quoi que ce soit de conteneurisé
directement ici — chaque pièce technique proposée reste à essayer sur sa
machine.

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

**Statut vérifié le 2026-09-20**, deux fois, en relisant le code du dépôt
public — d'abord au commit `b3c372f`, puis de nouveau après de nouveaux
correctifs, au commit `1f5840d` — pas seulement rapporté. Le compte a changé
entre les deux relectures ; ce qui suit est le second, à jour.

### Corrigés

| # | Constat (état au 2026-09-19) | Fichier | Correction vérifiée |
|---|---|---|---|
| 1 | `git clone` recevait l'URL soumise sans résolution d'hôte ni liste blanche — SSRF | `bin/gwaudit.js` | `resoudreCible()` appelle `validerHoteClone()` avant tout clonage : résolution DNS puis rejet des adresses privées/loopback/lien-local/métadonnées cloud, refus du `http://` non chiffré. Pas de protection anti-DNS-rebinding entre la vérification et la connexion — laissé au proxy de sortie V2 (§4). |
| 2 | `npm audit` héritait tout `process.env` et lisait le `.npmrc` du dépôt audité | `src/regles/e-dependances.js` | `npmAudit()` copie seulement `package.json`/`package-lock.json` dans un dossier neutre, avec un environnement dédié (`HOME` isolé, `npm_config_userconfig` pointé sur un `.npmrc` vide, `npm_config_registry` figé sur `registry.npmjs.org`) : le `.npmrc` du dépôt audité n'est jamais lu. |
| 3 | Chromium était lancé avec `--no-sandbox` | `src/runtime/dynamique.js` | Sandbox natif actif par défaut ; `--no-sandbox` seulement si `GWAUDIT_CHROMIUM_SANS_SANDBOX=1` est positionnée explicitement. |
| 4 | Aucun hash de commit rattaché au rapport | `bin/gwaudit.js` | `commitDepot()` (`git rev-parse HEAD`) inclus dans `meta.commit` ; identité du dépôt tirée de l'URL réelle. |
| 8 | Le passe-droit réseau « local » ne comparait que le *hostname* | `src/runtime/dynamique.js` | Compare désormais l'origine exacte (`urlOrigine === origine`, protocole + hôte + port), pas seulement le hostname. |
| 9 | Aucun plafond de fichiers/octets cumulés pendant l'inventaire | `src/contexte/inventaire.js` | `MAX_FICHIERS` (20 000) et `MAX_OCTETS_LUS_CUMULES` (200 Mo), avec troncature explicite plutôt que crash, signalée dans `ctx.tronque`. |
| 10a | Aucun timeout global sur l'axe D après le chargement initial | `src/runtime/dynamique.js` | Tout le scénario (chargement + évaluations + a11y) est couru contre `DELAI_GLOBAL_AXE_D_MS` (45 s par défaut) via `avecDelai()`, qui lève le constat `D-TIMEOUT-01` en cas de dépassement. |
| 12 | `git clone` sans timeout, dossier temporaire jamais supprimé | `bin/gwaudit.js` | `timeout: 120_000` sur le clone ; `main()` dans un `try/finally` qui purge systématiquement. |

### Atténués, mais pas structurellement fermés

Ces trois-là gardent la même limite qu'avant au niveau de l'API Playwright
(`context.route()` ne les voit toujours pas), mais une nouvelle couche
ajoutée en même temps que le reste réduit le risque réel en pratique :
`chromium.launch()` reçoit désormais `--host-resolver-rules=MAP *
0.0.0.0,EXCLUDE 127.0.0.1,EXCLUDE localhost` et `--proxy-server=direct://`
(avec les variables `*_PROXY` retirées de l'environnement du process
Chromium), qui coupent la résolution de tout nom de domaine réel — y
compris pour du trafic que `route()` ne voit pas.

| # | Constat | Ce que la nouvelle couche change | Ce qui reste ouvert |
|---|---|---|---|
| 5 | WebSocket hors de portée de `route()` | Une connexion vers un nom d'hôte réel échoue désormais (résolution DNS coupée) | Aucune protection dédiée si Playwright ajoute un jour `routeWebSocket()` au harnais — repose entièrement sur le blocage réseau |
| 6 | WebRTC hors de portée de `route()` | Idem pour un serveur STUN/TURN désigné par nom d'hôte | Une cible WebRTC désignée par adresse IP littérale contourne ce blocage : aucune politique Chromium ne désactive WebRTC lui-même |
| 7 | `serviceWorkers` laissé à `allow` | Les requêtes d'un Service Worker vers un nom d'hôte réel échouent aussi désormais | L'enregistrement du Service Worker lui-même reste possible (`newContext()` ne passe toujours pas `serviceWorkers: 'block'`) |

### Encore ouverts

| # | Constat | Fichier | Statut |
|---|---|---|---|
| 10b | Aucune limite CPU/mémoire sur le processus Chromium | `src/runtime/dynamique.js` | Le timeout global (10a) borne désormais la *durée*, pas la consommation de ressources pendant cette durée — reste à traiter au niveau conteneur en V2 (§4). |
| 11 | Aucune limite de concurrence, pas de file d'attente | — | N'a pas de sens pour un outil en ligne de commande (un `gwaudit` = un process séquentiel). Propre à l'orchestration V2 (§5), qui n'existe pas encore. |

Sur les 12 écarts distincts d'origine (13 en comptant 10a/10b séparément,
plus précis que de les garder groupés) : **8 sont corrigés, 3 sont
atténués sans être structurellement fermés, 2 restent ouverts** — dont un
seul (11) est réellement propre à une V2 qui n'existe pas encore. Les
quatre autres qui restaient vrais pour l'usage normal de la V1 (2, 8, 9,
10a) sont maintenant corrigés ; il ne reste, sur ce registre-là, que les
limites CPU/mémoire (10b) et les trois canaux réseau atténués (5, 6, 7).

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
point dur restant est concentré dans l'axe D (navigateur : limites de
ressources, canaux WebSocket/WebRTC/Service Worker) et dans l'orchestration
multi-utilisateurs (concurrence) que seule la V2 introduira.

## 2. Principe : deux zones de confiance étanches

- **Zone « site »** (confiance normale — ce qui existe déjà sur le VPS
  d'Antoine) : formulaire de soumission, quotas, file d'attente, base des
  résultats, affichage du verdict. Cette zone **n'exécute jamais** de code
  audité.
- **Zone « exécution »** (confiance zéro — la deuxième instance Docker
  qu'Antoine évoque) : c'est là que `gwaudit` tourne réellement sur le code
  soumis. Elle n'a aucun accès entrant depuis l'extérieur ; elle consomme
  des jobs depuis la file et publie un résultat, rien d'autre.

Règles non négociables pour que la séparation soit réelle et pas seulement
nominale :
- Jamais le socket Docker (`/var/run/docker.sock`) monté dans la zone
  d'exécution — c'est l'erreur la plus commune qui annule tout le reste
  d'une isolation par conteneurs.
- Aucun secret, jeton ou identifiant du site (base de données, mailer,
  API…) n'est accessible depuis la zone d'exécution.
- La zone d'exécution ne conserve rien après un job : voir §4.

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
   - analyse dynamique (axe D) durcie : sandbox Chromium natif actif (pas
     `--no-sandbox`), `routeWebSocket()` ajouté à côté de `route()`,
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
- **Chromium** : objectif = réactiver son sandbox natif (namespaces
  utilisateur, seccomp) plutôt que `--no-sandbox`. Si l'environnement
  Docker du VPS ne le permet pas sans capacités élevées, le bon réflexe
  n'est pas de céder et remettre `--no-sandbox` : c'est d'ajouter une
  deuxième couche d'isolation indépendante de Chromium (conteneur jetable +
  réseau fermé, voire microVM de type Firecracker/gVisor si le volume le
  justifie un jour), pour que le sandbox Chromium ne soit jamais la seule
  barrière.
- **Réseau pendant l'exécution du navigateur** : interdiction par défaut de
  toute sortie réelle (seule la boucle locale vers le harnais de la V1
  doit passer, sur l'origine exacte, pas sur un hostname générique). Ceci
  **complète**, sans les remplacer, les correctifs applicatifs Playwright
  ci-dessus — la revue a montré trois angles morts différents de `route()`
  (WebSocket, WebRTC, Service Worker) : la défense doit exister aux deux
  niveaux.
- **Réseau pour le clonage git et `npm audit`** : ces deux étapes ont
  besoin d'une vraie sortie réseau. La faire passer par un **proxy de
  sortie à liste blanche** (GitHub, GitLab, `registry.npmjs.org`…) qui
  refait sa propre résolution DNS et rejette lui-même les plages privées —
  en défense en profondeur, indépendante de la validation faite côté
  `gwaudit`, qui peut avoir un trou (c'est précisément ce qui vient d'être
  démontré).
- **Un job = un conteneur à usage unique.** Un pool de conteneurs vierges
  pré-chauffés peut réduire la latence, mais aucun ne doit survivre à un
  second job.

Une esquisse de `docker-compose` pour cette zone est dans
[`docker/docker-compose.v2-execution.yml`](../docker/docker-compose.v2-execution.yml)
— non testée ici pour la même raison que le reste de `docker/`.

## 5. File d'attente, quotas, anti-abus

Ce qui reste ouvert sur ce registre (constats 10b et 11, §1) se résume à
une seule cause commune : le code de la V1 suppose implicitement **un seul
audit à la fois, lancé par une personne de confiance**, et n'a pas de
notion de limite de ressources par exécution. Pour un service public, il
faut explicitement :

- un nombre maximal de jobs simultanés (aujourd'hui : aucun, puisqu'un
  `gwaudit` = un process séquentiel — voir constat 11) ;
- un quota de soumissions par IP et/ou par compte ;
- une taille maximale de dépôt acceptée (déjà vérifiée côté inventaire
  depuis le 2026-09-20 — constat 9, corrigé) ;
- une limite CPU/mémoire par job au niveau conteneur (le timeout borne
  déjà la durée depuis le 2026-09-20 — constat 10a, corrigé — mais pas la
  consommation de ressources pendant cette durée : constat 10b, encore
  ouvert) ;
- une purge garantie de tout l'espace de travail à la fin d'un job — le
  `tmpfs` jetable du §4 couvre ce point par construction si le conteneur
  est bien détruit après chaque job (l'équivalent local, la purge du
  dossier de clone, est corrigé depuis le 2026-09-20 — constat 12).

Une conséquence positive à ne pas manquer : indexer les résultats par
`(URL, commit SHA)` (§3) permet aussi un **cache** — une soumission déjà
auditée pour ce commit exact répond immédiatement sans consommer de
worker, ce qui réduit d'autant la surface d'abus par soumissions répétées.

## 6. Ce qui reste à trancher avec Antoine

1. Soumission par des visiteurs anonymes avec quotas (IP/e-mail), ou
   faut-il un compte pour soumettre un widget à l'audit ?
2. Le verdict doit-il être figé sur un hash de commit précis, avec
   invalidation automatique si le mainteneur pousse du nouveau code sous
   la même URL (§3) ?
3. Volume attendu — quelques widgets par semaine, ou potentiellement
   plus ? Détermine si un Docker durci (§4) suffit ou s'il vaut mieux
   viser une isolation plus forte (microVM) dès le départ.
4. Le score/verdict doit-il seulement informer l'utilisateur avant
   installation, ou doit-il pouvoir bloquer techniquement une
   installation en dessous d'un certain seuil ?

## 7. Prochaines étapes concrètes

- Fait : les constats 1, 2, 3, 4, 8, 9, 10a et 12 (§1) sont corrigés dans
  le moteur, et les constats 5, 6 et 7 substantiellement atténués par le
  durcissement réseau ajouté en même temps.
- Reste ouvert, propre à l'architecture V2 et pas au moteur en tant que
  tel : limite CPU/mémoire par job (constat 10b) et limite de concurrence
  (constat 11) — voir §4 et §5.
- Faire valider sur le VPS d'Antoine : le sandbox natif de Chromium dans
  son environnement Docker réel (§4), et l'esquisse `docker-compose`
  jointe.
