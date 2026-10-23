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
from ..models import Notification, NotificationPreference, PushSubscription
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


# --- Web Push (desktop/OS notifications while the site is closed) ------------------

class PushPublicKeyView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        from .. import push

        return Response({"enabled": push.enabled(), "public_key": push.public_key()})


class PushSubscribeView(APIView):
    """Register this browser for the caller. The endpoint is unique: the same
    browser re-subscribing under another account moves to that account."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        from .. import push

        if not push.enabled():
            raise ValidationError({"detail": "push notifications are not configured."})
        endpoint = request.data.get("endpoint")
        keys = request.data.get("keys") or {}
        p256dh, auth = keys.get("p256dh"), keys.get("auth")
        if not isinstance(endpoint, str) or len(endpoint) > 1000 or not push.endpoint_allowed(endpoint):
            raise ValidationError({"endpoint": "unsupported push service."})
        if not (isinstance(p256dh, str) and 40 <= len(p256dh) <= 200 and isinstance(auth, str) and 8 <= len(auth) <= 100):
            raise ValidationError({"keys": "invalid subscription keys."})
        sub, _ = PushSubscription.objects.update_or_create(
            endpoint=endpoint,
            defaults={
                "user": request.user,
                "p256dh": p256dh,
                "auth": auth,
                "user_agent": request.headers.get("User-Agent", "")[:300],
                "failures": 0,
            },
        )
        return Response({"id": str(sub.id)}, status=status.HTTP_201_CREATED)


class PushUnsubscribeView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        endpoint = request.data.get("endpoint")
        if not isinstance(endpoint, str):
            raise ValidationError({"endpoint": "required."})
        PushSubscription.objects.filter(endpoint=endpoint, user=request.user).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class PushTestView(APIView):
    """Send a test notification to the caller's own browsers."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        from .. import push

        count = PushSubscription.objects.filter(user=request.user).count()
        if not push.enabled() or count == 0:
            raise ValidationError({"detail": "no push subscription for this account."})
        push.push_to_users(
            [request.user.id], kind="test", title="تجربة الإشعارات", body="الإشعارات تعمل على هذا الجهاز", url="/notifications", tag="test"
        )
        return Response({"subscriptions": count})
