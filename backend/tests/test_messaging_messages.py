"""Message posting rules: epochs, idempotency, seq ordering, binary payloads,
sender-device trust, membership metadata carried by commits."""
import base64
import uuid

import pytest

from apps.messaging.models import Conversation, GroupCryptoEpoch, Message

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


@pytest.fixture
def group(api_client, user_factory):
    a = user_factory("msg_a")
    b = user_factory("msg_b")
    h_a = auth(api_client, "msg_a")
    h_b = auth(api_client, "msg_b")
    conv_id = create_conversation(api_client, h_a, "group", [b.id]).json()["id"]
    dev_a = make_device(a)
    dev_b = make_device(b)
    return {
        "a": a, "b": b, "h_a": h_a, "h_b": h_b,
        "conv_id": conv_id, "dev_a": dev_a, "dev_b": dev_b,
    }


# --- epoch gating ------------------------------------------------------------

def test_stale_commit_epoch_conflicts_then_valid_accepted(api_client, group):
    conv_id = group["conv_id"]
    stale = commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=5)
    assert stale.status_code == 409
    assert stale.json() == {"detail": "epoch_conflict", "current_epoch": 0}
    assert Conversation.objects.get(id=conv_id).current_epoch == 0

    ok = commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    assert ok.status_code == 201, ok.json()
    assert ok.json()["epoch"] == 1
    conv = Conversation.objects.get(id=conv_id)
    assert conv.current_epoch == 1
    epoch_row = GroupCryptoEpoch.objects.get(conversation_id=conv_id, epoch=1)
    assert epoch_row.member_count == 2
    assert epoch_row.committed_by_device_id == group["dev_a"].id

    # re-committing the same epoch also conflicts; so does skipping ahead
    again = commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    assert again.status_code == 409
    assert again.json()["current_epoch"] == 1
    skip = commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=3)
    assert skip.status_code == 409


def test_application_epoch_must_be_within_current(api_client, group):
    conv_id = group["conv_id"]
    payload = mls_payload()
    early = post_message(
        api_client, group["h_a"], conv_id, "application", payload,
        epoch=1, sender_device_id=group["dev_a"].id,
    )
    assert early.status_code == 409
    assert early.json() == {"detail": "epoch_conflict", "current_epoch": 0}

    commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    ok = post_message(
        api_client, group["h_b"], conv_id, "application", payload,
        epoch=1, sender_device_id=group["dev_b"].id,
    )
    assert ok.status_code == 201, ok.json()
    too_new = post_message(
        api_client, group["h_b"], conv_id, "application", payload,
        epoch=2, sender_device_id=group["dev_b"].id,
    )
    assert too_new.status_code == 409


# --- idempotency + sequencing ---------------------------------------------------

def test_idempotent_retry_returns_same_row(api_client, group):
    conv_id = group["conv_id"]
    commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    client_msg_id = str(uuid.uuid4())
    payload = mls_payload()
    first = post_message(
        api_client, group["h_a"], conv_id, "application", payload,
        client_msg_id=client_msg_id, epoch=1, sender_device_id=group["dev_a"].id,
    )
    assert first.status_code == 201
    retry = post_message(
        api_client, group["h_a"], conv_id, "application", payload,
        client_msg_id=client_msg_id, epoch=1, sender_device_id=group["dev_a"].id,
    )
    assert retry.status_code == 200
    assert retry.json()["seq"] == first.json()["seq"]
    assert Message.objects.filter(conversation_id=conv_id).count() == 2  # commit + 1 app


def test_seq_is_per_conversation_monotonic(api_client, group):
    conv_id = group["conv_id"]
    commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    seqs = []
    for user_h, dev in [(group["h_a"], group["dev_a"]), (group["h_b"], group["dev_b"]),
                        (group["h_a"], group["dev_a"])]:
        r = post_message(
            api_client, user_h, conv_id, "application", mls_payload(),
            epoch=1, sender_device_id=dev.id,
        )
        assert r.status_code == 201
        seqs.append(r.json()["seq"])
    assert seqs == sorted(seqs) == [2, 3, 4]


def test_catch_up_after_seq_returns_ordered_tail_only(api_client, group):
    conv_id = group["conv_id"]
    commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    for i in range(4):
        post_message(
            api_client, group["h_a"], conv_id, "application", mls_payload(),
            epoch=1, sender_device_id=group["dev_a"].id,
        )
    r = api_client.get(
        f"{CONV_URL}{conv_id}/messages/?after_seq=3&limit=200", **group["h_b"]
    )
    assert r.status_code == 200
    body = r.json()
    assert body["current_epoch"] == 1
    assert [m["seq"] for m in body["messages"]] == [4, 5]
    assert body["messages"][0]["created_at"] <= body["messages"][-1]["created_at"]

    limited = api_client.get(f"{CONV_URL}{conv_id}/messages/?limit=2", **group["h_b"])
    assert [m["seq"] for m in limited.json()["messages"]] == [1, 2]
    # limit is capped at 200
    capped = api_client.get(f"{CONV_URL}{conv_id}/messages/?limit=9999", **group["h_b"])
    assert capped.status_code == 200


# --- binary payload defense-in-depth -------------------------------------------

def test_plaintext_json_payload_rejected(api_client, group):
    conv_id = group["conv_id"]
    commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    json_text = base64.b64encode(b'{"text":"hello secret world"}').decode()
    r = api_client.post(
        f"{CONV_URL}{conv_id}/messages/",
        {
            "kind": "application",
            "mls_payload": json_text,
            "client_msg_id": str(uuid.uuid4()),
            "epoch": 1,
            "sender_device_id": str(group["dev_a"].id),
        },
        format="json",
        **group["h_a"],
    )
    assert r.status_code == 400, r.json()
    assert "mls_payload" in r.json()


def test_utf8_text_payload_rejected_even_when_not_json(api_client, group):
    conv_id = group["conv_id"]
    commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    text = base64.b64encode("just some plaintext, not MLS".encode()).decode()
    r = api_client.post(
        f"{CONV_URL}{conv_id}/messages/",
        {
            "kind": "application",
            "mls_payload": text,
            "client_msg_id": str(uuid.uuid4()),
            "epoch": 1,
            "sender_device_id": str(group["dev_a"].id),
        },
        format="json",
        **group["h_a"],
    )
    assert r.status_code == 400


def test_binary_payloads_accepted(api_client, group):
    conv_id = group["conv_id"]
    commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    # framing-byte prefixed payload
    framed = post_message(
        api_client, group["h_a"], conv_id, "application", mls_payload(prefix=0x15),
        epoch=1, sender_device_id=group["dev_a"].id,
    )
    assert framed.status_code == 201, framed.json()
    # non-UTF-8-decodable binary payload without a known framing byte
    raw_binary = b"\x03\x01\xff\xfe\x00\x9c" + uuid.uuid4().bytes
    raw = post_message(
        api_client, group["h_a"], conv_id, "application", raw_binary,
        epoch=1, sender_device_id=group["dev_a"].id,
    )
    assert raw.status_code == 201, raw.json()
    stored = Message.objects.get(conversation_id=conv_id, seq=raw.json()["seq"])
    assert bytes(stored.mls_payload) == raw_binary


# --- sender device trust --------------------------------------------------------

def test_revoked_sender_device_rejected(api_client, group):
    conv_id = group["conv_id"]
    revoked = make_device(group["a"], label="old-laptop", status="revoked")
    r = post_message(
        api_client, group["h_a"], conv_id, "application", mls_payload(),
        epoch=1, sender_device_id=revoked.id,
    )
    assert r.status_code == 403


def test_pending_sender_device_rejected(api_client, group):
    conv_id = group["conv_id"]
    pending = make_device(group["a"], label="new-phone", status="pending")
    r = post_message(
        api_client, group["h_a"], conv_id, "application", mls_payload(),
        epoch=1, sender_device_id=pending.id,
    )
    assert r.status_code == 403


def test_foreign_sender_device_rejected(api_client, group):
    conv_id = group["conv_id"]
    r = post_message(
        api_client, group["h_a"], conv_id, "application", mls_payload(),
        epoch=1, sender_device_id=group["dev_b"].id,
    )
    assert r.status_code == 403


def test_missing_sender_device_rejected(api_client, group):
    conv_id = group["conv_id"]
    r = post_message(
        api_client, group["h_a"], conv_id, "application", mls_payload(), epoch=1
    )
    assert r.status_code == 400


# --- misc validation --------------------------------------------------------------

def test_reply_to_must_reference_existing_message(api_client, group):
    conv_id = group["conv_id"]
    commit(api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1)
    bad = post_message(
        api_client, group["h_a"], conv_id, "application", mls_payload(),
        epoch=1, sender_device_id=group["dev_a"].id, reply_to_seq=999,
    )
    assert bad.status_code == 400

    anchor = Message.objects.filter(conversation_id=conv_id, kind="commit").get()
    ok = post_message(
        api_client, group["h_a"], conv_id, "application", mls_payload(),
        epoch=1, sender_device_id=group["dev_a"].id, reply_to_seq=anchor.seq,
    )
    assert ok.status_code == 201
    assert ok.json()["reply_to_seq"] == anchor.seq


def test_unknown_message_kind_rejected(api_client, group):
    conv_id = group["conv_id"]
    r = api_client.post(
        f"{CONV_URL}{conv_id}/messages/",
        {
            "kind": "system",
            "mls_payload": base64.b64encode(mls_payload()).decode(),
            "client_msg_id": str(uuid.uuid4()),
            "epoch": 1,
            "sender_device_id": str(group["dev_a"].id),
        },
        format="json",
        **group["h_a"],
    )
    assert r.status_code == 400


# --- membership metadata carried by commits ---------------------------------------

def test_commit_membership_metadata_applies_acl_immediately(api_client, group, user_factory):
    conv_id = group["conv_id"]
    c = user_factory("msg_c")
    dev_c = make_device(c)
    h_c = auth(api_client, "msg_c")

    r = commit(
        api_client, group["h_a"], conv_id, group["dev_a"].id, epoch=1,
        membership={"added_user_ids": [str(c.id)], "removed_user_ids": [str(group["b"].id)]},
    )
    assert r.status_code == 201, r.json()
    conv = Conversation.objects.get(id=conv_id)
    assert conv.current_epoch == 1
    epoch_row = GroupCryptoEpoch.objects.get(conversation_id=conv_id, epoch=1)
    assert epoch_row.member_count == 2  # a + c after b removed
    # added user can fetch history right away; removed user is locked out
    assert api_client.get(f"{CONV_URL}{conv_id}/messages/", **h_c).status_code == 200
    assert api_client.get(f"{CONV_URL}{conv_id}/messages/", **group["h_b"]).status_code == 403
    # the added member can participate with their own device
    ok = post_message(
        api_client, h_c, conv_id, "application", mls_payload(),
        epoch=1, sender_device_id=dev_c.id,
    )
    assert ok.status_code == 201


def test_non_admin_commit_with_membership_metadata_rejected(api_client, group):
    conv_id = group["conv_id"]
    r = commit(
        api_client, group["h_b"], conv_id, group["dev_b"].id, epoch=1,
        membership={"removed_user_ids": [str(group["a"].id)]},
    )
    assert r.status_code == 403
    assert Conversation.objects.get(id=conv_id).current_epoch == 0


def test_member_can_send_plain_commit_without_membership_meta(api_client, group):
    conv_id = group["conv_id"]
    r = commit(api_client, group["h_b"], conv_id, group["dev_b"].id, epoch=1)
    assert r.status_code == 201
    assert Conversation.objects.get(id=conv_id).current_epoch == 1
