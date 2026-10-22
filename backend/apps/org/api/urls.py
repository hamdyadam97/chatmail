"""URL routes for /api/v1/org/."""
from django.urls import path

from . import views

urlpatterns = [
    path("institutes/", views.InstituteListCreateView.as_view(), name="org-institutes"),
    path("branches/", views.BranchListCreateView.as_view(), name="org-branches"),
    path("branches/<uuid:branch_id>/", views.BranchDetailView.as_view(), name="org-branch-detail"),
    path("departments/", views.DepartmentListCreateView.as_view(), name="org-departments"),
    path(
        "departments/<uuid:department_id>/",
        views.DepartmentDetailView.as_view(),
        name="org-department-detail",
    ),
]
