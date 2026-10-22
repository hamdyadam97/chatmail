"""URL routes for /api/v1/approvals/."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.ApprovalListCreateView.as_view(), name="approval-list"),
    path("delegations/", views.DelegationListCreateView.as_view(), name="approval-delegations"),
    path(
        "delegations/<uuid:delegation_id>/revoke/",
        views.DelegationRevokeView.as_view(),
        name="approval-delegation-revoke",
    ),
    path("workflows/", views.WorkflowListCreateView.as_view(), name="approval-workflows"),
    path("<uuid:request_id>/", views.ApprovalDetailView.as_view(), name="approval-detail"),
    path("<uuid:request_id>/decide/", views.DecideView.as_view(), name="approval-decide"),
    path("<uuid:request_id>/cancel/", views.CancelView.as_view(), name="approval-cancel"),
    path("<uuid:request_id>/complete/", views.CompleteView.as_view(), name="approval-complete"),
]
