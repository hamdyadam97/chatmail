"""/api/v1/archive/ — central archive key + archived copies (officers only,
except reading the public key, which every sender needs)."""
from django.db.models import Q
from rest_framework.exceptions import NotFound
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.status import HTTP_201_CREATED
from rest_framework.views import APIView

from apps.audit.services import log, request_context
from apps.crypto_keys.services import b64encode

from .. import services


class _Pagination(PageNumberPagination):
    page_size = 30
    page_size_query_param = "page_size"
    max_page_size = 100


class ArchiveKeyView(APIView):
    """GET: the active archive public key (senders encrypt copies to it).
    POST: an archive officer creates the first key from one of their devices."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        key = services.active_key()
        officer = services.is_officer(request.user)
        return Response(
            {
                "key": services.key_to_dict(key) if key else None,
                "is_officer": officer,
                "devices": services.officer_devices_status(key) if key and officer else [],
                # the version a new key will get (the creating device signs it)
                "next_version": services.next_version(),
            }
        )

    def post(self, request):
        body = request.data if isinstance(request.data, dict) else {}
        key = services.create_key(
            request.user,
            device_id=body.get("device_id"),
            public_key_b64=body.get("public_key"),
            signature_b64=body.get("signature"),
        )
        log(actor=request.user, action="archive_key_created", target_type="archive_key", target_id=key.id,
            metadata={"version": key.version}, **request_context(request))
        return Response(services.key_to_dict(key), status=HTTP_201_CREATED)


class ArchiveKeyShareView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        body = request.data if isinstance(request.data, dict) else {}
        share = services.share_key(
            request.user,
            key_id=body.get("key_id"),
            recipient_device_id=body.get("recipient_device_id"),
            ephemeral_pub_b64=body.get("ephemeral_pub"),
            iv_b64=body.get("iv"),
            ciphertext_b64=body.get("ciphertext"),
        )
        log(actor=request.user, action="archive_key_shared", target_type="trusted_device",
            target_id=share.recipient_device_id, metadata={"archive_key_id": str(share.archive_key_id)},
            **request_context(request))
        return Response({"id": str(share.id)}, status=HTTP_201_CREATED)


class MyArchiveKeyShareView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        share = services.my_share(request.user, request.query_params.get("device_id"))
        if share is None:
            raise NotFound("لم يُشارَك مفتاح الأرشيف مع هذا الجهاز بعد.")
        return Response(
            {
                "key_id": str(share.archive_key_id),
                "ephemeral_pub": b64encode(share.ephemeral_pub),
                "iv": b64encode(share.iv),
                "ciphertext": b64encode(share.ciphertext),
            }
        )


class ArchiveCopyListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        services.require_officer(request.user)
        qs = services.copies_queryset()
        q = (request.query_params.get("q") or "").strip()
        if q:
            # metadata only: reference number or sender name (content is ciphertext)
            qs = qs.filter(
                Q(correspondence__reference_number__icontains=q)
                | Q(correspondence__sender__full_name__icontains=q)
            )
        paginator = _Pagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response([services.copy_to_dict(c, with_ciphertext=False) for c in page])


class ArchiveCopyDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, correspondence_id):
        services.require_officer(request.user)
        copy = services.copies_queryset().filter(correspondence_id=correspondence_id).first()
        if copy is None:
            raise NotFound("لا توجد نسخة أرشيف لهذه المراسلة.")
        # Every opening of archived content is audited (who, which item, when).
        log(actor=request.user, action="archive_copy_viewed", target_type="correspondence",
            target_id=copy.correspondence_id, metadata={"reference_number": copy.correspondence.reference_number},
            **request_context(request))
        return Response(services.copy_to_dict(copy, with_ciphertext=True))
