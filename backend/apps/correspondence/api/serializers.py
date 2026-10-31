"""Correspondence API shapes.

Content (subject, body, attachment names) is opened from its sealed blob only
in responses to participants — every view gates with services.get_readable
(or a sender check) before anything here runs.
"""
from rest_framework import serializers

from ..models import Correspondence
from ..services import correspondence_content, file_meta

PREVIEW_CHARS = 160


def _user_ref(user) -> dict:
    return {"id": str(user.id), "full_name": user.full_name, "username": user.username}


def participant_to_dict(p) -> dict:
    return {
        "user": _user_ref(p.user),
        "kind": p.kind,
        "added_via": p.added_via,
        "read_at": p.read_at.isoformat() if p.read_at else None,
    }


def correspondence_summary(c: Correspondence, my_row, participants, content: dict | None = None) -> dict:
    content = content if content is not None else correspondence_content(c) or {}
    body = " ".join((content.get("body") or "").split())
    return {
        "id": str(c.id),
        "reference_number": c.reference_number,
        "sender": _user_ref(c.sender),
        "subject": content.get("subject", ""),
        "preview": body[:PREVIEW_CHARS],
        "has_attachments": bool(content.get("attachments")),
        "priority": c.priority,
        "classification": c.classification,
        "status": c.status,
        "due_date": c.due_date.isoformat() if c.due_date else None,
        "created_at": c.created_at.isoformat(),
        "sent_at": c.sent_at.isoformat() if c.sent_at else None,
        "thread_id": str(c.thread_id),
        "thread_root_id": str(c.thread_root_id) if c.thread_root_id else None,
        "reply_to_id": str(c.reply_to_id) if c.reply_to_id else None,
        "is_forward": hasattr(c, "forwarded_from"),
        "my_kind": my_row.kind if my_row else None,
        "read_at": my_row.read_at.isoformat() if my_row and my_row.read_at else None,
        "archived": bool(my_row and my_row.archived_at),
        "is_important": bool(my_row and my_row.is_important),
        "participants": [participant_to_dict(p) for p in participants if p.kind != "from"],
    }


def content_to_dict(content: dict | None, files: dict) -> dict | None:
    """{subject, body, attachments: [{id, name, mime, size}], forwarded}."""
    if content is None:
        return None
    return {
        "subject": content.get("subject", ""),
        "body": content.get("body", ""),
        "attachments": [files[i] for i in content.get("attachments", []) if i in files],
        "forwarded": content.get("forwarded"),
    }


def correspondence_detail(c: Correspondence, my_row, participants, files: dict, thread_items) -> dict:
    content = correspondence_content(c)
    data = correspondence_summary(c, my_row, participants, content or {})
    data["content"] = content_to_dict(content, files)
    forwarding = getattr(c, "forwarded_from", None)
    data["forwarded_from_reference"] = forwarding.source.reference_number if forwarding else None
    data["thread_items"] = thread_items
    return data


def event_to_dict(e) -> dict:
    return {
        "event_type": e.event_type,
        "actor": _user_ref(e.actor) if e.actor_id else None,
        "metadata": e.metadata,
        "created_at": e.created_at.isoformat(),
    }


def files_by_id(stored_files) -> dict:
    return {str(f.id): file_meta(f) for f in stored_files}


class _ContentFields(serializers.Serializer):
    subject = serializers.CharField(max_length=500, required=False, allow_blank=True, default="")
    body = serializers.CharField(max_length=100_000, required=False, allow_blank=True, default="",
                                 trim_whitespace=False)
    attachment_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)


class ComposeSerializer(_ContentFields):
    to_user_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    cc_user_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    bcc_user_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    priority = serializers.ChoiceField(choices=[c for c, _ in Correspondence.PRIORITIES], default="normal")
    classification = serializers.ChoiceField(
        choices=[c for c, _ in Correspondence.CLASSIFICATIONS], default="normal"
    )
    due_date = serializers.DateField(required=False, allow_null=True, default=None)
    sender_membership_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    client_ref = serializers.UUIDField()
    # true = send now; false = save as a draft.
    send = serializers.BooleanField(default=True)


class DraftUpdateSerializer(_ContentFields):
    to_user_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    cc_user_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    priority = serializers.ChoiceField(choices=[c for c, _ in Correspondence.PRIORITIES], default="normal")
    classification = serializers.ChoiceField(
        choices=[c for c, _ in Correspondence.CLASSIFICATIONS], default="normal"
    )
    due_date = serializers.DateField(required=False, allow_null=True, default=None)


class ReplySerializer(_ContentFields):
    priority = serializers.ChoiceField(choices=[c for c, _ in Correspondence.PRIORITIES], default="normal")
    due_date = serializers.DateField(required=False, allow_null=True, default=None)
    sender_membership_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    client_ref = serializers.UUIDField()


class FlagsSerializer(serializers.Serializer):
    archived = serializers.BooleanField(required=False, allow_null=True, default=None)
    important = serializers.BooleanField(required=False, allow_null=True, default=None)
