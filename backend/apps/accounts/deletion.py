"""Permanent deletion of an account that was never used (an import mistake,
a duplicate, a test account). Anything that ties the account to a record —
a login, correspondence, chat, announcement, approval, external mail, a
file, or an audit entry it acted in — keeps it: deactivate it instead.

The check asks Django's own deletion collector what deleting would touch,
so a relation added later is covered without listing it here: only the
account's own settings rows below may go with it. A SET_NULL reference (e.g.
the audit log's actor) counts as a use too.

The runtime database role has no UPDATE on audit_logs, and PostgreSQL checks
that privilege even for an UPDATE matching no row; so the collector's
SET_NULL querysets are evaluated first (all empty here) and no UPDATE is
issued.
"""
from django.db import router
from django.db.models import QuerySet
from django.db.models.deletion import Collector, ProtectedError, RestrictedError

from .models import User

# Rows that exist only for the account itself and go with it.
DISPOSABLE = {
    "accounts.usersession", "accounts.trusteddevice", "accounts.loginintent", "accounts.loginapproval",
    "org.employeemembership", "authorization.userroleassignment",
    "notifications.notification", "notifications.pushsubscription", "notifications.apppushtoken",
    "notifications.notificationpreference",
    "external_mail.externalmailbox", "approvals.usersignature",
}


def _collect(user: User):
    """(collector, used labels); collector is None when deletion is blocked outright."""
    if user.last_login_at is not None:
        return None, ["login"]
    collector = Collector(using=router.db_for_write(User))
    try:
        collector.collect([user])
    except (ProtectedError, RestrictedError) as exc:
        objs = getattr(exc, "protected_objects", None) or getattr(exc, "restricted_objects", ())
        return None, sorted({o._meta.label_lower for o in objs})
    used = {m._meta.label_lower for m, objs in collector.data.items() if objs and m is not User}
    used |= {qs.model._meta.label_lower for qs in collector.fast_deletes if qs.exists()}
    for (field, _value), batches in collector.field_updates.items():
        for batch in batches:
            if isinstance(batch, QuerySet):
                list(batch)  # evaluated: an empty result issues no UPDATE at delete time
            if len(batch):
                used.add(field.model._meta.label_lower)
    return collector, sorted(used - DISPOSABLE)


def usage(user: User) -> list[str]:
    """Model labels that tie `user` to the system's records; empty = deletable."""
    return _collect(user)[1]


PURGED_FIRST, PURGED_LAST = "موظف", "محذوف"


def purge(user: User) -> dict:
    """Permanently delete a USED account (user decision 2026-11-21).

    Everything that is the employee's own goes: login, sessions and browsers,
    roles, memberships' standing, notifications, external mailbox with its
    mail and address book, drafts with their files, chat memberships, and
    personal details. What they SENT to others stays with its recipients,
    shown as «موظف محذوف»: the account row remains as an empty shell (no name,
    no contact, unusable password) because those records and the append-only
    audit log point to it. Returns counts of what was removed (no content).
    """
    from django.db import transaction
    from django.utils import timezone

    from apps.approvals.models import UserSignature
    from apps.authorization.models import UserRoleAssignment
    from apps.correspondence.models import Correspondence, EncryptedAttachment, StoredFile
    from apps.correspondence.services import blob_storage, discard_draft
    from apps.external_mail.models import ExternalAttachment, ExternalContact, ExternalMailbox, ExternalMessage
    from apps.messaging.models import ConversationMember
    from apps.notifications.models import AppPushToken, Notification, NotificationPreference, PushSubscription
    from apps.org.models import EmployeeMembership

    from .models import LoginApproval, LoginIntent, TrustedDevice, UserSession

    now = timezone.now()
    counts = {}
    with transaction.atomic():
        drafts = list(Correspondence.objects.filter(sender=user, status="draft").values_list("id", flat=True))
        for draft_id in drafts:
            discard_draft(user, draft_id)
        counts["drafts"] = len(drafts)

        counts["external_messages"] = ExternalMessage.objects.filter(owner=user).count()
        ExternalAttachment.objects.filter(message__owner=user).delete()
        ExternalMessage.objects.filter(owner=user).delete()
        ExternalContact.objects.filter(owner=user).delete()
        ExternalMailbox.objects.filter(user=user).delete()

        # Files they uploaded that nothing references any more (drafts, external mail).
        orphans = StoredFile.objects.filter(uploader=user, deleted_at__isnull=True).exclude(
            id__in=EncryptedAttachment.objects.values("stored_file_id")
        ).exclude(id__in=ExternalAttachment.objects.values("stored_file_id"))
        keys = list(orphans.values_list("storage_key", flat=True))
        counts["files"] = orphans.update(deleted_at=now)

        counts["chats_left"] = ConversationMember.objects.filter(
            user=user, conversation__type__in=("dm", "group")
        ).delete()[0]
        UserSession.objects.filter(user=user).delete()
        TrustedDevice.objects.filter(user=user).delete()
        LoginIntent.objects.filter(user=user).delete()
        LoginApproval.objects.filter(user=user).delete()
        counts["roles"] = UserRoleAssignment.objects.filter(user=user).delete()[0]
        Notification.objects.filter(user=user).delete()
        PushSubscription.objects.filter(user=user).delete()
        AppPushToken.objects.filter(user=user).delete()
        NotificationPreference.objects.filter(user=user).delete()
        UserSignature.objects.filter(user=user).delete()
        # Memberships stay as history (sent mail names the sender's unit) but end.
        EmployeeMembership.objects.filter(user=user, ended_on__isnull=True).update(ended_on=timezone.localdate())
        EmployeeMembership.objects.filter(user=user, is_primary=True).update(is_primary=False)

        user.username = f"deleted.{user.id.hex[:12]}"
        user.first_name, user.last_name = PURGED_FIRST, PURGED_LAST
        user.full_name = f"{PURGED_FIRST} {PURGED_LAST}"
        user.phone, user.optional_email = "", None
        user.set_unusable_password()
        user.is_active, user.must_change_password = False, False
        user.mfa_enabled, user.mfa_method, user.mfa_secret_ciphertext = False, "", None
        user.deactivated_at = user.deactivated_at or now
        user.deactivation_reason = "حذف نهائي"
        user.purged_at = now
        user.save()

    storage = blob_storage()
    for key in keys:  # after commit: a rollback must not lose files
        try:
            storage.delete(key)
        except OSError:
            pass
    return counts


def delete_unused(user: User) -> list[str]:
    """Delete `user` if never used; else leave it and return what uses it."""
    collector, used = _collect(user)
    if used:
        return used
    collector.delete()
    return []
