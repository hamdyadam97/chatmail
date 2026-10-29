"""Employee administration: managed-user listing, memberships (add / end /
transfer / multi-branch), and remote session revocation.

Permissions (docs/phase1/05 §5.2):
  * listing/inspecting accounts — accounts.manage_users, scoped by the
    employee's primary membership unit;
  * memberships — org.manage_structure on every unit touched (a transfer
    needs it on both the source and the destination);
  * session revocation — accounts.manage_sessions (login only).

None of these paths reads or writes devices or crypto identities: account
administration stays technically separate from E2EE (SEC-08). Nothing here
exposes content, mailboxes or keys.
"""
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import log, request_context
from apps.authorization.services import active_assignments, grant_default_role, has_permission
from apps.org.models import Branch, Department, EmployeeMembership, Institute

from ..models import User
from .services import revoke_all_user_sessions
from .user_views import _scope_unit_for_user


def _unit_of(m: EmployeeMembership):
    return m.department or m.branch or m.institute


def _membership_dict(m: EmployeeMembership) -> dict:
    return {
        "id": str(m.id),
        "institute": {"id": str(m.institute_id), "name": m.institute.name, "code": m.institute.code},
        "branch": {"id": str(m.branch_id), "name": m.branch.name, "code": m.branch.code} if m.branch_id else None,
        "department": {"id": str(m.department_id), "name": m.department.name, "code": m.department.code}
        if m.department_id
        else None,
        "job_title": m.job_title,
        "employment_type": m.employment_type,
        "is_primary": m.is_primary,
        "started_on": m.started_on.isoformat(),
        "ended_on": m.ended_on.isoformat() if m.ended_on else None,
        "is_current": m.ended_on is None or m.ended_on >= timezone.localdate(),
    }


def managed_user_dict(u: User) -> dict:
    memberships = sorted(u.memberships.all(), key=lambda m: (not m.is_primary, m.started_on))
    return {
        "id": str(u.id),
        "username": u.username,
        "first_name": u.first_name,
        "last_name": u.last_name,
        "full_name": u.full_name,
        "phone": u.phone,
        "optional_email": u.optional_email,
        "is_active": u.is_active,
        "must_change_password": u.must_change_password,
        "mfa_enabled": u.mfa_enabled,
        "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
        "created_at": u.created_at.isoformat(),
        "deactivated_at": u.deactivated_at.isoformat() if u.deactivated_at else None,
        "active_sessions": getattr(u, "active_sessions", None),
        "memberships": [_membership_dict(m) for m in memberships],
    }


def managed_scope_q(user) -> Q | None:
    """Q over users whose PRIMARY membership lies in a unit where `user` holds
    accounts.manage_users. None = nothing; Q() = everyone (central)."""
    q = None
    for a in active_assignments(user).filter(role__role_permissions__permission__code="accounts.manage_users"):
        if a.institute_id is None and a.branch_id is None and a.department_id is None:
            return Q()
        if a.department_id:
            part = Q(memberships__is_primary=True, memberships__department_id=a.department_id)
        elif a.branch_id:
            part = Q(memberships__is_primary=True, memberships__branch_id=a.branch_id)
        else:
            part = Q(memberships__is_primary=True, memberships__institute_id=a.institute_id)
        q = part if q is None else q | part
    return q


class _Pagination(PageNumberPagination):
    page_size = 25
    page_size_query_param = "page_size"
    max_page_size = 100


class ManagedUsersView(APIView):
    """GET /users/managed/?q=&status=active|inactive|all"""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        scope = managed_scope_q(request.user)
        if scope is None:
            raise PermissionDenied("لا تملك صلاحية إدارة الحسابات.")
        qs = User.objects.filter(scope).distinct()
        state = request.query_params.get("status", "all")
        if state == "active":
            qs = qs.filter(is_active=True)
        elif state == "inactive":
            qs = qs.filter(is_active=False)
        term = (request.query_params.get("q") or "").strip()
        if term:
            qs = qs.filter(Q(full_name__icontains=term) | Q(username__icontains=term) | Q(phone__icontains=term))
        now = timezone.now()
        qs = (
            qs.annotate(
                active_sessions=Count(
                    "sessions",
                    filter=Q(sessions__revoked_at__isnull=True, sessions__expires_at__gt=now),
                    distinct=True,
                )
            )
            .prefetch_related("memberships__institute", "memberships__branch", "memberships__department")
            .order_by("full_name", "username")
        )
        paginator = _Pagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response([managed_user_dict(u) for u in page])


def _get_target(request, user_id) -> User:
    target = User.objects.filter(id=user_id).first()
    if target is None:
        raise PermissionDenied("المستخدم غير موجود.")
    return target


def _require_structure(request, unit) -> None:
    if not has_permission(request.user, "org.manage_structure", unit=unit):
        raise PermissionDenied("لا تملك صلاحية إدارة الهيكل في هذه الوحدة.")


class MembershipInputSerializer(serializers.Serializer):
    institute = serializers.PrimaryKeyRelatedField(queryset=Institute.objects.all())
    branch = serializers.PrimaryKeyRelatedField(queryset=Branch.objects.all(), required=False, allow_null=True)
    department = serializers.PrimaryKeyRelatedField(
        queryset=Department.objects.all(), required=False, allow_null=True
    )
    job_title = serializers.CharField(max_length=128, required=False, allow_blank=True, default="")
    employment_type = serializers.ChoiceField(
        choices=[c for c, _ in EmployeeMembership.EMPLOYMENT_TYPES], default="full_time"
    )
    is_primary = serializers.BooleanField(default=False)
    started_on = serializers.DateField(required=False)


def _build_membership(target, data) -> EmployeeMembership:
    m = EmployeeMembership(
        user=target,
        institute=data["institute"],
        branch=data.get("branch"),
        department=data.get("department"),
        job_title=data.get("job_title", ""),
        employment_type=data.get("employment_type", "full_time"),
        is_primary=data.get("is_primary", False),
        started_on=data.get("started_on") or timezone.localdate(),
    )
    from django.core.exceptions import ValidationError as DjangoValidationError

    try:
        m.clean()
    except DjangoValidationError as exc:
        raise ValidationError(exc.message_dict)
    return m


def _audit(request, action, target, **metadata):
    log(actor=request.user, action=action, target_type="user", target_id=target.id,
        metadata=metadata, **request_context(request))


class MembershipsView(APIView):
    """GET (manage_users or structure on the user) / POST add membership."""

    permission_classes = [IsAuthenticated]

    def get(self, request, user_id):
        target = _get_target(request, user_id)
        if not (
            has_permission(request.user, "accounts.manage_users", unit=_scope_unit_for_user(target))
            or has_permission(request.user, "org.manage_structure", unit=_scope_unit_for_user(target))
        ):
            raise PermissionDenied("لا تملك صلاحية على هذا الحساب.")
        ms = target.memberships.select_related("institute", "branch", "department").order_by("-is_primary", "started_on")
        return Response([_membership_dict(m) for m in ms])

    def post(self, request, user_id):
        target = _get_target(request, user_id)
        s = MembershipInputSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        m = _build_membership(target, s.validated_data)
        _require_structure(request, _unit_of(m))
        with transaction.atomic():
            if m.is_primary:
                current = target.memberships.filter(is_primary=True).first()
                if current is not None:
                    _require_structure(request, _unit_of(current))
                    current.is_primary = False
                    current.save(update_fields=["is_primary"])
            m.save()
            if m.is_primary:
                grant_default_role(target, m.institute, granted_by=request.user, request=request)
        _audit(request, "membership_added", target, membership_id=str(m.id), is_primary=m.is_primary)
        return Response(_membership_dict(m), status=status.HTTP_201_CREATED)


class MembershipDetailSerializer(serializers.Serializer):
    job_title = serializers.CharField(max_length=128, required=False, allow_blank=True)
    make_primary = serializers.BooleanField(required=False)
    end = serializers.BooleanField(required=False)


class MembershipDetailView(APIView):
    """PATCH: edit job title, make primary, or end (secondary memberships)."""

    permission_classes = [IsAuthenticated]

    def patch(self, request, user_id, membership_id):
        target = _get_target(request, user_id)
        m = target.memberships.select_related("institute", "branch", "department").filter(id=membership_id).first()
        if m is None:
            raise PermissionDenied("العضوية غير موجودة.")
        _require_structure(request, _unit_of(m))
        s = MembershipDetailSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        with transaction.atomic():
            if "job_title" in d:
                m.job_title = d["job_title"]
                m.save(update_fields=["job_title"])
            if d.get("make_primary") and not m.is_primary:
                if m.ended_on is not None:
                    raise ValidationError({"make_primary": "لا تصبح عضوية منتهية رئيسية."})
                current = target.memberships.filter(is_primary=True).first()
                if current is not None:
                    _require_structure(request, _unit_of(current))
                    current.is_primary = False
                    current.save(update_fields=["is_primary"])
                m.is_primary = True
                m.save(update_fields=["is_primary"])
                grant_default_role(target, m.institute, granted_by=request.user, request=request)
            if d.get("end"):
                if m.is_primary:
                    raise ValidationError({"end": "لا تُنهى العضوية الرئيسية مباشرة — استخدم النقل أو اجعل عضوية أخرى رئيسية."})
                m.ended_on = timezone.localdate()
                m.save(update_fields=["ended_on"])
        _audit(request, "membership_changed", target, membership_id=str(m.id),
               ops=sorted(k for k, v in d.items() if v not in (None, False)))
        return Response(_membership_dict(m))


class TransferView(APIView):
    """POST: end the primary membership today and open a new primary one."""

    permission_classes = [IsAuthenticated]

    def post(self, request, user_id):
        target = _get_target(request, user_id)
        s = MembershipInputSerializer(data={**request.data, "is_primary": True})
        s.is_valid(raise_exception=True)
        new = _build_membership(target, s.validated_data)
        current = target.memberships.filter(is_primary=True).select_related("institute", "branch", "department").first()
        _require_structure(request, _unit_of(new))
        if current is not None:
            _require_structure(request, _unit_of(current))
        with transaction.atomic():
            if current is not None:
                current.is_primary = False
                current.ended_on = timezone.localdate()
                current.save(update_fields=["is_primary", "ended_on"])
            new.save()
            grant_default_role(target, new.institute, granted_by=request.user, request=request)
        _audit(request, "employee_transferred", target,
               from_membership=str(current.id) if current else None, to_membership=str(new.id))
        return Response(_membership_dict(new), status=status.HTTP_201_CREATED)


class RevokeSessionsView(APIView):
    """Sign the user out everywhere (login sessions only — devices and keys
    are untouched; revoking a device is the user's own E2EE action)."""

    permission_classes = [IsAuthenticated]

    def post(self, request, user_id):
        target = _get_target(request, user_id)
        if not has_permission(request.user, "accounts.manage_sessions", unit=_scope_unit_for_user(target)):
            raise PermissionDenied("لا تملك صلاحية إدارة جلسات هذا الحساب.")
        count = revoke_all_user_sessions(target, reason="admin_revoked")
        _audit(request, "sessions_revoked_by_admin", target, count=count)
        return Response({"revoked": count})

