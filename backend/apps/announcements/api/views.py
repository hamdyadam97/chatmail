"""/api/v1/announcements/ — content gates: publisher + declared recipients;
compliance gates: publisher + announcements.track_ack in the target unit."""
import base64
import binascii

from rest_framework import serializers, status
from rest_framework.exceptions import ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.messaging.services import b64decode, b64encode

from .. import services
from ..models import Announcement, AnnouncementRecipient


def _user_ref(u) -> dict:
    return {"id": str(u.id), "full_name": u.full_name, "username": u.username}


def _target_label(a) -> dict:
    unit = a.target_department or a.target_branch or a.target_institute
    return {"type": a.target_type, "id": str(unit.id) if unit else None, "name": unit.name if unit else None}


def announcement_dict(a: Announcement, viewer, row=None) -> dict:
    data = {
        "id": str(a.id),
        "reference_number": a.reference_number,
        "publisher": _user_ref(a.publisher),
        "target": _target_label(a),
        "priority": a.priority,
        "requires_ack": a.requires_ack,
        "ack_due_at": a.ack_due_at.isoformat() if a.ack_due_at else None,
        "status": a.status,
        "created_at": a.created_at.isoformat(),
        "published_at": a.published_at.isoformat() if a.published_at else None,
        "withdrawn_at": a.withdrawn_at.isoformat() if a.withdrawn_at else None,
        "recipient_count": a.recipients.count(),
        "is_publisher": a.publisher_id == viewer.id,
        "can_track": services.can_track(viewer, a),
        "thread": {
            "id": str(a.thread_id),
            "mls_group_id": b64encode(bytes(a.thread.mls_group_id)),
            "current_epoch": a.thread.current_epoch,
        },
        "content_hash": b64encode(bytes(a.content_hash)) if a.content_hash else None,
        "content": None,
        "mine": None,
    }
    if a.content_message_id:
        m = a.content_message
        data["content"] = {
            "seq": m.seq,
            "epoch": m.epoch,
            "sender_device_id": str(m.sender_device_id) if m.sender_device_id else None,
            "client_msg_id": str(m.client_msg_id),
            "mls_payload": b64encode(bytes(m.mls_payload)),
        }
    if row is not None:
        data["mine"] = {
            "delivered_at": row.delivered_at.isoformat() if row.delivered_at else None,
            "read_at": row.read_at.isoformat() if row.read_at else None,
            "acknowledged_at": row.acknowledged_at.isoformat() if row.acknowledged_at else None,
        }
    return data


class _Pagination(PageNumberPagination):
    page_size = 25
    max_page_size = 100
    page_size_query_param = "page_size"


class PrepareSerializer(serializers.Serializer):
    target_type = serializers.ChoiceField(choices=[c for c, _ in Announcement.TARGETS])
    target_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    user_ids = serializers.ListField(child=serializers.UUIDField(), required=False, default=list, max_length=1000)
    priority = serializers.ChoiceField(choices=[c for c, _ in Announcement.PRIORITIES], default="normal")
    requires_ack = serializers.BooleanField(default=True)
    ack_due_at = serializers.DateTimeField(required=False, allow_null=True, default=None)
    sender_membership_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    mls_group_id = serializers.CharField(max_length=64)
    client_ref = serializers.UUIDField()


class AnnouncementListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        box = request.query_params.get("box", "received")
        paginator = _Pagination()
        if box == "received":
            rows = (
                AnnouncementRecipient.objects.filter(user=request.user, announcement__status__in=["published", "withdrawn"])
                .select_related("announcement__publisher", "announcement__thread", "announcement__content_message",
                                "announcement__target_institute", "announcement__target_branch",
                                "announcement__target_department")
                .order_by("-announcement__published_at")
            )
            if request.query_params.get("pending_ack") == "1":
                rows = rows.filter(acknowledged_at__isnull=True, announcement__requires_ack=True,
                                   announcement__status="published")
            page = paginator.paginate_queryset(rows, request, view=self)
            items = [announcement_dict(r.announcement, request.user, r) for r in page]
        elif box == "published":
            qs = (
                Announcement.objects.filter(publisher=request.user)
                .select_related("publisher", "thread", "content_message", "target_institute", "target_branch",
                                "target_department")
                .order_by("-created_at")
            )
            page = paginator.paginate_queryset(qs, request, view=self)
            items = [announcement_dict(a, request.user) for a in page]
        else:
            raise ValidationError({"box": "received | published"})
        return paginator.get_paginated_response(items)

    def post(self, request):
        s = PrepareSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        a, created = services.prepare(
            publisher=request.user,
            target_type=d["target_type"],
            target_id=d["target_id"],
            user_ids=d["user_ids"],
            priority=d["priority"],
            requires_ack=d["requires_ack"],
            ack_due_at=d["ack_due_at"],
            membership_id=d["sender_membership_id"],
            mls_group_id=b64decode(d["mls_group_id"]),
            client_ref=d["client_ref"],
        )
        return Response(announcement_dict(a, request.user), status=status.HTTP_201_CREATED if created else 200)


class AnnouncementDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, announcement_id):
        a = services.get_viewable(request.user, announcement_id)
        services.mark_delivered(request.user, a)
        return Response(announcement_dict(a, request.user, services.recipient_row(request.user, a)))

    def delete(self, request, announcement_id):
        services.discard_draft(request.user, announcement_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class AudienceView(APIView):
    """The declared audience — every recipient may see it and compare it with
    the MLS roster (no undeclared reader)."""

    permission_classes = [IsAuthenticated]

    def get(self, request, announcement_id):
        a = services.get_viewable(request.user, announcement_id)
        rows = a.recipients.select_related("user").order_by("user__full_name")
        return Response(
            {"publisher": _user_ref(a.publisher), "recipients": [_user_ref(r.user) for r in rows]}
        )


class PublishSerializer(serializers.Serializer):
    mls_payload = serializers.CharField(max_length=400_000)
    client_msg_id = serializers.UUIDField()
    epoch = serializers.IntegerField(min_value=1)
    sender_device_id = serializers.UUIDField()


class PublishView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, announcement_id):
        a = services.get_viewable(request.user, announcement_id)
        s = PublishSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        d = s.validated_data
        a = services.publish(
            publisher=request.user,
            announcement=a,
            mls_payload=b64decode(d["mls_payload"]),
            client_msg_id=d["client_msg_id"],
            epoch=d["epoch"],
            sender_device_id=d["sender_device_id"],
        )
        return Response(announcement_dict(a, request.user))


class ReadView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, announcement_id):
        services.mark_read(request.user, services.get_viewable(request.user, announcement_id))
        return Response(status=status.HTTP_204_NO_CONTENT)


class AckSerializer(serializers.Serializer):
    payload = serializers.CharField(max_length=2048)
    signature = serializers.CharField(max_length=200)
    device_id = serializers.UUIDField()

    def validate(self, attrs):
        try:
            attrs["payload_raw"] = base64.b64decode(attrs["payload"], validate=True)
            attrs["signature_raw"] = base64.b64decode(attrs["signature"], validate=True)
        except (binascii.Error, ValueError):
            raise serializers.ValidationError("base64 غير صالح.")
        return attrs


class AckView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, announcement_id):
        a = services.get_viewable(request.user, announcement_id)
        s = AckSerializer(data=request.data)
        s.is_valid(raise_exception=True)
        row = services.acknowledge(
            user=request.user,
            announcement=a,
            payload=s.validated_data["payload_raw"],
            signature=s.validated_data["signature_raw"],
            device_id=s.validated_data["device_id"],
        )
        return Response({"acknowledged_at": row.acknowledged_at.isoformat()})


class ComplianceView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, announcement_id):
        return Response(services.compliance(services.get_trackable(request.user, announcement_id)))


class RemindView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, announcement_id):
        count = services.remind(request.user, services.get_trackable(request.user, announcement_id))
        return Response({"reminded": count})


class WithdrawView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, announcement_id):
        a = services.withdraw(request.user, services.get_viewable(request.user, announcement_id))
        return Response(announcement_dict(a, request.user))
