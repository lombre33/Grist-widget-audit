# Méthodologie de l'audit

## Principe général

Un constat est soit **prouvé** (observé à l'exécution), soit **certain**
(motif non ambigu dans le code), soit **probable** (heuristique, à confirmer
en revue), soit **à vérifier manuellement**. Ce niveau de confiance est
affiché sur chaque constat. Un outil automatisé qui présente une
heuristique avec la même autorité qu'une preuve d'exécution finit par ne
plus être cru sur rien : c'est le risque qu'on a cherché à éviter en premier.

Deux mécanismes de verdict, qui ne se compensent jamais entre eux :
- un **score** par axe (0 à 100), pondéré en score global ;
- des **points bloquants**, qui condamnent le verdict quel que soit le
  score par ailleurs. Une fuite de données confirmée reste rédhibitoire
  même à 95/100 sur tout le reste — c'est la logique d'un avis RSSI, pas
  d'une moyenne.

Un cas se distingue d'un axe que l'utilisateur n'a pas lancé (noté « non
exécuté », hors de la moyenne) et d'une mesure partielle (une vérification a
échoué pour une raison d'environnement : l'axe garde sa note, le verdict ne
peut pas être « conforme » sans réserve) : le widget **empêche lui-même la
mesure** (il bloque le navigateur, un fichier de code ne peut pas être lu).
Un widget qui empêche une mesure ne note jamais mieux que s'il la laissait
se faire : l'axe concerné est noté 0, le rapport dit ce qu'il vaut sur ce
qui a pu être lu et quel constat l'en empêche, et ce constat est toujours
bloquant. Un 0 de cette sorte dit que la mesure n'a pas pu se faire, non que
le code est mauvais.

## Modèle de menace retenu (axes C et D)

Un widget Grist est une page web tierce chargée dans une iframe, à laquelle
l'agent accorde un niveau d'accès (`none`, `read table`, `full`). Avec
`full`, le widget lit ET écrit l'intégralité du document. Le risque
dominant n'est donc pas la compromission du widget par un tiers : **c'est le
widget lui-même** qui dispose légitimement des données et peut les faire
sortir — volontairement, ou parce qu'une dépendance chargée depuis un CDN a
été compromise. D'où l'ordre de priorité effectif dans les règles : sortie
de données > privilège excessif > injection > stockage hors Grist > le reste.

## Axe A — Qualité du code

Analyse par arbre syntaxique (AST, via `acorn`), pas par expression
régulière sur le texte : une regexp qui cherche `eval(` se déclenche sur un
commentaire ou une chaîne de caractères. Mesures : taille des fichiers et
fonctions, complexité cyclomatique, imbrication, gestion d'erreur (`catch`
vide), traces de développement, duplication inter-fichiers, présence de
tests. Le guide de contribution n'impose aucun style : ces règles ne jugent
pas un style, elles mesurent ce qui coûte cher à un relecteur bénévole.

## Axe B — Lisibilité humaine

C'est l'axe le plus spécifique au guide Grist.Gouv, qui pose une exigence
inhabituelle : le code doit être compréhensible par un humain « sans avoir
besoin d'un outil d'IA », et met en garde contre la verbosité typique du
code généré sans relecture. On ne mesure pas « la compréhension » — on
mesure ses conditions : présence et contenu du README, nommage, densité de
commentaires rapportée à la taille du fichier, et des marqueurs (commentaires
« Étape 1 », formules d'assistant conversationnel, blocs Markdown oubliés
dans le code) dont l'accumulation — jamais un seul isolément — signale du
code probablement non relu. Ce constat est volontairement formulé comme une
question à vérifier, pas comme une accusation : le guide autorise l'usage de
l'IA, il interdit le dépôt de sortie brute non relue.

## Axe C — Sécurité applicative (statique)

Voir le modèle de menace ci-dessus. Points contrôlés : négociation du
niveau d'accès Grist et cohérence avec l'usage réel (lecture seule vs
écriture), sorties réseau, ressources chargées depuis un CDN sans contrôle
d'intégrité, injection DOM (`innerHTML`, `eval`, `document.write`),
écoute `postMessage` sans vérification d'origine, stockage hors Grist
(`localStorage`, cookies), secrets versionnés, aléa non cryptographique.

**Limite assumée** : une destination réseau *calculée à l'exécution*
(`fetch(variable)`) ne peut pas être résolue par lecture seule du code —
elle est signalée en confiance `à vérifier`, non bloquante, et c'est l'axe D
qui tranche en observant ce qui part réellement.

## Axe D — Sécurité en condition réelle

### Ce qui est exécuté, et ce qui ne l'est pas

L'axe D charge le widget dans un vrai Chromium (Playwright), face à un hôte
de test qui reproduit le **protocole RPC réel de Grist** — pas Grist
lui-même. Concrètement :

- Le widget charge le vrai `grist-plugin-api.js`, compilé sans modification
  depuis `app/plugin/grist-plugin-api.ts` du dépôt officiel
  [`gristlabs/grist-core`](https://github.com/gristlabs/grist-core)
  (licence Apache 2.0 — voir `ressources/grist-plugin-api/PROVENANCE.md`
  pour le commit exact et la licence complète).
- La négociation `grist.ready()` → `CustomSectionAPI.configure()` passe par
  la vraie bibliothèque `grain-rpc` que Grist utilise en production, avec le
  même transport (`postMessage` entre l'iframe et sa fenêtre parente).
- L'hôte de test (`src/runtime/harnais/hote.js`) répond à cette négociation
  avec un document minimal — quelques colonnes, dont une valeur contient une
  charge de test XSS — et journalise chaque appel reçu.

Ce n'est **pas** une instance Grist : pas de moteur de calcul, pas de vraie
authentification, pas de vrai stockage, pas de vraie UI de mappage de
colonnes. C'est un partenaire RPC protocolairement exact. Ce choix permet
d'exécuter l'axe D à chaque audit, en quelques secondes, sans dépendre d'un
accès réseau à une image Docker ni d'un temps de démarrage de plusieurs
minutes — voir `docker/README.md` pour l'étape complémentaire avec une
vraie instance Grist, qui reste nécessaire avant toute mise en production.

### Sécurité de l'audit lui-même

Aucune requête sortante n'est laissée aboutir vers un domaine tiers réel.
Chaque requête HTTP du widget est interceptée (`context.route`) ; celles
qui visent l'origine locale du harnais passent normalement, les autres sont
enregistrées (URL, méthode, corps si présent) puis court-circuitées par une
réponse neutre. Le canal WebSocket échappe à cette interception HTTP ;
Chromium est lancé avec des règles de résolution réseau qui bloquent déjà
une cible externe réelle par ce canal, nom d'hôte ou IP littérale, mais
laissent passer `127.0.0.1`/`localhost` sans la vérification d'origine
exacte que `context.route` applique au HTTP. `context.routeWebSocket`
comble ce point précis (une connexion WebSocket vers un autre port local
aurait pu réellement atteindre un autre service du même poste, sans qu'une
seule trace n'en reste dans le rapport) et donne en même temps au rapport
la visibilité qui manquait sur toute tentative WebSocket, quelle que soit
sa destination. **Un widget qui exfiltre réellement des données ne les
fait jamais sortir pendant l'audit** — le rapport dit ce qui a été *tenté*,
pas ce qui a été *transmis*.

### Ce qui est vérifié, avec preuve d'exécution

1. **Réseau réellement émis** : confronté aux constats C-EXFIL-* de l'axe
   C — une destination « à vérifier » en statique devient soit confirmée
   (le trafic est parti), soit non observée sur ce scénario (ce qui
   n'exclut pas qu'un autre scénario le déclenche : la couverture n'est pas
   exhaustive, elle porte sur le chargement initial et une notification de
   changement de données).
2. **Injection XSS réellement exécutée** : la charge `<img
   src=x onerror=…>` placée dans deux colonnes du document de test déclenche
   un compteur si, et seulement si, le widget l'a insérée dans le DOM d'une
   façon qui exécute le gestionnaire — pas une supposition sur la présence
   d'`innerHTML` dans le code, une preuve que la donnée devient du code.
3. **Accessibilité mesurée** : [axe-core](https://github.com/dequelabs/axe-core)
   (Deque Systems) exécuté sur le DOM réellement rendu par le widget, dans
   son propre cadre. Couvre une partie mécaniquement vérifiable du RGAA ;
   ne couvre ni le contraste dans tous les états, ni la navigation clavier,
   ni la gestion du focus, ni les critères qui demandent un jugement humain.
   **L'absence de violation ne vaut pas conformité RGAA.**
4. **Erreurs d'exécution** (console, exceptions non interceptées) sur un
   scénario de chargement pourtant simple.

## Axe E — Dépendances

Trois anneaux de risque, du plus critique au moins maîtrisé : bibliothèque
chargée à l'exécution depuis un CDN (le code livré au navigateur peut
changer sans que le dépôt bouge), bibliothèque embarquée dans le dépôt sans
version ni licence traçable, dépendances npm (verrouillage, versions
figées, `npm audit` contre la base d'avis GitHub quand un accès réseau est
disponible). Complété par la vérification de la licence du dépôt — condition
de fait pour qu'un fork par l'équipe Grist.Gouv soit juridiquement possible.

## Axe F — Conformité, souveraineté, accessibilité, sobriété

Appels vers des services non-souverains identifiés explicitement (Google
Fonts, Google Analytics, CDN publics, API d'IA hors UE…), vérifications
RGAA statiques, poids de la surface exécutée (écoconception), et
conventions du guide de contribution (nom de dépôt, `SECURITY.md`,
cohérence d'un éventuel `manifest.json`).

## Ce que l'outil n'a pas lu

Un audit qui ne dit pas ce qu'il n'a pas vu se lit comme un audit qui n'a rien
trouvé. L'outil lit chaque fichier de texte du dépôt dans des plafonds (nombre
de fichiers, texte lu en tout, taille d'un fichier, entrées listées dans les
dossiers exclus, résolutions d'adresses de worker, arêtes de document,
imbrication de code littéral), et aucun ne se passe sous silence :

- un **plafond atteint** est un constat critique et bloquant (C-SURFACE-01 ;
  C-XSS-03 pour l'imbrication de code littéral, C-EXFIL-03 pour les feuilles
  `data:` imbriquées) qui empêche les axes que ce qui n'a pas été lu aurait
  nourris (`axesEmpeches`) : un widget qui s'arrange pour que l'outil ne le lise
  pas ne note jamais mieux que s'il s'était laissé lire ;
- un **fichier de code non lu** qu'une page atteint (trop gros, plafond cumulé
  atteint, lecture refusée, extension de binaire chargée comme du code) est un
  constat critique et bloquant par fichier (C-SURFACE-02). Il empêche B, C, E
  et F, qui lisent tout le code exécuté ; A aussi, sauf pour un dossier exclu ou
  une bibliothèque tierce, que A ne juge pas ;
- un **fichier non lu qu'aucune page n'atteint comme du code** (des données, du
  code que la surface de chargement n'atteint pas) est une information qui le
  nomme : le navigateur ne l'exécute pas, le risque est celui d'une fuite que
  les règles qui lisent tout le texte du dépôt n'ont pas pu voir. **Limite
  connue** : une adresse entièrement calculée (`import(x)`) ne désigne aucun
  dossier que l'inventaire sache nommer, donc un fichier de code non lu que
  seule une telle adresse atteindrait reste dit comme information. L'`import()`
  calculé est, lui, déjà dit par une règle de l'axe C.

Les plafonds ne sont pas fixés au jugé : `scripts/mesurer-marges-plafonds.mjs
<dépôt>…` dit ce que chacun coûte à des dépôts donnés et la marge qui reste
(aucune cible honnête ne doit y buter). Celui d'un fichier tient compte de ce que
lire un fichier coûte, en temps et en mémoire, proportionnellement à sa taille.

## Ce que cet outil ne fait pas

- **Il ne remplace pas une revue de code humaine.** Le guide de
  contribution le dit sans détour : un relecteur doit pouvoir défendre
  chaque ligne. Un score élevé ne dispense de rien.
- **Il ne couvre pas le RGAA de façon exhaustive** (voir axe D/F).
- **Il ne fait pas d'analyse juridique** (RGPD, réutilisation de données,
  accessibilité légale) : il signale les points qui appellent cette
  analyse, il ne la mène pas.
- **Il ne teste pas la logique métier** : un widget peut être irréprochable
  sur ces six axes et faire un calcul faux. Ce n'est pas son rôle — c'est
  celui des tests unitaires (axe A, règle A-TEST-*) que le widget doit
  fournir.
- **Il ne remplace pas un test avec une vraie instance Grist** avant mise
  en production (voir `docker/`).
