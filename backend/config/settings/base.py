"""Base settings shared by all environments.

Environment-specific settings live in dev.py / prod.py, selected via
DJANGO_SETTINGS_MODULE (config.settings.dev by default in manage.py).
"""
import base64
import hashlib
import os
import warnings
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]  # backend/


def _env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_database_url(url):
    """Minimal DATABASE_URL parser (sqlite:///... or postgres[ql]://...).

    Dev default is sqlite; postgres driver only ships with prod.txt.
    """
    if not url:
        url = f"sqlite:///{BASE_DIR / 'db.sqlite3'}"
    if url.startswith("sqlite:"):
        # sqlite:///abs/path or sqlite:///relative.db
        path = url[len("sqlite:///"):]
        # Dev/trial only: concurrent writers (two browsers at once) wait for
        # the lock instead of failing with "database is locked".
        return {"ENGINE": "django.db.backends.sqlite3", "NAME": path, "OPTIONS": {"timeout": 20}}
    if url.startswith("postgres://") or url.startswith("postgresql://"):
        from urllib.parse import urlparse

        parsed = urlparse(url)
        return {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": parsed.path.lstrip("/"),
            "USER": parsed.username or "",
            "PASSWORD": parsed.password or "",
            "HOST": parsed.hostname or "localhost",
            "PORT": str(parsed.port or 5432),
        }
    raise ValueError(f"Unsupported DATABASE_URL scheme: {url!r}")


SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "django-insecure-dev-only-secret-key")

DEBUG = False  # overridden by environment modules

ALLOWED_HOSTS = []

# --- Installed apps -------------------------------------------------------
# Note: django.contrib.auth is installed only to reuse AbstractBaseUser
# infrastructure; the accounts.User model does NOT use PermissionsMixin,
# has_perm()/has_module_perms() are disabled on it, and authorization is
# handled exclusively by apps.authorization (RBAC + organizational scope).
# daphne must precede django.contrib.staticfiles so `runserver` serves ASGI.
INSTALLED_APPS = [
    "daphne",
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "channels",
    "apps.org",
    "apps.accounts",
    "apps.authorization",
    "apps.audit",
    "apps.crypto_keys",
    "apps.messaging",
    "apps.correspondence",
    "apps.notifications",
    "apps.approvals",
    "apps.announcements",
    "apps.reports",
    "apps.archive",
    "apps.external_mail",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

# --- Channels (chat delivery over WebSockets) --------------------------------
# Dev/test default is the in-process layer; set REDIS_URL to switch to Redis
# (e.g. prod compose: redis://redis:6379/0). WS ticket jti single-use caching
# rides the default cache, which is local-memory in dev.
REDIS_URL = os.environ.get("REDIS_URL", "")
if REDIS_URL:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            # Own prefix: a shared Redis may also carry other apps' Channels traffic.
            "CONFIG": {"hosts": [REDIS_URL], "prefix": "corr"},
        }
    }
else:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels.layers.InMemoryChannelLayer",
        }
    }

DATABASES = {
    "default": parse_database_url(os.environ.get("DATABASE_URL")),
}

# Custom user model without contrib.auth Permission coupling.
AUTH_USER_MODEL = "accounts.User"

# Argon2id first, per docs/phase1 (users.password_hash is Argon2id).
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher",
]

LANGUAGE_CODE = "ar"
TIME_ZONE = "Asia/Riyadh"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- DRF -------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.accounts.authentication.JWTAuthentication",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "login_ip": "30/hour",
        "login_user": "10/hour",
        "mfa_ip": "20/hour",
    },
    "EXCEPTION_HANDLER": "apps.audit.drf.exception_handler",
}

# --- Correspondence ---------------------------------------------------------
# Client-side encrypted attachment blobs. Never served as static/media files:
# downloads go through the participant-gated /api/v1/attachments/{id}/ view.
ENCRYPTED_BLOB_ROOT = Path(os.environ.get("ENCRYPTED_BLOB_ROOT", BASE_DIR / "var" / "blobs"))
ENCRYPTED_ATTACHMENT_MAX_BYTES = int(os.environ.get("ENCRYPTED_ATTACHMENT_MAX_BYTES", 25 * 1024 * 1024))
# External (Internet) mail — off unless EXTERNAL_MAIL_DOMAIN is set. Inbound
# arrives through the local Postfix; outbound leaves through Brevo's API.
EXTERNAL_MAIL_DOMAIN = os.environ.get("EXTERNAL_MAIL_DOMAIN", "")
BREVO_API_KEY = os.environ.get("BREVO_API_KEY", "")
BREVO_API_BASE = os.environ.get("BREVO_API_BASE", "https://api.brevo.com")
EXTERNAL_MAIL_MAX_BYTES = int(os.environ.get("EXTERNAL_MAIL_MAX_BYTES", 25 * 1024 * 1024))
EXTERNAL_MAIL_MAX_SEND_BYTES = int(os.environ.get("EXTERNAL_MAIL_MAX_SEND_BYTES", 10 * 1024 * 1024))
EXTERNAL_MAIL_DAILY_LIMIT = int(os.environ.get("EXTERNAL_MAIL_DAILY_LIMIT", 50))
CLAMD_SOCKET = os.environ.get("CLAMD_SOCKET", "")  # e.g. /run/clamav/clamd.ctl; empty = no virus scan
# Encrypted recovery bundle (keys + MLS state + locally decrypted mail/chat).
KEY_BACKUP_MAX_BYTES = int(os.environ.get("KEY_BACKUP_MAX_BYTES", 25 * 1024 * 1024))
CORRESPONDENCE_MAX_ATTACHMENTS = 20
# Decided default (AGENTS.md): BCC off until explicitly requested.
CORRESPONDENCE_BCC_ENABLED = os.environ.get("CORRESPONDENCE_BCC_ENABLED", "0") == "1"

# Announcements: one MLS group per announcement. Handshake size grows ~335 B
# per member (1000 members -> 335 KB welcome), so the audience is capped.
ANNOUNCEMENT_MAX_RECIPIENTS = int(os.environ.get("ANNOUNCEMENT_MAX_RECIPIENTS", 1000))

# Web Push (desktop/phone notifications while the site is closed). The VAPID
# key is a base64url PKCS#8 EC P-256 private key (gen-secrets.sh prints one);
# unset in production = push disabled, in DEBUG a dev key is generated.
WEB_PUSH_VAPID_PRIVATE_KEY = os.environ.get("WEB_PUSH_VAPID_PRIVATE_KEY", "")
WEB_PUSH_SUBJECT = os.environ.get("WEB_PUSH_SUBJECT", "mailto:it@example.org")

# --- Auth / crypto configuration -------------------------------------------
AUTH_JWT_ALGORITHM = "HS256"
AUTH_ACCESS_TOKEN_TTL_SECONDS = 15 * 60        # 15 minutes
AUTH_MFA_TOKEN_TTL_SECONDS = 2 * 60            # <= 2 minutes (login intent)
AUTH_REFRESH_TOKEN_TTL_DAYS = 30
AUTH_REFRESH_COOKIE_NAME = "refresh_token"
AUTH_REFRESH_COOKIE_PATH = "/api/v1/auth/"
AUTH_MFA_TOTP_VALID_WINDOW = 1                 # pyotp valid_window

# HS256 signing key for access tokens / MFA login-intent tokens.
AUTH_JWT_SECRET = os.environ.get("AUTH_JWT_SECRET")
if not AUTH_JWT_SECRET:
    AUTH_JWT_SECRET = "dev-only-jwt-secret-do-not-use-in-production"
    warnings.warn(
        "AUTH_JWT_SECRET not set; using an insecure development default. "
        "Set AUTH_JWT_SECRET in the environment for any non-dev deployment.",
        stacklevel=2,
    )

# Server-side key wrapping users' TOTP secrets (KMS-managed in production).
# Dev default is deterministic so dev/test environments can read each other's
# data; it MUST be replaced via AUTH_FERNET_KEY outside dev.
AUTH_FERNET_KEY = os.environ.get("AUTH_FERNET_KEY")
if not AUTH_FERNET_KEY:
    AUTH_FERNET_KEY = base64.urlsafe_b64encode(
        hashlib.sha256(b"correspondence-dev-mfa-key-do-not-use-in-prod").digest()
    ).decode()
    warnings.warn(
        "AUTH_FERNET_KEY not set; using an insecure development default. "
        "Set AUTH_FERNET_KEY in the environment for any non-dev deployment.",
        stacklevel=2,
    )

TOTP_ISSUER_NAME = os.environ.get("TOTP_ISSUER_NAME", "مجموعة المعاهد")

# CORS (frontend dev server talks to the API cross-origin in dev).
CORS_ALLOW_ALL_ORIGINS = False
# The refresh-token cookie must be sent/received cross-origin, so responses
# must carry Access-Control-Allow-Credentials (and a specific origin, never '*').
CORS_ALLOW_CREDENTIALS = True
# Encrypted backup uploads carry their metadata in headers (body = ciphertext).
from corsheaders.defaults import default_headers  # noqa: E402

CORS_ALLOW_HEADERS = (
    *default_headers,
    "x-backup-device",
    "x-backup-key-id",
    "x-backup-iv",
    "x-backup-signature",
)
