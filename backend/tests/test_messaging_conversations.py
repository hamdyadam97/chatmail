"""Conversation creation/listing: dm + group slice, dm uniqueness, roles."""
import pytest

from apps.messaging.models import Conversation, ConversationMember

from .messaging_utils import CONV_URL, auth, create_conversation

pytestmark = pytest.mark.django_db


@pytest.fixture
def pair(user_factory):
    a = user_factory("conv_a")
    b = user_factory("conv_b")
    return a, b


def test_create_group_201_admin_and_fields(api_client, pair, user_factory):
    a, b = pair
    c = user_factory("conv_c")
    h = auth(api_client, "conv_a")
    r = create_conversation(api_client, h, "group", [b.id, c.id])
    assert r.status_code == 201, r.json()
    body = r.json()
    conv = Conversation.objects.get(id=body["id"])
    assert body["type"] == "group"
    assert body["current_epoch"] == 0
    assert body["my_role"] == "admin"
    assert body["member_count"] == 3
    assert body["title_enc"] is not None
    assert body["mls_group_id"] == __import__("base64").b64encode(
        bytes(conv.mls_group_id)
    ).decode()
    assert body["joined_at"] and body["created_at"]
    assert ConversationMember.objects.get(conversation=conv, user=b).member_role == "member"


def test_create_dm_201(api_client, pair):
    a, b = pair
    h = auth(api_client, "conv_a")
    r = create_conversation(api_client, h, "dm", [b.id])
    assert r.status_code == 201, r.json()
    conv = Conversation.objects.get(id=r.json()["id"])
    assert conv.type == "dm"
    assert conv.active_members().count() == 2
    assert r.json()["my_role"] == "admin"


def test_dm_uniqueness_second_post_returns_same_conversation(api_client, pair):
    a, b = pair
    h = auth(api_client, "conv_a")
    first = create_conversation(api_client, h, "dm", [b.id])
    assert first.status_code == 201
    second = create_conversation(api_client, h, "dm", [b.id])
    assert second.status_code == 200, second.json()
    assert second.json()["id"] == first.json()["id"]
    # and from the other side as well
    h_b = auth(api_client, "conv_b")
    third = create_conversation(api_client, h_b, "dm", [a.id])
    assert third.status_code == 200
    assert third.json()["id"] == first.json()["id"]
    assert Conversation.objects.filter(type="dm").count() == 1


def test_dm_member_removal_is_forbidden(api_client, pair):
    """dm membership cannot be managed via the members endpoints (dm → 403)."""
    a, b = pair
    h = auth(api_client, "conv_a")
    conv_id = create_conversation(api_client, h, "dm", [b.id]).json()["id"]
    r = api_client.post(
        f"{CONV_URL}{conv_id}/members/remove/", {"user_ids": [str(b.id)]},
        format="json", **h,
    )
    assert r.status_code == 403


def test_dm_requires_exactly_one_member(api_client, pair, user_factory):
    a, b = pair
    c = user_factory("conv_c")
    h = auth(api_client, "conv_a")
    assert create_conversation(api_client, h, "dm", [b.id, c.id]).status_code == 400
    assert create_conversation(api_client, h, "dm", []).status_code == 400
    assert create_conversation(api_client, h, "dm", [a.id]).status_code == 400


def test_mls_group_id_length_validated(api_client, pair):
    a, b = pair
    h = auth(api_client, "conv_a")
    import base64

    body = {
        "type": "group",
        "member_user_ids": [str(b.id)],
        "mls_group_id": base64.b64encode(b"short").decode(),
    }
    r = api_client.post(CONV_URL, body, format="json", **h)
    assert r.status_code == 400


def test_members_add_forbidden_on_dm(api_client, pair, user_factory):
    a, b = pair
    c = user_factory("conv_c")
    h = auth(api_client, "conv_a")
    conv_id = create_conversation(api_client, h, "dm", [b.id]).json()["id"]
    r = api_client.post(
        f"{CONV_URL}{conv_id}/members/", {"user_ids": [str(c.id)]}, format="json", **h
    )
    assert r.status_code == 403


def test_list_shows_only_my_active_memberships(api_client, pair, user_factory):
    a, b = pair
    c = user_factory("conv_c")
    h_a = auth(api_client, "conv_a")
    h_b = auth(api_client, "conv_b")
    mine = create_conversation(api_client, h_a, "group", [b.id]).json()["id"]
    theirs = create_conversation(api_client, h_b, "group", [c.id]).json()["id"]

    listed = api_client.get(CONV_URL, **h_a)
    assert listed.status_code == 200
    ids = {row["id"] for row in listed.json()}
    assert mine in ids and theirs not in ids
    row = next(r for r in listed.json() if r["id"] == mine)
    assert row["my_role"] == "admin"
    assert row["member_count"] == 2

    # remove a → conversation disappears from a's list but stays in b's
    api_client.post(
        f"{CONV_URL}{mine}/members/remove/", {"user_ids": [str(a.id)]}, format="json", **h_a
    )
    ids_after = {r["id"] for r in api_client.get(CONV_URL, **h_a).json()}
    assert mine not in ids_after
    ids_b = {r["id"] for r in api_client.get(CONV_URL, **h_b).json()}
    assert mine in ids_b


def test_unauthenticated_rejected(api_client, pair):
    a, b = pair
    assert api_client.get(CONV_URL).status_code in (401, 403)
    assert create_conversation(api_client, {}, "group", [b.id]).status_code in (401, 403)


def test_membership_joined_at_recorded(api_client, pair):
    a, b = pair
    h = auth(api_client, "conv_a")
    conv_id = create_conversation(api_client, h, "group", [b.id]).json()["id"]
    member = ConversationMember.objects.get(conversation_id=conv_id, user=b)
    assert member.joined_at is not None
    assert member.added_by_id == a.id
