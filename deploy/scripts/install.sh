#!/usr/bin/env bash
# First-time installation on Ubuntu 24.04 LTS — native, no Docker.
#
#   sudo DOMAIN=mail.example.org CERT_EMAIL=it@example.org CORR_OWNER_PASSWORD=... CORR_APP_PASSWORD=... \
#        /opt/correspondence/deploy/scripts/install.sh
#
# Prerequisite: the repository is at /opt/correspondence and
# /etc/correspondence/correspondence.env exists (from deploy/env.example +
# gen-secrets.sh) with the same database passwords.
# Re-running is safe: each step checks before it creates.
#
# SHARED SERVER: built to sit next to other applications. It installs only
# missing packages, never edits or restarts an existing Redis/PostgreSQL/nginx
# globally, never disables other nginx sites, keeps its own Node.js under
# $APP/.tools (system Node untouched), and only adds its own nginx site,
# database, roles and systemd units. Run deploy/scripts/preflight.sh first.
set -euo pipefail

: "${DOMAIN:?set DOMAIN}"
: "${CORR_OWNER_PASSWORD:?set CORR_OWNER_PASSWORD}"
: "${CORR_APP_PASSWORD:?set CORR_APP_PASSWORD}"
APP=/opt/correspondence
ENV_FILE=/etc/correspondence/correspondence.env
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (see deploy/env.example)"; exit 1; }
[ -f /etc/correspondence/migrate.env ] || { echo "missing /etc/correspondence/migrate.env (MIGRATE_DATABASE_URL, owner role)"; exit 1; }

installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"; }
port_taken() { ss -ltnH 2>/dev/null | grep -q ":$1\b"; }

echo "== 0. refuse to clash with what already runs here"
if ! installed nginx && { port_taken 80 || port_taken 443; }; then
    echo "   Ports 80/443 belong to another web server (not nginx). Stop: plug the app into that"
    echo "   proxy instead (see deploy/README.md, shared server)."; exit 1
fi
if ! installed postgresql && port_taken 5432; then
    echo "   Port 5432 is used by a non-native PostgreSQL (docker?). Stop and decide where the"
    echo "   database lives (see deploy/README.md, shared server)."; exit 1
fi
if [ "${SKIP_REDIS:-0}" != 1 ] && ! installed redis-server && port_taken 6379; then
    echo "   Port 6379 is used by a non-native Redis. Point REDIS_URL at it (own db number) and"
    echo "   re-run with SKIP_REDIS=1."; exit 1
fi
if installed nginx && ! nginx -t >/dev/null 2>&1; then
    echo "   The existing nginx config is already invalid - fix it first (nginx -t)."; exit 1
fi

echo "== 1. system packages (only what is missing; nothing is upgraded)"
need=()
for p in python3 python3-venv python3-dev build-essential curl ca-certificates xz-utils postgresql-client; do
    installed "$p" || need+=("$p")
done
installed postgresql || need+=(postgresql postgresql-contrib)
[ "${SKIP_REDIS:-0}" = 1 ] || installed redis-server || need+=(redis-server)
installed nginx || need+=(nginx)
command -v certbot >/dev/null || need+=(certbot)
if [ ${#need[@]} -gt 0 ]; then
    apt-get update
    apt-get install -y --no-upgrade "${need[@]}"
fi

echo "== 1b. private Node.js for the frontend build (system Node is not touched)"
NODE_VERSION=22.11.0
NODE_DIR="$APP/.tools/node"
if [ ! -x "$NODE_DIR/bin/node" ]; then
    arch=$(uname -m); case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
    install -d "$APP/.tools"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" -o /tmp/corr-node.tar.xz
    rm -rf "$NODE_DIR" && install -d "$NODE_DIR"
    tar -xJf /tmp/corr-node.tar.xz -C "$NODE_DIR" --strip-components=1 && rm -f /tmp/corr-node.tar.xz
fi
"$NODE_DIR/bin/node" -v

echo "== 2. service account and directories"
id correspondence >/dev/null 2>&1 || useradd --system --home /var/lib/correspondence --shell /usr/sbin/nologin correspondence
usermod -aG correspondence www-data   # nginx reads the Daphne socket
install -d -o correspondence -g correspondence -m 0750 /var/lib/correspondence /var/lib/correspondence/blobs
install -d -o root -g root -m 0700 /var/backups/correspondence
chown root:correspondence "$ENV_FILE"; chmod 0640 "$ENV_FILE"
chown root:root /etc/correspondence/migrate.env; chmod 0600 /etc/correspondence/migrate.env

echo "== 3. Redis: use the existing instance as is (own db number + key prefix)"
# Ubuntu's default config already binds to localhost with protected-mode on.
# We never edit redis.conf or restart Redis: other applications may rely on it.
[ "${SKIP_REDIS:-0}" = 1 ] || systemctl enable --now redis-server

echo "== 4. PostgreSQL: our own database + roles only (server config untouched)"
systemctl enable --now postgresql
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

echo "== 7. TLS certificate, then the nginx site"
# The site references its certificate: enabling it before the certificate
# exists would make `nginx -t` fail for EVERY site on this server. So: get
# the certificate first through a temporary HTTP-only block, then enable.
if grep -rlsE "server_name[^;]*\b${DOMAIN}\b" /etc/nginx/sites-enabled /etc/nginx/conf.d | grep -vqE '/correspondence(-acme)?$'; then
    echo "   ${DOMAIN} is already served by another nginx site - refusing to take it over."; exit 1
fi
install -d /var/www/letsencrypt
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
if [ ! -f "$CERT" ]; then
    cat > /etc/nginx/sites-available/correspondence-acme <<ACME
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 404; }
}
ACME
    ln -sf /etc/nginx/sites-available/correspondence-acme /etc/nginx/sites-enabled/correspondence-acme
    if ! nginx -t >/dev/null 2>&1; then
        rm -f /etc/nginx/sites-enabled/correspondence-acme
        echo "   temporary ACME block rejected by nginx -t - nothing changed"; exit 1
    fi
    systemctl reload nginx
    email_args=(--register-unsafely-without-email)
    [ -n "${CERT_EMAIL:-}" ] && email_args=(-m "$CERT_EMAIL")
    certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" --non-interactive --agree-tos \
        "${email_args[@]}" --deploy-hook "systemctl reload nginx" || true
    rm -f /etc/nginx/sites-enabled/correspondence-acme /etc/nginx/sites-available/correspondence-acme
    systemctl reload nginx
    if [ ! -f "$CERT" ]; then
        echo "   Could not obtain a certificate for ${DOMAIN} (does its DNS point here?)."
        echo "   Nothing else was changed; fix DNS and re-run install.sh."; exit 1
    fi
fi
sed "s/mail.example.org/${DOMAIN}/g" "$APP/deploy/nginx/correspondence.conf" > /etc/nginx/sites-available/correspondence
ln -sf /etc/nginx/sites-available/correspondence /etc/nginx/sites-enabled/correspondence
# (other sites, including 'default', are left exactly as they are)
if ! nginx -t >/dev/null 2>&1; then
    rm -f /etc/nginx/sites-enabled/correspondence
    echo "   Our nginx site failed nginx -t and was disabled again (other sites untouched):"
    nginx -t; exit 1
fi

echo "== 8. build + migrate + start"
DOMAIN="$DOMAIN" "$APP/deploy/scripts/deploy.sh"
systemctl enable --now correspondence-reminders.timer correspondence-backup.timer
echo "Done. Next: create the first administrator — see deploy/README.md §5."
