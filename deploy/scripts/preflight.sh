#!/usr/bin/env bash
# READ-ONLY inventory of a server before installing the correspondence system
# next to other applications. Changes nothing; safe to run anywhere.
#
#   sudo DOMAIN=mail.example.org bash deploy/scripts/preflight.sh
#
# Paste the whole output back; lines starting with "!!" need a decision.
set -uo pipefail
DOMAIN="${DOMAIN:-}"
warn() { echo "!! $*"; }
ok() { echo "ok $*"; }
have() { command -v "$1" >/dev/null 2>&1; }
pkg() { dpkg-query -W -f='${Status} ${Version}' "$1" 2>/dev/null | grep -q "install ok installed" && dpkg-query -W -f='${Version}' "$1"; }

echo "== system"
. /etc/os-release 2>/dev/null && echo "os: $PRETTY_NAME"
case "${VERSION_ID:-}" in
  24.04|22.04) ok "Ubuntu ${VERSION_ID} supported" ;;
  *) warn "untested OS version (${VERSION_ID:-unknown}); 24.04/22.04 expected" ;;
esac
echo "cpu: $(nproc) cores · mem: $(free -m | awk '/Mem:/{print $2" MB total, "$7" MB available"}')"
echo "disk /opt: $(df -h /opt | awk 'NR==2{print $4" free of "$2}') · /var: $(df -h /var | awk 'NR==2{print $4" free"}')"
python3 -c 'import sys; v=sys.version_info; print(f"python3: {v.major}.{v.minor}"); sys.exit(0 if v>=(3,10) else 1)' \
  && ok "python ≥ 3.10" || warn "python3 < 3.10 or missing"
if have node; then echo "node (system): $(node -v) — left untouched; we use a private copy if needed"; else echo "node: not installed (we use a private copy under /opt/correspondence)"; fi

echo; echo "== who listens on the ports we need"
have ss && ss -ltnpH 2>/dev/null | awk '{print $4, $6}' | grep -E ':(80|443|5432|6379)\b' || echo "(none of 80/443/5432/6379 in use)"

echo; echo "== web server"
if pkg nginx >/dev/null; then
  echo "nginx package: $(pkg nginx) · $(nginx -v 2>&1)"
  nginx -t >/dev/null 2>&1 && ok "current nginx config is valid" || warn "nginx -t ALREADY fails before we change anything — fix that first"
  echo "enabled sites:"; ls -1 /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | sed 's/^/   /'
  grep -rhoE 'map\s+\$http_upgrade\s+\$\w+' /etc/nginx 2>/dev/null | sort -u | sed 's/^/   existing: /'
  if [ -n "$DOMAIN" ] && grep -rqs "server_name[^;]*\b${DOMAIN}\b" /etc/nginx/sites-enabled /etc/nginx/conf.d; then
    warn "$DOMAIN is already served by an existing nginx site"
  fi
else
  echo "nginx: not installed"
fi
for other in apache2 caddy httpd lighttpd; do
  pkg "$other" >/dev/null && warn "$other is installed — who owns ports 80/443 decides how we plug in"
done
if have docker; then
  echo "docker containers publishing ports:"
  docker ps --format '   {{.Names}}  {{.Ports}}' 2>/dev/null | grep -E '0\.0\.0\.0|:::|\[::\]' || echo "   (none)"
fi

echo; echo "== PostgreSQL"
if pkg postgresql >/dev/null || pkg postgresql-16 >/dev/null || pkg postgresql-14 >/dev/null; then
  echo "native postgres: $(sudo -u postgres psql -tAc 'select version()' 2>/dev/null | cut -c1-40)"
  sudo -u postgres psql -tAc "select datname from pg_database where datname='correspondence'" 2>/dev/null | grep -q . \
    && warn "a database named 'correspondence' already exists" || ok "no 'correspondence' database yet"
  sudo -u postgres psql -tAc "select rolname from pg_roles where rolname in ('corr_owner','corr_app')" 2>/dev/null | grep -q . \
    && warn "roles corr_owner/corr_app already exist" || ok "roles corr_owner/corr_app free"
else
  echo "native postgres: not installed"
  ss -ltnH 2>/dev/null | grep -q ':5432\b' && warn "port 5432 is taken by something else (docker?) — native install would clash"
fi

echo; echo "== Redis"
if pkg redis-server >/dev/null; then
  echo "redis: $(pkg redis-server)"
  if have redis-cli; then
    redis-cli INFO keyspace 2>/dev/null | grep -E '^db[0-9]+' | sed 's/^/   in use: /' || true
    redis-cli -n 5 DBSIZE 2>/dev/null | awk '{ if ($1 > 0) print "!! redis db 5 is not empty — pick another REDIS_URL db number"; else print "ok redis db 5 is free" }'
  fi
else
  echo "redis: not installed"
  ss -ltnH 2>/dev/null | grep -q ':6379\b' && warn "port 6379 is taken by something else (docker?)"
fi

echo; echo "== TLS"
if have certbot; then echo "certbot: $(certbot --version 2>&1)"; else echo "certbot: not installed"; fi
[ -n "$DOMAIN" ] && [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ] && ok "certificate for $DOMAIN exists"

echo; echo "== DNS"
if [ -n "$DOMAIN" ]; then
  resolved=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)
  mine=$(curl -s4 --max-time 5 https://ifconfig.me || true)
  echo "$DOMAIN → ${resolved:-unresolved} · this server's public IP: ${mine:-unknown}"
  [ -n "$resolved" ] && [ "$resolved" = "$mine" ] && ok "DNS points here" || warn "DNS for $DOMAIN does not point to this server (yet)"
else
  warn "DOMAIN not given — re-run with DOMAIN=your.subdomain"
fi

echo; echo "== outbound (Web Push)"
curl -s -o /dev/null --max-time 5 -w '%{http_code}' https://fcm.googleapis.com/ >/dev/null && ok "outbound HTTPS works" || warn "no outbound HTTPS (desktop notifications will not be delivered)"

echo; echo "== existing install"
[ -d /opt/correspondence ] && warn "/opt/correspondence already exists" || ok "/opt/correspondence free"
systemctl list-unit-files 'correspondence-*' --no-legend 2>/dev/null | grep -q . && warn "correspondence-* systemd units already exist" || ok "no correspondence-* units"
echo; echo "preflight done — nothing was changed."
