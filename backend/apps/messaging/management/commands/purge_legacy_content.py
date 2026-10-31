"""One-off: delete content written by the retired per-device (E2EE) design.

    manage.py purge_legacy_content          # counts only
    manage.py purge_legacy_content --yes    # delete

User decision (2026-10-31): switch to Outlook-style mail and start clean.
Content stored before the switch was encrypted to device keys that the
server never had, so it cannot be opened any more. This removes it —
correspondence (with approvals, attachments), chat, announcements, external
mail, their files and notifications — and leaves accounts, roles, the org
structure, reference counters and the append-only audit log untouched.

Only rows that are NOT sealed with the server key are legacy; anything
written after the switch is kept, so running it twice is harmless.
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from apps import vault


def _legacy_conversation_ids() -> set:
    """Conversations holding any message not sealed with the server key."""
    from apps.messaging.models import Message

    return {
        conversation_id
        for conversation_id, blob in Message.objects.values_list("conversation_id", "content_enc").iterator()
        if not bytes(blob).startswith(vault.VERSION)
    }


class Command(BaseCommand):
    help = "Delete content stored by the retired per-device encryption (one-off)."

    def add_arguments(self, parser):
        parser.add_argument("--yes", action="store_true", help="really delete")

    def handle(self, *args, **options):
        from apps.announcements.models import Announcement, AnnouncementRecipient
        from apps.approvals.models import ApprovalRequest
        from apps.correspondence.models import (
            Correspondence,
            CorrespondenceForwarding,
            EncryptedAttachment,
            StoredFile,
        )
        from apps.correspondence.services import blob_storage
        from apps.external_mail.models import ExternalAttachment, ExternalMessage
        from apps.messaging.models import Conversation, ConversationMember, Message
        from apps.notifications.models import Notification

        conv_ids = _legacy_conversation_ids()
        corr = Correspondence.objects.filter(thread_id__in=conv_ids)
        anns = Announcement.objects.filter(thread_id__in=conv_ids)
        ext = ExternalMessage.objects.filter(content_enc__isnull=True)
        files = StoredFile.objects.filter(meta_enc__isnull=True)
        counts = {
            "conversations": len(conv_ids),
            "correspondences": corr.count(),
            "announcements": anns.count(),
            "external_messages": ext.count(),
            "files": files.count(),
        }
        self.stdout.write(", ".join(f"{k}={v}" for k, v in counts.items()))
        if not options["yes"]:
            self.stdout.write("dry run — pass --yes to delete")
            return

        corr_ids = list(corr.values_list("id", flat=True))
        ann_ids = list(anns.values_list("id", flat=True))
        ext_ids = list(ext.values_list("id", flat=True))
        storage_keys = list(files.values_list("storage_key", flat=True))
        refs = corr_ids + ann_ids + ext_ids
        with transaction.atomic():
            # Raw deletes: sent rows are immutable through the ORM and point at
            # each other (reply_to / thread_root / content_message); FK checks
            # are deferred to the commit, when every side is gone.
            for qs in (
                ApprovalRequest.objects.filter(correspondence_id__in=corr_ids),
                CorrespondenceForwarding.objects.filter(new_correspondence_id__in=corr_ids),
                EncryptedAttachment.objects.filter(correspondence_id__in=corr_ids),
                ExternalAttachment.objects.filter(message_id__in=ext_ids),
                AnnouncementRecipient.objects.filter(announcement_id__in=ann_ids),
            ):
                qs.delete()
            Notification.objects.filter(ref_id__in=refs).delete()
            for model, ids in ((Correspondence, corr_ids), (Announcement, ann_ids)):
                model.objects.filter(id__in=ids)._raw_delete(model.objects.db)
            for rel in ("participants", "events"):
                field = Correspondence._meta.get_field(rel).related_model
                field.objects.filter(correspondence_id__in=corr_ids)._raw_delete(field.objects.db)
            ExternalMessage.objects.filter(id__in=ext_ids)._raw_delete(ExternalMessage.objects.db)
            Message.objects.filter(conversation_id__in=conv_ids)._raw_delete(Message.objects.db)
            ConversationMember.objects.filter(conversation_id__in=conv_ids).delete()
            Conversation.objects.filter(id__in=conv_ids)._raw_delete(Conversation.objects.db)
            files._raw_delete(StoredFile.objects.db)
        storage = blob_storage()
        for key in storage_keys:
            if storage.exists(key):
                storage.delete(key)
        self.stdout.write(self.style.SUCCESS("legacy content deleted"))
