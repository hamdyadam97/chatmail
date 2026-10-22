"""Key-transparency engine per docs/phase1/03-key-management.md §3.8.

Chain construction (per user — a client can verify its own /self/ view
standalone, gaps-free):

    entry_hash  = sha256(prev_hash || canonical_json(payload))
    signature   = ed25519_sign(entry_hash)            # server-held log key
    prev_hash   = previous entry_hash of the SAME user
                  (or GENESIS_PREV_HASH for the user's first entry)

canonical_json is deterministic: sorted keys, compact separators, UTF-8.

The log signing key is an ed25519 seed from the CRYPTO_LOG_SIGN_SEED env var
(base64, 32 bytes). A deterministic dev default exists with a loud warning,
mirroring AUTH_JWT_SECRET in config/settings/base.py; production must inject a
real seed. The matching public key is exposed at GET /crypto/transparency/
log-key/ so clients can pin it (§3.8.1: the public log key ships in the
client/build).
"""
import base64
import hashlib
import json
import os
import warnings

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from django.db import transaction

from .models import KeyTransparencyEvent

# Deterministic genesis marker for each user's first chain entry.
GENESIS_PREV_HASH = hashlib.sha256(b"correspondence-key-transparency-genesis-v1").digest()

_ENV_NAME = "CRYPTO_LOG_SIGN_SEED"

_private_key: Ed25519PrivateKey | None = None


def _load_private_key() -> Ed25519PrivateKey:
    global _private_key
    if _private_key is not None:
        return _private_key
    raw = os.environ.get(_ENV_NAME)
    if raw:
        try:
            seed = base64.b64decode(raw, validate=True)
        except Exception:
            seed = b""
        if len(seed) != 32:
            raise RuntimeError(
                f"{_ENV_NAME} must be base64 encoding exactly 32 bytes "
                f"(an ed25519 seed); got {len(seed)} bytes after decoding."
            )
    else:
        seed = hashlib.sha256(b"dev-only-crypto-log-sign-seed-do-not-use-in-production").digest()
        warnings.warn(
            f"{_ENV_NAME} not set; using an insecure deterministic development default. "
            f"Set {_ENV_NAME} in the environment for any non-dev deployment.",
            stacklevel=2,
        )
    _private_key = Ed25519PrivateKey.from_private_bytes(seed)
    return _private_key


def canonical_json(payload: dict) -> bytes:
    """Deterministic JSON encoding used inside the hash chain."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def compute_entry_hash(prev_hash: bytes, payload: dict) -> bytes:
    return hashlib.sha256(bytes(prev_hash) + canonical_json(payload)).digest()


def hash_bytes(data: bytes) -> str:
    """Public-key hash representation used inside transparency payloads
    (hex sha256 — hashes only, never the keys themselves)."""
    return hashlib.sha256(bytes(data)).hexdigest()


def log_public_key_bytes() -> bytes:
    """Raw 32-byte ed25519 public key of the log signer."""
    pub = _load_private_key().public_key()
    return pub.public_bytes(Encoding.Raw, PublicFormat.Raw)


def log_public_key_b64() -> str:
    return base64.b64encode(log_public_key_bytes()).decode("ascii")


@transaction.atomic
def append_event(event_type: str, *, user=None, device=None, payload: dict | None = None) -> KeyTransparencyEvent:
    """Append one signed entry to the user's transparency chain.

    Runs in a transaction and locks the user's chain tail (select_for_update)
    so two concurrent appends cannot fork the chain. `payload` must contain
    identifiers and public-key hashes only.
    """
    tail = (
        KeyTransparencyEvent.objects.filter(user=user)
        .order_by("-id")
        .select_for_update()
        .first()
        if user is not None
        else None
    )
    prev_hash = bytes(tail.entry_hash) if tail is not None else GENESIS_PREV_HASH
    body = dict(payload or {})
    entry_hash = compute_entry_hash(prev_hash, body)
    signature = _load_private_key().sign(entry_hash)
    return KeyTransparencyEvent.objects.create(
        user=user,
        device=device,
        event_type=event_type,
        prev_hash=prev_hash,
        entry_hash=entry_hash,
        payload=body,
        log_signature=signature,
    )


def verify_chain(events) -> list[str]:
    """Cryptographically verify a chain of entries (as model rows or as plain
    attribute-holding dicts from the API). Returns a list of problems — an
    empty list means the chain is fully valid:

      * continuity: first prev_hash == GENESIS, then prev_hash == previous
        entry_hash;
      * integrity:  recomputed sha256(prev_hash || canonical_json(payload))
        equals the stored entry_hash;
      * signature:  ed25519 signature over entry_hash verifies against the
        configured log public key.
    """
    problems: list[str] = []
    verifying_key = Ed25519PublicKey.from_public_bytes(log_public_key_bytes())
    prev: bytes | None = None
    for position, event in enumerate(events):
        seq = _get(event, "id")
        prev_hash = bytes(_get(event, "prev_hash"))
        entry_hash = bytes(_get(event, "entry_hash"))
        payload = _get(event, "payload") or {}
        signature = bytes(_get(event, "log_signature"))

        if position == 0:
            if prev_hash != GENESIS_PREV_HASH:
                problems.append(f"entry {seq}: genesis prev_hash mismatch")
        elif prev_hash != prev:
            problems.append(f"entry {seq}: broken chain link")

        if compute_entry_hash(prev_hash, payload) != entry_hash:
            problems.append(f"entry {seq}: entry_hash does not recompute")

        try:
            verifying_key.verify(signature, entry_hash)
        except InvalidSignature:
            problems.append(f"entry {seq}: log signature invalid")

        prev = entry_hash
    return problems


def _get(event, name: str):
    if isinstance(event, dict):
        return event[name]
    return getattr(event, name)
