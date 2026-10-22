"""Append-only audit log per docs/phase1/04-erd.md §4.2 (ط).

APPEND-ONLY CONTRACT: this table has no update/delete code paths at the
application level (queryset update()/delete() are overridden to raise),
and in production the DB role holding this data is granted INSERT/SELECT
only. Any retention/cleanup is an explicit, separately-approved DBA
operation, never part of application flows.
"""
import uuid

from django.db import models


class AuditLogQuerySet(models.QuerySet):
    def update(self, *args, **kwargs):
        raise NotImplementedError("audit_logs is append-only: updates are forbidden")

    def delete(self):
        raise NotImplementedError("audit_logs is append-only: deletes are forbidden")


class AuditLogManager(models.Manager):
    def get_queryset(self):
        return AuditLogQuerySet(self.model, using=self._db)

    def log(self, **kwargs):
        return self.create(**kwargs)


class AuditLog(models.Model):
    id = models.BigAutoField(primary_key=True)  # bigserial in PostgreSQL
    actor = models.ForeignKey(
        "accounts.User", on_delete=models.SET_NULL, null=True, blank=True, related_name="audit_logs"
    )
    actor_device = models.ForeignKey(
        "accounts.TrustedDevice",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="audit_logs",
    )
    action = models.CharField(max_length=64)
    target_type = models.CharField(max_length=64, blank=True, default="")
    target_id = models.UUIDField(null=True, blank=True)
    org_scope = models.CharField(max_length=128, blank=True, default="")
    ip = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField(blank=True, default="")
    metadata = models.JSONField(default=dict, blank=True)  # identifiers only — never secrets
    created_at = models.DateTimeField(auto_now_add=True)

    objects = AuditLogManager()

    class Meta:
        db_table = "audit_logs"
        indexes = [
            models.Index(fields=["actor", "created_at"], name="idx_audit_actor_created"),
            models.Index(fields=["action", "created_at"], name="idx_audit_action_created"),
            models.Index(fields=["target_type", "target_id"], name="idx_audit_target"),
        ]

    def __str__(self):
        return f"{self.action}:{self.id}"

    def save(self, *args, **kwargs):
        # App-level append-only guard: re-saving an existing row raises.
        kwargs["force_insert"] = True
        super().save(*args, **kwargs)
