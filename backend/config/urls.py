"""Root URL configuration."""
from django.urls import include, path

urlpatterns = [
    path("api/v1/auth/", include("apps.accounts.api.urls")),
    path("api/v1/users/", include("apps.accounts.api.user_urls")),
    path("api/v1/org/", include("apps.org.api.urls")),
    path("api/v1/roles/", include("apps.authorization.api.urls")),
    path("api/v1/conversations/", include("apps.messaging.api.urls")),
    path("api/v1/correspondences/", include("apps.correspondence.api.urls")),
    path("api/v1/attachments/", include("apps.correspondence.api.attachment_urls")),
    path("api/v1/notifications/", include("apps.notifications.api.urls")),
    path("api/v1/approvals/", include("apps.approvals.api.urls")),
    path("api/v1/announcements/", include("apps.announcements.api.urls")),
    path("api/v1/reports/", include("apps.reports.api.urls")),
    path("api/v1/archive/", include("apps.archive.api.urls")),
    path("api/v1/external-mail/", include("apps.external_mail.api.urls")),
    path("api/v1/audit-logs/", include("apps.audit.api.urls")),
    path("api/v1/search/", include("apps.search.urls")),
]
