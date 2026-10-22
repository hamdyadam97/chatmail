"""URL routes for /api/v1/roles/."""
from django.urls import path

from . import views

urlpatterns = [
    path("catalog/", views.RoleCatalogView.as_view(), name="role-catalog"),
    path("assignments/", views.AssignmentListCreateView.as_view(), name="role-assignments"),
    path(
        "assignments/<uuid:assignment_id>/",
        views.AssignmentRevokeView.as_view(),
        name="role-assignment-revoke",
    ),
]
