"""Chat WebSocket consumer — ticket-authenticated, forward-only.

The server is a dumb pipe (docs/phase1/02-protocol-comparison.md §2.4):
incoming client frames are ignored in this slice except ping/pong; all
server→client traffic is forwarded channel-layer events (chat.event frames,
membership revocation, device revocation).

Auth: one-time ?ticket= JWT (see services.issue_ws_ticket), validated and
consumed on connect, plus an active membership check. Reconnect handling is
the client's job — it mints a fresh ticket per connection.
"""
from urllib.parse import parse_qs

from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from apps.accounts.models import User

from .services import (
    WS_CLOSE_DEVICE_REVOKED,
    WS_CLOSE_MEMBERSHIP_REVOKED,
    consume_ws_ticket,
    get_active_membership,
)


class ChatConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        conversation_id = self.scope["url_route"]["kwargs"]["conversation_id"]
        params = parse_qs(self.scope["query_string"].decode())
        ticket = (params.get("ticket") or [""])[0]
        user_id = consume_ws_ticket(ticket, conversation_id) if ticket else None
        if user_id is None:
            await self.close(code=4401)
            return
        membership = await self._membership(conversation_id, user_id)
        if membership is None:
            await self.close(code=4403)
            return
        self.conversation_id = str(conversation_id)
        self.user_id = user_id
        self.conv_group = f"conv.{conversation_id}"
        self.user_group = f"user.{user_id}"
        await self.channel_layer.group_add(self.conv_group, self.channel_name)
        await self.channel_layer.group_add(self.user_group, self.channel_name)
        await self.accept()

    @staticmethod
    async def _membership(conversation_id, user_id):
        user = await sync_to_async(User.objects.get)(id=user_id)
        return await sync_to_async(get_active_membership)(conversation_id, user)

    async def disconnect(self, code):
        for group in (getattr(self, "conv_group", None), getattr(self, "user_group", None)):
            if group:
                await self.channel_layer.group_discard(group, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if content.get("type") == "ping":
            await self.send_json({"type": "pong"})

    # --- channel layer event handlers ---------------------------------------

    async def chat_event(self, event):
        """Forward a chat.event frame (message / member_added / member_removed)."""
        if event.get("event") == "member_removed" and self.user_id in event.get("user_ids", []):
            await self.send_json(event)
            await self.close(code=WS_CLOSE_MEMBERSHIP_REVOKED)
            return
        await self.send_json(event)

    async def device_revoked(self, event):
        """Server-side signal on user.{id}: this user's device was revoked."""
        await self.close(code=WS_CLOSE_DEVICE_REVOKED)
