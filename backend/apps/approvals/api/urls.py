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
    path("workflows/<uuid:workflow_id>/", views.WorkflowDetailView.as_view(), name="approval-workflow"),
    path("request-types/", views.RequestTypesView.as_view(), name="approval-request-types"),
    path("file-request/", views.FileRequestView.as_view(), name="approval-file-request"),
    path("signature/", views.SignatureView.as_view(), name="approval-signature"),
    path("verify/", views.VerifySignatureView.as_view(), name="approval-verify"),
    path("<uuid:request_id>/", views.ApprovalDetailView.as_view(), name="approval-detail"),
    path("<uuid:request_id>/decide/", views.DecideView.as_view(), name="approval-decide"),
    path("<uuid:request_id>/defer/", views.DeferView.as_view(), name="approval-defer"),
    path("<uuid:request_id>/resubmit/", views.ResubmitView.as_view(), name="approval-resubmit"),
    path("<uuid:request_id>/cancel/", views.CancelView.as_view(), name="approval-cancel"),
    path("<uuid:request_id>/remind/", views.RemindView.as_view(), name="approval-remind"),
    path("<uuid:request_id>/withdraw/", views.WithdrawView.as_view(), name="approval-withdraw"),
    path("<uuid:request_id>/complete/", views.CompleteView.as_view(), name="approval-complete"),
    path("<uuid:request_id>/remove-approver/", views.RemoveApproverView.as_view(), name="approval-remove-approver"),
]
