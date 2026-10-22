"""App configuration: crypto_keys — E2EE identity, devices, key bundles
and key-transparency log (docs/phase1/03-key-management.md, 04-erd.md §4.2 و)."""
from django.apps import AppConfig


class CryptoKeysConfig(AppConfig):
    name = "apps.crypto_keys"
    label = "crypto_keys"
    verbose_name = "Crypto keys & transparency"
