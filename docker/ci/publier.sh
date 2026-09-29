#!/usr/bin/env bash
# Publie sur ghcr.io les deux images que docker/ci/verifier.sh vient
# d'éprouver — celles-là mêmes, pas une reconstruction : le workflow n'appelle
# ce script qu'après le succès de toutes les vérifications, et seulement sur
# une étiquette v*.
#
# Usage : GITHUB_TOKEN=… GITHUB_ACTOR=… GITHUB_REPOSITORY_OWNER=… \
#         bash docker/ci/publier.sh <étiquette>
set -euo pipefail

ETIQUETTE="${1:?usage : publier.sh <étiquette v*>}"
[[ "$ETIQUETTE" =~ ^v[0-9][0-9A-Za-z._-]*$ ]] || { echo "étiquette refusée : $ETIQUETTE" >&2; exit 2; }
: "${GITHUB_TOKEN:?}" "${GITHUB_ACTOR:?}" "${GITHUB_REPOSITORY_OWNER:?}"

PROPRIETAIRE="${GITHUB_REPOSITORY_OWNER,,}"   # ghcr.io exige des minuscules
PROJET=gwaudit-v2

echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin

publier() {
  local local_nom="$1" distant="ghcr.io/$PROPRIETAIRE/$2"
  docker tag "$local_nom" "$distant:$ETIQUETTE"
  docker push "$distant:$ETIQUETTE"
  # « latest » ne suit que les versions finales : une étiquette v1.2.0-rc1 ne le déplace pas.
  if [[ "$ETIQUETTE" != *-* ]]; then
    docker tag "$local_nom" "$distant:latest"
    docker push "$distant:latest"
  fi
  echo "publié : $distant:$ETIQUETTE ($(docker image inspect --format '{{index .RepoDigests 0}}' "$distant:$ETIQUETTE" 2>/dev/null || echo 'digest indisponible'))"
}

publier "$PROJET-execution-audit" gwaudit-execution
publier "$PROJET-egress-proxy" gwaudit-egress-proxy

docker logout ghcr.io
