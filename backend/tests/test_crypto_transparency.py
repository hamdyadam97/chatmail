"""Key-transparency chain verification (docs/phase1/03-key-management.md §3.8).

The /self/ endpoint must yield a chain that an independent verifier can
check end-to-end: genesis constant, entry_hash = sha256(prev_hash ||
canonical_json(payload)), and an ed25519 signature over entry_hash that
verifies with the advertised /log-key/ public key. Chains are per-user:
another user's interleaved events must not break my chain's continuity.
"""
import base64
import hashlib
import json

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from apps.crypto_keys import transparency
from apps.crypto_keys.models import KeyTransparencyEvent

from .conftest import CRYPTO_BASE, b64e, login_and_get_access, make_device_keys, new_signing_key

pytestmark = pytest.mark.django_db


def _bootstrap(api_client, user_factory, username):
    from .conftest import bootstrap_payload

    user = user_factory(username)
    _, identity_pub = new_signing_key()
    keys = make_device_keys()
    token = login_and_get_access(api_client, username)
    assert api_client.post(
        f"{CRYPTO_BASE}/identity/", bootstrap_payload(user, identity_pub, keys), format="json"
    ).status_code == 201
    return user, identity_pub, keys, token


def _post_bootstrap_steps(api_client, user, identity_pub):
    """register → approve → upload → revoke."""
    import os

    from .conftest import register_device_payload

    phone_keys = make_device_keys()
    resp = api_client.post(
        f"{CRYPTO_BASE}/devices/register/",
        register_device_payload(user, identity_pub, phone_keys),
        format="json",
    )
    phone_id = resp.json()["id"]
    assert api_client.post(f"{CRYPTO_BASE}/devices/{phone_id}/approve/", {}, format="json").status_code == 200

    blob = os.urandom(64)
    assert api_client.post(
        f"{CRYPTO_BASE}/keys/upload/",
        {"keypackage": b64e(blob), "keypackage_hash": b64e(hashlib.sha256(blob).digest())},
        format="json",
    ).status_code == 201
    assert api_client.post(f"{CRYPTO_BASE}/devices/{phone_id}/revoke/", {}, format="json").status_code == 200


def _exercise_lifecycle(api_client, user_factory, username):
    """Bootstrap → register → approve → upload → revoke for one user."""
    user, identity_pub, keys, _ = _bootstrap(api_client, user_factory, username)
    device = user.trusted_devices.get(identity_sign_pub=keys.sign_pub)
    _post_bootstrap_steps(api_client, user, identity_pub)
    return user, device


def _canonical(payload) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def test_self_chain_verifies_cryptographically_end_to_end(api_client, user_factory):
    user, _ = _exercise_lifecycle(api_client, user_factory, "alice")
    login_and_get_access(api_client, "alice")

    chain = api_client.get(f"{CRYPTO_BASE}/transparency/self/").json()
    expected_types = ["identity_created", "device_added", "device_approved", "key_uploaded", "device_revoked"]
    assert [e["event_type"] for e in chain] == expected_types
    seqs = [e["seq"] for e in chain]
    assert seqs == sorted(seqs)  # ordered

    log_pub = api_client.get(f"{CRYPTO_BASE}/transparency/log-key/").json()["log_pub"]
    verifying_key = Ed25519PublicKey.from_public_bytes(base64.b64decode(log_pub))

    prev = None
    for position, entry in enumerate(chain):
        prev_hash = base64.b64decode(entry["prev_hash"])
        entry_hash = base64.b64decode(entry["entry_hash"])
        signature = base64.b64decode(entry["log_signature"])

        if position == 0:
            assert prev_hash == transparency.GENESIS_PREV_HASH
        else:
            assert prev_hash == prev, "chain link broken"

        # independent recomputation of the entry hash
        assert hashlib.sha256(prev_hash + _canonical(entry["payload"])).digest() == entry_hash

        # signature over the entry hash with the advertised log key
        verifying_key.verify(signature, entry_hash)  # raises on failure
        prev = entry_hash


def test_chain_is_per_user_despite_interleaving(api_client, user_factory):
    # alice bootstraps, THEN bob bootstraps, THEN alice continues her lifecycle
    # — bob's events sit between alice's in the global sequence.
    alice, alice_identity_pub, _, alice_token = _bootstrap(api_client, user_factory, "alice")
    bob, _, _, _ = _bootstrap(api_client, user_factory, "bob")
    # العودة لجلسة alice الأصلية (جهازها الموثّق بالمفاتيح) — لا new login:
    # الاعتماد يتطلب جهازًا موثّقًا فعليًا، وجلسة دخول جديدة = جهاز بلا مفاتيح.
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {alice_token}")
    _post_bootstrap_steps(api_client, alice, alice_identity_pub)

    alice_events = list(KeyTransparencyEvent.objects.filter(user=alice).order_by("id"))
    bob_events = list(KeyTransparencyEvent.objects.filter(user=bob).order_by("id"))
    assert bob_events[0].id > alice_events[0].id
    assert bob_events[0].id < alice_events[-1].id  # truly interleaved

    assert transparency.verify_chain(alice_events) == []
    assert transparency.verify_chain(bob_events) == []


def test_verify_chain_detects_tampering(api_client, user_factory):
    user, _ = _exercise_lifecycle(api_client, user_factory, "alice")
    events = list(KeyTransparencyEvent.objects.filter(user=user).order_by("id"))

    assert transparency.verify_chain(events) == []

    tampered = []
    for e in events:
        tampered.append(
            {
                "id": e.id,
                "prev_hash": bytes(e.prev_hash),
                "entry_hash": bytes(e.entry_hash),
                "payload": dict(e.payload, injected="attacker"),
                "log_signature": bytes(e.log_signature),
            }
        )
    problems = transparency.verify_chain(tampered)
    assert problems and all("does not recompute" in p for p in problems)

    # a swapped signature must fail verification (corrupt the last one)
    broken_sig = tampered.copy()
    broken_sig[-1] = dict(broken_sig[-1], log_signature=b"\x00" * 64)
    problems = transparency.verify_chain(broken_sig)
    assert any("signature invalid" in p for p in problems)


def test_verify_chain_detects_broken_link(api_client, user_factory):
    user, _ = _exercise_lifecycle(api_client, user_factory, "alice")
    events = [
        {
            "id": e.id,
            "prev_hash": bytes(e.prev_hash),
            "entry_hash": bytes(e.entry_hash),
            "payload": e.payload,
            "log_signature": bytes(e.log_signature),
        }
        for e in KeyTransparencyEvent.objects.filter(user=user).order_by("id")
    ]
    assert transparency.verify_chain(events) == []
    events[1] = dict(events[1], prev_hash=b"\xff" * 32)  # orphan the second entry
    problems = transparency.verify_chain(events)
    assert any("broken chain link" in p for p in problems)


def test_log_key_signature_rejects_wrong_key(api_client, user_factory):
    """Signatures must NOT verify under an attacker-supplied key."""
    user, _ = _exercise_lifecycle(api_client, user_factory, "alice")
    login_and_get_access(api_client, "alice")
    chain = api_client.get(f"{CRYPTO_BASE}/transparency/self/").json()
    last = chain[-1]

    _, attacker_pub = new_signing_key()
    wrong_key = Ed25519PublicKey.from_public_bytes(attacker_pub)
    with pytest.raises(InvalidSignature):
        wrong_key.verify(base64.b64decode(last["log_signature"]),
                         base64.b64decode(last["entry_hash"]))


def test_transparency_payloads_carry_hashes_not_keys(api_client, user_factory):
    """SEC-adjacent: payloads hold sha256 hex of keys, never the keys."""
    user, device = _exercise_lifecycle(api_client, user_factory, "alice")
    raw_material = {
        b64e(device.identity_sign_pub),
        b64e(device.kem_pub),
    }
    key_carrying_events = {"identity_created", "device_added", "key_uploaded"}
    for event in KeyTransparencyEvent.objects.filter(user=user):
        for value in event.payload.values():
            assert isinstance(value, str)
            assert value not in raw_material
        if event.event_type in key_carrying_events:
            hash_fields = [k for k in event.payload if k.endswith("_hash")]
            assert hash_fields, f"event {event.event_type} has no hash fields"
