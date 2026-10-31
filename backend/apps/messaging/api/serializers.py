"""Serializers for the messaging API.

Message content is opened from its sealed blob for active members only
(the views gate membership before anything here runs).
"""
from rest_framework import serializers

from ..models import Conversation, Message
from ..services import conversation_title, message_content, message_payload


def conversation_to_dict(conversation: Conversation, membership) -> dict:
    return {
        "id": str(conversation.id),
        "type": conversation.type,
        "title": conversation_title(conversation) or conversation.title_plain,
        "created_at": conversation.created_at.isoformat(),
        "joined_at": membership.joined_at.isoformat(),
        "member_count": conversation.active_members().count(),
        "my_role": membership.member_role,
        "last_read_seq": membership.last_read_seq,
        # Names of current members (directory data) — titles a DM by the
        # other person and labels message senders.
        "members": [
            {"id": str(m.user_id), "full_name": m.user.full_name, "username": m.user.username}
            for m in conversation.active_members().select_related("user").order_by("joined_at")
        ],
    }


def message_to_dict(message: Message) -> dict:
    return message_payload(message, message_content(message))


class CreateConversationSerializer(serializers.Serializer):
    type = serializers.ChoiceField(choices=["dm", "group"])
    member_user_ids = serializers.ListField(child=serializers.UUIDField(), allow_empty=False)
    title = serializers.CharField(required=False, allow_blank=True, default="", max_length=200)


class PostMessageSerializer(serializers.Serializer):
    text = serializers.CharField(max_length=20_000, trim_whitespace=False)
    client_msg_id = serializers.UUIDField()
    reply_to_seq = serializers.IntegerField(required=False)


class MemberIdsSerializer(serializers.Serializer):
    user_ids = serializers.ListField(child=serializers.UUIDField(), allow_empty=False)


class ReadSerializer(serializers.Serializer):
    seq = serializers.IntegerField(min_value=0)
