"""Org structure API under /api/v1/org/.

Reads are open to any authenticated user. Writes require
org.manage_structure with an assignment whose scope covers the affected
unit (institute creation is central-only).
"""
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import log, primary_org_scope, request_context
from apps.authorization.services import has_permission

from ..models import Branch, Department, Institute
from .serializers import BranchSerializer, DepartmentSerializer, InstituteSerializer


def _require_structure_perm(request, unit) -> None:
    if not has_permission(request.user, "org.manage_structure", unit=unit):
        raise PermissionDenied("لا تملك صلاحية إدارة الهيكل التنظيمي في هذا النطاق.")


class InstituteListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        institutes = Institute.objects.select_related("organization").order_by("name")
        return Response(InstituteSerializer(institutes, many=True).data)

    def post(self, request):
        # Creating an institute is a central-level operation.
        _require_structure_perm(request, None)
        serializer = InstituteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        from ..models import Organization

        org = Organization.objects.filter(is_active=True).first()
        if org is None:
            raise serializers.ValidationError({"detail": "لا توجد منظمة نشطة."})
        institute = Institute.objects.create(
            organization=org, name=serializer.validated_data["name"], code=serializer.validated_data["code"]
        )
        log(
            actor=request.user,
            action="org_structure_changed",
            target_type="institute",
            target_id=institute.id,
            org_scope=primary_org_scope(request.user),
            **request_context(request),
            metadata={"op": "create", "code": institute.code},
        )
        return Response(InstituteSerializer(institute).data, status=201)


class BranchListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        branches = Branch.objects.select_related("institute").order_by("institute__name", "name")
        return Response(BranchSerializer(branches, many=True).data)

    def post(self, request):
        serializer = BranchSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # Scope: the parent institute of the new branch.
        _require_structure_perm(request, serializer.validated_data["institute"])
        branch = Branch.objects.create(
            institute=serializer.validated_data["institute"],
            name=serializer.validated_data["name"],
            code=serializer.validated_data["code"],
            city=serializer.validated_data.get("city", ""),
        )
        log(
            actor=request.user,
            action="org_structure_changed",
            target_type="branch",
            target_id=branch.id,
            org_scope=primary_org_scope(request.user),
            **request_context(request),
            metadata={"op": "create", "code": branch.code, "institute": branch.institute.code},
        )
        return Response(BranchSerializer(branch).data, status=201)


class BranchDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def patch(self, request, branch_id):
        branch = Branch.objects.filter(id=branch_id).first()
        if branch is None:
            raise PermissionDenied("الفرع غير موجود.")
        _require_structure_perm(request, branch)
        serializer = BranchSerializer(branch, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        log(
            actor=request.user,
            action="org_structure_changed",
            target_type="branch",
            target_id=branch.id,
            org_scope=primary_org_scope(request.user),
            **request_context(request),
            metadata={"op": "update", "code": branch.code},
        )
        return Response(BranchSerializer(branch).data)


class DepartmentListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        departments = (
            Department.objects.select_related("institute", "branch", "parent")
            .order_by("institute__name", "name")
        )
        return Response(DepartmentSerializer(departments, many=True).data)

    def post(self, request):
        serializer = DepartmentSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        # Scope: the most specific parent context of the new department.
        unit = data.get("branch") or data["institute"]
        _require_structure_perm(request, unit)
        department = Department.objects.create(
            institute=data["institute"],
            branch=data.get("branch"),
            parent=data.get("parent"),
            name=data["name"],
            code=data["code"],
        )
        log(
            actor=request.user,
            action="org_structure_changed",
            target_type="department",
            target_id=department.id,
            org_scope=primary_org_scope(request.user),
            **request_context(request),
            metadata={"op": "create", "code": department.code, "institute": department.institute.code},
        )
        return Response(DepartmentSerializer(department).data, status=201)


class DepartmentDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def patch(self, request, department_id):
        department = Department.objects.filter(id=department_id).first()
        if department is None:
            raise PermissionDenied("القسم غير موجود.")
        _require_structure_perm(request, department)
        serializer = DepartmentSerializer(department, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        log(
            actor=request.user,
            action="org_structure_changed",
            target_type="department",
            target_id=department.id,
            org_scope=primary_org_scope(request.user),
            **request_context(request),
            metadata={"op": "update", "code": department.code},
        )
        return Response(DepartmentSerializer(department).data)
