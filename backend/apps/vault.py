"""Server-side content encryption at rest (AES-256-GCM).

User decision (2026-10-31): mail works like Outlook — the server stores
correspondence, chat, announcement and external-mail content encrypted with
one server key (settings.CONTENT_ENCRYPTION_KEY) and opens it for whoever the
object-permission gates allow. Read rights still derive only from
participation (AGENTS rule 5); no role reads other people's mail.

Format: b"v1" || nonce(12) || ciphertext+tag. The AAD binds each blob to its
purpose and owning row, so a blob copied onto another row fails to open.
"""
import base64
import json
import os
from functools import lru_cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from django.conf import settings

VERSION = b"v1"
NONCE_BYTES = 12


class VaultError(Exception):
    """A blob that is not ours, was moved to another row, or was tampered with."""


@lru_cache(maxsize=1)
def _cipher() -> AESGCM:
    key = base64.b64decode(settings.CONTENT_ENCRYPTION_KEY)
    if len(key) != 32:
        raise ValueError("CONTENT_ENCRYPTION_KEY must be base64 of 32 bytes")
    return AESGCM(key)


def _aad(purpose: str, owner) -> bytes:
    return f"{purpose}:{owner}".encode()


def seal(data: bytes, *, purpose: str, owner) -> bytes:
    nonce = os.urandom(NONCE_BYTES)
    return VERSION + nonce + _cipher().encrypt(nonce, data, _aad(purpose, owner))


def open_(blob: bytes, *, purpose: str, owner) -> bytes:
    blob = bytes(blob)
    if not blob.startswith(VERSION) or len(blob) < len(VERSION) + NONCE_BYTES + 16:
        raise VaultError("not a sealed blob")
    nonce = blob[len(VERSION) : len(VERSION) + NONCE_BYTES]
    try:
        return _cipher().decrypt(nonce, blob[len(VERSION) + NONCE_BYTES :], _aad(purpose, owner))
    except Exception as exc:  # InvalidTag
        raise VaultError("sealed blob does not open") from exc


def seal_json(value, *, purpose: str, owner) -> bytes:
    return seal(json.dumps(value, ensure_ascii=False).encode(), purpose=purpose, owner=owner)


def open_json(blob: bytes, *, purpose: str, owner):
    return json.loads(open_(blob, purpose=purpose, owner=owner))
