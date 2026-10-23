"""Web Push delivery (RFC 8030 + RFC 8291 payload encryption + RFC 8292 VAPID).

What a push carries: a fixed title per kind, optionally the ACTOR's display
name, a URL inside the app and a collapse tag — never a subject, body or any
other content (SEC-11). The payload is encrypted to the browser's key, so
the push service (FCM / Mozilla / WNS / Apple) only relays ciphertext; it
does see delivery timing (declared in docs).

Safety:
  * SSRF: the server POSTs to the endpoint the browser registered, so only
    the known push-service hosts are accepted (PUSH_HOST_SUFFIXES).
  * Delivery runs on a small thread pool after the transaction commits — a
    slow push service never delays an API request.
  * Endpoints answering 404/410 (unsubscribed browser) are deleted; others
    are dropped after repeated failures.
"""
import base64
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.conf import settings
from django.db import close_old_connections, transaction
from django.utils import timezone

from .models import NotificationPreference, PushSubscription

logger = logging.getLogger(__name__)

# Browser vendors' push services (Chrome/Edge-Chromium/Brave → FCM,
# Firefox → Mozilla autopush, legacy Edge → WNS, Safari → Apple).
PUSH_HOST_SUFFIXES = (
    "fcm.googleapis.com",
    "android.googleapis.com",
    "push.services.mozilla.com",
    "notify.windows.com",
    "push.apple.com",
)
MAX_FAILURES = 5
TTL_SECONDS = 24 * 3600

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="webpush")


def endpoint_allowed(endpoint: str) -> bool:
    try:
        url = urlparse(endpoint)
    except ValueError:
        return False
    host = (url.hostname or "").lower()
    return url.scheme == "https" and any(host == s or host.endswith(f".{s}") for s in PUSH_HOST_SUFFIXES)


# --- VAPID keys -----------------------------------------------------------------

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _dev_key_file() -> Path:
    return Path(settings.BASE_DIR) / "var" / "vapid-dev.key"


@lru_cache(maxsize=1)
def _private_key():
    """VAPID signing key: WEB_PUSH_VAPID_PRIVATE_KEY (base64url PKCS#8 DER).
    In DEBUG only, a key is generated once into var/ so dev just works."""
    raw = getattr(settings, "WEB_PUSH_VAPID_PRIVATE_KEY", "") or os.environ.get("WEB_PUSH_VAPID_PRIVATE_KEY", "")
    if raw:
        try:
            der = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
            return serialization.load_der_private_key(der, password=None)
        except ValueError:
            # A bad key must never break the actions that notify — push just stays off.
            logger.error("WEB_PUSH_VAPID_PRIVATE_KEY is not a valid key; web push disabled")
            return None
    if not settings.DEBUG:
        return None  # push disabled until configured
    path = _dev_key_file()
    if path.exists():
        return serialization.load_der_private_key(path.read_bytes(), password=None)
    key = ec.generate_private_key(ec.SECP256R1())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    )
    return key


def enabled() -> bool:
    return _private_key() is not None


def public_key() -> str | None:
    key = _private_key()
    if key is None:
        return None
    point = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return _b64url(point)


def generate_private_key_b64() -> str:
    """For gen-secrets: a fresh VAPID private key, env-file ready."""
    key = ec.generate_private_key(ec.SECP256R1())
    return _b64url(
        key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    )


# --- sending -----------------------------------------------------------------------

def _muted(user_ids, kind: str) -> set[str]:
    return {
        str(p.user_id)
        for p in NotificationPreference.objects.filter(user_id__in=user_ids)
        if kind in p.muted_kinds()
    }


def push_to_users(user_ids, *, kind: str, title: str, body: str = "", url: str = "/", tag: str = "") -> None:
    """Queue a push to every subscribed browser of these users (after commit)."""
    if not enabled():
        return
    ids = [str(u) for u in user_ids]
    if not ids:
        return
    muted = _muted(ids, kind)
    targets = [u for u in ids if u not in muted]
    if not targets:
        return
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag or kind}, ensure_ascii=False)
    transaction.on_commit(lambda: deliver_async(targets, payload))


def deliver_async(user_ids: list[str], payload: str) -> None:
    subs = list(PushSubscription.objects.filter(user_id__in=user_ids).values_list("id", flat=True))
    for sub_id in subs:
        _executor.submit(_deliver_one_safely, sub_id, payload)


def _deliver_one_safely(sub_id, payload: str) -> None:
    try:
        deliver_one(sub_id, payload)
    except Exception:  # never kill the worker
        logger.exception("web push delivery crashed")
    finally:
        close_old_connections()


def deliver_one(sub_id, payload: str) -> None:
    from py_vapid import Vapid01
    from pywebpush import WebPushException, webpush

    sub = PushSubscription.objects.filter(id=sub_id).first()
    if sub is None or not endpoint_allowed(sub.endpoint):
        return
    try:
        webpush(
            subscription_info={"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
            data=payload,
            vapid_private_key=Vapid01(private_key=_private_key()),
            vapid_claims={"sub": settings.WEB_PUSH_SUBJECT},
            ttl=TTL_SECONDS,
            timeout=10,
        )
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (404, 410):
            sub.delete()  # browser unsubscribed / expired
            return
        sub.failures += 1
        if sub.failures >= MAX_FAILURES:
            sub.delete()
        else:
            sub.save(update_fields=["failures"])
        logger.warning("web push failed (status=%s)", status)
        return
    sub.failures = 0
    sub.last_success_at = timezone.now()
    sub.save(update_fields=["failures", "last_success_at"])
