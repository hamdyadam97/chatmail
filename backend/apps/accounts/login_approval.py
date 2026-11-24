"""Login from a new browser needs a one-time code from the administrators
(user decision 2026-10-31).

A browser is "known" for an account once it carries the long-lived httpOnly
device cookie whose SHA-256 is on one of the account's TrustedDevice rows.
Otherwise a correct password (and MFA) only opens a LoginApproval, and the
user chooses where its 6-digit code goes (user decision 2026-11-24): to
themselves — their other signed-in browsers (never e-mail) — or to the
approvers, central ``accounts.manage_users`` holders (in-app + e-mail); the user types it to finish the login,
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
from rest_framework.exceptions import AuthenticationFailed, ValidationError

from apps import vault
from apps.audit.services import log, request_context

from .models import LoginApproval, TrustedDevice, User
from .tokens import LOGIN_APPROVAL_TTL_SECONDS, TokenError, decode_login_approval_token

DEVICE_COOKIE = "corr_device"
DEVICE_COOKIE_MAX_AGE = 2 * 365 * 86400
MAX_ATTEMPTS = 5
APPROVER_PERMISSION = "accounts.manage_users"
APP_DEVICE_HEADER = "HTTP_X_CORR_DEVICE"


def enabled() -> bool:
    return bool(getattr(settings, "LOGIN_NEW_DEVICE_APPROVAL", False))


def _digest(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def cookie_name(user) -> str:
    """One device cookie per account, so signing in with another account in
    the same browser never replaces this one's. The name is keyed (HMAC) so it
    does not reveal the account id."""
    tag = hmac.new(settings.SECRET_KEY.encode(), f"corr-device:{user.pk}".encode(), hashlib.sha256)
    return f"{DEVICE_COOKIE}_{tag.hexdigest()[:16]}"


def known_device(user, request) -> TrustedDevice | None:
    """This browser's device row for `user`: the account's own cookie, or the
    single shared cookie of earlier releases (still honoured)."""
    if request is None:
        return None
    # The mobile app keeps its device token in secure storage and sends it
    # as a header (no cookie jar) — same secret, same check.
    candidates = [request.META.get(APP_DEVICE_HEADER, "")]
    candidates += [request.COOKIES.get(name) for name in (cookie_name(user), DEVICE_COOKIE)]
    for raw in candidates:
        if raw:
            device = TrustedDevice.objects.filter(user=user, browser_token_hash=_digest(raw)).first()
            if device is not None:
                return device
    return None


def adopt_legacy_cookie(user, request, response) -> None:
    """A browser known through the old shared cookie gets the account's own
    cookie (same token), so a later login with another account cannot erase it."""
    if request is None or request.COOKIES.get(cookie_name(user)):
        return
    raw = request.COOKIES.get(DEVICE_COOKIE)
    if raw and TrustedDevice.objects.filter(user=user, browser_token_hash=_digest(raw)).exists():
        set_device_cookie(response, user, raw)


def mark_known(device: TrustedDevice) -> str:
    """Give this browser's device row a fresh cookie token; returns the raw token."""
    raw = secrets.token_urlsafe(32)
    device.browser_token_hash = _digest(raw)
    device.save(update_fields=["browser_token_hash"])
    return raw


def set_device_cookie(response, user, raw: str) -> None:
    response.set_cookie(
        cookie_name(user),
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


def self_destinations(user) -> dict:
    """Where a code sent "to myself" can reach: the account's other signed-in
    browsers only (the code shows there under «طلبات الدخول»). Never the
    personal e-mail (user decision 2026-11-24)."""
    from .models import UserSession

    sessions = UserSession.objects.filter(
        user=user, revoked_at__isnull=True, expires_at__gt=timezone.now()
    ).exists()
    return {"sessions": sessions}


def start(user, request) -> LoginApproval:
    """Open the approval; the code goes out once the user picks where
    (send(): to themselves or to the administrators)."""
    from .api.services import parse_device_info

    code = f"{secrets.randbelow(10**6):06d}"
    label, _ = parse_device_info(request.META.get("HTTP_USER_AGENT", "") if request is not None else "")
    ctx = request_context(request)
    approval = LoginApproval(
        user=user,
        device_label=label[:255],
        ip=ctx.get("ip"),
        expires_at=timezone.now() + timedelta(seconds=LOGIN_APPROVAL_TTL_SECONDS),
    )
    approval.code_enc = vault.seal(code.encode(), purpose="login-code", owner=approval.id)
    approval.save(force_insert=True)
    log(actor=None, action="login_approval_requested", target_type="user", target_id=user.id,
        metadata={"approval_id": str(approval.id)}, **ctx)
    return approval


def pending_by_token(token: str) -> LoginApproval:
    try:
        payload = decode_login_approval_token(token)
    except TokenError:
        raise AuthenticationFailed("انتهت صلاحية طلب الدخول — سجّل الدخول من جديد.")
    approval = LoginApproval.objects.select_related("user").filter(id=payload["aid"], user_id=payload["sub"]).first()
    if approval is None or approval.status != "pending" or approval.expires_at <= timezone.now():
        raise AuthenticationFailed("انتهت صلاحية طلب الدخول أو رُفض — سجّل الدخول من جديد.")
    return approval


def send(approval: LoginApproval, to: str, request) -> None:
    """Deliver the code: "self" = the account's signed-in browsers (notification;
    the code shows on «طلبات الدخول»); "admin" = central
    accounts.manage_users holders (notification + e-mail). Each once per request."""
    from apps.notifications.email import send_email
    from apps.notifications.services import notify

    if to not in ("self", "admin"):
        raise ValidationError({"to": "self | admin"})
    if to in approval.channels:
        return
    user = approval.user
    code = code_of(approval)
    name = user.full_name or user.username
    with transaction.atomic():
        if to == "self":
            if not self_destinations(user)["sessions"]:
                raise ValidationError({"to": "لا يوجد جهاز آخر مسجّل الدخول بحسابك — أرسل الكود للمسؤول."})
            notify([user.id], "login_approval", ref_type="login_approval", ref_id=approval.id)
            reached = 1
        else:
            people = approvers()
            reached = len(people)
            notify([u.id for u in people], "login_approval", ref_type="login_approval", ref_id=approval.id)
            send_email(
                [u.optional_email for u in people],
                f"كود دخول {name}",
                f"{name} ({user.username}) يحاول الدخول من جهاز جديد: {approval.device_label}.\n\n"
                f"كود الدخول: {code}\n\n"
                "أعطه الكود فقط إن تأكدت أنه هو (اتصال أو حضوريًا). الكود صالح 30 دقيقة.\n"
                "إن لم يكن هو فارفض الطلب من صفحة «طلبات الدخول» وغيّر كلمة مروره.",
            )
        approval.sent_to = ",".join(sorted(approval.channels | {to}))
        approval.save(update_fields=["sent_to"])
    log(actor=None, action="login_approval_code_sent", target_type="user", target_id=user.id,
        metadata={"approval_id": str(approval.id), "to": to, "reached": reached}, **request_context(request))


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
    """Every live request (manage.py login_codes)."""
    now = timezone.now()
    LoginApproval.objects.filter(status="pending", expires_at__lte=now).update(status="expired")
    return LoginApproval.objects.filter(status="pending").select_related("user").order_by("-created_at")


def visible_to(viewer, *, is_approver: bool):
    """Requests whose code `viewer` may see: their own sent "to myself", and —
    for approvers — those sent to the administrators."""
    from django.db.models import Q

    q = Q(user=viewer, sent_to__contains="self")
    if is_approver:
        q |= Q(sent_to__contains="admin")
    return pending().filter(q)


def reject(approval: LoginApproval, by, request) -> None:
    if approval.status != "pending":
        return
    approval.status = "rejected"
    approval.rejected_by = by
    approval.decided_at = timezone.now()
    approval.save(update_fields=["status", "rejected_by", "decided_at"])
    log(actor=by, action="login_approval_rejected", target_type="user", target_id=approval.user_id,
        metadata={"approval_id": str(approval.id)}, **request_context(request))
