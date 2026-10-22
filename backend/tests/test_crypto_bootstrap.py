"""Identity bootstrap contract (POST /api/v1/crypto/identity/):

201 + identity + first ACTIVE trusted device on success; 400 on a bad device
attestation signature or malformed key material; 409 on double bootstrap or
sign_pub reuse; every success appends a signed transparency event and an
audit row.
"""
import hashlib

import pytest

from apps.accounts.models import TrustedDevice
from apps.audit.models import AuditLog
from apps.crypto_keys.models import KeyTransparencyEvent, UserCryptoIdentity

from .conftest import (
    CRYPTO_BASE,
    bootstrap_payload,
    b64e,
    login_and_get_access,
    make_device_keys,
    new_signing_key,
)

pytestmark = pytest.mark.django_db


def test_bootstrap_creates_identity_and_first_active_device(api_client, user_factory):
    user = user_factory("alice")
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    login_and_get_access(api_client, "alice")

    resp = api_client.post(
        f"{CRYPTO_BASE}/identity/",
        bootstrap_payload(user, identity_pub, keys, label="Chrome — المكتب"),
        format="json",
    )

    assert resp.status_code == 201, resp.content
    body = resp.json()
    assert body["algorithm"] == "ed25519+x25519"
    assert body["identity_pub"] == b64e(identity_pub)
    assert body["device_status"] == "active"

    identity = UserCryptoIdentity.objects.get(user=user)
    assert bytes(identity.identity_sign_pub) == identity_pub
    assert bytes(identity.bootstrap_signature) == keys.bootstrap_signature(identity_pub)

    device = TrustedDevice.objects.get(user=user, identity_sign_pub=keys.sign_pub)
    assert body["device_id"] == str(device.id)
    assert device.status == "active"
    assert device.device_label == "Chrome — المكتب"
    assert bytes(device.kem_pub) == keys.kem_pub
    # one physical device == one row: bootstrap binds to the session's device
    assert user.trusted_devices.count() == 1

    event = KeyTransparencyEvent.objects.get(user=user, event_type="identity_created")
    assert event.payload["identity_sign_pub_hash"] == hashlib.sha256(identity_pub).hexdigest()
    assert event.payload["device_sign_pub_hash"] == hashlib.sha256(keys.sign_pub).hexdigest()

    assert AuditLog.objects.filter(actor=user, action="key_event").exists()


def test_bootstrap_rejects_bad_device_signature(api_client, user_factory):
    user = user_factory("alice")
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    login_and_get_access(api_client, "alice")

    payload = bootstrap_payload(user, identity_pub, keys)
    payload["device"]["sig"] = b64e(b"\x00" * 64)  # not a valid signature at all
    resp = api_client.post(f"{CRYPTO_BASE}/identity/", payload, format="json")

    assert resp.status_code == 400, resp.content
    assert not UserCryptoIdentity.objects.filter(user=user).exists()
    assert not KeyTransparencyEvent.objects.filter(user=user).exists()


def test_bootstrap_rejects_signature_over_wrong_message(api_client, user_factory):
    """A signature over anything but identity_pub||sign_pub||kem_pub||user.id
    bytes must not bootstrap — this is the A3 resistance anchor."""
    user = user_factory("alice")
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    login_and_get_access(api_client, "alice")

    payload = bootstrap_payload(user, identity_pub, keys)
    other_user = user_factory("mallory")
    payload["device"]["sig"] = b64e(keys.attestation_signature(identity_pub, other_user.id.bytes))
    resp = api_client.post(f"{CRYPTO_BASE}/identity/", payload, format="json")

    assert resp.status_code == 400, resp.content
    assert not UserCryptoIdentity.objects.filter(user=user).exists()


def test_bootstrap_conflicts_on_second_call(api_client, user_factory):
    user = user_factory("alice")
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    login_and_get_access(api_client, "alice")
    first = api_client.post(
        f"{CRYPTO_BASE}/identity/", bootstrap_payload(user, identity_pub, keys), format="json"
    )
    assert first.status_code == 201

    _, identity_pub_2 = new_signing_key()
    keys_2 = make_device_keys()
    second = api_client.post(
        f"{CRYPTO_BASE}/identity/",
        bootstrap_payload(user, identity_pub_2, keys_2, label="second"),
        format="json",
    )
    assert second.status_code == 409, second.content
    assert UserCryptoIdentity.objects.filter(user=user).count() == 1
    assert user.trusted_devices.count() == 1


def test_bootstrap_rejects_sign_pub_already_registered(api_client, user_factory):
    """One device identity can never be registered as two devices (globally)."""
    user_a = user_factory("alice")
    _, identity_pub_a = new_signing_key()
    keys = make_device_keys()
    login_and_get_access(api_client, "alice")
    resp = api_client.post(
        f"{CRYPTO_BASE}/identity/", bootstrap_payload(user_a, identity_pub_a, keys), format="json"
    )
    assert resp.status_code == 201
    api_client.credentials()  # log out alice

    user_b = user_factory("bob")
    _, identity_pub_b = new_signing_key()
    login_and_get_access(api_client, "bob")
    resp = api_client.post(
        f"{CRYPTO_BASE}/identity/",
        bootstrap_payload(user_b, identity_pub_b, keys, label="stolen"),
        format="json",
    )
    assert resp.status_code == 409, resp.content
    assert not UserCryptoIdentity.objects.filter(user=user_b).exists()


def test_bootstrap_rejects_malformed_key_material(api_client, user_factory):
    user = user_factory("alice")
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    login_and_get_access(api_client, "alice")

    payload = bootstrap_payload(user, identity_pub, keys)
    payload["device"]["sign_pub"] = b64e(b"short")
    resp = api_client.post(f"{CRYPTO_BASE}/identity/", payload, format="json")
    assert resp.status_code == 400, resp.content

    payload = bootstrap_payload(user, identity_pub, keys)
    payload["device"]["kem_pub"] = "not-base64!!"
    resp = api_client.post(f"{CRYPTO_BASE}/identity/", payload, format="json")
    assert resp.status_code == 400, resp.content


def test_bootstrap_requires_authentication(api_client, user_factory):
    user = user_factory("alice")
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    resp = api_client.post(
        f"{CRYPTO_BASE}/identity/",
        bootstrap_payload(user, identity_pub, keys),
        format="json",
    )
    assert resp.status_code == 401
