# Proxy de sortie à liste blanche pour les deux seules étapes qui ont
# besoin d'une vraie sortie réseau (clonage git, npm audit) — voir
# docs/ARCHITECTURE-V2.md §4, "Proposition concrète pour le VPS d'Antoine".
#
# ÉCRIT ET RELU ICI, JAMAIS CONSTRUIT NI DÉMARRÉ : même limite que
# docker/execution/Dockerfile — Docker Hub est bloqué depuis cet
# environnement, et squid.conf n'a donc jamais pu être éprouvé contre un
# vrai CONNECT. Choisi plutôt que tinyproxy (l'alternative citée en §4) :
# le filtrage par domaine sur la méthode CONNECT (acl dstdomain +
# http_access) est une configuration squid canonique et stable d'une
# version à l'autre, alors que la syntaxe de filtrage de tinyproxy n'a
# pas pu être vérifiée contre sa documentation actuelle depuis cette
# session (déjà signalé en §4).
FROM debian:bookworm-slim

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
