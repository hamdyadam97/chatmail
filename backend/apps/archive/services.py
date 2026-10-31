"""Central archive: officer gate and the archived-correspondence view.

Who is an archive officer: a CENTRAL assignment of
``archive.institutional.access`` (the archive_officer role). Only
correspondence classified ``institutional_archive_eligible`` is visible here,
and every opening of an item is audited by the view.
"""
from rest_framework.exceptions import PermissionDenied

from apps.authorization.services import has_permission
from apps.correspondence.models import Correspondence, EncryptedAttachment, StoredFile
from apps.correspondence.services import correspondence_content, file_meta

ARCHIVE_PERMISSION = "archive.institutional.access"
ARCHIVE_ELIGIBLE = "institutional_archive_eligible"


def is_officer(user) -> bool:
    return has_permission(user, ARCHIVE_PERMISSION, unit=None)


def require_officer(user) -> None:
    if not is_officer(user):
        raise PermissionDenied("الأرشيف المركزي متاح لضباط الأرشيف المعتمدين فقط.")


def archived_queryset():
    return (
        Correspondence.objects.filter(classification=ARCHIVE_ELIGIBLE, status__in=["sent", "closed"])
        .select_related("sender", "sender_membership__institute", "content_message")
        .order_by("-sent_at")
    )


def item_to_dict(c: Correspondence, *, with_content: bool) -> dict:
    membership = c.sender_membership
    data = {
        "correspondence_id": str(c.id),
        "reference_number": c.reference_number,
        "sent_at": c.sent_at.isoformat() if c.sent_at else None,
        "sender": c.sender.full_name or c.sender.username,
        "institute": membership.institute.name if membership and membership.institute_id else None,
        "priority": c.priority,
        "reply_to_id": str(c.reply_to_id) if c.reply_to_id else None,
        "thread_id": str(c.thread_id),
    }
    content = correspondence_content(c) or {}
    data["subject"] = content.get("subject", "")
    if with_content:
        files = {str(f.id): file_meta(f) for f in StoredFile.objects.filter(id__in=content.get("attachments", []))}
        data.update(
            body=content.get("body", ""),
            forwarded=content.get("forwarded"),
            attachments=[files[i] for i in content.get("attachments", []) if i in files],
        )
    return data


def officer_may_download(user, stored_file) -> bool:
    """Attachments of archived correspondence are downloadable by officers."""
    return is_officer(user) and EncryptedAttachment.objects.filter(
        stored_file=stored_file, correspondence__classification=ARCHIVE_ELIGIBLE,
        correspondence__status__in=["sent", "closed"],
    ).exists()
