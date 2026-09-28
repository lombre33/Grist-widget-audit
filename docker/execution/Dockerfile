# Image de la zone d'exécution V2 — un conteneur = un seul job d'audit
# (voir docs/ARCHITECTURE-V2.md §2, §3, §4).
#
# ÉCRITE ET RELUE ICI, JAMAIS CONSTRUITE NI DÉMARRÉE : la politique réseau
# de cet environnement cloud bloque Docker Hub (voir docker/README.md) —
# `docker build` n'a donc jamais pu être exécuté sur ce fichier. La
# première construction et le premier `docker run`/`docker compose up`
# doivent se faire sur le VPS d'Antoine : c'est là, et seulement là, que
# ce Dockerfile sera pour la première fois éprouvé pour de vrai.
#
# Base Playwright officielle plutôt qu'une image Node nue + apt-get manuel
# des dépendances système de Chromium (fonts, libs) : cette image les
# embarque déjà, testées pour cet usage exact. Version alignée sur la
# dépendance "playwright" de package.json (^1.63.0) — à remonter ensemble
# si l'une des deux bouge, sinon GWAUDIT_CHROMIUM_PATH (résolu au
# lancement par entrypoint.sh) peut ne plus rien trouver.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

# Dépendances d'abord, pour le cache Docker ; jamais les devDependencies
# dans une image qui exécute du code non fiable.
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Puis le code du job : gwaudit tel quel, pas un fork serveur (décision
# d'Antoine, voir docs/ARCHITECTURE-V2.md §2). fixtures/ et tests/ ne sont
# d'aucune utilité à l'exécution d'un job et restent hors de l'image.
COPY bin/ ./bin/
COPY src/ ./src/
COPY ressources/ ./ressources/

COPY docker/execution/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# L'image Playwright officielle fournit déjà un utilisateur non root,
# "pwuser", avec les permissions nécessaires sur /ms-playwright — à
# confirmer sur le VPS que cap_drop: ALL + no-new-privileges (voir
# docker-compose.v2-execution.yml) n'empêchent pas le sandbox natif de
# Chromium de démarrer sous cet utilisateur. Si c'est le cas, la réponse
# documentée en §4 est une deuxième couche d'isolation indépendante de
# Chromium (conteneur jetable + réseau fermé, déjà en place ; microVM si
# le volume le justifie un jour) — jamais céder et repasser en
# --no-sandbox.
USER pwuser

ENTRYPOINT ["/app/entrypoint.sh"]
