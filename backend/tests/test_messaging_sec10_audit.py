"""SEC-10 canary: message bodies must never appear in the audit log.

Canary strings travel inside binary mls_payload blobs; after a full flow
(create → commit → welcome → application → membership change → removal)
no audit row may contain the canary anywhere, and message metadata keys
must be identifiers/counters only.
"""
import pytest

from apps.audit.models import AuditLog

from .messaging_utils import (
    CONV_URL,
    auth,
    commit,
    create_conversation,
    make_device,
    mls_payload,
    post_message,
)

pytestmark = pytest.mark.django_db

CANARY = "CANARY-UNIQUE-7f3a9e21-message-body"


@pytest.fixture
def canary_flow(api_client, user_factory):
    a = user_factory("can_a")
    b = user_factory("can_b")
    h_a = auth(api_client, "can_a")
    h_b = auth(api_client, "can_b")
    dev_a = make_device(a)
    dev_b = make_device(b)
    conv_id = create_conversation(api_client, h_a, "group", [b.id]).json()["id"]
    # canary embedded in a binary payload (framing byte keeps it accepted)
    canary_payload = b"\x14" + CANARY.encode() + mls_payload(32)
    commit(api_client, h_a, conv_id, dev_a.id, epoch=1)
    post_message(
        api_client, h_a, conv_id, "welcome", canary_payload,
        epoch=1, sender_device_id=dev_a.id, recipient_device_id=dev_b.id,
    )
    post_message(
        api_client, h_b, conv_id, "application", canary_payload,
        epoch=1, sender_device_id=dev_b.id,
    )
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
        assert set(row.metadata.keys()) <= {"seq", "kind", "epoch"}
        for value in row.metadata.values():
            assert isinstance(value, (int, str))
            assert CANARY not in str(value)
