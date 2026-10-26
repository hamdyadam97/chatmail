"""Server-side sealing for external mail (mirror of frontend crypto/archive.ts).

seal: X25519(ephemeral, recipient) -> HKDF-SHA256(salt = eph_pub || recipient_pub,
info = SEAL_INFO) -> AES-256-GCM with a context AAD. The server holds no key
that opens the result: only the recipient device's KEM private key does.

Attachments use the client's format exactly (crypto/content.ts):
blob = IV(12) || AES-256-GCM(file, AAD "corr-attachment-v1"), with the raw key
and the blob's SHA-256 carried inside the sealed content.
"""
import base64
import hashlib
import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

SEAL_INFO = b"corr-external-seal-v1"
ATTACHMENT_AAD = b"corr-attachment-v1"


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def copy_aad(message_id, device_id) -> bytes:
    return f"corr-external-v1|{message_id}|{device_id}".encode()


def _raw_pub(key) -> bytes:
    return key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def _key(shared: bytes, eph_pub: bytes, recipient_pub: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=eph_pub + recipient_pub, info=SEAL_INFO).derive(shared)


def seal(recipient_pub: bytes, plaintext: bytes, aad: bytes) -> tuple[bytes, bytes, bytes]:
    """-> (ephemeral_pub, iv, ciphertext)"""
    eph = X25519PrivateKey.generate()
    eph_pub = _raw_pub(eph.public_key())
    shared = eph.exchange(X25519PublicKey.from_public_bytes(recipient_pub))
    iv = os.urandom(12)
    return eph_pub, iv, AESGCM(_key(shared, eph_pub, recipient_pub)).encrypt(iv, plaintext, aad)


def unseal(recipient_priv: X25519PrivateKey, eph_pub: bytes, iv: bytes, ciphertext: bytes, aad: bytes) -> bytes:
    """Used by the tests (the real opener is the browser)."""
    shared = recipient_priv.exchange(X25519PublicKey.from_public_bytes(eph_pub))
    recipient_pub = _raw_pub(recipient_priv.public_key())
    return AESGCM(_key(shared, eph_pub, recipient_pub)).decrypt(iv, ciphertext, aad)


def encrypt_attachment(data: bytes) -> tuple[bytes, str, str]:
    """-> (blob, raw key b64, blob sha256 b64) in the client attachment format."""
    key = os.urandom(32)
    iv = os.urandom(12)
    blob = iv + AESGCM(key).encrypt(iv, data, ATTACHMENT_AAD)
    return blob, b64(key), b64(hashlib.sha256(blob).digest())
