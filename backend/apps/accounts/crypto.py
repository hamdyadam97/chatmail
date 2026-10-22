"""Server-side encryption for MFA TOTP secrets (login-only data).

Key source: AUTH_FERNET_KEY env var (base64 32-byte Fernet key).
In dev/test a deterministic default is derived and a warning is emitted
(see config/settings/base.py); production MUST set AUTH_FERNET_KEY and in
the target deployment it is KMS-managed like all server-side wrapping keys.
"""
from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings


def _fernet() -> Fernet:
    key = settings.AUTH_FERNET_KEY
    if isinstance(key, str):
        key = key.encode()
    return Fernet(key)


def encrypt_secret(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt_secret(ciphertext) -> str:
    if ciphertext is None:
        raise InvalidToken("no ciphertext")
    if isinstance(ciphertext, memoryview):
        ciphertext = ciphertext.tobytes()
    return _fernet().decrypt(bytes(ciphertext)).decode()
