"""URL routes for /api/v1/auth/."""
from django.urls import path

from . import views

urlpatterns = [
    path("login/", views.LoginView.as_view(), name="auth-login"),
    path("mfa/verify/", views.MFAVerifyView.as_view(), name="auth-mfa-verify"),
    path("login/code/", views.LoginCodeView.as_view(), name="auth-login-code"),
    path("login-approvals/", views.LoginApprovalListView.as_view(), name="auth-login-approvals"),
    path(
        "login-approvals/<uuid:approval_id>/reject/",
        views.LoginApprovalRejectView.as_view(),
        name="auth-login-approval-reject",
    ),
    path("mfa/setup/", views.MFASetupView.as_view(), name="auth-mfa-setup"),
    path("mfa/enable/", views.MFAEnableView.as_view(), name="auth-mfa-enable"),
    path("mfa/disable/", views.MFADisableView.as_view(), name="auth-mfa-disable"),
    path("refresh/", views.RefreshView.as_view(), name="auth-refresh"),
    path("logout/", views.LogoutView.as_view(), name="auth-logout"),
    path("sessions/", views.SessionListView.as_view(), name="auth-sessions"),
    path(
        "sessions/<uuid:session_id>/",
        views.SessionRevokeView.as_view(),
        name="auth-session-revoke",
    ),
    path("password/change/", views.PasswordChangeView.as_view(), name="auth-password-change"),
]
