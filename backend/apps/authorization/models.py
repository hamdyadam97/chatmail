"""RBAC models per docs/phase1/04-erd.md §4.2 (ج) and catalog/roles per
docs/phase1/05-permissions-design.md §5.2/§5.5.

The negative catalog (§5.2) is enforced statically by SEC-14 tests:
no permission may ever grant reading/decrypting content outside the
derived-participation model.
"""
import uuid

from django.core.exceptions import ValidationError
from django.db import models


class Role(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=64, unique=True)
    name_ar = models.CharField(max_length=128)
    description = models.TextField(blank=True, default="")
    is_system = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "roles"

    def __str__(self):
        return self.code


class Permission(models.Model):
    CATEGORIES = [
        ("org", "org"),
        ("accounts", "accounts"),
        ("correspondence", "correspondence"),
        ("chat", "chat"),
        ("approvals", "approvals"),
        ("archive", "archive"),
        ("reports", "reports"),
        ("audit", "audit"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.CharField(max_length=64, unique=True)
    name_ar = models.CharField(max_length=128)
    description = models.TextField(blank=True, default="")
    category = models.CharField(max_length=32, choices=CATEGORIES)

    class Meta:
        db_table = "permissions"

    def __str__(self):
        return self.code


class RolePermission(models.Model):
    role = models.ForeignKey(Role, on_delete=models.CASCADE, related_name="role_permissions")
    permission = models.ForeignKey(
        Permission, on_delete=models.CASCADE, related_name="role_permissions"
    )

    class Meta:
        db_table = "role_permissions"
        constraints = [
            models.UniqueConstraint(fields=["role", "permission"], name="pk_role_permission"),
        ]


class UserRoleAssignment(models.Model):
    """A role granted to a user within an organizational scope.
    Scope: all of institute/branch/department NULL = central/general.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="role_assignments")
    role = models.ForeignKey(Role, on_delete=models.PROTECT, related_name="assignments")
    institute = models.ForeignKey(
        "org.Institute", on_delete=models.PROTECT, null=True, blank=True, related_name="role_assignments"
    )
    branch = models.ForeignKey(
        "org.Branch", on_delete=models.PROTECT, null=True, blank=True, related_name="role_assignments"
    )
    department = models.ForeignKey(
        "org.Department", on_delete=models.PROTECT, null=True, blank=True, related_name="role_assignments"
    )
    granted_by = models.ForeignKey(
        "accounts.User", on_delete=models.PROTECT, null=True, blank=True, related_name="granted_role_assignments"
    )
    granted_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "user_role_assignments"

    def clean(self):
        super().clean()
        if self.branch_id and self.branch.institute_id != self.institute_id:
            raise ValidationError(
                {"branch": "الفرع يجب أن يتبع المعهد نفسه."}
            )
        if self.department_id:
            if self.department.institute_id != self.institute_id:
                raise ValidationError(
                    {"department": "القسم يجب أن يتبع المعهد نفسه."}
                )
            if self.department.branch_id and self.branch_id != self.department.branch_id:
                raise ValidationError(
                    {"department": "القسم يجب أن يكون في الفرع نفسه."}
                )
        # Depth order: a department scope requires the branch context.
        if self.department_id and not self.institute_id:
            raise ValidationError({"institute": "النطاق على مستوى القسم يتطلب المعهد."})
        if self.branch_id and not self.institute_id:
            raise ValidationError({"institute": "النطاق على مستوى الفرع يتطلب المعهد."})

    def __str__(self):
        return f"{self.user_id}:{self.role.code}"
