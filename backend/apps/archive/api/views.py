"""/api/v1/archive/ — archived correspondence, archive officers only.
Every opening of an item is audited (who, which item, when)."""
from rest_framework.exceptions import NotFound
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import log, request_context
from apps.textsearch import matches

from .. import services

SEARCH_SCAN_LIMIT = 2000


class _Pagination(PageNumberPagination):
    page_size = 30
    page_size_query_param = "page_size"
    max_page_size = 100


class ArchiveStatusView(APIView):
    """Is the caller an archive officer? (the UI shows the archive tab)."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"is_officer": services.is_officer(request.user)})


class ArchiveItemListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        services.require_officer(request.user)
        qs = services.archived_queryset()
        q = (request.query_params.get("q") or "").strip()
        if q:
            hits = []
            for c in qs[:SEARCH_SCAN_LIMIT]:
                item = services.item_to_dict(c, with_content=True)
                if matches(q, item["reference_number"] or "", item["sender"], item["subject"], item["body"]):
                    hits.append(c.id)
            qs = qs.filter(id__in=hits)
        paginator = _Pagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response([services.item_to_dict(c, with_content=False) for c in page])


class ArchiveItemDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, correspondence_id):
        services.require_officer(request.user)
        c = services.archived_queryset().filter(id=correspondence_id).first()
        if c is None:
            raise NotFound("هذه المراسلة ليست في الأرشيف المؤسسي.")
        log(actor=request.user, action="archive_copy_viewed", target_type="correspondence",
            target_id=c.id, metadata={"reference_number": c.reference_number},
            **request_context(request))
        return Response(services.item_to_dict(c, with_content=True))
