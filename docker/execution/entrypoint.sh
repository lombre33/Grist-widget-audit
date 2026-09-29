#!/bin/sh
set -eu

# Un conteneur = un seul job (docs/ARCHITECTURE-V2.md §2, §3) : ce script
# audite UNE cible puis se termine. Il ne consomme pas de file d'attente
# lui-même — ça reste à écrire côté zone "site" (§5), pas dans cette
# image. Le contrat volontairement minimal : un argument (l'URL soumise),
# un dossier /out monté par l'appelant pour récupérer le rapport JSON +
# Markdown, un code de sortie standard.

# Le nom exact du dossier chromium-<révision>/chrome-linux64 dépend de la
# version embarquée par l'image de base Playwright — résolu ici plutôt
# qu'en dur dans le Dockerfile, pour ne pas avoir à le retoucher à chaque
# mise à jour de cette image de base. Le sous-dossier est chrome-linux64
# dans v1.63.0-jammy (constaté à la première vraie exécution, la version
# précédente cherchait chrome-linux et ne trouvait rien) ; le motif
# chrome-linux* couvre aussi l'ancienne disposition.
GWAUDIT_CHROMIUM_PATH="$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -n1)"
if [ -z "$GWAUDIT_CHROMIUM_PATH" ]; then
  echo "entrypoint: GWAUDIT_CHROMIUM_PATH introuvable sous /ms-playwright — l'image de base a-t-elle changé de mise en page ?" >&2
  exit 1
fi
export GWAUDIT_CHROMIUM_PATH

CIBLE="${1:?usage: entrypoint.sh <url-du-widget-a-auditer>}"

mkdir -p /out

# Plafond de durée au niveau du conteneur (défense en profondeur), ajouté
# le 2026-09-28 après qu'une revue a trouvé une expression régulière à
# retour arrière catastrophique dans une règle de l'axe F (F-RGAA-05,
# src/regles/f-conformite.js) qui a bloqué un audit reproductible sur un
# widget officiel Grist. La règle elle-même se reprend ailleurs (hors
# périmètre de ce fil, pas touchée ici ; correctif vérifié par exécution :
# 8643599, le premier, d4a2e39, prenait encore 302 s sur une page piégée)
# — mais la classe de bug reste :
# analyseStatique() (src/moteur/statique.js) exécute les axes A/B/C/F en
# JavaScript synchrone dans CE process, sans aucune limite propre, et un
# thread bloqué par du retour arrière ne peut structurellement pas
# exécuter le moindre setTimeout côté outil pour s'auto-interrompre. Seul
# un mécanisme externe au process peut couper un blocage de cette nature
# — vérifié ici avec une vraie boucle Node synchrone et sans gestionnaire
# de signal : `timeout` la termine par un simple SIGTERM, sans même avoir
# besoin du repli -k (voir docker/README-V2-VERIFICATIONS.md point 6).
#
# 480 s = marge au-dessus de la somme des plafonds déjà internes à l'outil
# (clone git 120 s, npm audit 120 s, scénario axe D ~90 s) : large pour ne
# jamais couper un audit légitime, borné pour ne jamais bloquer
# indéfiniment la file qui sérialise les jobs en V2 (constat 11, §5).
# -k 10 : repli SIGKILL 10 s après le SIGTERM initial, au cas où un futur
# changement du process ajouterait un gestionnaire de signal qui l'ignore
# ou n'a pas l'occasion de s'exécuter. Le code de sortie 124 (timeout) ou
# 137 (tué par SIGKILL) signale sans ambiguïté un job coupé par ce
# plafond, à distinguer d'un échec normal de gwaudit — utile à
# l'intégrateur qui appellera ce conteneur (§5, hors de ce dépôt).
#
# GWAUDIT_PLAFOND_S existe pour que la vérification automatisée
# (docker/ci/verifier.sh) coupe en quelques secondes au lieu de huit
# minutes ; en production, ne pas la poser : 480 est la valeur voulue.
exec timeout -k 10 "${GWAUDIT_PLAFOND_S:-480}" node bin/gwaudit.js "$CIBLE" --json --sortie /out
