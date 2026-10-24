"""Official correspondence models per docs/phase1/04-erd.md §4.2 (د + ز).

Encryption model (docs/phase1/03-key-management.md §3.4): every correspondence
thread is one MLS group, carried by a ``messaging.Conversation`` of type
``correspondence``. The encrypted subject + body + per-attachment file keys of
one correspondence travel together as a single MLS application message
(``content_message``). The server stores only that opaque ciphertext plus
metadata (reference number, priority, dates, who-is-addressed) — never the
subject, body, file names or file keys.

Authorization to read (docs/phase1/05-permissions-design.md §5.3) derives
exclusively from ``CorrespondenceParticipant`` rows; no role grants it.
"""
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class ReferenceSequence(models.Model):
    """Per-institute, per-year counter for reference numbers.

    Allocation happens inside a transaction holding a row lock
    (``select_for_update``) — see services.allocate_reference_number.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    institute = models.ForeignKey(
        "org.Institute", on_delete=models.PROTECT, related_name="reference_sequences"
    )
    year = models.IntegerField()
    last_seq = models.IntegerField(default=0)

    class Meta:
        db_table = "reference_sequences"
        constraints = [
            models.UniqueConstraint(fields=["institute", "year"], name="uq_refseq_institute_year"),
            models.CheckConstraint(condition=Q(last_seq__gte=0), name="ck_refseq_nonnegative"),
        ]

    def __str__(self):
        return f"{self.institute_id}:{self.year}:{self.last_seq}"


class ImmutableCorrespondenceError(Exception):
    """Raised when code tries to alter a correspondence after it was sent."""


# Frozen once sent. Only ``status`` may still move (sent -> closed).
IMMUTABLE_AFTER_SEND = (
    "reference_number",
    "sender_id",
    "sender_membership_id",
    "thread_id",
    "thread_root_id",
    "reply_to_id",
    "content_message_id",
    "priority",
    "classification",
    "due_date",
    "sent_at",
    "client_ref",
)


class Correspondence(models.Model):
    PRIORITIES = [
        ("low", "منخفضة"),
        ("normal", "عادية"),
        ("high", "عالية"),
        ("urgent", "عاجلة"),
    ]
    CLASSIFICATIONS = [
        ("normal", "عادية"),
        ("confidential", "سرية"),
        # Declared institutional-archive policy (docs/phase1/05 §5.5) — the
        # archive copy itself is a later phase; the flag is metadata only.
        ("institutional_archive_eligible", "قابلة للأرشفة المؤسسية"),
    ]
    STATUSES = [
        # Thread prepared (MLS group being set up), content not yet sent.
        # Visible to the sender only. User-facing drafts stay on the device.
        ("draft", "قيد الإعداد"),
        ("sent", "مرسلة"),
        ("closed", "مغلقة"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    reference_number = models.CharField(max_length=64, null=True, blank=True, unique=True)
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="sent_correspondences"
    )
    # The organizational capacity the sender writes in (issues the reference).
    sender_membership = models.ForeignKey(
        "org.EmployeeMembership", on_delete=models.PROTECT, related_name="correspondences"
    )
    thread = models.ForeignKey(
        "messaging.Conversation", on_delete=models.PROTECT, related_name="correspondences"
    )
    thread_root = models.ForeignKey(
        "self", on_delete=models.PROTECT, null=True, blank=True, related_name="thread_items"
    )
    reply_to = models.ForeignKey(
        "self", on_delete=models.PROTECT, null=True, blank=True, related_name="replies"
    )
    # Opaque MLS application message: encrypted {subject, body, attachment keys}.
    content_message = models.OneToOneField(
        "messaging.Message",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="correspondence",
    )
    priority = models.CharField(max_length=16, choices=PRIORITIES, default="normal")
    classification = models.CharField(max_length=40, choices=CLASSIFICATIONS, default="normal")
    status = models.CharField(max_length=16, choices=STATUSES, default="draft")
    due_date = models.DateField(null=True, blank=True)
    # Idempotency key chosen by the client for the prepare call.
    client_ref = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "correspondences"
        constraints = [
            models.UniqueConstraint(fields=["sender", "client_ref"], name="uq_corr_sender_client_ref"),
            # A draft carries nothing that only exists once sent; a sent item
            # carries all of it (immutability anchor).
            models.CheckConstraint(
                condition=(
                    Q(
                        status="draft",
                        sent_at__isnull=True,
                        reference_number__isnull=True,
                        content_message__isnull=True,
                    )
                    | Q(
                        status__in=["sent", "closed"],
                        sent_at__isnull=False,
                        reference_number__isnull=False,
                        content_message__isnull=False,
                    )
                ),
                name="ck_corr_status_consistency",
            ),
            models.CheckConstraint(
                condition=Q(reply_to__isnull=True) | Q(thread_root__isnull=False),
                name="ck_corr_reply_has_root",
            ),
        ]
        indexes = [
            models.Index(fields=["sender", "-sent_at"], name="idx_corr_sender_sent"),
            models.Index(fields=["thread_root"], name="idx_corr_thread_root"),
            models.Index(fields=["status", "due_date"], name="idx_corr_status_due"),
        ]

    def __str__(self):
        return self.reference_number or f"draft:{self.id}"

    def save(self, *args, **kwargs):
        if not self._state.adding:
            stored = Correspondence.objects.filter(pk=self.pk).values(
                "status", *IMMUTABLE_AFTER_SEND
            ).first()
            if stored and stored["status"] in ("sent", "closed"):
                changed = [f for f in IMMUTABLE_AFTER_SEND if stored[f] != getattr(self, f)]
                if changed or self.status not in ("sent", "closed"):
                    raise ImmutableCorrespondenceError(
                        f"sent correspondence is immutable (attempted: {changed or ['status']})"
                    )
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        if self.is_sent:
            raise ImmutableCorrespondenceError("sent correspondence cannot be deleted")
        return super().delete(*args, **kwargs)

    @property
    def is_sent(self) -> bool:
        return self.status in ("sent", "closed")


class CorrespondenceParticipant(models.Model):
    """Who a correspondence is addressed to — and the ONLY source of read rights.

    ``kind='from'`` is the sender's own row (folder flags for Sent/Archived);
    to/cc rows are recipients. Folder flags (archived/important) and read_at
    are per-user metadata, never content.
    """

    KINDS = [
        ("from", "المرسل"),
        ("to", "إلى"),
        ("cc", "نسخة"),
        ("bcc", "نسخة مخفية"),
    ]
    ADDED_VIA = [
        ("original", "أصلي"),
        ("reply", "رد"),
        ("forward", "إحالة"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    correspondence = models.ForeignKey(
        Correspondence, on_delete=models.CASCADE, related_name="participants"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="correspondence_participations",
    )
    kind = models.CharField(max_length=8, choices=KINDS)
    added_via = models.CharField(max_length=16, choices=ADDED_VIA, default="original")
    hidden_from_others = models.BooleanField(default=False)
    read_at = models.DateTimeField(null=True, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    is_important = models.BooleanField(default=False)
    removed_at = models.DateTimeField(null=True, blank=True)
    # Due-date reminders already sent to this participant (each stage once).
    due_reminded_at = models.DateTimeField(null=True, blank=True)
    overdue_notified_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "correspondence_participants"
        constraints = [
            models.UniqueConstraint(fields=["correspondence", "user"], name="uq_corr_participant"),
            models.CheckConstraint(
                condition=Q(kind="bcc") | Q(hidden_from_others=False),
                name="ck_corr_participant_hidden_only_bcc",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "kind", "read_at"], name="idx_corr_part_inbox"),
        ]

    def __str__(self):
        return f"{self.correspondence_id}:{self.user_id}:{self.kind}"


class CorrespondenceForwarding(models.Model):
    """Forward = a NEW thread whose content the forwarder re-encrypted.

    The new recipients never join the source thread's MLS group, so they get
    exactly what was forwarded and nothing else of the source thread.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source = models.ForeignKey(
        Correspondence, on_delete=models.PROTECT, related_name="forwardings"
    )
    forwarded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="correspondence_forwards"
    )
    new_correspondence = models.OneToOneField(
        Correspondence, on_delete=models.CASCADE, related_name="forwarded_from"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "correspondence_forwardings"

    def __str__(self):
        return f"{self.source_id}->{self.new_correspondence_id}"


class CorrespondenceEvent(models.Model):
    """Timeline of a correspondence. metadata: identifiers/counters only."""

    EVENT_TYPES = [
        ("created", "created"),
        ("sent", "sent"),
        ("read", "read"),
        ("replied", "replied"),
        ("forwarded", "forwarded"),
        ("closed", "closed"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    correspondence = models.ForeignKey(
        Correspondence, on_delete=models.CASCADE, related_name="events"
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="correspondence_events",
    )
    event_type = models.CharField(max_length=16, choices=EVENT_TYPES)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "correspondence_events"
        indexes = [
            models.Index(fields=["correspondence", "created_at"], name="idx_corr_event_time"),
        ]

    def __str__(self):
        return f"{self.correspondence_id}:{self.event_type}"


class StoredFile(models.Model):
    """An uploaded, client-side encrypted blob (docs/phase1/04-erd.md §4.2 ز).

    The server knows its size and SHA-256 only. The file name, type and the
    content key live inside the MLS content of the correspondence(s) it is
    attached to.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    storage_key = models.CharField(max_length=128, unique=True)
    ciphertext_size = models.BigIntegerField()
    ciphertext_sha256 = models.BinaryField(max_length=32)
    uploader = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="stored_files"
    )
    uploaded_at = models.DateTimeField(auto_now_add=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "stored_files"
        constraints = [
            models.CheckConstraint(condition=Q(ciphertext_size__gt=0), name="ck_stored_file_size"),
        ]

    def __str__(self):
        return str(self.id)


class EncryptedAttachment(models.Model):
    """Binds a stored blob to a correspondence (or, later, a chat message).

    A blob may be bound to several correspondences: replying with or
    forwarding an attachment re-shares its key inside the new MLS content and
    adds a binding here, so download rights follow participation.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    stored_file = models.ForeignKey(
        StoredFile, on_delete=models.PROTECT, related_name="attachments"
    )
    correspondence = models.ForeignKey(
        Correspondence,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="attachments",
    )
    message = models.ForeignKey(
        "messaging.Message",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="attachments",
    )
    algorithm = models.CharField(max_length=32, default="aes-256-gcm")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "encrypted_attachments"
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(correspondence__isnull=False, message__isnull=True)
                    | Q(correspondence__isnull=True, message__isnull=False)
                ),
                name="ck_attachment_exactly_one_owner",
            ),
            models.UniqueConstraint(
                fields=["stored_file", "correspondence"], name="uq_attachment_file_corr"
            ),
        ]

    def __str__(self):
        return f"{self.stored_file_id}@{self.correspondence_id or self.message_id}"
