"""Notification fan-out: DB row + WebSocket push after commit.

``notify`` accepts a kind and a reference only — there is no parameter that
could carry a subject, body or any other content (SEC-11). Titles come from
the fixed catalog below.
"""
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction

from .models import Notification, NotificationPreference

TITLES = {
    "new_correspondence": "وصلتك مراسلة جديدة",
    "correspondence_reply": "وصلك رد على مراسلة",
    "correspondence_forward": "أُحيلت إليك مراسلة",
    "approval_requested": "لديك طلب اعتماد بانتظار قرارك",
    "approval_decided": "صدر قرار على طلب اعتماد قدّمته",
    "device_alert": "تغيّرت أجهزة حسابك — راجع قائمة أجهزتك",
    "announcement": "صدر تعميم جديد موجّه إليك",
    "announcement_reminder": "تذكير: تعميم بانتظار تأكيد اطلاعك",
}


def group_name(user_id) -> str:
    return f"notify.{user_id}"


def to_dict(n: Notification) -> dict:
    return {
        "id": str(n.id),
        "kind": n.kind,
        "title": n.title_generic,
        "ref_type": n.ref_type,
        "ref_id": str(n.ref_id) if n.ref_id else None,
        "created_at": n.created_at.isoformat(),
        "read_at": n.read_at.isoformat() if n.read_at else None,
    }


def notify(user_ids, kind: str, *, ref_type: str = "", ref_id=None) -> list[Notification]:
    if kind not in TITLES:
        raise ValueError(f"unknown notification kind: {kind}")
    ids = list(dict.fromkeys(str(u) for u in user_ids))
    if not ids:
        return []
    rows = Notification.objects.bulk_create(
        [
            Notification(user_id=uid, kind=kind, title_generic=TITLES[kind], ref_type=ref_type, ref_id=ref_id)
            for uid in ids
        ]
    )
    muted = {
        str(p.user_id): p.muted_kinds()
        for p in NotificationPreference.objects.filter(user_id__in=ids)
    }
    pushes = [n for n in rows if kind not in muted.get(str(n.user_id), set())]
    transaction.on_commit(lambda: _push(pushes))
    return rows


def _push(rows: list[Notification]) -> None:
    layer = get_channel_layer()
    if layer is None:
        return
    for n in rows:
        async_to_sync(layer.group_send)(
            group_name(n.user_id), {"type": "notify.event", "notification": to_dict(n)}
        )
