"""SEC-10 canary: message bodies must never appear in the audit log.

After a full flow (create → messages → membership change → removal) no
audit row may contain the canary anywhere, and message metadata keys must be
identifiers/counters only.
"""
import pytest

from apps.audit.models import AuditLog

from .messaging_utils import CONV_URL, auth, create_conversation, post_message

pytestmark = pytest.mark.django_db

CANARY = "CANARY-UNIQUE-7f3a9e21-message-body"


@pytest.fixture
def canary_flow(api_client, user_factory):
    a = user_factory("can_a")
    b = user_factory("can_b")
    h_a = auth(api_client, "can_a")
    h_b = auth(api_client, "can_b")
    conv_id = create_conversation(api_client, h_a, "group", [b.id], title=CANARY).json()["id"]
    post_message(api_client, h_a, conv_id, CANARY)
    post_message(api_client, h_b, conv_id, f"رد {CANARY}")
    api_client.post(
        f"{CONV_URL}{conv_id}/members/remove/", {"user_ids": [str(b.id)]},
        format="json", **h_a,
    )
    api_client.get(f"{CONV_URL}{conv_id}/ws-ticket/", **h_a)
    return conv_id


def test_no_audit_row_contains_canary(canary_flow):
    rows = AuditLog.objects.all()
    assert rows.exists()  # the flow did produce audit rows
    for row in rows:
        blob = f"{row.action}|{row.target_type}|{row.metadata}|{row.user_agent}"
        assert CANARY not in blob


def test_message_audit_metadata_is_identifiers_only(canary_flow):
    posted = AuditLog.objects.filter(action="chat_message_posted")
    assert posted.exists()
    for row in posted:
        assert set(row.metadata.keys()) <= {"seq"}
        for value in row.metadata.values():
            assert isinstance(value, (int, str))
            assert CANARY not in str(value)


def test_canary_never_stored_readable(canary_flow):
    from apps.messaging.models import Conversation, Message

    for blob in Message.objects.values_list("content_enc", flat=True):
        assert CANARY.encode() not in bytes(blob)
    assert CANARY.encode() not in bytes(Conversation.objects.get(id=canary_flow).title_enc)
