"""DRF authentication: Bearer JWT access tokens."""
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed

from .models import User
from .tokens import TokenError, decode_access_token


class JWTAuthentication(BaseAuthentication):
    keyword = "Bearer"

    def authenticate_header(self, request):
        # Ensures DRF returns 401 (not 403) for AuthenticationFailed.
        return self.keyword

    def authenticate(self, request):
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header.startswith(f"{self.keyword} "):
            return None
        token = header[len(self.keyword) + 1 :].strip()
        if not token:
            return None
        try:
            payload = decode_access_token(token)
        except TokenError:
            raise AuthenticationFailed("Invalid or expired access token.")
        try:
            user = User.objects.get(id=payload["sub"])
        except (User.DoesNotExist, KeyError):
            raise AuthenticationFailed("Unknown user.")
        if not user.is_active:
            raise AuthenticationFailed("User account is inactive.")
        return (user, payload)
