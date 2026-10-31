"""GET /api/v1/search/?q=…[&kind=correspondence|chat|announcement|external]

Content is sealed at rest, so search opens the caller's own readable items
in memory (most recent first, bounded) and matches with Arabic
normalization. Only what the caller may already read is ever scanned: the
same participation gates as the detail endpoints.
"""
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.announcements.models import AnnouncementRecipient, Announcement
from apps.announcements.services import announcement_content
from apps.correspondence import services as corr
from apps.correspondence.models import Correspondence
from apps.external_mail import services as ext
from apps.external_mail.models import ExternalMessage
from apps.messaging.models import ConversationMember, Message
from apps.messaging.services import message_content
from apps.textsearch import matches, normalize

SCAN = 2000
MAX_HITS = 100
KINDS = ("correspondence", "chat", "announcement", "external")


def _snippet(text: str, query: str, width: int = 160) -> str:
    flat = " ".join((text or "").split())
    norm = normalize(flat)
    first = normalize(query).split()[0] if query.split() else ""
    at = norm.find(first) if first else -1
    start = max(0, at - width // 3) if at >= 0 else 0
    return ("…" if start else "") + flat[start:start + width]


def _correspondence(user, q):
    rows = (
        Correspondence.objects.filter(id__in=corr.readable_ids_subquery(user), status__in=["sent", "closed"])
        .select_related("sender", "content_message")
        .order_by("-sent_at")[:SCAN]
    )
    for c in rows:
        content = corr.correspondence_content(c) or {}
        if matches(q, c.reference_number or "", content.get("subject", ""), content.get("body", ""), c.sender.full_name):
            yield {
                "kind": "correspondence", "id": str(c.id), "title": content.get("subject") or "(بلا عنوان)",
                "snippet": _snippet(content.get("body", ""), q), "meta": f"{c.reference_number} — {c.sender.full_name}",
                "date": c.sent_at.isoformat() if c.sent_at else None, "link": f"/mail/inbox/{c.id}",
            }


def _chat(user, q):
    conversations = ConversationMember.objects.filter(
        user=user, removed_at__isnull=True, conversation__type__in=["dm", "group"]
    ).values_list("conversation_id", flat=True)
    messages = (
        Message.objects.filter(conversation_id__in=conversations)
        .select_related("sender")
        .order_by("-created_at")[:SCAN]
    )
    for m in messages:
        text = (message_content(m) or {}).get("text", "")
        if matches(q, text):
            name = m.sender.full_name if m.sender_id else ""
            yield {
                "kind": "chat", "id": f"{m.conversation_id}:{m.seq}", "title": name or "رسالة",
                "snippet": _snippet(text, q), "meta": "محادثة",
                "date": m.created_at.isoformat(), "link": f"/chat/{m.conversation_id}",
            }


def _announcements(user, q):
    received = AnnouncementRecipient.objects.filter(user=user).values_list("announcement_id", flat=True)
    rows = (
        Announcement.objects.filter(status__in=["published", "withdrawn"])
        .filter(id__in=received) | Announcement.objects.filter(publisher=user, status__in=["published", "withdrawn"])
    ).select_related("publisher", "content_message").order_by("-published_at")[:SCAN]
    for a in rows:
        content = announcement_content(a, user) or {}
        if content and matches(q, a.reference_number or "", content.get("title", ""), content.get("body", "")):
            yield {
                "kind": "announcement", "id": str(a.id), "title": content.get("title", ""),
                "snippet": _snippet(content.get("body", ""), q), "meta": f"{a.reference_number} — {a.publisher.full_name}",
                "date": a.published_at.isoformat() if a.published_at else None, "link": f"/announcements/{a.id}",
            }


def _external(user, q):
    for m in ExternalMessage.objects.filter(owner=user).order_by("-created_at")[:SCAN]:
        c = ext.message_content(m) or {}
        if matches(q, m.mail_from, " ".join(m.recipients), c.get("subject", ""), c.get("body", "")):
            yield {
                "kind": "external", "id": str(m.id), "title": c.get("subject") or "(بلا عنوان)",
                "snippet": _snippet(c.get("body", ""), q), "meta": m.mail_from,
                "date": m.created_at.isoformat(), "link": f"/mail/external/{m.id}",
            }


SOURCES = {"correspondence": _correspondence, "chat": _chat, "announcement": _announcements, "external": _external}


class SearchView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        q = (request.query_params.get("q") or "").strip()
        if len(q) < 2:
            raise ValidationError({"q": "اكتب حرفين على الأقل."})
        kind = request.query_params.get("kind") or ""
        if kind and kind not in KINDS:
            raise ValidationError({"kind": "نوع غير معروف."})
        hits = []
        for name in [kind] if kind else KINDS:
            for hit in SOURCES[name](request.user, q):
                hits.append(hit)
                if len(hits) >= MAX_HITS:
                    break
        hits.sort(key=lambda h: h["date"] or "", reverse=True)
        return Response({"results": hits[:MAX_HITS]})
