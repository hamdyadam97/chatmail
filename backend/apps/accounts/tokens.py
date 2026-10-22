"""JWT access tokens (PyJWT, HS256) and opaque refresh tokens.

Access token claims: sub=user id, sid=session id, device=device id, typ=access.
MFA login-intent token claims: sub=user id, iid=intent id, typ=mfa_login,
TTL <= 2 minutes.

Refresh tokens are opaque 256-bit values (secrets.token_urlsafe); only the
sha256 hex digest is persisted (user_sessions.refresh_token_hash).
"""
import hashlib
import secrets
from datetime import timedelta

import jwt
from django.conf import settings
from django.utils import timezone


class TokenError(Exception):
    pass


def _encode(payload: dict, ttl_seconds: int) -> str:
    now = timezone.now()
    payload = {**payload, "iat": now, "exp": now + timedelta(seconds=ttl_seconds)}
    return jwt.encode(
        payload, settings.AUTH_JWT_SECRET, algorithm=settings.AUTH_JWT_ALGORITHM
    )


def _decode(token: str, expected_type: str) -> dict:
    try:
        payload = jwt.decode(
            token,
            settings.AUTH_JWT_SECRET,
            algorithms=[settings.AUTH_JWT_ALGORITHM],
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc
    if payload.get("typ") != expected_type:
        raise TokenError(f"unexpected token type: {payload.get('typ')!r}")
    return payload


def issue_access_token(user, session) -> str:
    device_id = str(session.device_id) if session.device_id else None
    return _encode(
        {"sub": str(user.id), "sid": str(session.id), "device": device_id, "typ": "access"},
        settings.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    )


def decode_access_token(token: str) -> dict:
    return _decode(token, "access")


def issue_mfa_token(intent) -> str:
    return _encode(
        {"sub": str(intent.user_id), "iid": str(intent.id), "typ": "mfa_login"},
        settings.AUTH_MFA_TOKEN_TTL_SECONDS,
    )


def decode_mfa_token(token: str) -> dict:
    return _decode(token, "mfa_login")


def generate_refresh_token() -> tuple[str, str]:
    """Returns (raw_token, sha256_hex_digest)."""
    raw = secrets.token_urlsafe(32)  # 256 bits
    digest = hashlib.sha256(raw.encode()).hexdigest()
    return raw, digest
