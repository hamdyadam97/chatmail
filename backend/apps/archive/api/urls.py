"""URL routes for /api/v1/archive/."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.ArchiveStatusView.as_view(), name="archive-status"),
    path("items/", views.ArchiveItemListView.as_view(), name="archive-items"),
    path("items/<uuid:correspondence_id>/", views.ArchiveItemDetailView.as_view(), name="archive-item"),
]
