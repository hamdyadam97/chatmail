"""Chat delivery models per docs/phase1/04-erd.md §4.2 (هـ + و).

The server is a pure MLS Delivery Service (docs/phase1/02-protocol-comparison.md
§2.4): it stores opaque MLS wire payloads only — never plaintext, never key
material. ``mls_payload`` / ``title_enc`` are bytea ciphertext blobs whose
contents the server cannot and must not interpret.

This slice implements ``dm`` and ``group`` conversations; the channel types
and org-unit FKs are deferred, but the ``type`` choices stay ERD-complete.
"""
import uuid

from django.conf import settings
from django.db import models


class Conversation(models.Model):
    TYPES = [
        ("dm", "Direct Message"),
        ("group", "Group"),
        ("channel_dept", "Department Channel"),
        ("channel_branch", "Branch Channel"),
        ("channel_institute", "Institute Channel"),
        # One MLS group per official correspondence thread (docs/phase1/03 §3.4);
        # created and gated by apps.correspondence, hidden from chat listings.
        ("correspondence", "Correspondence Thread"),
        # One MLS group per announcement (apps.announcements); same gating.
        ("announcement", "Announcement"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    type = models.CharField(max_length=20, choices=TYPES)
    # Opaque ciphertext (group/dm titles) — server cannot read it.
    title_enc = models.BinaryField(null=True, blank=True)
    # Plain titles are reserved for official channels (organizational data).
    title_plain = models.CharField(max_length=255, null=True, blank=True)
    mls_group_id = models.BinaryField(max_length=32, unique=True)
    current_epoch = models.IntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_conversations",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "conversations"

    def __str__(self):
        return f"{self.type}:{self.id}"

    def active_members(self):
        return self.members.filter(removed_at__isnull=True)


class ConversationMember(models.Model):
    ROLES = [
        ("member", "Member"),
        ("admin", "Admin"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="members"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="conversation_memberships"
    )
    member_role = models.CharField(max_length=16, choices=ROLES, default="member")
    added_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="added_conversation_members",
    )
    joined_at = models.DateTimeField(auto_now_add=True)
    removed_at = models.DateTimeField(null=True, blank=True)
    last_read_seq = models.BigIntegerField(default=0)

    class Meta:
        db_table = "conversation_members"
        constraints = [
            models.UniqueConstraint(fields=["conversation", "user"], name="pk_conversation_member"),
        ]
        indexes = [
            models.Index(fields=["user", "removed_at"], name="idx_conv_member_user_removed"),
        ]

    def __str__(self):
        return f"{self.conversation_id}:{self.user_id}"


class Message(models.Model):
    KINDS = [
        ("application", "Application"),
        ("commit", "Commit"),
        ("welcome", "Welcome"),
        ("proposal", "Proposal"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="messages"
    )
    # NULL for welcome messages (they are addressed to a device, not "from" a user).
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="chat_messages",
    )
    sender_device = models.ForeignKey(
        "accounts.TrustedDevice",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="chat_messages",
    )
    seq = models.BigIntegerField()
    epoch = models.IntegerField()
    kind = models.CharField(max_length=16, choices=KINDS)
    mls_payload = models.BinaryField()
    recipient_device = models.ForeignKey(
        "accounts.TrustedDevice",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="welcome_messages",
    )
    reply_to = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="replies"
    )
    client_msg_id = models.UUIDField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "messages"
        constraints = [
            models.UniqueConstraint(fields=["conversation", "seq"], name="unq_message_conv_seq"),
            models.UniqueConstraint(
                fields=["conversation", "client_msg_id"], name="unq_message_conv_client_msg"
            ),
        ]
        indexes = [
            models.Index(fields=["conversation", "seq"], name="idx_message_conv_seq"),
        ]

    def __str__(self):
        return f"{self.conversation_id}:{self.seq}:{self.kind}"


class WelcomeRecipient(models.Model):
    """One stored Welcome addressed to many devices.

    A Welcome created for N new members is a single MLS message (each member
    finds its own encrypted group secrets inside it). Storing it once with N
    recipient rows instead of N copies keeps large groups (announcements,
    many-recipient threads) at O(size) storage. API visibility stays per
    device owner (SEC-07 server side).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name="welcome_recipients")
    device = models.ForeignKey(
        "accounts.TrustedDevice", on_delete=models.CASCADE, related_name="welcome_deliveries"
    )

    class Meta:
        db_table = "welcome_recipients"
        constraints = [
            models.UniqueConstraint(fields=["message", "device"], name="uq_welcome_recipient"),
        ]


class GroupCryptoEpoch(models.Model):
    """Server-side bookkeeping of MLS epochs (docs/phase1/04-erd.md §4.2 و).

    Records WHICH device committed WHICH epoch with HOW MANY active members
    — metadata only, never secrets. Clients enforce the cryptography; this
    table lets the server gate commit ordering and lets clients audit history.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="crypto_epochs"
    )
    epoch = models.IntegerField()
    commit_hash = models.BinaryField(null=True, blank=True)
    committed_by_device = models.ForeignKey(
        "accounts.TrustedDevice",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="committed_epochs",
    )
    member_count = models.IntegerField()
    started_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "group_crypto_epochs"
        constraints = [
            models.UniqueConstraint(fields=["conversation", "epoch"], name="unq_epoch_conv_epoch"),
        ]

    def __str__(self):
        return f"{self.conversation_id}:epoch{self.epoch}"
