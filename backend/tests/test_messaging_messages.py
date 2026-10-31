"""Chat messages: sealed at rest, opened for members, ordered, idempotent."""
import uuid

import pytest

from apps.messaging.models import Message

from .messaging_utils import CONV_URL, auth, create_conversation, post_message

pytestmark = pytest.mark.django_db


@pytest.fixture
def group(user_factory, api_client):
    a = user_factory("msg_a")
    b = user_factory("msg_b")
    h_a = auth(api_client, "msg_a")
    h_b = auth(api_client, "msg_b")
    conv_id = create_conversation(api_client, h_a, "group", [b.id]).json()["id"]
    return {"a": a, "b": b, "h_a": h_a, "h_b": h_b, "conv_id": conv_id}


def _messages(api_client, h, conv_id, query=""):
    r = api_client.get(f"{CONV_URL}{conv_id}/messages/{query}", **h)
    assert r.status_code == 200, r.content
    return r.json()["messages"]


def test_text_is_sealed_at_rest_and_opened_for_members(api_client, group):
    r = post_message(api_client, group["h_a"], group["conv_id"], "الاجتماع الساعة العاشرة")
    assert r.status_code == 201, r.content
    assert r.json()["content"] == {"text": "الاجتماع الساعة العاشرة"}
    stored = bytes(Message.objects.get(conversation_id=group["conv_id"]).content_enc)
    assert "الاجتماع".encode() not in stored and stored.startswith(b"v1")
    [m] = _messages(api_client, group["h_b"], group["conv_id"])
    assert m["content"]["text"] == "الاجتماع الساعة العاشرة"
    assert m["sender_user_id"] == str(group["a"].id)


def test_idempotent_retry_returns_same_row(api_client, group):
    cid = uuid.uuid4()
    first = post_message(api_client, group["h_a"], group["conv_id"], "مرة", client_msg_id=cid)
    second = post_message(api_client, group["h_a"], group["conv_id"], "مرة", client_msg_id=cid)
    assert first.status_code == 201 and second.status_code == 200
    assert first.json()["seq"] == second.json()["seq"]
    assert Message.objects.filter(conversation_id=group["conv_id"]).count() == 1


def test_seq_order_catch_up_and_latest_page(api_client, group):
    for i in range(5):
        post_message(api_client, group["h_a" if i % 2 else "h_b"], group["conv_id"], f"m{i}")
    seqs = [m["seq"] for m in _messages(api_client, group["h_a"], group["conv_id"])]
    assert seqs == [1, 2, 3, 4, 5]
    assert [m["seq"] for m in _messages(api_client, group["h_a"], group["conv_id"], "?after_seq=3")] == [4, 5]
    latest = _messages(api_client, group["h_a"], group["conv_id"], "?latest=1&limit=2")
    assert [m["seq"] for m in latest] == [4, 5]
    older = _messages(api_client, group["h_a"], group["conv_id"], "?before_seq=4&limit=2")
    assert [m["seq"] for m in older] == [2, 3]


def test_empty_text_rejected(api_client, group):
    assert post_message(api_client, group["h_a"], group["conv_id"], "   ").status_code == 400


def test_reply_to_must_reference_existing_message(api_client, group):
    assert post_message(api_client, group["h_a"], group["conv_id"], "x", reply_to_seq=9).status_code == 400
    post_message(api_client, group["h_a"], group["conv_id"], "أصل")
    r = post_message(api_client, group["h_b"], group["conv_id"], "رد", reply_to_seq=1)
    assert r.status_code == 201 and r.json()["reply_to_seq"] == 1


def test_read_position_only_moves_forward(api_client, group):
    url = f"{CONV_URL}{group['conv_id']}/read/"
    assert api_client.post(url, {"seq": 3}, format="json", **group["h_b"]).json() == {"last_read_seq": 3}
    assert api_client.post(url, {"seq": 1}, format="json", **group["h_b"]).json() == {"last_read_seq": 3}
    row = next(c for c in api_client.get(CONV_URL, **group["h_b"]).json() if c["id"] == group["conv_id"])
    assert row["last_read_seq"] == 3


def test_tampered_blob_is_not_shown(api_client, group):
    post_message(api_client, group["h_a"], group["conv_id"], "سر")
    m = Message.objects.get(conversation_id=group["conv_id"])
    blob = bytearray(bytes(m.content_enc))
    blob[-1] ^= 1
    Message.objects.filter(id=m.id).update(content_enc=bytes(blob))
    [shown] = _messages(api_client, group["h_a"], group["conv_id"])
    assert shown["content"] is None
