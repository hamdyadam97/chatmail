"""Correspondence API under /api/v1/correspondences/ and /api/v1/attachments/.

Every object endpoint goes through services.get_readable (participants only)
or an explicit sender check — the same object-permission gate for everyone,
whatever their role (AGENTS rule 5, SEC-01/02).
"""
from django.conf import settings
from django.db.models import Count, Max
from django.http import HttpResponse
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import BaseParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from .. import services
from apps.messaging.services import b64encode

from ..models import Correspondence, CorrespondenceParticipant, EncryptedAttachment
from .serializers import (
    FlagsSerializer,
    PrepareSerializer,
    ReplySerializer,
    SendSerializer,
    correspondence_detail,
    correspondence_summary,
    event_to_dict,
)


class _UserThrottle(SimpleRateThrottle):
    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": str(request.user.pk)}


class CorrespondenceWriteThrottle(_UserThrottle):
    scope = "correspondence_write"
    rate = "60/min"


class AttachmentUploadThrottle(_UserThrottle):
    scope = "attachment_upload"
    rate = "30/min"


class CorrespondencePagination(PageNumberPagination):
    page_size = 25
    page_size_query_param = "page_size"
    max_page_size = 100


def _detail_payload(request, correspondence):
    participants = services.visible_participants(correspondence, request.user)
    my_row = next((p for p in participants if p.user_id == request.user.id), None)
    attachments = list(
        EncryptedAttachment.objects.filter(correspondence=correspondence).select_related("stored_file")
    )
    siblings = (
        Correspondence.objects.filter(thread=correspondence.thread, status__in=["sent", "closed"])
        .filter(id__in=services.readable_ids_subquery(request.user))
        .select_related("sender", "content_message")
        .order_by("sent_at")
    )
    # Caller's own unread rows only (per-user metadata; the conversation view
    # expands these and marks them read).
    unread = {
        str(cid)
        for cid in CorrespondenceParticipant.objects.filter(
            user=request.user, correspondence__in=siblings, read_at__isnull=True
        )
        .exclude(kind="from")
        .values_list("correspondence_id", flat=True)
    }
    thread_items = [
        {
            "id": str(s.id),
            "reference_number": s.reference_number,
            "sender_id": str(s.sender_id),
            "sent_at": s.sent_at.isoformat(),
            "reply_to_id": str(s.reply_to_id) if s.reply_to_id else None,
            "content_seq": s.content_message.seq,
            "unread": str(s.id) in unread,
        }
        for s in siblings
    ]
    return correspondence_detail(correspondence, my_row, participants, attachments, thread_items)


class CorrespondenceListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get_throttles(self):
        return [CorrespondenceWriteThrottle()] if self.request.method == "POST" else []

    def get(self, request):
        folder = request.query_params.get("folder", "inbox")
        rows = services.folder_queryset(request.user, folder)
        params = request.query_params
        if params.get("q"):
            # Server search = metadata only (reference number). Content search
            # happens on the client over locally decrypted text (SEC-12).
            rows = rows.filter(correspondence__reference_number__icontains=params["q"].strip())
        if params.get("priority"):
            rows = rows.filter(correspondence__priority=params["priority"])
        if params.get("status"):
            rows = rows.filter(correspondence__status=params["status"])
        if params.get("unread") == "1":
            rows = rows.filter(read_at__isnull=True)
        if params.get("sent_after"):
            rows = rows.filter(correspondence__sent_at__date__gte=params["sent_after"])
        if params.get("sent_before"):
            rows = rows.filter(correspondence__sent_at__date__lte=params["sent_before"])
        order = "-correspondence__created_at" if folder == "drafts" else "-correspondence__sent_at"
        rows = rows.order_by(order)

        paginator = CorrespondencePagination()
        page = paginator.paginate_queryset(rows, request, view=self)
        # Whole-conversation size and last activity (my readable items only),
        # so the list can show one row per conversation like Outlook.
        stats = {
            str(r["thread_id"]): r
            for r in Correspondence.objects.filter(
                thread_id__in={row.correspondence.thread_id for row in page},
                status__in=["sent", "closed"],
                id__in=services.readable_ids_subquery(request.user),
            )
            .values("thread_id")
            .annotate(n=Count("id"), last=Max("sent_at"))
        }
        items = []
        for row in page:
            c = row.correspondence
            item = correspondence_summary(c, row, services.visible_participants(c, request.user))
            st = stats.get(str(c.thread_id))
            item["thread_count"] = st["n"] if st else 1
            item["thread_last_at"] = st["last"].isoformat() if st and st["last"] else item["sent_at"]
            items.append(item)
        return paginator.get_paginated_response(items)

    def post(self, request):
        serializer = PrepareSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        result = services.prepare_correspondence(
            requester=request.user,
            to_ids=data["to_user_ids"],
            cc_ids=data["cc_user_ids"],
            bcc_ids=data["bcc_user_ids"],
            priority=data["priority"],
            classification=data["classification"],
            due_date=data["due_date"],
            membership_id=data["sender_membership_id"],
            mls_group_id=data["mls_group_id_raw"],
            client_ref=data["client_ref"],
        )
        code = status.HTTP_201_CREATED if result.created else status.HTTP_200_OK
        return Response(_detail_payload(request, result.correspondence), status=code)


class CorrespondenceDetailView(APIView):
    """GET (participants only) and DELETE (unsent draft, sender only).
    There is deliberately no PUT/PATCH: a sent correspondence is immutable."""

    permission_classes = [IsAuthenticated]

    def get(self, request, correspondence_id):
        correspondence = services.get_readable(request.user, correspondence_id)
        return Response(_detail_payload(request, correspondence))

    def delete(self, request, correspondence_id):
        services.discard_draft(request.user, correspondence_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class SendView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [CorrespondenceWriteThrottle]

    def post(self, request, correspondence_id):
        correspondence = services.get_readable(request.user, correspondence_id)
        serializer = SendSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        sent = services.send_correspondence(
            requester=request.user,
            correspondence=correspondence,
            mls_payload=data["mls_payload_raw"],
            client_msg_id=data["client_msg_id"],
            epoch=data["epoch"],
            sender_device_id=data["sender_device_id"],
            attachment_ids=data["attachment_ids"],
            archive_copy=data["archive_copy"],
        )
        return Response(_detail_payload(request, sent))


class ReplyView(APIView):
    """Prepare + send a reply in the parent's thread in one call.

    Idempotent on client_ref: a retry after a failed send (e.g. 409 epoch
    conflict) reuses the same unsent reply row."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [CorrespondenceWriteThrottle]

    def post(self, request, correspondence_id):
        parent = services.get_readable(request.user, correspondence_id)
        meta = ReplySerializer(data=request.data)
        meta.is_valid(raise_exception=True)
        content = SendSerializer(data=request.data)
        content.is_valid(raise_exception=True)
        prepared = services.prepare_reply(
            requester=request.user,
            parent=parent,
            priority=meta.validated_data["priority"],
            due_date=meta.validated_data["due_date"],
            membership_id=meta.validated_data["sender_membership_id"],
            client_ref=meta.validated_data["client_ref"],
        )
        data = content.validated_data
        sent = services.send_correspondence(
            requester=request.user,
            correspondence=prepared.correspondence,
            mls_payload=data["mls_payload_raw"],
            client_msg_id=data["client_msg_id"],
            epoch=data["epoch"],
            sender_device_id=data["sender_device_id"],
            attachment_ids=data["attachment_ids"],
            archive_copy=data["archive_copy"],
        )
        return Response(_detail_payload(request, sent), status=status.HTTP_201_CREATED)


class ForwardView(APIView):
    """Prepare a forward: a NEW thread for the new recipients. The client then
    sets up the MLS group and sends the re-encrypted content via /send/."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [CorrespondenceWriteThrottle]

    def post(self, request, correspondence_id):
        source = services.get_readable(request.user, correspondence_id)
        serializer = PrepareSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        result = services.prepare_correspondence(
            requester=request.user,
            to_ids=data["to_user_ids"],
            cc_ids=data["cc_user_ids"],
            bcc_ids=data["bcc_user_ids"],
            priority=data["priority"],
            classification=data["classification"],
            due_date=data["due_date"],
            membership_id=data["sender_membership_id"],
            mls_group_id=data["mls_group_id_raw"],
            client_ref=data["client_ref"],
            forward_source=source,
        )
        code = status.HTTP_201_CREATED if result.created else status.HTTP_200_OK
        return Response(_detail_payload(request, result.correspondence), status=code)


class ReadView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, correspondence_id):
        correspondence = services.get_readable(request.user, correspondence_id)
        services.mark_read(request.user, correspondence)
        return Response(status=status.HTTP_204_NO_CONTENT)


class FlagsView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, correspondence_id):
        correspondence = services.get_readable(request.user, correspondence_id)
        serializer = FlagsSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        row = services.set_flags(
            request.user,
            correspondence,
            archived=serializer.validated_data["archived"],
            important=serializer.validated_data["important"],
        )
        return Response({"archived": row.archived_at is not None, "is_important": row.is_important})


class CloseView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, correspondence_id):
        correspondence = services.get_readable(request.user, correspondence_id)
        services.close_correspondence(request.user, correspondence)
        return Response(_detail_payload(request, correspondence))


class EventsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, correspondence_id):
        correspondence = services.get_readable(request.user, correspondence_id)
        events = correspondence.events.select_related("actor").order_by("created_at")
        return Response([event_to_dict(e) for e in events])


class CountsView(APIView):
    """Unread inbox count + pending replies — folder badges."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(
            {
                "inbox_unread": services.folder_queryset(request.user, "inbox")
                .filter(read_at__isnull=True)
                .count(),
                "pending_replies": services.folder_queryset(request.user, "pending_replies").count(),
                "drafts": services.folder_queryset(request.user, "drafts").count(),
            }
        )


# --- attachments ------------------------------------------------------------------

class OctetStreamParser(BaseParser):
    """Raw encrypted bytes; size is bounded before reading."""

    media_type = "application/octet-stream"

    def parse(self, stream, media_type=None, parser_context=None):
        limit = settings.ENCRYPTED_ATTACHMENT_MAX_BYTES
        request = parser_context["request"]
        try:
            declared = int(request.META.get("CONTENT_LENGTH") or 0)
        except ValueError:
            declared = 0
        if declared > limit:
            raise ValidationError({"file": "encrypted blob too large."})
        data = stream.read(limit + 1) if stream is not None else b""
        if len(data) > limit:
            raise ValidationError({"file": "encrypted blob too large."})
        return data


class AttachmentUploadView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [OctetStreamParser]
    throttle_classes = [AttachmentUploadThrottle]

    def post(self, request):
        data = request.data
        if not isinstance(data, (bytes, bytearray)):
            raise ValidationError({"file": "send the encrypted blob as application/octet-stream."})
        stored = services.store_blob(request.user, bytes(data))
        return Response(
            {
                "id": str(stored.id),
                "ciphertext_size": stored.ciphertext_size,
                "ciphertext_sha256": b64encode(bytes(stored.ciphertext_sha256)),
            },
            status=status.HTTP_201_CREATED,
        )


class AttachmentDownloadView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, stored_file_id):
        stored = services.get_downloadable(request.user, stored_file_id)
        response = HttpResponse(services.read_blob(stored), content_type="application/octet-stream")
        response["Content-Disposition"] = f'attachment; filename="{stored.id}.bin"'
        response["Cache-Control"] = "no-store"
        response["X-Content-Type-Options"] = "nosniff"
        return response

