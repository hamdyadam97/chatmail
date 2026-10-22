"""User-level notification stream: /ws/notifications/ and /ws/correspondences/.

Auth: one-time ?ticket= JWT scoped to "notifications" (same mechanism as the
chat stream). The server only ever pushes generic notification dicts — ids,
kinds and fixed titles — never content (SEC-11). /ws/correspondences/ is the
same stream filtered to correspondence kinds.
"""
from urllib.parse import parse_qs

from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from apps.accounts.models import User
from apps.messaging.services import consume_ws_ticket

from .services import group_name

TICKET_SCOPE = "notifications"
CORRESPONDENCE_KINDS = frozenset(
    {"new_correspondence", "correspondence_reply", "correspondence_forward", "announcement", "announcement_reminder"}
)


class NotificationsConsumer(AsyncJsonWebsocketConsumer):
    kinds: frozenset | None = None  # None = every kind

    async def connect(self):
        params = parse_qs(self.scope["query_string"].decode())
        ticket = (params.get("ticket") or [""])[0]
        user_id = consume_ws_ticket(ticket, TICKET_SCOPE) if ticket else None
        if user_id is None or not await self._active(user_id):
            await self.close(code=4401)
            return
        self.group = group_name(user_id)
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

    @staticmethod
    async def _active(user_id) -> bool:
        return await sync_to_async(User.objects.filter(id=user_id, is_active=True).exists)()

    async def disconnect(self, code):
        if getattr(self, "group", None):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if content.get("type") == "ping":
            await self.send_json({"type": "pong"})

    async def notify_event(self, event):
        notification = event["notification"]
        if self.kinds is not None and notification["kind"] not in self.kinds:
            return
        await self.send_json({"type": "notification", "notification": notification})


class CorrespondenceStreamConsumer(NotificationsConsumer):
    kinds = CORRESPONDENCE_KINDS
