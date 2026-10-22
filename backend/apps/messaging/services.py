"""Chat delivery services — the server acts as a pure MLS Delivery Service.

Docs: docs/phase1/02-protocol-comparison.md §2.4 (server = dumb pipe),
docs/phase1/08-mls-spike-results.md §8.3 (Welcome/epoch semantics).

Invariants enforced here:
  * Every POSTed payload must be genuinely binary (MLS wire format). A payload
    that decodes as UTF-8 JSON text is rejected (defense-in-depth; SEC rules
    4 in AGENTS.md: no plaintext in E2EE endpoints).
  * Commit ordering is gated against the conversation row locked with
    select_for_update — epochs advance strictly one-by-one.
  * Welcome messages are addressed to a device and are only ever visible to
    that device's user (SEC-07 server side).
  * Audit metadata carries identifiers/counters only — never payloads (SEC-10).
"""
import base64
import secrets
from dataclasses import dataclass, field
from datetime import timedelta

import jwt
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError
from rest_framework.status import HTTP_409_CONFLICT

from apps.accounts.models import TrustedDevice
from apps.audit.services import log

from .models import Conversation, ConversationMember, GroupCryptoEpoch, Message, WelcomeRecipient

# MLS wire-format framing bytes accepted as proof of binary content
# (handshake/application content types used by the MLS stack).
MLS_WIRE_BYTES = frozenset({0x14, 0x15, 0x19, 0x0A, 0x0B})

KINDS_WITHOUT_SENDER = frozenset({"welcome"})

WS_TICKET_TTL_SECONDS = 30
WS_TICKET_CACHE_PREFIX = "ws-ticket:"

# Custom WS close codes (4000-4999 application range).
WS_CLOSE_DEVICE_REVOKED = 4001
WS_CLOSE_MEMBERSHIP_REVOKED = 4002

# Payloads above this size are rejected. Application messages are small;
# handshake messages grow ~335 B per member (measured: 1000-member group
# creation -> commit 286 KB, welcome 335 KB), so commits/welcomes get a
# larger cap sized for ~3000 devices.
MAX_PAYLOAD_BYTES = 256 * 1024
MAX_HANDSHAKE_BYTES = 1024 * 1024
MAX_WELCOME_RECIPIENTS = 5000
HANDSHAKE_KINDS = frozenset({"commit", "welcome"})


def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64decode(data: str) -> bytes:
    try:
        return base64.b64decode(data, validate=True)
    except Exception:
        raise ValidationError({"mls_payload": "invalid base64."})


def payload_is_mls_binary(payload: bytes) -> bool:
    """Pragmatic binary check for MLS wire payloads.

    Accept when the bytes either fail UTF-8 decoding or begin with a known
    MLS wire framing byte. A payload that decodes as UTF-8 text (e.g. a JSON
    document) is rejected — MLS payloads are binary wire format, never text.
    """
    if not payload:
        return False
    if payload[0] in MLS_WIRE_BYTES:
        return True
    try:
        payload.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


# --- membership ------------------------------------------------------------

def get_active_membership(conversation_id, user):
    return ConversationMember.objects.filter(
        conversation_id=conversation_id, user=user, removed_at__isnull=True
    ).first()


def require_active_member(conversation, user, request=None) -> ConversationMember:
    """Object-permission gate: active membership or 403 (SEC-01/02 style).

    Denials are recorded by the DRF exception hook (apps.audit.drf)."""
    membership = get_active_membership(conversation.id, user)
    if membership is None:
        raise PermissionDenied("You are not an active member of this conversation.")
    return membership


def require_admin(membership, conversation, request=None) -> None:
    if membership.member_role != "admin":
        raise PermissionDenied("Conversation admin role required.")


# --- conversation creation ---------------------------------------------------

@dataclass
class ConversationResult:
    conversation: Conversation
    created: bool


def create_conversation(
    *, requester, type: str, member_user_ids: list, title_enc: bytes | None, mls_group_id: bytes
) -> ConversationResult:
    from apps.accounts.models import User

    if type not in ("dm", "group"):
        raise ValidationError({"type": "This slice supports dm and group only."})
    if not (16 <= len(mls_group_id) <= 32):
        raise ValidationError({"mls_group_id": "mls_group_id must be 16-32 bytes."})
    if type == "dm":
        # exactly one other member, no duplicates, requester not in list
        ids = [str(i) for i in member_user_ids]
        if len(ids) != 1 or len(set(ids)) != 1:
            raise ValidationError({"member_user_ids": "dm requires exactly one member."})
        if ids[0] == str(requester.id):
            raise ValidationError({"member_user_ids": "dm member must be another user."})
    else:
        ids = sorted({str(i) for i in member_user_ids})
        if not ids:
            raise ValidationError({"member_user_ids": "group requires at least one member."})
        if str(requester.id) in ids:
            raise ValidationError({"member_user_ids": "creator is a member by default."})
    users = list(User.objects.filter(id__in=ids, is_active=True))
    if len(users) != len(set(ids)):
        raise ValidationError({"member_user_ids": "Unknown or inactive user in member list."})

    if type == "dm":
        existing = _find_active_dm(requester, users[0])
        if existing is not None:
            return ConversationResult(conversation=existing, created=False)

    with transaction.atomic():
        conversation = Conversation.objects.create(
            type=type,
            title_enc=title_enc,
            mls_group_id=mls_group_id,
            created_by=requester,
        )
        ConversationMember.objects.create(
            conversation=conversation, user=requester, member_role="admin", added_by=requester
        )
        for user in users:
            ConversationMember.objects.create(
                conversation=conversation, user=user, member_role="member", added_by=requester
            )
    log(
        actor=requester,
        action="conversation_created",
        target_type="conversation",
        target_id=conversation.id,
        metadata={"type": type, "member_count": len(users) + 1},
    )
    return ConversationResult(conversation=conversation, created=True)


def _find_active_dm(user_a, user_b):
    """The unique active dm between two users, if any."""
    candidates = (
        Conversation.objects.filter(type="dm", members__user=user_a, members__removed_at__isnull=True)
        .filter(members__user=user_b, members__removed_at__isnull=True)
        .distinct()
    )
    for conversation in candidates:
        if conversation.active_members().count() == 2:
            return conversation
    return None


# --- membership management ----------------------------------------------------

def add_members(*, conversation, actor_membership, user_ids) -> list:
    from apps.accounts.models import User

    require_admin(actor_membership, conversation)
    if conversation.type == "dm":
        raise PermissionDenied("dm conversations cannot have members added.")
    _forbid_correspondence_membership_change(conversation)
    users = list(User.objects.filter(id__in=user_ids, is_active=True))
    existing = {
        str(m.user_id)
        for m in ConversationMember.objects.filter(
            conversation=conversation, user__in=users, removed_at__isnull=True
        )
    }
    added = []
    for user in users:
        if str(user.id) in existing:
            continue
        member, _ = ConversationMember.objects.get_or_create(
            conversation=conversation,
            user=user,
            defaults={"member_role": "member", "added_by": actor_membership.user},
        )
        if member.removed_at is not None:
            member.removed_at = None
            member.member_role = "member"
            member.added_by = actor_membership.user
            member.save(update_fields=["removed_at", "member_role", "added_by"])
        added.append(member)
        broadcast_member_added(conversation, str(user.id))
    if added:
        log(
            actor=actor_membership.user,
            action="conversation_members_added",
            target_type="conversation",
            target_id=conversation.id,
            metadata={"count": len(added)},
        )
    return added


def remove_members(*, conversation, actor_membership, user_ids) -> list:
    require_admin(actor_membership, conversation)
    if conversation.type == "dm":
        raise PermissionDenied("dm conversations cannot have members removed.")
    _forbid_correspondence_membership_change(conversation)
    members = list(
        ConversationMember.objects.filter(
            conversation=conversation, user__id__in=user_ids, removed_at__isnull=True
        ).select_related("user")
    )
    now = timezone.now()
    for member in members:
        member.removed_at = now
        member.save(update_fields=["removed_at"])
        broadcast_member_removed(conversation, str(member.user_id))
    if members:
        log(
            actor=actor_membership.user,
            action="conversation_members_removed",
            target_type="conversation",
            target_id=conversation.id,
            metadata={"count": len(members)},
        )
    return members


# Threads whose content and audience are owned by another app's flow
# (correspondence send / announcement publish), never by the chat API.
CONTENT_GATED_TYPES = frozenset({"correspondence", "announcement"})


def _forbid_correspondence_membership_change(conversation) -> None:
    """A correspondence/announcement audience is fixed when it is prepared;
    widening it goes through an explicit new thread, never a silent add."""
    if conversation.type in CONTENT_GATED_TYPES:
        raise PermissionDenied(
            "Correspondence thread membership is fixed; use forwarding instead."
        )


# --- message storage ----------------------------------------------------------

@dataclass
class StoreResult:
    message: Message
    created: bool
    events: list = field(default_factory=list)


class EpochConflict(APIException):
    """409 — the client's epoch is stale (or jumping ahead) for this conversation."""

    status_code = HTTP_409_CONFLICT
    default_detail = "epoch_conflict"
    default_code = "epoch_conflict"

    def __init__(self, current_epoch: int):
        # Bypass APIException.__init__: its detail normalization stringifies
        # ints (ErrorDetail is a str subclass) and the contract requires a
        # numeric current_epoch in the JSON body.
        self.detail = {"detail": "epoch_conflict", "current_epoch": current_epoch}


def _validate_sender_device(requester, sender_device_id, kind) -> TrustedDevice | None:
    if kind in KINDS_WITHOUT_SENDER and not sender_device_id:
        return None
    if not sender_device_id:
        raise ValidationError({"sender_device_id": "sender_device_id is required."})
    device = TrustedDevice.objects.filter(id=sender_device_id).select_related("user").first()
    if device is None or device.user_id != requester.id:
        raise PermissionDenied("sender_device is not owned by you.")
    if device.status != "active":
        raise PermissionDenied("sender_device is not active.")
    return device


def store_message(
    *,
    conversation,
    requester,
    membership,
    kind: str,
    mls_payload: bytes,
    client_msg_id,
    epoch: int,
    sender_device_id=None,
    recipient_device_id=None,
    recipient_device_ids=None,
    reply_to_seq=None,
    membership_meta=None,
    via_correspondence: bool = False,
) -> StoreResult:
    if conversation.type in CONTENT_GATED_TYPES:
        # Content of an official correspondence/announcement enters only
        # through its own send/publish flow (reference number + immutability).
        if kind == "application" and not via_correspondence:
            raise PermissionDenied(
                "Thread content must be sent through its correspondence/announcement flow."
            )
        if membership_meta and (
            membership_meta.get("removed_user_ids")
            or _adds_non_members(conversation, membership_meta.get("added_user_ids") or [])
        ):
            raise PermissionDenied(
                "Correspondence thread membership is fixed; use forwarding instead."
            )
    limit = MAX_HANDSHAKE_BYTES if kind in HANDSHAKE_KINDS else MAX_PAYLOAD_BYTES
    if len(mls_payload) > limit:
        raise ValidationError({"mls_payload": "payload too large."})
    if not payload_is_mls_binary(mls_payload):
        raise ValidationError(
            {"mls_payload": "payload must be binary MLS wire data, not text."}
        )
    if reply_to_seq is not None and not Message.objects.filter(
        conversation=conversation, seq=reply_to_seq
    ).exists():
        raise ValidationError({"reply_to_seq": "reply target does not exist in this conversation."})

    sender_device = _validate_sender_device(requester, sender_device_id, kind)

    reply_to = None
    if reply_to_seq is not None:
        reply_to = Message.objects.get(conversation=conversation, seq=reply_to_seq)

    recipient_device = None
    recipient_devices: list[TrustedDevice] = []
    if kind == "welcome":
        recipient_devices = _welcome_recipients(conversation, recipient_device_id, recipient_device_ids)
        if len(recipient_devices) == 1:
            recipient_device = recipient_devices[0]
        if epoch != conversation.current_epoch:
            raise EpochConflict(conversation.current_epoch)
    elif kind == "commit":
        if epoch != conversation.current_epoch + 1:
            raise EpochConflict(conversation.current_epoch)
        meta_present = bool(
            membership_meta
            and (membership_meta.get("added_user_ids") or membership_meta.get("removed_user_ids"))
        )
        if meta_present and membership.member_role != "admin":
            raise PermissionDenied("Only admins may commit membership changes.")
    else:  # application | proposal
        if not (1 <= epoch <= conversation.current_epoch):
            raise EpochConflict(conversation.current_epoch)

    events: list = []

    with transaction.atomic():
        locked = Conversation.objects.select_for_update().get(pk=conversation.pk)
        if kind == "commit" and epoch != locked.current_epoch + 1:
            raise EpochConflict(locked.current_epoch)
        if kind != "commit" and kind != "welcome":
            if not (1 <= epoch <= locked.current_epoch):
                raise EpochConflict(locked.current_epoch)
        if kind == "welcome" and epoch != locked.current_epoch:
            raise EpochConflict(locked.current_epoch)

        last_seq = (
            Message.objects.filter(conversation=locked).order_by("-seq").values_list("seq", flat=True).first()
            or 0
        )
        message = Message(
            conversation=locked,
            sender=None if kind in KINDS_WITHOUT_SENDER else requester,
            sender_device=sender_device,
            seq=last_seq + 1,
            epoch=epoch,
            kind=kind,
            mls_payload=mls_payload,
            recipient_device=recipient_device,
            reply_to=reply_to,
            client_msg_id=client_msg_id,
        )
        try:
            with transaction.atomic(savepoint=True):
                message.save(force_insert=True)
                WelcomeRecipient.objects.bulk_create(
                    [WelcomeRecipient(message=message, device=d) for d in recipient_devices]
                )
        except IntegrityError:
            existing = Message.objects.get(conversation=locked, client_msg_id=client_msg_id)
            return StoreResult(message=existing, created=False, events=events)

        if kind == "commit":
            added_ids: list[str] = []
            removed_ids: list[str] = []
            if membership_meta:
                added_ids = _apply_membership_meta(locked, membership, membership_meta)
                removed_ids = [str(u) for u in membership_meta.get("removed_user_ids", [])]
            member_count = locked.active_members().count()
            GroupCryptoEpoch.objects.create(
                conversation=locked,
                epoch=epoch,
                committed_by_device=sender_device,
                member_count=member_count,
            )
            locked.current_epoch = epoch
            locked.save(update_fields=["current_epoch"])
            if added_ids:
                events.append(_member_event("member_added", locked, added_ids))
            if removed_ids:
                events.append(_member_event("member_removed", locked, removed_ids))

    event = _message_event(message, recipient_device)
    ordered = [event, *events]
    for user_id in dict.fromkeys(str(d.user_id) for d in recipient_devices):
        ordered.append({**event, "_group": f"user.{user_id}"})
    _broadcast_events(ordered)

    log(
        actor=requester,
        action="chat_message_posted",
        target_type="conversation",
        target_id=conversation.id,
        metadata={"seq": message.seq, "kind": kind, "epoch": epoch},
    )
    return StoreResult(message=message, created=True, events=ordered)


def _welcome_recipients(conversation, single_id, many_ids) -> list[TrustedDevice]:
    ids = [str(i) for i in (many_ids or [])] or ([str(single_id)] if single_id else [])
    if not ids:
        raise ValidationError({"recipient_device_id": "required for welcome messages."})
    if len(ids) > MAX_WELCOME_RECIPIENTS or len(ids) != len(set(ids)):
        raise ValidationError({"recipient_device_ids": "invalid recipient device list."})
    devices = list(TrustedDevice.objects.filter(id__in=ids).select_related("user"))
    members = {
        str(u)
        for u in ConversationMember.objects.filter(
            conversation=conversation, removed_at__isnull=True
        ).values_list("user_id", flat=True)
    }
    if len(devices) != len(ids) or any(str(d.user_id) not in members for d in devices):
        raise ValidationError(
            {"recipient_device_id": "recipient device must belong to a current member."}
        )
    return devices


def user_may_see_message(message: Message, user) -> bool:
    """Welcome payloads are device-addressed: only their recipients owners may
    fetch them over the API (server-side half of SEC-07)."""
    if message.kind != "welcome":
        return True
    if message.recipient_device is not None and message.recipient_device.user_id == user.id:
        return True
    return any(r.device.user_id == user.id for r in message.welcome_recipients.all())


def _adds_non_members(conversation, user_ids) -> bool:
    wanted = {str(u) for u in user_ids}
    if not wanted:
        return False
    current = {
        str(u)
        for u in ConversationMember.objects.filter(
            conversation=conversation, removed_at__isnull=True
        ).values_list("user_id", flat=True)
    }
    return not wanted <= current


def _apply_membership_meta(conversation, actor_membership, meta) -> list[str]:
    """Apply membership metadata carried by a commit (admins only).

    NOTE: the cryptography is the clients' job — this only updates the
    server's ACL bookkeeping so removed members lose API access immediately
    even if clients never rotate the epoch.
    """
    from apps.accounts.models import User

    added_ids: list[str] = []
    for uid in meta.get("added_user_ids", []):
        user = User.objects.filter(id=uid).first()
        if user is None:
            continue
        member, created = ConversationMember.objects.get_or_create(
            conversation=conversation,
            user=user,
            defaults={"member_role": "member", "added_by": actor_membership.user},
        )
        if member.removed_at is not None:
            member.removed_at = None
            member.member_role = "member"
            member.save(update_fields=["removed_at", "member_role"])
        added_ids.append(str(user.id))
    now = timezone.now()
    for uid in meta.get("removed_user_ids", []):
        ConversationMember.objects.filter(
            conversation=conversation, user__id=uid, removed_at__isnull=True
        ).update(removed_at=now)
    return added_ids


# --- channel layer broadcasts ---------------------------------------------------

def _message_event(message: Message, recipient_device) -> dict:
    return {
        "type": "chat.event",
        "event": "message",
        "conversation_id": str(message.conversation_id),
        "seq": message.seq,
        "kind": message.kind,
        "sender_user_id": str(message.sender_id) if message.sender_id else None,
        "sender_device_id": str(message.sender_device_id) if message.sender_device_id else None,
        "epoch": message.epoch,
        "mls_payload": b64encode(message.mls_payload),
        "reply_to_seq": message.reply_to.seq if message.reply_to_id else None,
        "client_msg_id": str(message.client_msg_id),
        "created_at": message.created_at.isoformat(),
        "recipient_user_id": str(recipient_device.user_id) if recipient_device else None,
    }


def _member_event(event: str, conversation: Conversation, user_ids: list[str]) -> dict:
    return {
        "type": "chat.event",
        "event": event,
        "conversation_id": str(conversation.id),
        "user_ids": user_ids,
    }


def _broadcast_events(events: list[dict]) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    for event in events:
        group = event.pop("_group", None)
        if group is None:
            group = f"conv.{event['conversation_id']}"
        async_to_sync(channel_layer.group_send)(group, event)


def broadcast_member_added(conversation: Conversation, user_id: str) -> None:
    _broadcast_events([_member_event("member_added", conversation, [user_id])])


def broadcast_member_removed(conversation: Conversation, user_id: str) -> None:
    _broadcast_events([_member_event("member_removed", conversation, [user_id])])


# --- WS tickets -----------------------------------------------------------------

def issue_ws_ticket(user, conversation) -> str:
    """Mint a one-time, 30-second WS ticket (signed JWT + cached jti)."""
    return issue_scoped_ws_ticket(user, str(conversation.id))


def issue_scoped_ws_ticket(user, scope: str) -> str:
    """Same ticket, bound to an arbitrary scope (a conversation id, or a
    user-level stream such as "notifications")."""
    jti = secrets.token_hex(16)
    now = timezone.now()
    payload = {
        "sub": str(user.id),
        "cid": scope,
        "jti": jti,
        "typ": "ws_ticket",
        "iat": now,
        "exp": now + timedelta(seconds=WS_TICKET_TTL_SECONDS),
    }
    token = jwt.encode(
        payload, settings.AUTH_JWT_SECRET, algorithm=settings.AUTH_JWT_ALGORITHM
    )
    cache.set(f"{WS_TICKET_CACHE_PREFIX}{jti}", 1, timeout=WS_TICKET_TTL_SECONDS)
    return token


def consume_ws_ticket(token: str, conversation_id: str):
    """Validate a ticket; consume its jti (single use). Returns user id or None."""
    try:
        payload = jwt.decode(
            token, settings.AUTH_JWT_SECRET, algorithms=[settings.AUTH_JWT_ALGORITHM]
        )
    except jwt.PyJWTError:
        return None
    if payload.get("typ") != "ws_ticket" or payload.get("cid") != str(conversation_id):
        return None
    jti = payload.get("jti", "")
    key = f"{WS_TICKET_CACHE_PREFIX}{jti}"
    if not cache.get(key):
        return None
    cache.delete(key)  # one-time use
    return payload["sub"]
