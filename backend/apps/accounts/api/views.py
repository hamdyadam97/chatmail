"""Auth API views under /api/v1/auth/.

Contract (frontend depends on this):
  POST login/            -> {access, mfa_required:false, user:{...}} + refresh cookie
                          | {mfa_required:true, mfa_token}
  POST mfa/verify/       -> {access, mfa_required:false, user:{...}} + refresh cookie
  POST refresh/          -> {access} + rotated refresh cookie
  POST logout/           -> revokes the cookie session, clears the cookie
  GET  sessions/         -> own sessions list
  DELETE sessions/{id}/  -> revoke one own session
  POST password/change/  -> change own password, revoke other sessions
  POST mfa/setup|enable|disable/
"""
from datetime import timedelta

from django.conf import settings
from django.utils import timezone
from pyotp import TOTP
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import log, primary_org_scope, request_context

from ..crypto import decrypt_secret, encrypt_secret
from ..models import LoginIntent, User
from ..tokens import (
    TokenError,
    decode_mfa_token,
    issue_access_token,
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
    get_session_by_refresh_token,
    revoke_all_user_sessions,
    revoke_session,
    recently_rotated,
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


def _complete_login(user, request) -> Response:
    """Issue session + tokens after all credentials checks passed."""
    session, raw_refresh = create_session(user, request)
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


class RefreshView(APIView):
    def post(self, request):
        raw = request.COOKIES.get(settings.AUTH_REFRESH_COOKIE_NAME)
        session = get_session_by_refresh_token(raw or "")
        if session is None:
            if recently_rotated(raw or ""):
                # Lost a concurrent-refresh race; the newer cookie is already
                # in the browser — keep it (no Set-Cookie here), client retries.
                return Response(
                    {"detail": "تم تجديد الجلسة للتو.", "code": "refresh_superseded"},
                    status=status.HTTP_401_UNAUTHORIZED,
                )
            response = Response(
                {"detail": "جلسة غير صالحة."}, status=status.HTTP_401_UNAUTHORIZED
            )
            _clear_refresh_cookie(response)
            return response
        new_session, raw_refresh = rotate_session(session, request)
        access = issue_access_token(new_session.user, new_session)
        response = Response({"access": access})
        _set_refresh_cookie(response, raw_refresh)
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
