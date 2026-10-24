"""Crypto key models per docs/phase1/04-erd.md §4.2 (ب: user_crypto_identities)
and §4.2 (و: device_key_bundles, key_transparency_events, key_verification_events).

STORAGE CONTRACT (ERD §4 header + SEC-03/09/10): only PUBLIC keys, public-key
HASHES and opaque MLS wire blobs live here. Private keys, recovery keys,
plaintext and unwrapped secrets must never reach these tables — the
test_crypto_schema suite sweeps for PEM/OpenSSH private-key material.
"""
import uuid

from django.db import models


class UserCryptoIdentity(models.Model):
    """The user's single Ed25519 identity key (public part only).

    Chain-of-trust root per docs/phase1/03-key-management.md §3.2: every
    device credential is signed (transitively) by this key. Rotation is
    recorded through rotated_at / superseded_by_hash.
    """

    user = models.OneToOneField(
        "accounts.User",
        primary_key=True,
        on_delete=models.CASCADE,
        related_name="crypto_identity",
    )
    identity_sign_pub = models.BinaryField()  # Ed25519, 32 bytes
    algorithm = models.CharField(max_length=64, default="ed25519+x25519")
    created_at = models.DateTimeField(auto_now_add=True)
    rotated_at = models.DateTimeField(null=True, blank=True)
    superseded_by_hash = models.BinaryField(null=True, blank=True)
    # First device's signature over the identity key — closes the bootstrap
    # loop (ERD §4.2 ب). Stored for clients/auditors; possession of the device
    # key is what the server verifies at registration time.
    bootstrap_signature = models.BinaryField()

    class Meta:
        db_table = "user_crypto_identities"

    def __str__(self):
        return f"identity:{self.user_id}"


class DeviceKeyBundle(models.Model):
    """An uploaded MLS KeyPackage awaiting consumption in a Welcome.

    Trust note (docs/phase1/08-mls-spike-results.md §8.3): the server binds a
    KeyPackage to its OWNING device row by hash + ownership only, and enforces
    one-time use via keypackage_hash uniqueness and consumed_at. The
    CRYPTOGRAPHIC binding of the KeyPackage contents (credential → identity →
    device chain) is verified by MLS clients at Welcome time. The server is a
    dumb pipe: it never parses the MLS wire format.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        "accounts.TrustedDevice", on_delete=models.CASCADE, related_name="key_bundles"
    )
    keypackage = models.BinaryField()  # opaque MLS wire blob
    keypackage_hash = models.BinaryField(unique=True)  # sha256 — reuse prevention (SEC-15)
    uploaded_at = models.DateTimeField(auto_now_add=True)
    consumed_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "device_key_bundles"
        indexes = [
            models.Index(fields=["device", "consumed_at"], name="idx_keybundle_device_consumed"),
        ]

    def __str__(self):
        return f"keybundle:{self.device_id}:{self.id}"


class KeyTransparencyEventQuerySet(models.QuerySet):
    def update(self, *args, **kwargs):
        raise NotImplementedError("key_transparency_events is append-only: updates are forbidden")

    def delete(self):
        raise NotImplementedError("key_transparency_events is append-only: deletes are forbidden")


class KeyTransparencyEventManager(models.Manager):
    def get_queryset(self):
        return KeyTransparencyEventQuerySet(self.model, using=self._db)


class KeyTransparencyEvent(models.Model):
    """Append-only key-transparency log per docs/phase1/03-key-management.md §3.8.

    Global total order via the bigserial id (seq). The hash chain runs
    PER USER: entry_hash = sha256(prev_hash || canonical_json(payload)) where
    prev_hash is that user's previous entry (or the genesis constant for the
    user's first entry), so a client can verify its own /self/ chain
    standalone. The ed25519 log signature (server-held log key) is over
    entry_hash. payload carries public-key HASHES and identifiers only.
    """

    EVENT_TYPES = [
        ("identity_created", "Identity created"),
        ("identity_rotated", "Identity rotated"),
        ("device_added", "Device added"),
        ("device_approved", "Device approved"),
        ("device_revoked", "Device revoked"),
        ("key_uploaded", "Key uploaded"),
        ("key_rotated", "Key rotated"),
        # A browser took over a lost device from its encrypted recovery backup.
        ("device_restored", "Device restored from backup"),
    ]

    id = models.BigAutoField(primary_key=True)  # bigserial — the global seq
    user = models.ForeignKey(
        "accounts.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="transparency_events"
    )
    device = models.ForeignKey(
        "accounts.TrustedDevice",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="transparency_events",
    )
    event_type = models.CharField(max_length=32, choices=EVENT_TYPES)
    prev_hash = models.BinaryField()
    entry_hash = models.BinaryField()
    payload = models.JSONField(default=dict)  # public-key hashes + identifiers only
    log_signature = models.BinaryField()  # ed25519 over entry_hash by the log key
    created_at = models.DateTimeField(auto_now_add=True)

    objects = KeyTransparencyEventManager()

    class Meta:
        db_table = "key_transparency_events"
        indexes = [
            models.Index(fields=["user", "id"], name="idx_kt_user_seq"),
        ]

    def __str__(self):
        return f"{self.event_type}:{self.id}"

    def save(self, *args, **kwargs):
        # App-level append-only guard, mirroring apps.audit.models.AuditLog.
        kwargs["force_insert"] = True
        super().save(*args, **kwargs)


class KeyVerificationEvent(models.Model):
    """Device-to-device verification (SAS/QR) outcome per §3.5 — hashes only,
    never fingerprints' pre-image or key material."""

    METHODS = [
        ("sas", "SAS"),
        ("qr", "QR"),
    ]
    RESULTS = [
        ("success", "Success"),
        ("failed", "Failed"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    verifier_device = models.ForeignKey(
        "accounts.TrustedDevice", on_delete=models.CASCADE, related_name="verifications_made"
    )
    verified_device = models.ForeignKey(
        "accounts.TrustedDevice", on_delete=models.CASCADE, related_name="verifications_received"
    )
    method = models.CharField(max_length=8, choices=METHODS)
    fingerprint_hash = models.BinaryField()  # sha256 of the agreed fingerprint
    result = models.CharField(max_length=16, choices=RESULTS)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "key_verification_events"

    def __str__(self):
        return f"verify:{self.verifier_device_id}->{self.verified_device_id}:{self.result}"


class EncryptedKeyBackup(models.Model):
    """Encrypted recovery bundle (docs/phase1/03 §3.6, ERD encrypted_key_backups).

    The client encrypts {identity/device seeds, MLS state, locally decrypted
    mail and chat} with AES-256-GCM under a key derived from the user's
    Recovery Key BEFORE upload. The server stores ciphertext + public KDF
    parameters only; there is no column that could hold the decryption key.
    ``key_id`` is a one-way fingerprint of the recovery key (HKDF output, not
    the key) so a client can tell which backups a key opens.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="key_backups")
    device = models.ForeignKey(
        "accounts.TrustedDevice", on_delete=models.CASCADE, related_name="key_backups"
    )
    version = models.IntegerField()
    format = models.IntegerField(default=1)
    kdf = models.CharField(max_length=32, default="HKDF-SHA256")
    key_id = models.CharField(max_length=32)
    iv = models.BinaryField(max_length=12)
    ciphertext = models.BinaryField()
    ciphertext_size = models.IntegerField()
    ciphertext_sha256 = models.BinaryField(max_length=32)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "encrypted_key_backups"
        constraints = [
            models.UniqueConstraint(fields=["user", "version"], name="uq_key_backup_user_version"),
        ]
        indexes = [
            models.Index(fields=["user", "device", "-version"], name="idx_key_backup_device"),
        ]
