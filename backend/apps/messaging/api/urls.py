"""URL routes for /api/v1/conversations/."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.ConversationListCreateView.as_view(), name="conversation-list"),
    path(
        "<uuid:conversation_id>/messages/",
        views.MessageListCreateView.as_view(),
        name="conversation-messages",
    ),
    path(
        "<uuid:conversation_id>/members/",
        views.ConversationMembersView.as_view(),
        name="conversation-members",
    ),
    path(
        "<uuid:conversation_id>/members/remove/",
        views.ConversationMembersRemoveView.as_view(),
        name="conversation-members-remove",
    ),
    path(
        "<uuid:conversation_id>/read/",
        views.ReadMarkView.as_view(),
        name="conversation-read",
    ),
    path(
        "<uuid:conversation_id>/ws-ticket/",
        views.WsTicketView.as_view(),
        name="conversation-ws-ticket",
    ),
]
