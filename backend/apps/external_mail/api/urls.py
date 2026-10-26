"""URL routes for /api/v1/external-mail/."""
from django.urls import path

from . import views

urlpatterns = [
    path("me/", views.MeView.as_view(), name="external-mail-me"),
    path("messages/", views.MessageListView.as_view(), name="external-mail-messages"),
    path("messages/<uuid:message_id>/", views.MessageDetailView.as_view(), name="external-mail-message"),
    path("messages/<uuid:message_id>/read/", views.MessageReadView.as_view(), name="external-mail-read"),
    path("send/", views.SendView.as_view(), name="external-mail-send"),
    path("mailboxes/<uuid:user_id>/", views.MailboxAdminView.as_view(), name="external-mailbox"),
]
