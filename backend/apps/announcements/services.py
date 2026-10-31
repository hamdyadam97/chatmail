"""Announcement services: audience resolution, publish, receipts,
acknowledgements, compliance and reminders (prompt §10).

Content {title, body} is sealed at rest with the server key (apps.vault).

Invariants:
  * The audience is resolved server-side from active org memberships at
    publish time and snapshotted; only the publisher and that audience can
    open the content. Every recipient can list the declared audience.
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


def resolve_target(target_type, target_id):
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
    if not has_permission(publisher, "announcements.publish", unit=unit):
        raise PermissionDenied("announcements.publish is not granted in the target unit.")


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
    return has_permission(user, "announcements.track_ack", unit=_tracking_unit(announcement))


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

def publish(*, publisher, target_type, target_id, user_ids, priority, requires_ack, ack_due_at,
            membership_id, client_ref, title, body) -> tuple[Announcement, bool]:
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
    unit = resolve_target(target_type, target_id)
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
        notify(audience, "announcement", ref_type="announcement", ref_id=a.id, actor=publisher)
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
    if not announcement.requires_ack:
        raise ValidationError({"detail": "هذا التعميم لا يتطلب إقرارًا."})
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
    now = timezone.now()
    rows = list(announcement.recipients.select_related("user").order_by("user__full_name"))
    overdue = bool(announcement.requires_ack and announcement.ack_due_at and announcement.ack_due_at < now)
    return {
        "total": len(rows),
        "delivered": sum(1 for r in rows if r.delivered_at),
        "read": sum(1 for r in rows if r.read_at),
        "acknowledged": sum(1 for r in rows if r.acknowledged_at),
        "overdue": sum(1 for r in rows if overdue and not r.acknowledged_at),
        "rows": [
            {
                "user": {"id": str(r.user_id), "full_name": r.user.full_name, "username": r.user.username},
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
    return announcement.recipients.filter(acknowledged_at__isnull=True)


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
