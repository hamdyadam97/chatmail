#!/usr/bin/env bash
# Build + migrate + restart. Used by install.sh and for every update:
#   cd /opt/correspondence && sudo git pull && sudo DOMAIN=mail.example.org deploy/scripts/deploy.sh
set -euo pipefail

: "${DOMAIN:?set DOMAIN}"
APP=/opt/correspondence
ENV_FILE=/etc/correspondence/correspondence.env
PY="$APP/.venv/bin/python"
# Private Node.js from install.sh (system Node, if any, belongs to other apps).
[ -x "$APP/.tools/node/bin/node" ] && export PATH="$APP/.tools/node/bin:$PATH"
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

set -a; . "$ENV_FILE"; . /etc/correspondence/migrate.env; set +a

echo "== backend dependencies"
"$APP/.venv/bin/pip" install -q -r "$APP/backend/requirements/prod.txt"

# Tests belong in CI before a release reaches the server. RUN_TESTS=1 runs
# them here too, in a separate venv (the production venv stays lean).
if [ "${RUN_TESTS:-0}" = 1 ]; then
    echo "== backend tests (refuse to deploy a red build)"
    [ -d "$APP/.venv-test" ] || python3 -m venv "$APP/.venv-test"
    "$APP/.venv-test/bin/pip" install -q -r "$APP/backend/requirements/dev.txt"
    ( cd "$APP" && env -i PATH="$PATH" HOME=/root DJANGO_SETTINGS_MODULE=config.settings.dev \
        "$APP/.venv-test/bin/python" -m pytest backend/tests -q -p no:warnings )
fi

echo "== migrations as the OWNER role, then re-apply runtime grants"
( cd "$APP/backend" && DATABASE_URL="$MIGRATE_DATABASE_URL" "$PY" manage.py migrate --noinput )
psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$APP/deploy/postgres/grants.sql"

echo "== frontend build (same-origin API)"
( cd "$APP/frontend" && npm ci --no-audit --no-fund \
  && VITE_API_BASE_URL="https://${DOMAIN}/api/v1" npm run build )

echo "== systemd units (ours only, refreshed on every update)"
install -m 0644 "$APP"/deploy/systemd/correspondence-*.service "$APP"/deploy/systemd/correspondence-*.timer /etc/systemd/system/
systemctl daemon-reload

echo "== nginx site (ours only, refreshed from the template; old copy restored if invalid)"
SITE=/etc/nginx/sites-available/correspondence
if [ -f "$SITE" ]; then
    cp "$SITE" "$SITE.prev"
    sed "s/mail.example.org/${DOMAIN}/g" "$APP/deploy/nginx/correspondence.conf" > "$SITE"
    if ! nginx -t >/dev/null 2>&1; then
        mv "$SITE.prev" "$SITE"
        echo "   new site config failed nginx -t - previous one restored (nothing else touched)"
        nginx -t
    else
        rm -f "$SITE.prev"
    fi
fi

echo "== restart (our service only; nginx is reloaded gracefully, never restarted)"
systemctl restart correspondence-web
if ! nginx -t; then
    # Never leave the server in a state where nobody can reload nginx: if our
    # site is the culprit, disable it again so the other sites stay manageable.
    rm -f /etc/nginx/sites-enabled/correspondence
    nginx -t >/dev/null 2>&1 && echo "our nginx site was invalid and has been disabled - other sites untouched"
    echo "NOT reloading nginx"; exit 1
fi
systemctl reload nginx

echo "== post-deploy checks"
( cd "$APP/backend" && runuser -u correspondence -- "$PY" manage.py check --deploy --fail-level ERROR )
( cd "$APP/backend" && runuser -u correspondence -- "$PY" manage.py verify_integrity --skip-blobs )
for i in 1 2 3 4 5 6 7 8 9 10; do
    code=$(curl -sk -o /dev/null -w '%{http_code}' "https://${DOMAIN}/api/v1/users/me/" || true)
    [ "$code" = 401 ] && break; sleep 1
done
[ "$code" = 401 ] && echo "API reachable through nginx (401 without a token, as expected)" \
                  || { echo "API not reachable through nginx (got $code)"; exit 1; }
