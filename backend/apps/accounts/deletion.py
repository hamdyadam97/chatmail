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
    "notifications.notification", "notifications.pushsubscription", "notifications.notificationpreference",
    "external_mail.externalmailbox",
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


def delete_unused(user: User) -> list[str]:
    """Delete `user` if never used; else leave it and return what uses it."""
    collector, used = _collect(user)
    if used:
        return used
    collector.delete()
    return []
