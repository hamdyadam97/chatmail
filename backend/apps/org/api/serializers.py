"""Serializers for the org structure API."""
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from ..models import Branch, Department, Institute, Organization


class OrganizationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Organization
        fields = ["id", "name", "slug", "is_active"]


class InstituteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Institute
        fields = ["id", "name", "code", "is_active", "created_at"]
        read_only_fields = ["created_at"]


class BranchSerializer(serializers.ModelSerializer):
    class Meta:
        model = Branch
        fields = ["id", "institute", "name", "code", "city", "is_active", "created_at"]
        read_only_fields = ["created_at"]

    def validate(self, attrs):
        institute = attrs.get("institute")
        if institute is None and self.instance is not None:
            institute = self.instance.institute
        code = attrs.get("code", getattr(self.instance, "code", ""))
        duplicate = Branch.objects.filter(institute=institute, code=code)
        if self.instance is not None:
            duplicate = duplicate.exclude(id=self.instance.id)
        if duplicate.exists():
            raise serializers.ValidationError({"code": "يوجد فرع بنفس الرمز في هذا المعهد."})
        probe = Branch(
            id=getattr(self.instance, "id", None),
            institute=institute,
            name=attrs.get("name", getattr(self.instance, "name", "")),
            code=code,
            city=attrs.get("city", getattr(self.instance, "city", "")),
        )
        try:
            probe.clean()
        except DjangoValidationError as exc:
            raise serializers.ValidationError(
                exc.message_dict if hasattr(exc, "message_dict") else {"detail": exc.messages}
            )
        return attrs


class DepartmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Department
        fields = ["id", "institute", "branch", "parent", "name", "code", "created_at"]
        read_only_fields = ["created_at"]

    def validate(self, attrs):
        institute = attrs.get("institute")
        if institute is None and self.instance is not None:
            institute = self.instance.institute
        code = attrs.get("code", getattr(self.instance, "code", ""))
        duplicate = Department.objects.filter(institute=institute, code=code)
        if self.instance is not None:
            duplicate = duplicate.exclude(id=self.instance.id)
        if duplicate.exists():
            raise serializers.ValidationError({"code": "يوجد قسم بنفس الرمز في هذا المعهد."})
        probe = Department(
            id=getattr(self.instance, "id", None),
            institute=institute,
            branch=attrs.get("branch", getattr(self.instance, "branch", None)),
            parent=attrs.get("parent", getattr(self.instance, "parent", None)),
            name=attrs.get("name", getattr(self.instance, "name", "")),
            code=code,
        )
        try:
            probe.clean()
        except DjangoValidationError as exc:
            raise serializers.ValidationError(
                exc.message_dict if hasattr(exc, "message_dict") else {"detail": exc.messages}
            )
        return attrs
