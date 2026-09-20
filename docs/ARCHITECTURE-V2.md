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
15 écarts concrets entre ce que le code de la V1 fait aujourd'hui et ce
qu'exige ce changement de contexte de confiance. Aucun n'est un défaut de
la V1 en tant que tel — c'est un outil qui fait ce qu'on lui a demandé, pour
l'usage auquel il était destiné. Ce sont des prérequis de la V2 :

| # | Constat | Fichier | Sévérité |
|---|---|---|---|
| 1 | `git clone` reçoit l'URL soumise sans résolution d'hôte ni liste blanche : une cible interne au VPS (`127.0.0.1`, réseau Docker interne, `169.254.169.254`…) passe le test et déclenche une requête sortante réelle depuis le serveur — SSRF | `bin/gwaudit.js` (`resoudreCible`) | Critique |
| 2 | `npm audit` hérite tout `process.env` et lit le `.npmrc` du dépôt soumis (clé `registry` interpolable avec des variables d'env) : un dépôt hostile peut rediriger le trafic `npm audit` et potentiellement faire fuiter des variables d'environnement du serveur | `src/regles/e-dependances.js` (`npmAudit`) | Critique |
| 3 | Chromium est lancé avec `--no-sandbox` : le bac à sable natif de Chromium contre une faille du moteur de rendu est désactivé pour exécuter du code dont l'objet même de l'audit est de vérifier qu'il n'est pas malveillant | `src/runtime/dynamique.js` (`auditDynamique`) | Critique |
| 4 | Aucun hash de commit ni identité stable n'est attaché au rapport (pour une cible URL, l'identifiant retenu est le nom du dossier de clone temporaire) : rien n'empêche de faire auditer une version inoffensive puis publier une version différente sous la même URL | `bin/gwaudit.js` (`main`, `meta`) | Critique |
| 5 | `contexte.route('**/*', …)` ne couvre pas les connexions WebSocket : la garantie « aucune requête ne sort pendant l'audit » est fausse pour ce canal, que l'axe C sait pourtant repérer statiquement (`WebSocket`/`EventSource` dans `c-securite.js`) | `src/runtime/dynamique.js` | Majeur |
| 6 | WebRTC (ICE/STUN/TURN, DataChannel) est un sous-système réseau de Chromium totalement hors de portée de `route()` — aucun flag ni politique ne le neutralise | `src/runtime/dynamique.js` | Majeur |
| 7 | `newContext()` laisse `serviceWorkers` à sa valeur par défaut (`allow`) : un widget peut enregistrer un Service Worker dont les requêtes ne passent pas garanti par `route()` | `src/runtime/dynamique.js` | Majeur |
| 8 | Le passe-droit réseau « local » ne compare que le *hostname* (`127.0.0.1`/`localhost`), pas l'origine complète du harnais : toute requête vers un autre service qui écouterait sur loopback dans le même environnement passerait aussi | `src/runtime/dynamique.js` | Majeur |
| 9 | Aucun plafond sur le nombre de fichiers ni sur la taille cumulée lue en mémoire pendant l'inventaire (seul un seuil par fichier de 4 Mo existe) | `src/contexte/inventaire.js` | Majeur |
| 10 | Aucun timeout global sur l'audit dynamique après le chargement initial (`page.evaluate`/`axe.run` sans timeout), aucune limite CPU/mémoire sur le processus Chromium | `src/runtime/dynamique.js` | Majeur |
| 11 | Aucune limite de concurrence nulle part dans le code (pas de file, pas de sémaphore) : rien n'empêche N audits simultanés de multiplier chacun des points ci-dessus | `bin/gwaudit.js` et alentours | Majeur |
| 12 | `git clone` n'a ni timeout ni plafond de taille, et le dossier temporaire de clone n'est **jamais supprimé** (contrairement au dossier de travail de l'axe D, nettoyé en `finally`) | `bin/gwaudit.js` (`resoudreCible`) | Majeur |

Détail des preuves (fichier + ligne + citation) disponible sur demande — elles
ont été relues une seconde fois indépendamment avant d'être retenues ici,
aucune n'a été écartée par cette relecture.

**Ce qui n'a pas besoin de changer** : les axes A, B, C et F restent de
l'analyse statique par AST (`acorn`), qui ne fait qu'analyser du texte sans
jamais l'exécuter — aucun de ces axes n'ouvre de surface nouvelle en V2. Le
point dur est entièrement concentré dans ce qui *exécute* du code non
maîtrisé : l'axe D (navigateur) et les deux endroits qui parlent réseau en
dehors du navigateur (clonage git, `npm audit`).

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

Constats 9 à 12 ci-dessus se résument à une seule cause commune : le code
de la V1 suppose implicitement **un seul audit à la fois, lancé par une
personne de confiance**. Pour un service public, il faut explicitement :

- un nombre maximal de jobs simultanés (aujourd'hui : aucune limite) ;
- un quota de soumissions par IP et/ou par compte ;
- une taille maximale de dépôt acceptée, vérifiée avant et pendant le
  clonage (aujourd'hui : aucune) ;
- un timeout dur par job, qui tue le conteneur entier au-delà (aujourd'hui :
  seuls deux appels Playwright sur toute la chaîne ont un timeout) ;
- une purge garantie de tout l'espace de travail à la fin d'un job, y
  compris en cas d'erreur (aujourd'hui : le dossier de clone n'est jamais
  supprimé) — le `tmpfs` jetable du §4 couvre déjà ce point par
  construction si le conteneur est bien détruit après chaque job.

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

- Les constats 1, 3, 4 et 12 (SSRF sur le clonage, `--no-sandbox`,
  rattachement du commit au rapport, dossiers temporaires jamais purgés)
  sont des corrections utiles indépendamment de la V2 — elles touchent des
  fichiers activement modifiés en ce moment par le fil « Protocole d'audit
  widgets Grist », donc à coordonner avec lui plutôt qu'à corriger en
  parallèle depuis ce fil-ci.
- Faire valider sur le VPS d'Antoine : le sandbox natif de Chromium dans
  son environnement Docker réel (§4), et l'esquisse `docker-compose`
  jointe.
