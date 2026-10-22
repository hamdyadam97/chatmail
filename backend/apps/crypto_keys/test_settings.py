"""Settings shim for running the crypto_keys suite BEFORE the integrator adds
"apps.crypto_keys" to INSTALLED_APPS in config/settings (config/ is owned by
the integrator during this slice).

Usage (pre-integration):
    .venv/Scripts/python.exe -m pytest backend/tests -q --ds apps.crypto_keys.test_settings

After the integrator adds "apps.crypto_keys" to INSTALLED_APPS, the canonical
command works unchanged:
    .venv/Scripts/python.exe -m pytest backend/tests -q
"""
from config.settings.dev import *  # noqa: F401,F403

if "apps.crypto_keys" not in INSTALLED_APPS:
    INSTALLED_APPS = [*INSTALLED_APPS, "apps.crypto_keys"]

# Pre-integration routing: mirrors config/urls.py + the crypto mount
# (see apps/crypto_keys/test_urls.py). Removed once config/urls.py is wired.
ROOT_URLCONF = "apps.crypto_keys.test_urls"
