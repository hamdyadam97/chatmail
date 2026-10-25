"""Correspondence API shapes — metadata + base64 ciphertext only.

There is no field anywhere in this module that can carry a plaintext
subject/body: content arrives as one opaque MLS application message
(``mls_payload``) and is validated as binary by messaging.store_message.
"""
from rest_framework import serializers

from apps.messaging.services import b64decode, b64encode

from ..models import Correspondence


def _user_ref(user) -> dict:
    return {"id": str(user.id), "full_name": user.full_name, "username": user.username}


def participant_to_dict(p) -> dict:
    return {
        "user": _user_ref(p.user),
        "kind": p.kind,
        "added_via": p.added_via,
        "read_at": p.read_at.isoformat() if p.read_at else None,
    }


def correspondence_summary(c: Correspondence, my_row, participants) -> dict:
    return {
        "id": str(c.id),
        "reference_number": c.reference_number,
        "sender": _user_ref(c.sender),
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


def correspondence_detail(c: Correspondence, my_row, participants, attachments, thread_items) -> dict:
    data = correspondence_summary(c, my_row, participants)
    thread = c.thread
    data["thread"] = {
        "id": str(thread.id),
        "mls_group_id": b64encode(bytes(thread.mls_group_id)),
        "current_epoch": thread.current_epoch,
    }
    message = c.content_message
    data["content"] = (
        {
            "seq": message.seq,
            "epoch": message.epoch,
            "sender_device_id": str(message.sender_device_id) if message.sender_device_id else None,
            "client_msg_id": str(message.client_msg_id),
            "mls_payload": b64encode(bytes(message.mls_payload)),
        }
        if message is not None
        else None
    )
    data["attachments"] = [
        {
            "id": str(a.stored_file_id),
            "ciphertext_size": a.stored_file.ciphertext_size,
            "ciphertext_sha256": b64encode(bytes(a.stored_file.ciphertext_sha256)),
            "algorithm": a.algorithm,
        }
        for a in attachments
    ]
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


class _Base64Field(serializers.CharField):
    def __init__(self, **kwargs):
        kwargs.setdefault("max_length", 400_000)
        super().__init__(**kwargs)


class PrepareSerializer(serializers.Serializer):
    to_user_ids = serializers.ListField(child=serializers.UUIDField(), allow_empty=False)
    cc_user_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    bcc_user_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    priority = serializers.ChoiceField(choices=[c for c, _ in Correspondence.PRIORITIES], default="normal")
    classification = serializers.ChoiceField(
        choices=[c for c, _ in Correspondence.CLASSIFICATIONS], default="normal"
    )
    due_date = serializers.DateField(required=False, allow_null=True, default=None)
    sender_membership_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    mls_group_id = _Base64Field()
    client_ref = serializers.UUIDField()

    def validate(self, attrs):
        attrs["mls_group_id_raw"] = b64decode(attrs["mls_group_id"])
        return attrs


class ReplySerializer(serializers.Serializer):
    priority = serializers.ChoiceField(choices=[c for c, _ in Correspondence.PRIORITIES], default="normal")
    due_date = serializers.DateField(required=False, allow_null=True, default=None)
    sender_membership_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    client_ref = serializers.UUIDField()


class SendSerializer(serializers.Serializer):
    mls_payload = _Base64Field()
    client_msg_id = serializers.UUIDField()
    epoch = serializers.IntegerField(min_value=1)
    sender_device_id = serializers.UUIDField()
    attachment_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list)
    # Encrypted copy for the central archive (institutional_archive_eligible only).
    archive_copy = serializers.JSONField(required=False, allow_null=True, default=None)

    def validate(self, attrs):
        from apps.archive.services import parse_copy

        attrs["mls_payload_raw"] = b64decode(attrs["mls_payload"])
        attrs["archive_copy"] = parse_copy(attrs.get("archive_copy"))
        return attrs


class FlagsSerializer(serializers.Serializer):
    archived = serializers.BooleanField(required=False, allow_null=True, default=None)
    important = serializers.BooleanField(required=False, allow_null=True, default=None)
