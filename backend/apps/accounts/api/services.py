"""Session lifecycle services: creation, rotation, revocation."""
from datetime import timedelta
from hashlib import sha256

from django.conf import settings
from django.db.models import F
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
    """Get or create the trusted_devices row a login binds to: one per
    (user, platform, browser label), so sessions have a device anchor."""
    user_agent = request.META.get("HTTP_USER_AGENT", "") if request is not None else ""
    label, platform = parse_device_info(user_agent)
    # Rows from the old per-device-key era may repeat a label: reuse the
    # most recently seen one.
    device = (
        TrustedDevice.objects.filter(user=user, device_label=label, platform=platform)
        .order_by(F("last_seen_at").desc(nulls_last=True), "-created_at")
        .first()
    )
    if device is None:
        device = TrustedDevice.objects.create(
            user=user, device_label=label, platform=platform, app_version="api/1.0", status="active"
        )
    elif device.status != "active":
        device.status = "active"
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


# Reuse interval. A refresh token rotated moments ago and presented again
# means the rotation's response never reached the browser (page reloaded or
# closed mid-request, two tabs racing, a dropped connection) — the cookie jar
# still holds the old token. Within this window, and only while the chain of
# successors still ends in a live session, the presenter gets that successor
# rotated instead of being logged out.
#
# Trade-off (declared): a stolen refresh token stays usable for at most this
# many seconds after a legitimate rotation. Outside the window, or once the
# successor was revoked (logout, admin sign-out, password reset), the old
# token is refused as before.
ROTATION_GRACE_SECONDS = 30
_MAX_CHAIN = 10


def live_successor_within_grace(raw_token: str) -> UserSession | None:
    if not raw_token:
        return None
    digest = sha256(raw_token.encode()).hexdigest()
    session = UserSession.objects.filter(refresh_token_hash=digest).first()
    cutoff = timezone.now() - timedelta(seconds=ROTATION_GRACE_SECONDS)
    if (
        session is None
        or session.revoked_reason != "rotated"
        or session.revoked_at is None
        or session.revoked_at < cutoff
    ):
        return None
    for _ in range(_MAX_CHAIN):
        successor = session.replaced_by
        if successor is None:
            return None
        if successor.revoked_at is None:
            return successor if successor.expires_at > timezone.now() else None
        if successor.revoked_reason != "rotated":
            return None  # ended by logout / revocation — never resurrect
        session = successor
    return None


def rotate_session(session: UserSession, request) -> tuple[UserSession, str]:
    """Revoke the presented session and mint a fresh one (rotation)."""
    revoke_session(session, reason="rotated")
    new_session, raw = create_session(session.user, request, device=session.device)
    session.replaced_by = new_session
    session.save(update_fields=["replaced_by"])
    return new_session, raw


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
