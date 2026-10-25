"""Central institutional archive (docs/phase1/README.md §3, 05 §archive).

An explicit, declared recipient — not a back door:
  * Only correspondence classified ``institutional_archive_eligible`` gets
    an archive copy, created by the SENDER's client at send time; senders
    and recipients see that classification on the item.
  * The copy is the same content encrypted (X25519 + HKDF + AES-GCM) to the
    central archive PUBLIC key. The private key exists only on archive
    officers' devices: created on one, passed to others encrypted to each
    device's KEM key (ArchiveKeyShare). The server stores ciphertext only.
Nothing here grants access to non-archived correspondence.
"""
import uuid

from django.conf import settings
from django.db import models


class ArchiveKey(models.Model):
    STATUSES = [("active", "نشط"), ("retired", "متقاعد")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    version = models.IntegerField(unique=True)
    public_key = models.BinaryField(max_length=32)  # X25519 raw
    status = models.CharField(max_length=16, choices=STATUSES, default="active")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    created_by_device = models.ForeignKey("accounts.TrustedDevice", on_delete=models.PROTECT, related_name="+")
    # Ed25519 by the creating device over ARCHIVE_KEY_CONTEXT || version || public_key.
    signature = models.BinaryField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "archive_keys"
        constraints = [
            models.UniqueConstraint(
                fields=["status"], condition=models.Q(status="active"), name="uq_archive_key_single_active"
            ),
        ]


class ArchiveKeyShare(models.Model):
    """The archive private key, encrypted by an officer device to another
    officer device's KEM public key."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    archive_key = models.ForeignKey(ArchiveKey, on_delete=models.CASCADE, related_name="shares")
    recipient_device = models.ForeignKey("accounts.TrustedDevice", on_delete=models.CASCADE, related_name="+")
    shared_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    ephemeral_pub = models.BinaryField(max_length=32)
    iv = models.BinaryField(max_length=12)
    ciphertext = models.BinaryField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "archive_key_shares"
        constraints = [
            models.UniqueConstraint(fields=["archive_key", "recipient_device"], name="uq_archive_share_device"),
        ]


class ArchiveCopy(models.Model):
    """Sender-encrypted copy of one archive-eligible correspondence."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    correspondence = models.OneToOneField(
        "correspondence.Correspondence", on_delete=models.PROTECT, related_name="archive_copy"
    )
    archive_key = models.ForeignKey(ArchiveKey, on_delete=models.PROTECT, related_name="copies")
    ephemeral_pub = models.BinaryField(max_length=32)
    iv = models.BinaryField(max_length=12)
    ciphertext = models.BinaryField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "archive_copies"
