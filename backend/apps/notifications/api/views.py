"""/api/v1/notifications/ — the caller's own notifications only."""
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.messaging.services import issue_scoped_ws_ticket

from ..consumers import TICKET_SCOPE
from ..models import Notification, NotificationPreference
from ..services import TITLES, to_dict


class _Pagination(PageNumberPagination):
    page_size = 30
    page_size_query_param = "page_size"
    max_page_size = 100


class NotificationListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = Notification.objects.filter(user=request.user).order_by("-created_at")
        if request.query_params.get("unread") == "1":
            qs = qs.filter(read_at__isnull=True)
        paginator = _Pagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response([to_dict(n) for n in page])


class UnreadCountView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        count = Notification.objects.filter(user=request.user, read_at__isnull=True).count()
        return Response({"unread": count})


class MarkReadView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, notification_id):
        n = Notification.objects.filter(id=notification_id).first()
        if n is None or n.user_id != request.user.id:
            raise PermissionDenied("Not your notification.")
        if n.read_at is None:
            n.read_at = timezone.now()
            n.save(update_fields=["read_at"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class MarkAllReadView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        Notification.objects.filter(user=request.user, read_at__isnull=True).update(read_at=timezone.now())
        return Response(status=status.HTTP_204_NO_CONTENT)


class PreferencesView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        pref, _ = NotificationPreference.objects.get_or_create(user=request.user)
        return Response({"muted_kinds": sorted(pref.muted_kinds()), "kinds": TITLES})

    def put(self, request):
        muted = request.data.get("muted_kinds", [])
        if not isinstance(muted, list) or any(k not in TITLES for k in muted):
            raise ValidationError({"muted_kinds": "unknown kind."})
        pref, _ = NotificationPreference.objects.get_or_create(user=request.user)
        pref.prefs = {**pref.prefs, "muted_kinds": sorted(set(muted))}
        pref.save(update_fields=["prefs", "updated_at"])
        return Response({"muted_kinds": pref.prefs["muted_kinds"]})


class WsTicketView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"ticket": issue_scoped_ws_ticket(request.user, TICKET_SCOPE)})
