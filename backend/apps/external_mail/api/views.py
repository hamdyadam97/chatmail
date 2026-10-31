"""/api/v1/external-mail/ — the caller's own external mail, plus per-employee
mailbox settings for account managers (same gate as the employee pages)."""
import base64
import binascii

from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.status import HTTP_201_CREATED
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from apps.accounts.api.admin_views import _get_target, _scope_unit_for_user
from apps.audit.services import log, request_context
from apps.authorization.services import has_permission

from .. import services
from ..models import ExternalMessage


class _Pagination(PageNumberPagination):
    page_size = 30
    page_size_query_param = "page_size"
    max_page_size = 100


class SendThrottle(SimpleRateThrottle):
    scope = "external_mail_send"
    rate = "20/min"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": str(request.user.pk)}


def _mailbox_dict(user) -> dict:
    mb = services.mailbox_for(user)
    return {
        "address": services.address_for(user),
        "local_part": mb.local_part,
        "receiving_enabled": mb.receiving_enabled,
        "sending_enabled": mb.sending_enabled,
        "receiving_configured": services.receiving_configured(),
        "sending_configured": services.sending_configured(),
    }


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        unread = ExternalMessage.objects.filter(owner=request.user, direction="in", read_at__isnull=True).count()
        return Response({**_mailbox_dict(request.user), "unread": unread})


class MessageListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = ExternalMessage.objects.filter(owner=request.user).order_by("-created_at")
        box = request.query_params.get("box")
        if box in ("in", "out"):
            qs = qs.filter(direction=box)
        q = (request.query_params.get("q") or "").strip()
        if q:
            qs = services.search(qs, q)
        paginator = _Pagination()
        page = paginator.paginate_queryset(qs, request, view=self)
        return paginator.get_paginated_response([services.summary(m) for m in page])


class MessageDetailView(APIView):
    """Metadata + content (owner only)."""

    permission_classes = [IsAuthenticated]

    def get(self, request, message_id):
        message = services.own_message(request.user, message_id)
        content = services.message_content(message)
        data = services.summary(message, content or {})
        data["content"] = content
        return Response(data)


class MessageReadView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, message_id):
        message = services.own_message(request.user, message_id)
        if message.read_at is None:
            message.read_at = timezone.now()
            message.save(update_fields=["read_at"])
        return Response(status=204)


def _decode_attachments(items) -> list[dict]:
    out = []
    for item in items or []:
        if not isinstance(item, dict):
            raise ValidationError({"attachments": "صيغة غير صالحة."})
        try:
            data = base64.b64decode(item.get("data") or "", validate=True)
        except (binascii.Error, ValueError):
            raise ValidationError({"attachments": "مرفق غير صالح."})
        out.append({"name": str(item.get("name") or "attachment")[:255],
                    "mime": str(item.get("mime") or "application/octet-stream")[:255], "data": data})
    return out


class SendView(APIView):
    """The text leaves the system through Brevo (plain Internet mail)."""

    permission_classes = [IsAuthenticated]
    throttle_classes = [SendThrottle]

    def post(self, request):
        body = request.data if isinstance(request.data, dict) else {}
        message = services.send(
            request.user,
            to=body.get("to") or [],
            cc=body.get("cc") or [],
            subject=body.get("subject") or "",
            body=body.get("body") or "",
            attachments=_decode_attachments(body.get("attachments")),
            reply_to_id=body.get("reply_to_id") or None,
        )
        return Response(services.summary(message), status=HTTP_201_CREATED)


class MailboxAdminView(APIView):
    """GET/PATCH an employee's external mailbox — accounts.manage_users on that employee."""

    permission_classes = [IsAuthenticated]

    def _target(self, request, user_id):
        target = _get_target(request, user_id)
        if not has_permission(request.user, "accounts.manage_users", unit=_scope_unit_for_user(target)):
            raise PermissionDenied("لا تملك صلاحية إدارة هذا الحساب.")
        return target

    def get(self, request, user_id):
        return Response(_mailbox_dict(self._target(request, user_id)))

    def patch(self, request, user_id):
        target = self._target(request, user_id)
        body = request.data if isinstance(request.data, dict) else {}
        if "local_part" in body:
            services.set_local_part(target, body.get("local_part") or None)
        mb = services.mailbox_for(target)
        changed = {}
        for flag in ("receiving_enabled", "sending_enabled"):
            if flag in body:
                if not isinstance(body[flag], bool):
                    raise ValidationError({flag: "قيمة منطقية مطلوبة."})
                setattr(mb, flag, body[flag])
                changed[flag] = body[flag]
        mb.save()
        log(actor=request.user, action="external_mailbox_updated", target_type="user", target_id=target.id,
            metadata={**changed, "local_part": mb.local_part}, **request_context(request))
        return Response(_mailbox_dict(target))
