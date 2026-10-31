"""Production settings: DEBUG off, postgres via DATABASE_URL, secure cookies."""
import os

from .base import *  # noqa: F401,F403

DEBUG = False

ALLOWED_HOSTS = [h.strip() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()]
if not ALLOWED_HOSTS:
    raise ValueError("ALLOWED_HOSTS must be set in production")

CORS_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()
]
if not CORS_ALLOWED_ORIGINS:
    raise ValueError("CORS_ALLOWED_ORIGINS must be set in production")

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if not DATABASE_URL.startswith(("postgres://", "postgresql://")):
    raise ValueError("DATABASE_URL must point at PostgreSQL in production")

SECURE_SSL_REDIRECT = os.environ.get("SECURE_SSL_REDIRECT", "true").lower() == "true"
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

# Refresh-token cookie: Secure + Strict SameSite in production.
AUTH_REFRESH_COOKIE_SECURE = True

# New-browser logins need an administrator's code (set "0" to turn off).
LOGIN_NEW_DEVICE_APPROVAL = os.environ.get("LOGIN_NEW_DEVICE_APPROVAL", "1") == "1"

# --- Secrets: fail fast instead of silently using the dev defaults -----------
# base.py only *warns* when these are missing (convenient in dev). In
# production a missing secret must stop the process at startup.
_REQUIRED_SECRETS = (
    "DJANGO_SECRET_KEY",
    "AUTH_JWT_SECRET",       # access-token signing
    "AUTH_FERNET_KEY",       # wraps TOTP secrets (login only, never E2EE)
    "CONTENT_ENCRYPTION_KEY",  # mail/chat content at rest (losing it loses all mail)
    "REDIS_URL",             # channel layer + shared cache
    "ENCRYPTED_BLOB_ROOT",   # encrypted attachment storage
)
_missing = [name for name in _REQUIRED_SECRETS if not os.environ.get(name)]
if _missing:
    raise ValueError(f"Missing required production settings: {', '.join(_missing)}")

# --- Shared cache --------------------------------------------------------------
# WS tickets and throttle counters must be visible to every worker process;
# the default per-process LocMemCache would break both behind >1 process.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": REDIS_URL,  # noqa: F405 (from base)
        "KEY_PREFIX": "corr",
    }
}

# --- Behind nginx (TLS terminated there) ------------------------------------------
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_HSTS_SECONDS = int(os.environ.get("SECURE_HSTS_SECONDS", 31536000))
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "no-referrer"
X_FRAME_OPTIONS = "DENY"
DATA_UPLOAD_MAX_MEMORY_SIZE = 4 * 1024 * 1024  # JSON bodies (MLS handshakes ≤ 1 MB, base64)

# --- Logging: stdout → journald. Requests are logged by path/status only;
# bodies (ciphertext or otherwise) never reach a log handler (SEC-10).
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "%(levelname)s %(name)s %(message)s"}},
    "handlers": {"stdout": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "root": {"handlers": ["stdout"], "level": os.environ.get("LOG_LEVEL", "INFO")},
    "loggers": {
        "django.request": {"handlers": ["stdout"], "level": "WARNING", "propagate": False},
        "django.security": {"handlers": ["stdout"], "level": "WARNING", "propagate": False},
    },
}
