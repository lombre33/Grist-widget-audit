# Image de la zone d'exécution V2 — un conteneur = un seul job d'audit
# (voir docs/ARCHITECTURE-V2.md §2, §3, §4).
#
# Construite pour la première fois le 2026-09-29, ce qui a révélé deux
# défauts que la relecture n'avait pas vus (contexte de construction du
# compose, chemin de Chromium dans entrypoint.sh) — voir
# docker/README-V2-VERIFICATIONS.md pour ce qui est éprouvé et où. La
# construction de référence est celle de GitHub Actions
# (.github/workflows/image-v2.yml) : le contexte est la RACINE du dépôt,
# `docker build -f docker/execution/Dockerfile .`.
#
# Base épinglée par digest (index multi-architecture de la balise
# v1.63.0-jammy au 2026-09-29) : une balise peut être republiée sous le
# même nom, un digest non ; `node docker/ci/derive-empreintes.mjs` dit si la
# balise désigne aujourd'hui autre chose. BASE_IMAGE ne se surcharge que pour un
# essai local ou pour monter la version de Playwright (voir plus bas).
ARG BASE_IMAGE=mcr.microsoft.com/playwright:v1.63.0-jammy@sha256:167d0506cfbe3c294fb214b2d11737326eeee028aa611fa1ba538e5057675847
#
# Base Playwright officielle plutôt qu'une image Node nue + apt-get manuel
# des dépendances système de Chromium (fonts, libs) : cette image les
# embarque déjà, testées pour cet usage exact. Version alignée sur la
# dépendance "playwright" de package.json (^1.63.0) — à remonter ensemble
# si l'une des deux bouge, sinon GWAUDIT_CHROMIUM_PATH (résolu au
# lancement par entrypoint.sh) peut ne plus rien trouver.
#
# Dernière vérification de fraîcheur : commit a6b6ee8 (2026-09-28). Cette
# image COPY bin/, src/, ressources/, package.json et package-lock.json
# (voir plus bas) : tout commit qui touche l'un de ces chemins après celui
# ci-dessus rend l'image obsolète et impose une reconstruction avant le
# prochain déploiement. Un contrôle automatique quotidien (routine
# « Fraîcheur image Docker V2 ») constate ces écarts ; ce hash n'avance
# qu'au moment où Antoine est prévenu qu'une reconstruction est à faire,
# pas à chaque constat — voir docker/README-V2-VERIFICATIONS.md.
FROM ${BASE_IMAGE}

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
# "pwuser", avec les permissions nécessaires sur /ms-playwright.
#
# Le bac à sable natif de Chromium est actif par défaut dans gwaudit (le widget
# audité est du code non fiable) et cette image REFUSE la dérogation
# GWAUDIT_CHROMIUM_SANS_SANDBOX (entrypoint.sh). Sous cette enveloppe
# (cap_drop: ALL, no-new-privileges, lecture seule), il ne démarre que si le
# moteur de conteneurs reçoit, au lancement, le profil seccomp
# docker/execution/seccomp-chromium.json ET la capacité SYS_CHROOT — ce que
# fait docker-compose.v2-execution.yml, et que quiconque lance l'image sans lui
# doit reproduire. Ces deux réglages ne sont pas dans l'image : sans eux,
# Chromium ne démarre pas, l'axe D est « non exécuté » avec cette cause
# (D-INDISPONIBLE) et l'audit ne tourne jamais sans bac à sable. La réponse
# documentée en §4 de docs/ARCHITECTURE-V2.md si un noyau ne le permet pas est
# une deuxième couche d'isolation indépendante de Chromium (conteneur jetable +
# réseau fermé, déjà en place ; microVM si le volume le justifie un jour) —
# jamais céder et repasser en --no-sandbox.
# Durée de l'analyse du code dans son enfant à limite (src/isolement, docs/ARCHITECTURE-V2.md §4) : au-delà,
# l'enfant est tué et l'audit conclut par un rapport de repli (C-SURFACE-03, axes empêchés), au lieu d'attendre
# le plafond de 480 s du conteneur, qui ne laisserait ni rapport ni axe D. 240 s laissent, sous 480 s, le clonage
# (120 s au plus), l'axe D (~90 s) et l'écriture des rapports. La mémoire, elle, suit celle du conteneur
# (mem_limit) sans rien poser ici : GWAUDIT_MEMOIRE_ANALYSE_MO ne se surcharge que pour un essai.
ENV GWAUDIT_DELAI_ANALYSE_S=240

USER pwuser

ENTRYPOINT ["/app/entrypoint.sh"]

# Rattache l'image publiée à ce dépôt ; la révision exacte est posée à la
# construction par le compose (GWAUDIT_REVISION).
LABEL org.opencontainers.image.source="https://github.com/lombre33/Grist-widget-audit" \
      org.opencontainers.image.description="Zone d'exécution gwaudit V2 : un conteneur = un audit"
