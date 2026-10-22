"""KeyPackage upload / directory query / claim contract.

Upload: active devices only, sha256(keypackage) must equal the presented
hash, hash uniqueness (no reuse), per-device rate limit. Query: public
directory of ACTIVE devices of ACTIVE users with identities. Claim: any
authenticated user consumes exactly ONE unconsumed, unexpired package per
device atomically; re-claim returns empty for that device.
"""
import base64
import hashlib
import os
from datetime import timedelta

import pytest
from django.utils import timezone

from apps.accounts.models import TrustedDevice
from apps.crypto_keys.models import DeviceKeyBundle, KeyTransparencyEvent
from apps.crypto_keys.throttles import KeyClaimThrottle, KeyQueryThrottle, KeyUploadThrottle

from .conftest import (
    CRYPTO_BASE,
    b64e,
    login_and_get_access,
    register_device_payload,
)

pytestmark = pytest.mark.django_db

KP = os.urandom(288)


def kp_body(blob=KP, hash_override=None):
    return {
        "keypackage": b64e(blob),
        "keypackage_hash": b64e(hash_override if hash_override is not None else hashlib.sha256(blob).digest()),
    }


def _login_other(api_client, user_factory, username):
    from .conftest import login

    other = user_factory(username)
    resp = login(api_client, username)
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.json()['access']}")
    return other


def _upload(api_client, blob=KP, hash_override=None):
    return api_client.post(
        f"{CRYPTO_BASE}/keys/upload/", kp_body(blob, hash_override), format="json"
    )


def test_upload_and_claim_roundtrip(bootstrapped_user_factory, api_client, user_factory):
    owner, keys, _ = bootstrapped_user_factory("alice")
    resp = _upload(api_client)
    assert resp.status_code == 201, resp.content
    device = TrustedDevice.objects.get(user=owner, identity_sign_pub=keys.sign_pub)
    assert resp.json()["device_id"] == str(device.id)

    _login_other(api_client, user_factory, "bob")
    resp = api_client.post(
        f"{CRYPTO_BASE}/keys/claim/", {"device_ids": [str(device.id)]}, format="json"
    )
    assert resp.status_code == 200, resp.content
    claimed = resp.json()
    assert len(claimed) == 1
    assert claimed[0]["device_id"] == str(device.id)
    assert claimed[0]["keypackage"] == b64e(KP)
    assert claimed[0]["keypackage_hash"] == b64e(hashlib.sha256(KP).digest())
    bundle = DeviceKeyBundle.objects.get(device=device)
    assert bundle.consumed_at is not None


def test_claim_never_double_spends(bootstrapped_user_factory, api_client, user_factory):
    owner, keys, _ = bootstrapped_user_factory("alice")
    _upload(api_client)
    device = TrustedDevice.objects.get(user=owner, identity_sign_pub=keys.sign_pub)

    _login_other(api_client, user_factory, "bob")
    first = api_client.post(
        f"{CRYPTO_BASE}/keys/claim/", {"device_ids": [str(device.id)]}, format="json"
    )
    second = api_client.post(
        f"{CRYPTO_BASE}/keys/claim/", {"device_ids": [str(device.id)]}, format="json"
    )
    assert len(first.json()) == 1
    assert second.json() == []  # re-claim: empty for that device


def test_claim_consumes_one_of_many_in_fifo_order(bootstrapped_user_factory, api_client,
                                                  user_factory):
    owner, keys, _ = bootstrapped_user_factory("alice")
    blobs = [os.urandom(64) for _ in range(3)]
    for blob in blobs:
        assert _upload(api_client, blob).status_code == 201
    device = TrustedDevice.objects.get(user=owner, identity_sign_pub=keys.sign_pub)

    _login_other(api_client, user_factory, "bob")
    resp = api_client.post(
        f"{CRYPTO_BASE}/keys/claim/", {"device_ids": [str(device.id)]}, format="json"
    )
    assert resp.json()[0]["keypackage"] == b64e(blobs[0])  # oldest first
    assert DeviceKeyBundle.objects.filter(device=device, consumed_at__isnull=False).count() == 1


def test_upload_rejects_hash_mismatch(bootstrapped_user_factory, api_client):
    bootstrapped_user_factory("alice")
    resp = _upload(api_client, hash_override=os.urandom(32))
    assert resp.status_code == 400, resp.content
    assert DeviceKeyBundle.objects.count() == 0


def test_upload_rejects_reused_keypackage_hash(bootstrapped_user_factory, api_client):
    bootstrapped_user_factory("alice")
    assert _upload(api_client).status_code == 201
    resp = _upload(api_client)  # identical blob → identical hash
    assert resp.status_code == 409, resp.content


def test_claim_skips_revoked_devices(bootstrapped_user_factory, api_client, user_factory):
    owner, keys, _ = bootstrapped_user_factory("alice")
    _upload(api_client)
    device = TrustedDevice.objects.get(user=owner, identity_sign_pub=keys.sign_pub)

    login_and_get_access(api_client, "alice")
    resp = api_client.post(f"{CRYPTO_BASE}/devices/{device.id}/revoke/", {}, format="json")
    assert resp.status_code == 200

    _login_other(api_client, user_factory, "bob")
    resp = api_client.post(
        f"{CRYPTO_BASE}/keys/claim/", {"device_ids": [str(device.id)]}, format="json"
    )
    assert resp.json() == []
    # and the package stays unconsumed (no bookkeeping lies)
    assert DeviceKeyBundle.objects.get(device=device).consumed_at is None


def test_claim_skips_expired_packages(bootstrapped_user_factory, api_client, user_factory):
    owner, keys, _ = bootstrapped_user_factory("alice")
    device = TrustedDevice.objects.get(user=owner, identity_sign_pub=keys.sign_pub)
    blob = os.urandom(64)
    DeviceKeyBundle.objects.create(
        device=device,
        keypackage=blob,
        keypackage_hash=hashlib.sha256(blob).digest(),
        expires_at=timezone.now() - timedelta(seconds=1),
    )
    _login_other(api_client, user_factory, "bob")
    resp = api_client.post(
        f"{CRYPTO_BASE}/keys/claim/", {"device_ids": [str(device.id)]}, format="json"
    )
    assert resp.json() == []


def test_upload_rejects_past_expiry(bootstrapped_user_factory, api_client):
    bootstrapped_user_factory("alice")
    resp = api_client.post(
        f"{CRYPTO_BASE}/keys/upload/",
        {
            **kp_body(),
            "expires_at": (timezone.now() - timedelta(seconds=1)).isoformat(),
        },
        format="json",
    )
    assert resp.status_code == 400, resp.content


def test_query_lists_only_active_devices_with_keys(bootstrapped_user_factory, api_client,
                                                   user_factory, device_keys_factory):
    owner, keys, identity_pub = bootstrapped_user_factory("alice")
    bootstrap_device = TrustedDevice.objects.get(user=owner, identity_sign_pub=keys.sign_pub)
    phone_keys = device_keys_factory()
    api_client.post(
        f"{CRYPTO_BASE}/devices/register/",
        register_device_payload(owner, identity_pub, phone_keys),
        format="json",
    )
    inactive = user_factory("ghost", is_active=False)
    no_identity = user_factory("plain")

    _login_other(api_client, user_factory, "bob")
    resp = api_client.post(
        f"{CRYPTO_BASE}/keys/query/",
        {"user_ids": [str(owner.id), str(inactive.id), str(no_identity.id), str(user_factory('x2').id)]},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    entries = {e["user_id"]: e for e in resp.json()["users"]}

    assert str(owner.id) in entries
    assert str(inactive.id) not in entries
    assert str(no_identity.id) not in entries  # no identity → not in directory

    devices = entries[str(owner.id)]["devices"]
    assert [d["id"] for d in devices] == [str(bootstrap_device.id)]  # pending phone hidden
    assert devices[0]["status"] == "active"
    assert devices[0]["sign_pub"] == b64e(keys.sign_pub)
    assert devices[0]["kem_pub"] == b64e(keys.kem_pub)
    # the directory serves raw public keys by design; the transparency log
    # records only their hashes — the two views must agree
    served_sign_pub = devices[0]["sign_pub"]
    event = KeyTransparencyEvent.objects.get(user=owner, event_type="identity_created")
    assert event.payload["device_sign_pub_hash"] == hashlib.sha256(
        base64.b64decode(served_sign_pub)
    ).hexdigest()


def test_query_deduplicates_user_ids(bootstrapped_user_factory, api_client, user_factory):
    owner, keys, _ = bootstrapped_user_factory("alice")
    _login_other(api_client, user_factory, "bob")
    resp = api_client.post(
        f"{CRYPTO_BASE}/keys/query/",
        {"user_ids": [str(owner.id), str(owner.id)]},
        format="json",
    )
    assert len(resp.json()["users"]) == 1


def test_upload_rate_limited_per_device(bootstrapped_user_factory, api_client, monkeypatch):
    monkeypatch.setattr(KeyUploadThrottle, "rate", "3/min", raising=False)
    bootstrapped_user_factory("alice")
    statuses = [_upload(api_client, os.urandom(16)).status_code for _ in range(4)]
    assert statuses == [201, 201, 201, 429]


def test_query_rate_limited_per_user(bootstrapped_user_factory, api_client, user_factory,
                                     monkeypatch):
    monkeypatch.setattr(KeyQueryThrottle, "rate", "3/min", raising=False)
    owner, _, _ = bootstrapped_user_factory("alice")
    _login_other(api_client, user_factory, "bob")
    statuses = [
        api_client.post(
            f"{CRYPTO_BASE}/keys/query/", {"user_ids": [str(owner.id)]}, format="json"
        ).status_code
        for _ in range(4)
    ]
    assert statuses == [200, 200, 200, 429]


def test_claim_rate_limited_per_user(bootstrapped_user_factory, api_client, user_factory,
                                     monkeypatch):
    monkeypatch.setattr(KeyClaimThrottle, "rate", "3/min", raising=False)
    owner, keys, _ = bootstrapped_user_factory("alice")
    device = TrustedDevice.objects.get(user=owner, identity_sign_pub=keys.sign_pub)
    _login_other(api_client, user_factory, "bob")
    statuses = [
        api_client.post(
            f"{CRYPTO_BASE}/keys/claim/", {"device_ids": [str(device.id)]}, format="json"
        ).status_code
        for _ in range(4)
    ]
    assert statuses == [200, 200, 200, 429]
