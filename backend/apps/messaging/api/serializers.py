"""Serializers for the messaging API — output shapes only.

All serialized message fields are metadata or base64 ciphertext; the server
never sees plaintext (docs/phase1/02-protocol-comparison.md §2.4).
"""
from rest_framework import serializers

from ..models import Conversation, Message
from ..services import b64encode


def conversation_to_dict(conversation: Conversation, membership) -> dict:
    title_enc = b64encode(bytes(conversation.title_enc)) if conversation.title_enc else None
    return {
        "id": str(conversation.id),
        "type": conversation.type,
        "title_enc": title_enc,
        "title_plain": conversation.title_plain,
        "mls_group_id": b64encode(bytes(conversation.mls_group_id)),
        "current_epoch": conversation.current_epoch,
        "created_at": conversation.created_at.isoformat(),
        "joined_at": membership.joined_at.isoformat(),
        "member_count": conversation.active_members().count(),
        "my_role": membership.member_role,
    }


def message_to_dict(message: Message) -> dict:
    return {
        "seq": message.seq,
        "kind": message.kind,
        "sender_user_id": str(message.sender_id) if message.sender_id else None,
        "sender_device_id": str(message.sender_device_id) if message.sender_device_id else None,
        "epoch": message.epoch,
        "mls_payload": b64encode(bytes(message.mls_payload)),
        "reply_to_seq": message.reply_to.seq if message.reply_to_id else None,
        "created_at": message.created_at.isoformat(),
        "client_msg_id": str(message.client_msg_id),
    }


class CreateConversationSerializer(serializers.Serializer):
    type = serializers.ChoiceField(choices=["dm", "group"])
    member_user_ids = serializers.ListField(
        child=serializers.UUIDField(), allow_empty=False
    )
    title_enc = serializers.CharField(required=False, allow_blank=False)
    mls_group_id = serializers.CharField()  # base64, 16-32 bytes decoded

    def validate(self, attrs):
        from ..services import b64decode

        raw = b64decode(attrs["mls_group_id"])
        if not (16 <= len(raw) <= 32):
            raise serializers.ValidationError(
                {"mls_group_id": "mls_group_id must be 16-32 bytes when decoded."}
            )
        attrs["mls_group_id_raw"] = raw
        if "title_enc" in attrs:
            attrs["title_enc_raw"] = b64decode(attrs["title_enc"])
        return attrs


class PostMessageSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=["application", "commit", "welcome", "proposal"])
    mls_payload = serializers.CharField()  # base64 binary
    client_msg_id = serializers.UUIDField()
    epoch = serializers.IntegerField()
    sender_device_id = serializers.UUIDField(required=False)
    recipient_device_id = serializers.UUIDField(required=False)
    # One welcome for many devices (stored once; see models.WelcomeRecipient).
    recipient_device_ids = serializers.ListField(
        child=serializers.UUIDField(), required=False, allow_empty=False, max_length=5000
    )
    reply_to_seq = serializers.IntegerField(required=False)
    membership = serializers.DictField(required=False)

    def validate(self, attrs):
        from ..services import b64decode

        attrs["mls_payload_raw"] = b64decode(attrs["mls_payload"])
        return attrs


class MemberIdsSerializer(serializers.Serializer):
    user_ids = serializers.ListField(child=serializers.UUIDField(), allow_empty=False)
