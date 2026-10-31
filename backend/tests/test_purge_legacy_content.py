"""purge_legacy_content: deletes what the retired per-device design stored
(content the server cannot open) and keeps everything written since."""
import pytest
from django.core.management import call_command

from apps.correspondence.models import Correspondence, StoredFile
from apps.messaging.models import Conversation, Message
from apps.notifications.models import Notification

from .correspondence_utils import (  # noqa: F401  (fixtures)
    _blob_root,
    office,
    prepare_and_send,
    reply,
    upload,
)
from .messaging_utils import create_conversation, post_message

pytestmark = pytest.mark.django_db


def _make_legacy(sent: dict, chat_id: str, stored_file_id: str):
    """Turn rows into what the old design left behind: MLS bytes, keyless files."""
    Message.objects.filter(conversation_id__in=[sent["thread_id"], chat_id]).update(content_enc=b"\x14mls-wire")
    StoredFile.objects.filter(id=stored_file_id).update(meta_enc=None)


def test_purges_only_legacy_content(api_client, office, capsys):
    r = upload(api_client, office["h_s"])
    assert r.status_code == 201, r.content
    legacy_file = r.json()["id"]
    old = prepare_and_send(api_client, office["h_s"], [office["r1"]], attachment_ids=[legacy_file])
    reply(api_client, office["h_r1"], old["id"])
    old_chat = create_conversation(api_client, office["h_s"], "dm", [office["r1"].id]).json()["id"]
    post_message(api_client, office["h_s"], old_chat, "قديم")
    _make_legacy(old, old_chat, legacy_file)

    new_file = upload(api_client, office["h_s"]).json()["id"]
    new = prepare_and_send(api_client, office["h_s"], [office["r2"]], attachment_ids=[new_file])
    new_chat = create_conversation(api_client, office["h_s"], "dm", [office["r2"].id]).json()["id"]
    post_message(api_client, office["h_s"], new_chat, "جديد")

    call_command("purge_legacy_content")  # dry run
    assert "correspondences=2" in capsys.readouterr().out
    assert Correspondence.objects.filter(id=old["id"]).exists()

    call_command("purge_legacy_content", "--yes")
    assert not Correspondence.objects.filter(thread_id=old["thread_id"]).exists()
    assert not Conversation.objects.filter(id__in=[old["thread_id"], old_chat]).exists()
    assert not StoredFile.objects.filter(id=legacy_file).exists()
    assert not Notification.objects.filter(ref_id=old["id"]).exists()
    assert api_client.get(f"/api/v1/correspondences/{new['id']}/", **office["h_r2"]).json()["content"]
    assert Message.objects.filter(conversation_id=new_chat).count() == 1
    assert StoredFile.objects.filter(id=new_file).exists()

    call_command("purge_legacy_content", "--yes")  # nothing left to do
    assert "correspondences=0" in capsys.readouterr().out
