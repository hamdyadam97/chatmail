"""Announcements (التعاميم) — prompt §10.

Each announcement is one MLS group (``messaging.Conversation`` of type
``announcement``) holding the publisher and every resolved recipient; the
content is a single MLS application message. The audience is resolved by the
server from the org structure, snapshotted in ``AnnouncementRecipient`` and
disclosed to every recipient, whose client checks that the MLS roster holds
no undeclared member — there is no hidden reader with a decryption key.

Acknowledgements are signed by the recipient's device (Ed25519) over a
canonical payload bound to the SHA-256 of the announcement ciphertext:
integrity evidence of "who confirmed which version", not a legal signature.
"""
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class AnnouncementSequence(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    institute = models.ForeignKey("org.Institute", on_delete=models.PROTECT, related_name="+")
    year = models.IntegerField()
    last_seq = models.IntegerField(default=0)

    class Meta:
        db_table = "announcement_sequences"
        constraints = [
            models.UniqueConstraint(fields=["institute", "year"], name="uq_annseq_institute_year"),
        ]


class Announcement(models.Model):
    TARGETS = [
        ("users", "موظفون محددون"),
        ("department", "قسم"),
        ("branch", "فرع"),
        ("institute", "معهد"),
        ("all", "جميع المعاهد"),
    ]
    STATUSES = [
        ("draft", "قيد الإعداد"),
        ("published", "منشور"),
        ("withdrawn", "مسحوب"),
    ]
    PRIORITIES = [
        ("normal", "عادي"),
        ("high", "مهم"),
        ("urgent", "عاجل"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reference_number = models.CharField(max_length=64, null=True, blank=True, unique=True)
    publisher = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="published_announcements"
    )
    publisher_membership = models.ForeignKey(
        "org.EmployeeMembership", on_delete=models.PROTECT, related_name="+"
    )
    target_type = models.CharField(max_length=16, choices=TARGETS)
    target_institute = models.ForeignKey("org.Institute", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    target_branch = models.ForeignKey("org.Branch", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    target_department = models.ForeignKey(
        "org.Department", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    thread = models.OneToOneField("messaging.Conversation", on_delete=models.PROTECT, related_name="announcement")
    content_message = models.OneToOneField(
        "messaging.Message", on_delete=models.PROTECT, null=True, blank=True, related_name="announcement"
    )
    content_hash = models.BinaryField(max_length=32, null=True, blank=True)
    priority = models.CharField(max_length=16, choices=PRIORITIES, default="normal")
    requires_ack = models.BooleanField(default=True)
    ack_due_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=16, choices=STATUSES, default="draft")
    client_ref = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    published_at = models.DateTimeField(null=True, blank=True)
    withdrawn_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "announcements"
        constraints = [
            models.UniqueConstraint(fields=["publisher", "client_ref"], name="uq_announcement_client_ref"),
            models.CheckConstraint(
                condition=(
                    Q(status="draft", published_at__isnull=True, content_message__isnull=True)
                    | Q(status__in=["published", "withdrawn"], published_at__isnull=False,
                        content_message__isnull=False, reference_number__isnull=False)
                ),
                name="ck_announcement_status_consistency",
            ),
            models.CheckConstraint(
                condition=Q(requires_ack=True) | Q(ack_due_at__isnull=True),
                name="ck_announcement_due_needs_ack",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "ack_due_at"], name="idx_announcement_due"),
        ]

    @property
    def is_published(self) -> bool:
        return self.status in ("published", "withdrawn")


class AnnouncementRecipient(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    announcement = models.ForeignKey(Announcement, on_delete=models.CASCADE, related_name="recipients")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="announcement_receipts"
    )
    # "Received" = first time the recipient's client fetched it after publish.
    delivered_at = models.DateTimeField(null=True, blank=True)
    read_at = models.DateTimeField(null=True, blank=True)
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    ack_device = models.ForeignKey(
        "accounts.TrustedDevice", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    ack_payload = models.BinaryField(null=True, blank=True)
    ack_signature = models.BinaryField(max_length=64, null=True, blank=True)
    reminder_count = models.IntegerField(default=0)
    last_reminded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "announcement_recipients"
        constraints = [
            models.UniqueConstraint(fields=["announcement", "user"], name="uq_announcement_recipient"),
            models.CheckConstraint(
                condition=Q(acknowledged_at__isnull=True)
                | Q(ack_device__isnull=False, ack_payload__isnull=False, ack_signature__isnull=False),
                name="ck_ack_is_signed",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "acknowledged_at"], name="idx_ann_recipient_user_ack"),
        ]
