"""ASGI config: HTTP through Django, WebSockets through the messaging and
notifications routers.

WS auth uses one-time ?ticket= JWTs validated by each consumer itself, so no
session/auth middleware stack is needed on the websocket path.
"""
import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.dev")

django_asgi_app = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402

from apps.messaging.routing import websocket_urlpatterns as chat_ws  # noqa: E402
from apps.notifications.routing import websocket_urlpatterns as notify_ws  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": URLRouter(chat_ws + notify_ws),
    }
)
