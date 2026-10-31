"""Correspondence API under /api/v1/correspondences/ and /api/v1/attachments/.

Every object endpoint goes through services.get_readable (participants only)
or an explicit sender check — the same object-permission gate for everyone,
whatever their role (AGENTS rule 5, SEC-01/02).
"""
from urllib.parse import quote

from django.conf import settings
from django.db.models import Count, Max
from django.http import HttpResponse
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from apps.textsearch import matches

from .. import services
from ..models import Correspondence, CorrespondenceParticipant, StoredFile
from .serializers import (
    ComposeSerializer,
    DraftUpdateSerializer,
    FlagsSerializer,
    ReplySerializer,
    correspondence_detail,
    correspondence_summary,
    event_to_dict,
    files_by_id,
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
    siblings = list(
        Correspondence.objects.filter(thread=correspondence.thread, status__in=["sent", "closed"])
        .filter(id__in=services.readable_ids_subquery(request.user))
        .select_related("sender", "content_message")
        .order_by("sent_at")
    )
    contents = {s.id: services.correspondence_content(s) or {} for s in siblings}
    file_ids = {i for c in [*contents.values(), services.correspondence_content(correspondence) or {}]
                for i in c.get("attachments", [])}
    files = files_by_id(StoredFile.objects.filter(id__in=file_ids, deleted_at__isnull=True))
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
            "unread": str(s.id) in unread,
            "subject": contents[s.id].get("subject", ""),
            "body": contents[s.id].get("body", ""),
            "attachments": [files[i] for i in contents[s.id].get("attachments", []) if i in files],
            "forwarded": contents[s.id].get("forwarded"),
        }
        for s in siblings
    ]
    return correspondence_detail(correspondence, my_row, participants, files, thread_items)


# Content search opens each candidate in memory (content is sealed at rest),
# so it scans the most recent items of the folder only.
SEARCH_SCAN_LIMIT = 2000


def _search(rows, q):
    q = q.strip()
    hits = []
    for row in rows[:SEARCH_SCAN_LIMIT]:
        c = row.correspondence
        content = services.correspondence_content(c) or {}
        if matches(q, c.reference_number or "", content.get("subject", ""), content.get("body", ""),
                   c.sender.full_name):
            hits.append(row.id)
    return rows.model.objects.filter(id__in=hits)


class CorrespondenceListCreateView(APIView):
    permission_classes = [IsAuthenticated]

    def get_throttles(self):
        return [CorrespondenceWriteThrottle()] if self.request.method == "POST" else []

    def get(self, request):
        folder = request.query_params.get("folder", "inbox")
        rows = services.folder_queryset(request.user, folder)
        params = request.query_params
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
        if params.get("q", "").strip():
            rows = _search(rows, params["q"]).select_related(
                "correspondence", "correspondence__sender", "correspondence__thread"
            ).order_by(order)

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
        """Compose: save a draft (send=false) or send at once (send=true)."""
        serializer = ComposeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        result = services.create_correspondence(
            requester=request.user,
            to_ids=data["to_user_ids"],
            cc_ids=data["cc_user_ids"],
            bcc_ids=data["bcc_user_ids"],
            priority=data["priority"],
            classification=data["classification"],
            due_date=data["due_date"],
            membership_id=data["sender_membership_id"],
            client_ref=data["client_ref"],
            subject=data["subject"],
            body=data["body"],
            attachment_ids=data["attachment_ids"],
            send=data["send"],
        )
        code = status.HTTP_201_CREATED if result.created else status.HTTP_200_OK
        return Response(_detail_payload(request, result.correspondence), status=code)


class CorrespondenceDetailView(APIView):
    """GET (participants only), PATCH and DELETE (unsent draft, sender only).
    A sent correspondence is immutable."""

    permission_classes = [IsAuthenticated]

    def get(self, request, correspondence_id):
        correspondence = services.get_readable(request.user, correspondence_id)
        return Response(_detail_payload(request, correspondence))

    def patch(self, request, correspondence_id):
        correspondence = services.get_readable(request.user, correspondence_id)
        serializer = DraftUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        services.update_draft(
            requester=request.user,
            correspondence=correspondence,
            to_ids=data["to_user_ids"],
            cc_ids=data["cc_user_ids"],
            priority=data["priority"],
            classification=data["classification"],
            due_date=data["due_date"],
            subject=data["subject"],
            body=data["body"],
            attachment_ids=data["attachment_ids"],
        )
        return Response(_detail_payload(request, correspondence))

    def delete(self, request, correspondence_id):
        services.discard_draft(request.user, correspondence_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class SendView(APIView):
    """Send a saved draft."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [CorrespondenceWriteThrottle]

    def post(self, request, correspondence_id):
        correspondence = services.get_readable(request.user, correspondence_id)
        sent = services.send_correspondence(requester=request.user, correspondence=correspondence)
        return Response(_detail_payload(request, sent))


class ReplyView(APIView):
    """Reply-all in the parent's thread, sent at once. Idempotent on client_ref."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [CorrespondenceWriteThrottle]

    def post(self, request, correspondence_id):
        parent = services.get_readable(request.user, correspondence_id)
        serializer = ReplySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        prepared = services.prepare_reply(
            requester=request.user,
            parent=parent,
            priority=data["priority"],
            due_date=data["due_date"],
            membership_id=data["sender_membership_id"],
            client_ref=data["client_ref"],
            subject=data["subject"],
            body=data["body"],
            attachment_ids=data["attachment_ids"],
        )
        sent = services.send_correspondence(requester=request.user, correspondence=prepared.correspondence)
        return Response(_detail_payload(request, sent), status=status.HTTP_201_CREATED)


class ForwardView(APIView):
    """Forward = a NEW thread for the new recipients carrying the source
    content and files (send=false keeps it as a draft)."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [CorrespondenceWriteThrottle]

    def post(self, request, correspondence_id):
        source = services.get_readable(request.user, correspondence_id)
        serializer = ComposeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        result = services.create_correspondence(
            requester=request.user,
            to_ids=data["to_user_ids"],
            cc_ids=data["cc_user_ids"],
            bcc_ids=data["bcc_user_ids"],
            priority=data["priority"],
            classification=data["classification"],
            due_date=data["due_date"],
            membership_id=data["sender_membership_id"],
            client_ref=data["client_ref"],
            subject=data["subject"],
            body=data["body"],
            attachment_ids=data["attachment_ids"],
            send=data["send"],
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

class AttachmentUploadView(APIView):
    """multipart/form-data with one ``file``; sealed with the server key."""

    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser]
    throttle_classes = [AttachmentUploadThrottle]

    def post(self, request):
        upload = request.FILES.get("file")
        if upload is None:
            raise ValidationError({"file": "أرفق ملفًا."})
        if upload.size > settings.ENCRYPTED_ATTACHMENT_MAX_BYTES:
            raise ValidationError({"file": "الملف أكبر من الحد المسموح."})
        stored = services.store_blob(
            request.user, upload.read(), name=upload.name, mime=upload.content_type or ""
        )
        return Response(services.file_meta(stored), status=status.HTTP_201_CREATED)


def attachment_response(data: bytes, name: str) -> HttpResponse:
    """Always a download (octet-stream + attachment + nosniff): a file that
    is HTML/SVG must never render inside the app's origin."""
    response = HttpResponse(data, content_type="application/octet-stream")
    safe = quote(name or "attachment", safe="")
    response["Content-Disposition"] = f"attachment; filename=\"attachment\"; filename*=UTF-8''{safe}"
    response["Cache-Control"] = "no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response


class AttachmentDownloadView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, stored_file_id):
        stored = services.get_downloadable(request.user, stored_file_id)
        return attachment_response(services.read_blob(stored), services.file_meta(stored)["name"])
