"""Announcement services: audience resolution, publish, receipts, signed
acknowledgements, compliance and reminders (prompt §10).

Invariants:
  * The audience is resolved server-side from active org memberships at
    prepare time and snapshotted; nobody outside it is a thread member, so
    nobody outside it can receive the key (no hidden recipients). Every
    recipient can list the declared audience and its client compares it with
    the MLS roster.
  * announcements.publish is checked in the target unit (central for "all";
    for named users, a unit holding each user's membership).
  * Compliance (who received/read/acknowledged) is metadata, visible to the
    publisher and to announcements.track_ack holders of the target unit —
    never the content.
"""
import hashlib
import json
from datetime import datetime, timedelta

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError
from rest_framework.status import HTTP_409_CONFLICT

from apps.accounts.models import TrustedDevice, User
from apps.approvals.services import canonical_bytes
from apps.audit.services import log
from apps.authorization.services import has_permission
from apps.correspondence.services import resolve_sender_membership
from apps.messaging.models import Conversation, ConversationMember
from apps.messaging.services import get_active_membership, store_message
from apps.notifications.services import notify
from apps.org.models import Branch, Department, EmployeeMembership, Institute

from .models import Announcement, AnnouncementRecipient, AnnouncementSequence

ACK_CONTEXT = b"announcement-ack-v1\n"
ACK_FIELDS = ("acknowledged_at", "announcement_id", "content_hash", "device_id", "user_id")
MAX_CLOCK_SKEW = timedelta(minutes=10)
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


# --- prepare / publish ---------------------------------------------------------------------

def prepare(*, publisher, target_type, target_id, user_ids, priority, requires_ack, ack_due_at,
            membership_id, mls_group_id: bytes, client_ref) -> tuple[Announcement, bool]:
    existing = Announcement.objects.filter(publisher=publisher, client_ref=client_ref).first()
    if existing is not None:
        return existing, False
    if not (16 <= len(mls_group_id) <= 32):
        raise ValidationError({"mls_group_id": "mls_group_id must be 16-32 bytes."})
    if ack_due_at is not None and (not requires_ack or ack_due_at <= timezone.now()):
        raise ValidationError({"ack_due_at": "الموعد النهائي يتطلب طلب إقرار ويجب أن يكون في المستقبل."})
    membership = resolve_sender_membership(publisher, membership_id)
    unit = resolve_target(target_type, target_id)
    audience = resolve_audience(publisher=publisher, target_type=target_type, unit=unit, user_ids=user_ids)
    require_publish_permission(publisher, target_type, unit, audience)
    if Conversation.objects.filter(mls_group_id=mls_group_id).exists():
        raise ValidationError({"mls_group_id": "mls_group_id already in use."})

    with transaction.atomic():
        thread = Conversation.objects.create(type="announcement", mls_group_id=mls_group_id, created_by=publisher)
        ConversationMember.objects.create(conversation=thread, user=publisher, member_role="admin", added_by=publisher)
        ConversationMember.objects.bulk_create(
            [ConversationMember(conversation=thread, user_id=u, member_role="member", added_by=publisher) for u in audience]
        )
        a = Announcement.objects.create(
            publisher=publisher,
            publisher_membership=membership,
            target_type=target_type,
            target_institute=unit if isinstance(unit, Institute) else getattr(unit, "institute", None),
            target_branch=unit if isinstance(unit, Branch) else getattr(unit, "branch", None),
            target_department=unit if isinstance(unit, Department) else None,
            thread=thread,
            priority=priority,
            requires_ack=requires_ack,
            ack_due_at=ack_due_at,
            client_ref=client_ref,
        )
        AnnouncementRecipient.objects.bulk_create(
            [AnnouncementRecipient(announcement=a, user_id=u) for u in audience]
        )
    log(
        actor=publisher,
        action="announcement_prepared",
        target_type="announcement",
        target_id=a.id,
        metadata={"target_type": target_type, "recipient_count": len(audience)},
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


def publish(*, publisher, announcement, mls_payload: bytes, client_msg_id, epoch, sender_device_id) -> Announcement:
    if announcement.publisher_id != publisher.id:
        raise PermissionDenied("Only the publisher can publish this announcement.")
    if announcement.is_published:
        if str(announcement.content_message.client_msg_id) == str(client_msg_id):
            return announcement
        raise Conflict("التعميم منشور ولا يُعدّل.")
    membership = get_active_membership(announcement.thread_id, publisher)
    with transaction.atomic():
        locked = Announcement.objects.select_for_update().select_related("publisher_membership__institute").get(
            pk=announcement.pk
        )
        if locked.is_published:
            raise Conflict("التعميم منشور ولا يُعدّل.")
        result = store_message(
            conversation=locked.thread,
            requester=publisher,
            membership=membership,
            kind="application",
            mls_payload=mls_payload,
            client_msg_id=client_msg_id,
            epoch=epoch,
            sender_device_id=sender_device_id,
            via_correspondence=True,
        )
        if not result.created:
            raise Conflict("client_msg_id already used.")
        now = timezone.now()
        locked.reference_number = allocate_reference(locked.publisher_membership, now)
        locked.content_message = result.message
        locked.content_hash = hashlib.sha256(mls_payload).digest()
        locked.status = "published"
        locked.published_at = now
        locked.save(update_fields=["reference_number", "content_message", "content_hash", "status", "published_at"])
        recipients = list(locked.recipients.values_list("user_id", flat=True))
        notify(recipients, "announcement", ref_type="announcement", ref_id=locked.id)
    log(
        actor=publisher,
        action="announcement_published",
        target_type="announcement",
        target_id=locked.id,
        metadata={"reference_number": locked.reference_number, "recipient_count": len(recipients)},
    )
    return locked


def discard_draft(user, announcement_id) -> None:
    a = Announcement.objects.filter(id=announcement_id).first()
    if a is None or a.publisher_id != user.id:
        raise PermissionDenied("Not your announcement.")
    if a.is_published:
        raise Conflict("A published announcement cannot be deleted; withdraw it instead.")
    thread = a.thread
    with transaction.atomic():
        a.delete()
        thread.delete()


def withdraw(user, announcement) -> Announcement:
    """Marks the announcement withdrawn (metadata). Copies already decrypted on
    recipients devices cannot be recalled — declared to the user in the UI."""
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


def expected_ack_payload(*, announcement, user, device_id, acknowledged_at) -> dict:
    import base64

    return {
        "acknowledged_at": acknowledged_at,
        "announcement_id": str(announcement.id),
        "content_hash": base64.b64encode(bytes(announcement.content_hash)).decode(),
        "device_id": str(device_id),
        "user_id": str(user.id),
    }


def acknowledge(*, user, announcement, payload: bytes, signature: bytes, device_id) -> AnnouncementRecipient:
    row = recipient_row(user, announcement)
    if row is None:
        raise PermissionDenied("You are not a recipient of this announcement.")
    if announcement.status != "published":
        raise Conflict("لا يُقَر إلا بتعميم منشور وغير مسحوب.")
    if not announcement.requires_ack:
        raise ValidationError({"detail": "هذا التعميم لا يتطلب إقرارًا."})
    if row.acknowledged_at is not None:
        return row  # idempotent
    device = TrustedDevice.objects.filter(id=device_id, user=user, status="active").first()
    if device is None or not device.identity_sign_pub:
        raise PermissionDenied("Acknowledgements must be signed by one of your active devices.")
    try:
        parsed = json.loads(payload.decode("ascii"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValidationError({"payload": "حمولة غير صالحة."})
    if not isinstance(parsed, dict) or tuple(sorted(parsed)) != ACK_FIELDS or canonical_bytes(parsed) != payload:
        raise ValidationError({"payload": "الحمولة ليست بالصيغة القانونية."})
    try:
        Ed25519PublicKey.from_public_bytes(bytes(device.identity_sign_pub)).verify(signature, ACK_CONTEXT + payload)
    except (InvalidSignature, ValueError):
        raise ValidationError({"signature": "توقيع الإقرار غير صالح."})
    try:
        when = datetime.fromisoformat(str(parsed["acknowledged_at"]).replace("Z", "+00:00"))
    except ValueError:
        raise ValidationError({"payload": "acknowledged_at غير صالح."})
    if when.tzinfo is None or abs(timezone.now() - when) > MAX_CLOCK_SKEW:
        raise ValidationError({"payload": "وقت الإقرار بعيد عن وقت الخادم."})
    expected = expected_ack_payload(
        announcement=announcement, user=user, device_id=device.id, acknowledged_at=parsed["acknowledged_at"]
    )
    if parsed != expected:
        raise ValidationError({"payload": "الحمولة لا تطابق هذا التعميم أو نسخته."})
    now = timezone.now()
    row.acknowledged_at = now
    row.read_at = row.read_at or now
    row.delivered_at = row.delivered_at or now
    row.ack_device = device
    row.ack_payload = payload
    row.ack_signature = signature
    row.save(update_fields=["acknowledged_at", "read_at", "delivered_at", "ack_device", "ack_payload", "ack_signature"])
    log(actor=user, actor_device=device, action="announcement_acknowledged", target_type="announcement",
        target_id=announcement.id)
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
