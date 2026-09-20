# gwaudit — audit automatisé de widgets Grist

Outil en ligne de commande qui analyse un widget personnalisé Grist et
produit un rapport d'audit couvrant six axes : qualité du code, lisibilité
humaine, sécurité applicative, sécurité en condition réelle, chaîne de
dépendances, et conformité Grist.Gouv / souveraineté / accessibilité.

Conçu pour un niveau d'exigence proche d'un audit DINUM avant hébergement
sur une instance officielle (grist.numerique.gouv.fr), et pour être lancé
en quelques secondes sur un widget en cours de développement.

## Installation

```bash
npm install                                   # dépendances de l'outil
npx playwright install chromium               # nécessaire pour l'axe D (analyse dynamique)
```

## Utilisation

```bash
node bin/gwaudit.js /chemin/vers/mon-widget
node bin/gwaudit.js https://github.com/quelquun/grist-widget-exemple
```

Le rapport est écrit dans `./rapport-<nom-du-widget>/rapport.md`.

Options :
- `--sans-dynamique` : n'exécute que l'analyse statique (pas de navigateur).
- `--sans-reseau` : ne consulte pas `npm audit` (fonctionne hors-ligne).
- `--sortie <dossier>` : change le dossier de sortie.
- `--json` : écrit aussi `rapport.json`, pour intégration outillée.

Le code de sortie reflète le verdict : `0` conforme, `1` conforme sous
réserve, `2` non conforme (point bloquant), `3` erreur d'exécution de
l'outil lui-même.

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
