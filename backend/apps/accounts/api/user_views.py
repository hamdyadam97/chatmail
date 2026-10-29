"""Users API under /api/v1/users/.

SEC-08 ISOLATION CONTRACT: this module manages login credentials ONLY.
It has no import path to any crypto store: user_crypto_identities does
not exist yet, and trusted_devices crypto columns (identity_sign_pub /
kem_pub) are not part of any flow here. Password reset must never touch
device key material; the SEC-08 test locks this with a canary on
trusted_devices rows.
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


def _scope_unit_for_user(user: User):
    """The org unit that governs admin operations on this user:
    their primary membership's most specific unit, else None (central)."""
    membership = user.memberships.filter(is_primary=True).first()
    if membership is None:
        return None
    return membership.department or membership.branch or membership.institute


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
        # The caller's own primary institute (for its logo in the header).
        membership = request.user.memberships.filter(is_primary=True).select_related("institute").first()
        data["institute"] = (
            {"code": membership.institute.code, "name": membership.institute.name} if membership else None
        )
        return Response(data)


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
            if password:
                validate_password_policy(user.username, password)
                user.set_password(password)
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
        return Response(DirectoryUserSerializer(user).data, status=status.HTTP_201_CREATED)


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
