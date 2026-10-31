"""Chat API views under /api/v1/conversations/ (JWT-authenticated).

Every endpoint gates active membership first; content is sealed at rest and
opened only in responses to members (see apps.messaging.services).
"""
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from ..models import Conversation, Message
from ..services import (
    add_members,
    create_conversation,
    get_active_membership,
    issue_ws_ticket,
    remove_members,
    require_active_member,
    chat_content,
    store_message,
)
from .serializers import (
    CreateConversationSerializer,
    MemberIdsSerializer,
    PostMessageSerializer,
    ReadSerializer,
    conversation_to_dict,
    message_to_dict,
)

MAX_MESSAGE_PAGE = 200
DEFAULT_MESSAGE_PAGE = 100


class ConversationListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        memberships = (
            request.user.conversation_memberships.filter(removed_at__isnull=True)
            .exclude(conversation__type__in=["correspondence", "announcement"])
            .select_related("conversation")
            .order_by("conversation__created_at")
        )
        data = [
            conversation_to_dict(m.conversation, m) for m in memberships
        ]
        return Response(data)

    def post(self, request):
        serializer = CreateConversationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        result = create_conversation(
            requester=request.user,
            type=serializer.validated_data["type"],
            member_user_ids=serializer.validated_data["member_user_ids"],
            title=serializer.validated_data["title"],
        )
        membership = get_active_membership(result.conversation.id, request.user)
        code = status.HTTP_201_CREATED if result.created else status.HTTP_200_OK
        return Response(
            conversation_to_dict(result.conversation, membership),
            status=code,
        )


class _ConversationMixin:
    permission_classes = [IsAuthenticated]

    def _conversation(self, conversation_id) -> Conversation:
        return Conversation.objects.get(id=conversation_id)


class MessageListCreateView(_ConversationMixin, APIView):
    def get(self, request, conversation_id):
        conversation = self._conversation(conversation_id)
        require_active_member(conversation, request.user)

        after_seq = request.query_params.get("after_seq")
        limit = request.query_params.get("limit")
        try:
            after_seq = int(after_seq) if after_seq is not None else None
        except ValueError:
            after_seq = None
        try:
            limit = min(int(limit), MAX_MESSAGE_PAGE) if limit else DEFAULT_MESSAGE_PAGE
        except ValueError:
            limit = DEFAULT_MESSAGE_PAGE

        qs = Message.objects.filter(conversation=conversation)
        if after_seq is not None:
            qs = qs.filter(seq__gt=after_seq)
        before_seq = request.query_params.get("before_seq")
        if before_seq and before_seq.isdigit():
            qs = qs.filter(seq__lt=int(before_seq))
        if request.query_params.get("latest") == "1" or before_seq:
            # The newest page (chat opens at the bottom, older pages load
            # upwards), returned oldest-first.
            messages = list(qs.select_related("reply_to").order_by("-seq")[:limit])[::-1]
        else:
            messages = list(qs.select_related("reply_to").order_by("seq")[:limit])
        return Response({"messages": [message_to_dict(m) for m in messages]})

    def post(self, request, conversation_id):
        conversation = self._conversation(conversation_id)
        require_active_member(conversation, request.user)
        serializer = PostMessageSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        result = store_message(
            conversation=conversation,
            requester=request.user,
            content=chat_content(data["text"]),
            client_msg_id=data["client_msg_id"],
            reply_to_seq=data.get("reply_to_seq"),
        )
        code = status.HTTP_201_CREATED if result.created else status.HTTP_200_OK
        return Response(message_to_dict(result.message), status=code)


class ConversationMembersView(_ConversationMixin, APIView):
    """Admin-only membership add. dm → 403."""

    def post(self, request, conversation_id):
        conversation = self._conversation(conversation_id)
        membership = require_active_member(conversation, request.user)
        serializer = MemberIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        added = add_members(
            conversation=conversation,
            actor_membership=membership,
            user_ids=serializer.validated_data["user_ids"],
        )
        return Response(
            {"added": [str(m.user_id) for m in added]}, status=status.HTTP_201_CREATED
        )


class ConversationMembersRemoveView(_ConversationMixin, APIView):
    """Admin-only removal: the member loses API and WS access at once. dm → 403."""

    def post(self, request, conversation_id):
        conversation = self._conversation(conversation_id)
        membership = require_active_member(conversation, request.user)
        serializer = MemberIdsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        removed = remove_members(
            conversation=conversation,
            actor_membership=membership,
            user_ids=serializer.validated_data["user_ids"],
        )
        return Response({"removed": [str(m.user_id) for m in removed]})


class WsTicketView(_ConversationMixin, APIView):
    """Mint a one-time, 30-second WebSocket ticket."""

    def get(self, request, conversation_id):
        conversation = self._conversation(conversation_id)
        require_active_member(conversation, request.user)
        return Response({"ticket": issue_ws_ticket(request.user, conversation)})


class ReadMarkView(_ConversationMixin, APIView):
    """POST {seq}: my read position (never moves backwards)."""

    def post(self, request, conversation_id):
        conversation = self._conversation(conversation_id)
        membership = require_active_member(conversation, request.user)
        serializer = ReadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        seq = serializer.validated_data["seq"]
        if seq > membership.last_read_seq:
            membership.last_read_seq = seq
            membership.save(update_fields=["last_read_seq"])
        return Response({"last_read_seq": membership.last_read_seq})
