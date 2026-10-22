"""WebSocket routing for user-level notification streams."""
from django.urls import path

from .consumers import CorrespondenceStreamConsumer, NotificationsConsumer

websocket_urlpatterns = [
    path("ws/notifications/", NotificationsConsumer.as_asgi()),
    path("ws/correspondences/", CorrespondenceStreamConsumer.as_asgi()),
]
