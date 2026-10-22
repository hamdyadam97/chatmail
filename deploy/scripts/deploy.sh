#!/usr/bin/env bash
# Build + migrate + restart. Used by install.sh and for every update:
#   cd /opt/correspondence && sudo git pull && sudo DOMAIN=mail.example.org deploy/scripts/deploy.sh
set -euo pipefail

: "${DOMAIN:?set DOMAIN}"
APP=/opt/correspondence
ENV_FILE=/etc/correspondence/correspondence.env
PY="$APP/.venv/bin/python"
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

echo "== restart"
systemctl restart correspondence-web
nginx -t && systemctl reload nginx

echo "== post-deploy checks"
( cd "$APP/backend" && runuser -u correspondence -- "$PY" manage.py check --deploy --fail-level ERROR )
( cd "$APP/backend" && runuser -u correspondence -- "$PY" manage.py verify_integrity --skip-blobs )
for i in 1 2 3 4 5 6 7 8 9 10; do
    code=$(curl -sk -o /dev/null -w '%{http_code}' "https://${DOMAIN}/api/v1/users/me/" || true)
    [ "$code" = 401 ] && break; sleep 1
done
[ "$code" = 401 ] && echo "API reachable through nginx (401 without a token, as expected)" \
                  || { echo "API not reachable through nginx (got $code)"; exit 1; }
