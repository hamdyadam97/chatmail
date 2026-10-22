"""URL routes for /api/v1/attachments/ (encrypted blobs only)."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.AttachmentUploadView.as_view(), name="attachment-upload"),
    path("<uuid:stored_file_id>/", views.AttachmentDownloadView.as_view(), name="attachment-download"),
]
