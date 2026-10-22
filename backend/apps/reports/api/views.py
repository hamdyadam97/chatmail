"""/api/v1/reports/ — aggregate metadata reports and service health."""
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from apps.audit.services import log, request_context
from apps.authorization.services import has_permission

from .. import services


class ReportThrottle(SimpleRateThrottle):
    scope = "reports"
    rate = "30/min"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": str(request.user.pk)}


class ReportView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ReportThrottle]

    def get(self, request):
        params = request.query_params
        unit = services.resolve_unit(params.get("unit_type", "all"), params.get("unit_id"))
        services.require_report_access(request.user, unit)
        start, end = services.parse_period(params.get("from"), params.get("to"))
        report = services.build_report(unit, start, end)
        # Metadata access by an administrator is itself audited (§5.6).
        log(
            actor=request.user,
            action="report_viewed",
            target_type=report["scope"]["type"],
            target_id=unit.id if unit else None,
            metadata={"from": report["period"]["from"], "to": report["period"]["to"]},
            **request_context(request),
        )
        return Response(report)


class ReportUnitsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(services.reportable_units(request.user))


class HealthView(APIView):
    """Service status — no org data at all; for report viewers and auditors."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not (services.reportable_units(request.user) or has_permission(request.user, "audit.view", unit=None)):
            raise PermissionDenied("reports.view_metadata or audit.view required.")
        return Response(services.health())
