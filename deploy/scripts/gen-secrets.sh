#!/usr/bin/env bash
# Print fresh production secrets in env-file format (paste into
# /etc/correspondence/correspondence.env). Nothing is written to disk.
set -euo pipefail
py=/opt/correspondence/.venv/bin/python
[ -x "$py" ] || py=python3
"$py" - <<'PY'
import base64, os, secrets
print(f"DJANGO_SECRET_KEY={secrets.token_urlsafe(50)}")
print(f"AUTH_JWT_SECRET={secrets.token_urlsafe(48)}")
print(f"AUTH_FERNET_KEY={base64.urlsafe_b64encode(os.urandom(32)).decode()}")
print(f"CRYPTO_LOG_SIGN_SEED={base64.b64encode(os.urandom(32)).decode()}")
try:  # Web Push (VAPID) signing key — P-256, PKCS#8 DER, base64url
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    der = ec.generate_private_key(ec.SECP256R1()).private_bytes(
        serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    print(f"WEB_PUSH_VAPID_PRIVATE_KEY={base64.urlsafe_b64encode(der).rstrip(b'=').decode()}")
except ImportError:
    print("# WEB_PUSH_VAPID_PRIVATE_KEY: run again after install.sh (needs the app venv)")
print(f"# database passwords")
print(f"CORR_OWNER_PASSWORD={secrets.token_urlsafe(24)}")
print(f"CORR_APP_PASSWORD={secrets.token_urlsafe(24)}")
PY
