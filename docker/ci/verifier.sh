#!/usr/bin/env bash
# Vérifications de l'image V2 (zone d'exécution + proxy de sortie), rejouées
# par .github/workflows/image-v2.yml sur un runner GitHub. C'est la version
# exécutable de docker/README-V2-VERIFICATIONS.md : ce qui s'y lit comme une
# commande à taper sur le VPS est ici une commande qui tourne et échoue.
#
# Usage : bash docker/ci/verifier.sh <build|audit|securite|proxy|plafond|memoire|tout>
#
# Règle de ce script : une vérification qui ne peut rien prouver échoue au lieu
# de passer. Chaque blocage attendu a donc un témoin (la même commande sur un
# réseau ouvert doit, elle, aboutir), et chaque coupure attend d'abord de
# constater que la chose à couper tournait bien.
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$RACINE"

PROJET=gwaudit-v2
COMPOSE=(docker compose -p "$PROJET" -f docker/docker-compose.v2-execution.yml)
IMG_EXEC="${PROJET}-execution-audit"
IMG_PROXY="${PROJET}-egress-proxy"
SORTIE="$RACINE/docker/out"
TRAVAIL="${RUNNER_TEMP:-/tmp}/gwaudit-v2-verif"
DEPOT_TEMOIN="https://github.com/lombre33/Grist_Table_structure_import"
SSH_OPTS='ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=no'
mkdir -p "$TRAVAIL"

echec() { echo "::error::$*"; echo "ÉCHEC : $*" >&2; exit 1; }
ok() { echo "OK : $*"; }
titre() { echo; echo "=== $* ==="; }

preparer_sortie() { rm -rf "$SORTIE"; mkdir -p "$SORTIE"; chmod 777 "$SORTIE"; }
dans_conteneur() { "${COMPOSE[@]}" run --rm -T --entrypoint sh execution-audit -c "$1"; }

# Audit complet d'une cible dans le conteneur ; rend le code de sortie de
# gwaudit (0 conforme, 1 sous réserve ou non conforme, 2 bloquant : ce sont des
# verdicts, pas des pannes — seul 3 ou un code de coupure est une panne).
lancer_audit() {
  local journal="$1"; shift
  set +e
  "${COMPOSE[@]}" run --rm -T "$@" 2>&1 | tee "$journal"
  local code=${PIPESTATUS[0]}
  set -e
  return "$code"
}

cmd_build() {
  titre "Construction des deux images (compose, contexte = racine du dépôt)"
  "${COMPOSE[@]}" build
  # Pour épingler la base du proxy par digest : à relever ici, puis à écrire dans son Dockerfile.
  docker buildx imagetools inspect debian:bookworm-slim 2>&1 | sed -n 1,4p || true
  docker image ls --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}' | grep -E "REPOSITORY|$PROJET" || true
  ok "les deux images se construisent"
}

cmd_audit() {
  titre "Audit réel de widget-exemple dans le conteneur durci"
  preparer_sortie
  local code=0
  lancer_audit "$TRAVAIL/audit.log" -v "$RACINE/fixtures/widget-exemple:/widget:ro" execution-audit /widget || code=$?
  [ "$code" -le 2 ] || echec "gwaudit a rendu le code $code dans le conteneur (3 = erreur interne, 124/137 = coupure)"
  node docker/ci/verifier-rapport.mjs "$SORTIE/rapport.json" || echec "rapport incomplet, voir ci-dessus (l'axe D est le suspect : bac à sable Chromium sous cap_drop ALL et seccomp par défaut ?)"
  ok "audit complet dans le conteneur, axe D exécuté"
}

cmd_securite() {
  titre "Enveloppe du conteneur : non-root, sans capacités, lecture seule, réseau fermé"
  local uid cap nnp
  uid="$(dans_conteneur 'id -u' | tr -d '\r')"
  [ "$uid" != "0" ] || echec "le conteneur tourne en root"
  ok "utilisateur non root (uid $uid)"

  cap="$(dans_conteneur "awk '/^CapEff/ {print \$2}' /proc/self/status" | tr -d '\r')"
  [ "$cap" = "0000000000000000" ] || echec "capacités effectives non nulles : $cap"
  ok "aucune capacité (CapEff=$cap)"

  nnp="$(dans_conteneur "awk '/^NoNewPrivs/ {print \$2}' /proc/self/status" | tr -d '\r')"
  [ "$nnp" = "1" ] || echec "no-new-privileges non appliqué (NoNewPrivs=$nnp)"
  ok "no-new-privileges appliqué"

  if dans_conteneur 'touch /app/ecriture-interdite' >/dev/null 2>&1; then echec "écriture possible sous /app : rootfs pas en lecture seule"; fi
  dans_conteneur 'touch /tmp/ecriture-permise' >/dev/null 2>&1 || echec "écriture impossible sous /tmp : le tmpfs de travail ne marche pas"
  ok "rootfs en lecture seule, /tmp inscriptible"

  local sans_sandbox
  sans_sandbox="$(dans_conteneur 'env | grep -c "^GWAUDIT_CHROMIUM_SANS_SANDBOX=" || true' | tr -d '\r')"
  [ "$sans_sandbox" = "0" ] || echec "GWAUDIT_CHROMIUM_SANS_SANDBOX est posée dans le conteneur"
  ok "aucune dérogation --no-sandbox"

  local ferme temoin
  ferme="$("${COMPOSE[@]}" run --rm -T -v "$RACINE/docker/ci:/ci:ro" --entrypoint node execution-audit /ci/sonde-reseau.mjs http://1.1.1.1 | tr -d '\r')"
  temoin="$(docker run --rm -v "$RACINE/docker/ci:/ci:ro" --entrypoint node "$IMG_EXEC" /ci/sonde-reseau.mjs http://1.1.1.1 | tr -d '\r')"
  echo "réseau du conteneur d'exécution : $ferme ; témoin sur réseau ouvert : $temoin"
  [ "$temoin" = "SORTI" ] || echec "témoin réseau ouvert non concluant ($temoin) : la sonde ou le runner sont en cause, le blocage ne prouve rien"
  [[ "$ferme" == BLOQUE:* ]] || echec "le conteneur d'exécution atteint Internet ($ferme)"
  ok "réseau fermé (le témoin sur réseau ouvert sort bien)"
}

cmd_proxy() {
  titre "Proxy de sortie : liste blanche, pièges, SSH, anti-rebinding"
  "${COMPOSE[@]}" up -d egress-proxy

  local ok_ls=""
  for _ in $(seq 1 20); do
    if ok_ls="$(dans_conteneur "git ls-remote $DEPOT_TEMOIN HEAD" 2>"$TRAVAIL/ls-ok.err")" && [ -n "$ok_ls" ]; then break; fi
    ok_ls=""; sleep 2
  done
  [ -n "$ok_ls" ] || { cat "$TRAVAIL/ls-ok.err" >&2; echec "git ls-remote vers un hôte autorisé (github.com) échoue à travers le proxy"; }
  ok "hôte autorisé joignable à travers le proxy : ${ok_ls%%$'\t'*}"

  local sortie
  for refuse in "https://gitlab.gnome.org/GNOME/gimp.git" "https://github.com.attaquant.example/x.git"; do
    if sortie="$(dans_conteneur "git ls-remote $refuse HEAD 2>&1")"; then echec "hôte hors liste blanche accepté : $refuse"; fi
    grep -q '403' <<<"$sortie" || echec "$refuse refusé, mais pas par le proxy (403 attendu) : $sortie"
    ok "refusé par le proxy (403) : $refuse"
  done

  local ssh_sortie ssh_temoin
  ssh_sortie="$(dans_conteneur "GIT_SSH_COMMAND='$SSH_OPTS' timeout 30 git ls-remote git@github.com:lombre33/Grist_Table_structure_import.git HEAD 2>&1" || true)"
  ssh_temoin="$(docker run --rm --read-only --tmpfs /tmp:exec -e HOME=/tmp --entrypoint sh "$IMG_EXEC" -c "GIT_SSH_COMMAND='$SSH_OPTS' timeout 30 git ls-remote git@github.com:lombre33/Grist_Table_structure_import.git HEAD 2>&1" || true)"
  echo "SSH depuis le conteneur d'exécution : $ssh_sortie"
  echo "SSH témoin sur réseau ouvert : $ssh_temoin"
  grep -qiE 'Permission denied|publickey' <<<"$ssh_temoin" || echec "témoin SSH non concluant : le runner n'atteint pas le port 22 de github.com, l'essai ne prouve rien ($ssh_temoin)"
  if grep -qiE 'Permission denied|publickey|Host key|Permanently added' <<<"$ssh_sortie"; then echec "SSH a atteint github.com depuis le conteneur d'exécution : voie parallèle au proxy"; fi
  [ -n "$ssh_sortie" ] || echec "SSH sans aucun message : essai non concluant"
  ok "SSH n'ouvre pas de voie parallèle (échec par le réseau, pas par les identifiants)"

  titre "Anti-rebinding : un nom autorisé qui se résout vers 127.0.0.1 est refusé"
  local reseau=gwaudit-rebind proxy=gwaudit-proxy-rebind
  docker rm -f "$proxy" >/dev/null 2>&1 || true
  docker network rm "$reseau" >/dev/null 2>&1 || true
  docker network create --internal "$reseau" >/dev/null
  docker run -d --name "$proxy" --network "$reseau" --add-host github.com:127.0.0.1 "$IMG_PROXY" >/dev/null
  sleep 4
  local rebind
  if rebind="$(docker run --rm --network "$reseau" -e HTTPS_PROXY="http://$proxy:3128" --entrypoint git "$IMG_EXEC" ls-remote "$DEPOT_TEMOIN" HEAD 2>&1)"; then
    docker rm -f "$proxy" >/dev/null; docker network rm "$reseau" >/dev/null
    echec "le proxy a laissé passer un nom autorisé résolu vers 127.0.0.1"
  fi
  docker rm -f "$proxy" >/dev/null; docker network rm "$reseau" >/dev/null
  grep -q '403' <<<"$rebind" || echec "rebinding refusé, mais pas par le proxy (403 attendu) : $rebind"
  ok "anti-rebinding : refusé par le proxy (403)"

  titre "Audit de bout en bout d'une URL : clone et npm audit à travers le proxy"
  preparer_sortie
  local code=0
  lancer_audit "$TRAVAIL/audit-url.log" execution-audit "$DEPOT_TEMOIN" || code=$?
  [ "$code" -le 2 ] || echec "audit d'URL : code $code"
  node docker/ci/verifier-rapport.mjs "$SORTIE/rapport.json" || echec "audit d'URL : rapport incomplet"
  ok "audit d'une URL réelle, de bout en bout, à travers le proxy"
}

cmd_plafond() {
  titre "Plafond de durée : un audit bloqué est coupé, Chromium avec lui"
  # Un « gwaudit » de substitution monté sur bin/gwaudit.js — le vrai
  # entrypoint.sh, la vraie image — qui lance un Chromium puis reste bloqué en
  # boucle synchrone : la situation que le plafond existe pour couper (un
  # thread pris dans du retour arrière ne peut pas se couper lui-même), rendue
  # déterministe. Avec le vrai gwaudit, le blocage dépendrait de la vitesse du
  # runner.
  local nom=gwaudit-plafond dossier="$TRAVAIL/blocage"
  mkdir -p "$dossier"
  cat > "$dossier/bloque.mjs" <<'JS'
import { spawn } from 'node:child_process';
spawn(process.env.GWAUDIT_CHROMIUM_PATH, ['--headless=new', '--no-sandbox', '--disable-gpu', '--user-data-dir=/tmp/profil-substitut', 'about:blank'], { stdio: 'ignore' });
console.log('substitut : Chromium lancé, boucle synchrone');
for (;;) {}
JS
  preparer_sortie
  docker rm -f "$nom" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" run -d --name "$nom" -e GWAUDIT_PLAFOND_S=20 -v "$dossier/bloque.mjs:/app/bin/gwaudit.js:ro" execution-audit /widget >/dev/null
  local t0 t1 haut code
  t0="$(date +%s)"
  sleep 8
  haut="$(docker top "$nom" 2>&1 || true)"
  if ! grep -q 'chrome' <<<"$haut"; then
    docker logs "$nom" 2>&1 | tail -20; docker rm -f "$nom" >/dev/null 2>&1 || true
    echo "$haut"
    echec "essai non concluant : aucun Chromium en cours à 8 s, il n'y a rien à couper (voir le journal ci-dessus)"
  fi
  ok "un Chromium tourne, et le processus principal est bloqué, au moment où le plafond doit tomber"
  code="$(docker wait "$nom")"
  t1="$(date +%s)"
  docker logs "$nom" 2>&1 | tail -5 || true
  docker rm -f "$nom" >/dev/null 2>&1 || true
  echo "durée $((t1 - t0)) s après le contrôle, code de sortie $code"
  { [ "$code" = "124" ] || [ "$code" = "137" ]; } || echec "code $code au lieu de 124 (timeout) ou 137 (SIGKILL de repli)"
  [ $((t1 - t0)) -ge 8 ] && [ $((t1 - t0)) -le 35 ] || echec "coupure $((t1 - t0)) s après le contrôle, attendue autour de 12 s (plafond 20 s)"
  sleep 2
  if pgrep -f '/ms-playwright/chromium-' >/dev/null; then pgrep -af '/ms-playwright/chromium-' || true; echec "un Chromium survit à la destruction du conteneur"; fi
  ok "audit coupé au plafond (code $code), aucun Chromium orphelin"

  titre "Widget qui boucle sans fin : le vrai audit conclut de lui-même, sans Chromium orphelin"
  mkdir -p "$TRAVAIL/boucle"
  printf '<!doctype html><html><body><script>for(;;){}</script></body></html>\n' > "$TRAVAIL/boucle/index.html"
  preparer_sortie
  local debut fin
  debut="$(date +%s)"
  code=0
  lancer_audit "$TRAVAIL/audit-boucle.log" -e GWAUDIT_PLAFOND_S=150 -v "$TRAVAIL/boucle:/widget:ro" execution-audit /widget || code=$?
  fin="$(date +%s)"
  echo "durée $((fin - debut)) s, code $code"
  [ "$code" -le 2 ] || echec "l'audit d'un widget qui boucle n'a pas conclu (code $code) : coupé par le plafond de 150 s ou en panne"
  node docker/ci/verifier-rapport.mjs "$SORTIE/rapport.json" || echec "rapport incomplet pour le widget qui boucle"
  sleep 2
  if pgrep -f '/ms-playwright/chromium-' >/dev/null; then pgrep -af '/ms-playwright/chromium-' || true; echec "un Chromium survit à l'audit du widget qui boucle"; fi
  ok "le vrai audit conclut en $((fin - debut)) s sur un widget qui boucle, aucun Chromium orphelin"
}

cmd_memoire() {
  titre "Limite mémoire (cgroups) : un widget qui alloue sans fin est contenu"
  local nom=gwaudit-memoire dossier="$TRAVAIL/gouffre"
  mkdir -p "$dossier"
  printf '<!doctype html><html><body><script>const a=[];for(;;){a.push(new Uint8Array(20*1024*1024).fill(1))}</script></body></html>\n' > "$dossier/index.html"
  preparer_sortie
  docker rm -f "$nom" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" run -d --name "$nom" -e GWAUDIT_PLAFOND_S=60 -v "$dossier:/widget:ro" execution-audit /widget >/dev/null
  local limite pic=0 mib
  limite="$(docker inspect -f '{{.HostConfig.Memory}}' "$nom")"
  [ "$limite" = "805306368" ] || echec "limite mémoire du conteneur = $limite octets au lieu de 768 Mio : le compose n'est pas appliqué"
  while [ "$(docker inspect -f '{{.State.Running}}' "$nom")" = "true" ]; do
    mib="$(docker stats --no-stream --format '{{.MemUsage}}' "$nom" 2>/dev/null | awk '{
      v=$1; u=v; gsub(/[0-9.]/,"",u); gsub(/[A-Za-z]/,"",v);
      if (u=="GiB") v*=1024; else if (u=="KiB") v/=1024; else if (u=="B") v/=1048576;
      printf "%d", v }')"
    [ -n "$mib" ] && [ "$mib" -gt "$pic" ] && pic="$mib"
    sleep 1
  done
  local oom code
  oom="$(docker inspect -f '{{.State.OOMKilled}}' "$nom")"
  code="$(docker inspect -f '{{.State.ExitCode}}' "$nom")"
  docker logs "$nom" 2>&1 | tail -15 || true
  docker rm -f "$nom" >/dev/null 2>&1 || true
  echo "pic mesuré ${pic} Mio pour une limite de 768 Mio, OOMKilled=$oom, code $code"
  [ "$pic" -le $((768 * 102 / 100)) ] || echec "la mémoire a dépassé la limite (${pic} Mio) : les cgroups ne coupent pas"
  { [ "$oom" = "true" ] || [ "$pic" -ge $((768 * 60 / 100)) ]; } || echec "essai non concluant : le widget n'a ni approché la limite (${pic} Mio) ni été tué par le noyau"
  ok "mémoire contenue sous 768 Mio face à un widget qui alloue sans fin"
}

case "${1:-}" in
  build) cmd_build ;;
  audit) cmd_audit ;;
  securite) cmd_securite ;;
  proxy) cmd_proxy ;;
  plafond) cmd_plafond ;;
  memoire) cmd_memoire ;;
  tout) cmd_build; cmd_audit; cmd_securite; cmd_proxy; cmd_plafond; cmd_memoire ;;
  *) echo "usage : $0 <build|audit|securite|proxy|plafond|memoire|tout>" >&2; exit 2 ;;
esac
