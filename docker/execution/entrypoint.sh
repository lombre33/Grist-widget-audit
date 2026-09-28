#!/bin/sh
set -eu

# Un conteneur = un seul job (docs/ARCHITECTURE-V2.md §2, §3) : ce script
# audite UNE cible puis se termine. Il ne consomme pas de file d'attente
# lui-même — ça reste à écrire côté zone "site" (§5), pas dans cette
# image. Le contrat volontairement minimal : un argument (l'URL soumise),
# un dossier /out monté par l'appelant pour récupérer le rapport JSON +
# Markdown, un code de sortie standard.

# Le nom exact du dossier chromium-<révision> dépend de la version
# embarquée par l'image de base Playwright — résolu ici plutôt qu'en dur
# dans le Dockerfile, pour ne pas avoir à le retoucher à chaque mise à
# jour de cette image de base.
GWAUDIT_CHROMIUM_PATH="$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -n1)"
if [ -z "$GWAUDIT_CHROMIUM_PATH" ]; then
  echo "entrypoint: GWAUDIT_CHROMIUM_PATH introuvable sous /ms-playwright — l'image de base a-t-elle changé de mise en page ?" >&2
  exit 1
fi
export GWAUDIT_CHROMIUM_PATH

CIBLE="${1:?usage: entrypoint.sh <url-du-widget-a-auditer>}"

mkdir -p /out
exec node bin/gwaudit.js "$CIBLE" --json --sortie /out
