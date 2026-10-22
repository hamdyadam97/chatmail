"""Login throttling: per-IP and per-username rates."""
from hashlib import md5

from rest_framework.throttling import AnonRateThrottle, SimpleRateThrottle


class LoginIPThrottle(AnonRateThrottle):
    scope = "login_ip"


class LoginUsernameThrottle(SimpleRateThrottle):
    """Per-username login throttle (applies to anonymous attempts)."""

    scope = "login_user"

    def get_cache_key(self, request, view):
        username = (request.data or {}).get("username", "")
        if not username:
            return None  # nothing identifiable; the IP throttle still applies
        if request.user and request.user.is_authenticated:
            ident = str(request.user.id)
        else:
            ident = md5(str(username).lower().encode()).hexdigest()
        return self.cache_format % {"scope": self.scope, "ident": ident}


class MFAVerifyIPThrottle(AnonRateThrottle):
    scope = "mfa_ip"
