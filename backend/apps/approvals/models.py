"""Approval workflow engine models per docs/phase1/04-erd.md §4.2 (ح).

Templates (``ApprovalWorkflow`` + ``ApprovalStep``) describe who approves;
a request snapshots them into ``ApprovalRequestStep`` + ``ApprovalStepApprover``
at creation time so later template edits never change a running request.

Every approver must already be a participant of the correspondence: they read
it like any recipient. The engine adds no read path of its own
(docs/phase1/05 §5.3).

``ApprovalDecision.content_hash`` records which content version was decided on
(SHA-256 of the content) — evidence, NOT a legally recognized signature.
"""
import uuid

from django.conf import settings
from django.db import models
from django.db.models import F, Q

STEP_TYPES = [
    ("all", "جميع معتمدي الخطوة"),
    ("any", "أي معتمد في الخطوة"),
]


class ApprovalWorkflow(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    institute = models.ForeignKey("org.Institute", on_delete=models.PROTECT, null=True, blank=True)
    branch = models.ForeignKey("org.Branch", on_delete=models.PROTECT, null=True, blank=True)
    department = models.ForeignKey("org.Department", on_delete=models.PROTECT, null=True, blank=True)
    version = models.IntegerField(default=1)
    is_active = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="approval_workflows"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "approval_workflows"

    def __str__(self):
        return f"{self.name} v{self.version}"


class ApprovalStep(models.Model):
    """Template step. approver_selector: {"user": "<uuid>"} or
    {"role": "<role code>", "scope": "sender_institute|sender_branch|sender_department"}."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workflow = models.ForeignKey(ApprovalWorkflow, on_delete=models.CASCADE, related_name="steps")
    step_order = models.PositiveSmallIntegerField()
    step_type = models.CharField(max_length=8, choices=STEP_TYPES, default="all")
    approver_selectors = models.JSONField(default=list)
    timeout_hours = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        db_table = "approval_steps"
        constraints = [
            models.UniqueConstraint(fields=["workflow", "step_order"], name="uq_approval_step_order"),
            models.CheckConstraint(condition=Q(step_order__gte=1), name="ck_approval_step_order_pos"),
        ]


class ApprovalRequest(models.Model):
    STATUSES = [
        ("pending", "قيد الاعتماد"),
        ("approved", "معتمد"),
        ("rejected", "مرفوض"),
        ("returned", "معاد للمراجعة"),
        ("completed", "مكتمل"),
        ("cancelled", "ملغى"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workflow = models.ForeignKey(ApprovalWorkflow, on_delete=models.PROTECT, null=True, blank=True)
    workflow_version = models.IntegerField(null=True, blank=True)
    subject_type = models.CharField(max_length=32, default="correspondence")
    correspondence = models.ForeignKey(
        "correspondence.Correspondence", on_delete=models.PROTECT, related_name="approval_requests"
    )
    # SHA-256 of the correspondence's MLS ciphertext — the exact version reviewed.
    content_hash = models.BinaryField(max_length=32)
    status = models.CharField(max_length=16, choices=STATUSES, default="pending")
    current_step_order = models.PositiveSmallIntegerField(default=1)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="approval_requests"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    decided_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "approval_requests"
        constraints = [
            # At most one live request per correspondence.
            models.UniqueConstraint(
                fields=["correspondence"],
                condition=Q(status="pending"),
                name="uq_approval_one_pending_per_subject",
            ),
        ]
        indexes = [models.Index(fields=["status", "current_step_order"], name="idx_approval_status_step")]

    def __str__(self):
        return f"{self.correspondence_id}:{self.status}"


class ApprovalRequestStep(models.Model):
    STATUSES = [
        ("waiting", "بالانتظار"),
        ("active", "جارية"),
        ("approved", "معتمدة"),
        ("rejected", "مرفوضة"),
        ("returned", "معادة"),
        ("cancelled", "ملغاة"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    request = models.ForeignKey(ApprovalRequest, on_delete=models.CASCADE, related_name="steps")
    step_order = models.PositiveSmallIntegerField()
    step_type = models.CharField(max_length=8, choices=STEP_TYPES)
    status = models.CharField(max_length=16, choices=STATUSES, default="waiting")
    due_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "approval_request_steps"
        constraints = [
            models.UniqueConstraint(fields=["request", "step_order"], name="uq_request_step_order"),
        ]


class ApprovalStepApprover(models.Model):
    """One approver slot in a request step (snapshot)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    step = models.ForeignKey(ApprovalRequestStep, on_delete=models.CASCADE, related_name="approvers")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        db_table = "approval_step_approvers"
        constraints = [models.UniqueConstraint(fields=["step", "user"], name="uq_step_approver")]


class ApprovalDecision(models.Model):
    DECISIONS = [
        ("approved", "اعتماد"),
        ("rejected", "رفض"),
        ("returned", "إعادة"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    request = models.ForeignKey(ApprovalRequest, on_delete=models.CASCADE, related_name="decisions")
    step = models.ForeignKey(ApprovalRequestStep, on_delete=models.CASCADE, related_name="decisions")
    # The slot this decision fills (the assigned approver) …
    slot_user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    # … and who actually decided (differs only under delegation).
    approver = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="approval_decisions"
    )
    delegation = models.ForeignKey(
        "ApprovalDelegation", on_delete=models.PROTECT, null=True, blank=True, related_name="decisions"
    )
    decision = models.CharField(max_length=16, choices=DECISIONS)
    content_hash = models.BinaryField(max_length=32)
    decided_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "approval_decisions"
        constraints = [
            # Duplicate-approval guard: a slot is filled exactly once.
            models.UniqueConstraint(fields=["step", "slot_user"], name="uq_decision_step_slot"),
            models.CheckConstraint(
                condition=Q(delegation__isnull=False) | Q(approver=F("slot_user")),
                name="ck_decision_self_or_delegated",
            ),
        ]


class ApprovalDelegation(models.Model):
    """Temporary delegation of approval authority. The delegate still needs
    to be a participant of a correspondence to act on it (content access is
    never delegated)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    delegator = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="delegations_given"
    )
    delegate = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="delegations_received"
    )
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "approval_delegations"
        constraints = [
            models.CheckConstraint(condition=Q(ends_at__gt=F("starts_at")), name="ck_delegation_window"),
            models.CheckConstraint(condition=~Q(delegator=F("delegate")), name="ck_delegation_not_self"),
        ]
