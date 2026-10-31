"""Auth API views under /api/v1/auth/.

Contract (frontend depends on this):
  POST login/            -> {access, mfa_required:false, user:{...}} + refresh cookie
                          | {mfa_required:true, mfa_token}
  POST mfa/verify/       -> {access, mfa_required:false, user:{...}} + refresh cookie
                          (login and mfa/verify answer {approval_required:true,
                          approval_token} instead when the browser is new and
                          LOGIN_NEW_DEVICE_APPROVAL is on — see login_approval)
  POST login/code/       -> {approval_token, code} -> like login, + device cookie
  GET  login-approvals/  -> pending new-browser logins with their codes (approvers)
  POST login-approvals/{id}/reject/
  POST refresh/          -> {access} + rotated refresh cookie
  POST logout/           -> revokes the cookie session, clears the cookie
  GET  sessions/         -> own sessions list
  DELETE sessions/{id}/  -> revoke one own session
  POST password/change/  -> change own password, revoke other sessions
  POST mfa/setup|enable|disable/
"""
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from pyotp import TOTP
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import log, primary_org_scope, request_context

from .. import login_approval
from ..crypto import decrypt_secret, encrypt_secret
from ..models import LoginApproval, LoginIntent, TrustedDevice, User, UserSession
from ..tokens import (
    TokenError,
    decode_mfa_token,
    issue_access_token,
    issue_login_approval_token,
    issue_mfa_token,
)
from .serializers import (
    LoginSerializer,
    MFAVerifySerializer,
    OTPOnlySerializer,
    PasswordChangeSerializer,
    PublicUserSerializer,
)
from .services import (
    create_session,
    parse_device_info,
    get_session_by_refresh_token,
    live_successor_within_grace,
    revoke_all_user_sessions,
    revoke_session,
    rotate_session,
)
from ..throttles import LoginIPThrottle, LoginUsernameThrottle, MFAVerifyIPThrottle


def _set_refresh_cookie(response: Response, raw_token: str) -> None:
    response.set_cookie(
        settings.AUTH_REFRESH_COOKIE_NAME,
        raw_token,
        max_age=settings.AUTH_REFRESH_TOKEN_TTL_DAYS * 86400,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
        httponly=True,
        samesite="Strict",
        secure=getattr(settings, "AUTH_REFRESH_COOKIE_SECURE", False),
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        settings.AUTH_REFRESH_COOKIE_NAME,
        path=settings.AUTH_REFRESH_COOKIE_PATH,
    )


def _new_browser_device(user, request) -> tuple[TrustedDevice, str]:
    """A device row of its own for this browser, marked known (cookie token)."""
    label, platform = parse_device_info(request.META.get("HTTP_USER_AGENT", "") if request is not None else "")
    device = TrustedDevice.objects.create(
        user=user, device_label=label, platform=platform, app_version="api/1.0", status="active",
        last_seen_at=timezone.now(),
    )
    return device, login_approval.mark_known(device)


def _complete_login(user, request) -> Response:
    """After all credential checks: a known browser (or approvals off) gets a
    session; a new browser gets a login-approval challenge instead."""
    device = login_approval.known_device(user, request)
    if device is None and login_approval.enabled():
        approval = login_approval.start(user, request)
        return Response(
            {"approval_required": True, "mfa_required": False, "approval_token": issue_login_approval_token(approval)}
        )
    raw_device = None
    if device is None:
        device, raw_device = _new_browser_device(user, request)
    else:
        device.last_seen_at = timezone.now()
        device.status = "active"
        device.save(update_fields=["last_seen_at", "status"])
    return _issue_session(user, request, device, raw_device)


def _issue_session(user, request, device, raw_device=None) -> Response:
    session, raw_refresh = create_session(user, request, device=device)
    access = issue_access_token(user, session)
    log(
        actor=user,
        actor_device=session.device,
        action="login",
        target_type="user",
        target_id=user.id,
        org_scope=primary_org_scope(user),
        **request_context(request),
    )
    response = Response(
        {
            "access": access,
            "mfa_required": False,
            "user": PublicUserSerializer(user).data,
        }
    )
    _set_refresh_cookie(response, raw_refresh)
    if raw_device:
        login_approval.set_device_cookie(response, raw_device)
    return response


def _authenticate_credentials(username: str, password: str):
    user = User.objects.filter(username=username).first()
    if user is None or not user.check_password(password) or not user.is_active:
        return None
    return user


class LoginView(APIView):
    throttle_classes = [LoginIPThrottle, LoginUsernameThrottle]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        username = serializer.validated_data["username"]
        password = serializer.validated_data["password"]

        user = _authenticate_credentials(username, password)
        if user is None:
            # actor=None for failures: identity is NOT proven at this point.
            known = User.objects.filter(username=username).first()
            log(
                actor=None,
                action="login_failed",
                target_type="user",
                target_id=known.id if known else None,
                **request_context(request),
                metadata={"reason": "invalid_credentials_or_inactive"},
            )
            raise AuthenticationFailed("بيانات الدخول غير صحيحة.")

        user.last_login_at = timezone.now()
        user.save(update_fields=["last_login_at"])

        if user.mfa_enabled:
            intent = LoginIntent.objects.create(
                user=user,
                expires_at=timezone.now()
                + timedelta(seconds=settings.AUTH_MFA_TOKEN_TTL_SECONDS),
            )
            log(
                actor=user,
                action="login_mfa_challenge_issued",
                target_type="user",
                target_id=user.id,
                org_scope=primary_org_scope(user),
                **request_context(request),
            )
            return Response(
                {"mfa_required": True, "mfa_token": issue_mfa_token(intent)}
            )

        return _complete_login(user, request)


class MFAVerifyView(APIView):
    throttle_classes = [MFAVerifyIPThrottle]

    def post(self, request):
        serializer = MFAVerifySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        mfa_token = serializer.validated_data["mfa_token"]
        otp = serializer.validated_data["otp"]

        try:
            payload = decode_mfa_token(mfa_token)
        except TokenError:
            raise AuthenticationFailed("رمز MFA غير صالح أو منتهي.")

        now = timezone.now()
        intent = (
            LoginIntent.objects.filter(id=payload["iid"], user_id=payload["sub"])
            .select_related("user")
            .first()
        )
        if (
            intent is None
            or intent.consumed_at is not None
            or intent.expires_at <= now
            or not intent.user.mfa_enabled
        ):
            raise AuthenticationFailed("رمز MFA غير صالح أو منتهي.")

        user = intent.user
        try:
            secret = decrypt_secret(user.mfa_secret_ciphertext)
        except Exception:
            raise AuthenticationFailed("لم يُهيأ MFA بشكل صحيح لهذا الحساب.")

        if not TOTP(secret).verify(otp, valid_window=settings.AUTH_MFA_TOTP_VALID_WINDOW):
            log(
                actor=None,
                action="mfa_verify_failed",
                target_type="user",
                target_id=user.id,
                **request_context(request),
            )
            raise AuthenticationFailed("رمز التحقق غير صحيح.")

        intent.consumed_at = now
        intent.save(update_fields=["consumed_at"])
        return _complete_login(user, request)


class LoginCodeView(APIView):
    """Finish a new-browser login with the code the administrators gave."""

    throttle_classes = [MFAVerifyIPThrottle]

    def post(self, request):
        token = str(request.data.get("approval_token") or "")
        code = str(request.data.get("code") or "")
        approval = login_approval.verify(token, code, request)
        device, raw_device = _new_browser_device(approval.user, request)
        log(actor=approval.user, actor_device=device, action="login_approval_used", target_type="user",
            target_id=approval.user_id, metadata={"approval_id": str(approval.id)}, **request_context(request))
        return _issue_session(approval.user, request, device, raw_device)


def _require_approver(request) -> None:
    from apps.authorization.services import has_permission

    if not has_permission(request.user, login_approval.APPROVER_PERMISSION, unit=None):
        raise PermissionDenied("طلبات الدخول متاحة لمسؤولي الحسابات المركزيين فقط.")


class LoginApprovalListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        _require_approver(request)
        rows = login_approval.pending()
        return Response([
            {
                "id": str(a.id),
                "user": {"id": str(a.user_id), "full_name": a.user.full_name, "username": a.user.username},
                "device_label": a.device_label,
                "ip": a.ip,
                "code": login_approval.code_of(a),
                "attempts": a.attempts,
                "created_at": a.created_at.isoformat(),
                "expires_at": a.expires_at.isoformat(),
            }
            for a in rows
        ])


class LoginApprovalRejectView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, approval_id):
        _require_approver(request)
        approval = LoginApproval.objects.filter(id=approval_id).first()
        if approval is None:
            raise ValidationError({"detail": "طلب غير موجود."})
        login_approval.reject(approval, request.user, request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RefreshView(APIView):
    def post(self, request):
        raw = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME)
        session = get_session_by_refresh_token(raw or "")
        if session is None:
            # Reuse interval: the previous rotation's response was lost (page
            # left mid-request, racing tabs). Rotate the live successor instead
            # of logging the user out — see services.live_successor_within_grace.
            with transaction.atomic():
                successor = live_successor_within_grace(raw or "")
                if successor is not None:
                    successor = UserSession.objects.select_for_update().get(pk=successor.pk)
                    if successor.revoked_at is not None:  # rotated concurrently: follow on
                        successor = live_successor_within_grace(raw or "")
                if successor is not None:
                    new_session, raw_refresh = rotate_session(successor, request)
            if successor is None:
                response = Response(
                    {"detail": "جلسة غير صالحة."}, status=status.HTTP_401_UNAUTHORIZED
                )
                _clear_refresh_cookie(response)
                return response
            access = issue_access_token(new_session.user, new_session)
            response = Response({"access": access})
            _set_refresh_cookie(response, raw_refresh)
            return response
        new_session, raw_refresh = rotate_session(session, request)
        access = issue_access_token(new_session.user, new_session)
        response = Response({"access": access})
        _set_refresh_cookie(response, raw_refresh)
        # Browsers signed in before new-browser approval existed become known
        # through their live session (no code needed for them).
        device = new_session.device
        if (device is not None and not device.browser_token_hash
                and login_approval.known_device(new_session.user, request) is None):
            login_approval.set_device_cookie(response, login_approval.mark_known(device))
        return response


class LogoutView(APIView):
    def post(self, request):
        raw = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME)
        session = get_session_by_refresh_token(raw or "")
        if session is not None:
            revoke_session(session, reason="logout")
            log(
                actor=session.user,
                actor_device=session.device,
                action="logout",
                target_type="user",
                target_id=session.user_id,
                org_scope=primary_org_scope(session.user),
                **request_context(request),
            )
        response = Response(status=status.HTTP_204_NO_CONTENT)
        _clear_refresh_cookie(response)
        return response


class PasswordChangeView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        from ..password_policy import validate_password_policy

        serializer = PasswordChangeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        old = serializer.validated_data["old_password"]
        new = serializer.validated_data["new_password"]

        if not user.check_password(old):
            raise ValidationError({"old_password": "كلمة المرور الحالية غير صحيحة."})
        validate_password_policy(user.username, new)

        user.set_password(new)
        user.must_change_password = False
        user.password_changed_at = timezone.now()
        user.save(update_fields=["password", "must_change_password", "password_changed_at", "updated_at"])

        current_sid = None
        if isinstance(request.auth, dict):
            current_sid = request.auth.get("sid")
        revoked = revoke_all_user_sessions(
            user, exclude_ids=[current_sid] if current_sid else (), reason="password_changed"
        )
        log(
            actor=user,
            action="password_changed",
            target_type="user",
            target_id=user.id,
            org_scope=primary_org_scope(user),
            **request_context(request),
            metadata={"other_sessions_revoked": revoked},
        )
        return Response({"detail": "تم تغيير كلمة المرور."})


class MFASetupView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        user = request.user
        if user.mfa_enabled:
            raise ValidationError({"detail": "MFA مفعّل مسبقًا."})
        import pyotp

        secret = pyotp.random_base32()
        user.mfa_secret_ciphertext = encrypt_secret(secret)
        user.save(update_fields=["mfa_secret_ciphertext", "updated_at"])
        uri = pyotp.TOTP(secret).provisioning_uri(
            name=user.username, issuer_name=settings.TOTP_ISSUER_NAME
        )
        log(
            actor=user,
            action="mfa_setup",
            target_type="user",
            target_id=user.id,
            org_scope=primary_org_scope(user),
            **request_context(request),
            metadata={"method": "totp"},
        )
        return Response({"otpauth_uri": uri, "secret": secret})


class MFAEnableView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = OTPOnlySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        if user.mfa_enabled:
            raise ValidationError({"detail": "MFA مفعّل مسبقًا."})
        try:
            secret = decrypt_secret(user.mfa_secret_ciphertext)
        except Exception:
            raise ValidationError({"otp": "يجب بدء إعداد MFA أولًا (mfa/setup)."})
        if not TOTP(secret).verify(
            serializer.validated_data["otp"],
            valid_window=settings.AUTH_MFA_TOTP_VALID_WINDOW,
        ):
            log(
                actor=None,
                action="mfa_verify_failed",
                target_type="user",
                target_id=user.id,
                **request_context(request),
            )
            raise ValidationError({"otp": "رمز التحقق غير صحيح."})
        user.mfa_enabled = True
        user.mfa_method = "totp"
        user.save(update_fields=["mfa_enabled", "mfa_method", "updated_at"])
        log(
            actor=user,
            action="mfa_enabled",
            target_type="user",
            target_id=user.id,
            org_scope=primary_org_scope(user),
            **request_context(request),
            metadata={"method": "totp"},
        )
        return Response({"detail": "تم تفعيل MFA."})


class MFADisableView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = OTPOnlySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = request.user
        if not user.mfa_enabled:
            raise ValidationError({"detail": "MFA غير مفعّل."})
        try:
            secret = decrypt_secret(user.mfa_secret_ciphertext)
        except Exception:
            secret = None
        if secret is None or not TOTP(secret).verify(
            serializer.validated_data["otp"],
            valid_window=settings.AUTH_MFA_TOTP_VALID_WINDOW,
        ):
            log(
                actor=None,
                action="mfa_verify_failed",
                target_type="user",
                target_id=user.id,
                **request_context(request),
            )
            raise ValidationError({"otp": "رمز التحقق غير صحيح."})
        user.mfa_enabled = False
        user.mfa_method = ""
        user.mfa_secret_ciphertext = None
        user.save(update_fields=["mfa_enabled", "mfa_method", "mfa_secret_ciphertext", "updated_at"])
        log(
            actor=user,
            action="mfa_disabled",
            target_type="user",
            target_id=user.id,
            org_scope=primary_org_scope(user),
            **request_context(request),
        )
        return Response({"detail": "تم تعطيل MFA."})


class SessionListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        now = timezone.now()
        sessions = (
            request.user.sessions.filter(revoked_at__isnull=True)
            .filter(expires_at__gt=now)
            .select_related("device")
            .order_by("-created_at")
        )
        current_sid = request.auth.get("sid") if isinstance(request.auth, dict) else None
        data = [
            {
                "id": str(s.id),
                "device_label": s.device.device_label if s.device_id else "جهاز غير معروف",
                "ip": s.ip,
                "user_agent": s.user_agent[:200],
                "created_at": s.created_at,
                "current": str(s.id) == str(current_sid),
            }
            for s in sessions
        ]
        return Response(data)


class SessionRevokeView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, session_id):
        session = request.user.sessions.filter(id=session_id).first()
        if session is None:
            raise PermissionDenied("الجلسة غير موجودة.")
        revoke_session(session, reason="user_revoked")
        log(
            actor=request.user,
            actor_device=session.device,
            action="session_revoked",
            target_type="user_session",
            target_id=session.id,
            org_scope=primary_org_scope(request.user),
            **request_context(request),
            metadata={"session_user": str(session.user_id)},
        )
        response = Response(status=status.HTTP_204_NO_CONTENT)
        current_sid = request.auth.get("sid") if isinstance(request.auth, dict) else None
        if current_sid and str(session.id) == str(current_sid):
            _clear_refresh_cookie(response)
        return response
