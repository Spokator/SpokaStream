#!/usr/bin/env bash
# Installe ou met à jour le serveur. À lancer sur le VPS, depuis un dossier contenant
# spokastream-server.mjs et ce dossier deploy/ :  sudo bash deploy/install.sh
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET=/opt/spokastream

command -v node >/dev/null || { echo "Node.js 22 est nécessaire."; exit 1; }
[ -f "$SOURCE/spokastream-server.mjs" ] || { echo "spokastream-server.mjs introuvable : lance d'abord npm run server:build."; exit 1; }

id spokastream >/dev/null 2>&1 || useradd --system --home "$TARGET" --shell /usr/sbin/nologin spokastream
install -d -o spokastream -g spokastream "$TARGET" "$TARGET/data"
install -o spokastream -g spokastream -m 644 "$SOURCE/spokastream-server.mjs" "$TARGET/"

if [ ! -f "$TARGET/.env" ]; then
  install -o spokastream -g spokastream -m 600 "$SOURCE/deploy/.env.example" "$TARGET/.env"
  echo "Renseigne TURN_HOST et TURN_SECRET dans $TARGET/.env"
fi

install -m 644 "$SOURCE/deploy/spokastream-server.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now spokastream-server
systemctl restart spokastream-server
sleep 1
curl -fsS http://127.0.0.1:8787/health && echo
echo "Serveur en route. Pour nginx : deploy/nginx-stream.conf puis certbot --nginx -d stream.chretieno.fr"
