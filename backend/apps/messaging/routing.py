"""WebSocket routing for the messaging app."""
from django.urls import path

from .consumers import ChatConsumer

websocket_urlpatterns = [
    path("ws/conversations/<uuid:conversation_id>/", ChatConsumer.as_asgi()),
]
