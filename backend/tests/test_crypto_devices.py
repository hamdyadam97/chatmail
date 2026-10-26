"""Device lifecycle contract: register (pending) → approve (active) → revoke.

Pending devices are invisible in the key directory and cannot upload
KeyPackages; approval must come from an active session of the OWNER; revoke
hides the device, stops KeyPackage serving, emits the channel-layer
device_revoked event on user.{id}, and is audit-logged.
"""
from datetime import timedelta

import pytest
from asgiref.sync import async_to_sync
from channels.layers import InMemoryChannelLayer
from django.utils import timezone

from apps.accounts.models import TrustedDevice, UserSession
from apps.accounts.tokens import issue_access_token
from apps.audit.models import AuditLog
from apps.crypto_keys.models import KeyTransparencyEvent

from .conftest import (
    CRYPTO_BASE,
    b64e,
    login_and_get_access,
    make_device_keys,
    register_device_payload,
)

pytestmark = pytest.mark.django_db


def _query_devices(api_client, user_id):
    resp = api_client.post(
        f"{CRYPTO_BASE}/keys/query/", {"user_ids": [str(user_id)]}, format="json"
    )
    assert resp.status_code == 200, resp.content
    entries = resp.json()["users"]
    return entries[0]["devices"] if entries else []


def _other_client(api_client, user_factory, username):
    from .conftest import login

    other = user_factory(username)
    resp = login(api_client, username)
    assert resp.status_code == 200
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {resp.json()['access']}")
    return other


@pytest.fixture
def owner_setup(api_client, user_factory):
    """owner bootstrapped; returns (owner, identity_pub, bootstrap_device)."""
    from .conftest import bootstrap_payload, new_signing_key

    owner = user_factory("owner")
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    login_and_get_access(api_client, "owner")
    resp = api_client.post(
        f"{CRYPTO_BASE}/identity/",
        bootstrap_payload(owner, identity_pub, keys),
        format="json",
    )
    assert resp.status_code == 201, resp.content
    device = TrustedDevice.objects.get(user=owner, identity_sign_pub=keys.sign_pub)
    return owner, identity_pub, device


def test_register_additional_device_is_pending(owner_setup, api_client, device_keys_factory):
    owner, identity_pub, bootstrap_device = owner_setup
    phone_keys = device_keys_factory()

    resp = api_client.post(
        f"{CRYPTO_BASE}/devices/register/",
        register_device_payload(owner, identity_pub, phone_keys, label="iPhone", platform="ios"),
        format="json",
    )

    assert resp.status_code == 201, resp.content
    assert resp.json()["status"] == "pending"
    phone = TrustedDevice.objects.get(user=owner, identity_sign_pub=phone_keys.sign_pub)
    assert phone.status == "pending"
    event = KeyTransparencyEvent.objects.get(user=owner, event_type="device_added")
    assert event.payload["device_id"] == str(phone.id)
    assert AuditLog.objects.filter(actor=owner, action="device_added").exists()


def test_pending_device_invisible_in_query_and_cannot_upload(owner_setup, api_client,
                                                             user_factory, device_keys_factory):
    owner, identity_pub, bootstrap_device = owner_setup
    phone_keys = device_keys_factory()
    resp = api_client.post(
        f"{CRYPTO_BASE}/devices/register/",
        register_device_payload(owner, identity_pub, phone_keys),
        format="json",
    )
    phone_id = resp.json()["id"]

    _other_client(api_client, user_factory, "querier")
    devices = _query_devices(api_client, owner.id)
    assert [d["id"] for d in devices] == [str(bootstrap_device.id)]

    # A session bound to the PENDING device must still be refused upload.
    session = UserSession.objects.create(
        user=owner,
        device_id=phone_id,
        refresh_token_hash="p" * 64,
        expires_at=timezone.now() + timedelta(hours=1),
    )
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {issue_access_token(owner, session)}")
    resp = api_client.post(
        f"{CRYPTO_BASE}/keys/upload/",
        {"keypackage": b64e(b"\x01" * 32), "keypackage_hash": b64e(b"\x02" * 32)},
        format="json",
    )
    assert resp.status_code == 403, resp.content


def test_approve_activates_and_directory_shows_it(owner_setup, api_client,
                                                  user_factory, device_keys_factory):
    owner, identity_pub, bootstrap_device = owner_setup
    phone_keys = device_keys_factory()
    resp = api_client.post(
        f"{CRYPTO_BASE}/devices/register/",
        register_device_payload(owner, identity_pub, phone_keys),
        format="json",
    )
    phone_id = resp.json()["id"]

    resp = api_client.post(f"{CRYPTO_BASE}/devices/{phone_id}/approve/", {}, format="json")
    assert resp.status_code == 200, resp.content
    assert resp.json()["status"] == "active"

    phone = TrustedDevice.objects.get(id=phone_id)
    assert phone.approved_by_device_id == bootstrap_device.id
    assert phone.approved_at is not None

    _other_client(api_client, user_factory, "querier")
    devices = _query_devices(api_client, owner.id)
    assert sorted(d["id"] for d in devices) == sorted([str(bootstrap_device.id), str(phone_id)])
    assert all(d["status"] == "active" for d in devices)

    event = KeyTransparencyEvent.objects.get(user=owner, event_type="device_approved")
    assert event.payload["approved_by_device_id"] == str(bootstrap_device.id)
    assert AuditLog.objects.filter(actor=owner, action="device_approved").exists()


def test_approve_rejects_other_peoples_devices(owner_setup, api_client, user_factory,
                                               device_keys_factory):
    owner, identity_pub, _ = owner_setup
    phone_keys = device_keys_factory()
    resp = api_client.post(
        f"{CRYPTO_BASE}/devices/register/",
        register_device_payload(owner, identity_pub, phone_keys),
        format="json",
    )
    phone_id = resp.json()["id"]

    _other_client(api_client, user_factory, "intruder")
    resp = api_client.post(f"{CRYPTO_BASE}/devices/{phone_id}/approve/", {}, format="json")
    assert resp.status_code == 403, resp.content
    assert TrustedDevice.objects.get(id=phone_id).status == "pending"


def _signed_proof(user, approver_id, keys, device_id, issued_at=None):
    from apps.crypto_keys.services import approve_signing_message

    issued_at = int(issued_at if issued_at is not None else timezone.now().timestamp())
    message = approve_signing_message(
        user_id=user.id, approver_device_id=approver_id, device_id=device_id, issued_at=issued_at
    )
    return {"approver_device_id": str(approver_id), "issued_at": issued_at, "signature": b64e(keys.sign_priv.sign(message))}


@pytest.fixture
def relogged_owner(api_client, user_factory, device_keys_factory):
    """Owner whose keyed device exists, but whose CURRENT login session is
    anchored to a keyless placeholder (what every later login produces)."""
    from .conftest import bootstrap_payload, new_signing_key

    owner = user_factory("owner")
    _, identity_pub = new_signing_key()
    laptop_keys = make_device_keys()
    login_and_get_access(api_client, "owner")
    assert api_client.post(f"{CRYPTO_BASE}/identity/", bootstrap_payload(owner, identity_pub, laptop_keys),
                           format="json").status_code == 201
    laptop = TrustedDevice.objects.get(user=owner, identity_sign_pub=laptop_keys.sign_pub)
    login_and_get_access(api_client, "owner")
    phone_keys = device_keys_factory()
    phone_id = api_client.post(f"{CRYPTO_BASE}/devices/register/",
                               register_device_payload(owner, identity_pub, phone_keys), format="json").json()["id"]
    return owner, laptop, laptop_keys, phone_id


def test_relogged_session_approves_with_device_signature(relogged_owner, api_client):
    owner, laptop, laptop_keys, phone_id = relogged_owner
    url = f"{CRYPTO_BASE}/devices/{phone_id}/approve/"
    # The session alone no longer names a keyed device...
    assert api_client.post(url, {}, format="json").status_code == 403
    # ...the keyed device's signature does.
    resp = api_client.post(url, _signed_proof(owner, laptop.id, laptop_keys, phone_id), format="json")
    assert resp.status_code == 200, resp.content
    phone = TrustedDevice.objects.get(id=phone_id)
    assert phone.status == "active" and phone.approved_by_device_id == laptop.id
    event = KeyTransparencyEvent.objects.get(user=owner, event_type="device_approved")
    assert event.payload["approved_by_device_id"] == str(laptop.id)


def test_signed_approval_rejects_forged_stale_or_foreign_proofs(relogged_owner, api_client, device_keys_factory):
    owner, laptop, laptop_keys, phone_id = relogged_owner
    url = f"{CRYPTO_BASE}/devices/{phone_id}/approve/"
    forged = _signed_proof(owner, laptop.id, device_keys_factory(), phone_id)
    assert api_client.post(url, forged, format="json").status_code == 403
    stale = _signed_proof(owner, laptop.id, laptop_keys, phone_id, issued_at=timezone.now().timestamp() - 3600)
    assert api_client.post(url, stale, format="json").status_code == 400
    # A signature for another device cannot be replayed onto this one.
    other = _signed_proof(owner, laptop.id, laptop_keys, laptop.id)
    assert api_client.post(url, other, format="json").status_code == 403
    assert TrustedDevice.objects.get(id=phone_id).status == "pending"


def test_approve_requires_pending_status(owner_setup, api_client):
    owner, _, bootstrap_device = owner_setup
    resp = api_client.post(
        f"{CRYPTO_BASE}/devices/{bootstrap_device.id}/approve/", {}, format="json"
    )
    assert resp.status_code == 409, resp.content


def test_revoke_hides_from_query_stops_key_serving_and_audits(
    owner_setup, api_client, user_factory, device_keys_factory, monkeypatch
):
    owner, identity_pub, bootstrap_device = owner_setup
    layer = InMemoryChannelLayer()
    monkeypatch.setattr("channels.layers.get_channel_layer", lambda: layer)
    async_to_sync(layer.group_add)(f"user.{owner.id}", "watcher")

    resp = api_client.post(
        f"{CRYPTO_BASE}/devices/{bootstrap_device.id}/revoke/", {}, format="json"
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["status"] == "revoked"

    bootstrap_device.refresh_from_db()
    assert bootstrap_device.status == "revoked"
    assert bootstrap_device.revoked_at is not None

    # directory no longer serves the device
    _other_client(api_client, user_factory, "querier")
    assert _query_devices(api_client, owner.id) == []

    # KeyPackage serving stops: upload happened before revoke; claim gets nothing
    # (covered in the keys suite) — here assert the channel + audit + log rows.

    # channel-layer event consumed by the messaging app to close the WS
    message = async_to_sync(layer.receive)("watcher")
    assert message == {"type": "device_revoked", "device_id": str(bootstrap_device.id)}

    assert AuditLog.objects.filter(
        actor=owner, action="device_revoked", target_id=bootstrap_device.id
    ).exists()
    event = KeyTransparencyEvent.objects.get(user=owner, event_type="device_revoked")
    assert event.payload["device_id"] == str(bootstrap_device.id)


def test_revoke_is_idempotent(owner_setup, api_client):
    owner, _, bootstrap_device = owner_setup
    first = api_client.post(
        f"{CRYPTO_BASE}/devices/{bootstrap_device.id}/revoke/", {}, format="json"
    )
    second = api_client.post(
        f"{CRYPTO_BASE}/devices/{bootstrap_device.id}/revoke/", {}, format="json"
    )
    assert first.status_code == second.status_code == 200
    assert KeyTransparencyEvent.objects.filter(
        user=owner, event_type="device_revoked"
    ).count() == 1


def test_device_listing_shows_full_registry(owner_setup, api_client, device_keys_factory):
    owner, identity_pub, bootstrap_device = owner_setup
    phone_keys = device_keys_factory()
    api_client.post(
        f"{CRYPTO_BASE}/devices/register/",
        register_device_payload(owner, identity_pub, phone_keys, label="iPhone"),
        format="json",
    )
    resp = api_client.get(f"{CRYPTO_BASE}/devices/")
    assert resp.status_code == 200
    phone = TrustedDevice.objects.get(user=owner, identity_sign_pub=phone_keys.sign_pub)
    by_id = {d["id"]: d for d in resp.json()}
    assert set(by_id) == {str(bootstrap_device.id), str(phone.id)}
    row = by_id[str(bootstrap_device.id)]
    assert row["label"] == "test-device"
    assert row["status"] == "active"
    assert row["created_at"] and "last_seen_at" in row
