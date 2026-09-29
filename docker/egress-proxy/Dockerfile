# Proxy de sortie à liste blanche pour les deux seules étapes qui ont
# besoin d'une vraie sortie réseau (clonage git, npm audit) — voir
# docs/ARCHITECTURE-V2.md §4, "Proposition concrète pour le VPS d'Antoine".
#
# Construit et éprouvé par GitHub Actions (.github/workflows/image-v2.yml,
# docker/ci/verifier.sh) : liste blanche, refus des hôtes hors liste,
# refus d'un nom autorisé qui se résout vers 127.0.0.1 — ce que ces
# vérifications prouvent, et où, est dans docker/README-V2-VERIFICATIONS.md.
# Le contexte de construction est docker/egress-proxy (rien d'autre n'y est
# copié). Choisi plutôt que tinyproxy (l'alternative citée en §4) : le
# filtrage par domaine sur la méthode CONNECT (acl dstdomain + http_access)
# est une configuration squid canonique et stable d'une version à l'autre,
# alors que la syntaxe de filtrage de tinyproxy n'a pas pu être vérifiée
# contre sa documentation actuelle (déjà signalé en §4).
# L'image de base est épinglée par empreinte (l'index multi-architectures de
# debian:bookworm-slim au 2026-09-29) : une étiquette peut être repointée, une
# empreinte non, et la construction échoue si elle disparaît au lieu de prendre
# autre chose en silence. Pour la mettre à jour, reprendre l'empreinte d'index
# (`docker buildx imagetools inspect debian:bookworm-slim`) et relancer le
# workflow image-v2.yml ; les correctifs de sécurité de l'image de base
# n'arrivent donc que par ce geste. Le paquet squid, lui, est celui de bookworm
# au moment de la construction (non épinglé) ; `tests/images-epinglees.test.mjs`
# vérifie que toute image de base des Dockerfile de docker/ porte une empreinte.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

RUN apt-get update \
    && apt-get install -y --no-install-recommends squid \
    && rm -rf /var/lib/apt/lists/*

COPY squid.conf /etc/squid/squid.conf

EXPOSE 3128

# Le paquet squid Debian tourne en root puis abandonne lui-même ses
# privilèges vers l'utilisateur "proxy" (cache_effective_user, dans
# squid.conf) pour pouvoir créer ses répertoires d'exécution — forcer un
# USER non root ici au niveau Docker risque de l'en empêcher. La
# restriction non négociable est côté docker-compose.v2-execution.yml
# (cap_drop, no-new-privileges), pas ici. À vérifier au premier démarrage
# réel sur le VPS.
CMD ["squid", "-N", "-d", "1"]

# Rattache l'image publiée à ce dépôt (GitHub en déduit le paquet et sa
# visibilité) ; la révision exacte est posée à la construction par le compose.
LABEL org.opencontainers.image.source="https://github.com/lombre33/Grist-widget-audit" \
      org.opencontainers.image.description="Proxy de sortie à liste blanche (squid) de la zone d'exécution gwaudit V2"
