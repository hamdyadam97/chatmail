"""URL routes for /api/v1/announcements/."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.AnnouncementListCreateView.as_view(), name="announcement-list"),
    path("<uuid:announcement_id>/", views.AnnouncementDetailView.as_view(), name="announcement-detail"),
    path("<uuid:announcement_id>/audience/", views.AudienceView.as_view(), name="announcement-audience"),
    path("<uuid:announcement_id>/read/", views.ReadView.as_view(), name="announcement-read"),
    path("<uuid:announcement_id>/ack/", views.AckView.as_view(), name="announcement-ack"),
    path("<uuid:announcement_id>/compliance/", views.ComplianceView.as_view(), name="announcement-compliance"),
    path("<uuid:announcement_id>/remind/", views.RemindView.as_view(), name="announcement-remind"),
    path("<uuid:announcement_id>/withdraw/", views.WithdrawView.as_view(), name="announcement-withdraw"),
]
