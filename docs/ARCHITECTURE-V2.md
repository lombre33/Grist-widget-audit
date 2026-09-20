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

**Statut vérifié le 2026-09-20** en relisant le code du dépôt public
(commit `b3c372f`), pas seulement rapporté :

### Corrigés depuis, dans le moteur

| # | Constat (état au 2026-09-19) | Fichier | Correction vérifiée |
|---|---|---|---|
| 1 | `git clone` recevait l'URL soumise sans résolution d'hôte ni liste blanche : une cible interne (`127.0.0.1`, réseau Docker interne, `169.254.169.254`…) passait le test et déclenchait une requête sortante réelle — SSRF | `bin/gwaudit.js` | `resoudreCible()` appelle désormais `validerHoteClone()` avant tout clonage : résolution DNS puis rejet des adresses privées/loopback/lien-local/métadonnées cloud, et refus explicite du `http://` non chiffré. Limite que le code documente lui-même : pas de protection anti-DNS-rebinding entre cette vérification et la connexion que `git` ouvre ensuite — volontairement laissée à la charge d'un proxy de sortie dédié en V2 (§4), l'usage V1 local ne l'exigeant pas. |
| 3 | Chromium était lancé avec `--no-sandbox` | `src/runtime/dynamique.js` | Le sandbox natif de Chromium est actif par défaut ; `--no-sandbox` ne s'applique plus que si `GWAUDIT_CHROMIUM_SANS_SANDBOX=1` est explicitement positionnée. En V2, s'assurer que cette variable n'est jamais définie dans la zone d'exécution reste une vérification opérationnelle à faire (§4). |
| 4 | Aucun hash de commit ni identité stable n'était attaché au rapport (l'identifiant retenu était le nom du dossier de clone temporaire) | `bin/gwaudit.js` | `main()` calcule `git rev-parse HEAD` (`commitDepot()`) et l'inclut dans `meta.commit` ; l'identité du dépôt vient de l'URL réelle (`identiteDepuisUrl()`), plus du dossier temporaire. Le rattachement `(URL, commit)` proposé au §3 pour le cache/l'invalidation V2 peut s'appuyer dessus directement. |
| 12 | `git clone` n'avait ni timeout ni plafond de taille, et le dossier temporaire n'était jamais supprimé | `bin/gwaudit.js` | `execFileSync('git', ['clone', …], { timeout: 120_000 })`, et tout `main()` est maintenant dans un `try/finally` qui purge le clone (`fs.rmSync`) en succès comme en erreur ; la levée d'exception pendant le clone lui-même est aussi nettoyée explicitement. |

### Encore ouverts — et déjà vrais pour l'usage normal de la V1, pas seulement pour une future V2

Le vrai usage de `gwaudit` n'est pas de s'auditer soi-même : c'est de faire
tourner l'axe D (navigateur, actif par défaut) et l'axe E (`npm audit`) sur
un widget qu'on n'a **pas** écrit, pour décider de lui faire confiance —
exactement ce qu'Antoine a fait avec ses deux dépôts de calibrage, et ce
que quiconque clone ce dépôt public peut faire dès aujourd'hui sur un
widget de son choix. Ces écarts s'appliquent donc déjà à cet usage local,
pas seulement à une V2 hébergée qui n'existe pas encore :

| # | Constat | Fichier | Conséquence aujourd'hui | Conséquence en V2 |
|---|---|---|---|---|
| 2 | `npm audit` hérite tout `process.env` et lit le `.npmrc` du dépôt audité (clé `registry` interpolable) | `src/regles/e-dependances.js` (`npmAudit`) | Un widget hostile audité en local peut rediriger le trafic `npm audit` de la machine de l'auditeur, voire y faire fuiter des variables d'environnement | Même risque, mais côté serveur, avec les identifiants du service |
| 5 | `contexte.route('**/*', …)` ne couvre pas les WebSocket | `src/runtime/dynamique.js` | Un widget audité peut ouvrir une connexion WebSocket réelle pendant l'audit, hors de la neutralisation que le fichier documente | Idem, à l'échelle de tout ce que le service audite |
| 6 | WebRTC est hors de portée de `route()` | `src/runtime/dynamique.js` | Idem, par ICE/STUN/TURN/DataChannel | Idem |
| 7 | `newContext()` laisse `serviceWorkers` à `allow` | `src/runtime/dynamique.js` | Un widget peut enregistrer un Service Worker dont les requêtes échappent potentiellement à `route()` | Idem |
| 8 | Le passe-droit réseau « local » ne compare que le *hostname*, pas l'origine complète du harnais | `src/runtime/dynamique.js` | Risque limité en local (peu de services tiers sur `127.0.0.1` d'un poste de dev) | Plus net sur un serveur partagé, où d'autres services peuvent écouter en loopback |
| 9 | Aucun plafond de fichiers/taille cumulée en mémoire pendant l'inventaire | `src/contexte/inventaire.js` | Un dépôt hostile peut ralentir/geler la machine de l'auditeur (auto-DoS) | Un seul dépôt peut geler un worker partagé par tous les utilisateurs |
| 10 | Aucun timeout global sur l'axe D après le chargement initial, aucune limite CPU/mémoire sur Chromium | `src/runtime/dynamique.js` | Idem : un widget qui boucle bloque l'audit local jusqu'à intervention manuelle | Idem, sur l'infrastructure du service |
| 11 | Aucune limite de concurrence, pas de file d'attente | *(n'a pas de sens pour un outil en ligne de commande — un `gwaudit` = un process, un utilisateur, séquentiel par construction)* | — | Propre à la V2 : c'est l'orchestration par file d'attente du §5 qui l'introduit, elle n'existe pas encore |

Autrement dit : **il n'existe aujourd'hui aucun service hébergé par
Antoine à mettre en défaut** — la V2 n'est pas déployée, donc aucun des
points ci-dessus n'est une faille exploitable en production. Mais ce ne
sont pas non plus des limites purement théoriques réservées à un futur
hypothétique : ce sont des comportements réels du code publié, aujourd'hui,
que toute personne qui exécute `gwaudit --dynamique` (actif par défaut)
sur un widget auquel elle ne fait pas encore confiance expose sa propre
machine — Antoine y compris, dans l'usage même que la V1 est censée
couvrir. Rien n'empêche de corriger certains de ces points (8, 9, 10 en
particulier, qui ne coûtent rien en usage local légitime) indépendamment du
calendrier de la V2 ; ce n'est cependant pas à ce document de le décider,
c'est au fil qui possède le moteur.

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

- Fait : les constats 1, 3, 4 et 12 (SSRF sur le clonage, `--no-sandbox`,
  rattachement du commit au rapport, dossiers temporaires jamais purgés)
  sont corrigés dans le moteur — voir §1.
- Reste à trancher, côté fil moteur : corriger ou non, indépendamment du
  calendrier V2, les constats 8, 9 et 10 (§1) — ils réduisent un risque
  qui existe déjà pour l'usage local normal de `gwaudit`, sans coût
  fonctionnel apparent.
- Faire valider sur le VPS d'Antoine : le sandbox natif de Chromium dans
  son environnement Docker réel (§4), et l'esquisse `docker-compose`
  jointe.
