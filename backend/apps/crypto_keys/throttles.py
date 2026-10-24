"""Per-endpoint rate limits (docs/phase1/03 + spike §8.3 reuse concerns).

Rates are pinned as class attributes (DRF honours a class-level `rate`
without requiring an entry in settings DEFAULT_THROTTLE_RATES), so this app
does not need config/settings changes for throttling.
"""
from rest_framework.throttling import SimpleRateThrottle

from apps.crypto_keys import services


class KeyUploadThrottle(SimpleRateThrottle):
    """Per-device upload budget (default 10/min)."""

    scope = "crypto_key_upload"
    rate = "10/min"

    def get_cache_key(self, request, view):
        session = services.request_session(request)
        device_id = str(session.device_id) if session is not None and session.device_id else "none"
        ident = f"{request.user.pk}:{device_id}"
        return self.cache_format % {"scope": self.scope, "ident": ident}


class KeyQueryThrottle(SimpleRateThrottle):
    """Directory lookups are public-by-design but rate-limited per user."""

    scope = "crypto_key_query"
    rate = "60/min"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": str(request.user.pk)}


class KeyClaimThrottle(SimpleRateThrottle):
    """Per-user claim budget."""

    scope = "crypto_key_claim"
    rate = "30/min"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": str(request.user.pk)}


class KeyBackupThrottle(SimpleRateThrottle):
    """Backups are re-uploaded after local changes (debounced); this caps abuse."""

    scope = "crypto_key_backup"
    rate = "60/hour"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": str(request.user.pk)}
