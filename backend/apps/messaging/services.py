"""Chat services: conversations, membership and messages.

Content is sealed at rest with the server key (apps.vault — user decision
2026-10-31, Outlook-style). Read access is active membership only (the same
object-permission gate for every role, AGENTS rule 5). Audit metadata carries
identifiers/counters only — never content (SEC-10).
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
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps import vault
from apps.audit.services import log

from .models import Conversation, ConversationMember, Message

WS_TICKET_TTL_SECONDS = 30
WS_TICKET_CACHE_PREFIX = "ws-ticket:"

# Custom WS close codes (4000-4999 application range).
WS_CLOSE_MEMBERSHIP_REVOKED = 4002


def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64decode(data: str, field: str = "data") -> bytes:
    try:
        return base64.b64decode(data, validate=True)
    except Exception:
        raise ValidationError({field: "invalid base64."})


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


def create_conversation(*, requester, type: str, member_user_ids: list, title: str = "") -> ConversationResult:
    from apps.accounts.models import User

    if type not in ("dm", "group"):
        raise ValidationError({"type": "This slice supports dm and group only."})
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
        conversation = Conversation.objects.create(type=type, created_by=requester)
        if title.strip():
            conversation.title_enc = seal_title(conversation.id, title.strip()[:200])
            conversation.save(update_fields=["title_enc"])
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


def seal_title(conversation_id, title: str) -> bytes:
    return vault.seal(title.encode(), purpose="conversation-title", owner=conversation_id)


def conversation_title(conversation) -> str | None:
    if not conversation.title_enc:
        return None
    try:
        return vault.open_(conversation.title_enc, purpose="conversation-title", owner=conversation.id).decode()
    except vault.VaultError:
        return None


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

MAX_TEXT_CHARS = 20_000


@dataclass
class StoreResult:
    message: Message
    created: bool
    events: list = field(default_factory=list)


def seal_content(conversation_id, content: dict) -> bytes:
    return vault.seal_json(content, purpose="message", owner=conversation_id)


def message_content(message: Message) -> dict | None:
    """Opened content, or None when the blob does not open (moved/tampered)."""
    try:
        return vault.open_json(message.content_enc, purpose="message", owner=message.conversation_id)
    except vault.VaultError:
        return None


def chat_content(text: str) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValidationError({"text": "الرسالة فارغة."})
    if len(text) > MAX_TEXT_CHARS:
        raise ValidationError({"text": f"الحد الأقصى {MAX_TEXT_CHARS} حرف."})
    return {"text": text}


def store_message(
    *,
    conversation,
    requester,
    content: dict,
    client_msg_id,
    reply_to_seq=None,
    via_correspondence: bool = False,
) -> StoreResult:
    """Seal and append one message. Content of a correspondence/announcement
    thread enters only through its own send/publish flow."""
    if conversation.type in CONTENT_GATED_TYPES and not via_correspondence:
        raise PermissionDenied("Thread content must be sent through its correspondence/announcement flow.")
    reply_to = None
    if reply_to_seq is not None:
        reply_to = Message.objects.filter(conversation=conversation, seq=reply_to_seq).first()
        if reply_to is None:
            raise ValidationError({"reply_to_seq": "reply target does not exist in this conversation."})

    with transaction.atomic():
        locked = Conversation.objects.select_for_update().get(pk=conversation.pk)
        existing = Message.objects.filter(conversation=locked, client_msg_id=client_msg_id).first()
        if existing is not None:
            return StoreResult(message=existing, created=False)
        last_seq = (
            Message.objects.filter(conversation=locked).order_by("-seq").values_list("seq", flat=True).first()
            or 0
        )
        message = Message.objects.create(
            conversation=locked,
            sender=requester,
            seq=last_seq + 1,
            content_enc=seal_content(locked.id, content),
            reply_to=reply_to,
            client_msg_id=client_msg_id,
        )

    event = _message_event(message, content)
    _broadcast_events([dict(event)])
    if conversation.type in ("dm", "group"):
        _push_chat_message(conversation, requester)
    log(
        actor=requester,
        action="chat_message_posted",
        target_type="conversation",
        target_id=conversation.id,
        metadata={"seq": message.seq},
    )
    return StoreResult(message=message, created=True, events=[event])


def _push_chat_message(conversation, sender) -> None:
    """Web Push to the other members: sender's name only, never the text
    (SEC-11). One tag per chat, so a burst collapses into one notification."""
    from apps.notifications import push

    others = list(
        conversation.active_members().exclude(user=sender).values_list("user_id", flat=True)
    )
    name = sender.full_name or sender.username
    push.push_to_users(
        others,
        kind="new_message",
        title=f"رسالة من {name}" if conversation.type == "dm" else "رسالة جديدة في محادثة جماعية",
        body="" if conversation.type == "dm" else f"من {name}",
        url=f"/chat/{conversation.id}",
        tag=f"chat:{conversation.id}",
    )


# --- channel layer broadcasts ---------------------------------------------------

def message_payload(message: Message, content: dict | None) -> dict:
    return {
        "seq": message.seq,
        "sender_user_id": str(message.sender_id) if message.sender_id else None,
        "content": content,
        "reply_to_seq": message.reply_to.seq if message.reply_to_id else None,
        "client_msg_id": str(message.client_msg_id),
        "created_at": message.created_at.isoformat(),
    }


def _message_event(message: Message, content: dict) -> dict:
    return {
        "type": "chat.event",
        "event": "message",
        "conversation_id": str(message.conversation_id),
        **message_payload(message, content),
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
