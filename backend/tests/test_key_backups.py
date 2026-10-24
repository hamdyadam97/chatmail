"""Encrypted recovery backups (docs/phase1/03 §3.6) + device restore.

The server only stores ciphertext signed by the uploading device; restoring
requires a signature by the restored device's key, withdraws the browser's
pending registration, re-anchors the session and logs a transparency event.
"""
import base64
import hashlib
import os
import time

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import TrustedDevice, UserSession
from apps.crypto_keys import services
from apps.crypto_keys.models import EncryptedKeyBackup, KeyTransparencyEvent
from apps.notifications.models import Notification

from .conftest import (
    b64e,
    login_and_get_access,
    make_device_keys,
    new_signing_key,
    register_device_payload,
)

CRYPTO = "/api/v1/crypto"
KEY_ID = "a" * 32
pytestmark = pytest.mark.django_db


def upload(client, user, device_id, keys, ciphertext=None, key_id=KEY_ID, sign_device_id=None):
    ciphertext = ciphertext if ciphertext is not None else os.urandom(256)
    iv = os.urandom(12)
    message = services.backup_signing_message(
        user_id=user.id, device_id=sign_device_id or device_id, key_id=key_id, iv=iv,
        ciphertext_sha256=hashlib.sha256(ciphertext).digest(),
    )
    return client.post(
        f"{CRYPTO}/backups/",
        data=ciphertext,
        content_type="application/octet-stream",
        HTTP_X_BACKUP_DEVICE=str(device_id),
        HTTP_X_BACKUP_KEY_ID=key_id,
        HTTP_X_BACKUP_IV=b64e(iv),
        HTTP_X_BACKUP_SIGNATURE=b64e(keys.sign_priv.sign(message)),
    )


@pytest.fixture
def alice(api_client, bootstrapped_user_factory):
    user, keys, identity_pub = bootstrapped_user_factory("alice_bk")
    device = TrustedDevice.objects.get(user=user, identity_sign_pub=keys.sign_pub)
    return {"user": user, "keys": keys, "identity_pub": identity_pub, "device": device, "client": api_client}


def test_upload_list_download_roundtrip(alice):
    blob = os.urandom(4096)
    r = upload(alice["client"], alice["user"], alice["device"].id, alice["keys"], blob)
    assert r.status_code == 201, r.content
    listing = alice["client"].get(f"{CRYPTO}/backups/").json()
    assert [b["id"] for b in listing] == [r.json()["id"]]
    assert listing[0]["device_id"] == str(alice["device"].id) and listing[0]["size"] == len(blob)
    got = alice["client"].get(f"{CRYPTO}/backups/{r.json()['id']}/download/")
    assert got.status_code == 200 and got.content == blob


def test_backups_are_private(alice, user_factory):
    r = upload(alice["client"], alice["user"], alice["device"].id, alice["keys"])
    user_factory("mallory_bk")
    other = APIClient()
    login_and_get_access(other, "mallory_bk")
    assert other.get(f"{CRYPTO}/backups/").json() == []
    assert other.get(f"{CRYPTO}/backups/{r.json()['id']}/download/").status_code == 403
    # nor can mallory upload "for" alice's device
    assert upload(other, alice["user"], alice["device"].id, alice["keys"]).status_code == 403


def test_upload_requires_the_devices_own_signature(alice):
    wrong = make_device_keys()
    assert upload(alice["client"], alice["user"], alice["device"].id, wrong).status_code == 403
    # signature made for another device id does not transfer
    r = upload(alice["client"], alice["user"], alice["device"].id, alice["keys"], sign_device_id=alice["user"].id)
    assert r.status_code == 403
    assert not EncryptedKeyBackup.objects.exists()


def test_pending_device_cannot_upload(alice):
    pending_keys = make_device_keys()
    r = alice["client"].post(
        f"{CRYPTO}/devices/register/",
        register_device_payload(alice["user"], alice["identity_pub"], pending_keys),
        format="json",
    )
    assert upload(alice["client"], alice["user"], r.json()["id"], pending_keys).status_code == 403


def test_retention_and_key_rotation(alice):
    for _ in range(5):
        assert upload(alice["client"], alice["user"], alice["device"].id, alice["keys"]).status_code == 201
    versions = list(EncryptedKeyBackup.objects.order_by("version").values_list("version", flat=True))
    assert versions == [3, 4, 5]
    assert upload(alice["client"], alice["user"], alice["device"].id, alice["keys"], key_id="b" * 32).status_code == 201
    assert list(EncryptedKeyBackup.objects.values_list("key_id", flat=True)) == ["b" * 32]


def test_size_and_field_validation(alice, settings):
    settings.KEY_BACKUP_MAX_BYTES = 100
    assert upload(alice["client"], alice["user"], alice["device"].id, alice["keys"], os.urandom(101)).status_code == 400
    assert upload(alice["client"], alice["user"], "not-a-uuid", alice["keys"], os.urandom(10)).status_code == 400
    assert upload(alice["client"], alice["user"], alice["device"].id, alice["keys"], os.urandom(10), key_id="xyz").status_code == 400


# --- restore ---------------------------------------------------------------------

def restore_body(user, device_id, backup_id, keys, abandoned=None, issued_at=None):
    issued_at = int(time.time()) if issued_at is None else issued_at
    msg = services.restore_signing_message(
        user_id=user.id, device_id=device_id, backup_id=backup_id, abandoned_device_id=abandoned, issued_at=issued_at
    )
    return {
        "device_id": str(device_id),
        "backup_id": str(backup_id),
        "abandoned_device_id": str(abandoned) if abandoned else None,
        "issued_at": issued_at,
        "signature": b64e(keys.sign_priv.sign(msg)),
    }


@pytest.fixture
def lost_browser(alice):
    """Alice's backup exists; a fresh browser logs in and registers a pending device."""
    backup_id = upload(alice["client"], alice["user"], alice["device"].id, alice["keys"]).json()["id"]
    fresh = APIClient()
    login_and_get_access(fresh, "alice_bk")
    pending_keys = make_device_keys()
    pending_id = fresh.post(
        f"{CRYPTO}/devices/register/",
        register_device_payload(alice["user"], alice["identity_pub"], pending_keys, label="new-browser"),
        format="json",
    ).json()["id"]
    return {**alice, "fresh": fresh, "backup_id": backup_id, "pending_id": pending_id}


def test_restore_takes_over_device(lost_browser):
    lb = lost_browser
    body = restore_body(lb["user"], lb["device"].id, lb["backup_id"], lb["keys"], abandoned=lb["pending_id"])
    r = lb["fresh"].post(f"{CRYPTO}/backups/restored/", body, format="json")
    assert r.status_code == 200, r.content
    assert TrustedDevice.objects.get(id=lb["pending_id"]).status == "revoked"
    newest = UserSession.objects.filter(user=lb["user"]).order_by("-created_at").first()
    assert newest.device_id == lb["device"].id  # re-anchored → can approve devices again
    event = KeyTransparencyEvent.objects.filter(user=lb["user"], event_type="device_restored").get()
    assert event.payload["device_id"] == str(lb["device"].id)
    assert Notification.objects.filter(user=lb["user"], kind="device_alert", ref_id=lb["device"].id).exists()


def test_restore_rejects_forged_or_stale_proofs(lost_browser):
    lb = lost_browser
    forged = restore_body(lb["user"], lb["device"].id, lb["backup_id"], make_device_keys(), abandoned=lb["pending_id"])
    assert lb["fresh"].post(f"{CRYPTO}/backups/restored/", forged, format="json").status_code == 403
    stale = restore_body(lb["user"], lb["device"].id, lb["backup_id"], lb["keys"], issued_at=int(time.time()) - 3600)
    assert lb["fresh"].post(f"{CRYPTO}/backups/restored/", stale, format="json").status_code == 400
    # the signature covers the abandoned device id: it cannot be swapped afterwards
    body = restore_body(lb["user"], lb["device"].id, lb["backup_id"], lb["keys"])
    body["abandoned_device_id"] = lb["pending_id"]
    assert lb["fresh"].post(f"{CRYPTO}/backups/restored/", body, format="json").status_code == 403
    assert TrustedDevice.objects.get(id=lb["pending_id"]).status == "pending"
    assert not KeyTransparencyEvent.objects.filter(event_type="device_restored").exists()


def test_restore_never_revokes_a_working_device(lost_browser, bootstrapped_user_factory):
    lb = lost_browser
    other_active = TrustedDevice.objects.create(
        user=lb["user"], device_label="laptop", platform="linux",
        identity_sign_pub=new_signing_key()[1], kem_pub=os.urandom(32), status="active",
    )
    body = restore_body(lb["user"], lb["device"].id, lb["backup_id"], lb["keys"], abandoned=other_active.id)
    assert lb["fresh"].post(f"{CRYPTO}/backups/restored/", body, format="json").status_code == 200
    assert TrustedDevice.objects.get(id=other_active.id).status == "active"


def test_backup_ciphertext_is_opaque_to_the_server(alice):
    """SEC-18 shape: nothing but ciphertext + public parameters is stored."""
    canary = b"CANARY-backup-plaintext-77f1"
    upload(alice["client"], alice["user"], alice["device"].id, alice["keys"], ciphertext=os.urandom(64))
    fields = {f.name for f in EncryptedKeyBackup._meta.fields}
    assert not {"key", "recovery_key", "kek", "plaintext", "password"} & fields
    row = EncryptedKeyBackup.objects.get()
    assert canary not in bytes(row.ciphertext)
    assert base64.b64decode(services.b64encode(row.iv)) == bytes(row.iv)


def test_login_never_reactivates_a_revoked_crypto_device(api_client, user_factory):
    user = user_factory("bob_bk")
    stolen = TrustedDevice.objects.create(
        user=user, device_label="unknown device", platform="unknown",
        identity_sign_pub=new_signing_key()[1], kem_pub=os.urandom(32), status="revoked",
    )
    login_and_get_access(api_client, "bob_bk")
    stolen.refresh_from_db()
    assert stolen.status == "revoked"
    assert UserSession.objects.filter(user=user).latest("created_at").device_id != stolen.id
