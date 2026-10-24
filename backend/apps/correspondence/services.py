"""Official correspondence services — metadata + ciphertext only.

Docs: docs/phase1/03-key-management.md §3.4 (one MLS group per thread),
docs/phase1/05-permissions-design.md §5.3 (read derivation),
docs/phase1/04-erd.md §4.2 د/ز.

Flow (all content encrypted on the client):
  1. prepare  — POST /correspondences/: creates the thread Conversation
     (type=correspondence, members = sender + recipients) and a draft row.
  2. MLS setup — the client posts Welcome(s) + Commit through the existing
     /conversations/{thread}/messages/ endpoint (pure delivery service).
  3. send — POST /correspondences/{id}/send/: stores the encrypted content
     (one MLS application message), binds attachments, allocates the
     reference number and freezes the row (immutable afterwards).
Replies live in the same thread (same MLS group). Forwards open a NEW thread
whose content the forwarder re-encrypted, so new recipients never see the
source thread.

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

from apps.accounts.models import User
from apps.audit.services import log
from apps.authorization.services import has_permission
from apps.messaging.models import Conversation, ConversationMember
from apps.messaging.services import get_active_membership, store_message
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


# --- prepare (root / reply / forward) -----------------------------------------

def _load_recipients(requester, to_ids, cc_ids, bcc_ids) -> dict[str, list[User]]:
    if bcc_ids and not settings.CORRESPONDENCE_BCC_ENABLED:
        raise ValidationError({"bcc_user_ids": "النسخة المخفية (BCC) معطّلة بسياسة النظام."})
    if bcc_ids:
        # MLS rosters are visible to every group member, so a BCC recipient
        # cannot share the thread's group; it needs its own per-recipient
        # thread, which is not built yet. Refuse rather than leak.
        raise ValidationError({"bcc_user_ids": "BCC requires per-recipient threads (not built yet)."})
    to_ids = [str(i) for i in to_ids]
    cc_ids = [str(i) for i in cc_ids]
    if not to_ids:
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


def _validate_group_id(mls_group_id: bytes) -> None:
    if not (16 <= len(mls_group_id) <= 32):
        raise ValidationError({"mls_group_id": "mls_group_id must be 16-32 bytes."})


@dataclass
class PrepareResult:
    correspondence: Correspondence
    created: bool


def _existing_by_client_ref(requester, client_ref):
    return Correspondence.objects.filter(sender=requester, client_ref=client_ref).first()


def _create_thread(requester, recipients: dict[str, list[User]], mls_group_id: bytes) -> Conversation:
    thread = Conversation.objects.create(
        type="correspondence", mls_group_id=mls_group_id, created_by=requester
    )
    ConversationMember.objects.create(
        conversation=thread, user=requester, member_role="admin", added_by=requester
    )
    for user in recipients["to"] + recipients["cc"]:
        ConversationMember.objects.create(
            conversation=thread, user=user, member_role="member", added_by=requester
        )
    return thread


def _add_participants(correspondence, requester, recipients, added_via) -> None:
    CorrespondenceParticipant.objects.create(
        correspondence=correspondence, user=requester, kind="from", added_via=added_via
    )
    for kind in ("to", "cc"):
        for user in recipients[kind]:
            CorrespondenceParticipant.objects.create(
                correspondence=correspondence, user=user, kind=kind, added_via=added_via
            )


def prepare_correspondence(
    *,
    requester,
    to_ids,
    cc_ids,
    bcc_ids,
    priority,
    classification,
    due_date,
    membership_id,
    mls_group_id: bytes,
    client_ref,
    forward_source: Correspondence | None = None,
) -> PrepareResult:
    existing = _existing_by_client_ref(requester, client_ref)
    if existing is not None:
        return PrepareResult(existing, created=False)
    membership = resolve_sender_membership(requester, membership_id)
    require_send_permission(requester, membership)
    recipients = _load_recipients(requester, to_ids, cc_ids, bcc_ids)
    _validate_group_id(mls_group_id)
    if Conversation.objects.filter(mls_group_id=mls_group_id).exists():
        raise ValidationError({"mls_group_id": "mls_group_id already in use."})
    if forward_source is not None and not (
        forward_source.is_sent and can_read(requester, forward_source)
    ):
        raise PermissionDenied("You are not a participant of the source correspondence.")

    added_via = "forward" if forward_source is not None else "original"
    with transaction.atomic():
        thread = _create_thread(requester, recipients, mls_group_id)
        correspondence = Correspondence.objects.create(
            sender=requester,
            sender_membership=membership,
            thread=thread,
            priority=priority,
            classification=classification,
            due_date=due_date,
            client_ref=client_ref,
        )
        _add_participants(correspondence, requester, recipients, added_via)
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
    return PrepareResult(correspondence, created=True)


def prepare_reply(*, requester, parent, priority, due_date, membership_id, client_ref) -> PrepareResult:
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
        correspondence = Correspondence.objects.create(
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
        _add_participants(correspondence, requester, recipients, "reply")
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


def send_correspondence(
    *,
    requester,
    correspondence,
    mls_payload: bytes,
    client_msg_id,
    epoch: int,
    sender_device_id,
    attachment_ids,
) -> Correspondence:
    if correspondence.sender_id != requester.id:
        raise PermissionDenied("Only the sender can send this correspondence.")
    if correspondence.is_sent:
        if str(correspondence.content_message.client_msg_id) == str(client_msg_id):
            return correspondence  # idempotent retry
        raise Conflict("Correspondence already sent; it is immutable.")
    thread_membership = get_active_membership(correspondence.thread_id, requester)
    if thread_membership is None:
        raise PermissionDenied("You are not a member of this correspondence thread.")
    files = _resolve_attachments(requester, attachment_ids)

    with transaction.atomic():
        locked = Correspondence.objects.select_for_update().get(pk=correspondence.pk)
        if locked.is_sent:
            raise Conflict("Correspondence already sent; it is immutable.")
        result = store_message(
            conversation=locked.thread,
            requester=requester,
            membership=thread_membership,
            kind="application",
            mls_payload=mls_payload,
            client_msg_id=client_msg_id,
            epoch=epoch,
            sender_device_id=sender_device_id,
            via_correspondence=True,
        )
        if not result.created:
            raise Conflict("client_msg_id already used in this thread.")
        now = timezone.now()
        locked.reference_number = allocate_reference_number(locked.sender_membership, now)
        locked.content_message = result.message
        locked.status = "sent"
        locked.sent_at = now
        locked.save(update_fields=["reference_number", "content_message", "status", "sent_at"])
        for stored in files:
            EncryptedAttachment.objects.create(stored_file=stored, correspondence=locked)
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


# --- encrypted blobs -----------------------------------------------------------

# Magic numbers of common plaintext formats. Our client format is
# IV(12) || AES-GCM ciphertext+tag, so a blob opening with one of these is
# almost certainly an unencrypted file (defense-in-depth; AGENTS rule 4).
_PLAINTEXT_MAGIC = (
    b"%PDF", b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"PK\x03\x04", b"\xd0\xcf\x11\xe0",
    b"{\\rtf", b"<?xml", b"<!DOC", b"<html", b"ID3", b"RIFF", b"\x1f\x8b",
)
MIN_BLOB_BYTES = 12 + 16 + 1  # IV + tag + one byte


def blob_storage() -> FileSystemStorage:
    return FileSystemStorage(location=settings.ENCRYPTED_BLOB_ROOT)


def blob_looks_plaintext(data: bytes) -> bool:
    if data.startswith(_PLAINTEXT_MAGIC):
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def store_blob(user, data: bytes) -> StoredFile:
    if len(data) < MIN_BLOB_BYTES:
        raise ValidationError({"file": "encrypted blob too small."})
    if len(data) > settings.ENCRYPTED_ATTACHMENT_MAX_BYTES:
        raise ValidationError({"file": "encrypted blob too large."})
    if blob_looks_plaintext(data):
        raise ValidationError({"file": "blob must be client-side encrypted, not plaintext."})
    key_hex = uuid.uuid4().hex
    storage_key = f"{key_hex[:2]}/{key_hex[2:4]}/{key_hex}"
    saved_key = blob_storage().save(storage_key, ContentFile(data))
    stored = StoredFile.objects.create(
        storage_key=saved_key,
        ciphertext_size=len(data),
        ciphertext_sha256=hashlib.sha256(data).digest(),
        uploader=user,
    )
    log(
        actor=user,
        action="attachment_uploaded",
        target_type="stored_file",
        target_id=stored.id,
        metadata={"ciphertext_size": len(data)},
    )
    return stored


def can_download(user, stored_file) -> bool:
    """Uploader before binding, or a reader of any correspondence it is bound
    to. Holding the blob is useless without the key carried in MLS content."""
    bindings = list(
        EncryptedAttachment.objects.filter(
            stored_file=stored_file, correspondence__isnull=False
        ).select_related("correspondence")
    )
    if not bindings:
        return stored_file.uploader_id == user.id
    return any(can_read(user, b.correspondence) for b in bindings)


def get_downloadable(user, stored_file_id) -> StoredFile:
    stored = StoredFile.objects.filter(id=stored_file_id, deleted_at__isnull=True).first()
    if stored is None or not can_download(user, stored):
        raise PermissionDenied("You are not allowed to download this attachment.")
    return stored


def read_blob(stored_file) -> bytes:
    with blob_storage().open(stored_file.storage_key, "rb") as fh:
        return fh.read()

