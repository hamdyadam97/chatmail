"""Role assignment management API under /api/v1/roles/assignments/.

Gated by roles.manage which is CENTRAL-ONLY (per docs/phase1 §5.2):
a scoped assignment of roles.manage grants nothing here.
"""
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.models import User
from apps.audit.services import log, primary_org_scope, request_context
from apps.org.models import Branch, Department, Institute

from ..models import Role, UserRoleAssignment
from ..services import has_permission


class AssignmentSerializer(serializers.Serializer):
    """One role for one user. The regional manager takes several branches
    (branch_ids) — one assignment per branch. A branch implies its institute."""

    user_id = serializers.UUIDField()
    role_code = serializers.CharField(max_length=64)
    institute_id = serializers.UUIDField(required=False, allow_null=True)
    branch_id = serializers.UUIDField(required=False, allow_null=True)
    branch_ids = serializers.ListField(child=serializers.UUIDField(), required=False, max_length=500)
    department_id = serializers.UUIDField(required=False, allow_null=True)
    expires_at = serializers.DateTimeField(required=False, allow_null=True)

    def validate(self, attrs):
        from ..roles import ASSIGNABLE, SCOPE_ERRORS, scope_ok

        user = User.objects.filter(id=attrs["user_id"]).first()
        if user is None:
            raise serializers.ValidationError({"user_id": "المستخدم غير موجود."})
        role = Role.objects.filter(code=attrs["role_code"]).first()
        if role is None:
            raise serializers.ValidationError({"role_code": "الدور غير موجود."})
        kind = ASSIGNABLE.get(role.code)
        if kind is None:
            raise serializers.ValidationError({"role_code": "هذا الدور لم يعد يُسند."})
        attrs["user"], attrs["role"] = user, role

        institute = department = None
        if attrs.get("institute_id"):
            institute = Institute.objects.filter(id=attrs["institute_id"]).first()
            if institute is None:
                raise serializers.ValidationError({"institute_id": "المعهد غير موجود."})
        if attrs.get("department_id"):
            department = Department.objects.filter(id=attrs["department_id"]).first()
            if department is None:
                raise serializers.ValidationError({"department_id": "القسم غير موجود."})
        branch_ids = list(dict.fromkeys(attrs.get("branch_ids") or []))
        if attrs.get("branch_id"):
            branch_ids = list(dict.fromkeys([attrs["branch_id"], *branch_ids]))
        branches = list(Branch.objects.filter(id__in=branch_ids).select_related("institute"))
        if len(branches) != len(branch_ids):
            raise serializers.ValidationError({"branch_id": "الفرع غير موجود."})
        if kind == "branch" and len(branches) > 1:
            raise serializers.ValidationError({"branch_id": SCOPE_ERRORS["branch"]})

        scopes = []
        for branch in branches or [None]:
            if branch is not None and institute is not None and branch.institute_id != institute.id:
                raise serializers.ValidationError({"branch": "الفرع يجب أن يتبع المعهد نفسه."})
            inst = branch.institute if branch is not None else institute
            if not scope_ok(kind, institute=inst, branch=branch, department=department):
                raise serializers.ValidationError({"role_code": SCOPE_ERRORS[kind]})
            probe = UserRoleAssignment(user=user, role=role, institute=inst, branch=branch, department=department)
            try:
                probe.clean()
            except DjangoValidationError as exc:
                raise serializers.ValidationError(
                    exc.message_dict if hasattr(exc, "message_dict") else {"detail": exc.messages}
                )
            scopes.append((inst, branch))
        attrs["scopes"] = scopes
        return attrs


class AssignmentReadSerializer(serializers.ModelSerializer):
    user = serializers.CharField(source="user.username")
    role = serializers.CharField(source="role.code")
    role_name = serializers.CharField(source="role.name_ar")
    full_name = serializers.CharField(source="user.full_name")

    class Meta:
        model = UserRoleAssignment
        fields = [
            "id",
            "user",
            "full_name",
            "role",
            "role_name",
            "institute",
            "branch",
            "department",
            "granted_by",
            "granted_at",
            "expires_at",
        ]


def _require_roles_manage(request) -> None:
    if not has_permission(request.user, "roles.manage", unit=None):
        raise PermissionDenied("صلاحية إسناد الأدوار مركزية فقط (roles.manage).")


class AssignmentListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        _require_roles_manage(request)
        qs = UserRoleAssignment.objects.select_related(
            "user", "role", "institute", "branch", "department", "granted_by"
        ).order_by("-granted_at")
        username = request.query_params.get("user")
        if username:
            qs = qs.filter(user__username=username)
        return Response(AssignmentReadSerializer(qs, many=True).data)

    def post(self, request):
        from ..services import active_assignments

        _require_roles_manage(request)
        serializer = AssignmentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        created = []
        for institute, branch in data["scopes"]:
            if active_assignments(data["user"]).filter(role=data["role"], institute=institute, branch=branch,
                                                       department__isnull=True).exists():
                continue  # already held there
            assignment = UserRoleAssignment.objects.create(
                user=data["user"],
                role=data["role"],
                institute=institute,
                branch=branch,
                granted_by=request.user,
                expires_at=data.get("expires_at"),
            )
            log(
                actor=request.user,
                action="permission_granted",
                target_type="user_role_assignment",
                target_id=assignment.id,
                org_scope=primary_org_scope(request.user),
                **request_context(request),
                metadata={
                    "user": assignment.user.username,
                    "role": assignment.role.code,
                    "scope": {
                        "institute": institute.code if institute else None,
                        "branch": branch.code if branch else None,
                        "department": None,
                    },
                },
            )
            created.append(assignment)
        if not created:
            raise serializers.ValidationError({"role_code": "الموظف يحمل هذا الدور في هذا النطاق بالفعل."})
        body = AssignmentReadSerializer(created, many=True).data
        return Response(body[0] if len(body) == 1 else body, status=status.HTTP_201_CREATED)


class AssignmentRevokeView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, assignment_id):
        _require_roles_manage(request)
        assignment = UserRoleAssignment.objects.filter(id=assignment_id).first()
        if assignment is None:
            raise PermissionDenied("الإسناد غير موجود.")
        log(
            actor=request.user,
            action="permission_revoked",
            target_type="user_role_assignment",
            target_id=assignment.id,
            org_scope=primary_org_scope(request.user),
            **request_context(request),
            metadata={"user": assignment.user.username, "role": assignment.role.code},
        )
        assignment.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class RoleCatalogView(APIView):
    """What each role grants — readable by every authenticated user
    (transparency: nobody holds a hidden content-access permission)."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from ..models import Role

        from django.db.models import Count, Q
        from django.utils import timezone

        from ..roles import ASSIGNABLE, ORDER

        now = timezone.now()
        roles = Role.objects.prefetch_related("role_permissions__permission").annotate(
            holders=Count("assignments", filter=Q(assignments__expires_at__isnull=True)
                          | Q(assignments__expires_at__gt=now), distinct=True)
        )
        # The five assignable roles first, in order; legacy ones only while someone still holds them.
        roles = sorted(
            (r for r in roles if r.code in ASSIGNABLE or r.holders),
            key=lambda r: (ORDER.index(r.code) if r.code in ASSIGNABLE else len(ORDER), r.code),
        )
        return Response(
            [
                {
                    "code": r.code,
                    "name_ar": r.name_ar,
                    "assignable": r.code in ASSIGNABLE,
                    "scope": ASSIGNABLE.get(r.code),
                    "holders": r.holders,
                    "permissions": sorted(
                        ({"code": rp.permission.code, "name_ar": rp.permission.name_ar} for rp in r.role_permissions.all()),
                        key=lambda p: p["code"],
                    ),
                }
                for r in roles
            ]
        )
