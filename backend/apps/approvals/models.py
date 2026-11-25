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
    # A request type (expense, leave…): employees file it with a document from
    # «طلب جديد», and every approval stamps the approver's signature on it.
    signable = models.BooleanField(default=False)
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
    # Signed requests: the uploaded document (as PDF) and its latest signed copy.
    source_file = models.ForeignKey(
        "correspondence.StoredFile", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    signed_file = models.ForeignKey(
        "correspondence.StoredFile", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    signature_count = models.PositiveSmallIntegerField(default=0)
    # Pages of the document, and how many signatures each page already carries
    # ({"1": 2, "3": 1}) — every approver chooses the page they sign.
    page_count = models.PositiveSmallIntegerField(default=0)  # 0 = not counted yet (older requests)
    page_signatures = models.JSONField(default=dict, blank=True)
    # Where each stamped box sits: [{"page", "x", "y", "w", "h"}] in PDF points
    # from the page's top-left — a new signature may not cover an earlier one.
    signature_boxes = models.JSONField(default=list, blank=True)
    # Resubmitting a returned request with a new document starts a new round:
    # everyone signs the new file; the earlier round's decisions stay recorded.
    round = models.PositiveSmallIntegerField(default=1)
    # «يُرسل بعد الاعتماد إلى»: on final approval the (signed) letter goes to
    # these people from the final approver, the requester in CC.
    deliver_to = models.JSONField(default=list, blank=True)
    deliver_cc = models.JSONField(default=list, blank=True)
    delivered_correspondence = models.ForeignKey(
        "correspondence.Correspondence", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

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
        # The executive decided the request directly, before this step was reached.
        ("skipped", "تم تخطيها"),
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
    # «تأجيل»: the approver keeps the request and decides later (cleared on decision).
    deferred_at = models.DateTimeField(null=True, blank=True)

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
    # Signed requests: the code printed in the signature box (XXXX-XXXX) —
    # anyone in the system checks it at «التحقق من توقيع».
    verify_code = models.CharField(max_length=9, null=True, blank=True, unique=True)
    signed_page = models.PositiveSmallIntegerField(null=True, blank=True)
    round = models.PositiveSmallIntegerField(default=1)

    class Meta:
        db_table = "approval_decisions"
        constraints = [
            # Duplicate-approval guard: a slot is filled exactly once per round.
            models.UniqueConstraint(fields=["step", "slot_user", "round"], name="uq_decision_step_slot_round"),
            models.CheckConstraint(
                condition=Q(delegation__isnull=False) | Q(approver=F("slot_user")),
                name="ck_decision_self_or_delegated",
            ),
        ]


class ApprovalEvent(models.Model):
    """The request's timeline: every decision, deferral and resubmission, with
    the optional note (sealed, apps.vault purpose "approval-note", bound to
    the row). Notifications never carry the note (SEC-11)."""

    KINDS = [
        ("approved", "اعتماد"),
        ("rejected", "رفض"),
        ("returned", "إعادة للمراجعة"),
        ("deferred", "تأجيل"),
        ("resubmitted", "إعادة إرسال"),
        ("resubmitted_file", "إعادة إرسال بملف جديد"),
        ("skipped", "تخطٍّ من المدير التنفيذي"),
        # The same person approves a later step too: their earlier approval counts.
        ("carried", "اعتماد سابق يُحتسب"),
        # The executive reminded the earlier approvers to sign.
        ("reminded", "تذكير بالتوقيع"),
        # The only approver so far took their approval (and signature) back: the round restarts.
        ("withdrawn", "سحب الاعتماد"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    request = models.ForeignKey(ApprovalRequest, on_delete=models.CASCADE, related_name="events")
    round = models.PositiveSmallIntegerField(default=1)
    step_order = models.PositiveSmallIntegerField()
    kind = models.CharField(max_length=20, choices=KINDS)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    # Delegated decisions: the approver whose slot was filled.
    on_behalf_of = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    note_enc = models.BinaryField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "approval_events"
        indexes = [models.Index(fields=["request", "created_at"], name="idx_approval_event_time")]


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


class UserSignature(models.Model):
    """An approver's handwritten signature, drawn once and reused for signed
    requests. Sealed (apps.vault, purpose "signature", bound to the user)."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="signature"
    )
    image_enc = models.BinaryField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "user_signatures"
