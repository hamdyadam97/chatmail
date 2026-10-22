"""Serializers for the auth endpoints and user/directory surfaces.

SECURITY: the directory/user serializers here expose ONLY basic public
fields — never password hashes, MFA state, secrets, or session data.
SEC-01/02 tests assert this contract.
"""
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers

from ..models import User


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=64)
    password = serializers.CharField(max_length=128, write_only=True)


class MFAVerifySerializer(serializers.Serializer):
    mfa_token = serializers.CharField()
    otp = serializers.CharField(min_length=6, max_length=12, write_only=True)


class OTPOnlySerializer(serializers.Serializer):
    otp = serializers.CharField(min_length=6, max_length=12, write_only=True)


class PasswordChangeSerializer(serializers.Serializer):
    old_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(min_length=1, write_only=True)


class PublicUserSerializer(serializers.ModelSerializer):
    """Minimal user shape returned by login / users:me."""

    class Meta:
        model = User
        fields = ["id", "username", "full_name", "must_change_password"]
        read_only_fields = fields


class PrimaryMembershipSerializer(serializers.Serializer):
    institute = serializers.CharField()
    branch = serializers.CharField(allow_null=True)
    department = serializers.CharField(allow_null=True)
    job_title = serializers.CharField(allow_blank=True)


class DirectoryUserSerializer(serializers.ModelSerializer):
    """Directory entry: basic fields + primary membership summary ONLY."""

    primary_membership = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "full_name", "username", "primary_membership"]
        read_only_fields = fields

    def get_primary_membership(self, obj):
        membership = (
            obj.memberships.filter(is_primary=True)
            .select_related("institute", "branch", "department")
            .first()
        )
        if membership is None:
            return None
        return {
            "institute": membership.institute.name,
            "branch": membership.branch.name if membership.branch_id else None,
            "department": membership.department.name if membership.department_id else None,
            "job_title": membership.job_title,
        }


class MembershipInputSerializer(serializers.Serializer):
    institute_id = serializers.UUIDField()
    branch_id = serializers.UUIDField(required=False, allow_null=True)
    department_id = serializers.UUIDField(required=False, allow_null=True)
    job_title = serializers.CharField(required=False, allow_blank=True, default="")
    employment_type = serializers.CharField(required=False, default="full_time")

    def validate(self, attrs):
        from apps.org.models import Branch, Department, Institute

        institute = Institute.objects.filter(id=attrs["institute_id"]).first()
        if institute is None:
            raise serializers.ValidationError({"institute_id": "المعهد غير موجود."})
        attrs["institute"] = institute
        branch = None
        if attrs.get("branch_id"):
            branch = Branch.objects.filter(id=attrs["branch_id"]).first()
            if branch is None:
                raise serializers.ValidationError({"branch_id": "الفرع غير موجود."})
        attrs["branch"] = branch
        department = None
        if attrs.get("department_id"):
            department = Department.objects.filter(id=attrs["department_id"]).first()
            if department is None:
                raise serializers.ValidationError({"department_id": "القسم غير موجود."})
        attrs["department"] = department
        probe = _membership_probe(attrs)
        try:
            probe.clean()
        except DjangoValidationError as exc:
            raise serializers.ValidationError(exc.message_dict if hasattr(exc, "message_dict") else {"detail": exc.messages})
        return attrs


def _membership_probe(attrs):
    from apps.org.models import EmployeeMembership

    return EmployeeMembership(
        user_id=None,
        institute=attrs["institute"],
        branch=attrs.get("branch"),
        department=attrs.get("department"),
        job_title=attrs.get("job_title", ""),
        employment_type=attrs.get("employment_type", "full_time"),
        is_primary=True,
        started_on=None,
    )


class AdminUserCreateSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=64)
    first_name = serializers.CharField(max_length=128, allow_blank=True, default="")
    last_name = serializers.CharField(max_length=128, allow_blank=True, default="")
    phone = serializers.CharField(max_length=32, allow_blank=True, default="")
    optional_email = serializers.EmailField(required=False, allow_null=True)
    password = serializers.CharField(
        min_length=10, required=False, allow_blank=False, write_only=True
    )
    membership = MembershipInputSerializer(required=False)

    def validate_username(self, value):
        if User.objects.filter(username=value).exists():
            raise serializers.ValidationError("اسم المستخدم مستخدم مسبقًا.")
        return value


class AdminUserUpdateSerializer(serializers.Serializer):
    is_active = serializers.BooleanField(required=False)
    deactivation_reason = serializers.CharField(
        max_length=255, required=False, allow_blank=True, default=""
    )
