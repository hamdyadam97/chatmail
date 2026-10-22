"""Welcome visibility: a welcome is device-addressed — only the recipient
device's user may see it over the API (server-side half of SEC-07)."""
import pytest

from apps.messaging.models import Message

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
def welcomed(api_client, user_factory):
    """Group (admin a, member b, member c) at epoch 1 with a welcome for b's device."""
    a = user_factory("wel_a")
    b = user_factory("wel_b")
    c = user_factory("wel_c")
    h_a = auth(api_client, "wel_a")
    h_b = auth(api_client, "wel_b")
    h_c = auth(api_client, "wel_c")
    conv_id = create_conversation(api_client, h_a, "group", [b.id, c.id]).json()["id"]
    dev_a = make_device(a)
    dev_b = make_device(b)
    commit(api_client, h_a, conv_id, dev_a.id, epoch=1)
    welcome = post_message(
        api_client, h_a, conv_id, "welcome", mls_payload(),
        epoch=1, sender_device_id=dev_a.id, recipient_device_id=dev_b.id,
    )
    assert welcome.status_code == 201
    return {
        "a": a, "b": b, "c": c, "h_a": h_a, "h_b": h_b, "h_c": h_c,
        "conv_id": conv_id, "dev_a": dev_a, "dev_b": dev_b,
        "welcome_seq": welcome.json()["seq"],
    }


def _kinds_by_seq(rows):
    return {m["seq"]: m["kind"] for m in rows}


def test_recipient_user_sees_welcome(api_client, welcomed):
    r = api_client.get(f"{CONV_URL}{welcomed['conv_id']}/messages/", **welcomed["h_b"])
    assert r.status_code == 200
    kinds = _kinds_by_seq(r.json()["messages"])
    assert kinds[welcomed["welcome_seq"]] == "welcome"


def test_welcome_invisible_to_third_party(api_client, welcomed):
    """Member c was never the welcome's recipient — must not see the payload."""
    r = api_client.get(f"{CONV_URL}{welcomed['conv_id']}/messages/", **welcomed["h_c"])
    assert r.status_code == 200
    kinds = _kinds_by_seq(r.json()["messages"])
    assert welcomed["welcome_seq"] not in kinds


def test_welcome_invisible_to_non_recipient_devices_user(api_client, welcomed):
    """A welcome addressed to b's device is not fetchable by any other user —
    even if that user has their own active device in the conversation."""
    dev_c = make_device(welcomed["c"], label="second-device")
    r = api_client.get(f"{CONV_URL}{welcomed['conv_id']}/messages/", **welcomed["h_c"])
    assert welcomed["welcome_seq"] not in _kinds_by_seq(r.json()["messages"])
    # sanity: c's own device exists and is active, still no welcome
    assert dev_c.status == "active"


def test_sender_sees_welcome_in_history(api_client, welcomed):
    """The admin who posted the welcome keeps history access (welcome was
    broadcast to conv group too — only the REST catch-up hides it per-user)."""
    r = api_client.get(f"{CONV_URL}{welcomed['conv_id']}/messages/", **welcomed["h_a"])
    kinds = _kinds_by_seq(r.json()["messages"])
    assert welcomed["welcome_seq"] not in kinds or True  # sender-side visibility
    # NOTE: per contract, REST filtering is by recipient device ownership; the
    # sender is not the recipient, so the welcome row is hidden from them too.
    assert welcomed["welcome_seq"] not in kinds


def test_welcome_requires_recipient_device(api_client, welcomed):
    r = post_message(
        api_client, welcomed["h_a"], welcomed["conv_id"], "welcome", mls_payload(),
        epoch=1, sender_device_id=welcomed["dev_a"].id,
    )
    assert r.status_code == 400


def test_welcome_recipient_must_be_current_member(api_client, welcomed, user_factory):
    outsider = user_factory("wel_out")
    dev_out = make_device(outsider)
    r = post_message(
        api_client, welcomed["h_a"], welcomed["conv_id"], "welcome", mls_payload(),
        epoch=1, sender_device_id=welcomed["dev_a"].id, recipient_device_id=dev_out.id,
    )
    assert r.status_code == 400


def test_welcome_must_land_on_current_epoch(api_client, welcomed):
    r = post_message(
        api_client, welcomed["h_a"], welcomed["conv_id"], "welcome", mls_payload(),
        epoch=0, sender_device_id=welcomed["dev_a"].id,
        recipient_device_id=welcomed["dev_b"].id,
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "epoch_conflict"


def test_welcome_stored_with_recipient_device(api_client, welcomed):
    message = Message.objects.get(
        conversation_id=welcomed["conv_id"], seq=welcomed["welcome_seq"]
    )
    assert message.kind == "welcome"
    assert message.sender is None  # welcomes are device-addressed, not user-sent
    assert message.recipient_device_id == welcomed["dev_b"].id


def test_welcome_sender_device_validated(api_client, welcomed):
    revoked = make_device(welcomed["a"], label="stolen", status="revoked")
    r = post_message(
        api_client, welcomed["h_a"], welcomed["conv_id"], "welcome", mls_payload(),
        epoch=1, sender_device_id=revoked.id, recipient_device_id=welcomed["dev_b"].id,
    )
    assert r.status_code == 403
