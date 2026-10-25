"""URL routes for /api/v1/archive/."""
from django.urls import path

from . import views

urlpatterns = [
    path("key/", views.ArchiveKeyView.as_view(), name="archive-key"),
    path("key/shares/", views.ArchiveKeyShareView.as_view(), name="archive-key-shares"),
    path("key/shares/mine/", views.MyArchiveKeyShareView.as_view(), name="archive-key-share-mine"),
    path("copies/", views.ArchiveCopyListView.as_view(), name="archive-copies"),
    path("copies/<uuid:correspondence_id>/", views.ArchiveCopyDetailView.as_view(), name="archive-copy"),
]
