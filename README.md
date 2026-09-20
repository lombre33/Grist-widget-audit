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

```bash
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

L'outil tourne sous Windows (10/11), avec une différence : la protection
qui plafonne le temps CPU que peut consommer Chromium pendant l'axe D
repose sous Linux/macOS sur `ulimit`, absent de Windows — elle y est donc
réimplémentée avec l'équivalent natif (Job Objects Win32, via un script
PowerShell généré à la volée ; PowerShell 5.1, présent par défaut sur
Windows 10/11, suffit). Ce mécanisme n'a pas pu être testé sur une machine
Windows réelle avant publication : si le message `⚠ Plafond CPU inactif
pour ce lancement de Chromium (Windows)` apparaît dans la sortie, cette
protection précise n'a pas pu s'activer pour cette exécution (l'audit
continue normalement, sans ce filet) — un signalement (issue) est
bienvenu dans ce cas.

### Installation globale (commande `gwaudit` disponible partout)

Depuis une copie clonée du dépôt :

```bash
npm install
npm link                                      # crée le lien symbolique global
gwaudit /chemin/vers/mon-widget               # utilisable depuis n'importe quel dossier
```

`npm link` s'appuie sur le champ `bin` de `package.json` (déjà présent) :
aucune configuration supplémentaire n'est nécessaire. Pour retirer le lien :
`npm unlink -g grist-widget-audit`.

## Utilisation

```bash
node bin/gwaudit.js /chemin/vers/mon-widget
node bin/gwaudit.js https://github.com/quelquun/grist-widget-exemple
```

(ou `gwaudit /chemin/vers/mon-widget` après `npm link`, voir ci-dessus.)

Le rapport est écrit dans `./rapport-<nom-du-widget>/rapport.md`.

Options :
- `--sans-dynamique` : n'exécute que l'analyse statique (pas de navigateur).
- `--sans-reseau` : ne consulte pas `npm audit` (fonctionne hors-ligne).
- `--sortie <dossier>` : change le dossier de sortie.
- `--json` : écrit aussi `rapport.json`, pour intégration outillée.
- `--sarif` : écrit aussi `rapport.sarif` (SARIF 2.1.0), pour l'ingestion CI
  — par exemple `github/codeql-action/upload-sarif` en GitHub Actions, qui
  affiche alors les constats dans l'onglet Security du dépôt.
- `--version` : affiche la version de l'outil et quitte.

Le code de sortie reflète le verdict : `0` conforme, `1` conforme sous
réserve, `2` non conforme (point bloquant), `3` erreur d'exécution de
l'outil lui-même.

## Comparer deux audits

Pour suivre l'effet d'un correctif, ou faire échouer une étape CI en cas de
régression, comparer deux rapports `--json` déjà générés (pas besoin de
relancer l'analyse) :

```bash
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

```bash
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

## Environnement de test Grist réel

`gwaudit --dynamique` (activé par défaut) simule un hôte Grist minimal, pas
une vraie instance : voir la méthodologie pour pourquoi ce choix. Pour
valider un widget dans un vrai Grist avant publication, voir
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

`npm audit` (axe E), en revanche, a réellement besoin d'atteindre
`registry.npmjs.org` : il conserve les variables `HTTP(S)_PROXY`/`NO_PROXY`
de l'environnement pour fonctionner derrière un proxy d'entreprise, tout en
ignorant le `.npmrc` et le reste de l'environnement du dépôt audité (voir
`src/regles/e-dependances.js`, qui l'exécute dans un dossier isolé pour
cette raison). Sans accès réseau du tout, utiliser `--sans-reseau` : l'axe E
le dit explicitement dans le rapport plutôt que de laisser croire à une
absence de vulnérabilité.

## Structure du dépôt

```
bin/gwaudit.js              point d'entrée CLI
src/contexte/               inventaire du dépôt, calcul de la surface exécutée
src/moteur/                 modèle de données, notation, analyse JS (AST)
src/regles/                 les règles des axes A, B, C, E, F (analyse statique)
src/runtime/                axe D : hôte Grist de test, serveur local, orchestration Playwright
src/rapport/                génération Markdown / JSON
ressources/grist-plugin-api/ client Grist vendu (voir docs/METHODOLOGIE.md § axe D)
docker/                     instance Grist réelle pour validation manuelle
docs/                       méthodologie, guide de contribution Grist.Gouv (source)
```

## V2 (esquisse, hors périmètre de cette V1)

Le besoin exprimé va au-delà d'un outil en ligne de commande : intégrer le
module sur un site, pour que des agents puissent faire vérifier
l'intégrité d'un widget avant de l'installer sur leur propre Grist. Cela
suppose au minimum : mettre en sandbox l'exécution de code arbitraire côté
serveur (l'analyse dynamique lance aujourd'hui un vrai navigateur sur du
code non maîtrisé — acceptable pour un usage local, à isoler fortement en
service public), une file d'attente et des quotas, une conservation des
rapports, et une authentification. Cette V1 n'a pas été conçue pour cet
usage et ne doit pas être exposée telle quelle sur un service public.
