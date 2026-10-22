"""DRF exception hook: record unauthorized access attempts (401/403) on
API endpoints in the audit log. Auth endpoints audit themselves (login
success/failure, MFA failures) so they are excluded here to avoid noise.
"""
from rest_framework.views import exception_handler as drf_exception_handler

from .services import log, request_context

_SKIP_PREFIXES = ("/api/v1/auth/",)


def exception_handler(exc, context):
    response = drf_exception_handler(exc, context)
    request = context.get("request")
    if (
        response is not None
        and response.status_code in (401, 403)
        and request is not None
        and request.path.startswith("/api/")
        and not request.path.startswith(_SKIP_PREFIXES)
    ):
        user = getattr(request, "user", None)
        actor = user if getattr(user, "is_authenticated", False) else None
        log(
            actor=actor,
            action="unauthorized_access_denied",
            target_type="api_endpoint",
            ip=request_context(request)["ip"],
            user_agent=request_context(request)["user_agent"],
            metadata={
                "path": request.path,
                "method": request.method,
                "status": response.status_code,
            },
        )
    return response
