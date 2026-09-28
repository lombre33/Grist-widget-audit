# Pistes d'exhaustivité et d'efficacité — état des lieux et référentiels

État établi sur le commit `6394556` (2026-09-20 20:20 UTC), confronté à un
clone frais de [`publipostageGrist`](https://github.com/lombre33/publipostageGrist)
et de [`Grist_Table_structure_import`](https://github.com/lombre33/Grist_Table_structure_import).
Document d'étude : il propose, il n'implémente pas — `src/regles/` et
`src/moteur/` restent la propriété du fil qui les fait évoluer ce soir même.

## 1. Ce qui existe déjà (bref)

- **CLI** : `--sans-dynamique`, `--sans-reseau`, `--sortie`, `--json`,
  `--sans-html`, `--sarif`, `--scenario <fichier.json>` (données de test
  personnalisées pour l'axe D), `--diff <a.json> <b.json>` (comparaison de
  deux audits, score par axe + constats corrigés/nouveaux/persistants),
  `--interface [--port]`.
- **Rapports** : Markdown, JSON, HTML autonome, SARIF 2.1.0 (CI/CodeQL).
- **Interface web** : formulaire → suivi en direct (SSE) → page de rapport,
  durcie (verrou un-audit-à-la-fois, arbre de processus tué au timeout,
  purge, CSP sur `/rapport`).
- **Emplacements précis** : la quasi-totalité des règles remontent déjà
  `fichier`/`ligne`, y compris depuis ce soir pour les entrées de
  `package.json` (E-DEP) et de `manifest.json` (F-GUIDE) — auparavant
  seulement le nom de fichier.
- **Nouveau ce soir** : `A-MORT-01` (code mort structurel), `B-DOC-04`
  (service externe contacté mais non documenté dans le README — contrôle
  croisé avec ce que l'axe D observe réellement), et un point de vérité
  unique `f.vendorise` qui exempte le code tiers embarqué des axes A/B tout
  en le gardant pleinement noté en C/D/E.

Tes quatre demandes de ce soir (emplacements exhaustifs, téléchargement du
rapport, roadmap de correction, retour en arrière depuis la page de
résultat) sont en cours de traitement — je ne les liste pas ci-dessous comme
manquantes.

## 2. Principe retenu pour la suite

Plus exhaustif ne veut pas dire plus de constats. Une règle n'a d'intérêt
que si elle change un verdict, un score, ou ce que tu dois corriger — sinon
elle ajoute du bruit et use la confiance dans l'outil. Chaque piste
ci-dessous est donc testée sur `publipostageGrist` (35/100, NON CONFORME)
et `Grist_Table_structure_import` (81/100, CONFORME), pas seulement
argumentée dans l'absolu. Et un widget navigateur de quelques fichiers
n'est pas une application d'entreprise : une bonne part de ce qu'un
référentiel senior generaliste demanderait (CODEOWNERS, versionnage
sémantique, changelog, revue de PR obligatoire...) ne s'y applique pas et
n'est pas retenue.

## 3. Angle mort trouvé dans une règle existante (priorité la plus haute)

**`A-TEST-01`/`A-TEST-02`** (`src/regles/a-qualite.js:277-281`) détectent les
tests par motif de nom de fichier : `(^|\/)(tests?|__tests__|spec)\/` ou
`\.(test|spec)\.(m?js|ts|jsx|tsx)$` pour l'unitaire ; présence de
`playwright|cypress|puppeteer|e2e|integration|browser` dans le chemin, ou
`@playwright/test|require(['"]puppeteer|from ['"]playwright` dans le
contenu, pour l'intégration.

`publipostageGrist` a un dossier `dev-tests/` avec 15 fichiers de scénarios
(`scenarios-autosave.js`, `scenarios-docx.js`, `scenarios-tables.js`...), un
lanceur (`runner.js`) qui exécute chaque scénario et capture les exceptions
sans les avaler, et un serveur headless (`run-headless.mjs`) qui pilote un
vrai Chromium via
`require('/opt/node22/lib/node_modules/playwright')`. C'est une
infrastructure de test réelle et substantielle — mais elle ne matche
**aucun** des deux motifs : `dev-tests/` ne commence pas par `test(s)?/`
(le `(^|\/)` exige la limite juste avant, `dev-tests` a `dev-` collé
devant), aucun nom de fichier ne contient `e2e`/`browser`/`playwright`, et
`require('/opt/.../playwright')` ne matche ni
`require(['"]puppeteer` ni `from ['"]playwright`.

Conséquence mesurée : `publipostageGrist` reçoit aujourd'hui `A-TEST-01`
*et* `A-TEST-02` en sévérité majeure — « aucun test unitaire identifié »,
« aucun test d'intégration identifié » — alors que le dépôt a
manifestement une suite de tests, documentée qui plus est
(`dev-tests/README.md`, `dev-tests/PROTOCOLE_TEST_MANUEL.md`,
`dev-tests/BUGS.md`). Un verdict qui affirme l'absence de quelque chose de
présent est le pire des deux mondes : il ne se contente pas de rater un
point, il envoie un correctif inutile ("ajoute des tests") à quelqu'un qui
en a déjà — exactement le risque que la méthodologie dit vouloir éviter en
premier (confiance dans l'outil).

**Piste concrète** (implémentable par le fil qui tient `src/regles/`) :
- Élargir le motif unitaire à un segment de chemin contenant `tests?`
  entouré de frontières `-`/`_`/`/` plutôt que seulement en préfixe :
  `(^|[/_-])tests?([/_-]|$)` capture `dev-tests/`, `test-utils/`,
  `unit_tests/` sans capturer `latest.js` ou `contest.js`.
- Élargir la détection e2e/intégration côté contenu à une preuve
  protocolaire plutôt qu'à une syntaxe d'import précise : présence de
  `playwright` n'importe où dans un `require(...)`/`import`, ou appel à
  `.launch(` / `.newPage(` / `chromium.` — ce qui est réellement observé
  ici plutôt que le nom exact du paquet cité.
- Garder `A-TEST-03` (point positif) tel quel une fois les deux motifs
  élargis : il se déclenche automatiquement dès que `testsUnitaires` n'est
  plus vide.

Effet attendu sur les deux dépôts : `publipostageGrist` perd deux constats
majeurs incorrects (le score A, aujourd'hui à 2/100, remonterait sans que
rien n'ait changé dans le widget — l'outil devient juste plus juste, pas
plus indulgent) ; `Grist_Table_structure_import`, déjà bien identifié
(`test/*.test.mjs`, `node --test`), n'est pas affecté.

## 4. Une graduation utile sur une règle qui existe déjà : `C-CSP-01`

Aujourd'hui `C-CSP-01` (`src/regles/c-securite.js:436-448`) est binaire :
présence ou absence d'une balise `<meta http-equiv="Content-Security-Policy">`
sur le point d'entrée, sévérité mineure dans les deux cas où elle manque.
Une CSP présente mais permissive (`default-src *`, `script-src
'unsafe-inline'` sans raison) passe la règle aussi bien qu'une CSP stricte
— c'est le défaut classique d'un contrôle de présence : il peut être
« satisfait » sans apporter de protection réelle.

`Grist_Table_structure_import` a une CSP réellement stricte
(`default-src 'none'; script-src 'self' https://docs.getgrist.com
'unsafe-eval'; connect-src 'none'; object-src 'none'; base-uri 'none';
form-action 'none'`). Fait notable en la lisant : elle contient
`'unsafe-eval'` dans `script-src` — vraisemblablement nécessaire pour la
négociation `grain-rpc` du `grist-plugin-api.js` officiel. C'est
exactement le genre de nuance qu'une règle de gradation doit intégrer
plutôt qu'ignorer : sanctionner `unsafe-eval` sans discernement
pénaliserait ce dépôt-là précisément pour avoir respecté l'intégration
Grist officielle.

**Piste concrète** : garder `C-CSP-01` pour l'absence totale (inchangé),
ajouter une variante graduée qui ne regarde que deux signaux peu
discutables sur une CSP déjà présente — `default-src` (ou `script-src` s'il
est défini séparément) contenant un joker `*` non qualifié, et
`'unsafe-inline'` dans `script-src` (celui-ci, contrairement à
`unsafe-eval`, n'a pas de raison connue d'être nécessaire pour un widget
Grist). Sévérité mineure, jamais bloquante — un signal de qualité, pas un
verdict de sécurité en soi. `Grist_Table_structure_import` ne serait pas
affecté (aucun des deux signaux) ; une CSP « décorative » type `default-src
*` le serait, ce qui est le cas réel visé.

## 5. Un signal à faible poids mais réel : CI qui rejoue les mêmes garanties

`Grist_Table_structure_import` a une CI GitHub Actions
(`.github/workflows/ci.yml`) qui, à chaque push, exécute les tests **et**
interdit par recherche de motif `eval(`/`new Function(`/`.innerHTML =`/
`document.write(` dans `js/`, **et** interdit toute balise `<script src>`
non listée explicitement dans `index.html` — c'est-à-dire une automatisation
continue d'une partie de ce que `gwaudit` vérifie ponctuellement.
`publipostageGrist` n'a aucun workflow CI.

C'est un signal de méthode (le dépôt se protège lui-même des régressions
qu'un audit ponctuel ne peut pas voir), pas un signal de sécurité du widget
lui-même — je le classerais en **info**, jamais en majeur ni bloquant, sur
la présence d'un `.github/workflows/*.yml` qui exécute au moins les tests
du dépôt. Sur les deux dépôts de référence, l'effet est marginal (les scores
sont déjà nettement différenciés par des points plus lourds) : je la
retiens à titre d'enrichissement, pas comme une priorité — et seulement si
le guide de contribution en fait mention quelque part (à vérifier auprès
du fil qui tient le guide ; je ne l'ai pas sous les yeux ici).

## 6. Pistes envisagées et écartées (pour la transparence)

- **`Referrer-Policy`** (`Grist_Table_structure_import` a `<meta
  name="referrer" content="no-referrer">`) : bonne pratique réelle, mais
  n'aurait rien changé sur les deux dépôts de référence aujourd'hui —
  écartée pour l'instant, faute d'impact mesurable.
- **SRI (`integrity=`) sur les ressources CDN** : déjà vérifié, dans
  `C-EXFIL-*` et `E-DEP-*` (`c-securite.js:247`, `e-dependances.js:41`).
  Pas une piste, un point déjà couvert — je le signale seulement parce que
  je l'ai d'abord cru manquant avant de relire le code.
- **Zéro dépendance npm en exécution** : déjà récompensé mécaniquement par
  l'absence de constats E-DEP/E-VULN quand il n'y a rien à trouver ; pas
  besoin d'une règle dédiée.
- **Accessibilité au clavier / gestion du focus** (navigation Tab, focus
  visible) : la méthodologie de l'axe D dit elle-même ne pas la couvrir
  (`docs/METHODOLOGIE.md`, axe D §3). `Grist_Table_structure_import`
  (boîte de dialogue `<dialog>`, `aria-haspopup`) laisse penser qu'un
  contrôle simple (simuler des `Tab`, vérifier qu'un élément garde un focus
  visible) serait réaliste à ajouter à l'axe D. C'est une piste solide,
  mais elle touche `src/runtime/` — je la remets au fil qui tient cet axe
  plutôt que de la creuser ici.

## 7. Recommandation

Par ordre d'impact réel sur les deux dépôts de référence : §3 (angle mort
A-TEST) d'abord — c'est une correction d'exactitude, pas un ajout, et c'est
celle qui change le plus un verdict aujourd'hui erroné. §4 (CSP graduée)
ensuite — referme un contournement possible d'une règle existante sans
inventer de nouvel axe. §5 (signal CI) en complément mineur, à confirmer
contre le guide de contribution avant de l'ajouter.

## 8. Deuxième passe : regard RSSI très critique (vol de données, intrusion)

Demandé par Antoine le 2026-09-20 (soir) : reprendre l'exercice avec un
regard de RSSI qui anticipe activement le vol de données et l'intrusion,
plutôt que la qualité générale. Deux questions de sécurité ne doivent pas
se mélanger ici : ce que peut faire un widget malveillant aux données de
celui qui l'installe (le sujet ci-dessous, axes C et D) ; et l'exposition
de l'outil d'audit lui-même, qui exécute du code inconnu (déjà traitée à
part — `docs/ARCHITECTURE-V2.md`, quatorze écarts recensés, neuf corrigés,
trois atténués, deux ouverts sur la mémoire/la concurrence — pas repris
ici).

Le signal le plus fort déjà en place reste l'observation réseau réelle de
l'axe D (Chromium chargé face au protocole Grist réel) : c'est lui qui a
confirmé ce soir même les appels de `publipostage+` vers Google Fonts et
esm.sh. Les pistes ci-dessous cherchent ce qui reste hors de son champ, pas
à le remplacer. Chacune vérifiée dans le code du commit `6394556`/`4375b91`
(pas seulement supposée) sauf mention contraire.

1. **Interception réseau de l'axe D qui ne couvre pas les WebSocket**
   (le plus sérieux). `src/runtime/dynamique.js` neutralise tout via
   `contexte.route('**/*', ...)` (ligne 461) ; aucune trace de
   `routeWebSocket`/`page.on('websocket')` dans le fichier. Une connexion
   WebSocket directe vers un domaine externe échapperait donc à
   l'interception : le widget exfiltrerait réellement, pas seulement
   « tenterait », y compris pendant l'audit lui-même. À traiter en
   priorité si confirmé — c'est une brèche dans la neutralisation, pas un
   simple trou de couverture.
2. **Écriture ou lecture hors du périmètre déclaré.** `docApi.applyUserActions`
   et les appels de lecture (`fetchTable`, `getTable`...) sont déjà détectés
   statiquement (`c-securite.js:62-64`), et `D-GRIST-01` vérifie que la
   négociation d'accès a bien eu lieu — mais rien ne compare aujourd'hui
   les tables/colonnes réellement touchées à l'exécution à ce que le widget
   annonce faire. Un widget à accès `full` qui lit ou écrit dans une table
   sans rapport avec sa fonction déclarée ne serait pas détecté. C'est
   exactement le risque que le modèle de menace de la méthodologie
   identifie déjà comme dominant (le widget légitime qui abuse de son
   propre accès) — cette piste le rend mesurable plutôt que seulement
   nommé.
3. **Contournement de l'audit par empreinte d'environnement.** Un widget
   qui se comporterait différemment sous Chromium automatisé (`navigator.webdriver`,
   dimensions de fenêtre, données du scénario par défaut reconnaissables)
   resterait sage pendant l'audit et actif une fois installé. Rien ne le
   détecte aujourd'hui. Deux leviers : une règle statique qui signale les
   vérifications sur `navigator.webdriver`/empreinte navigateur comme
   suspectes ; et faire réellement varier `--scenario` d'un audit à
   l'autre plutôt que de garder des données de test fixes et donc
   reconnaissables.
4. **Persistance au-delà du retrait du widget.** Aucune règle ne vise
   `serviceWorker.register` ni `caches.open` (zéro occurrence dans
   `src/` — vérifié). Plus grave qu'un `localStorage` déjà couvert par
   `C-STOCK-01` : un Service Worker enregistré peut continuer de
   s'exécuter et d'intercepter des requêtes après que le widget a été
   retiré du document, jusqu'à désinscription explicite.
5. **`postMessage` émis avec `targetOrigin: '*'`.** `C-PM-01` vérifie
   l'écoute (`addEventListener('message', ...)` sans contrôle d'origine)
   mais rien ne vérifie l'émission (zéro occurrence de `postMessage(`
   dans `c-securite.js` — vérifié) : un widget qui émet avec `'*'`
   plutôt qu'une origine précise peut faire fuiter son message vers
   n'importe quel cadre qui parvient à s'interposer dans la page parente.
6. **Chargement différé, hors de la fenêtre d'observation.** La
   méthodologie l'assume déjà : l'axe D couvre le chargement initial et
   une notification de changement, pas un comportement retardé
   (`setTimeout` long, `import()` dynamique déclenché par une interaction
   tardive). Piste distincte des règles CDN existantes (qui portent sur
   les balises `<script>`, pas sur `import()` en cours d'exécution) :
   signaler un `import()` dont la source distante n'apparaît dans aucune
   balise déclarée au chargement.
7. **Accès au presse-papiers.** `navigator.clipboard.read()`/`readText()`
   donnerait à un widget accès à un contenu sans rapport avec le document
   Grist (mot de passe copié ailleurs, par exemple) — risque au niveau de
   l'appareil, pas seulement du document. Aucune règle ne le vise
   aujourd'hui.

Deux points de renfort, pas des règles nouvelles :
- Le référentiel recommande déjà vendoring + `integrity` pour toute
  dépendance CDN (E-DEP-01/02) — un RSSI ajouterait la raison précise :
  un service distant peut servir un contenu différent selon l'IP/le
  user-agent de la requête (bienveillant pour un scanner connu, actif en
  production), ce que seul le vendoring + `integrity` ferme complètement.
- **Divergence entre le commit audité et le code réellement servi** :
  le rapport lie déjà le verdict à `meta.commit`, mais si l'hébergement
  installe le widget depuis une branche suivie plutôt que ce commit
  précis, rien ne garantit que le code exécuté chez l'agent reste celui
  audité. C'est un point de processus d'hébergement, pas une règle de
  l'outil — à porter dans cette discussion-là plutôt qu'ici.

Filtré à dessein : une bonne part de ce qu'un RSSI généraliste demanderait
(authentification forte, cloisonnement réseau, gestion des secrets côté
serveur...) ne s'applique pas à un widget navigateur de quelques fichiers
sans backend propre, et n'est pas listée.

## 9. Regard RSSI sur la soumission anonyme (V2) — étude, pas implémentation

Antoine a confirmé le 2026-09-28 une soumission anonyme (pas de compte) sur
la V2 : n'importe qui peut donc fournir l'URL du dépôt à cloner sur
l'infrastructure d'Antoine, sous son nom. J'ai cherché un chemin où le
proxy CONNECT décrit en §4 ne tient pas — deux hypothèses posées puis
vérifiées contre le code réellement poussé entre-temps
(`docker/egress-proxy/squid.conf`, `docker/execution/`,
`docker-compose.v2-execution.yml`, commit `8052c8b`), donc daté et
vérifié, pas seulement supposé sur la base du document de conception.
Fichiers lus, pas modifiés — `docker/` et `docs/ARCHITECTURE-V2.md`
restent hors de mon périmètre.

**Les deux hypothèses ne tiennent pas contre ce qui a été écrit** — à
confirmer une fois construit pour de vrai sur le VPS, mais rien dans la
lecture du code ne les soutient :

1. *Un domaine possédé par l'attaquant (`github.com.attaquant.example`,
   `evilgithub.com`) passerait-il le filtre par nom d'hôte ?* Non : la
   liste blanche (`squid.conf`) utilise `acl domaines_autorises dstdomain
   .github.com .gitlab.com registry.npmjs.org` — la syntaxe Squid à point
   initial (`.github.com`) est un filtre par suffixe ancré sur les
   frontières de labels, pas une recherche de sous-chaîne : elle exige que
   le nom se termine exactement par `.github.com`, ce qu'aucun des deux
   noms ci-dessus ne fait. `registry.npmjs.org` sans point initial exclut
   même ses propres sous-domaines, volontairement.
2. *`git@hôte:chemin` (SSH), qui ne respecte pas `HTTP_PROXY`,
   contournerait-il le proxy CONNECT ?* Sans objet, pour une raison plus
   solide qu'une simple absence de mention : `execution-audit` n'a
   qu'un seul réseau, `reseau-ferme`, déclaré `internal: true` — aucune
   route par défaut vers l'extérieur. Seul `egress-proxy` a une seconde
   patte sur `reseau-sortie-controlee`. Le conteneur d'exécution ne peut
   donc atteindre *aucun* hôte externe par *aucun* protocole, SSH compris,
   qu'il passe ou non par une variable d'environnement — l'isolation est
   réseau, pas seulement applicative, ce qui ferme la question au niveau
   où elle doit l'être plutôt qu'au niveau de chaque client (git, npm, un
   futur outil qui ignorerait lui aussi `HTTP_PROXY`).

**Point fonctionnel signalé ci-dessus : corrigé.** `HTTP_PROXY`/`HTTPS_PROXY`
manquaient bien dans l'environnement d'`execution-audit` — ajoutées depuis
(commit `3b48de4`), avec le cas SSH (`git@hôte:chemin`, qui ignore ces deux
variables) explicitement documenté à côté : pas un trou, parce que
`reseau-ferme` n'a de route que vers `egress-proxy`, qui ne relaie pas SSH
— mais une affirmation qui reste, comme le reste de cette pile, écrite et
non éprouvée. Une checklist de vérification dédiée est apparue au même
commit (`docker/README-V2-VERIFICATIONS.md`) : voir §10.

**Correction sur la conclusion ci-dessus (§9, point 2).** Je l'ai écrite
comme si l'isolation réseau fermait la question — c'est ce que le fichier
*demande*, pas ce qui a été *observé* : personne n'a jamais construit ni
démarré cette pile (Docker Hub inatteignable depuis cet environnement de
développement). Le raisonnement lu dans `docker-compose.v2-execution.yml`
tient, mais reste à confirmer à la première exécution réelle sur le VPS,
comme le fichier le dit lui-même dans ses propres commentaires.

## 10. Ce qui, dans la pile V2, n'est aujourd'hui vrai que par écrit

Demandé après la correction ci-dessus : lister ce qui repose sur une
directive déclarative jamais éprouvée, et dire pour chacune comment on le
saurait au premier démarrage réel. Étude de ce qui est déjà écrit dans
`docker/` et `docs/ARCHITECTURE-V2.md` — rien modifié.

**Un point qui n'a pas besoin d'être exécuté pour être tranché**, parce
que ce n'est pas une question de comportement Docker mais de sémantique
de système de fichiers : `bin/gwaudit.js:231` crée le clone temporaire
d'une cible distante avec `fs.mkdtempSync(path.join(RACINE_OUTIL,
'.tmp-clone-'))`, où `RACINE_OUTIL` vaut `/app` dans l'image V2
(`docker/execution/Dockerfile`, `WORKDIR /app`). Or
`docker-compose.v2-execution.yml` déclare `read_only: true` avec pour
seul espace inscriptible `/tmp` (tmpfs). Une soumission anonyme est
toujours une URL (jamais un chemin local) : chaque job passerait donc par
cette ligne, qui écrirait dans un système de fichiers en lecture seule —
`EROFS` garanti par le noyau, pas une hypothèse à vérifier sur le VPS.
Pour comparaison, le reste du code a déjà appris cette leçon : le dossier
isolé de `npm audit` (`e-dependances.js:233`) et celui de l'axe D
(`dynamique.js:441`) utilisent tous les deux `os.tmpdir()`, pas
`RACINE_OUTIL` — seul le clone d'URL dans `bin/gwaudit.js` ne l'a pas
encore. `--sortie /out` (`entrypoint.sh`) évite le même problème pour le
rapport en pointant vers un volume monté, en dehors du système de
fichiers en lecture seule du conteneur. **Ce défaut est signalé, pris en
charge ailleurs (portabilité du code — écrire à côté de son répertoire
d'installation serait tout aussi mauvais sous Windows) : rien à ajouter
ici, je referme ce point.**

**Une checklist dédiée est apparue depuis** (`docker/README-V2-VERIFICATIONS.md`,
commit `3b48de4`) : elle couvre déjà, pour cinq points, exactement le
critère qui rend une checklist utile — pas seulement quoi vérifier, mais
comment reconnaître un échec qui ne crierait pas assez fort pour être cru
cassé (le piège déjà payé sur l'axe D). Je ne les reproduis pas ici pour
ne pas créer deux versions qui divergent :

- filtre Squid (`dstdomain`/`dst`) contre une cible autorisée et une cible
  piège (§1 de la checklist) ;
- `reseau-ferme: internal: true` : une sortie directe doit échouer par
  absence de route, pas par simple refus HTTP (§2) ;
- `git clone`/`npm audit` passent réellement par `egress-proxy`, dans un
  sens comme dans l'autre — hôte autorisé qui doit réussir, hors liste qui
  doit échouer (§3) ;
- SSH (`git@hôte:chemin`) doit échouer par absence de route, pas par
  absence de clé — la checklist insiste sur cette distinction précise,
  parce qu'un échec de credentials ne prouve rien sur l'isolation (§4) ;
- `mem_limit: 768m` doit se traduire par un conteneur tué (`OOMKilled`
  visible), pas par un Chromium qui dégrade en silence ou tourne
  indéfiniment (§5).

Deux points de mon tableau initial n'y figurent pas encore — je les garde
ici avec le même critère :

| Ce qui est écrit | Comment un échec silencieux se distinguerait d'un échec franc |
|---|---|
| `pids_limit: 128`, censé suffire à un widget légitime et contraindre un widget hostile | Chromium est lui-même multi-processus (rendu, GPU, réseau) : un dépassement peut faire échouer la création d'un seul processus de rendu sans tuer le conteneur — l'axe D se terminerait alors avec un résultat partiel plutôt qu'une erreur explicite. À vérifier : que le widget-fixture (légitime) ne s'approche pas de la limite, et que le dépassement délibéré produise soit un `OOMKilled`/`pids` explicite, soit un `D-INDISPONIBLE` franc — jamais un rapport qui a l'air complet et ne l'est pas |
| Résolution de `GWAUDIT_CHROMIUM_PATH` (`ls -d /ms-playwright/chromium-*/chrome-linux/chrome \| head -n1` dans `entrypoint.sh`) | Lisible sans exécuter : le script n'échoue que si **aucune** correspondance n'est trouvée (`-z`) — s'il y en avait deux (l'image de base embarque un jour un second binde `chromium-*`), `head -n1` en choisirait une arbitrairement, sans erreur ni journal. Ce n'est pas un cas connu aujourd'hui, mais le garde-fou du script est asymétrique : à surveiller au premier build (journaliser le chemin résolu, confirmer une correspondance unique) plutôt qu'à supposer réglé parce que ça démarre |
