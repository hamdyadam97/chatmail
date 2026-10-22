"""URL routes for /api/v1/crypto/ (mounted via
path("api/v1/crypto/", include("apps.crypto_keys.api.urls")) in config/urls.py).
"""
from django.urls import path

from . import views

urlpatterns = [
    path("identity/", views.IdentityBootstrapView.as_view(), name="crypto-identity"),
    path("devices/", views.DeviceListView.as_view(), name="crypto-devices"),
    path("devices/register/", views.DeviceRegisterView.as_view(), name="crypto-device-register"),
    path("devices/<uuid:device_id>/approve/", views.DeviceApproveView.as_view(), name="crypto-device-approve"),
    path("devices/<uuid:device_id>/revoke/", views.DeviceRevokeView.as_view(), name="crypto-device-revoke"),
    path("keys/upload/", views.KeyUploadView.as_view(), name="crypto-keys-upload"),
    path("keys/query/", views.KeyQueryView.as_view(), name="crypto-keys-query"),
    path("keys/claim/", views.KeyClaimView.as_view(), name="crypto-keys-claim"),
    path("transparency/self/", views.TransparencySelfView.as_view(), name="crypto-transparency-self"),
    path("transparency/log-key/", views.TransparencyLogKeyView.as_view(), name="crypto-transparency-log-key"),
]
