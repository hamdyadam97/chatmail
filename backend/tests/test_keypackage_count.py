"""keys/count/: lets a client top its KeyPackage pool up only when needed
(uploading on every page load hit the per-device upload rate limit)."""
import base64
import hashlib
import os

import pytest

from apps.crypto_keys.models import DeviceKeyBundle

from .conftest import CRYPTO_BASE, login_and_get_access

pytestmark = pytest.mark.django_db


def _upload(api_client, device_id):
    kp = os.urandom(64)
    return api_client.post(
        f"{CRYPTO_BASE}/keys/upload/",
        {
            "keypackage": base64.b64encode(kp).decode(),
            "keypackage_hash": base64.b64encode(hashlib.sha256(kp).digest()).decode(),
            "device_id": str(device_id),
        },
        format="json",
    )


def test_counts_only_unconsumed_packages_of_my_device(api_client, bootstrapped_user_factory, user_factory):
    user, _, _ = bootstrapped_user_factory("kpc_owner")
    device = user.trusted_devices.filter(identity_sign_pub__isnull=False).get()
    url = f"{CRYPTO_BASE}/keys/count/?device_id={device.id}"
    assert api_client.get(url).json()["available"] == 0
    for _ in range(3):
        assert _upload(api_client, device.id).status_code == 201
    assert api_client.get(url).json()["available"] == 3
    DeviceKeyBundle.objects.filter(device=device).first().__class__.objects.filter(
        id=DeviceKeyBundle.objects.filter(device=device).first().id
    ).update(consumed_at="2026-01-01T00:00:00Z")
    assert api_client.get(url).json()["available"] == 2

    user_factory("kpc_other")
    login_and_get_access(api_client, "kpc_other")
    assert api_client.get(url).status_code == 403  # not my device
