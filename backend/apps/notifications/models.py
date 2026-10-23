"""Notifications per docs/phase1/04-erd.md §4.2 (ط).

A notification never carries content: ``title_generic`` comes from a fixed
server-side catalog keyed by ``kind`` (see services.TITLES), and the target
is referenced by type + id only (SEC-11).
"""
import uuid

from django.conf import settings
from django.db import models


class Notification(models.Model):
    KINDS = [
        ("new_correspondence", "مراسلة جديدة"),
        ("correspondence_reply", "رد على مراسلة"),
        ("correspondence_forward", "إحالة"),
        ("approval_requested", "طلب اعتماد"),
        ("approval_decided", "قرار اعتماد"),
        ("device_alert", "تنبيه أجهزة"),
        ("announcement", "تعميم"),
        ("announcement_reminder", "تذكير بتعميم"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications"
    )
    kind = models.CharField(max_length=32, choices=KINDS)
    title_generic = models.CharField(max_length=200)
    ref_type = models.CharField(max_length=32, blank=True, default="")
    ref_id = models.UUIDField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "notifications"
        indexes = [
            models.Index(fields=["user", "read_at"], name="idx_notification_user_read"),
            models.Index(fields=["user", "-created_at"], name="idx_notification_user_time"),
        ]

    def __str__(self):
        return f"{self.user_id}:{self.kind}"


class PushSubscription(models.Model):
    """A browser's Web Push subscription (RFC 8030/8291). One per browser
    profile: the endpoint is unique, and re-subscribing from the same browser
    under another account moves it (no cross-account notifications on a
    shared computer). Payloads are encrypted to the browser's p256dh key."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="push_subscriptions"
    )
    endpoint = models.URLField(max_length=1000, unique=True)
    p256dh = models.CharField(max_length=200)
    auth = models.CharField(max_length=100)
    user_agent = models.CharField(max_length=300, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    last_success_at = models.DateTimeField(null=True, blank=True)
    failures = models.IntegerField(default=0)

    class Meta:
        db_table = "push_subscriptions"


class NotificationPreference(models.Model):
    """Per-user delivery preferences. Today only ``muted_kinds`` is honoured
    (muted kinds are still stored, just not pushed over WebSocket)."""

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        primary_key=True,
        related_name="notification_preferences",
    )
    prefs = models.JSONField(default=dict, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "notification_preferences"

    def muted_kinds(self) -> set[str]:
        return set(self.prefs.get("muted_kinds", []))
