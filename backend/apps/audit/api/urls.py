"""URL routes for /api/v1/audit-logs/."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.AuditLogListView.as_view(), name="audit-log-list"),
    path("actions/", views.AuditActionsView.as_view(), name="audit-log-actions"),
    path("mine/", views.MyAuditLogView.as_view(), name="audit-log-mine"),
]
