"""External e-mail (Internet mail) — deliberately separate from E2EE correspondence.

Mail from or to the outside world is plaintext by nature: the server sees it
at the moment it arrives (inbound, via the local Postfix) or leaves (outbound,
via Brevo). It is never STORED readable:

  * inbound: parsed in memory, attachments encrypted like client attachments,
    and the content sealed to each of the recipient's active devices
    (X25519 + HKDF + AES-GCM — the same seal the archive uses);
  * outbound: the sender's own copy is sealed the same way after Brevo accepts it.

Only routing metadata (addresses, Message-ID, times, sizes, authentication
result) is kept in clear, like the metadata of internal correspondence.
"""
import uuid

from django.conf import settings
from django.db import models


class ExternalMailbox(models.Model):
    """Per-user external address settings. Without a row the address is the
    username, receiving is on and sending is off."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, primary_key=True, related_name="external_mailbox"
    )
    # Overrides the default local part (= username) so login names need not be public.
    local_part = models.CharField(max_length=64, null=True, blank=True, unique=True)
    receiving_enabled = models.BooleanField(default=True)
    sending_enabled = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "external_mailboxes"


class ExternalMessage(models.Model):
    DIRECTIONS = [("in", "وارد"), ("out", "صادر")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="external_messages")
    direction = models.CharField(max_length=3, choices=DIRECTIONS)
    # Routing metadata only (no subject, no body).
    mail_from = models.CharField(max_length=320)
    recipients = models.JSONField(default=list)  # addresses (to + cc)
    message_id = models.CharField(max_length=998, blank=True, default="", db_index=True)
    in_reply_to = models.ForeignKey("self", on_delete=models.SET_NULL, null=True, blank=True, related_name="replies")
    # inbound sender authentication: "pass" | "fail" | "none"
    auth_result = models.CharField(max_length=8, default="none")
    size = models.IntegerField(default=0)
    attachment_count = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "external_messages"
        indexes = [models.Index(fields=["owner", "-created_at"], name="idx_ext_msg_owner_time")]


class ExternalMessageCopy(models.Model):
    """The message content sealed to one device of its owner."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    message = models.ForeignKey(ExternalMessage, on_delete=models.CASCADE, related_name="copies")
    device = models.ForeignKey("accounts.TrustedDevice", on_delete=models.CASCADE, related_name="+")
    ephemeral_pub = models.BinaryField(max_length=32)
    iv = models.BinaryField(max_length=12)
    ciphertext = models.BinaryField()

    class Meta:
        db_table = "external_message_copies"
        constraints = [models.UniqueConstraint(fields=["message", "device"], name="uq_ext_copy_device")]


class ExternalAttachment(models.Model):
    message = models.ForeignKey(ExternalMessage, on_delete=models.CASCADE, related_name="attachments")
    stored_file = models.ForeignKey("correspondence.StoredFile", on_delete=models.PROTECT, related_name="+")

    class Meta:
        db_table = "external_attachments"
