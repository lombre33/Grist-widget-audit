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

Deux mesures se font sur ce que le code est, non sur ce qu'il ressemble.
- **Une fonction se mesure sur son propre corps** (complexité de McCabe,
  imbrication, lignes) : les fonctions qu'elle contient, rappels, fonctions
  internes, méthodes d'une classe qu'elle déclare, ont chacune leur mesure et
  ne s'ajoutent pas à la sienne. Une fermeture qui enveloppe tout un widget,
  `(function () { … })()`, n'est donc pas « une fonction de neuf cents lignes
  et de trente et un chemins » : trente fonctions de deux chemins ne font pas
  une fonction de trente et un. Pour la longueur, une fonction appelée là où
  elle est écrite ne compte que ses lignes propres, et la taille du fichier
  est dite par la règle de taille de fichier. Un `else if` prolonge la chaîne
  d'un `if` au même niveau : huit `else if` à la suite sont à plat, non à
  huit niveaux. Le constat nomme la fonction (`render`, `Carte.constructor`,
  « le rappel passé à `grist.onRecords` ») ; un nom que le widget choisit est cité
  et borné comme tout texte qui en vient. Le code qui n'est dans aucune fonction
  (le niveau supérieur d'un fichier, d'un script de page) se mesure de la même
  façon, en complexité et en imbrication, avec les mêmes seuils, et le constat
  dit l'instruction où regarder : un widget écrit à plat ne vaut pas mieux que
  le même code dans une fermeture. Sa longueur reste dite par la règle de taille
  de fichier.
- **Les lignes d'un fichier se comptent d'après les commentaires que lit
  `acorn`**, non d'après le premier caractère de chaque ligne : une ligne est
  du code dès qu'un caractère qui n'est pas un blanc est hors de tout
  commentaire, un commentaire quand elle n'a que des blancs et des caractères
  de commentaire, vide quand elle n'a que des blancs. Les lignes d'un
  commentaire de bloc sans étoile en tête sont des commentaires, `/* x */ f();`
  est du code. Un fichier qu'`acorn` ne lit pas (JSX, TypeScript, erreur de
  syntaxe) se compte encore d'après le premier caractère, et le constat le dit.

Le code dupliqué (A-DUP-01) se cherche, lui aussi, sur l'arbre et non sur le
texte : des fonctions, des blocs ou des suites d'instructions de même forme, à
l'identique ou aux noms et aux valeurs près, dans un fichier ou entre fichiers,
scripts de page compris. Le renommage doit rester cohérent : `a + b * a` et
`x + y * x` sont des copies, `x + y * y` n'en est pas une. Seul ce qui porte de
la logique compte : ni les tableaux de données, ni les suites d'appels du même
nom (`set('a', 1); set('b', 2); …`) ou d'affectations de littéraux, où la
répétition est l'idiome. Un clone plus gros couvre ce qu'il contient : une
fonction copiée ne fait pas trente blocs, elle en fait un. Tout le code lisible
qui n'est pas celui d'un autre se compare, que la page l'exécute ou non, tests
compris (le constat dit la part des blocs qui n'est que dans des fichiers de
test). Jusqu'à cinq clones entre fichiers, le constat est mineur ; au-delà, ou
pour un clone répété plus de cinq mille fois, il est majeur.

Ce que la recherche ne compare pas est dit (A-DUP-00, une information), pour que
l'absence de constat ne passe pas pour une preuve : le code d'un autre
(bibliothèques tierces, code construit), le code qu'aucun humain ne relit
(minifié, empaqueté par un outil de build), ce qu'un outil a généré et que la
page n'exécute pas, et ce qui ne tient pas dans les plafonds de mémoire et de
travail de la recherche. Ces plafonds se comptent, ils ne se chronomètrent pas :
le même dépôt donne le même rapport sur une machine lente ou rapide. Une erreur
de l'outil pendant la recherche n'arrête pas l'audit : elle se dit de la même
façon. Quand le code laissé de côté par un plafond, ou par une erreur, est du
code que la page exécute, la mesure est partielle : l'axe garde ce qu'il a vu,
sans lui faire payer ce que l'outil n'a pas pu lire, mais le verdict ne peut
plus être « conforme » sans réserve.
Se dire généré, ou porter une licence, n'exempte rien : le code généré que la
page exécute se compare.

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

### Secrets versionnés (C-SECRET-01)

Un secret poussé dans un dépôt public est perdu à l'instant où il l'est : le
retirer d'un fichier ne l'efface pas de l'historique, il faut le révoquer. La
règle cherche deux choses, et ne les mélange pas.

- **Le format d'un fournisseur** (clé d'accès AWS, jetons GitHub, clés de type
  OpenAI, jetons Slack, clé privée PEM avec son corps, JWT) est reconnu dans
  tout texte du dépôt, README et carte de sources compris, et dans un fichier
  que l'outil ne sait pas lire : seul un fichier de verrous de paquets, dont
  les empreintes ressemblent à des clés, n'est pas lu. C'est un critique
  bloquant, même sous un nom sans rapport. Un format que son fournisseur
  publie pour être public (clé Google, clé publique Stripe, jeton public
  Mapbox, clé anonyme d'un fournisseur de base de données comme Supabase) est
  une information : il n'y a rien à révoquer. Un JWT n'est la clé anonyme que si
  sa charge utile, décodée, est un objet JSON dont `role` vaut `anon` : tout
  autre rôle (`service_role` compris), une charge sans rôle ou qui n'est pas du
  JSON, un rôle qui n'est pas au premier niveau, le dernier de deux rôles qui
  se contredisent, laissent le jeton critique et bloquant. L'émetteur (`iss`) et
  le rôle sont dits en clair dans la preuve, et l'émetteur aussi dans le texte
  du constat (l'émetteur ne porte aucun secret ; le widget le choisit, il est
  donc borné à cent caractères, rendu en Unicode bien formé et cité dans un
  extrait de code, après que chaque caractère qu'on ne voit pas a été écrit en
  clair : ni la page HTML, ni le Markdown, ni une console, ni le JSON ou le SARIF
  ne le lisent comme du balisage, du Markdown ou une suite d'échappement ; le
  nom d'une affectation qui porte un tel caractère est cité de la même façon, un
  nom honnête est dit tel quel), le jeton seul reste masqué. Les clés d'exemple de la documentation
  d'AWS ne disent rien. Un format dont la partie que le fournisseur tire au
  hasard se voit fausse n'est pas une clé : `ghp_` suivi de trente-six `x`,
  `xoxb-your-bot-token`, `AKIA` suivi de seize `X`, `sk_test_` suivi de `x`
  (un seul caractère répété, une suite, ou des mots joints dont l'un est un mot
  de remplacement d'une liste courte de quatre lettres au moins, `your`, `token`,
  `here`, `example`, derrière le préfixe du fournisseur). La forme de mots seule
  ne fait pas un leurre : une clé n'est ni un caractère répété ni une suite, et
  des mots joints sans mot de remplacement n'en sont pas (la forme seule ne
  suffisait pas : une clé AWS sur cent, un chiffre puis quinze majuscules, se
  coupe en morceaux qui ont la forme de mots). Il passe avant le format et avant
  l'allure générée. Deux limites, dites pour que personne n'en croie une levée.
  Un leurre écrit avec d'autres mots, sans aucun mot de la liste, reste signalé,
  un faux constat que le lecteur écarte d'un coup d'œil, plutôt qu'une clé qui
  passe. Et une clé tirée au hasard dont l'un des morceaux est, par hasard, un
  mot de remplacement entier (`TEST`, `here`), et dont les autres morceaux ont la
  forme de mots, passe pour un leurre : elle n'est ni signalée ni masquée, une
  absence. Le hasard le fait rarement, et `node
  scripts/mesurer-leurres-au-hasard.mjs --tirages=4000000` le compte, par forme de
  fournisseur, avec les mêmes tirages à chaque lancement ; son code de sortie est 1
  au-delà d'un tirage sur cent mille. Le reste du préfixe (`fake_`, `stub-`,
  `test_` suivis d'une valeur tirée au hasard) n'absout rien.
- **Un « nom = valeur »** : un littéral affecté à un nom dont le **dernier mot**
  est un secret (`apiKey`, `DB_PASSWORD`, `authToken`, `mot_de_passe`), car
  `tokenUrl` ou `passwordLabel` disent ce que la valeur décrit, non ce
  qu'elle est. En JavaScript, par l'arbre (déclaration, affectation, propriété
  d'objet, champ de classe) ; dans un fichier de configuration (`.env`, JSON,
  YAML, INI, properties, TOML, `.npmrc`), ligne à ligne. La valeur se juge
  dans cet ordre : ce qui se voit faux (le leurre ci-dessus, derrière le
  préfixe d'une clé ou seul : trente-deux `0`, l'UUID nul, une suite) ne dit
  rien ; d'allure générée (du hasard plutôt que des mots : assez de
  caractères, trois classes ou une entropie haute ; un hexadécimal long, un
  UUID qui n'est pas une suite) c'est un critique bloquant ; une valeur de
  remplacement (`xxxx`, `changeme`, `${VAR}`, `process.env…`, `example`), une phrase
  ou une adresse ne dit rien ; un libellé de traduction (`Passwort`,
  `Contraseña`, `API-Schlüssel`, `パスワード` : un mot de langue à capitale
  initiale ou un sigle, en lettres seules, sans chiffre ni symbole) ne dit rien,
  c'est le champ d'un fichier de langue, non un mot de passe choisi ; dans un
  fichier de configuration d'exemple (`.env.example`, `.env.sample`,
  `.env.template`, `config.example.json`, `exemple.env` : le mot est un mot
  entier du nom du fichier ; jamais un script, que la page charge et que le
  navigateur exécute, quel que soit son nom) un mot seul ne dit rien non plus,
  seuls un format et l'allure générée y comptent ; le reste, assez long pour être autre chose qu'un mot, est « à
  vérifier » : majeur, non bloquant, car ce peut être un exemple.

Le constat ne reproduit jamais la valeur (quatre caractères de chaque côté au
plus, moins pour une valeur courte), et redit au plus une fois ce qu'un littéral
exécuté (`eval`, `Function`) reprend d'un fichier déjà lu.

**Aucun texte d'un rapport ne redit un secret, quelle que soit la règle qui
l'écrit.** Une règle qui recopie du code ou une adresse (C-EXFIL-01, C-XSS-01,
C-XSS-03, D-RESEAU-01…) recopie aussi ce qu'ils portent : un jeton dans
l'adresse d'un `fetch` se retrouvait en entier dans `rapport.json`, `rapport.html`
et `rapport.md`. `constat()` masque donc, à la création de chaque constat de toute
règle : tout format de fournisseur (titre, constat, impact, remédiation, extrait,
preuve), le corps d'une clé privée, et, dans le code que montrent l'extrait et la
preuve (non la prose), la valeur d'un « nom = valeur » que C-SECRET-01 signalerait.
Le masque passe avant la coupe de l'extrait (un jeton que la coupe partagerait
ne serait plus reconnu), une clé publique par conception et un leurre restent tels
quels, et la preuve se lit sur trente-deux niveaux : ce qui est plus profond, ou
qui boucle, est remplacé par `[trop profond]`, jamais rendu tel quel. Limites : le
chemin du fichier (`fichier`) n'est pas masqué, et un jeton collé à un caractère de
mot (sans frontière) n'est reconnu ni par la règle ni par le masque.

**Limites assumées** : la règle dit ce qu'elle voit, elle ne prouve pas qu'un
secret est valide ; un mot de passe choisi par une personne (`Soleil2024!`, sans
allure de hasard) n'est dit que « à vérifier », sous un nom qui évoque un
secret, et il n'est pas dit du tout sous huit caractères ; un mot de passe faible
écrit comme un libellé (`Sunshine`, une capitale puis des lettres) n'est plus
signalé, et un libellé écrit en minuscules (`wachtwoord`) ou en majuscules de
six lettres et plus (`PASSWORT`) l'est encore ; un fichier
TypeScript ou un code illisible n'est lu que par les formats de fournisseur
(et, quand une page l'exécute, dit illisible par C-SURFACE-03) ; un format de
fournisseur absent de la liste (clés Stripe secrètes, Anthropic, jetons Slack
d'application…) n'est reconnu que s'il est affecté, dans un fichier JavaScript
ou de configuration, à un nom qui évoque un secret ; un JWT collé à un caractère
de base64 URL n'est pas reconnu (le prix de ne chercher une suite qu'à son
début).

**Le coût est borné par construction**, parce qu'en V2 un algorithme quadratique
est un déni de service : le nom se juge sur ses derniers caractères et la valeur
sur ses premiers (`LONGUEUR_DE_NOM`, `APERCU`), chaque occurrence d'un mot de
secret est prise pour centre d'un travail borné (pas d'expression régulière à nom
libre, qui relirait la suite entière à chaque départ), et chaque suite gloutonne
d'un format a une borne haute : sans elle, l'analyseur d'expressions régulières de
V8 déborde de sa pile de retour arrière sur une suite de quelques millions de
caractères (une image en base64, une carte de sources), et la règle échoue avec
tous les secrets du reste du dépôt. `scripts/mutants-c-secret.mjs` rejoue un défaut
plausible par choix de la règle, et les essais sont faits pour que chacun en tue
un.

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
  calculé est, lui, déjà dit par une règle de l'axe C ;
- un **code que l'outil ne sait pas lire** et que la page exécute est un
  constat critique et bloquant par fichier, ou par script de la page
  (C-SURFACE-03), avec les axes empêchés du fichier non lu : la syntaxe
  qu'acorn refuse (TypeScript, JSX que la page charge), une imbrication que la
  pile de l'analyse ne porte pas alors que le navigateur l'exécute, un parcours
  des règles qui déborde, une règle qui échoue sur un code piégé, une erreur de
  l'outil lui-même. L'inventaire des fichiers lit ce même code pour savoir ce
  que la page charge : ce qu'il n'a pas pu lire ou parcourir est dit comme le
  reste, une fois par unité, avec l'étape où l'échec a eu lieu (lecture,
  parcours d'une règle, inventaire), et une lecture qui a échoué n'est pas
  refaite par les règles. Le code piégé est dit et les autres fichiers sont
  audités comme s'il n'était pas là : il ne fait pas tomber l'audit. Une
  imbrication que la pile ne porte pas ne fait pas non plus abandonner le
  processus : la lecture rattrape elle-même le dépassement de pile, sans
  expression régulière (`LecteurAcorn`), là où acorn en compilait une au bord
  de la pile, ce que V8 ne pardonne pas (abandon sans rapport, à certains
  lancements). Un
  fichier que le parcours d'une règle n'a pas pu faire et qu'aucune page
  n'exécute est une information groupée, qui ne bloque pas. Quand c'est la
  lecture elle-même qui échoue, le texte du constat dit ce qui a eu lieu :
  « aucune règle ne l'a lu » (aucune n'a eu d'arbre), là où un parcours qui
  échoue dit que ce que les règles en disent est incomplet (les autres ont
  lu). **Limite connue** : un fichier que la lecture refuse et qu'aucune page
  n'exécute (du TypeScript que rien ne charge) n'est pas dit.

Un fichier qu'une balise script, un import ou un worker désigne par son adresse
est du code pour le navigateur **quelle que soit son extension** :
`<script src="logique.txt">` exécute le texte du fichier, sous le type que
l'hébergement lui donne, et c'est l'auteur du widget qui choisit l'hébergement.
L'audit le lit comme du code. Trois exceptions, parce que le navigateur n'y
exécute rien : le JSON valide (un objet ne se lit ni comme un module ni comme un
script) ; un import de données (`import … with { type: 'json' }`, `'css'`,
`'text'`, `'bytes'`, aussi en `import()` et `export … from`) ; et ce qu'une
carte d'import désigne sans que rien dans le code lu l'importe, qui n'est du
code que si un import sans type de données l'emploie : il est lu comme du code
quand il se lit comme du JavaScript, et sinon dit par une information (il peut
être de la donnée, ou du code que l'outil ne sait pas lire).

Le code que l'outil a lu **désigne aussi des fichiers par un nom** : `import
'lib'` et `import 'lib/x.js'` mènent, par la carte d'import de la page, à un
fichier, qui est du code quelle que soit son extension (`"lib/": "./libs/"` fait
de `libs/x.txt` du code dès qu'un import le nomme). La carte se lit comme
Chromium l'applique, et `tests/carte-import-chromium.test.mjs` compare chaque cas
à `import.meta.resolve` de Chromium : les cartes d'une page se fusionnent et la
première qui nomme une clé l'emporte ; dans une table, la clé exacte passe avant
le plus long préfixe (une clé qui finit par `/`) ; un nom nu qu'aucune clé ne
nomme est une erreur du navigateur ; une adresse `null` ou qui n'est pas une
chaîne bloque le nom ; `scopes` donne au module qui importe sa propre table avant
celle du dessus. Un fichier ainsi désigné qui ne se lit pas est un constat
critique et bloquant (C-SURFACE-03), comme un fichier qu'une balise `<script src>`
désigne. Un import de données par un nom n'en fait pas du code, et un code que
l'outil ne lit pas ne désigne rien par ses noms (ce que son texte semble importer
peut être un commentaire ou une chaîne). La résolution des noms consomme le
plafond d'analyse de document (C-SURFACE-01) : un plafond atteint est dit, il ne
désigne pas en silence.

**Limites connues** : le JavaScript qu'acorn ne connaît pas encore (une
proposition très récente du langage) est dit illisible, pas absous ; l'ordre des
cartes et des chargements (une carte lue après le premier module est ignorée
par le navigateur) n'est pas modélisé, une carte de la page compte toujours ;
quand plusieurs portées de la carte correspondent au module qui importe,
Chromium 141 n'en retient pas toujours la plus longue comme la norme le veut : la
résolution rend alors les adresses de toutes celles qui nomment le nom, le doute
inclut ; et une adresse entièrement calculée (`import(x)`) ne désigne aucun
fichier que l'inventaire sache nommer (elle est dite par une règle de l'axe C).

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
