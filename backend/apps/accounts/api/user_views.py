"""Users API under /api/v1/users/.

This module manages accounts and login credentials. Password reset gives
login access only: what a user can READ still derives solely from
participation (correspondence / chat / announcement rows), never from
anything set here.
"""
from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import log, primary_org_scope, request_context
from apps.authorization.services import grant_default_role, has_permission

from ..models import User
from ..password_policy import generate_temp_password, validate_password_policy
from .serializers import (
    AdminUserCreateSerializer,
    AdminUserUpdateSerializer,
    DirectoryUserSerializer,
    PublicUserSerializer,
)
from .services import revoke_all_user_sessions


ADMIN_SECTION_ROLES = {"sys_admin", "executive"}


def _scope_unit_for_user(user: User):
    """The org unit that governs admin operations on this user:
    their primary membership's most specific unit, else None (central)."""
    membership = user.memberships.filter(is_primary=True).first()
    if membership is None:
        return None
    return membership.department or membership.branch or membership.institute


def _shared_temp_password(username: str) -> str | None:
    """settings.NEW_ACCOUNT_TEMP_PASSWORD if set and acceptable for this
    username; otherwise None (the caller falls back to a random one)."""
    from django.conf import settings

    shared = getattr(settings, "NEW_ACCOUNT_TEMP_PASSWORD", "") or ""
    if not shared:
        return None
    try:
        validate_password_policy(username, shared)
    except ValidationError:
        return None
    return shared


def _require_manage_users(request, target_user: User) -> None:
    if not has_permission(
        request.user, "accounts.manage_users", unit=_scope_unit_for_user(target_user)
    ):
        raise PermissionDenied("لا تملك صلاحية إدارة هذا الحساب.")


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from apps.authorization.services import user_scope_summary

        data = PublicUserSerializer(request.user).data
        data["roles"] = user_scope_summary(request.user)
        # The «الإدارة» section is shown to the system admin and the executive
        # only (user decision 2026-11-21) — and to whoever manages roles
        # centrally, so an admin bootstrapped with older roles keeps it. Only
        # a display switch: every admin endpoint still checks its permission.
        data["show_admin"] = any(r["role"] in ADMIN_SECTION_ROLES for r in data["roles"]) or has_permission(
            request.user, "roles.manage"
        )
        # The caller's own primary institute (for its logo in the header).
        membership = request.user.memberships.filter(is_primary=True).select_related("institute").first()
        data["institute"] = (
            {"code": membership.institute.code, "name": membership.institute.name} if membership else None
        )
        return Response(data)


class MyProfileView(APIView):
    """GET: the caller's own account details (any user, own row only).
    PATCH: the caller changes their own phone / e-mail — current password
    required. Name, branch and roles stay with the administrator."""

    permission_classes = [IsAuthenticated]

    def _data(self, user):
        from apps.authorization.services import active_assignments
        from apps.external_mail.services import address_for

        membership = (
            user.memberships.filter(is_primary=True).select_related("institute", "branch", "department").first()
        )
        roles = []
        for a in active_assignments(user):
            unit = a.department or a.branch or a.institute
            roles.append({"code": a.role.code, "name": a.role.name_ar, "scope": unit.name if unit else "مركزي"})
        return {
            "id": str(user.id),
            "username": user.username,
            "full_name": user.full_name,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "phone": user.phone,
            "optional_email": user.optional_email,
            "external_address": address_for(user),
            "membership": {
                "institute": membership.institute.name,
                "branch": membership.branch.name if membership.branch_id else None,
                "department": membership.department.name if membership.department_id else None,
                "job_title": membership.job_title,
            } if membership else None,
            "roles": roles,
            "mfa_enabled": user.mfa_enabled,
            "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
            "password_changed_at": user.password_changed_at.isoformat() if user.password_changed_at else None,
        }

    def get(self, request):
        return Response(self._data(request.user))

    def patch(self, request):
        from django.core.validators import validate_email
        from django.core.exceptions import ValidationError as DjangoValidationError

        user = request.user
        body = request.data if isinstance(request.data, dict) else {}
        if not user.check_password(str(body.get("current_password") or "")):
            raise ValidationError({"current_password": "كلمة المرور الحالية غير صحيحة."})
        changed = []
        if "phone" in body:
            phone = " ".join(str(body.get("phone") or "").split())[:32]
            if phone != user.phone:
                user.phone = phone
                changed.append("phone")
        if "optional_email" in body:
            email = str(body.get("optional_email") or "").strip().lower() or None
            if email:
                try:
                    validate_email(email)
                except DjangoValidationError:
                    raise ValidationError({"optional_email": "بريد إلكتروني غير صالح."})
                if User.objects.filter(optional_email__iexact=email).exclude(id=user.id).exists():
                    raise ValidationError({"optional_email": "هذا البريد مسجّل لحساب آخر."})
            if email != user.optional_email:
                user.optional_email = email
                changed.append("optional_email")
        if changed:
            user.save(update_fields=[*changed, "updated_at"])
            log(
                actor=user,
                action="profile_updated",
                target_type="user",
                target_id=user.id,
                org_scope=primary_org_scope(user),
                **request_context(request),
                metadata={"fields": changed},
            )
        return Response(self._data(user))


class UserDirectoryView(APIView):
    """GET: every authenticated user sees the basic directory.
    POST: accounts.manage_users (scoped) creates an employee."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        users = (
            User.objects.filter(is_active=True)
            .prefetch_related("memberships__institute", "memberships__branch", "memberships__department")
            .order_by("full_name", "username")
        )
        return Response(DirectoryUserSerializer(users, many=True).data)

    def post(self, request):
        serializer = AdminUserCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        membership_data = data.get("membership")

        unit = None
        if membership_data is not None:
            unit = (
                membership_data.get("department")
                or membership_data.get("branch")
                or membership_data.get("institute")
            )
        if not has_permission(request.user, "accounts.manage_users", unit=unit):
            raise PermissionDenied("لا تملك صلاحية إنشاء حساب في هذا النطاق.")

        with transaction.atomic():
            user = User(
                username=data["username"],
                first_name=data.get("first_name", ""),
                last_name=data.get("last_name", ""),
                phone=data.get("phone", ""),
                optional_email=data.get("optional_email"),
                must_change_password=True,
            )
            password = data.get("password")
            shared_temp = _shared_temp_password(user.username) if not password else None
            if password:
                validate_password_policy(user.username, password)
                user.set_password(password)
            elif shared_temp:
                user.set_password(shared_temp)
                user.password_changed_at = timezone.now()
            else:
                # No password yet: account is unusable until an admin issues
                # a temp password via reset-password/.
                user.set_unusable_password()
            user.save()
            if membership_data is not None:
                from apps.org.models import EmployeeMembership

                EmployeeMembership.objects.create(
                    user=user,
                    institute=membership_data["institute"],
                    branch=membership_data.get("branch"),
                    department=membership_data.get("department"),
                    job_title=membership_data.get("job_title", ""),
                    employment_type=membership_data.get("employment_type", "full_time"),
                    is_primary=True,
                    started_on=timezone.now().date(),
                )
                grant_default_role(user, membership_data["institute"], granted_by=request.user, request=request)
        log(
            actor=request.user,
            action="account_created",
            target_type="user",
            target_id=user.id,
            org_scope=primary_org_scope(request.user),
            **request_context(request),
            metadata={"unit_type": type(unit).__name__ if unit is not None else "central"},
        )
        body = DirectoryUserSerializer(user).data
        if shared_temp:
            # Shown once to the creating admin; never logged or audited.
            body["temp_password"] = shared_temp
        return Response(body, status=status.HTTP_201_CREATED)


class UserDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, user_id):
        target = User.objects.filter(id=user_id).first()
        if target is None:
            raise PermissionDenied("المستخدم غير موجود.")
        if target.id != request.user.id:
            _require_manage_users(request, target)
        return Response(DirectoryUserSerializer(target).data)

    def patch(self, request, user_id):
        target = User.objects.filter(id=user_id).first()
        if target is None:
            raise PermissionDenied("المستخدم غير موجود.")
        _require_manage_users(request, target)
        serializer = AdminUserUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        if "first_name" in data or "last_name" in data:
            first = data.get("first_name", target.first_name)
            last = data.get("last_name", target.last_name)
            if (first, last) != (target.first_name, target.last_name):
                target.first_name, target.last_name = first, last
                # The name everyone sees: first + family.
                target.full_name = target.get_full_name() or target.username
                target.save(update_fields=["first_name", "last_name", "full_name", "updated_at"])
                log(
                    actor=request.user,
                    action="user_renamed",
                    target_type="user",
                    target_id=target.id,
                    org_scope=primary_org_scope(request.user),
                    **request_context(request),
                )

        if "is_active" in data and data["is_active"] != target.is_active:
            if data["is_active"]:
                target.is_active = True
                target.deactivated_at = None
                target.deactivation_reason = ""
                action = "account_activated"
            else:
                target.is_active = False
                target.deactivated_at = timezone.now()
                target.deactivation_reason = data.get("deactivation_reason", "")
                revoke_all_user_sessions(target, reason="account_deactivated")
                action = "account_deactivated"
            target.save(
                update_fields=["is_active", "deactivated_at", "deactivation_reason", "updated_at"]
            )
            log(
                actor=request.user,
                action=action,
                target_type="user",
                target_id=target.id,
                org_scope=primary_org_scope(request.user),
                **request_context(request),
                metadata={"reason": data.get("deactivation_reason", "")},
            )
        return Response(DirectoryUserSerializer(target).data)

    def delete(self, request, user_id):
        """Permanent deletion — only for an account never used (accounts.deletion)."""
        from ..deletion import delete_unused

        target = User.objects.filter(id=user_id).first()
        if target is None:
            raise PermissionDenied("المستخدم غير موجود.")
        _require_manage_users(request, target)
        if target.id == request.user.id:
            raise PermissionDenied("لا يمكنك حذف حسابك.")
        username, target_id = target.username, target.id
        with transaction.atomic():
            used = delete_unused(target)
            if used:
                return Response(
                    {"detail": "هذا الحساب استُخدم في النظام (دخول أو مراسلات أو محادثات أو سجل نشاط)، "
                               "فلا يُحذف حفاظًا على السجلات. عطّله بدلًا من ذلك.", "used": used},
                    status=status.HTTP_409_CONFLICT,
                )
            log(
                actor=request.user,
                action="account_deleted",
                target_type="user",
                target_id=target_id,
                org_scope=primary_org_scope(request.user),
                **request_context(request),
                metadata={"username": username},
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


class ResetPasswordView(APIView):
    """Login-only password reset (SEC-08).

    This endpoint is STRUCTURALLY INCAPABLE of touching crypto:
    - user_crypto_identities does not exist in this phase;
    - trusted_devices carries no key columns yet, and this code path
      never reads or writes trusted_devices at all;
    - the only state mutated is User.password (+ must_change_password)
      and revocation of user_sessions.
    The SEC-08 canary test asserts trusted_devices rows of the target
    user are byte-identical across this call.
    """

    permission_classes = [IsAuthenticated]

    def post(self, request, user_id):
        target = User.objects.filter(id=user_id).first()
        if target is None:
            raise PermissionDenied("المستخدم غير موجود.")
        _require_manage_users(request, target)

        temp_password = generate_temp_password(target.username)
        target.set_password(temp_password)
        target.must_change_password = True
        target.password_changed_at = timezone.now()
        target.save(
            update_fields=["password", "must_change_password", "password_changed_at", "updated_at"]
        )
        revoke_all_user_sessions(target, reason="password_reset")
        # NOTE: the temp password is returned exactly once in the response
        # and is NEVER written to the audit log (metadata stays clean).
        log(
            actor=request.user,
            action="password_reset",
            target_type="user",
            target_id=target.id,
            org_scope=primary_org_scope(request.user),
            **request_context(request),
        )
        return Response({"temp_password": temp_password})
