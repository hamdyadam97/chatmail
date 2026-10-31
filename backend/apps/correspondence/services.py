"""Official correspondence services.

Docs: docs/phase1/05-permissions-design.md §5.3 (read derivation),
docs/phase1/04-erd.md §4.2 د/ز.

Content is sealed at rest with the server key (apps.vault — user decision
2026-10-31, Outlook-style mail): any login of a participant reads it, from
any browser, with no device keys.

  * A correspondence thread is a ``messaging.Conversation(type=correspondence)``
    whose members are the sender and recipients; each sent item's
    {subject, body, attachment ids, forwarded quote} is one sealed message.
  * Drafts live on the server (sealed ``draft_enc``) so they follow the user.
  * Sending freezes the row and issues the reference number.
  * Replies stay in the thread; a forward opens a NEW thread whose content the
    server copies from the source, so new recipients never see the source
    thread itself.

Invariants:
  * can_read derives ONLY from participant rows (sender + to/cc). No role,
    permission or org scope widens it (SEC-01/02/14).
  * Audit/event metadata carries identifiers and counters only (SEC-10).
"""
import hashlib
import uuid
from dataclasses import dataclass
from datetime import timedelta

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import FileSystemStorage
from django.db import IntegrityError, transaction
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError
from rest_framework.status import HTTP_409_CONFLICT

from apps import vault
from apps.accounts.models import User
from apps.audit.services import log
from apps.authorization.services import has_permission
from apps.messaging.models import Conversation, ConversationMember
from apps.messaging.services import get_active_membership, message_content, store_message
from apps.notifications.services import notify
from apps.org.models import EmployeeMembership

from .models import (
    Correspondence,
    CorrespondenceEvent,
    CorrespondenceForwarding,
    CorrespondenceParticipant,
    EncryptedAttachment,
    ReferenceSequence,
    StoredFile,
)

MAX_RECIPIENTS = 200
RECIPIENT_KINDS = ("to", "cc", "bcc")


class Conflict(APIException):
    status_code = HTTP_409_CONFLICT
    default_detail = "conflict"
    default_code = "conflict"


# --- read derivation (§5.3) ---------------------------------------------------

def participant_row(user, correspondence):
    return CorrespondenceParticipant.objects.filter(
        correspondence=correspondence, user=user, removed_at__isnull=True
    ).first()


def can_read(user, correspondence) -> bool:
    """Sender, or a live to/cc/bcc participant of a SENT correspondence."""
    if user is None or not getattr(user, "is_authenticated", False):
        return False
    if correspondence.sender_id == user.id:
        return True
    if not correspondence.is_sent:
        return False
    return CorrespondenceParticipant.objects.filter(
        correspondence=correspondence,
        user=user,
        kind__in=RECIPIENT_KINDS,
        removed_at__isnull=True,
    ).exists()


def get_readable(user, correspondence_id) -> Correspondence:
    """Object-permission gate. Unknown ids and forbidden ids both answer 403
    (no existence oracle); the DRF hook audits the denial."""
    correspondence = (
        Correspondence.objects.select_related("sender", "thread", "content_message")
        .filter(id=correspondence_id)
        .first()
    )
    if correspondence is None or not can_read(user, correspondence):
        raise PermissionDenied("You are not a participant of this correspondence.")
    return correspondence


def readable_ids_subquery(user):
    """Correspondence ids the user may read — for list/search filters."""
    return CorrespondenceParticipant.objects.filter(
        user=user, removed_at__isnull=True
    ).filter(
        Q(kind="from") | Q(kind__in=RECIPIENT_KINDS, correspondence__status__in=["sent", "closed"])
    ).values("correspondence_id")


def visible_participants(correspondence, viewer) -> list[CorrespondenceParticipant]:
    """BCC rows are visible only to the sender and to that BCC user (§5.4)."""
    rows = list(
        correspondence.participants.filter(removed_at__isnull=True).select_related("user")
    )
    return [
        p
        for p in rows
        if not p.hidden_from_others
        or viewer.id in (correspondence.sender_id, p.user_id)
    ]


# --- sender capacity + permission --------------------------------------------

def resolve_sender_membership(user, membership_id=None) -> EmployeeMembership:
    today = timezone.localdate()
    qs = EmployeeMembership.objects.filter(user=user).filter(
        Q(ended_on__isnull=True) | Q(ended_on__gte=today)
    ).select_related("institute", "branch", "department")
    membership = qs.filter(id=membership_id).first() if membership_id else qs.filter(
        is_primary=True
    ).first() or qs.first()
    if membership is None:
        raise ValidationError(
            {"sender_membership_id": "لا توجد عضوية تنظيمية سارية تُصدر باسمها المراسلة."}
        )
    return membership


def _membership_unit(membership):
    return membership.department or membership.branch or membership.institute


def require_send_permission(user, membership) -> None:
    if not has_permission(user, "correspondence.send", unit=_membership_unit(membership)):
        raise PermissionDenied("correspondence.send is not granted in this unit.")


# --- reference numbers -------------------------------------------------------

def format_reference(membership, year: int, seq: int) -> str:
    parts = [membership.institute.code]
    if membership.branch_id:
        parts.append(membership.branch.code)
    parts.extend([str(year), f"{seq:06d}"])
    return "-".join(parts)


def allocate_reference_number(membership, when) -> str:
    """Next number for (institute, year) under a row lock — duplicate-safe.

    The sequence row is created on first use; a concurrent creator loses the
    unique-constraint race and simply retries against the existing row.
    """
    year = timezone.localtime(when).year
    for _ in range(3):
        try:
            with transaction.atomic():
                ReferenceSequence.objects.get_or_create(
                    institute_id=membership.institute_id, year=year
                )
                row = ReferenceSequence.objects.select_for_update().get(
                    institute_id=membership.institute_id, year=year
                )
                row.last_seq += 1
                row.save(update_fields=["last_seq"])
                return format_reference(membership, year, row.last_seq)
        except IntegrityError:
            continue
    raise Conflict("Could not allocate a reference number; retry.")


# --- content -----------------------------------------------------------------

MAX_SUBJECT = 500
MAX_BODY = 100_000


def build_content(*, subject: str, body: str, attachment_ids, forwarded: dict | None = None) -> dict:
    subject = (subject or "").strip()
    if len(subject) > MAX_SUBJECT:
        raise ValidationError({"subject": f"الحد الأقصى {MAX_SUBJECT} حرف."})
    if len(body or "") > MAX_BODY:
        raise ValidationError({"body": "النص طويل جدًا."})
    content = {"subject": subject, "body": body or "", "attachments": [str(i) for i in attachment_ids]}
    if forwarded:
        content["forwarded"] = forwarded
    return content


def correspondence_content(correspondence) -> dict | None:
    """Opened content of a sent item, or of a draft (None if neither opens)."""
    if correspondence.content_message_id:
        return message_content(correspondence.content_message)
    if correspondence.draft_enc:
        try:
            return vault.open_json(correspondence.draft_enc, purpose="draft", owner=correspondence.id)
        except vault.VaultError:
            return None
    return None


# --- create / edit drafts, send ------------------------------------------------

def _load_recipients(requester, to_ids, cc_ids, bcc_ids, *, require_to: bool) -> dict[str, list[User]]:
    if bcc_ids and not settings.CORRESPONDENCE_BCC_ENABLED:
        raise ValidationError({"bcc_user_ids": "النسخة المخفية (BCC) معطّلة بسياسة النظام."})
    if bcc_ids:
        # Thread members see each other; a hidden recipient would need its own
        # per-recipient thread, which is not built. Refuse rather than leak.
        raise ValidationError({"bcc_user_ids": "BCC requires per-recipient threads (not built yet)."})
    to_ids = [str(i) for i in to_ids]
    cc_ids = [str(i) for i in cc_ids]
    if require_to and not to_ids:
        raise ValidationError({"to_user_ids": "مستلم واحد على الأقل في «إلى»."})
    all_ids = to_ids + cc_ids
    if len(all_ids) != len(set(all_ids)):
        raise ValidationError({"cc_user_ids": "لا يتكرر المستلم في «إلى» و«نسخة»."})
    if len(all_ids) > MAX_RECIPIENTS:
        raise ValidationError({"to_user_ids": f"الحد الأقصى {MAX_RECIPIENTS} مستلمًا."})
    if str(requester.id) in all_ids:
        raise ValidationError({"to_user_ids": "لا يمكن إرسال المراسلة إلى نفسك."})
    users = {str(u.id): u for u in User.objects.filter(id__in=all_ids, is_active=True)}
    if len(users) != len(all_ids):
        raise ValidationError({"to_user_ids": "مستلم غير معروف أو معطّل."})
    return {"to": [users[i] for i in to_ids], "cc": [users[i] for i in cc_ids]}


@dataclass
class PrepareResult:
    correspondence: Correspondence
    created: bool


def _existing_by_client_ref(requester, client_ref):
    return Correspondence.objects.filter(sender=requester, client_ref=client_ref).first()


def _set_audience(correspondence, requester, recipients, added_via) -> None:
    """(Re)write the participant rows and thread members of an unsent item."""
    thread = correspondence.thread
    correspondence.participants.all().delete()
    thread.members.exclude(user=requester).delete()
    if not thread.members.filter(user=requester).exists():
        ConversationMember.objects.create(
            conversation=thread, user=requester, member_role="admin", added_by=requester
        )
    CorrespondenceParticipant.objects.create(
        correspondence=correspondence, user=requester, kind="from", added_via=added_via
    )
    for kind in ("to", "cc"):
        for user in recipients[kind]:
            ConversationMember.objects.create(
                conversation=thread, user=user, member_role="member", added_by=requester
            )
            CorrespondenceParticipant.objects.create(
                correspondence=correspondence, user=user, kind=kind, added_via=added_via
            )


def _seal_draft(correspondence, content: dict) -> None:
    correspondence.draft_enc = vault.seal_json(content, purpose="draft", owner=correspondence.id)


def create_correspondence(
    *,
    requester,
    to_ids,
    cc_ids,
    bcc_ids,
    priority,
    classification,
    due_date,
    membership_id,
    client_ref,
    subject,
    body,
    attachment_ids,
    send: bool,
    forward_source: Correspondence | None = None,
) -> PrepareResult:
    """New correspondence (or forward): saved as a draft, then sent when
    ``send`` — one call from the compose window."""
    existing = _existing_by_client_ref(requester, client_ref)
    if existing is not None:
        if send and not existing.is_sent:
            send_correspondence(requester=requester, correspondence=existing)
            existing.refresh_from_db()
        return PrepareResult(existing, created=False)
    membership = resolve_sender_membership(requester, membership_id)
    require_send_permission(requester, membership)
    recipients = _load_recipients(requester, to_ids, cc_ids, bcc_ids, require_to=send)
    files = _resolve_attachments(requester, attachment_ids)
    forwarded = None
    if forward_source is not None:
        if not (forward_source.is_sent and can_read(requester, forward_source)):
            raise PermissionDenied("You are not a participant of the source correspondence.")
        source = correspondence_content(forward_source) or {}
        forwarded = {
            "reference_number": forward_source.reference_number,
            "sender_name": forward_source.sender.full_name,
            "sent_at": forward_source.sent_at.isoformat() if forward_source.sent_at else None,
            "subject": source.get("subject", ""),
            "body": source.get("body", ""),
        }
        # The forward carries the source's attachments too (download rights
        # follow the new binding).
        source_files = [str(i) for i in source.get("attachments", [])]
        attachment_ids = source_files + [str(f.id) for f in files if str(f.id) not in source_files]
    content = build_content(subject=subject, body=body, attachment_ids=[str(i) for i in attachment_ids],
                            forwarded=forwarded)

    added_via = "forward" if forward_source is not None else "original"
    with transaction.atomic():
        thread = Conversation.objects.create(type="correspondence", created_by=requester)
        correspondence = Correspondence(
            sender=requester,
            sender_membership=membership,
            thread=thread,
            priority=priority,
            classification=classification,
            due_date=due_date,
            client_ref=client_ref,
        )
        _seal_draft(correspondence, content)
        correspondence.save(force_insert=True)
        _set_audience(correspondence, requester, recipients, added_via)
        if forward_source is not None:
            CorrespondenceForwarding.objects.create(
                source=forward_source, forwarded_by=requester, new_correspondence=correspondence
            )
        CorrespondenceEvent.objects.create(
            correspondence=correspondence,
            actor=requester,
            event_type="created",
            metadata={"recipient_count": len(recipients["to"]) + len(recipients["cc"])},
        )
    log(
        actor=requester,
        action="correspondence_forward_prepared" if forward_source else "correspondence_prepared",
        target_type="correspondence",
        target_id=correspondence.id,
        metadata={
            "recipient_count": len(recipients["to"]) + len(recipients["cc"]),
            "source_id": str(forward_source.id) if forward_source else None,
        },
    )
    if send:
        correspondence = send_correspondence(requester=requester, correspondence=correspondence)
    return PrepareResult(correspondence, created=True)


def update_draft(*, requester, correspondence, to_ids, cc_ids, priority, classification, due_date,
                 subject, body, attachment_ids) -> Correspondence:
    if correspondence.sender_id != requester.id:
        raise PermissionDenied("Only the sender can edit this draft.")
    if correspondence.is_sent:
        raise Conflict("A sent correspondence is immutable.")
    recipients = _load_recipients(requester, to_ids, cc_ids, [], require_to=False)
    _resolve_attachments(requester, attachment_ids)
    previous = correspondence_content(correspondence) or {}
    content = build_content(subject=subject, body=body, attachment_ids=attachment_ids,
                            forwarded=previous.get("forwarded"))
    added_via = "forward" if hasattr(correspondence, "forwarded_from") else "original"
    with transaction.atomic():
        correspondence.priority = priority
        correspondence.classification = classification
        correspondence.due_date = due_date
        _seal_draft(correspondence, content)
        correspondence.save(update_fields=["priority", "classification", "due_date", "draft_enc"])
        _set_audience(correspondence, requester, recipients, added_via)
    return correspondence


def prepare_reply(*, requester, parent, priority, due_date, membership_id, client_ref,
                  subject, body, attachment_ids) -> PrepareResult:
    """A reply stays in the parent's thread: its audience is the thread's
    live members (reply-all). To answer a subset, start a new correspondence."""
    existing = _existing_by_client_ref(requester, client_ref)
    if existing is not None:
        if existing.reply_to_id != parent.id:
            raise ValidationError({"client_ref": "client_ref already used for another item."})
        return PrepareResult(existing, created=False)
    if not parent.is_sent:
        raise ValidationError({"detail": "Cannot reply to an unsent correspondence."})
    if parent.status == "closed":
        raise ValidationError({"detail": "This correspondence is closed."})
    if get_active_membership(parent.thread_id, requester) is None:
        raise PermissionDenied("You are not a member of this correspondence thread.")
    membership = resolve_sender_membership(requester, membership_id)
    require_send_permission(requester, membership)
    _resolve_attachments(requester, attachment_ids)
    content = build_content(subject=subject, body=body, attachment_ids=attachment_ids)

    audience = [
        p
        for p in visible_participants(parent, requester)
        if p.kind != "bcc" and p.user_id != requester.id and p.user.is_active
    ]
    if not audience:
        raise ValidationError({"detail": "No active recipient left in this thread."})
    users = [p.user for p in audience]
    if parent.sender_id != requester.id:
        to_users = [u for u in users if u.id == parent.sender_id]
    else:  # following up on my own correspondence: same "to" as before
        to_users = [p.user for p in audience if p.kind == "to"]
    to_users = to_users or users[:1]
    recipients = {"to": to_users, "cc": [u for u in users if u not in to_users]}

    root = parent.thread_root or parent
    with transaction.atomic():
        correspondence = Correspondence(
            sender=requester,
            sender_membership=membership,
            thread=parent.thread,
            thread_root=root,
            reply_to=parent,
            priority=priority,
            classification=parent.classification,
            due_date=due_date,
            client_ref=client_ref,
        )
        _seal_draft(correspondence, content)
        correspondence.save(force_insert=True)
        CorrespondenceParticipant.objects.create(
            correspondence=correspondence, user=requester, kind="from", added_via="reply"
        )
        for kind in ("to", "cc"):
            for user in recipients[kind]:
                CorrespondenceParticipant.objects.create(
                    correspondence=correspondence, user=user, kind=kind, added_via="reply"
                )
        CorrespondenceEvent.objects.create(
            correspondence=correspondence, actor=requester, event_type="created",
            metadata={"reply_to": str(parent.id)},
        )
    return PrepareResult(correspondence, created=True)


# --- send (freeze) ------------------------------------------------------------

def _resolve_attachments(requester, attachment_ids) -> list[StoredFile]:
    ids = [str(i) for i in attachment_ids]
    if len(ids) != len(set(ids)):
        raise ValidationError({"attachment_ids": "duplicate attachment id."})
    if len(ids) > settings.CORRESPONDENCE_MAX_ATTACHMENTS:
        raise ValidationError({"attachment_ids": "too many attachments."})
    files = list(StoredFile.objects.filter(id__in=ids, deleted_at__isnull=True))
    if len(files) != len(ids):
        raise ValidationError({"attachment_ids": "unknown attachment."})
    for stored in files:
        if not can_download(requester, stored):
            raise PermissionDenied("You cannot share an attachment you cannot access.")
    return files


def send_correspondence(*, requester, correspondence) -> Correspondence:
    """Freeze a draft: its sealed content becomes the thread message, the
    reference number is issued and recipients are notified."""
    if correspondence.sender_id != requester.id:
        raise PermissionDenied("Only the sender can send this correspondence.")
    if correspondence.is_sent:
        return correspondence  # idempotent retry
    if get_active_membership(correspondence.thread_id, requester) is None:
        raise PermissionDenied("You are not a member of this correspondence thread.")
    content = correspondence_content(correspondence)
    if content is None:
        raise ValidationError({"detail": "Draft content is missing."})
    if not content["subject"] and not content["body"].strip():
        raise ValidationError({"subject": "اكتب عنوانًا أو نصًا."})
    if not correspondence.participants.filter(kind="to", removed_at__isnull=True).exists():
        raise ValidationError({"to_user_ids": "مستلم واحد على الأقل في «إلى»."})
    files = _resolve_attachments(requester, content["attachments"])

    with transaction.atomic():
        locked = Correspondence.objects.select_for_update().get(pk=correspondence.pk)
        if locked.is_sent:
            return locked
        result = store_message(
            conversation=locked.thread,
            requester=requester,
            content=content,
            client_msg_id=uuid.uuid4(),
            via_correspondence=True,
        )
        now = timezone.now()
        locked.reference_number = allocate_reference_number(locked.sender_membership, now)
        locked.content_message = result.message
        locked.draft_enc = None
        locked.status = "sent"
        locked.sent_at = now
        locked.save(update_fields=["reference_number", "content_message", "draft_enc", "status", "sent_at"])
        for stored in files:
            EncryptedAttachment.objects.get_or_create(stored_file=stored, correspondence=locked)
        CorrespondenceEvent.objects.create(
            correspondence=locked, actor=requester, event_type="sent",
            metadata={"attachment_count": len(files), "seq": result.message.seq},
        )
        if locked.reply_to_id:
            CorrespondenceEvent.objects.create(
                correspondence_id=locked.reply_to_id, actor=requester, event_type="replied",
                metadata={"reply_id": str(locked.id)},
            )
        forwarding = CorrespondenceForwarding.objects.filter(new_correspondence=locked).first()
        if forwarding is not None:
            CorrespondenceEvent.objects.create(
                correspondence_id=forwarding.source_id, actor=requester, event_type="forwarded",
                metadata={"forward_id": str(locked.id)},
            )
        recipients = locked.participants.filter(
            kind__in=RECIPIENT_KINDS, removed_at__isnull=True
        ).values_list("user_id", flat=True)
        kind = (
            "correspondence_forward" if forwarding is not None
            else "correspondence_reply" if locked.reply_to_id
            else "new_correspondence"
        )
        notify(recipients, kind, ref_type="correspondence", ref_id=locked.id, actor=requester)
    log(
        actor=requester,
        action="correspondence_sent",
        target_type="correspondence",
        target_id=locked.id,
        metadata={
            "reference_number": locked.reference_number,
            "attachment_count": len(files),
            "is_reply": bool(locked.reply_to_id),
            "is_forward": forwarding is not None,
        },
    )
    if forwarding is not None:
        log(
            actor=requester,
            action="forward",
            target_type="correspondence",
            target_id=forwarding.source_id,
            metadata={"new_correspondence_id": str(locked.id)},
        )
    return locked


# --- per-user state -----------------------------------------------------------

def mark_read(user, correspondence) -> None:
    row = participant_row(user, correspondence)
    if row is None or row.kind == "from" or row.read_at is not None:
        return
    row.read_at = timezone.now()
    row.save(update_fields=["read_at"])
    CorrespondenceEvent.objects.create(correspondence=correspondence, actor=user, event_type="read")


def set_flags(user, correspondence, *, archived=None, important=None) -> CorrespondenceParticipant:
    row = participant_row(user, correspondence)
    if row is None:
        raise PermissionDenied("You are not a participant of this correspondence.")
    fields = []
    if archived is not None:
        row.archived_at = timezone.now() if archived else None
        fields.append("archived_at")
    if important is not None:
        row.is_important = bool(important)
        fields.append("is_important")
    if fields:
        row.save(update_fields=fields)
    return row


def close_correspondence(user, correspondence) -> Correspondence:
    if correspondence.sender_id != user.id:
        raise PermissionDenied("Only the sender can close this correspondence.")
    if correspondence.status != "sent":
        raise ValidationError({"detail": "Only a sent correspondence can be closed."})
    correspondence.status = "closed"
    correspondence.save(update_fields=["status"])
    CorrespondenceEvent.objects.create(correspondence=correspondence, actor=user, event_type="closed")
    return correspondence


def discard_draft(user, correspondence_id) -> None:
    correspondence = Correspondence.objects.filter(id=correspondence_id).first()
    if correspondence is None or correspondence.sender_id != user.id:
        raise PermissionDenied("You are not the sender of this correspondence.")
    if correspondence.is_sent:
        raise Conflict("A sent correspondence cannot be deleted.")
    thread = correspondence.thread
    with transaction.atomic():
        correspondence.delete()
        if not Correspondence.objects.filter(thread=thread).exists():
            thread.delete()


# --- folders ------------------------------------------------------------------

FOLDERS = ("inbox", "sent", "drafts", "archived", "important", "pending_replies")


def folder_queryset(user, folder: str):
    rows = CorrespondenceParticipant.objects.filter(user=user, removed_at__isnull=True)
    sent_states = ["sent", "closed"]
    if folder == "inbox":
        rows = rows.filter(
            kind__in=RECIPIENT_KINDS, archived_at__isnull=True,
            correspondence__status__in=sent_states,
        )
    elif folder == "sent":
        rows = rows.filter(kind="from", archived_at__isnull=True, correspondence__status__in=sent_states)
    elif folder == "drafts":
        rows = rows.filter(kind="from", correspondence__status="draft")
    elif folder == "archived":
        rows = rows.filter(archived_at__isnull=False, correspondence__status__in=sent_states)
    elif folder == "important":
        rows = rows.filter(is_important=True, correspondence__status__in=sent_states)
    elif folder == "pending_replies":
        my_reply = Correspondence.objects.filter(
            reply_to=OuterRef("correspondence_id"), sender=user, status__in=sent_states
        )
        rows = rows.filter(
            kind="to", archived_at__isnull=True, correspondence__status="sent"
        ).filter(~Exists(my_reply))
    else:
        raise ValidationError({"folder": f"folder must be one of {', '.join(FOLDERS)}."})
    return rows.select_related(
        "correspondence", "correspondence__sender", "correspondence__thread"
    )


# --- due-date reminders (scheduled) ---------------------------------------------

def _awaiting_my_reply(rows):
    """Primary recipients who have not replied — same rule as the
    pending_replies folder (archived = the user dismissed it)."""
    my_reply = Correspondence.objects.filter(
        reply_to=OuterRef("correspondence_id"), sender=OuterRef("user_id"), status__in=["sent", "closed"]
    )
    return rows.filter(
        kind="to", removed_at__isnull=True, archived_at__isnull=True,
        correspondence__status="sent", correspondence__due_date__isnull=False,
    ).filter(~Exists(my_reply))


def send_due_reminders(today=None) -> dict:
    """Hourly job: generic notifications (no content) about due dates.

    * due today or tomorrow → each waiting primary recipient, once;
    * past due → each waiting primary recipient once, and the sender once.
    Closed, archived or answered correspondence never triggers anything.
    """
    today = today or timezone.localdate()
    now = timezone.now()
    counts = {"due_soon": 0, "overdue": 0, "overdue_sender": 0}
    pending = _awaiting_my_reply(CorrespondenceParticipant.objects.all())

    with transaction.atomic():
        soon = list(pending.filter(
            due_reminded_at__isnull=True,
            correspondence__due_date__gte=today,
            correspondence__due_date__lte=today + timedelta(days=1),
        ))
        for row in soon:
            notify([row.user_id], "correspondence_due_soon", ref_type="correspondence", ref_id=row.correspondence_id)
        CorrespondenceParticipant.objects.filter(id__in=[r.id for r in soon]).update(due_reminded_at=now)
        counts["due_soon"] = len(soon)

        late = list(pending.filter(overdue_notified_at__isnull=True, correspondence__due_date__lt=today))
        for row in late:
            notify([row.user_id], "correspondence_overdue", ref_type="correspondence", ref_id=row.correspondence_id)
        CorrespondenceParticipant.objects.filter(id__in=[r.id for r in late]).update(overdue_notified_at=now)
        counts["overdue"] = len(late)

        senders = list(CorrespondenceParticipant.objects.filter(
            correspondence_id__in={r.correspondence_id for r in late},
            kind="from", removed_at__isnull=True, overdue_notified_at__isnull=True,
        ))
        for row in senders:
            notify([row.user_id], "correspondence_overdue_sender", ref_type="correspondence", ref_id=row.correspondence_id)
        CorrespondenceParticipant.objects.filter(id__in=[r.id for r in senders]).update(overdue_notified_at=now)
        counts["overdue_sender"] = len(senders)
    return counts


# --- attachments (sealed at rest) -----------------------------------------------

def blob_storage() -> FileSystemStorage:
    return FileSystemStorage(location=settings.ENCRYPTED_BLOB_ROOT)


def store_blob(user, data: bytes, *, name: str, mime: str) -> StoredFile:
    """Seal an uploaded file with the server key; name and type are sealed too."""
    if not data:
        raise ValidationError({"file": "الملف فارغ."})
    if len(data) > settings.ENCRYPTED_ATTACHMENT_MAX_BYTES:
        raise ValidationError({"file": "الملف أكبر من الحد المسموح."})
    stored = StoredFile(uploader=user)
    sealed = vault.seal(data, purpose="file", owner=stored.id)
    key_hex = uuid.uuid4().hex
    storage_key = f"{key_hex[:2]}/{key_hex[2:4]}/{key_hex}"
    stored.storage_key = blob_storage().save(storage_key, ContentFile(sealed))
    stored.ciphertext_size = len(sealed)
    stored.ciphertext_sha256 = hashlib.sha256(sealed).digest()
    stored.meta_enc = vault.seal_json(
        {"name": (name or "attachment")[:255], "mime": (mime or "application/octet-stream")[:255], "size": len(data)},
        purpose="file-meta", owner=stored.id,
    )
    stored.save(force_insert=True)
    log(
        actor=user,
        action="attachment_uploaded",
        target_type="stored_file",
        target_id=stored.id,
        metadata={"size": len(data)},
    )
    return stored


def file_meta(stored_file) -> dict:
    try:
        meta = vault.open_json(stored_file.meta_enc, purpose="file-meta", owner=stored_file.id)
    except (vault.VaultError, TypeError):
        meta = {"name": "attachment", "mime": "application/octet-stream", "size": stored_file.ciphertext_size}
    return {"id": str(stored_file.id), **meta}


def can_download(user, stored_file) -> bool:
    """Uploader before binding, a reader of any correspondence it is bound
    to, or an archive officer for archived correspondence."""
    from apps.archive.services import officer_may_download

    bindings = list(
        EncryptedAttachment.objects.filter(
            stored_file=stored_file, correspondence__isnull=False
        ).select_related("correspondence")
    )
    if not bindings:
        return stored_file.uploader_id == user.id
    return any(can_read(user, b.correspondence) for b in bindings) or officer_may_download(user, stored_file)


def get_downloadable(user, stored_file_id) -> StoredFile:
    stored = StoredFile.objects.filter(id=stored_file_id, deleted_at__isnull=True).first()
    if stored is None or not can_download(user, stored):
        raise PermissionDenied("You are not allowed to download this attachment.")
    return stored


def read_blob(stored_file) -> bytes:
    with blob_storage().open(stored_file.storage_key, "rb") as fh:
        return vault.open_(fh.read(), purpose="file", owner=stored_file.id)

