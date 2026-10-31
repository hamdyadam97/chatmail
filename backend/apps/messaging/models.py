"""Chat delivery models per docs/phase1/04-erd.md §4.2 (هـ + و).

Content is encrypted at rest with the server key (apps.vault, user decision
2026-10-31: Outlook-style mail). ``content_enc`` / ``title_enc`` are sealed
blobs bound to their conversation; the API opens them for active members only.

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
    # Sealed group title (apps.vault).
    title_enc = models.BinaryField(null=True, blank=True)
    # Plain titles are reserved for official channels (organizational data).
    title_plain = models.CharField(max_length=255, null=True, blank=True)
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
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    conversation = models.ForeignKey(
        Conversation, on_delete=models.CASCADE, related_name="messages"
    )
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="chat_messages",
    )
    seq = models.BigIntegerField()
    # Sealed JSON content (apps.vault, purpose "message", owner = conversation).
    content_enc = models.BinaryField()
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
        return f"{self.conversation_id}:{self.seq}"
