"""URL routes for /api/v1/correspondences/."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.CorrespondenceListCreateView.as_view(), name="correspondence-list"),
    path("counts/", views.CountsView.as_view(), name="correspondence-counts"),
    path("<uuid:correspondence_id>/", views.CorrespondenceDetailView.as_view(), name="correspondence-detail"),
    path("<uuid:correspondence_id>/send/", views.SendView.as_view(), name="correspondence-send"),
    path("<uuid:correspondence_id>/reply/", views.ReplyView.as_view(), name="correspondence-reply"),
    path("<uuid:correspondence_id>/forward/", views.ForwardView.as_view(), name="correspondence-forward"),
    path("<uuid:correspondence_id>/read/", views.ReadView.as_view(), name="correspondence-read"),
    path("<uuid:correspondence_id>/flags/", views.FlagsView.as_view(), name="correspondence-flags"),
    path("<uuid:correspondence_id>/close/", views.CloseView.as_view(), name="correspondence-close"),
    path("<uuid:correspondence_id>/events/", views.EventsView.as_view(), name="correspondence-events"),
]
