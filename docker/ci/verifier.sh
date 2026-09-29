#!/usr/bin/env bash
# Vérifications de l'image V2 (zone d'exécution + proxy de sortie), rejouées
# par .github/workflows/image-v2.yml sur un runner GitHub. C'est la version
# exécutable de docker/README-V2-VERIFICATIONS.md : ce qui s'y lit comme une
# commande à taper sur le VPS est ici une commande qui tourne et échoue.
#
# Usage : bash docker/ci/verifier.sh <build|audit|securite|proxy|plafond|memoire|publication|tout>
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

# Aucun processus Chromium ne doit survivre à l'audit ni à la destruction du
# conteneur : sur l'hôte, rien de ce qui vient de /ms-playwright ne tourne.
# (Le runner est jetable, mais la même commande se rejoue sur le VPS.)
aucun_chromium_orphelin() {
  sleep 2
  # « [/] » : le motif ne se reconnaît pas lui-même dans la ligne de commande de
  # celui qui le cherche (bash -c, ssh…).
  if pgrep -f '[/]ms-playwright/chromium-' >/dev/null; then
    pgrep -af '[/]ms-playwright/chromium-' | cut -c1-200 || true
    echec "un Chromium survit $1"
  fi
}

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
  local nom=gwaudit-audit
  docker rm -f "$nom" >/dev/null 2>&1 || true
  "${COMPOSE[@]}" run -d --name "$nom" -v "$RACINE/fixtures/widget-exemple:/widget:ro" execution-audit /widget >/dev/null

  # Pendant l'audit, relève les arguments du vrai processus Chromium (celui du
  # navigateur, pas ses processus de rendu) : Playwright y ajoute --no-sandbox
  # de lui-même tant que gwaudit ne lui demande pas chromiumSandbox: true, donc
  # l'absence de variable de dérogation ne prouve rien — seuls les arguments du
  # processus réel disent si le bac à sable est actif.
  local vus="$TRAVAIL/chromium-arguments.txt"
  : > "$vus"
  while [ "$(docker inspect -f '{{.State.Running}}' "$nom")" = "true" ]; do
    docker top "$nom" 2>/dev/null | grep -E '/chrome-linux[^ ]*/chrome ' | grep -v -e '--type=' >> "$vus" || true
    sleep 0.3
  done
  local code
  code="$(docker wait "$nom")"
  docker logs "$nom" 2>&1 | tee "$TRAVAIL/audit.log"
  docker rm -f "$nom" >/dev/null 2>&1 || true

  [ "$code" -le 2 ] || echec "gwaudit a rendu le code $code dans le conteneur (3 = erreur interne, 124/137 = coupure)"
  node docker/ci/verifier-rapport.mjs "$SORTIE/rapport.json" || echec "rapport incomplet, voir ci-dessus (l'axe D est le suspect : Chromium ne démarre pas sous cette enveloppe)"
  local n
  n="$(sort -u "$vus" | wc -l)"
  [ "$n" -ge 1 ] || echec "aucun processus Chromium observé pendant l'audit : impossible de dire si son bac à sable est actif"
  if grep -q -e '--no-sandbox' "$vus"; then sort -u "$vus" | cut -c1-300; echec "Chromium a tourné avec --no-sandbox pendant l'audit : le widget audité s'exécute sans bac à sable"; fi
  ok "audit complet dans le conteneur, axe D exécuté, Chromium lancé sans --no-sandbox ($n relevés du processus navigateur)"
  aucun_chromium_orphelin "à l'audit de widget-exemple, conteneur détruit"
  ok "aucun Chromium ne survit à l'audit ni au conteneur"
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
  ok "aucune variable de dérogation --no-sandbox (ne prouve pas à elle seule le bac à sable : voir la sonde ci-dessous et l'audit)"

  # La dérogation de gwaudit (GWAUDIT_CHROMIUM_SANS_SANDBOX) est refusée dans
  # l'image : l'audit ne démarre pas, il ne tourne pas sans bac à sable.
  preparer_sortie
  local refus code_refus=0
  refus="$("${COMPOSE[@]}" run --rm -T -e GWAUDIT_CHROMIUM_SANS_SANDBOX=1 -v "$RACINE/fixtures/widget-exemple:/widget:ro" execution-audit /widget 2>&1)" || code_refus=$?
  echo "$refus" | tail -3
  [ "$code_refus" != "0" ] || echec "l'image a accepté GWAUDIT_CHROMIUM_SANS_SANDBOX : un audit sans bac à sable est possible"
  grep -q 'refusé' <<<"$refus" || echec "refus de la dérogation sans message explicite : $refus"
  [ ! -e "$SORTIE/rapport.json" ] || echec "un rapport a été produit malgré la dérogation refusée"
  ok "la dérogation au bac à sable est refusée par l'image (code $code_refus, aucun audit lancé)"

  local chromium='export GWAUDIT_CHROMIUM_PATH="$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome | head -n1)"; node /ci/sonde-sandbox.mjs'
  local bac bac_temoin
  bac="$("${COMPOSE[@]}" run --rm -T -v "$RACINE/docker/ci:/ci:ro" --entrypoint sh execution-audit -c "$chromium" 2>&1 | tail -1 | tr -d '\r')"
  # Témoin : même enveloppe (lecture seule, sans capacité, no-new-privileges)
  # mais profil seccomp par défaut de Docker et sans SYS_CHROOT — la sonde doit
  # y échouer, sinon un SANDBOX-OK ne prouverait pas qu'elle sait échouer.
  bac_temoin="$(docker run --rm --network none --read-only --tmpfs /tmp:size=512m,mode=1777,exec --cap-drop ALL --security-opt no-new-privileges:true -e HOME=/tmp -v "$RACINE/docker/ci:/ci:ro" --entrypoint sh "$IMG_EXEC" -c "$chromium" 2>&1 | tail -1 | tr -d '\r')"
  echo "bac à sable de Chromium sous l'enveloppe du compose : $bac"
  echo "bac à sable sous le profil seccomp par défaut (témoin) : $bac_temoin"
  [ "$bac" = "SANDBOX-OK" ] || echec "Chromium ne démarre pas avec son bac à sable sous l'enveloppe du compose ($bac)"
  [[ "$bac_temoin" == SANDBOX-ABSENT* ]] || echec "témoin non concluant : la sonde ne détecte pas l'absence de bac à sable sous le profil par défaut ($bac_temoin)"
  ok "Chromium démarre avec son bac à sable (chrome://sandbox : adequately sandboxed) ; la même sonde échoue sous le profil par défaut"

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
  aucun_chromium_orphelin "à l'audit d'une URL"
  ok "aucun Chromium ne survit à l'audit d'une URL"
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
  echo "durée $((t1 - t0)) s depuis le démarrage (plafond 20 s), code de sortie $code"
  { [ "$code" = "124" ] || [ "$code" = "137" ]; } || echec "code $code au lieu de 124 (timeout) ou 137 (SIGKILL de repli)"
  [ $((t1 - t0)) -ge 18 ] && [ $((t1 - t0)) -le 35 ] || echec "coupure à $((t1 - t0)) s, attendue autour de 20 s (plafond GWAUDIT_PLAFOND_S=20)"
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
  # L'axe D ne peut pas mesurer une page qui ne finit jamais de charger : il est
  # attendu « non exécuté » ; ce qui compte ici est que l'audit conclue et le dise.
  node docker/ci/verifier-rapport.mjs --axe-d-libre "$SORTIE/rapport.json" || echec "pas de rapport exploitable pour le widget qui boucle"
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
  local swap
  swap="$(docker inspect -f '{{.HostConfig.MemorySwap}}' "$nom")"
  [ "$swap" = "805306368" ] || echec "mémoire + swap du conteneur = $swap octets au lieu de 768 Mio : le swap n'est pas exclu"
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
  aucun_chromium_orphelin "au widget qui alloue sans fin, conteneur détruit"
  ok "aucun Chromium ne survit au conteneur tué pour cause de mémoire"
}

cmd_publication() {
  titre "Publication à blanc : les deux images vers un registre local, sans identifiants"
  # Ce que ça éprouve : publier.sh (étiquettes, « latest » réservé aux versions
  # finales, propriétaire en minuscules, refus d'une étiquette invalide) et les
  # étiquettes posées par la construction (source, révision). Pas ce qui ne se
  # voit que sur ghcr.io (droits du jeton, visibilité du paquet) : publier.sh le
  # dit à la vraie publication.
  local reg=gwaudit-registre nom_reg=localhost:5000
  docker rm -f "$reg" >/dev/null 2>&1 || true
  docker run -d --name "$reg" -p 127.0.0.1:5000:5000 ghcr.io/distribution/distribution:3.0.0 >/dev/null
  for _ in $(seq 1 20); do curl -sf "http://$nom_reg/v2/" >/dev/null && break; sleep 1; done
  curl -sf "http://$nom_reg/v2/" >/dev/null || { docker logs "$reg" 2>&1 | tail -5; echec "registre local injoignable"; }

  local pub=(env GWAUDIT_REGISTRE="$nom_reg" GWAUDIT_SANS_CONNEXION=1 GITHUB_REPOSITORY_OWNER=Lombre33 bash docker/ci/publier.sh)
  if "${pub[@]}" latest >/dev/null 2>&1; then echec "publier.sh accepte l'étiquette « latest »"; fi
  ok "étiquette invalide refusée"

  "${pub[@]}" v0.0.0-essai
  local tags
  tags="$(curl -sf "http://$nom_reg/v2/lombre33/gwaudit-execution/tags/list")"
  grep -q '"v0.0.0-essai"' <<<"$tags" || echec "étiquette v0.0.0-essai absente : $tags"
  if grep -q '"latest"' <<<"$tags"; then echec "une version d'essai (v0.0.0-essai) a déplacé « latest » : $tags"; fi
  ok "une version d'essai ne déplace pas « latest »"

  "${pub[@]}" v0.0.0
  local nom d_version d_latest
  for nom in gwaudit-execution gwaudit-egress-proxy; do
    tags="$(curl -sf "http://$nom_reg/v2/lombre33/$nom/tags/list")"
    grep -q '"v0.0.0"' <<<"$tags" && grep -q '"latest"' <<<"$tags" || echec "$nom : v0.0.0 ou latest absent : $tags"
    d_version="$(curl -sfI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' "http://$nom_reg/v2/lombre33/$nom/manifests/v0.0.0" | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest" {print $2}')"
    d_latest="$(curl -sfI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' "http://$nom_reg/v2/lombre33/$nom/manifests/latest" | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest" {print $2}')"
    [ -n "$d_version" ] && [ "$d_version" = "$d_latest" ] || echec "$nom : latest ($d_latest) ne pointe pas sur v0.0.0 ($d_version)"
  done
  ok "une version finale (v0.0.0) porte « latest », pour les deux images"

  local source revision
  docker pull -q "$nom_reg/lombre33/gwaudit-execution:v0.0.0" >/dev/null
  source="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$nom_reg/lombre33/gwaudit-execution:v0.0.0")"
  revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$nom_reg/lombre33/gwaudit-execution:v0.0.0")"
  [ "$source" = "https://github.com/lombre33/Grist-widget-audit" ] || echec "étiquette source de l'image : « $source »"
  [ -z "${GWAUDIT_REVISION:-}" ] || [ "$revision" = "$GWAUDIT_REVISION" ] || echec "étiquette révision de l'image : « $revision » au lieu de $GWAUDIT_REVISION"
  ok "l'image publiée dit d'où elle vient (source $source, révision ${revision:0:7})"
  docker rm -f "$reg" >/dev/null 2>&1 || true
}

case "${1:-}" in
  build) cmd_build ;;
  audit) cmd_audit ;;
  securite) cmd_securite ;;
  proxy) cmd_proxy ;;
  plafond) cmd_plafond ;;
  memoire) cmd_memoire ;;
  publication) cmd_publication ;;
  tout) cmd_build; cmd_audit; cmd_securite; cmd_proxy; cmd_plafond; cmd_memoire; cmd_publication ;;
  *) echo "usage : $0 <build|audit|securite|proxy|plafond|memoire|publication|tout>" >&2; exit 2 ;;
esac
