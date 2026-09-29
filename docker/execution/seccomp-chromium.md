# seccomp-chromium.json

Profil seccomp de Docker (celui par défaut) **plus** l'autorisation de créer
des espaces de noms utilisateur (`clone`, `unshare`, `setns`) : c'est ce dont
le bac à sable natif de Chromium a besoin, et le profil par défaut de Docker
le refuse (« No usable sandbox! »).

- Origine : Playwright, `utils/docker/seccomp_profile.json`
  (https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json),
  licence Apache-2.0, repris tel quel le 2026-09-29 — aucune modification.
- sha256 : `sha256sum docker/execution/seccomp-chromium.json`
- Utilisé par `docker/docker-compose.v2-execution.yml` (`security_opt`), avec
  `cap_add: SYS_CHROOT` : le profil n'autorise `chroot` que si le conteneur
  détient cette capacité dans son ensemble borné, et le bac à sable de
  Chromium l'appelle une fois dans son espace de noms utilisateur. Pour un
  processus non root (`pwuser`), une capacité ajoutée reste hors de l'ensemble
  effectif : le noyau refuse toujours `chroot` hors de cet espace de noms.
- Quiconque déploie l'image sans ce compose doit reproduire les deux réglages
  (`--security-opt seccomp=… --cap-add SYS_CHROOT`), sans quoi Chromium ne
  démarre pas avec son bac à sable.
- Ce qui l'éprouve : `docker/ci/verifier.sh securite` lit `chrome://sandbox`
  dans le conteneur (« You are adequately sandboxed ») et montre le même essai
  échouer sous le profil par défaut.
