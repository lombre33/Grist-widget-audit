#!/usr/bin/env bash
# Mesure ce qu'un audit réel coûte en mémoire DANS l'image d'exécution, sous le plafond de l'intégrateur : le pic du groupe de
# contrôle (celui qui se compare à `mem_limit`), celui de l'enfant de l'analyse et celui du parent, et si le noyau a refusé de la
# mémoire. Sert à dire, pour une cible honnête (`chart`, la racine de gristlabs/grist-widget), la marge que le tas de l'enfant
# (`mem_limit` moins 210 Mio) et le conteneur lui laissent. Une mesure n'est pas une preuve : elle varie d'une exécution à l'autre
# (le pic du groupe de contrôle a varié de 614 à 673 Mio sur cinq exécutions de `chart`, la mémoire de cache y étant comptée), on la répète.
#
# Usage : bash docker/ci/mesurer-pics.sh <dossier-de-la-cible> [--image nom:etiquette] [--memoire 768m] [--statique]
#   --image     l'image construite (défaut : gwaudit-exec:local ; `docker build -f docker/execution/Dockerfile -t gwaudit-exec:local .`)
#   --memoire   `--memory` et `--memory-swap` du conteneur (défaut 768m : celui de l'intégrateur)
#   --statique  sans l'axe D (le pic du parent est alors celui de l'audit statique seul, l'axe D et Chromium ne le gonflent pas)
# Sortie : une ligne de résumé, le détail dans le dossier de sortie annoncé (pics.json, rapport.json, sortie.txt, erreur.txt).
# Mêmes limites que docker/docker-compose.v2-execution.yml : sans réseau, lecture seule, /tmp en tmpfs, capacités retirées, profil seccomp
# de l'image ; le pic de chaque processus vient de `pics.cjs`, chargé avec `node -r`.
set -uo pipefail
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="gwaudit-exec:local"; MEMOIRE="768m"; STATIQUE=""; CIBLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) [ $# -ge 2 ] || { echo "--image demande un nom" >&2; exit 64; }; IMAGE="$2"; shift 2 ;;
    --memoire) [ $# -ge 2 ] || { echo "--memoire demande une valeur" >&2; exit 64; }; MEMOIRE="$2"; shift 2 ;;
    --statique) STATIQUE="--sans-dynamique"; shift ;;
    -*) echo "option inconnue : $1" >&2; exit 64 ;;
    *) [ -z "$CIBLE" ] || { echo "une seule cible" >&2; exit 64; }; CIBLE="$1"; shift ;;
  esac
done
[ -n "$CIBLE" ] && [ -d "$CIBLE" ] || { echo "usage : mesurer-pics.sh <dossier-de-la-cible> [--image …] [--memoire 768m] [--statique]" >&2; exit 64; }
CIBLE="$(cd "$CIBLE" && pwd)"
SORTIE="$(mktemp -d "${TMPDIR:-/tmp}/gwaudit-pics-XXXXXX")"; chmod 777 "$SORTIE"
DEBUT=$(date +%s)
docker run --rm --memory "$MEMOIRE" --memory-swap "$MEMOIRE" --pids-limit 512 --network none --read-only \
  --tmpfs /tmp:size=512m,mode=1777,exec --cap-drop ALL --cap-add SYS_CHROOT --security-opt no-new-privileges:true \
  --security-opt "seccomp=$RACINE/docker/execution/seccomp-chromium.json" -e HOME=/tmp \
  -v "$CIBLE":/cible:ro -v "$SORTIE":/out -v "$RACINE/docker/ci/pics.cjs":/pics.cjs:ro --entrypoint sh "$IMAGE" \
  -c "GWAUDIT_CHROMIUM_PATH=\$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome | head -n1) exec node -r /pics.cjs bin/gwaudit.js /cible $STATIQUE --json --sortie /out" \
  > "$SORTIE/sortie.txt" 2> "$SORTIE/erreur.txt"
CODE=$?
node "$RACINE/docker/ci/resumer-pics.cjs" "$SORTIE" "$CODE" "$(( $(date +%s) - DEBUT ))" "$MEMOIRE"
