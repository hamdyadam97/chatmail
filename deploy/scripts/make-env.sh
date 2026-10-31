#!/usr/bin/env bash
# Create /etc/correspondence/{correspondence.env,migrate.env,db-passwords.env}
# with freshly generated secrets — written straight to root-only files and
# never printed (nothing to copy by hand, nothing to leak into chat or logs).
#
#   sudo DOMAIN=mail.example.org CERT_EMAIL=it@example.org bash deploy/scripts/make-env.sh
#
# Refuses to overwrite existing files: regenerating CONTENT_ENCRYPTION_KEY or
# the database passwords on a live install would break it.
set -euo pipefail
: "${DOMAIN:?set DOMAIN}"
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
APP="$(cd "$(dirname "$0")/../.." && pwd)"
DIR=/etc/correspondence
for f in correspondence.env migrate.env db-passwords.env; do
    [ -e "$DIR/$f" ] && { echo "$DIR/$f already exists - not touching it"; exit 1; }
done
python3 -c 'import cryptography' 2>/dev/null || { echo "python3-cryptography missing: apt-get install -y python3-cryptography"; exit 1; }

install -d -o root -g root -m 0755 "$DIR"
umask 077
DOMAIN="$DOMAIN" CERT_EMAIL="${CERT_EMAIL:-it@${DOMAIN}}" APP="$APP" DIR="$DIR" python3 - <<'PY'
import base64, os, re, secrets
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

env = os.environ
domain, app, d = env["DOMAIN"], env["APP"], env["DIR"]
owner_pw, app_pw = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
vapid = ec.generate_private_key(ec.SECP256R1()).private_bytes(
    serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
values = {
    "ALLOWED_HOSTS": domain,
    "CORS_ALLOWED_ORIGINS": f"https://{domain}",
    "DATABASE_URL": f"postgresql://corr_app:{app_pw}@localhost:5432/correspondence",
    "DJANGO_SECRET_KEY": secrets.token_urlsafe(50),
    "AUTH_JWT_SECRET": secrets.token_urlsafe(48),
    "AUTH_FERNET_KEY": base64.urlsafe_b64encode(os.urandom(32)).decode(),
    "CONTENT_ENCRYPTION_KEY": base64.b64encode(os.urandom(32)).decode(),
    "WEB_PUSH_VAPID_PRIVATE_KEY": base64.urlsafe_b64encode(vapid).rstrip(b"=").decode(),
    "WEB_PUSH_SUBJECT": f"mailto:{env['CERT_EMAIL']}",
}
text = open(f"{app}/deploy/env.example", encoding="utf-8").read()
for key, value in values.items():
    text, n = re.subn(rf"^{key}=.*$", f"{key}={value}", text, count=1, flags=re.M)
    assert n == 1, key
assert "CHANGE_ME" not in "\n".join(l for l in text.splitlines() if not l.startswith("#"))
open(f"{d}/correspondence.env", "w", encoding="utf-8").write(text)
open(f"{d}/migrate.env", "w").write(
    f"MIGRATE_DATABASE_URL=postgresql://corr_owner:{owner_pw}@localhost:5432/correspondence\n")
open(f"{d}/db-passwords.env", "w").write(f"CORR_OWNER_PASSWORD={owner_pw}\nCORR_APP_PASSWORD={app_pw}\n")
PY
chmod 0600 "$DIR/migrate.env" "$DIR/db-passwords.env"
chmod 0640 "$DIR/correspondence.env"   # group set to the service account by install.sh
echo "written: $DIR/correspondence.env, migrate.env, db-passwords.env (secrets not shown)"
echo "IMPORTANT: keep an offline copy of $DIR (with your backups key). Losing"
echo "CONTENT_ENCRYPTION_KEY loses every stored message and attachment."
