#!/usr/bin/env bash
# Publie sur ghcr.io les deux images que docker/ci/verifier.sh vient
# d'éprouver — celles-là mêmes, pas une reconstruction : le workflow n'appelle
# ce script qu'après le succès de toutes les vérifications, et seulement sur
# une étiquette v*.
#
# Usage : GITHUB_TOKEN=… GITHUB_ACTOR=… GITHUB_REPOSITORY_OWNER=… \
#         bash docker/ci/publier.sh <étiquette>
#
# GWAUDIT_REGISTRE (défaut ghcr.io) et GWAUDIT_SANS_CONNEXION=1 n'existent que
# pour la publication à blanc de verifier.sh (registre local, sans identifiants).
set -euo pipefail

ETIQUETTE="${1:?usage : publier.sh <étiquette v*>}"
[[ "$ETIQUETTE" =~ ^v[0-9][0-9A-Za-z._-]*$ ]] || { echo "étiquette refusée : $ETIQUETTE" >&2; exit 2; }
: "${GITHUB_REPOSITORY_OWNER:?}"

REGISTRE="${GWAUDIT_REGISTRE:-ghcr.io}"
PROPRIETAIRE="${GITHUB_REPOSITORY_OWNER,,}"   # ghcr.io exige des minuscules
PROJET=gwaudit-v2

if [ "${GWAUDIT_SANS_CONNEXION:-}" != "1" ]; then
  : "${GITHUB_TOKEN:?}" "${GITHUB_ACTOR:?}"
  echo "$GITHUB_TOKEN" | docker login "$REGISTRE" -u "$GITHUB_ACTOR" --password-stdin
fi

publier() {
  local local_nom="$1" distant="$REGISTRE/$PROPRIETAIRE/$2"
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

if [ "${GWAUDIT_SANS_CONNEXION:-}" != "1" ]; then
  docker logout "$REGISTRE"
  # Un paquet ghcr.io est privé tant qu'on ne l'a pas rendu public : sans
  # identifiants, l'image doit pouvoir se tirer. Sinon, ce n'est pas un échec de
  # publication mais une action à faire dans l'interface GitHub, dite ici.
  for nom in gwaudit-execution gwaudit-egress-proxy; do
    if docker manifest inspect "$REGISTRE/$PROPRIETAIRE/$nom:$ETIQUETTE" >/dev/null 2>&1; then
      echo "PUBLIC : $REGISTRE/$PROPRIETAIRE/$nom se tire sans identifiants"
    else
      echo "::warning::$REGISTRE/$PROPRIETAIRE/$nom est PRIVÉ : à rendre public dans GitHub (profil → Packages → $nom → Package settings → Change visibility → Public), sinon le VPS devra s'authentifier pour le tirer"
    fi
  done
fi
