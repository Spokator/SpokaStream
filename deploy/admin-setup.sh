#!/usr/bin/env bash
# Crée ou remplace l'accès au panneau d'administration : mot de passe oublié, téléphone perdu.
#   sudo bash deploy/admin-setup.sh
# Affiche un lien à usage unique, valable 24 heures.
set -euo pipefail
set -a
. /opt/spokastream/.env
set +a
cd /opt/spokastream
path=$(sudo -E -u spokastream /usr/bin/node /opt/spokastream/spokastream-server.mjs --admin-setup)
echo "https://stream.chretieno.fr$path"
