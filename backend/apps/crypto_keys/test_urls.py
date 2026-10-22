"""Standalone urlconf mirroring config/urls.py PLUS the crypto mount.

Used only by apps.crypto_keys.test_settings so the suite runs before the
integrator wires config/urls.py. The production wiring the integrator must
add (single line):

    path("api/v1/crypto/", include("apps.crypto_keys.api.urls"))

"""
from django.urls import include, path

urlpatterns = [
    path("api/v1/auth/", include("apps.accounts.api.urls")),
    path("api/v1/users/", include("apps.accounts.api.user_urls")),
    path("api/v1/org/", include("apps.org.api.urls")),
    path("api/v1/roles/", include("apps.authorization.api.urls")),
    path("api/v1/conversations/", include("apps.messaging.api.urls")),
    path("api/v1/crypto/", include("apps.crypto_keys.api.urls")),
]
