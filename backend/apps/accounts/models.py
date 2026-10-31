"""Custom user account models per docs/phase1/04-erd.md §4.2 (ب).

The User model deliberately does NOT use django.contrib.auth's
PermissionsMixin: authorization is handled by apps.authorization
(RBAC + organizational scope), and Django's contrib Permission coupling
is intentionally absent from this project.
"""
import uuid

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager
from django.db import models


class UserManager(BaseUserManager):
    def create_user(self, username, password=None, **extra_fields):
        if not username:
            raise ValueError("username is required")
        user = self.model(username=username, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, username, password=None, **extra_fields):
        extra_fields.setdefault("is_active", True)
        extra_fields.setdefault("must_change_password", False)
        return self.create_user(username, password, **extra_fields)


class User(AbstractBaseUser):
    MFA_METHODS = [
        ("totp", "TOTP"),
        ("webauthn", "WebAuthn"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    username = models.CharField(max_length=64, unique=True)
    # password: Argon2id hash, inherited from AbstractBaseUser (ERD: password_hash).
    first_name = models.CharField(max_length=128, blank=True, default="")
    last_name = models.CharField(max_length=128, blank=True, default="")
    full_name = models.CharField(max_length=255, blank=True, default="", db_index=True)
    phone = models.CharField(max_length=32, blank=True, default="")
    optional_email = models.EmailField(null=True, blank=True, unique=True)
    is_active = models.BooleanField(default=True)
    must_change_password = models.BooleanField(default=False)
    mfa_enabled = models.BooleanField(default=False)
    mfa_method = models.CharField(max_length=16, choices=MFA_METHODS, blank=True, default="")
    # Server-side encrypted (Fernet) TOTP secret; login-only data, never E2EE.
    # While MFA setup is pending this holds the unconfirmed secret.
    mfa_secret_ciphertext = models.BinaryField(null=True, blank=True)
    password_changed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # ERD names this last_login_at; replaces AbstractBaseUser.last_login.
    last_login_at = models.DateTimeField(null=True, blank=True)
    deactivated_at = models.DateTimeField(null=True, blank=True)
    deactivation_reason = models.CharField(max_length=255, blank=True, default="")

    USERNAME_FIELD = "username"
    REQUIRED_FIELDS: list = []

    objects = UserManager()

    # Remove the inherited last_login field in favour of last_login_at.
    last_login = None

    class Meta:
        db_table = "users"

    def save(self, *args, **kwargs):
        if not self.full_name:
            self.full_name = self.get_full_name() or self.username
        super().save(*args, **kwargs)

    def get_full_name(self):
        return " ".join(part for part in [self.first_name, self.last_name] if part).strip()

    def has_perm(self, perm, obj=None):
        # No contrib-Permission coupling; authorization is scope-based (apps.authorization).
        return False

    def has_perms(self, perm_list, obj=None):
        return False

    def has_module_perms(self, app_label):
        return False

    def __str__(self):
        return self.username


class TrustedDevice(models.Model):
    """A browser/app the user signed in from (one row per user + browser +
    platform). Login sessions hang off it. It holds no keys: mail content is
    encrypted at rest on the server (apps.vault)."""

    STATUS = [
        ("pending", "Pending"),
        ("active", "Active"),
        ("approved", "Approved"),
        ("revoked", "Revoked"),
        ("retired", "Retired"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="trusted_devices")
    device_label = models.CharField(max_length=255)
    platform = models.CharField(max_length=64, blank=True, default="")
    app_version = models.CharField(max_length=64, blank=True, default="")
    status = models.CharField(max_length=16, choices=STATUS, default="pending")
    last_seen_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "trusted_devices"
        indexes = [
            models.Index(fields=["user", "status"], name="idx_device_user_status"),
        ]

    def __str__(self):
        return f"{self.user_id}:{self.device_label}"


class UserSession(models.Model):
    """Refresh-token session. Only the sha256 hex digest of the opaque
    refresh token is stored — the raw token lives solely in the
    httpOnly cookie."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sessions")
    device = models.ForeignKey(
        TrustedDevice, on_delete=models.SET_NULL, null=True, blank=True, related_name="sessions"
    )
    refresh_token_hash = models.CharField(max_length=64, unique=True)  # sha256 hex
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_reason = models.CharField(max_length=64, blank=True, default="")
    # Set when this session is rotated: the session that replaced it. Lets a
    # refresh whose response was lost (page navigated / closed mid-request)
    # recover within a short grace window instead of logging the user out.
    replaced_by = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        db_table = "user_sessions"
        indexes = [
            models.Index(fields=["user", "revoked_at"], name="idx_session_user_revoked"),
        ]

    def __str__(self):
        return f"session:{self.user_id}"


class LoginIntent(models.Model):
    """Short-lived login intent issued when a user with MFA passes the
    password check. The MFA verify step exchanges the signed mfa_token
    (which embeds this id) for a session. One-time use."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="login_intents")
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "login_intents"

    def __str__(self):
        return f"intent:{self.user_id}"
