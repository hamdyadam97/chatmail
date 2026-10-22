"""Organizational structure: organizations → institutes → branches →
departments → employee memberships. See docs/phase1/04-erd.md §4.2 (أ).
"""
import uuid

from django.core.exceptions import ValidationError
from django.db import models


class Organization(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255)
    slug = models.SlugField(max_length=100, unique=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "organizations"

    def __str__(self):
        return self.name


class Institute(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization, on_delete=models.PROTECT, related_name="institutes"
    )
    name = models.CharField(max_length=255)
    code = models.CharField(max_length=32, unique=True)  # used in reference numbers
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "institutes"

    def __str__(self):
        return self.name


class Branch(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    institute = models.ForeignKey(
        Institute, on_delete=models.PROTECT, related_name="branches"
    )
    name = models.CharField(max_length=255)
    code = models.CharField(max_length=32)
    city = models.CharField(max_length=128, blank=True, default="")
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "branches"
        constraints = [
            models.UniqueConstraint(fields=["institute", "code"], name="uq_branch_institute_code"),
        ]

    def __str__(self):
        return f"{self.institute.name} — {self.name}"


class Department(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    institute = models.ForeignKey(
        Institute, on_delete=models.PROTECT, related_name="departments"
    )
    # NULL = department at institute level; otherwise hosted by that branch.
    branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True, related_name="departments"
    )
    parent = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="children"
    )
    name = models.CharField(max_length=255)
    code = models.CharField(max_length=32)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "departments"
        constraints = [
            models.UniqueConstraint(fields=["institute", "code"], name="uq_department_institute_code"),
        ]

    def clean(self):
        super().clean()
        if self.branch_id and self.branch and self.branch.institute_id != self.institute_id:
            raise ValidationError(
                {"branch": "الفرع يجب أن يتبع المعهد نفسه (branch.institute must equal institute)."}
            )
        if self.parent_id:
            if self.parent.institute_id != self.institute_id:
                raise ValidationError(
                    {"parent": "القسم الأب يجب أن يتبع المعهد نفسه."}
                )
            if self.parent.branch_id and self.parent.branch_id != self.branch_id:
                raise ValidationError(
                    {"parent": "القسم الأب يجب أن يكون في الفرع نفسه."}
                )

    def __str__(self):
        return self.name


class EmployeeMembership(models.Model):
    EMPLOYMENT_TYPES = [
        ("full_time", "دوام كامل"),
        ("part_time", "دوام جزئي"),
        ("volunteer", "تطوع"),
        ("contract", "عقد"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        "accounts.User", on_delete=models.CASCADE, related_name="memberships"
    )
    institute = models.ForeignKey(Institute, on_delete=models.PROTECT, related_name="memberships")
    branch = models.ForeignKey(
        Branch, on_delete=models.PROTECT, null=True, blank=True, related_name="memberships"
    )
    department = models.ForeignKey(
        Department, on_delete=models.PROTECT, null=True, blank=True, related_name="memberships"
    )
    job_title = models.CharField(max_length=128, blank=True, default="")
    is_primary = models.BooleanField(default=False)
    employment_type = models.CharField(max_length=32, choices=EMPLOYMENT_TYPES, default="full_time")
    started_on = models.DateField()
    ended_on = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "employee_memberships"
        constraints = [
            # One primary membership per user (partial unique index per ERD).
            models.UniqueConstraint(
                fields=["user"],
                condition=models.Q(is_primary=True),
                name="uq_user_primary_membership",
            ),
        ]
        indexes = [
            models.Index(fields=["department"], name="idx_membership_department"),
        ]

    def clean(self):
        super().clean()
        if self.branch_id and self.branch.institute_id != self.institute_id:
            raise ValidationError(
                {"branch": "الفرع يجب أن يتبع المعهد نفسه (branch.institute must equal institute)."}
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

    def __str__(self):
        return f"{self.user_id} @ {self.institute.name}"
