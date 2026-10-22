#!/usr/bin/env bash
# First-time installation on Ubuntu 24.04 LTS — native, no Docker.
#
#   sudo DOMAIN=mail.example.org CORR_OWNER_PASSWORD=... CORR_APP_PASSWORD=... \
#        /opt/correspondence/deploy/scripts/install.sh
#
# Prerequisite: the repository is at /opt/correspondence and
# /etc/correspondence/correspondence.env exists (from deploy/env.example +
# gen-secrets.sh) with the same database passwords.
# Re-running is safe: each step checks before it creates.
set -euo pipefail

: "${DOMAIN:?set DOMAIN}"
: "${CORR_OWNER_PASSWORD:?set CORR_OWNER_PASSWORD}"
: "${CORR_APP_PASSWORD:?set CORR_APP_PASSWORD}"
APP=/opt/correspondence
ENV_FILE=/etc/correspondence/correspondence.env
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (see deploy/env.example)"; exit 1; }
[ -f /etc/correspondence/migrate.env ] || { echo "missing /etc/correspondence/migrate.env (MIGRATE_DATABASE_URL, owner role)"; exit 1; }

echo "== 1. system packages"
apt-get update
apt-get install -y python3 python3-venv python3-dev build-essential \
    postgresql postgresql-contrib redis-server nginx certbot curl ca-certificates
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    echo "   Node.js >= 20 is needed only to build the frontend; install it (e.g. from NodeSource) and re-run."
    exit 1
fi

echo "== 2. service account and directories"
id correspondence >/dev/null 2>&1 || useradd --system --home /var/lib/correspondence --shell /usr/sbin/nologin correspondence
usermod -aG correspondence www-data   # nginx reads the Daphne socket
install -d -o correspondence -g correspondence -m 0750 /var/lib/correspondence /var/lib/correspondence/blobs
install -d -o root -g root -m 0700 /var/backups/correspondence
chown root:correspondence "$ENV_FILE"; chmod 0640 "$ENV_FILE"
chown root:root /etc/correspondence/migrate.env; chmod 0600 /etc/correspondence/migrate.env

echo "== 3. Redis: local only, no persistence of channel traffic needed"
sed -i 's/^#\?\s*bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf
sed -i 's/^#\?\s*protected-mode .*/protected-mode yes/' /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server

echo "== 4. PostgreSQL: owner role (migrations) + runtime role (append-only logs)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'corr_owner') THEN
    CREATE ROLE corr_owner LOGIN PASSWORD '${CORR_OWNER_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'corr_app') THEN
    CREATE ROLE corr_app LOGIN PASSWORD '${CORR_APP_PASSWORD}';
  END IF;
END \$\$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='correspondence'" | grep -q 1 \
    || sudo -u postgres createdb -O corr_owner -E UTF8 correspondence
sudo -u postgres psql -d correspondence -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO corr_owner;"

echo "== 5. Python environment"
[ -d "$APP/.venv" ] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install --upgrade pip
"$APP/.venv/bin/pip" install -r "$APP/backend/requirements/prod.txt"

echo "== 6. systemd units"
install -m 0644 "$APP"/deploy/systemd/*.service "$APP"/deploy/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload

echo "== 7. nginx site"
sed "s/mail.example.org/${DOMAIN}/g" "$APP/deploy/nginx/correspondence.conf" > /etc/nginx/sites-available/correspondence
ln -sf /etc/nginx/sites-available/correspondence /etc/nginx/sites-enabled/correspondence
rm -f /etc/nginx/sites-enabled/default
install -d /var/www/letsencrypt
if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
    echo "   No certificate yet. Obtain one, e.g.:"
    echo "   certbot certonly --webroot -w /var/www/letsencrypt -d ${DOMAIN}"
    echo "   (or place your organisation's certificate at that path), then run deploy.sh."
fi

echo "== 8. build + migrate + start"
DOMAIN="$DOMAIN" "$APP/deploy/scripts/deploy.sh"
systemctl enable --now correspondence-reminders.timer correspondence-backup.timer
echo "Done. Next: create the first administrator — see deploy/README.md §5."
