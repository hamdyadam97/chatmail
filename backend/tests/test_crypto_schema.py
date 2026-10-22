"""SEC-03/09-style storage sweeps for the crypto_keys phase.

1. Schema: no model field name may contain 'private' or 'secret' except the
   allowlisted accounts.mfa_secret_ciphertext (server-encrypted TOTP secret,
   login-only data — ERD §4.2 ب).
2. Content: in a populated database, no BinaryField value may look like a
   PEM or OpenSSH private key. All stored bytes must be raw public keys,
   hashes, opaque MLS blobs, ciphertexts or signatures.
"""
import base64
import hashlib
import os
import re

import pytest
from django.apps import apps

from apps.accounts.models import TrustedDevice
from apps.accounts.tokens import issue_access_token
from apps.audit.models import AuditLog
from apps.crypto_keys.models import DeviceKeyBundle, KeyVerificationEvent

from .conftest import CRYPTO_BASE, b64e, login_and_get_access, make_device_keys, new_signing_key

pytestmark = pytest.mark.django_db

ALLOWLISTED_SECRET_FIELDS = {"mfa_secret_ciphertext"}

_PEM_PRIVATE_RE = re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")
_OPENSSH_MAGIC = b"openssh-key-v1\x00"


def test_no_private_or_secret_field_names():
    offenders = []
    for model in apps.get_models():
        for field in model._meta.get_fields():
            name = (getattr(field, "name", "") or "").lower()
            if "private" in name or "secret" in name:
                if name not in ALLOWLISTED_SECRET_FIELDS:
                    offenders.append(f"{model._meta.label}.{field.name}")
    assert offenders == []


def _populate(api_client, user_factory):
    """Exercise every bytes-writing flow this phase owns."""
    from .conftest import bootstrap_payload

    user = user_factory("alice")
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    login_and_get_access(api_client, "alice")
    assert api_client.post(
        f"{CRYPTO_BASE}/identity/", bootstrap_payload(user, identity_pub, keys), format="json"
    ).status_code == 201
    device = TrustedDevice.objects.get(user=user, identity_sign_pub=keys.sign_pub)

    blob = os.urandom(288)
    assert api_client.post(
        f"{CRYPTO_BASE}/keys/upload/",
        {"keypackage": b64e(blob), "keypackage_hash": b64e(hashlib.sha256(blob).digest())},
        format="json",
    ).status_code == 201

    KeyVerificationEvent.objects.create(
        verifier_device=device,
        verified_device=device,
        method="sas",
        fingerprint_hash=hashlib.sha256(b"fingerprint").digest(),
        result="success",
    )
    # MFA ciphertext path (accounts app) — populate it too.
    user.mfa_secret_ciphertext = base64.urlsafe_b64encode(os.urandom(32))
    user.save(update_fields=["mfa_secret_ciphertext"])
    return user, device


def test_no_private_key_material_anywhere_in_database(api_client, user_factory):
    _populate(api_client, user_factory)

    offenders = []
    for model in apps.get_models():
        binary_fields = [
            f for f in model._meta.get_fields()
            if f.concrete and not f.is_relation and f.get_internal_type() == "BinaryField"
        ]
        if not binary_fields:
            continue
        for row in model.objects.all().iterator():
            for field in binary_fields:
                value = getattr(row, field.attname)
                if not value:
                    continue
                raw = bytes(value)
                if _PEM_PRIVATE_RE.search(raw) or raw.startswith(_OPENSSH_MAGIC):
                    offenders.append(f"{model._meta.label}.{field.name}:{row.pk}")
    assert offenders == []


def test_transparency_log_is_append_only(api_client, user_factory):
    from apps.crypto_keys.models import KeyTransparencyEvent

    from .conftest import bootstrap_payload

    user = user_factory("alice")
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    login_and_get_access(api_client, "alice")
    assert api_client.post(
        f"{CRYPTO_BASE}/identity/",
        bootstrap_payload(user, identity_pub, keys),
        format="json",
    ).status_code == 201

    event = KeyTransparencyEvent.objects.get(user=user)
    with pytest.raises(NotImplementedError):
        KeyTransparencyEvent.objects.filter(id=event.id).update(event_type="device_revoked")
    with pytest.raises(NotImplementedError):
        KeyTransparencyEvent.objects.filter(id=event.id).delete()
    event.event_type = "device_revoked"
    with pytest.raises(Exception):
        event.save()
