# gwaudit — audit automatisé de widgets Grist

Outil en ligne de commande qui analyse un widget personnalisé Grist et
produit un rapport d'audit couvrant six axes : qualité du code, lisibilité
humaine, sécurité applicative, sécurité en condition réelle, chaîne de
dépendances, et conformité Grist.Gouv / souveraineté / accessibilité.

Conçu pour un niveau d'exigence proche d'un audit DINUM avant hébergement
sur une instance officielle (grist.numerique.gouv.fr), et pour être lancé
en quelques secondes sur un widget en cours de développement.

## Installation

Prérequis : [Node.js](https://nodejs.org/) 20 ou plus récent, et `git`
disponible dans le `PATH` (utilisé pour auditer une URL de dépôt et pour
lier chaque rapport au commit audité).

```powershell
npm install                                   # dépendances de l'outil
npx playwright install chromium               # nécessaire pour l'axe D (analyse dynamique)
```

`npm install` ne télécharge lui-même aucun navigateur (Playwright n'a plus
de script d'installation automatique) : la seconde commande est donc bien
nécessaire, et télécharge environ 150 à 300 Mio depuis les serveurs de
Playwright — prévoir un accès réseau à ce moment précis, y compris derrière
un proxy d'entreprise (voir plus bas ce qui, une fois ce téléchargement
fait, ne dépend plus du réseau). Si cette étape est ignorée ou échoue,
`gwaudit` ne plante pas : l'axe D est signalé comme non exécuté dans le
rapport (constat `D-INDISPONIBLE`), les cinq autres axes s'exécutent
normalement. Utiliser `--sans-dynamique` pour l'ignorer volontairement.

### Windows

L'outil est conçu, utilisé et éprouvé (CI `windows-latest`) sous Windows 11 ;
les commandes de ce document sont écrites pour PowerShell. Le code reste
portable, mais Linux et macOS ne sont plus suivis : rien n'y est garanti.

La protection qui plafonne le temps CPU que peut consommer Chromium pendant
l'axe D repose sous Linux/macOS sur `ulimit`, absent de Windows — elle y est
donc réimplémentée avec l'équivalent natif (Job Objects Win32, via un script
PowerShell généré à la volée ; PowerShell 5.1, présent par défaut sur
Windows 10/11, suffit). Confirmé sur une machine Windows 11 réelle : le
mécanisme s'installe sans erreur (pas de message `⚠ Plafond CPU inactif
pour ce lancement de Chromium (Windows)` dans la sortie). Si ce message
apparaît malgré tout, cette protection précise n'a pas pu s'activer pour
cette exécution (l'audit continue normalement, sans ce filet) — un
signalement (issue) est bienvenu dans ce cas.

**Limite connue, sur les deux plateformes** : ce plafond CPU est une
protection de dernier recours qui, dans le déroulement normal de l'axe D,
n'a structurellement pas l'occasion de s'exercer. Un widget qui bloque le
thread principal dès le chargement fait expirer le timeout propre de
Playwright (30s) avant que le plafond CPU (réglé à ce timeout + 30s) n'ait
le temps d'intervenir ; un widget qui charge normalement puis sature le
CPU en arrière-plan (Web Workers) ne retarde pas les étapes du scénario
qui gouvernent la durée de l'axe D, qui se termine donc normalement bien
avant ce plafond, sans laisser de processus derrière lui. Mesuré dans les
deux cas : le plafond CPU n'a jamais été le mécanisme qui met fin à
l'exécution. Il reste un filet de sécurité en profondeur, pas la
protection qui agit en pratique.

### Chromium déjà présent, mais sous une autre révision (`GWAUDIT_CHROMIUM_PATH`)

Playwright attend une révision précise de Chromium (celle que
`npx playwright install chromium` installe). Si un Chromium est déjà
présent ailleurs sur la machine — cas de certains environnements de
développement cloud, où un Chromium est pré-installé pour d'autres usages
sous une révision différente — `gwaudit` ne le trouve pas automatiquement
et l'axe D échoue (message `Executable doesn't exist at ...`, ou le
message plus vague `Target page, context or browser has been closed` si
l'échec survient après le lancement plutôt qu'avant). Pointer explicitement
dessus avec la variable d'environnement `GWAUDIT_CHROMIUM_PATH` :

```powershell
$env:GWAUDIT_CHROMIUM_PATH = "C:\chemin\vers\chrome.exe"
node bin/gwaudit.js C:\chemin\vers\mon-widget
```

### Le bac à sable de Chromium (`GWAUDIT_CHROMIUM_SANS_SANDBOX`)

L'axe D exécute le widget audité, du code non fiable, dans Chromium. Le bac à
sable natif de Chromium est **actif par défaut** : Playwright, lui, lance
Chromium avec `--no-sandbox` tant qu'on ne lui demande pas l'inverse, et
`gwaudit` le lui demande (`chromiumSandbox: true`).

Quand Chromium ne peut pas démarrer avec son bac à sable, l'axe D est signalé
non exécuté avec cette cause précise (`D-INDISPONIBLE`), jamais
silencieusement. Deux issues : corriger l'environnement, ou déroger
**explicitement** :

```powershell
$env:GWAUDIT_CHROMIUM_SANS_SANDBOX = "1"
node bin/gwaudit.js C:\chemin\vers\mon-widget
```

C'est alors le widget audité qui s'exécute dans un Chromium sans bac à sable, sur
votre machine : une faille du moteur de rendu que ce code exploiterait lui
donnerait vos droits. À ne faire que sur un widget dont la source est connue. Le
rapport le dit (`D-INDISPONIBLE-BAC-A-SABLE`, information, sans effet sur le
verdict). `GWAUDIT_CHROMIUM_SANDBOX=1`, l'ancien nom de la demande, est encore
accepté et ne change rien.

Un widget qui garde le navigateur occupé (boucle sans fin au chargement) n'est
pas une panne de l'axe D : `D-TIMEOUT-01`, bloquant, le dit — bloquer la mesure
ne rapporte pas une meilleure note que la laisser tourner. Le délai global du
scénario est de 45 s (`GWAUDIT_DELAI_AXE_D_MS` pour l'allonger) ; celui du
chargement de la page en est déduit, 15 s de moins.

### Installation globale (commande `gwaudit` disponible partout)

Depuis une copie clonée du dépôt :

```powershell
npm install
npm link                                      # crée le lien symbolique global
gwaudit /chemin/vers/mon-widget               # utilisable depuis n'importe quel dossier
```

`npm link` s'appuie sur le champ `bin` de `package.json` (déjà présent) :
aucune configuration supplémentaire n'est nécessaire. Pour retirer le lien :
`npm unlink -g grist-widget-audit`.

## Utilisation

```powershell
node bin/gwaudit.js /chemin/vers/mon-widget
node bin/gwaudit.js https://github.com/quelquun/grist-widget-exemple
```

(ou `gwaudit /chemin/vers/mon-widget` après `npm link`, voir ci-dessus.)

Le rapport est écrit dans `./rapport-<nom-du-widget>/rapport.md`.

Options :
- `--sans-dynamique` : n'exécute que l'analyse statique (pas de navigateur).
- `--grist-reel` : joue en plus le widget contre un vrai Grist (Grist Desktop, installé et lancé tout seul dans un profil jetable), voir [Essais contre un Grist réel](#essais-contre-un-grist-réel).
- `--sans-reseau` : n'interroge pas le registre npm, ni pour `npm audit` ni pour les dates de publication du bilan des dépendances (fonctionne hors-ligne). Pour un dépôt qui verrouille ses dépendances, le rapport dit alors l'axe E mesuré en partie (E-VULN-OPTION) et le verdict ne peut pas être « CONFORME » ; le bilan (E-DEP-07) écrit la régularité de publication « non mesurée ».
- `--sortie <dossier>` : change le dossier de sortie.
- `--json` : écrit aussi `rapport.json`, pour intégration outillée.
- `--sarif` : écrit aussi `rapport.sarif` (SARIF 2.1.0), pour l'ingestion CI
  — par exemple `github/codeql-action/upload-sarif` en GitHub Actions, qui
  affiche alors les constats dans l'onglet Security du dépôt.
- `--version` : affiche la version de l'outil et quitte.

Le code de sortie reflète le verdict : `0` conforme, `1` conforme sous
réserve, `2` non conforme (point bloquant), `3` erreur d'exécution de
l'outil lui-même, `4` cible refusée ou inaccessible (URL refusée par la
validation, clonage impossible, chemin introuvable) : un refus est dit en clair, sans pile, et ce n'est pas une panne.

## Comparer deux audits

Pour suivre l'effet d'un correctif, ou faire échouer une étape CI en cas de
régression, comparer deux rapports `--json` déjà générés (pas besoin de
relancer l'analyse) :

```powershell
node bin/gwaudit.js /chemin/vers/mon-widget --json --sortie ./avant
# ... correctifs sur le widget ...
node bin/gwaudit.js /chemin/vers/mon-widget --json --sortie ./apres

node bin/gwaudit.js --diff ./avant/rapport.json ./apres/rapport.json
```

Affiche l'évolution du score global et par axe, et liste les constats
corrigés, nouveaux et persistants. `--sortie <fichier.md>` écrit la
comparaison dans un fichier au lieu de l'afficher. Le code de sortie est `2`
si des constats nouveaux sont apparus (utile pour gater une CI dessus),
sinon `0`.

## Personnaliser le scénario de l'axe D

Par défaut, l'axe D (analyse dynamique) charge le widget face à un document
de test fixe (table `Contacts`, quelques colonnes). `--scenario <fichier.json>`
remplace ces données par les vôtres — utile pour tester avec des noms de
colonnes que le widget attend réellement, plus de lignes, ou des valeurs
limites (nombres négatifs, cellules vides, texte très long) :

```json
{
  "tableId": "Commandes",
  "colonnes": {
    "id": [1, 2],
    "Client": ["Marie Curie", "Ada Lovelace"],
    "Montant": [42.5, 0],
    "Statut": ["payée", "en attente"]
  }
}
```

```powershell
node bin/gwaudit.js /chemin/vers/mon-widget --scenario ./mon-scenario.json
```

`colonnes` est obligatoire (un objet de tableaux de valeurs, une entrée par
colonne) ; `tableId` et `nom` sont optionnels. Un scénario invalide (JSON
mal formé, `colonnes` absent ou mal typé) est ignoré avec un avertissement
sur la sortie d'erreur, et l'audit continue avec le scénario par défaut —
il ne fait jamais échouer tout l'outil.

La sonde qui prouve qu'une valeur de cellule peut s'exécuter comme du code
(constat `D-XSS-01`) est toujours ajoutée, dans sa propre colonne, quel que
soit le scénario fourni : la personnaliser sert à tester avec des données
représentatives, pas à retirer cette vérification.

## Interface web locale

`--interface` lance une interface minimale au lieu d'un audit direct : un
formulaire (lien du dépôt à auditer), le suivi en direct de l'audit, puis
la page de rapport une fois terminé. La case « Ajouter les essais contre un
Grist réel » (décochée par défaut) ajoute `--grist-reel` à l'audit classique,
dans le même rapport : voir [Essais contre un Grist réel](#essais-contre-un-grist-réel).
Le premier audit coché télécharge Grist Desktop (environ 320 Mo) ; le délai
global de l'interface passe alors de 5 à 20 minutes.

```powershell
node bin/gwaudit.js --interface          # http://127.0.0.1:4317
node bin/gwaudit.js --interface --port 8080
```

Sous Windows, un double-clic sur `lancer-interface.cmd` (à la racine) fait la
même chose : il démarre l'interface et ouvre le navigateur par défaut. Il
garde aussi tout le travail sur le disque de l'outil : les rapports vont dans
ce dossier, les fichiers temporaires dans `.tmp-travail` et Grist Desktop
(téléchargé pour les essais contre un Grist réel) dans `.tmp-cache`, au lieu
des dossiers de `C:`.

Cette interface ne réimplémente rien : elle pilote `gwaudit` lui-même en
sous-processus et affiche ce qu'il imprime déjà (mêmes rapports, mêmes
codes de sortie).

Pensée pour un usage local, mono-utilisateur, sans authentification : elle
n'écoute que sur `127.0.0.1`, un audit à la fois, et seuls les liens de dépôt
(`https://` ou `git@`) sont acceptés — jamais un chemin local, pour qu'un
formulaire ne puisse jamais faire auditer (donc lire) un dossier arbitraire
de la machine qui l'héberge. Un usage hébergé et exposé publiquement
(plusieurs utilisateurs, code non fiable) demanderait une isolation que cet
outil ne fournit pas (voir [`docs/archive-v2-vps.md`](docs/archive-v2-vps.md)) :
ne jamais la lier à une interface réseau publique.

Lancée avec succès sous Windows 11 (parcours complet : démarrage,
formulaire, clonage, audit, page de rapport) — aucune invite de pare-feu au
démarrage, `127.0.0.1` ne semble donc pas en déclencher. Reste non vérifié
sur Windows : le rattrapage au bout de 5 minutes (`taskkill /T /F` pour
arrêter Chromium si l'audit traîne) n'a encore été exercé sur aucune
machine Windows réelle, cette exécution s'étant terminée normalement avant
le délai. Un signalement (issue) est bienvenu si ce cas se présente et se
comporte autrement.

## Ce que l'outil vérifie

Voir [`docs/METHODOLOGIE.md`](docs/METHODOLOGIE.md) pour le détail des six
axes, leur pondération, et — point important — leurs limites : ce que
l'outil peut prouver, ce qu'il ne fait que suspecter, et ce qu'il ne
regarde pas du tout.

En bref :

| Axe | Ce qui est mesuré | Comment |
|---|---|---|
| A — Qualité | taille, complexité, duplication, gestion d'erreur, tests | analyse statique (AST) |
| B — Lisibilité | README, nommage, densité de commentaires, signaux de code généré non relu | analyse statique |
| C — Sécurité | accès Grist demandé, fuite de données, injection DOM, secrets, CDN non maîtrisés | analyse statique (AST) |
| D — Sécurité réelle | trafic réseau réellement émis, XSS réellement exécuté, accessibilité mesurée | exécution dans Chromium face à un hôte Grist de test (protocole RPC réel) |
| E — Dépendances | intégrité des ressources distantes, `npm audit`, licence | statique + `npm audit` |
| F — Conformité | souveraineté des flux, RGAA (partiel), écoconception, conventions du guide | statique + résultats de l'axe D |

## Essais contre un Grist réel

`gwaudit <widget> --grist-reel` ajoute à l'audit des essais joués par un vrai Grist, au lieu du faux hôte de test de l'axe D. Rien à préparer : au premier lancement, l'outil télécharge Grist Desktop (version épinglée dans `src/runtime/grist-reel/grist-desktop.json`, environ 300 Mo, empreinte SHA-256 vérifiée), le range dans un dossier de cache (`%LOCALAPPDATA%\gwaudit\cache`, ou `GWAUDIT_CACHE`) et le réutilise ensuite. Il n'utilise jamais ton propre Grist Desktop, tes documents ni ton profil : chaque audit lance une instance neuve dans un dossier temporaire, y crée un document de test (valeurs « canaris », table appât, section Custom qui charge le widget), joue le widget, puis arrête l'instance et supprime le dossier.

Ce qui est joué (numéros du catalogue de l'étude) : le widget chargé au niveau d'accès « none » puis à celui qu'il demande ; 1 XSS par valeur de cellule, avec lecture d'une autre table par l'API Grist au niveau réellement accordé, puis sortie ; 7 aucune donnée transmise à « none » ; 8, 9 et 12 « dépendance piégée » (voir ci-dessous) ; 13 exfiltration mesurée (un canari du document retrouvé dans une requête sortante) ; 15 navigation de la page Grist ; 16 fenêtres, boîtes de dialogue, téléchargements. Les requêtes vers l'extérieur sont interceptées, jamais envoyées. Le rapport gagne une section « Essais contre un Grist réel » et des constats `D-REEL-NN`, notés comme les autres ; un essai qui n'a pas pu se jouer est dit « non testé » avec sa raison, jamais « rien trouvé ».

Bibliothèques du widget (esm.sh, CDN…) : le navigateur des essais reste coupé d'Internet, mais l'outil télécharge lui-même, avant les essais, les bibliothèques que le widget déclare (balise `<script src>`, import map, `import` à adresse littérale) et les imports en clair de ces modules chez le même hôte, puis les sert au widget pour qu'il s'affiche pour de vrai. Seul du JavaScript, en https, depuis un nom public (jamais une IP, un nom interne, un autre port), avec des plafonds de nombre, de taille et de durée ; chaque fichier est consigné avec son empreinte SHA-256 dans le rapport. Une adresse calculée à l'exécution n'est jamais téléchargée. Si une bibliothèque n'a pas pu l'être (hors ligne, proxy, refus), les essais qui n'ont « rien observé » passent à « Pas testé » avec la raison : leur résultat ne prouverait rien.

Dépendance piégée (essais 8, 9 et 12) : l'audit joue, depuis l'intérieur du cadre du widget chargé par le vrai Grist, ce que ferait du code étranger (une bibliothèque dont le mainteneur est piraté, un CDN compromis) avec le niveau d'accès réellement accordé : lire la liste des tables, une table sans rapport avec le widget et les tables système (8) ; obtenir un jeton d'accès et appeler directement l'API du document, y compris sur un autre document de l'instance (9) ; créer un webhook, une sortie permanente de données (12). Rien n'est détruit ni écrit dans les données. Le rapport dit « avec ce niveau, une dépendance piégée obtiendrait : … ». À « read table », Grist refuse tout (essais « Bloqué ») ; à « full », 8 et 9 sont des constats d'information (`D-REEL-08`, `D-REEL-09`) sans effet sur la note, le niveau demandé étant déjà pesé par C-GRIST-03. L'essai 12 vaut pour le réglage par défaut de Grist (aucune adresse de webhook autorisée) : l'instance jetable ignore la configuration de la machine ; s'il aboutissait, ce serait un constat majeur (`D-REEL-12`).

Bibliothèque modifiée à la source (essai 21, ajouté à la suite du catalogue) : si le CDN d'une bibliothèque, ou quelqu'un qui en a pris le contrôle, servait un fichier modifié à la même adresse, le widget l'exécuterait-il ? Quand le widget déclare des bibliothèques que l'outil a téléchargées, une troisième passe les sert à la même adresse avec une ligne de plus à la fin. Cette ligne ne fait que consigner un identifiant dans une variable globale : elle ne lit rien et n'envoie rien. Si le navigateur refuse le fichier (empreinte `integrity` qui ne correspond plus), l'essai est « Bloqué ». S'il l'exécute sans qu'aucune empreinte ne soit déclarée, c'est une information qui confirme E-DEP-01, sans pénalité de plus. S'il l'exécute alors que l'analyse du code croit le fichier protégé par une empreinte, c'est un constat critique (`D-REEL-21`) : l'empreinte ne joue pas son rôle dans ce navigateur. Ce que ferait un vrai code malveillant avec les droits du widget est mesuré à part (essais 8 et 9).

À savoir :
- Windows : une fenêtre de Grist Desktop peut apparaître quelques secondes pendant l'audit. Aucun droit d'administrateur, aucune installation système.
- Derrière un proxy d'entreprise, le téléchargement peut échouer : le message donne l'adresse du fichier et le dossier où le déposer à la main (il est vérifié comme un fichier téléchargé). `GWAUDIT_GRIST_DESKTOP=<exécutable>` impose un Grist Desktop déjà installé.
- Windows : garder le dossier de l'outil à un chemin court (moins de 50 caractères, par exemple `D:\Grist-widget-audit`) : Grist Desktop contient des chemins de 155 caractères, rangés dans `.tmp-cache` sous l'interface web.
- Le résultat vaut pour la version de Grist Desktop testée, pas pour l'instance où le widget sera installé si elle diffère.
- Test de bout en bout : `$env:GWAUDIT_GRIST_REEL_E2E = "1"; node --test tests/grist-reel.test.mjs`.

## Essai manuel dans un Grist réel (Docker, facultatif)

L'axe D par défaut simule un hôte Grist minimal, pas une vraie instance : voir
la méthodologie pour pourquoi ce choix. `--grist-reel` (ci-dessus) joue le
widget dans un vrai Grist, sans rien installer. Pour le voir fonctionner à la
main dans un vrai Grist avant publication, avec Docker Desktop, voir
[`docker/README.md`](docker/README.md).

## Réseau et proxy d'entreprise

L'axe D (navigateur) n'a besoin d'aucun accès réseau réel : le widget testé
et le hôte Grist de test sont tous les deux servis en local
(`127.0.0.1`), et tout le trafic sortant du widget est de toute façon
neutralisé (voir méthodologie). Chromium est donc lancé sans proxy
(`--proxy-server=direct://`) et sans les variables `*_PROXY` de
l'environnement, pour qu'aucun service interne du navigateur ne puisse
sortir non plus — cela **ne dépend d'aucune configuration réseau** :
l'axe D fonctionne à l'identique derrière un proxy d'entreprise ou sans
accès Internet du tout.

`npm audit` et le bilan des dépendances (axe E : avis publiés, dates de publication
des 25 premières dépendances directes de production, lues par `npm view`),
en revanche, ont réellement besoin d'atteindre
`registry.npmjs.org` : ils conservent les variables `HTTP(S)_PROXY`/`NO_PROXY`
de l'environnement pour fonctionner derrière un proxy d'entreprise, tout en
ignorant le `.npmrc` et le reste de l'environnement du dépôt audité (voir
`src/regles/npm-isole.js`, qui les exécute dans un dossier isolé pour
cette raison). Sans accès réseau du tout, utiliser `--sans-reseau` : l'axe E
le dit explicitement dans le rapport plutôt que de laisser croire à une
absence de vulnérabilité.

## Structure du dépôt

```
bin/gwaudit.js              point d'entrée CLI
src/contexte/               inventaire du dépôt, calcul de la surface exécutée
src/moteur/                 modèle de données, notation, analyse JS (AST)
src/regles/                 les règles des axes A, B, C, E, F (analyse statique)
src/runtime/                axe D : hôte Grist de test, serveur local, orchestration Playwright, essais contre un Grist réel
src/rapport/                génération Markdown / HTML / JSON / SARIF
ressources/grist-plugin-api/ client Grist vendu (voir docs/METHODOLOGIE.md § axe D)
tests/                      suite de tests (`npm test`)
scripts/                    outils de mise au point (mutants, mesures) et preuve du bac à sable sous Windows
docker/                     instance Grist réelle pour validation manuelle (facultatif)
docs/                       méthodologie, guide de contribution Grist.Gouv (source), archive du projet d'hébergement
```

## Hébergement sur un serveur (abandonné)

Un projet d'audit hébergé (soumission d'un lien par des inconnus, exécution dans
un conteneur durci sur un VPS) a été conçu et en partie éprouvé, puis mis de
côté : l'outil n'est utilisé qu'en local, sous Windows. Ce qui existait, et
comment le retrouver dans l'historique du dépôt, est dans
[`docs/archive-v2-vps.md`](docs/archive-v2-vps.md).

## Licence

GPL 3.0 (`LICENSE`), comme les autres dépôts de la suite Grist Factory. Les copies obtenues avant ce changement de licence restent sous MIT.
