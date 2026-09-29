# seccomp-chromium.json

Profil seccomp de Docker (celui par défaut) **plus** l'autorisation de créer
des espaces de noms utilisateur (`clone`, `unshare`, `setns`) : c'est ce dont
le bac à sable natif de Chromium a besoin, et le profil par défaut de Docker
le refuse (« No usable sandbox! »).

## Provenance

- Origine : `utils/docker/seccomp_profile.json` de `microsoft/playwright`,
  **au commit `1b025d7e20a026371cd5f98ba0cdce48892737c8`**, celui de l'étiquette
  `v1.63.0` — la version de Playwright de l'image de base (`Dockerfile`, `ARG
  BASE_IMAGE`). Repris tel quel, aucune modification.
  https://github.com/microsoft/playwright/blob/1b025d7e20a026371cd5f98ba0cdce48892737c8/utils/docker/seccomp_profile.json
- Empreinte épinglée dans `seccomp-chromium.sha256` (sha256
  `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`). Chaque
  passage de la CI la vérifie (`sha256sum -c`, étape `build` de
  `docker/ci/verifier.sh`) : un profil modifié à la main, ou remplacé sans mettre
  à jour cette provenance, fait échouer la vérification avant toute construction.
  Pour mettre à jour le profil avec Playwright : nouveau commit et nouvelle
  empreinte ensemble, ici et dans ce fichier.
- Licence : Apache-2.0, texte joint dans `LICENSE-playwright-apache-2.0.txt`,
  avis de Playwright dans `NOTICE-playwright.txt` (le dépôt d'audit reste sous sa
  propre licence ; ce sont les deux fichiers d'un tiers qu'il redistribue).

## Ce qu'il faut à côté

- Utilisé par `docker/docker-compose.v2-execution.yml` (`security_opt`), avec
  `cap_add: SYS_CHROOT` : le profil n'autorise `chroot` que si le conteneur
  détient cette capacité dans son ensemble borné, et le bac à sable de
  Chromium l'appelle une fois dans son espace de noms utilisateur. Pour un
  processus non root (`pwuser`), une capacité ajoutée reste hors de l'ensemble
  effectif : le noyau refuse toujours `chroot` hors de cet espace de noms.
- Quiconque déploie l'image sans ce compose doit reproduire les deux réglages
  (`--security-opt seccomp=… --cap-add SYS_CHROOT`), sans quoi Chromium ne
  démarre pas avec son bac à sable — et l'audit le dit (`D-INDISPONIBLE`, avec la
  cause) au lieu de le lancer sans bac à sable.

## Ce qui l'éprouve

`docker/ci/verifier.sh securite` lit `chrome://sandbox` dans le conteneur (« You
are adequately sandboxed ») et rejoue l'essai deux fois en retirant **un**
élément à la fois : profil par défaut de Docker (avec `SYS_CHROOT`), puis profil
de Playwright sans `SYS_CHROOT`. Les deux doivent échouer : chaque réglage est
nécessaire, aucun n'est là par précaution.
