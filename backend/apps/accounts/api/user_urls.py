"""URL routes for /api/v1/users/."""
from django.urls import path

from . import admin_views, user_views

urlpatterns = [
    path("me/", user_views.MeView.as_view(), name="users-me"),
    path("", user_views.UserDirectoryView.as_view(), name="users-directory"),
    path("managed/", admin_views.ManagedUsersView.as_view(), name="users-managed"),
    path("<uuid:user_id>/memberships/", admin_views.MembershipsView.as_view(), name="user-memberships"),
    path(
        "<uuid:user_id>/memberships/<uuid:membership_id>/",
        admin_views.MembershipDetailView.as_view(),
        name="user-membership-detail",
    ),
    path("<uuid:user_id>/transfer/", admin_views.TransferView.as_view(), name="user-transfer"),
    path("<uuid:user_id>/revoke-sessions/", admin_views.RevokeSessionsView.as_view(), name="user-revoke-sessions"),
    path("<uuid:user_id>/", user_views.UserDetailView.as_view(), name="user-detail"),
    path(
        "<uuid:user_id>/reset-password/",
        user_views.ResetPasswordView.as_view(),
        name="user-reset-password",
    ),
]
