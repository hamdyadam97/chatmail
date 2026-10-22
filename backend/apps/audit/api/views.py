"""/api/v1/audit-logs/ — read-only views over the append-only audit log.

* ``/``       full log, central ``audit.view`` only (declared security
  auditor). Each query is itself logged — watching the watchers.
* ``/mine/``  the caller's own security events (logins, devices, keys…),
  for the Security page. Any authenticated user.

Rows hold identifiers and counters only (see apps.audit.services), never
passwords, keys or content (SEC-10).
"""
from datetime import date, datetime, time

from django.db.models import Q
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.authorization.services import has_permission

from ..models import AuditLog
from ..services import log, request_context

# Actions shown to users about their own account.
SECURITY_ACTIONS = (
    "login",
    "login_failed",
    "login_mfa_challenge_issued",
    "logout",
    "password_changed",
    "password_reset",
    "mfa_setup",
    "mfa_enabled",
    "mfa_disabled",
    "mfa_verify_failed",
    "session_revoked",
    "key_event",
    "device_added",
    "device_approved",
    "device_revoked",
)


def _row(entry: AuditLog) -> dict:
    actor = entry.actor
    return {
        "id": entry.id,
        "created_at": entry.created_at.isoformat(),
        "action": entry.action,
        "actor": {"id": str(actor.id), "username": actor.username, "full_name": actor.full_name} if actor else None,
        "actor_device_id": str(entry.actor_device_id) if entry.actor_device_id else None,
        "target_type": entry.target_type,
        "target_id": str(entry.target_id) if entry.target_id else None,
        "org_scope": entry.org_scope,
        "ip": entry.ip,
        "user_agent": (entry.user_agent or "")[:160],
        "metadata": entry.metadata,
    }


class _Pagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


def _day(value, end=False):
    if not value:
        return None
    try:
        d = date.fromisoformat(value)
    except ValueError:
        raise ValidationError({"date": "صيغة التاريخ YYYY-MM-DD."})
    return timezone.make_aware(datetime.combine(d, time.max if end else time.min))


class AuditLogListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not has_permission(request.user, "audit.view", unit=None):
            raise PermissionDenied("audit.view is required.")
        p = request.query_params
        qs = AuditLog.objects.select_related("actor").order_by("-id")
        if p.get("action"):
            qs = qs.filter(action=p["action"])
        if p.get("actor"):
            qs = qs.filter(actor__username=p["actor"])
        if p.get("target_type"):
            qs = qs.filter(target_type=p["target_type"])
        if p.get("target_id"):
            qs = qs.filter(target_id=p["target_id"])
        if p.get("ip"):
            qs = qs.filter(ip=p["ip"])
        if p.get("from"):
            qs = qs.filter(created_at__gte=_day(p["from"]))
        if p.get("to"):
            qs = qs.filter(created_at__lte=_day(p["to"], end=True))
        paginator = _Pagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        log(
            actor=request.user,
            action="audit_log_viewed",
            metadata={k: p[k] for k in ("action", "actor", "target_type", "from", "to") if p.get(k)},
            **request_context(request),
        )
        return paginator.get_paginated_response([_row(e) for e in page])


class AuditActionsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not has_permission(request.user, "audit.view", unit=None):
            raise PermissionDenied("audit.view is required.")
        actions = AuditLog.objects.order_by("action").values_list("action", flat=True).distinct()
        return Response(list(actions))


class MyAuditLogView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = (
            # Mine = done by me, or done to my account (e.g. an admin reset).
            AuditLog.objects.filter(action__in=SECURITY_ACTIONS)
            .filter(Q(actor=request.user) | Q(target_type="user", target_id=request.user.id))
            .select_related("actor")
            .order_by("-id")[:100]
        )
        return Response([_row(e) for e in qs])
