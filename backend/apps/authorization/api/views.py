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


class AssignmentSerializer(serializers.ModelSerializer):
    user_id = serializers.UUIDField()
    role_code = serializers.CharField(max_length=64)
    institute_id = serializers.UUIDField(required=False, allow_null=True)
    branch_id = serializers.UUIDField(required=False, allow_null=True)
    department_id = serializers.UUIDField(required=False, allow_null=True)

    class Meta:
        model = UserRoleAssignment
        fields = [
            "id",
            "user_id",
            "role_code",
            "institute_id",
            "branch_id",
            "department_id",
            "granted_at",
            "expires_at",
        ]
        read_only_fields = ["id", "granted_at"]

    def validate(self, attrs):
        user = User.objects.filter(id=attrs["user_id"]).first()
        if user is None:
            raise serializers.ValidationError({"user_id": "المستخدم غير موجود."})
        role = Role.objects.filter(code=attrs["role_code"]).first()
        if role is None:
            raise serializers.ValidationError({"role_code": "الدور غير موجود."})
        attrs["user"] = user
        attrs["role"] = role

        institute = branch = department = None
        if attrs.get("institute_id"):
            institute = Institute.objects.filter(id=attrs["institute_id"]).first()
            if institute is None:
                raise serializers.ValidationError({"institute_id": "المعهد غير موجود."})
        if attrs.get("branch_id"):
            branch = Branch.objects.filter(id=attrs["branch_id"]).first()
            if branch is None:
                raise serializers.ValidationError({"branch_id": "الفرع غير موجود."})
        if attrs.get("department_id"):
            department = Department.objects.filter(id=attrs["department_id"]).first()
            if department is None:
                raise serializers.ValidationError({"department_id": "القسم غير موجود."})
        attrs["institute"] = institute
        attrs["branch"] = branch
        attrs["department"] = department

        probe = UserRoleAssignment(
            user=user,
            role=role,
            institute=institute,
            branch=branch,
            department=department,
        )
        try:
            probe.clean()
        except DjangoValidationError as exc:
            raise serializers.ValidationError(
                exc.message_dict if hasattr(exc, "message_dict") else {"detail": exc.messages}
            )
        return attrs


class AssignmentReadSerializer(serializers.ModelSerializer):
    user = serializers.CharField(source="user.username")
    role = serializers.CharField(source="role.code")

    class Meta:
        model = UserRoleAssignment
        fields = [
            "id",
            "user",
            "role",
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
        _require_roles_manage(request)
        serializer = AssignmentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        assignment = UserRoleAssignment.objects.create(
            user=data["user"],
            role=data["role"],
            institute=data.get("institute"),
            branch=data.get("branch"),
            department=data.get("department"),
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
                    "institute": assignment.institute.code if assignment.institute_id else None,
                    "branch": assignment.branch.code if assignment.branch_id else None,
                    "department": assignment.department.code if assignment.department_id else None,
                },
            },
        )
        return Response(
            AssignmentReadSerializer(assignment).data, status=status.HTTP_201_CREATED
        )


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

        roles = Role.objects.prefetch_related("role_permissions__permission").order_by("code")
        return Response(
            [
                {
                    "code": r.code,
                    "name_ar": r.name_ar,
                    "permissions": sorted(
                        ({"code": rp.permission.code, "name_ar": rp.permission.name_ar} for rp in r.role_permissions.all()),
                        key=lambda p: p["code"],
                    ),
                }
                for r in roles
            ]
        )
