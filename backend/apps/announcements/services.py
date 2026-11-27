"""Announcement services: audience resolution, publish, receipts,
acknowledgements, compliance and reminders (prompt §10).

Content {title, body} is sealed at rest with the server key (apps.vault).

Invariants:
  * The audience is resolved server-side from active org memberships at
    publish time and snapshotted; only the publisher and that audience can
    open the content. Every recipient can list the declared audience.
  * The central executive also receives every announcement as an *observer*
    (user decision 2026-11-26): a member of the thread and a recipient row
    with observer=True — reads and is notified, but stays out of compliance,
    acknowledgement and reminders. Read access still comes only from being a
    recipient (no "view all" permission).
  * Withdrawing hides the content from recipients at once.
  * announcements.publish is checked in the target unit (central for "all";
    for named users, a unit holding each user's membership).
  * Compliance (who received/read/acknowledged) is metadata, visible to the
    publisher and to announcements.track_ack holders of the target unit —
    never the content.
"""
import hashlib
import json
from datetime import timedelta

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError
from rest_framework.status import HTTP_409_CONFLICT

from apps.accounts.models import User
from apps.audit.services import log
from apps.authorization.services import has_permission
from apps.correspondence.services import resolve_sender_membership
from apps.messaging.models import Conversation, ConversationMember
from apps.messaging.services import message_content, store_message
from apps.notifications.services import notify
from apps.org.models import Branch, Department, EmployeeMembership, Institute

from .models import Announcement, AnnouncementRecipient, AnnouncementSequence

MAX_TITLE = 300
MAX_BODY = 50_000
REMIND_COOLDOWN = timedelta(hours=1)
AUTO_REMIND_WINDOW = timedelta(hours=24)


class Conflict(APIException):
    status_code = HTTP_409_CONFLICT
    default_detail = "conflict"
    default_code = "conflict"


# --- audience --------------------------------------------------------------------

def _active_memberships():
    today = timezone.localdate()
    return EmployeeMembership.objects.filter(user__is_active=True).filter(
        Q(ended_on__isnull=True) | Q(ended_on__gte=today)
    )


def _membership_unit(m):
    return m.department or m.branch or m.institute


def resolve_target(target_type, target_id, branch_ids=None):
    if target_type == "branches":
        ids = list(dict.fromkeys(str(b) for b in branch_ids or []))
        branches = list(Branch.objects.filter(id__in=ids).select_related("institute"))
        if not ids or len(branches) != len(ids):
            raise ValidationError({"branch_ids": "اختر فرعًا واحدًا على الأقل من فروع معروفة."})
        return branches
    model = {"department": Department, "branch": Branch, "institute": Institute}.get(target_type)
    if model is None:
        return None
    unit = model.objects.filter(id=target_id).first() if target_id else None
    if unit is None:
        raise ValidationError({"target_id": "وحدة الهدف غير معروفة."})
    return unit


def resolve_audience(*, publisher, target_type, unit, user_ids) -> list[str]:
    memberships = _active_memberships()
    if target_type == "users":
        ids = list(dict.fromkeys(str(u) for u in user_ids or []))
        if not ids:
            raise ValidationError({"user_ids": "حدد موظفًا واحدًا على الأقل."})
        found = set(
            str(u) for u in User.objects.filter(id__in=ids, is_active=True).values_list("id", flat=True)
        )
        if found != set(ids):
            raise ValidationError({"user_ids": "موظف غير معروف أو معطّل."})
        audience = ids
    elif target_type == "department":
        audience = memberships.filter(department=unit).values_list("user_id", flat=True)
    elif target_type == "branch":
        audience = memberships.filter(branch=unit).values_list("user_id", flat=True)
    elif target_type == "branches":
        audience = memberships.filter(branch__in=unit).values_list("user_id", flat=True)
    elif target_type == "institute":
        audience = memberships.filter(institute=unit).values_list("user_id", flat=True)
    elif target_type == "all":
        audience = memberships.values_list("user_id", flat=True)
    else:
        raise ValidationError({"target_type": "نوع هدف غير معروف."})
    out = [u for u in dict.fromkeys(str(x) for x in audience) if u != str(publisher.id)]
    if not out:
        raise ValidationError({"target_type": "لا يوجد مستلمون فعليون في هذا النطاق."})
    if len(out) > settings.ANNOUNCEMENT_MAX_RECIPIENTS:
        raise ValidationError(
            {"target_type": f"النطاق يضم {len(out)} مستلمًا؛ الحد الحالي {settings.ANNOUNCEMENT_MAX_RECIPIENTS}."}
        )
    return out


EXECUTIVE_ROLE = "executive"

# Who counts in compliance (totals, percentages, «متأخرون», reminders): the
# declared audience minus the executive's observer copy, deleted («موظف
# محذوف») and archived (deactivated) accounts — they can never acknowledge,
# so counting them only drags the percentages down (user decision 2026-11-27).
COUNTED = Q(observer=False, user__is_active=True, user__purged_at__isnull=True)
COUNTED_REL = Q(recipients__observer=False, recipients__user__is_active=True,
                recipients__user__purged_at__isnull=True)


def counted_recipients(announcement):
    return announcement.recipients.filter(COUNTED)


def executive_observer_ids(exclude=()) -> list:
    """Active holders of the central executive role, minus `exclude`."""
    from apps.authorization.models import UserRoleAssignment

    now = timezone.now()
    skip = {str(x) for x in exclude}
    ids = UserRoleAssignment.objects.filter(
        role__code=EXECUTIVE_ROLE, user__is_active=True, user__purged_at__isnull=True,
        institute__isnull=True, branch__isnull=True, department__isnull=True,
    ).filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now)).values_list("user_id", flat=True)
    return [u for u in dict.fromkeys(ids) if str(u) not in skip]


def _add_observers(announcement, user_ids, added_by) -> None:
    in_thread = set(ConversationMember.objects.filter(
        conversation=announcement.thread, user_id__in=user_ids
    ).values_list("user_id", flat=True))
    ConversationMember.objects.bulk_create([
        ConversationMember(conversation=announcement.thread, user_id=u, member_role="member", added_by=added_by)
        for u in user_ids if u not in in_thread
    ])
    AnnouncementRecipient.objects.bulk_create(
        [AnnouncementRecipient(announcement=announcement, user_id=u, observer=True) for u in user_ids],
        ignore_conflicts=True,
    )


def add_observer_to_all(user) -> int:
    """A newly appointed executive: every published announcement so far, as an
    observer (no notifications for the backlog)."""
    if user.id not in executive_observer_ids():
        return 0
    have = set(AnnouncementRecipient.objects.filter(user=user).values_list("announcement_id", flat=True))
    todo = Announcement.objects.filter(status__in=["published", "withdrawn"]).exclude(
        id__in=have).exclude(publisher=user).select_related("thread", "publisher")
    n = 0
    with transaction.atomic():
        for a in todo:
            _add_observers(a, [user.id], a.publisher)
            n += 1
    return n


def require_publish_permission(publisher, target_type, unit, audience) -> None:
    if target_type == "users":
        by_user: dict[str, list] = {}
        for m in _active_memberships().filter(user_id__in=audience).select_related(
            "institute", "branch", "department"
        ):
            by_user.setdefault(str(m.user_id), []).append(m)
        for uid in audience:
            if not any(
                has_permission(publisher, "announcements.publish", unit=_membership_unit(m))
                for m in by_user.get(uid, [])
            ):
                raise PermissionDenied("announcements.publish is not granted over every selected employee.")
        return
    if target_type == "branches":
        if not all(has_permission(publisher, "announcements.publish", unit=b) for b in unit):
            raise PermissionDenied("announcements.publish is not granted in every selected branch.")
        return
    if not has_permission(publisher, "announcements.publish", unit=unit):
        raise PermissionDenied("announcements.publish is not granted in the target unit.")


def publish_targets(user) -> dict:
    """Where `user` may publish: everyone, and which institutes/branches —
    computed once from their assignments (same rule as has_permission)."""
    from apps.authorization.services import active_assignments

    grants = list(active_assignments(user).filter(
        role__role_permissions__permission__code="announcements.publish"
    ).values_list("institute_id", "branch_id", "department_id"))
    central = any(i is None and b is None and d is None for i, b, d in grants)
    inst_ids = {i for i, b, d in grants if i is not None and b is None and d is None}
    branch_ids = {b for i, b, d in grants if b is not None and d is None}
    institutes = [i for i in Institute.objects.filter(is_active=True).order_by("name") if central or i.id in inst_ids]
    branches = [
        b for b in Branch.objects.filter(is_active=True).select_related("institute").order_by("institute__name", "name")
        if central or b.institute_id in inst_ids or b.id in branch_ids
    ]
    return {"all": central, "institutes": institutes, "branches": branches}


# --- visibility ------------------------------------------------------------------------

def recipient_row(user, announcement):
    return AnnouncementRecipient.objects.filter(announcement=announcement, user=user).first()


def can_view(user, announcement) -> bool:
    if announcement.publisher_id == user.id:
        return True
    return announcement.is_published and recipient_row(user, announcement) is not None


def _tracking_unit(announcement):
    return (
        announcement.target_department
        or announcement.target_branch
        or announcement.target_institute
        or (_membership_unit(announcement.publisher_membership) if announcement.target_type == "users" else None)
    )


def can_track(user, announcement) -> bool:
    if announcement.publisher_id == user.id:
        return True
    if announcement.target_type == "branches":
        branches = list(Branch.objects.filter(id__in=announcement.target_branch_ids))
        return bool(branches) and all(has_permission(user, "announcements.track_ack", unit=b) for b in branches)
    return has_permission(user, "announcements.track_ack", unit=_tracking_unit(announcement))


TRACKING_LIMIT = 500


def tracks_any(user) -> bool:
    """Holds announcements.track_ack somewhere (shows the «متابعة التعاميم» tab)."""
    from apps.authorization.services import active_assignments

    return active_assignments(user).filter(
        role__role_permissions__permission__code="announcements.track_ack"
    ).exists()


def trackable_announcements(user) -> list[Announcement]:
    """Published (or withdrawn) announcements whose compliance `user` may see —
    the latest TRACKING_LIMIT, newest first. Metadata only: the content stays
    with the publisher and the recipients (see announcement_content callers)."""
    from django.db.models import Count

    if not tracks_any(user):
        return []
    qs = (
        Announcement.objects.filter(status__in=["published", "withdrawn"])
        .select_related("publisher", "publisher_membership", "target_institute", "target_branch",
                        "target_department")
        .annotate(
            n_recipients=Count("recipients", filter=COUNTED_REL, distinct=True),
            n_read=Count("recipients", filter=COUNTED_REL & Q(recipients__read_at__isnull=False), distinct=True),
            n_acked=Count("recipients", filter=COUNTED_REL & Q(recipients__acknowledged_at__isnull=False), distinct=True),
        )
        .order_by("-published_at")[:TRACKING_LIMIT]
    )
    return [a for a in qs if can_track(user, a)]


def announcement_content(announcement, viewer) -> dict | None:
    """{title, body} for the publisher, or for recipients while not withdrawn."""
    if not announcement.content_message_id:
        return None
    if announcement.status == "withdrawn" and announcement.publisher_id != viewer.id:
        return None
    return message_content(announcement.content_message)


def get_viewable(user, announcement_id) -> Announcement:
    a = Announcement.objects.select_related("publisher", "thread", "content_message").filter(id=announcement_id).first()
    if a is None or not can_view(user, a):
        raise PermissionDenied("You are not a recipient of this announcement.")
    return a


def get_trackable(user, announcement_id) -> Announcement:
    a = Announcement.objects.select_related(
        "publisher", "publisher_membership", "target_department", "target_branch", "target_institute"
    ).filter(id=announcement_id).first()
    if a is None or not can_track(user, a):
        raise PermissionDenied("You cannot track this announcement.")
    return a


# --- publish ------------------------------------------------------------------------------

def preview_audience(*, publisher, target_type, target_id, user_ids, branch_ids=None) -> list[User]:
    """Who would receive it (the publisher confirms before publishing)."""
    unit = resolve_target(target_type, target_id, branch_ids)
    audience = resolve_audience(publisher=publisher, target_type=target_type, unit=unit, user_ids=user_ids)
    require_publish_permission(publisher, target_type, unit, audience)
    return list(User.objects.filter(id__in=audience).order_by("full_name", "username"))


def publish(*, publisher, target_type, target_id, user_ids, priority, requires_ack, ack_due_at,
            membership_id, client_ref, title, body, branch_ids=None) -> tuple[Announcement, bool]:
    """Resolve the audience, seal {title, body}, issue the number, notify."""
    existing = Announcement.objects.filter(publisher=publisher, client_ref=client_ref).first()
    if existing is not None:
        return existing, False
    title = (title or "").strip()
    if not title:
        raise ValidationError({"title": "العنوان مطلوب."})
    if len(title) > MAX_TITLE or len(body or "") > MAX_BODY:
        raise ValidationError({"body": "التعميم طويل جدًا."})
    if ack_due_at is not None and (not requires_ack or ack_due_at <= timezone.now()):
        raise ValidationError({"ack_due_at": "الموعد النهائي يتطلب طلب إقرار ويجب أن يكون في المستقبل."})
    membership = resolve_sender_membership(publisher, membership_id)
    unit = resolve_target(target_type, target_id, branch_ids)
    audience = resolve_audience(publisher=publisher, target_type=target_type, unit=unit, user_ids=user_ids)
    require_publish_permission(publisher, target_type, unit, audience)
    content = {"title": title, "body": body or ""}

    with transaction.atomic():
        thread = Conversation.objects.create(type="announcement", created_by=publisher)
        ConversationMember.objects.create(conversation=thread, user=publisher, member_role="admin", added_by=publisher)
        ConversationMember.objects.bulk_create(
            [ConversationMember(conversation=thread, user_id=u, member_role="member", added_by=publisher) for u in audience]
        )
        result = store_message(
            conversation=thread, requester=publisher, content=content,
            client_msg_id=client_ref, via_correspondence=True,
        )
        now = timezone.now()
        a = Announcement.objects.create(
            publisher=publisher,
            publisher_membership=membership,
            target_type=target_type,
            target_institute=unit if isinstance(unit, Institute) else getattr(unit, "institute", None),
            target_branch=unit if isinstance(unit, Branch) else getattr(unit, "branch", None),
            target_department=unit if isinstance(unit, Department) else None,
            target_branch_ids=[str(b.id) for b in unit] if target_type == "branches" else [],
            thread=thread,
            content_message=result.message,
            # Which version a recipient acknowledged (integrity evidence).
            content_hash=hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True).encode()).digest(),
            priority=priority,
            requires_ack=requires_ack,
            ack_due_at=ack_due_at,
            client_ref=client_ref,
            reference_number=allocate_reference(membership, now),
            status="published",
            published_at=now,
        )
        AnnouncementRecipient.objects.bulk_create(
            [AnnouncementRecipient(announcement=a, user_id=u) for u in audience]
        )
        observers = executive_observer_ids(exclude=[*audience, publisher.id])
        if observers:
            _add_observers(a, observers, publisher)
        notify([*audience, *observers], "announcement", ref_type="announcement", ref_id=a.id, actor=publisher)
    log(
        actor=publisher,
        action="announcement_published",
        target_type="announcement",
        target_id=a.id,
        metadata={"reference_number": a.reference_number, "target_type": target_type,
                  "recipient_count": len(audience)},
    )
    return a, True


def allocate_reference(membership, when) -> str:
    year = timezone.localtime(when).year
    for _ in range(3):
        try:
            with transaction.atomic():
                AnnouncementSequence.objects.get_or_create(institute_id=membership.institute_id, year=year)
                row = AnnouncementSequence.objects.select_for_update().get(
                    institute_id=membership.institute_id, year=year
                )
                row.last_seq += 1
                row.save(update_fields=["last_seq"])
                return f"{membership.institute.code}-TAM-{year}-{row.last_seq:05d}"
        except IntegrityError:
            continue
    raise Conflict("تعذر إصدار رقم التعميم؛ أعد المحاولة.")


def _target_unit(announcement):
    if announcement.target_type == "branches":
        return list(Branch.objects.filter(id__in=announcement.target_branch_ids))
    return {
        "department": announcement.target_department,
        "branch": announcement.target_branch,
        "institute": announcement.target_institute,
    }.get(announcement.target_type)


def missing_recipients(announcement) -> list[User]:
    """Employees who belong to the announcement's target today but were not in
    the audience snapshotted at publish time (joined or moved in later).
    Named-user announcements have no target to grow."""
    if announcement.status != "published" or announcement.target_type == "users":
        return []
    memberships = _active_memberships()
    unit = _target_unit(announcement)
    if announcement.target_type == "all":
        ids = memberships.values_list("user_id", flat=True)
    elif announcement.target_type == "branches":
        ids = memberships.filter(branch__in=unit).values_list("user_id", flat=True)
    elif unit is None:
        return []
    else:
        ids = memberships.filter(**{announcement.target_type: unit}).values_list("user_id", flat=True)
    existing = set(announcement.recipients.values_list("user_id", flat=True))
    missing = {u for u in ids if u not in existing and u != announcement.publisher_id}
    return list(User.objects.filter(id__in=missing, purged_at__isnull=True).order_by("full_name", "username"))


def can_add_recipients(user, announcement) -> bool:
    """Publisher, or someone who could publish to the same target."""
    if announcement.status != "published" or announcement.target_type == "users":
        return False
    if announcement.publisher_id == user.id:
        return True
    unit = _target_unit(announcement)
    if announcement.target_type == "branches":
        return bool(unit) and all(has_permission(user, "announcements.publish", unit=b) for b in unit)
    return has_permission(user, "announcements.publish", unit=unit)


def add_missing_recipients(user, announcement) -> int:
    """Deliver an already-published announcement to the employees who joined
    its target after publishing — same content, same number, same deadline."""
    if not can_add_recipients(user, announcement):
        raise PermissionDenied("لا تملك إضافة مستلمين لهذا التعميم.")
    new_ids = [u.id for u in missing_recipients(announcement)]
    if not new_ids:
        return 0
    if announcement.recipients.count() + len(new_ids) > settings.ANNOUNCEMENT_MAX_RECIPIENTS:
        raise ValidationError({"detail": f"سيتجاوز التعميم الحد ({settings.ANNOUNCEMENT_MAX_RECIPIENTS} مستلمًا)."})
    with transaction.atomic():
        in_thread = set(ConversationMember.objects.filter(
            conversation=announcement.thread, user_id__in=new_ids
        ).values_list("user_id", flat=True))
        ConversationMember.objects.bulk_create([
            ConversationMember(conversation=announcement.thread, user_id=u, member_role="member", added_by=user)
            for u in new_ids if u not in in_thread
        ])
        AnnouncementRecipient.objects.bulk_create(
            [AnnouncementRecipient(announcement=announcement, user_id=u) for u in new_ids],
            ignore_conflicts=True,
        )
        notify(new_ids, "announcement", ref_type="announcement", ref_id=announcement.id, actor=announcement.publisher)
    log(actor=user, action="announcement_recipients_added", target_type="announcement",
        target_id=announcement.id, metadata={"count": len(new_ids)})
    return len(new_ids)


def withdraw(user, announcement) -> Announcement:
    """Withdraw: recipients can no longer open the content (the publisher still can)."""
    if announcement.publisher_id != user.id:
        raise PermissionDenied("Only the publisher can withdraw.")
    if announcement.status != "published":
        raise Conflict("Only a published announcement can be withdrawn.")
    announcement.status = "withdrawn"
    announcement.withdrawn_at = timezone.now()
    announcement.save(update_fields=["status", "withdrawn_at"])
    log(actor=user, action="announcement_withdrawn", target_type="announcement", target_id=announcement.id)
    return announcement


# --- receipts ---------------------------------------------------------------------------------

def mark_delivered(user, announcement) -> None:
    if announcement.is_published:
        AnnouncementRecipient.objects.filter(
            announcement=announcement, user=user, delivered_at__isnull=True
        ).update(delivered_at=timezone.now())


def mark_read(user, announcement) -> None:
    now = timezone.now()
    row = recipient_row(user, announcement)
    if row is None or not announcement.is_published:
        return
    fields = []
    if row.delivered_at is None:
        row.delivered_at = now
        fields.append("delivered_at")
    if row.read_at is None:
        row.read_at = now
        fields.append("read_at")
    if fields:
        row.save(update_fields=fields)


def acknowledge(*, user, announcement) -> AnnouncementRecipient:
    """Server-recorded acknowledgement of the current content version."""
    row = recipient_row(user, announcement)
    if row is None:
        raise PermissionDenied("You are not a recipient of this announcement.")
    if announcement.status != "published":
        raise Conflict("لا يُقَر إلا بتعميم منشور وغير مسحوب.")
    if not announcement.requires_ack or row.observer:
        raise ValidationError({"detail": "هذا التعميم لا يتطلب إقرارًا منك."})
    if row.acknowledged_at is not None:
        return row  # idempotent
    now = timezone.now()
    row.acknowledged_at = now
    row.read_at = row.read_at or now
    row.delivered_at = row.delivered_at or now
    row.ack_content_hash = announcement.content_hash
    row.save(update_fields=["acknowledged_at", "read_at", "delivered_at", "ack_content_hash"])
    log(actor=user, action="announcement_acknowledged", target_type="announcement", target_id=announcement.id)
    return row


# --- compliance + reminders ------------------------------------------------------------------

def compliance(announcement) -> dict:
    from apps.org.labels import primary_units

    now = timezone.now()
    rows = list(counted_recipients(announcement).select_related("user").order_by("user__full_name"))
    units = primary_units(r.user_id for r in rows)
    overdue = bool(announcement.requires_ack and announcement.ack_due_at and announcement.ack_due_at < now)
    return {
        "total": len(rows),
        "delivered": sum(1 for r in rows if r.delivered_at),
        "read": sum(1 for r in rows if r.read_at),
        "acknowledged": sum(1 for r in rows if r.acknowledged_at),
        "overdue": sum(1 for r in rows if overdue and not r.acknowledged_at),
        "rows": [
            {
                "user": {
                    "id": str(r.user_id),
                    "full_name": r.user.full_name,
                    "username": r.user.username,
                    "branch": units.get(str(r.user_id), {}).get("branch"),
                    "institute": units.get(str(r.user_id), {}).get("institute"),
                },
                "delivered_at": r.delivered_at.isoformat() if r.delivered_at else None,
                "read_at": r.read_at.isoformat() if r.read_at else None,
                "acknowledged_at": r.acknowledged_at.isoformat() if r.acknowledged_at else None,
                "overdue": overdue and not r.acknowledged_at,
                "reminder_count": r.reminder_count,
            }
            for r in rows
        ],
    }


def _pending_ack_rows(announcement):
    return counted_recipients(announcement).filter(acknowledged_at__isnull=True)


def remind(user, announcement) -> int:
    if announcement.status != "published" or not announcement.requires_ack:
        raise ValidationError({"detail": "التذكير متاح لتعميم منشور يتطلب إقرارًا."})
    now = timezone.now()
    if announcement.recipients.filter(last_reminded_at__gt=now - REMIND_COOLDOWN).exists():
        raise Conflict("أُرسل تذكير خلال الساعة الماضية.")
    return _send_reminders(announcement, _pending_ack_rows(announcement), actor=user)


def _send_reminders(announcement, rows, actor=None) -> int:
    now = timezone.now()
    ids = list(rows.values_list("id", flat=True))
    users = list(rows.values_list("user_id", flat=True))
    if not ids:
        return 0
    with transaction.atomic():
        AnnouncementRecipient.objects.filter(id__in=ids).update(last_reminded_at=now)
        for r in AnnouncementRecipient.objects.filter(id__in=ids):
            r.reminder_count += 1
            r.save(update_fields=["reminder_count"])
        notify(users, "announcement_reminder", ref_type="announcement", ref_id=announcement.id)
    log(actor=actor, action="announcement_reminded", target_type="announcement", target_id=announcement.id,
        metadata={"count": len(ids), "automatic": actor is None})
    return len(ids)


def send_due_reminders(now=None) -> int:
    """Scheduled job (management command / cron): remind un-acknowledged
    recipients once a day from 24 h before the deadline onwards."""
    now = now or timezone.now()
    total = 0
    due = Announcement.objects.filter(
        status="published", requires_ack=True, ack_due_at__isnull=False, ack_due_at__lte=now + AUTO_REMIND_WINDOW
    )
    for a in due:
        rows = _pending_ack_rows(a).filter(
            Q(last_reminded_at__isnull=True) | Q(last_reminded_at__lte=now - AUTO_REMIND_WINDOW)
        )
        total += _send_reminders(a, rows)
    return total
