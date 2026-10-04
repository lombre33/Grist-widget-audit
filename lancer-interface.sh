#!/bin/sh
# Lanceur de l'interface web gwaudit (Linux, macOS) : ouvre le navigateur par défaut.
# Tout reste dans le dossier de l'outil : rapports ici, fichiers temporaires dans .tmp-travail.
cd "$(dirname "$0")" || exit 1

command -v node >/dev/null 2>&1 || { echo "Node.js est introuvable : l'installer (version 20 ou plus) puis relancer." >&2; exit 1; }
[ -f node_modules/acorn/package.json ] || { echo "Les dépendances ne sont pas installées : lancer d'abord « npm ci » dans ce dossier." >&2; exit 1; }

mkdir -p .tmp-travail
TMPDIR="$PWD/.tmp-travail"
export TMPDIR

URL="http://127.0.0.1:4317"
echo "Interface gwaudit : $URL"
echo "Ctrl+C arrête le serveur."

# Navigateur ouvert après une courte pause, le temps que le serveur démarre ; sans navigateur
# (serveur sans écran), l'adresse ci-dessus suffit.
( sleep 2; xdg-open "$URL" >/dev/null 2>&1 || open "$URL" >/dev/null 2>&1 || true ) &

exec node bin/gwaudit.js --interface
