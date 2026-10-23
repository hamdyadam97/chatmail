"""URL routes for /api/v1/notifications/."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.NotificationListView.as_view(), name="notification-list"),
    path("unread-count/", views.UnreadCountView.as_view(), name="notification-unread-count"),
    path("read-all/", views.MarkAllReadView.as_view(), name="notification-read-all"),
    path("preferences/", views.PreferencesView.as_view(), name="notification-preferences"),
    path("ws-ticket/", views.WsTicketView.as_view(), name="notification-ws-ticket"),
    path("push/public-key/", views.PushPublicKeyView.as_view(), name="push-public-key"),
    path("push/subscribe/", views.PushSubscribeView.as_view(), name="push-subscribe"),
    path("push/unsubscribe/", views.PushUnsubscribeView.as_view(), name="push-unsubscribe"),
    path("push/test/", views.PushTestView.as_view(), name="push-test"),
    path("<uuid:notification_id>/read/", views.MarkReadView.as_view(), name="notification-read"),
]
