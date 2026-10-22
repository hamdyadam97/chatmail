"""Session lifecycle services: creation, rotation, revocation."""
from datetime import timedelta
from hashlib import sha256

from django.conf import settings
from django.utils import timezone

from ..models import TrustedDevice, UserSession
from ..tokens import generate_refresh_token


def parse_device_info(user_agent: str) -> tuple[str, str]:
    """Derive a human-ish (device_label, platform) from a User-Agent header."""
    ua = user_agent or ""
    platform = "unknown"
    for token, name in [
        ("Windows", "windows"),
        ("Android", "android"),
        ("iPhone", "ios"),
        ("iPad", "ios"),
        ("Mac OS", "macos"),
        ("Linux", "linux"),
    ]:
        if token in ua:
            platform = name
            break
    browser = "unknown"
    for token, name in [
        ("Edg/", "Edge"),
        ("Chrome/", "Chrome"),
        ("Firefox/", "Firefox"),
        ("Safari/", "Safari"),
    ]:
        if token in ua:
            browser = name
            break
    label = f"{browser} — {platform}" if ua else "unknown device"
    return label, platform


def ensure_active_device(user, request) -> TrustedDevice:
    """Get or create the placeholder trusted_devices binding for a login.

    Real device identity (Ed25519/HPKE public keys) arrives in the crypto
    phase; for now a login binds to an active placeholder row per
    (user, platform, browser label) so sessions have a device anchor.
    """
    user_agent = request.META.get("HTTP_USER_AGENT", "") if request is not None else ""
    label, platform = parse_device_info(user_agent)
    device, created = TrustedDevice.objects.get_or_create(
        user=user,
        device_label=label,
        platform=platform,
        defaults={"app_version": "api/1.0", "status": "active"},
    )
    if not created:
        changed = False
        if device.status != "active":
            device.status = "active"
            changed = True
        if changed:
            device.save(update_fields=["status"])
    device.last_seen_at = timezone.now()
    device.save(update_fields=["last_seen_at"])
    return device


def _client_ip(request) -> str | None:
    if request is None:
        return None
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded:
        return forwarded.split(",")[0].strip() or None
    return request.META.get("REMOTE_ADDR")


def create_session(user, request, device=None) -> tuple[UserSession, str]:
    if device is None:
        device = ensure_active_device(user, request)
    raw, digest = generate_refresh_token()
    session = UserSession.objects.create(
        user=user,
        device=device,
        refresh_token_hash=digest,
        ip=_client_ip(request),
        user_agent=request.META.get("HTTP_USER_AGENT", "") if request is not None else "",
        expires_at=timezone.now()
        + timedelta(days=settings.AUTH_REFRESH_TOKEN_TTL_DAYS),
    )
    return session, raw


def get_session_by_refresh_token(raw_token: str) -> UserSession | None:
    if not raw_token:
        return None
    digest = sha256(raw_token.encode()).hexdigest()
    session = UserSession.objects.filter(refresh_token_hash=digest).first()
    if session is None:
        return None
    if session.revoked_at is not None or session.expires_at <= timezone.now():
        return None
    return session


# A refresh token rotated moments ago and presented again is a benign race
# (two tabs, or a double-fired page boot), not theft: the browser already
# holds the newer cookie. The refresh endpoint answers 401 WITHOUT clearing
# that cookie so the winner's session survives.
ROTATION_GRACE_SECONDS = 30


def recently_rotated(raw_token: str) -> bool:
    if not raw_token:
        return False
    digest = sha256(raw_token.encode()).hexdigest()
    return UserSession.objects.filter(
        refresh_token_hash=digest,
        revoked_reason="rotated",
        revoked_at__gte=timezone.now() - timedelta(seconds=ROTATION_GRACE_SECONDS),
    ).exists()


def rotate_session(session: UserSession, request) -> tuple[UserSession, str]:
    """Revoke the presented session and mint a fresh one (rotation)."""
    revoke_session(session, reason="rotated")
    return create_session(
        session.user, request, device=session.device
    )


def revoke_session(session: UserSession, reason: str) -> None:
    if session.revoked_at is None:
        session.revoked_at = timezone.now()
        session.revoked_reason = reason
        session.save(update_fields=["revoked_at", "revoked_reason"])


def revoke_all_user_sessions(user, exclude_ids=(), reason: str = "revoked") -> int:
    """Revoke every active session of a user; returns the count revoked."""
    now = timezone.now()
    qs = UserSession.objects.filter(
        user=user, revoked_at__isnull=True, expires_at__gt=now
    ).exclude(id__in=exclude_ids)
    count = qs.count()
    qs.update(revoked_at=now, revoked_reason=reason)
    return count
