"""Management reports — aggregate metadata only (prompt §19, docs/phase1/05 §5.6).

What a report may contain: counts and durations per organizational unit.
What it never contains: names, subjects, bodies, attachments, participants or
who-wrote-to-whom. Breakdown rows for units with fewer than MIN_GROUP_SIZE
employees are merged so averages cannot single out one person. Access needs
reports.view_metadata in the requested unit and is itself audited.
"""
import os
from datetime import date, datetime, time, timedelta
from statistics import median

from django.conf import settings
from django.core.cache import cache
from django.db import connection
from django.db.models import Count, Exists, Min, OuterRef, Q
from django.db.models.functions import TruncMonth
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.accounts.models import TrustedDevice
from apps.announcements.models import Announcement, AnnouncementRecipient
from apps.approvals.models import ApprovalRequest
from apps.authorization.services import has_permission
from apps.correspondence.models import Correspondence
from apps.messaging.models import Message
from apps.org.models import Branch, Department, EmployeeMembership, Institute

MIN_GROUP_SIZE = 3
MAX_RANGE_DAYS = 366


# --- scope -------------------------------------------------------------------------

def resolve_unit(unit_type: str, unit_id):
    if unit_type == "all":
        return None
    model = {"institute": Institute, "branch": Branch, "department": Department}.get(unit_type)
    if model is None:
        raise ValidationError({"unit_type": "institute | branch | department | all"})
    unit = model.objects.filter(id=unit_id).first() if unit_id else None
    if unit is None:
        raise ValidationError({"unit_id": "وحدة غير معروفة."})
    return unit


def require_report_access(user, unit) -> None:
    if not has_permission(user, "reports.view_metadata", unit=unit):
        raise PermissionDenied("reports.view_metadata is not granted for this unit.")


def _membership_filter(unit, prefix: str) -> Q:
    """Q over an EmployeeMembership path (e.g. 'sender_membership__')."""
    if unit is None:
        return Q()
    if isinstance(unit, Department):
        return Q(**{f"{prefix}department": unit})
    if isinstance(unit, Branch):
        return Q(**{f"{prefix}branch": unit})
    return Q(**{f"{prefix}institute": unit})


def _children(unit) -> list:
    if unit is None:
        return list(Institute.objects.filter(is_active=True).order_by("name"))
    if isinstance(unit, Institute):
        return list(unit.branches.filter(is_active=True).order_by("name"))
    if isinstance(unit, Branch):
        return list(unit.departments.order_by("name"))
    return list(unit.children.order_by("name"))


def _active_memberships():
    today = timezone.localdate()
    return EmployeeMembership.objects.filter(user__is_active=True).filter(
        Q(ended_on__isnull=True) | Q(ended_on__gte=today)
    )


def parse_period(date_from: str | None, date_to: str | None) -> tuple[datetime, datetime]:
    today = timezone.localdate()
    try:
        end_day = date.fromisoformat(date_to) if date_to else today
        start_day = date.fromisoformat(date_from) if date_from else end_day - timedelta(days=89)
    except ValueError:
        raise ValidationError({"from": "صيغة التاريخ YYYY-MM-DD."})
    if start_day > end_day or (end_day - start_day).days > MAX_RANGE_DAYS:
        raise ValidationError({"from": f"فترة غير صالحة (الحد {MAX_RANGE_DAYS} يومًا)."})
    tz = timezone.get_current_timezone()
    return (
        timezone.make_aware(datetime.combine(start_day, time.min), tz),
        timezone.make_aware(datetime.combine(end_day, time.max), tz),
    )


# --- metrics -------------------------------------------------------------------------------

def _hours(delta: timedelta) -> float:
    return round(delta.total_seconds() / 3600, 1)


def correspondence_metrics(unit, start, end) -> dict:
    scope = Correspondence.objects.filter(_membership_filter(unit, "sender_membership__"))
    sent = scope.filter(status__in=["sent", "closed"], sent_at__range=(start, end))
    roots = sent.filter(reply_to__isnull=True)
    has_reply = Correspondence.objects.filter(reply_to=OuterRef("pk"), status__in=["sent", "closed"])
    overdue = scope.filter(
        status="sent", reply_to__isnull=True, due_date__lt=timezone.localdate()
    ).filter(~Exists(has_reply))

    first_replies = (
        roots.annotate(first_reply=Min("replies__sent_at", filter=Q(replies__status__in=["sent", "closed"])))
        .filter(first_reply__isnull=False)
        .values_list("sent_at", "first_reply")
    )
    durations = [_hours(r - s) for s, r in first_replies]
    return {
        "sent": sent.count(),
        "new_threads": roots.count(),
        "replies": sent.filter(reply_to__isnull=False).count(),
        "forwards": sent.filter(forwarded_from__isnull=False).count(),
        "closed": sent.filter(status="closed").count(),
        "overdue_open": overdue.count(),
        "with_due_date": roots.filter(due_date__isnull=False).count(),
        "avg_first_reply_hours": round(sum(durations) / len(durations), 1) if durations else None,
        "median_first_reply_hours": round(median(durations), 1) if durations else None,
        "replied_threads": len(durations),
    }


def approval_metrics(unit, start, end) -> dict:
    qs = ApprovalRequest.objects.filter(
        _membership_filter(unit, "correspondence__sender_membership__"), created_at__range=(start, end)
    )
    by_status = dict(qs.values_list("status").annotate(n=Count("id")))
    decided = [
        _hours(d - c) for c, d in qs.filter(decided_at__isnull=False).values_list("created_at", "decided_at")
    ]
    return {
        "requests": qs.count(),
        "by_status": {k: by_status.get(k, 0) for k, _ in ApprovalRequest.STATUSES},
        "avg_decision_hours": round(sum(decided) / len(decided), 1) if decided else None,
    }


def announcement_metrics(unit, start, end) -> dict:
    qs = Announcement.objects.filter(
        _membership_filter(unit, "publisher_membership__"),
        status__in=["published", "withdrawn"],
        published_at__range=(start, end),
    )
    rows = AnnouncementRecipient.objects.filter(announcement__in=qs.filter(requires_ack=True))
    total = rows.count()
    acked = rows.filter(acknowledged_at__isnull=False).count()
    overdue = rows.filter(
        acknowledged_at__isnull=True, announcement__ack_due_at__lt=timezone.now(), announcement__status="published"
    ).count()
    return {
        "published": qs.count(),
        "requiring_ack": qs.filter(requires_ack=True).count(),
        "ack_rate": round(acked / total, 3) if total else None,
        "overdue_acks": overdue,
    }


def usage_metrics(unit, start, end) -> dict:
    members = _active_memberships().filter(_membership_filter(unit, ""))
    user_ids = members.values("user_id")
    since = timezone.now() - timedelta(days=30)
    return {
        "employees": members.values("user_id").distinct().count(),
        "active_last_30_days": members.filter(user__last_login_at__gte=since).values("user_id").distinct().count(),
        "active_devices": TrustedDevice.objects.filter(user_id__in=user_ids, status="active").count(),
        "chat_messages": Message.objects.filter(
            kind="application",
            sender_id__in=user_ids,
            conversation__type__in=["dm", "group"],
            created_at__range=(start, end),
        ).count(),
    }


def monthly_series(unit, start, end) -> list[dict]:
    qs = (
        Correspondence.objects.filter(
            _membership_filter(unit, "sender_membership__"),
            status__in=["sent", "closed"],
            sent_at__range=(start, end),
        )
        .annotate(month=TruncMonth("sent_at"))
        .values("month")
        .annotate(n=Count("id"))
        .order_by("month")
    )
    return [{"month": row["month"].strftime("%Y-%m"), "sent": row["n"]} for row in qs]


def breakdown(unit, start, end) -> dict:
    rows, merged = [], {"units": 0, "employees": 0, "sent": 0, "overdue_open": 0}
    for child in _children(unit):
        employees = _active_memberships().filter(_membership_filter(child, "")).values("user_id").distinct().count()
        metrics = correspondence_metrics(child, start, end)
        if employees < MIN_GROUP_SIZE:
            merged["units"] += 1
            merged["employees"] += employees
            merged["sent"] += metrics["sent"]
            merged["overdue_open"] += metrics["overdue_open"]
            continue
        rows.append(
            {
                "unit": {"id": str(child.id), "name": child.name, "code": child.code},
                "employees": employees,
                "sent": metrics["sent"],
                "closed": metrics["closed"],
                "overdue_open": metrics["overdue_open"],
                "avg_first_reply_hours": metrics["avg_first_reply_hours"],
            }
        )
    return {"rows": rows, "merged_small_units": merged if merged["units"] else None, "min_group_size": MIN_GROUP_SIZE}


def build_report(unit, start, end) -> dict:
    return {
        "scope": {
            "type": "all" if unit is None else type(unit).__name__.lower(),
            "id": str(unit.id) if unit else None,
            "name": unit.name if unit else "جميع المعاهد",
        },
        "period": {"from": start.date().isoformat(), "to": end.date().isoformat()},
        "correspondence": correspondence_metrics(unit, start, end),
        "approvals": approval_metrics(unit, start, end),
        "announcements": announcement_metrics(unit, start, end),
        "usage": usage_metrics(unit, start, end),
        "monthly": monthly_series(unit, start, end),
        "breakdown": breakdown(unit, start, end),
        "generated_at": timezone.now().isoformat(),
    }


def reportable_units(user) -> list[dict]:
    """Units where the user may run reports (for the UI selector)."""
    out = []
    if has_permission(user, "reports.view_metadata", unit=None):
        out.append({"type": "all", "id": None, "name": "جميع المعاهد"})
    for inst in Institute.objects.filter(is_active=True).order_by("name"):
        if has_permission(user, "reports.view_metadata", unit=inst):
            out.append({"type": "institute", "id": str(inst.id), "name": inst.name})
    for br in Branch.objects.filter(is_active=True).select_related("institute").order_by("institute__name", "name"):
        if has_permission(user, "reports.view_metadata", unit=br):
            out.append({"type": "branch", "id": str(br.id), "name": f"{br.institute.name} — {br.name}"})
    for dep in Department.objects.select_related("institute").order_by("institute__name", "name"):
        if has_permission(user, "reports.view_metadata", unit=dep):
            out.append({"type": "department", "id": str(dep.id), "name": f"{dep.institute.name} — {dep.name}"})
    return out


# --- service health ---------------------------------------------------------------------------

def _check(fn) -> dict:
    try:
        detail = fn()
        return {"ok": True, **(detail or {})}
    except Exception as exc:  # health must report, never raise
        return {"ok": False, "error": type(exc).__name__}


def _db():
    with connection.cursor() as cur:
        cur.execute("SELECT 1")
    return {"engine": connection.vendor}


def _cache():
    cache.set("health:probe", "1", 5)
    if cache.get("health:probe") != "1":
        raise RuntimeError("cache read-back failed")


def _channel_layer():
    from channels.layers import get_channel_layer

    layer = get_channel_layer()
    if layer is None:
        raise RuntimeError("no channel layer")
    return {"backend": type(layer).__name__}


def _blob_storage():
    root = settings.ENCRYPTED_BLOB_ROOT
    os.makedirs(root, exist_ok=True)
    if not os.access(root, os.W_OK):
        raise RuntimeError("blob storage not writable")


def _transparency():
    from apps.crypto_keys.models import KeyTransparencyEvent
    from apps.crypto_keys.transparency import verify_chain

    events = list(KeyTransparencyEvent.objects.order_by("id"))
    problems = verify_chain(events)
    if problems:
        raise RuntimeError("transparency chain broken")
    return {"events": len(events)}


def health() -> dict:
    checks = {
        "database": _check(_db),
        "cache": _check(_cache),
        "realtime": _check(_channel_layer),
        "blob_storage": _check(_blob_storage),
        "key_transparency": _check(_transparency),
    }
    return {"status": "ok" if all(c["ok"] for c in checks.values()) else "degraded", "checks": checks,
            "checked_at": timezone.now().isoformat()}
