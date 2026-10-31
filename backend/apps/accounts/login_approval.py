"""Login from a new browser needs a one-time code from the administrators
(user decision 2026-10-31).

A browser is "known" for an account once it carries the long-lived httpOnly
device cookie whose SHA-256 is on one of the account's TrustedDevice rows.
Otherwise a correct password (and MFA) only opens a LoginApproval: a 6-digit
code goes to the approvers — central ``accounts.manage_users`` holders — as
an in-app notification and an e-mail; the user types it to finish the login,
and the browser becomes known. Codes live 30 minutes, allow 5 attempts, and
are sealed at rest. ``manage.py login_codes`` shows pending codes to root on
the server (the way in when no approver can be reached).
"""
import hashlib
import hmac
import secrets
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed

from apps import vault
from apps.audit.services import log, request_context

from .models import LoginApproval, TrustedDevice, User
from .tokens import LOGIN_APPROVAL_TTL_SECONDS, TokenError, decode_login_approval_token

DEVICE_COOKIE = "corr_device"
DEVICE_COOKIE_MAX_AGE = 2 * 365 * 86400
MAX_ATTEMPTS = 5
APPROVER_PERMISSION = "accounts.manage_users"


def enabled() -> bool:
    return bool(getattr(settings, "LOGIN_NEW_DEVICE_APPROVAL", False))


def _digest(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def known_device(user, request) -> TrustedDevice | None:
    raw = request.COOKIES.get(DEVICE_COOKIE) if request is not None else None
    if not raw:
        return None
    return TrustedDevice.objects.filter(user=user, browser_token_hash=_digest(raw)).first()


def mark_known(device: TrustedDevice) -> str:
    """Give this browser's device row a fresh cookie token; returns the raw token."""
    raw = secrets.token_urlsafe(32)
    device.browser_token_hash = _digest(raw)
    device.save(update_fields=["browser_token_hash"])
    return raw


def set_device_cookie(response, raw: str) -> None:
    response.set_cookie(
        DEVICE_COOKIE,
        raw,
        max_age=DEVICE_COOKIE_MAX_AGE,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
        httponly=True,
        samesite="Strict",
        secure=getattr(settings, "AUTH_REFRESH_COOKIE_SECURE", False),
    )


def approvers() -> list[User]:
    from apps.authorization.services import has_permission

    candidates = User.objects.filter(is_active=True, role_assignments__isnull=False).distinct()
    return [u for u in candidates if has_permission(u, APPROVER_PERMISSION, unit=None)]


def code_of(approval: LoginApproval) -> str:
    return vault.open_(approval.code_enc, purpose="login-code", owner=approval.id).decode()


def start(user, request) -> LoginApproval:
    from apps.notifications.email import send_email
    from apps.notifications.services import notify

    from .api.services import parse_device_info

    code = f"{secrets.randbelow(10**6):06d}"
    label, _ = parse_device_info(request.META.get("HTTP_USER_AGENT", "") if request is not None else "")
    ctx = request_context(request)
    with transaction.atomic():
        approval = LoginApproval(
            user=user,
            device_label=label[:255],
            ip=ctx.get("ip"),
            expires_at=timezone.now() + timedelta(seconds=LOGIN_APPROVAL_TTL_SECONDS),
        )
        approval.code_enc = vault.seal(code.encode(), purpose="login-code", owner=approval.id)
        approval.save(force_insert=True)
        people = approvers()
        notify([u.id for u in people], "login_approval", ref_type="login_approval", ref_id=approval.id)
        name = user.full_name or user.username
        send_email(
            [u.optional_email for u in people],
            f"كود دخول {name}",
            f"{name} ({user.username}) يحاول الدخول من جهاز جديد: {label}.\n\n"
            f"كود الدخول: {code}\n\n"
            "أعطه الكود فقط إن تأكدت أنه هو (اتصال أو حضوريًا). الكود صالح 30 دقيقة.\n"
            "إن لم يكن هو فارفض الطلب من صفحة «طلبات الدخول» وغيّر كلمة مروره.",
        )
    log(actor=None, action="login_approval_requested", target_type="user", target_id=user.id,
        metadata={"approval_id": str(approval.id), "approvers": len(people)}, **ctx)
    return approval


def verify(token: str, code: str, request) -> LoginApproval:
    """The approval the code opens, or AuthenticationFailed (attempts counted)."""
    try:
        payload = decode_login_approval_token(token)
    except TokenError:
        raise AuthenticationFailed("انتهت صلاحية طلب الدخول — سجّل الدخول من جديد.")
    failed = False
    with transaction.atomic():
        approval = (
            LoginApproval.objects.select_for_update().select_related("user")
            .filter(id=payload["aid"], user_id=payload["sub"]).first()
        )
        if approval is None or approval.status != "pending" or approval.expires_at <= timezone.now():
            raise AuthenticationFailed("انتهت صلاحية طلب الدخول أو رُفض — سجّل الدخول من جديد.")
        if not approval.user.is_active:
            raise AuthenticationFailed("الحساب معطّل.")
        if hmac.compare_digest(code_of(approval), (code or "").strip()):
            approval.status = "used"
            approval.decided_at = timezone.now()
            approval.save(update_fields=["status", "decided_at"])
        else:
            failed = True
            approval.attempts += 1
            if approval.attempts >= MAX_ATTEMPTS:
                approval.status = "expired"
                approval.decided_at = timezone.now()
            approval.save(update_fields=["attempts", "status", "decided_at"])
    if failed:
        log(actor=None, action="login_approval_code_failed", target_type="user",
            target_id=approval.user_id, **request_context(request))
        raise AuthenticationFailed("الكود غير صحيح.")
    return approval


def pending():
    now = timezone.now()
    LoginApproval.objects.filter(status="pending", expires_at__lte=now).update(status="expired")
    return LoginApproval.objects.filter(status="pending").select_related("user").order_by("-created_at")


def reject(approval: LoginApproval, by, request) -> None:
    if approval.status != "pending":
        return
    approval.status = "rejected"
    approval.rejected_by = by
    approval.decided_at = timezone.now()
    approval.save(update_fields=["status", "rejected_by", "decided_at"])
    log(actor=by, action="login_approval_rejected", target_type="user", target_id=approval.user_id,
        metadata={"approval_id": str(approval.id)}, **request_context(request))
